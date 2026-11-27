// O260: a turn that ends while the daemon holds a message it sends as the next turn at once is not finished. The daemon
// says so on that end (turn-end next); the background "<agent> finished" notice skips only such an end. The new turn's
// end, or the daemon's word that the held message did not start one after all (unheld ends), shows it, so every turn
// the window sees ends in exactly one notice. The first test runs the real chat.mjs (the fake agent) and checks the
// marks it writes. The window tests write the chat's events into the ledger themselves, one batch per poll, as
// agent-warning.test.mjs does, since the daemon's timing cannot pick which poll an event lands in; the last one runs the real daemon.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { _electron } from '@playwright/test';
import { daemon, http, authenticated, root } from './helpers.mjs';
import { openLedger } from '../apps/server/ledger.mjs';
import { authority } from '../apps/server/authority.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('O260 daemon: an end that sends a held message as a new turn says next; a paused sprint, a held worker, a Stop and a refused message do not, or say ends', { timeout: 120000 }, async (t) => {
  const { createChat } = await import('../apps/server/chat.mjs');
  const { createLifecycle } = await import('../apps/server/lifecycle.mjs');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-o260-'));
  const chat = createChat({ ledger: openLedger(path.join(dir, 'ledger.db')), workspace: dir, adapterOverride: path.join(import.meta.dirname, 'fake-acp-agent.mjs'),
    instance: 'o260-' + process.pid, lifecycle: createLifecycle() });
  t.after(() => chat.shutdown());
  const go = path.join(dir, 'go');
  const of = async (id) => (await chat.events(0, 0, [id])).events;
  const until = async (id, test, what) => {
    for (let i = 0; i < 300; i++) { const events = await of(id); if (test(events)) return events; await wait(50); }
    assert.fail(what + ': ' + JSON.stringify((await of(id)).map((e) => [e.type, e.data?.text ?? e.data?.content?.text ?? e.data?.stopReason])));
  };
  const said = (text) => (events) => events.some((e) => e.data?.content?.text === text);
  const ends = (events) => events.filter((e) => e.type === 'turn-end');
  // A chat in a gated turn ('gate' works until the go file is there), with one message held for the turn's end.
  const gated = async (id, text, from, scope) => {
    await unlink(go).catch(() => {});
    assert.equal((await chat.prompt(id, { text: 'gate' })).status, 202);
    await until(id, said('gating'), 'no gated turn');
    const held = await (scope ?? ((f) => f()))(() => chat.prompt(id, { text, when: 'queue' }, undefined, from));
    assert.equal(held.status, 202); assert.equal(held.when, 'queue');
    return held.held;
  };
  const make = async (lineage) => (await chat.create({ provider: 'claude' }, undefined, lineage)).conversation;
  const other = await make();

  // Sent at the end as a new turn: that end says next; the held message's own turn ends without it.
  const a = await make(), ha = await gated(a, 'second');
  await writeFile(go, '');
  let events = await until(a, (e) => ends(e).length === 2, 'the held message\'s turn did not end');
  const [first, second] = ends(events), user = events.find((e) => e.type === 'user' && e.data.text === 'second');
  assert.equal(first.data.next, true, 'the end that sent a held message did not say next');
  assert.ok(user && user.cursor > first.cursor && user.data.held.includes(ha), 'the held message was not sent after the end');
  assert.equal(second.data.next, undefined, 'the last end said next');

  // A sprint paused at the end: its lead's message is kept for Resume, no turn starts, and the end does not say next.
  const lead = await make(), child = await make({ parent: lead });
  await gated(child, 'from the lead', lead);
  assert.equal(chat.pause(lead), true);
  await writeFile(go, '');
  events = await until(child, (e) => ends(e).length === 1, 'the paused sprint\'s turn did not end');
  await wait(500);
  events = await of(child);
  assert.equal(ends(events)[0].data.next, undefined, 'a paused sprint\'s end said next');
  assert.ok(!events.some((e) => e.type === 'user' && e.data.text === 'from the lead'), 'a paused sprint started a turn');

  // A worker its lead holds (paused:<worker>): the same.
  const worker = await make();
  await gated(worker, 'from the other chat', other);
  assert.equal(chat.pause(worker), true);
  await writeFile(go, '');
  events = await until(worker, (e) => ends(e).length === 1, 'the held worker\'s turn did not end');
  await wait(500);
  events = await of(worker);
  assert.equal(ends(events)[0].data.next, undefined, 'a held worker\'s end said next');
  assert.ok(!events.some((e) => e.type === 'user' && e.data.text === 'from the other chat'), 'a held worker started a turn');

  // Stop: the turn ends cancelled without next, and what waited goes back without ends (that end showed it).
  const stop = await make();
  assert.equal((await chat.prompt(stop, { text: 'long work' })).status, 202);
  await until(stop, (e) => e.some((x) => x.type === 'update' && x.data?.sessionUpdate === 'tool_call'), 'no long work');
  assert.equal((await chat.prompt(stop, { text: 'after the stop', when: 'queue' })).status, 202);
  await chat.cancel(stop);
  events = await until(stop, (e) => ends(e).length && e.some((x) => x.type === 'unheld'), 'the stopped turn did not end with its message handed back');
  assert.equal(ends(events)[0].data.stopReason, 'cancelled');
  assert.equal(ends(events)[0].data.next, undefined, 'a stopped turn\'s end said next');
  assert.equal(events.find((e) => e.type === 'unheld').data.ends, undefined, 'a message handed back by Stop said ends');

  // A held message whose sender was revoked before the end: the end said next, so its refusal says ends (the window's notice).
  const revoked = await make();
  let allowed = true;
  const hr = await gated(revoked, 'from a revoked phone', undefined, (f) => authority.run(() => allowed, f));
  allowed = false;
  await writeFile(go, '');
  events = await until(revoked, (e) => e.some((x) => x.type === 'unheld'), 'the revoked message was not refused');
  const refusedEv = events.find((e) => e.type === 'unheld');
  assert.equal(ends(events)[0].data.next, true);
  assert.deepEqual([refusedEv.data.id, refusedEv.data.why, refusedEv.data.ends], [hr, 'session-ended', true], 'the refused message did not say ends');
  assert.ok(!events.some((e) => e.type === 'user' && e.data.text === 'from a revoked phone'), 'a revoked message was sent');
  console.log('PASS O260 daemon: next on the end that sends a held message (not on its own end); none for a paused sprint, a held worker, a Stop; unheld ends for a refused one');
});

