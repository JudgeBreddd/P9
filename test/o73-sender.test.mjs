// O73: a message another chat's agent sent is drawn under that chat's title, never as "You", in the desktop window and on
// the phone, from the chat's history (a reload). The daemon writes the sender's id (from) and its title at send time
// (fromTitle, #393) on the user and note events; these tests seed those events straight into the ledger.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { _electron } from '@playwright/test';
import { daemon, remoteDaemon, root } from './helpers.mjs';
import { phone } from './phone-c16-helpers.mjs';

const LEAD = '00000000-0000-4000-8000-000000007301', WORKER = '00000000-0000-4000-8000-000000007302', GONE = '00000000-0000-4000-8000-000000007303';
const shot = async (target, name) => { const png = await target.screenshot({ type: 'png' }); if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png.toString('base64')); };

// The worker's history: the user's own message, then each way another chat's text arrives. The lead was renamed after it
// sent (its title now is 'Lead renamed'); GONE was deleted, so the ledger has no row for it.
function seed(directory) {
  const db = new DatabaseSync(path.join(directory, '.local', 'state', 'p9-foundation', 'p9.db'), { timeout: 5000 });
  const chat = db.prepare('INSERT INTO conversations (id, provider, title, state, created) VALUES (?, ?, ?, ?, ?)');
  chat.run(LEAD, 'claude', 'Lead renamed', 'idle', Date.now()); chat.run(WORKER, 'claude', 'Worker', 'idle', Date.now());
  const event = db.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)'), add = (type, data) => event.run(WORKER, type, JSON.stringify(data), Date.now());
  add('user', { text: 'My own words.' });
  add('user', { text: 'Start on the parser.', from: LEAD, fromTitle: 'Lead "one"' });
  add('user', { text: 'Sent before titles were kept.', from: LEAD });
  add('note', { text: 'The tests pass on main.', from: LEAD, fromTitle: 'Lead "one"' });
  add('user', { text: 'From a chat since deleted.', from: GONE });
  add('note', { text: '[p9] Kid ended its turn.', from: 'p9' });
  add('user', { text: 'Which file holds the parser?', ask: true, from: LEAD, fromTitle: 'Lead "one"' });
  add('turn-end', { stopReason: 'end_turn' });
  db.close();
}
const HEADINGS = ['Message from Lead "one"', 'Message from Lead renamed', 'Note from Lead "one" · information only', 'Message from a deleted chat', 'Note from P9 · information only', 'Question from Lead "one" · answered read-only'];

test('O73 desktop: another chat\'s message is drawn under its title, not "You", after a reload', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t);
  seed(instance.directory);
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-o73-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#nav .row[data-chat="' + WORKER + '"]').click({ timeout: 20000 });
  const pane = page.locator('#chats .pane[data-id="' + WORKER + '"]');
  await pane.locator('.msg.user', { hasText: 'Which file holds the parser?' }).waitFor({ timeout: 15000 });
  const drawn = await pane.locator('.msg.user').evaluateAll((all) => all.map((m) => [m.querySelector('.who').textContent.replace(/ · \d\d:\d\d$/, ''), m.hasAttribute('data-from'), getComputedStyle(m).alignSelf]));
  assert.deepEqual(drawn, [['You', false, 'flex-end'], ...HEADINGS.map((h) => [h, true, 'flex-start'])], 'each sender named, drawn apart from the user\'s own: ' + JSON.stringify(drawn));
  await shot(pane, 'o73-desktop');
});

test('O73 phone: another chat\'s message is drawn under its title, apart from the user\'s own', { timeout: 180000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  seed(server.directory);
  const { page } = await phone(t, server);
  await page.evaluate((id) => history.replaceState(null, '', '#chat=' + id), WORKER);
  await page.reload();
  await page.waitForFunction(() => /Which file holds the parser\?/.test(document.querySelector('#events')?.textContent ?? ''), null, { timeout: 30000 });
  const drawn = await page.locator('#events article[data-kind="user"]').evaluateAll((all) => all.map((m) => [m.querySelector('.who')?.textContent ?? '', m.hasAttribute('data-from'), getComputedStyle(m).borderStyle]));
  assert.deepEqual(drawn, [['', false, 'none'], ...HEADINGS.map((h) => [h, true, 'dashed'])], 'each sender named, drawn apart from the user\'s own: ' + JSON.stringify(drawn));
  await shot(page, 'o73-phone');
});

