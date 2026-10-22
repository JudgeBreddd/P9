// Phase 10 council r1 + r2 (C-H1, N-H1, C-H2, expired approval, C-H4): a desktop action that lands while a ceremony's check is
// still awaiting wins. The verify step is held open on purpose, so each race is deterministic.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { openLedger } from '../apps/server/ledger.mjs';
import { authority, stillAuthorized } from '../apps/server/authority.mjs';

const { createAuth } = await import(process.env.P9_AUTH_MODULE ?? '../apps/server/auth.mjs');

async function setup() {
  const dir = await mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), 'p9-auth-'));
  const pending = [], state = {};
  let clock = Date.now();
  const gate = () => new Promise((resolve) => pending.push(resolve));
  // The stub spends the challenge the way the real verifier does, through expectedChallenge, then waits to be released.
  const auth = createAuth({ ledger: openLedger(path.join(dir, 'ledger.db')), rpID: 'p9.localhost', origin: 'http://app.p9.localhost',
    now: () => clock, verify: { registration: gate, authentication: (options) => { options.expectedChallenge(state.challenge); return gate(); } } });
  const db = openLedger(path.join(dir, 'ledger.db')).db;
  const login = async (id) => { state.challenge = (await auth.loginOptions()).options.challenge; return auth.loginVerify({ id }); };
  return { auth, db, login, state, release: (value) => pending.shift()?.(value), releaseLast: (value) => pending.pop()?.(value), advance: (ms) => { clock += ms; } };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

for (const action of ['revoke', 'lock', 'reset']) {
  test('Phase 10: a ' + action + ' during a login check wins (C-H1)', async () => {
    const { auth, db, login: start, release } = await setup();
    db.prepare("INSERT INTO devices VALUES ('d1', 'phone', 'cred1', ?, 0, 'active', 0)").run(Buffer.from([1]));
    const login = start('cred1');
    await tick();
    if (action === 'reset') auth.reset(); else auth[action]('d1');
    release({ verified: true, authenticationInfo: { newCounter: 1 } });
    const result = await login;
    assert.equal(result.status, 401, JSON.stringify(result));
    assert.notEqual(db.prepare("SELECT state FROM devices WHERE id = 'd1'").get().state, 'active');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  });
}

const ok = { verified: true, authenticationInfo: { newCounter: 1 } };
test('Phase 10: an assertion for a challenge issued before a lock cannot unlock the device (N-H1)', async () => {
  const { auth, db, state, release } = await setup();
  db.prepare("INSERT INTO devices VALUES ('d1', 'phone', 'cred1', ?, 0, 'active', 0)").run(Buffer.from([1]));
  state.challenge = (await auth.loginOptions()).options.challenge;
  auth.lock('d1');
  const verify = auth.loginVerify({ id: 'cred1' });
  release(ok);
  assert.equal((await verify).status, 401);
  assert.equal(db.prepare("SELECT state FROM devices WHERE id = 'd1'").get().state, 'locked');
});

test('Phase 10: a stale login cannot finish after a lock and a newer login, nor log the newer one out (N-H1 ABA)', async () => {
  const { auth, db, login, release, releaseLast } = await setup();
  db.prepare("INSERT INTO devices VALUES ('d1', 'phone', 'cred1', ?, 0, 'active', 0)").run(Buffer.from([1]));
  const first = login('cred1');
  await tick();
  auth.lock('d1');
  const second = login('cred1');
  await tick();
  releaseLast(ok);
  const newer = await second;
  assert.equal(newer.status, 200, JSON.stringify(newer));
  release(ok);
  assert.equal((await first).status, 401);
  assert.equal(auth.session(newer.token).status, 0);
});

for (const action of ['reset', 'refuse']) {
  test('Phase 10: a ' + action + ' during an enrollment check adds no device (C-H2)', async () => {
    const { auth, db, release } = await setup();
    const { enrollment } = auth.request({ name: 'phone' });
    auth.approve(enrollment);
    assert.equal((await auth.enrollOptions(enrollment)).status, 200);
    const verify = auth.enrollVerify(enrollment, {});
    await tick();
    if (action === 'reset') auth.reset(); else auth.refuse(enrollment);
    release({ verified: true, registrationInfo: { credential: { id: 'cred2', publicKey: new Uint8Array([1]), counter: 0 } } });
    const result = await verify;
    assert.equal(result.status, 403, JSON.stringify(result));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM devices').get().n, 0);
  });
}

