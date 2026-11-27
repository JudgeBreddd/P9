// O260 (the part fixed here): a chat whose held message ran a whole turn inside one poll ended twice in that poll, and the
// background "<agent> finished" notice came once per end. It comes once per chat per poll now. The end that sends a held
// message in one poll and that turn's end in a later poll still make two notices: that case stays open (O260 follow-up).
// The test writes the chat's events into the ledger itself, one batch per poll, as agent-warning.test.mjs does, since the
// daemon's timing cannot pick which poll an event lands in.
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
  // The daemon's events as chat.mjs writes them.
  const ev = {
    user: (text, held) => ['user', { text, ...(held && { held }) }],
    say: (text) => ['update', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }],
    held: (hid, text) => ['held', { id: hid, text, when: 'queue' }],
    end: () => ['turn-end', { stopReason: 'end_turn' }],
  };
  // One poll's events: written in one transaction (all seen together), the long poll woken by a rename of another
  // chat, and done once its reply line is drawn (the window draws a batch after settling its turn ends).
  let wakes = 0;
  const poll = async (mark, ...events) => {
    db.exec('BEGIN');
    for (const [type, data] of [ev.say(' ' + mark), ...events]) add.run(id, type, JSON.stringify(data), Date.now());
    db.exec('COMMIT');
    await call(instance, '/chat/' + waker + '/rename', 'POST', { title: 'wake ' + ++wakes });
    await pane.locator('.msg.agent', { hasText: mark }).waitFor({ timeout: 20000 });
  };
  const notes = () => page.evaluate(() => window.__notes.length);
  return { ev, poll, notes, page };
}

test('O260: a chat that ends twice in one poll (its held message ran a whole turn there) makes one finished notice', { timeout: 180000 }, async (t) => {
  const { ev, poll, notes, page } = await setup(t);
  // One end in its own poll: one notice (the window does notify in the background).
  await poll('m1', ev.user('first'));
  await poll('m2', ev.end());
  assert.equal(await notes(), 1, 'one end: not one finished notice');
  // Both ends in one poll: one notice, not one per end.
  await poll('m3', ev.user('second'), ev.held('h1', 'third'));
  await poll('m4', ev.end(), ev.user('third', ['h1']), ev.end());
  assert.deepEqual(await page.evaluate(() => window.__notes), Array(2).fill('Claude finished'), 'two ends of one chat in one poll: not one finished notice');
  console.log('PASS O260: 1 notice for one end, 1 for two ends of one chat in one poll');
});