// #394 FIX1: a message sent before titles were kept names its sender by the title it has now, so with the chat open and no
// reload, a rename of the sender, then its deletion, redraws that heading; a heading with the send-time title stays.
test('O73 phone: a heading with no send-time title follows a rename and a deletion of the sender without a reload', { timeout: 180000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  seed(server.directory);
  const { page } = await phone(t, server);
  await page.evaluate((id) => history.replaceState(null, '', '#chat=' + id), WORKER);
  await page.reload();
  await page.waitForFunction(() => /Which file holds the parser\?/.test(document.querySelector('#events')?.textContent ?? ''), null, { timeout: 30000 });
  await page.evaluate(() => { window.o73Kept = true; });
  const heads = () => page.locator('#events article[data-kind="user"] .who').evaluateAll((all) => all.map((m) => m.textContent));
  const until = async (want, why) => { await page.waitForFunction((w) => [...document.querySelectorAll('#events article[data-kind="user"] .who')].map((m) => m.textContent).join('|') === w, want.join('|'), { timeout: 20000 }).catch(() => {}); assert.deepEqual(await heads(), want, why); };
  assert.deepEqual(await heads(), HEADINGS);
  assert.equal((await server.desk('/chat/' + LEAD + '/rename', 'POST', { title: 'Lead again' })).status, 200);
  await until(HEADINGS.map((h) => h === 'Message from Lead renamed' ? 'Message from Lead again' : h), 'the rename redraws the heading with no send-time title, and only it');
  assert.equal((await server.desk('/chat/' + LEAD + '/delete', 'POST', {})).status, 200);
  await until(HEADINGS.map((h) => h === 'Message from Lead renamed' ? 'Message from a deleted chat' : h), 'the deletion redraws it as a deleted chat; send-time titles stay');
  assert.equal(await page.evaluate(() => window.o73Kept), true, 'the page did not reload');
});

// O73: on the phone's chat list, a chat whose newest line is another chat's message has something the reader has not read;
// only the reader's own message leaves it unmarked. Three finished chats, each read on this phone at an older line.
const OWN = '00000000-0000-4000-8000-000000007311', TOLD = '00000000-0000-4000-8000-000000007312', REPLIED = '00000000-0000-4000-8000-000000007313';
function seedList(directory) {
  const db = new DatabaseSync(path.join(directory, '.local', 'state', 'p9-foundation', 'p9.db'), { timeout: 5000 });
  const chat = db.prepare('INSERT INTO conversations (id, provider, title, state, created) VALUES (?, ?, ?, ?, ?)');
  for (const [id, title] of [[LEAD, 'Lead'], [OWN, 'Own'], [TOLD, 'Told'], [REPLIED, 'Replied']]) chat.run(id, 'claude', title, 'idle', Date.now());
  const event = db.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)'), add = (id, type, data) => event.run(id, type, JSON.stringify(data), Date.now());
  add(OWN, 'user', { text: 'My own words.' }); add(OWN, 'turn-end', { stopReason: 'end_turn' });
  add(TOLD, 'user', { text: 'Start on the parser.', from: LEAD, fromTitle: 'Lead' }); add(TOLD, 'turn-end', { stopReason: 'end_turn' });
  add(REPLIED, 'user', { text: 'Hi.' }); add(REPLIED, 'update', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } }); add(REPLIED, 'turn-end', { stopReason: 'end_turn' });
  db.close();
}

test('O73 phone list: a chat whose newest line is another chat\'s message is marked unread', { timeout: 180000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  seedList(server.directory);
  const { page } = await phone(t, server);
  // Only the chat last shown loads its events on the first read (the others are stubs, drawn from the daemon's preview), so
  // each chat is the last shown in turn, read on this phone at an older line.
  const marks = [];
  for (const id of [OWN, TOLD, REPLIED]) {
    await page.evaluate((id) => { localStorage.setItem('p9-read', JSON.stringify({ [id]: 'an older line' })); localStorage.setItem('p9-last-chat', id); history.replaceState(null, '', location.pathname); }, id);
    await page.reload();
    await page.locator('.row[data-chat="' + id + '"]').waitFor({ timeout: 30000 });
    await page.waitForFunction((id) => !document.querySelector('.row[data-chat="' + id + '"][data-run="working"]'), id, { timeout: 15000 });
    marks.push(await page.locator('.row[data-chat="' + id + '"]').evaluate((row) => row.hasAttribute('data-unread')));
    if (id === TOLD) await shot(page, 'o73-phone-list-told');
  }
  assert.deepEqual(marks, [false, true, true], 'unread marks for [own message, another chat\'s message, a reply]: ' + JSON.stringify(marks));
});