const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((result) => JSON.parse(result.text));

// One background window on one live chat, whose events each poll writes into the ledger.
async function setup(t) {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', path.join(root, 'test/fake-acp-agent.mjs')] }));
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-o260-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#dataNote', { hasText: 'Chat live' }).waitFor({ timeout: 20000 });
  // Made after the window is live, so it is a whole chat here (not one whose history loads first).
  const id = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  const waker = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  await page.locator('#nav .row[data-chat="' + id + '"]').click();
  const pane = page.locator('#chats .pane[data-id="' + id + '"]');
  await pane.waitFor({ timeout: 15000 });
  // The window is in the background; the OS notice is recorded instead of shown.
  await page.evaluate(() => { window.__notes = []; document.hasFocus = () => false; window.Notification = class { constructor(title) { window.__notes.push(title); } }; });
  const db = new DatabaseSync(path.join(instance.directory, '.local', 'state', 'p9-foundation', 'p9.db'), { timeout: 5000 });
  t.after(() => db.close());
  const add = db.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)');
  // The daemon's events as chat.mjs writes them; next and ends are its O260 marks (the first test checks it writes them).
  const ev = {
    user: (text, held, more) => ['user', { text, ...(held && { held }), ...more }],
    unheld: (hid, text, why, ends) => ['unheld', { id: hid, text, why, ...(ends && { ends: true }) }],
    say: (text) => ['update', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }],
    held: (hid, text, when = 'queue', info) => ['held', { id: hid, text, when, ...(info && { info: true }) }],
    end: (next, stopReason = 'end_turn') => ['turn-end', { stopReason, ...(next && { next: true }) }],
  };
  // One poll's events: written in one transaction (all seen together), the long poll woken by a rename of another
  // chat, and done once its reply line is drawn (the window draws a batch after settling its turn ends). gap: that many
  // of the other chat's events first, so the window's page is full and it catches up instead (O251 jump).
  let wakes = 0;
  const poll = async (mark, ...events) => {
    const gap = typeof events[0] === 'number' ? events.shift() : 0;
    db.exec('BEGIN');
    for (let i = 0; i < gap; i++) add.run(waker, 'update', JSON.stringify(ev.say('.')[1]), Date.now());
    for (const [type, data] of [ev.say(' ' + mark), ...events]) add.run(id, type, JSON.stringify(data), Date.now());
    db.exec('COMMIT');
    await call(instance, '/chat/' + waker + '/rename', 'POST', { title: 'wake ' + ++wakes });
    await pane.locator('.msg.agent', { hasText: mark }).waitFor({ timeout: 20000 });
  };
  const notes = () => page.evaluate(() => window.__notes.length);
  return { ev, poll, notes, page, pane, instance, id };
}