test('Phase 10: an approval older than 10 minutes cannot finish enrolling', async () => {
  const { auth, db, release, advance } = await setup();
  const { enrollment } = auth.request({ name: 'phone' });
  auth.approve(enrollment);
  assert.equal((await auth.enrollOptions(enrollment)).status, 200);
  advance(11 * 60 * 1000);
  const verify = auth.enrollVerify(enrollment, {});
  release({ verified: true, registrationInfo: { credential: { id: 'cred3', publicKey: new Uint8Array([1]), counter: 0 } } });
  assert.equal((await verify).status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM devices').get().n, 0);
});

test('Phase 10: an enrollment whose check crosses the 10-minute deadline does not finish', async () => {
  const { auth, db, release, advance } = await setup();
  const { enrollment } = auth.request({ name: 'phone' });
  auth.approve(enrollment);
  assert.equal((await auth.enrollOptions(enrollment)).status, 200);
  const verify = auth.enrollVerify(enrollment, {});
  await tick();
  advance(11 * 60 * 1000);
  release({ verified: true, registrationInfo: { credential: { id: 'cred4', publicKey: new Uint8Array([1]), counter: 0 } } });
  assert.equal((await verify).status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM devices').get().n, 0);
});

// Review #11 (F1): a phone that waited 9 minutes for the desktop still gets 10 from the approval; an unapproved request lapses at 10.
test('Phase 10: the 10 minutes to finish enrolling count from the approval, not the request', async () => {
  const { auth, db, release, advance } = await setup();
  const late = auth.request({ name: 'phone' }).enrollment;
  advance(9 * 60 * 1000);
  assert.equal(auth.approve(late).status, 200);
  advance(9 * 60 * 1000);
  assert.equal((await auth.enrollOptions(late)).status, 200);
  const verify = auth.enrollVerify(late, {});
  release({ verified: true, registrationInfo: { credential: { id: 'cred5', publicKey: new Uint8Array([1]), counter: 0 } } });
  assert.equal((await verify).status, 201);
  const unapproved = auth.request({ name: 'tablet' }).enrollment;
  advance(11 * 60 * 1000);
  assert.equal(auth.approve(unapproved).status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM devices').get().n, 1);
});

test('Phase 10: stillAuthorized stops work once the session check fails, and passes on the desktop (C-H4)', () => {
  let live = true;
  authority.run(() => live, () => {
    stillAuthorized();
    live = false;
    assert.throws(stillAuthorized, /session-ended/);
  });
  stillAuthorized();  // no store: a desktop request
});

test('Phase 12: a device revoked before its approval lands cannot approve the waiting agent action (cold-read H1)', async (t) => {
  const { createChat } = await import('../apps/server/chat.mjs');
  const { createLifecycle } = await import('../apps/server/lifecycle.mjs');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-answer-race-'));
  const chat = createChat({ ledger: openLedger(path.join(dir, 'ledger.db')), workspace: dir, adapterOverride: path.join(import.meta.dirname, 'fake-acp-agent.mjs'),
    instance: 'race-' + process.pid, lifecycle: createLifecycle() });
  t.after(() => chat.shutdown());
  const id = (await chat.create({ provider: 'claude' })).conversation;
  assert.equal((await chat.prompt(id, { text: 'permission' })).status, 202);
  let approval, cursor = 0;
  for (let i = 0; i < 40 && !approval; i++) {
    const page = await chat.events(cursor, 1000);
    cursor = page.cursor;
    approval = page.events.find((event) => event.type === 'approval');
  }
  assert.ok(approval, 'approval request');
  const answer = { request: approval.data.request, answer: { optionId: 'allow' } };
  // The session check now fails (revoked after the route's own check): the answer throws and the request stays waiting.
  authority.run(() => false, () => assert.throws(() => chat.answer(id, answer), /session-ended/));
  const after = await chat.events(cursor, 500);
  assert.ok(!after.events.some((event) => event.type === 'answered'), 'answered after revoke');
  assert.equal(chat.answer(id, answer).status, 200);
  console.log('PASS revoked answer: throws session-ended, approval still waiting, desktop answer then 200');
});

test('Release r1: a device revoked while the mode is being set sends no prompt (R1-1)', async (t) => {
  const { createChat } = await import('../apps/server/chat.mjs');
  const { createLifecycle } = await import('../apps/server/lifecycle.mjs');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-prompt-race-'));
  const chat = createChat({ ledger: openLedger(path.join(dir, 'ledger.db')), workspace: dir, adapterOverride: path.join(import.meta.dirname, 'fake-acp-agent.mjs'),
    instance: 'prace-' + process.pid, lifecycle: createLifecycle() });
  t.after(() => chat.shutdown());
  const id = (await chat.create({ provider: 'claude' })).conversation;
  // The first check (before the mode await) passes; every later one fails, as after a revoke during setMode.
  let checks = 0;
  await authority.run(() => ++checks === 1, () => assert.rejects(chat.prompt(id, { text: 'after revoke', mode: 'Plan' }), /session-ended/));
  let events = [], cursor = 0;
  for (let i = 0; i < 5; i++) { const page = await chat.events(cursor, 200); cursor = page.cursor; events = events.concat(page.events); }
  assert.ok(!events.some((event) => event.type === 'turn-end' || event.data?.sessionUpdate === 'agent_message_chunk'), 'the agent got the prompt: ' + JSON.stringify(events.map((e) => e.type)));
  assert.equal((await chat.prompt(id, { text: 'desktop' })).status, 202);
  console.log('PASS revoked during setMode: session-ended, nothing sent, desktop prompt then 202');
});

test('Phase 12: a remote device gets 600 new operation IDs an hour; the desktop and other devices are not limited (cold-read M2)', async () => {
  const { Hono } = await import('hono');
  const { operations } = await import('../apps/server/ledger.mjs');
  const { randomUUID } = await import('node:crypto');
  const ledger = openLedger(':memory:');
  const remote = new Hono().use('*', operations(ledger, (c) => 'device:' + c.req.header('x-dev'))).post('*', (c) => c.json({ ok: true }));
  const desktop = new Hono().use('*', operations(ledger, 'desktop')).post('*', (c) => c.json({ ok: true }));
  const post = (app, dev) => app.request('/x', { method: 'POST', headers: { 'x-p9-op': randomUUID(), 'x-dev': dev }, body: '{}' });
  for (let i = 0; i < 600; i++) assert.equal((await post(remote, 'a')).status, 200);
  const over = await post(remote, 'a');
  assert.equal(over.status, 429);
  assert.equal((await over.json()).error, 'operation-quota');
  assert.equal((await post(remote, 'b')).status, 200);
  for (let i = 0; i < 700; i++) assert.equal((await post(desktop)).status, 200);
  console.log('PASS operation quota: device a 600 then 429, device b 200, desktop 700 unlimited');
});
