import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { remoteDaemon } from './helpers.mjs';
import { phone } from './phone-c16-helpers.mjs';

// O66: the phone's chat list says what each chat is doing. Fails on main 074b17d.
const A = '00000000-0000-4000-8000-0000000000a1', B = '00000000-0000-4000-8000-0000000000b2', C = '00000000-0000-4000-8000-0000000000c3', D = '00000000-0000-4000-8000-0000000000d4';
const shots = process.env.P9_SCREENSHOTS || '/tmp';
const shot = async (page, name) => { const png = await page.screenshot({ type: 'png', path: shots + '/' + name + '.png' }); if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png.toString('base64')); };
const db = (server) => new DatabaseSync(path.join(server.directory, '.local', 'state', 'p9-foundation', 'p9.db'));
function append(ledger, id, events) {
  const event = ledger.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)');
  ledger.exec('BEGIN'); for (const [type, data] of events) event.run(id, type, JSON.stringify(data), Date.now()); ledger.exec('COMMIT');
}
function seed(server, id, title, state, events) {
  const ledger = db(server);
  ledger.prepare('INSERT INTO conversations (id, provider, title, state, created) VALUES (?, ?, ?, ?, ?)').run(id, 'claude', title, state, Date.now());
  append(ledger, id, events); ledger.close();
}
const turn = (text, reply) => [['user', { text }], ['update', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } }], ['turn-end', { stopReason: 'end_turn' }]];
const row = (page, id) => page.locator(`#chatList [data-chat="${id}"]`);

test('O66: a row shows stopped and not read yet, and its preview has no Markdown marks', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  seed(server, A, 'Marks', 'idle', turn('hello a', '## **Done**: see `notes.md` and [the log](https://example.test/log)\nmore'));
  seed(server, B, 'Ended', 'stopped', turn('hello b', 'All finished here.'));
  seed(server, C, 'Quiet', 'idle', turn('hello c', 'First answer.'));
  seed(server, D, 'Fenced', 'idle', turn('hello d', '```js\nconst a = 1;\n```'));
  const { page } = await phone(t, server);
  await row(page, C).waitFor({ timeout: 15000 });
  assert.equal(await row(page, A).locator('small').innerText(), 'Done: see notes.md and the log', 'the preview still shows Markdown marks');
  await row(page, B).waitFor();
  assert.match(await row(page, B).locator('small').innerText(), /^Stopped\s*All finished here\.$/, 'a stopped chat does not say so');
  assert.equal(await row(page, C).locator('small .tag').count(), 0, 'a chat that is not stopped says Stopped');
  assert.equal(await page.locator('#chatList .new').count(), 0, 'a chat first seen on this phone is marked not read');
  // A turn finishes in C while the reader is on the list.
  const ledger = db(server); append(ledger, C, turn('again', 'Second answer, *new*.')); ledger.close();
  await row(page, C).locator('.new').waitFor({ timeout: 20000 });
  assert.equal(await row(page, C).locator('small').innerText(), 'Second answer, new.');
  assert.equal(await page.locator('#chatList .new').count(), 1, 'only the chat with the new result is marked');
  assert.equal(await row(page, C).locator('.new').getAttribute('aria-label'), 'Not read yet');
  await page.setViewportSize({ width: 390, height: 844 }); await shot(page, 'phone-o66-list');
  // It survives a reload, and reading the chat clears it.
  await page.reload(); await row(page, C).locator('.new').waitFor({ timeout: 20000 });
  await row(page, C).click(); await page.waitForSelector('#events > *', { timeout: 15000 });
  await page.locator('[data-back]').click(); await row(page, C).waitFor();
  assert.equal(await page.locator('#chatList .new').count(), 0, 'the mark stays after the chat was read');
  // A reply that opens with a code fence still has a preview.
  assert.equal(await row(page, D).locator('small').innerText(), 'Code', 'a fenced reply has an empty preview');
  // A prompt whose turn ended with no reply is not a result to read.
  const again = db(server); append(again, C, [['user', { text: 'my own prompt' }], ['error', { message: 'the agent failed' }]]); again.close();
  await page.waitForFunction((id) => document.querySelector(`#chatList [data-chat="${id}"][data-run="idle"] small`)?.textContent === 'my own prompt', C, { timeout: 20000 });
  assert.equal(await page.locator('#chatList .new').count(), 0, 'the reader\'s own prompt is marked not read');
  console.log('PASS O66: Stopped shown, one chat marked not read then cleared by reading it, previews are plain text');
});
