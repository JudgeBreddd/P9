import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { remoteDaemon } from './helpers.mjs';
import { phone } from './phone-c16-helpers.mjs';
import { openLedger } from '../apps/server/ledger.mjs';

const BIG = '00000000-0000-4000-8000-0000000000d1', TURNS = 450;
// A screenshot goes out in the log (P9_SHOT name base64), as agent-setup.test.mjs does.
const shot = async (page, name) => { const png = await page.screenshot({ type: 'png' }); if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png.toString('base64')); };

// P20: the tail read counts blocks as the phone draws them: a run of streamed chunks is one block, bookkeeping
// updates are none, and it always reaches back to the latest message from the user.
test('P20: the tail read counts a chunk run as one block and reaches back to the latest message', () => {
  const ledger = openLedger(':memory:'), add = (type, data) => ledger.append(BIG, type, data);
  const chunk = (sessionUpdate, text) => add('update', { sessionUpdate, content: { type: 'text', text } });
  add('card', { id: 'c', kind: 'note', text: 'Pinned early' });
  add('user', { text: 'one' }); chunk('agent_message_chunk', 'a'); chunk('agent_message_chunk', 'a'); add('turn-end', { stopReason: 'end_turn' });
  add('user', { text: 'two' }); chunk('agent_thought_chunk', 't'); add('update', { sessionUpdate: 'usage_update', used: 1, size: 9 });
  chunk('agent_message_chunk', 'b'); chunk('agent_message_chunk', 'b'); chunk('agent_message_chunk', 'b'); add('turn-end', { stopReason: 'end_turn' });
  const texts = (result) => result.events.map((event) => event.data.text ?? event.data.content?.text);
  const three = ledger.tail([BIG], undefined, 3);
  assert.deepEqual(texts(three), ['Pinned early', undefined, 'two', 't', undefined, 'b', 'b', 'b', undefined], 'three blocks: two, the thought, the three b chunks as one; the early card comes along');
  assert.ok(three.more[BIG] > 0, 'older events are left out, so more says where the kept ones start');
  assert.deepEqual(texts(ledger.tail([BIG], undefined, 1)), texts(three), 'one block still reaches back to the latest message');
  const all = ledger.tail([BIG], undefined, 10);
  assert.equal(all.events.length, 12); assert.equal(all.more[BIG], undefined);
  assert.equal(all.cursor, 12);
});

// A running chat as long as the longest real one: TURNS turns of a message, 40 streamed chunks, a tool call; a card,
// a plan and a mode early on, which the chat screen still shows.
function seedBig(server) {
  const db = new DatabaseSync(path.join(server.directory, '.local', 'state', 'p9-foundation', 'p9.db'));
  db.prepare('INSERT INTO conversations (id, provider, title, state, created) VALUES (?, ?, ?, ?, ?)').run(BIG, 'claude', 'Long chat', 'idle', Date.now());
  const event = db.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)'), at = Date.now(), filler = 'x'.repeat(480) + ' ';
  db.exec('BEGIN');
  event.run(BIG, 'card', JSON.stringify({ id: 'k1', kind: 'note', text: 'Pinned at the start' }), at);
  event.run(BIG, 'update', JSON.stringify({ sessionUpdate: 'plan', entries: [{ status: 'completed', content: 'Read' }, { status: 'pending', content: 'Write' }] }), at);
  for (let turn = 0; turn < TURNS; turn++) {
    event.run(BIG, 'user', JSON.stringify({ text: 'Question ' + turn }), at);
    for (let i = 0; i < 40; i++) event.run(BIG, 'update', JSON.stringify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: (i ? '' : 'Reply ' + turn + ' ') + filler } }), at);
    event.run(BIG, 'update', JSON.stringify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'end of ' + turn } }), at);
    event.run(BIG, 'update', JSON.stringify({ sessionUpdate: 'tool_call', toolCallId: 't' + turn, title: 'Tool ' + turn, status: 'completed' }), at);
    event.run(BIG, 'turn-end', JSON.stringify({ stopReason: 'end_turn' }), at);
  }
  db.exec('COMMIT');
  db.close();
}

test('P20: a long chat opens on its newest messages; Load earlier adds the next ones above and keeps the place', { timeout: 300000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  seedBig(server);
  const { page } = await phone(t, server);
  await page.evaluate((id) => history.replaceState(null, '', '#chat=' + id), BIG);
  // A phone on a good mobile link: 20 Mbit/s down, 50 ms each way. Every byte of chat events read is counted.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 50, downloadThroughput: 2.5e6, uploadThroughput: 1e6 });
  let bytes = 0;
  page.on('response', async (response) => { if (response.url().includes('/chat/events')) bytes += (await response.body().catch(() => '')).length; });
  const started = Date.now();
  await page.reload();
  const last = 'end of ' + (TURNS - 1);
  await page.waitForFunction((text) => document.querySelector('#events')?.textContent.includes(text), last, { timeout: 120000 });
  const paint = Date.now() - started;
  console.log('P20 first paint of a ' + (TURNS * 44 + 2) + '-event chat: ' + paint + ' ms, ' + Math.round(bytes / 1024) + ' KB of events');
  const count = () => page.locator('#events > article').count(), first = await count();
  assert.ok(first > 0 && first <= 40, 'about the last 30 blocks are shown, not ' + first);
  await page.waitForSelector('#earlier', { state: 'visible', timeout: 5000 });
  await page.waitForFunction(() => document.querySelector('#chips')?.textContent.includes('Plan 1/2'), null, { timeout: 5000 });
  await shot(page, 'p20-first-paint');
  // The reader goes to the top and taps Load earlier: older blocks come in above, and what was on screen stays put.
  await page.evaluate(() => { document.querySelector('#chatBody').scrollTop = 0; });
  await page.waitForTimeout(300); await shot(page, 'p20-button');
  const oldest = page.locator('#events > article').first(), mark = (await oldest.textContent()).slice(0, 40), before = (await oldest.boundingBox()).y;
  await page.click('#earlier');
  await page.waitForFunction((n) => document.querySelectorAll('#events > article').length > n, first, { timeout: 10000 });
  const kept = page.locator('#events > article', { hasText: mark }).first(), after = (await kept.boundingBox()).y;
  assert.ok(Math.abs(after - before) < 3, 'the block on screen moved from ' + before + ' to ' + after);
  assert.ok(await count() > first + 20, 'the next batch came in: ' + first + ' then ' + await count());
  await page.evaluate(() => { document.querySelector('#chatBody').scrollTop -= 400; });
  await shot(page, 'p20-load-earlier');
  // The route refuses a tail with no chat named, or out of range.
  const status = (query) => page.evaluate((q) => fetch('/chat/events?after=0' + q).then((r) => r.status), query);
  assert.deepEqual([await status('&tail=5'), await status('&tail=0&only=' + BIG), await status('&tail=201&only=' + BIG), await status('&tail=x&only=' + BIG)], [400, 400, 400, 400]);
  console.log('PASS P20: ' + first + ' blocks first, ' + await count() + ' after Load earlier; the place held (' + before + ' then ' + after + ')');
});
