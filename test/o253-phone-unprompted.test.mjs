import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { remoteDaemon } from './helpers.mjs';
import { phone, CHAT, seedChat, openChat } from './phone-c16-helpers.mjs';

// O253: a turn nobody prompted (the run after a compaction, a plugin's prompt) streams agent output after the last
// turn-end with no user event of its own. The phone read that as ended: no Working, no Stop, Send an arrow. As on the
// desktop, agent output now marks it working, and the run's closing usage_update (with a cost) marks it done.
const seed = (server, closed) => {
  seedChat(server);
  const db = new DatabaseSync(path.join(server.directory, '.local', 'state', 'p9-foundation', 'p9.db'), { timeout: 5000 });
  const event = db.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)'), update = (data) => event.run(CHAT, 'update', JSON.stringify(data), Date.now());
  update({ sessionUpdate: 'tool_call', toolCallId: 'o253-1', title: 'Compact conversation', kind: 'think', status: 'completed' });
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working on after the compaction' } });
  if (closed) update({ sessionUpdate: 'usage_update', used: 10, size: 1000, cost: { amount: 0.01, currency: 'USD' } });
  db.close();
};

test('O253: agent output after the last turn-end, with no user event, shows Working and Stop on the phone', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  seed(server, false);
  const { page } = await phone(t, server);
  await openChat(page, server);
  await page.waitForSelector('[data-bar="chat"] .run[data-run="working"]', { timeout: 10000 });
  await page.waitForSelector('[data-bar="chat"] #stopTurn', { timeout: 10000 });
  await page.screenshot({ path: (process.env.P9_SCREENSHOTS || '/tmp') + '/o253-phone-unprompted.png' });
});

test('O253: that run\'s closing usage_update with a cost ends it: no Stop', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  seed(server, true);
  const { page } = await phone(t, server);
  await openChat(page, server);
  await page.waitForSelector('[data-bar="chat"] h1', { timeout: 10000 });
  await page.locator('text=working on after the compaction >> visible=true').first().waitFor({ timeout: 10000 });
  assert.equal(await page.locator('#stopTurn').count(), 0, 'a run whose closing usage_update came still shows Stop');
});
