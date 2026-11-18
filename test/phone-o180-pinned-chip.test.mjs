import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { remoteDaemon } from './helpers.mjs';
import { phone } from './phone-c16-helpers.mjs';

// O180: when a worker report arrives, the "N pinned" chip row unhides in flow above the transcript and the phone
// must keep the newest reply line in view (re-anchor the transcript, or reserve the row's height).
const CHAT = '00000000-0000-4000-8000-000000010801';
const shot = async (page, name) => { const png = await page.screenshot({ type: 'png' }); if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png.toString('base64')); };
const REPLY = 'The last line of the reply. ' + 'A line of the reply that wraps on a phone, so the transcript grows past one screen. '.repeat(30);
const seedCard = (server, id, text) => { const db = new DatabaseSync(path.join(server.directory, '.local', 'state', 'p9-foundation', 'p9.db')); db.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)').run(CHAT, 'card', JSON.stringify({ id, kind: 'note', text }), Date.now()); db.close(); };

test('O180: the last reply line stays in view when the pinned chip row appears', { timeout: 180000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  const db = new DatabaseSync(path.join(server.directory, '.local', 'state', 'p9-foundation', 'p9.db'));
  db.prepare('INSERT INTO conversations (id, provider, title, state, created) VALUES (?, ?, ?, ?, ?)').run(CHAT, 'claude', 'Lead chat', 'idle', Date.now());
  const at = Date.now(), add = (type, data) => db.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)').run(CHAT, type, JSON.stringify(data), at);
  add('user', { text: 'Run the sprint' });
  add('update', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: REPLY } });
  add('turn-end', { stopReason: 'end_turn' });
  db.close();
  const { page } = await phone(t, server);
  await page.evaluate((id) => history.replaceState(null, '', '#chat=' + id), CHAT);
  await page.reload();
  await page.waitForFunction(() => /The last line of the reply\./.test(document.querySelector('#events')?.textContent ?? ''), null, { timeout: 30000 });
  // No pinned cards yet, so the chip row is hidden; read the state at the bottom of the transcript.
  await page.evaluate(() => { const body = document.querySelector('#chatBody'); body.scrollTop = body.scrollHeight; });
  const read = () => page.evaluate(() => {
    const body = document.querySelector('#chatBody'), rows = [...document.querySelectorAll('#events article')].filter((row) => row.checkVisibility());
    const last = rows.at(-1);
    const b = body.getBoundingClientRect(), l = last?.getBoundingClientRect();
    return { chipsHidden: document.querySelector('#chips').hidden, chipsHeight: Math.round(document.querySelector('#chips').getBoundingClientRect().height),
      fromBottom: Math.round(body.scrollHeight - body.scrollTop - body.clientHeight), lastBottom: Math.round(l?.bottom ?? 0), bodyBottom: Math.round(b.bottom), chips: document.querySelector('#chips')?.textContent ?? '' };
  });
  const before = await read();
  assert.equal(before.chipsHidden, true, 'with no pinned card the chip row is hidden');
  assert.ok(before.fromBottom <= 80, 'the transcript is at its bottom before the card arrives: ' + JSON.stringify(before));
  // A worker report arrives while the chat is open at its bottom.
  seedCard(server, 'ready-0d4c1e2f-1a4c-4559-a431-f0e2d3c4b5a6', 'Worker report: PR #180 pushed');
  await page.waitForFunction(() => /1 pinned/.test(document.querySelector('#chips')?.textContent ?? ''), null, { timeout: 30000 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))); // layout settled
  const after = await read();
  console.log('O180 state: ' + JSON.stringify({ before, after }));
  await shot(page, 'o180-pinned-chip');
  assert.ok(after.lastBottom <= after.bodyBottom + 1, 'the last reply line stays inside the transcript\'s visible bottom after the chip row appears: ' + JSON.stringify(after));
  console.log('PASS O180: the last reply line stays in view when the pinned chip row appears');
});