test('O260: no finished notice at an end that sends a held message (its turn in the same poll or the next); one when that turn ends, also for both ends in one poll; one with only a paused message or a note held', { timeout: 180000 }, async (t) => {
  const { ev, poll, notes, page } = await setup(t);
  // Two polls: the end that sends 'second' comes alone; that turn's user event comes in the next poll.
  await poll('m1', ev.user('first'), ev.held('h1', 'second'));
  await poll('m2', ev.end(true));
  assert.equal(await notes(), 0, 'an end that sends a held message made a finished notice');
  await poll('m3', ev.user('second', ['h1']), ev.end());
  assert.equal(await notes(), 1, 'the held message\'s turn ended: one finished notice');

  // One poll: the end and the next turn's user event together.
  await poll('m4', ev.user('third'), ev.held('h2', 'fourth'));
  await poll('m5', ev.end(true), ev.user('fourth', ['h2']));
  assert.equal(await notes(), 1, 'an end that sent a held message (its turn in the same poll) made a finished notice');
  await poll('m6', ev.end());
  assert.equal(await notes(), 2, 'the next turn ended: one more finished notice');

  // Both ends in one poll: one notice, not one per end.
  await poll('m7', ev.user('sixth'), ev.held('h5', 'seventh'));
  await poll('m8', ev.end(true), ev.user('seventh', ['h5']), ev.end());
  assert.equal(await notes(), 3, 'two ends of one chat in one poll: not one finished notice');

  // A paused message and a note held start no turn: the end says no next, and it is the chat's last.
  await poll('m9', ev.user('fifth'), ev.held('h3', 'kept for the pause', 'pause'), ev.held('h4', 'a note', 'queue', true));
  await poll('m10', ev.end());
  assert.deepEqual(await page.evaluate(() => window.__notes), Array(4).fill('Claude finished'), 'a paused message or a note held stopped the finished notice');
  console.log('PASS O260: 0 notices at an end that sends a held message (two polls or one), 1 at each next end, 1 for two ends in one poll, 1 with only a paused message and a note held');
});

test('O260: a steer into the turn that ended (a steered note, a late or unconfirmed acknowledgement) in the poll of the end leaves one finished notice', { timeout: 180000 }, async (t) => {
  const { ev, poll, notes } = await setup(t);
  await poll('n1', ev.user('a'));
  await poll('n2', ev.end(), ev.user('a note steered in', undefined, { steered: true, info: true }));
  assert.equal(await notes(), 1, 'a steered note after the end: not one finished notice');
  await poll('n3', ev.user('b'));
  await poll('n4', ev.end(), ev.user('a late steer', undefined, { steered: true }));
  assert.equal(await notes(), 2, 'a steer acknowledged after the end: not one finished notice');
  await poll('n5', ev.user('c'));
  await poll('n6', ev.end(), ev.user('a slow steer', undefined, { steered: true, unconfirmed: true }));
  await poll('n7', ['steer-lost', { text: 'a slow steer' }]);
  assert.equal(await notes(), 3, 'an unconfirmed steer after the end, then lost: not one finished notice');
  console.log('PASS O260 steers: 1 notice each for a steered note, a late steer and an unconfirmed steer after the end');
});

