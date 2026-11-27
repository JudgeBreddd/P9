// O260: a turn that ends while a message waits in the daemon's hold is not finished: the daemon sends that message as
// the next turn. The background "<agent> finished" notice shows only when no turn starts after the end, whether the
// next turn's user event comes in the same poll as the end or in a later one; a paused message or a note held starts
// no turn, so it does not hold the notice back; and two ends of one chat in one poll make one notice. The daemon's timing cannot pick which poll an event lands in, so the
// test writes the chat's events into the ledger itself, one batch per poll, as agent-warning.test.mjs does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { _electron } from '@playwright/test';
import { daemon, http, authenticated, root } from './helpers.mjs';

const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((result) => JSON.parse(result.text));

test('O260: no finished notice while a held message starts the next turn (end and next turn in one poll or two); one when that turn ends, also for both ends in one poll; a paused message or a note held does not stop it', { timeout: 180000 }, async (t) => {
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
  const ev = {
    user: (text, held) => ['user', { text, ...(held && { held }) }],
    say: (text) => ['update', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }],
    held: (hid, text, when = 'queue', info) => ['held', { id: hid, text, when, ...(info && { info: true }) }],
    end: () => ['turn-end', { stopReason: 'end_turn' }],
  };
  // One poll's events: written in one transaction (all seen together), the long poll woken by a rename of another
  // chat, and done once its reply line is drawn (the window draws a batch after settling its turn ends).
  let wakes = 0;
  const poll = async (mark, ...events) => {
    db.exec('BEGIN'); for (const [type, data] of [ev.say(' ' + mark), ...events]) add.run(id, type, JSON.stringify(data), Date.now()); db.exec('COMMIT');
    await call(instance, '/chat/' + waker + '/rename', 'POST', { title: 'wake ' + ++wakes });
    await pane.locator('.msg.agent', { hasText: mark }).waitFor({ timeout: 15000 });
  };
  const notes = () => page.evaluate(() => window.__notes.length);

  // Two polls: the end comes alone while 'second' waits held; the next turn's user event comes in the next poll.
  await poll('m1', ev.user('first'), ev.held('h1', 'second'));
  await poll('m2', ev.end());
  assert.equal(await notes(), 0, 'a turn that ended with a message held made a finished notice');
  await poll('m3', ev.user('second', ['h1']), ev.end());
  assert.equal(await notes(), 1, 'the held message\'s turn ended: one finished notice');

  // One poll: the end and the next turn's user event together, so the hold is already empty when the poll is settled.
  await poll('m4', ev.user('third'), ev.held('h2', 'fourth'));
  await poll('m5', ev.end(), ev.user('fourth', ['h2']));
  assert.equal(await notes(), 1, 'a turn that ended as the next one started (one poll) made a finished notice');
  await poll('m6', ev.end());
  assert.equal(await notes(), 2, 'the next turn ended: one more finished notice');

  // One poll with both ends: the held message's whole turn came with the end before it. One notice, not one per end.
  await poll('m7', ev.user('sixth'), ev.held('h5', 'seventh'));
  await poll('m8', ev.end(), ev.user('seventh', ['h5']), ev.end());
  assert.equal(await notes(), 3, 'two ends of one chat in one poll: one finished notice');

  // A paused message and a note held start no turn: the end is the chat's last, and it says so.
  await poll('m9', ev.user('fifth'), ev.held('h3', 'kept for the pause', 'pause'), ev.held('h4', 'a note', 'queue', true));
  await poll('m10', ev.end());
  assert.deepEqual(await page.evaluate(() => window.__notes), ['Claude finished', 'Claude finished', 'Claude finished', 'Claude finished'], 'a paused message or a note held stopped the finished notice');
  console.log('PASS O260: 0 notices with a message held at the end (two polls) or the next turn started (one poll), 1 at each next end, 1 for two ends in one poll, 1 with only a paused message and a note held');
});
