// O193: P9 carries a sprint item from ready to the merge. Each wake goes to the item's one next actor, once per
// (worker, item, state, commit); a restart and a dropped event are caught; a paused sprint gets only what it got before.
// createDelegate over a stub chat: the persisted records live in `store`, so a new createDelegate is a P9 restart.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// O188's 10-minute check, shortened (honoured only under a test home); read when delegate.mjs loads.
process.env.P9_TEST_HOME ||= tmpdir();
process.env.P9_WAKE_AFTER_MS = '200';
const { createDelegate } = await import('../apps/server/delegate.mjs');
const { decide } = await import('../apps/server/carry.mjs');

const lead = '00000000-0000-0000-0000-00000000000a';
const worker = '00000000-0000-0000-0000-00000000000b';
const reviewer = '00000000-0000-0000-0000-00000000000c';
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

// The worker's commits are on a branch, not on main: a commit already on main is a stale record.
function repo(t) {
  const folder = mkdtempSync(join(tmpdir(), 'p9-carry-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const g = (...a) => execFileSync('git', ['-C', folder, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...a], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', folder]);
  g('commit', '--allow-empty', '-qm', 'base'); g('checkout', '-qb', 'work');
  return { folder, commit: (m) => { g('commit', '--allow-empty', '-qm', m); return g('rev-parse', 'HEAD'); }, merge: () => { g('checkout', '-q', 'main'); g('merge', '-q', '--ff-only', 'work'); g('checkout', '-q', 'work'); } };
}

function world(t, { paused = false, withReviewer = true } = {}) {
  const { folder, commit, merge } = repo(t);
  const store = new Map([[worker, { task: { item: 'B1', doneMeans: 'done', checks: ['test'] } }]]);
  const states = new Map([[lead, 'running'], [worker, 'running'], [reviewer, 'running']]);
  const family = [{ id: lead, project: 'p', title: 'Lead' }, { id: worker, parent: lead, key: 'w1', project: 'p', title: 'Kid' },
    ...(withReviewer ? [{ id: reviewer, parent: lead, key: 'review', project: 'p', title: 'Rev' }] : [])];
  const prompts = [], notes = [];
  const make = () => {
    const settled = [];
    let ready;
    const restarted = new Promise((resolve) => { ready = resolve; });
    const chat = {
      lock: () => ({ on: false }), list: () => [], family: () => family,
      info: (id) => { const c = family.find((x) => x.id === id); return c && { provider: 'claude', mode: 'Auto', ...c, state: states.get(id) }; },
      activeTaskTurn: (id) => (states.get(id) === 'turn' ? 'turn-1' : null),
      sprint: (id) => store.get(id) ?? {}, setSprint: (id, patch) => store.set(id, { ...(store.get(id) ?? {}), ...patch }),
      startFolder: async () => folder, gauge: () => ({}), pin: () => {}, turnEnded: () => {}, acts: () => 0, reply: () => 'done for now',
      note: async (id, text) => { notes.push([id, text]); }, prompt: async (id, body) => { prompts.push([id, body.text]); return { status: 202 }; },
      settled: (hook) => { settled.push(hook); }, restarted: () => restarted,
      projects: { started: (id) => (id === lead ? { plan: 'hash', at: 1 } : null), closed: () => null }, paused: () => paused,
    };
    const tools = createDelegate({ chat });
    return { tools, end: async (id) => { for (const hook of settled) hook(id, true); await settle(); }, boot: async () => { ready({ chats: [], storm: false }); await settle(); } };
  };
  const ready = async (p9, c) => { states.set(worker, 'turn'); const out = await p9.tools.ready({ commit: c, results: [{ check: 'test', result: 'passed' }], weakest: 'none' }, worker); states.set(worker, 'running'); assert.ok(out.ready, JSON.stringify(out)); await settle(); };
  const verdict = async (p9, c, result) => { states.set(reviewer, 'turn'); const out = p9.tools.verdict({ chat: worker, commit: c, result, note: 'see the test' }, reviewer); states.set(reviewer, 'running'); assert.ok(out.verdict, JSON.stringify(out)); await settle(); };
  const who = { [lead]: 'lead', [worker]: 'worker', [reviewer]: 'reviewer' };
  return { make, store, states, commit, merge, prompts, notes, ready, verdict, order: () => prompts.map(([id]) => who[id]) };
}

test('O193: an item\'s whole life (ready, fix, ready, pass) wakes reviewer, worker, reviewer, lead, in that order, and nothing else', { timeout: 30000 }, async (t) => {
  const w = world(t), p9 = w.make();
  await p9.boot();
  const c1 = w.commit('one');
  await w.ready(p9, c1); await p9.end(worker);
  await w.verdict(p9, c1, 'fix'); await p9.end(reviewer);
  const c2 = w.commit('two');
  await w.ready(p9, c2); await p9.end(worker);
  await w.verdict(p9, c2, 'pass'); await p9.end(reviewer);
  await p9.end(lead); await p9.end(reviewer); // later ends wake nobody again
  assert.deepEqual(w.order(), ['reviewer', 'worker', 'reviewer', 'lead'], JSON.stringify(w.prompts));
  assert.equal(w.prompts[3][1], `[p9] B1 by Kid passed at ${c2}: merge it.`);
  assert.equal(w.prompts[1][1], `[p9] B1: the reviewer asked for a fix (fix 1) at ${c1}: see the test`);
  assert.ok(w.notes.some(([id, text]) => id === worker && text.includes('passed review')), 'the worker hears of the pass as a note');
  w.merge(); // merged: the passed record is stale, and a restart wakes nobody
  await w.make().boot();
  assert.equal(w.prompts.length, 4);
});