test('O260: a held message refused or handed back, queued then paused, held for a held worker, a held steer acknowledged after the end, and a catch-up while held: one finished notice each', { timeout: 180000 }, async (t) => {
  const { ev, poll, notes, page } = await setup(t);
  // Refused after an end that said next (a revoked sender): its unheld says ends, and the notice shows then.
  await poll('p1', ev.user('d'), ev.held('h6', 'e'));
  await poll('p2', ev.end(true));
  assert.equal(await notes(), 0, 'an end that sends a held message made a finished notice');
  await poll('p3', ev.unheld('h6', 'e', 'session-ended', true));
  assert.equal(await notes(), 1, 'a held message refused after the end: no finished notice');
  // Handed back by a Stop: the cancelled end says no next, so it shows; the hand-back and a quiet poll add none.
  await poll('p4', ev.user('f'), ev.held('h7', 'g'));
  await poll('p5', ev.end(false, 'cancelled'), ev.unheld('h7', 'g', 'cancelled'));
  await poll('p6');
  assert.equal(await notes(), 2, 'a held message handed back by Stop: not one finished notice');
  // Handed back after an end that said next (the chat stopped as it ended): ends, once.
  await poll('p7', ev.user('f2'), ev.held('h9', 'g2'));
  await poll('p8', ev.end(true));
  await poll('p9', ev.unheld('h9', 'g2', 'stopped', true));
  await poll('p10');
  assert.equal(await notes(), 3, 'a held message handed back after the end: not one finished notice');
  // Queued, then the sprint paused before the end: the daemon keeps it for Resume (no new held event, so the window
  // still lists it as queued) and the end says no next. A held worker's is the same; its Resume's turn ends in one more.
  await poll('p11', ev.user('j'), ev.held('h10', 'k'));
  await poll('p12', ev.end());
  await poll('p13');
  assert.equal(await notes(), 4, 'a message kept for a pause still listed as queued: not one finished notice');
  await poll('p14', ev.user('k', ['h10']), ev.end());
  assert.equal(await notes(), 5, 'the resumed message\'s turn: not one finished notice');
  // A held steer taken into the old turn just before it ended: it left the hold, so the end says no next.
  await poll('p15', ev.user('h'), ev.held('h8', 'i', 'steer'));
  await poll('p16', ev.end());
  await poll('p17', ev.user('i', ['h8'], { steered: true }));
  assert.equal(await notes(), 6, 'a held steer acknowledged after the end: not one finished notice');
  // A catch-up (the window's page full of another chat's events) after an end that said next: the chat is read again;
  // the held message's turn ends after it, in one notice.
  await poll('p18', ev.user('l'), ev.held('h11', 'm'));
  await poll('p19', ev.end(true));
  await poll('p20', 600, ev.user('m', ['h11']));
  await poll('p21', ev.end());
  assert.deepEqual(await page.evaluate(() => window.__notes), Array(7).fill('Claude finished'), 'a catch-up while a held message ran: not one finished notice');
  console.log('PASS O260 holds: 1 notice each for refused, handed back by Stop or after the end, kept for a pause (and its resumed turn), a held steer acknowledged after the end, and a catch-up while held');
});

test('O260 real daemon: a message queued in a gated turn runs at its end; one finished notice, at the end of the held message\'s turn', { timeout: 180000 }, async (t) => {
  const { notes, pane, instance, id } = await setup(t);
  assert.ok((await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'gate' })).turn, 'the gated turn did not start');
  await pane.locator('.msg.agent', { hasText: 'gating' }).waitFor({ timeout: 20000 });
  // 'late' replies 1.5 s after it starts, so its end comes in a later poll than the gated turn's.
  assert.ok((await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'late', when: 'queue' })).held, 'the queued message was not held');
  await writeFile(path.join(instance.workspace, 'go'), '');
  // The queued message's user event comes after the gated turn's end, so that end is settled once it is drawn.
  await pane.locator('.msg.user', { hasText: 'late' }).waitFor({ timeout: 20000 });
  await wait(500);
  assert.equal(await notes(), 0, 'the gated turn\'s end, which sent the queued message, made a finished notice');
  await pane.locator('.msg.agent', { hasText: 'late reply' }).waitFor({ timeout: 20000 });
  for (let i = 0; i < 50 && !await notes(); i++) await wait(100);
  await wait(1000);
  assert.equal(await notes(), 1, 'the held message\'s turn ended: not one finished notice');
  console.log('PASS O260 real daemon: 0 notices at the gated end, 1 at the queued message\'s end');
});