test('O193: a P9 restart between ready and verdict still wakes the reviewer, once', { timeout: 30000 }, async (t) => {
  const w = world(t), first = w.make();
  await first.boot();
  w.states.set(reviewer, 'turn'); // busy at ready: no wake yet
  await w.ready(first, w.commit('one'));
  assert.deepEqual(w.order(), []);
  w.states.set(reviewer, 'stopped'); // P9 restarts: the reviewer's turn and its end are lost
  await w.make().boot();
  assert.deepEqual(w.order(), ['reviewer']);
  await w.make().boot(); // the wake is kept, so not sent again; the lead is told once instead
  await w.make().boot();
  assert.deepEqual(w.order(), ['reviewer', 'lead']);
  assert.match(w.prompts[1][1], /Rev ended its turn on B1 at .* without acting on it/);
});

test('O193: a dropped event is caught on the next event for that sprint; a reviewer ending with no verdict tells the lead once', { timeout: 30000 }, async (t) => {
  const w = world(t), p9 = w.make();
  await p9.boot();
  w.states.set(reviewer, 'turn');
  await w.ready(p9, w.commit('one'));
  w.states.set(reviewer, 'running'); // its turn ended, but that event never came
  assert.deepEqual(w.order(), []);
  await p9.end(lead); // the next event for the sprint, from another chat
  assert.deepEqual(w.order(), ['reviewer']);
  await p9.end(reviewer); // woken, ended, no verdict
  await p9.end(reviewer);
  assert.deepEqual(w.order(), ['reviewer', 'lead']);
});

test('O193: a worker still stopped after its end with no ready and nothing sent to the lead wakes the lead once', { timeout: 30000 }, async (t) => {
  const w = world(t), p9 = w.make();
  await p9.boot();
  await p9.end(worker); await settle(3600); // END_HOLD_MS, then the shortened 10-minute check
  assert.deepEqual(w.order(), ['lead']);
  assert.equal(w.prompts[0][1], '[p9] Kid ended its turn with no ready and nothing queued for you.');
  const sent = await p9.tools.send_chat({ chat: lead, text: 'B1 is up', when: 'queue' }, worker); // a message to the lead
  assert.ok(!sent?.error, JSON.stringify(sent));
  w.prompts.length = 0;
  await p9.end(worker); await settle(3600);
  assert.equal(w.prompts.filter(([, s]) => s.includes('no ready')).length, 0, JSON.stringify(w.prompts));
});

test('O193: ready with no reviewer tells the lead; a paused sprint gets only what it got before', { timeout: 30000 }, async (t) => {
  const lone = world(t, { withReviewer: false }), p9 = lone.make();
  await p9.boot();
  await lone.ready(p9, lone.commit('one'));
  assert.deepEqual(lone.order(), ['lead']);
  assert.match(lone.prompts[0][1], /no reviewer can take it/);

  const held = world(t, { paused: true }), plain = held.make();
  await plain.boot();
  const c1 = held.commit('one');
  await held.ready(plain, c1); await plain.end(worker);
  await held.verdict(plain, c1, 'fix'); await plain.end(reviewer);
  const c2 = held.commit('two');
  await held.ready(plain, c2);
  await held.verdict(plain, c2, 'pass'); await plain.end(lead);
  await held.make().boot();
  assert.deepEqual(held.order(), ['reviewer', 'worker', 'reviewer', 'worker'], 'today\'s prompts: the ready line, the fix and the pass to the worker');
  assert.equal(held.store.get(lead)?.carry, undefined, 'nothing is recorded in a paused sprint');
});

test('O193 decide: a record whose commit is on main, or queued before the sprint started, wakes nobody', () => {
  const base = { lead: { id: 'L', busy: false }, started: 100, reviewer: { id: 'R', title: 'Rev', busy: false }, woken: {} };
  const one = (r) => decide({ ...base, workers: [{ id: 'W', title: 'Kid', reviews: { B1: r } }] }, { type: 'end' });
  assert.equal(one({ state: 'queued', commit: 'c', at: 50 }).length, 0);
  assert.equal(one({ state: 'passed', commit: 'c', at: 150, onMain: true }).length, 0);
  assert.deepEqual(one({ state: 'queued', commit: 'c', at: 150 }).map((w) => [w.chat, w.key]), [['R', 'W:B1:queued:c']]);
  assert.equal(decide({ ...base, woken: { 'W:B1:queued:c': 1 }, workers: [{ id: 'W', title: 'Kid', reviews: { B1: { state: 'queued', commit: 'c', at: 150 } } }] }, { type: 'end', chat: 'W' }).length, 0, 'another chat\'s end tells nobody');
});
