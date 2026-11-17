import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { daemon, http, authenticated, root } from './helpers.mjs';
import { Client } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

// O139: a worker that compacts just after its turn ends tells its parent it is compacting, not that it ended; the end
// line comes when the unprompted run after the compaction ends (a higher cost), or after 60 s of quiet (a compaction that failed).
const fake = path.join(root, 'test/fake-acp-agent.mjs');
const call = (instance, route, method = 'GET', body) => http({ socketPath: instance.credentials.socketPath, route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  .then((result) => ({ ...result, body: result.text ? JSON.parse(result.text) : null }));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const events = async (instance, id) => (await call(instance, '/chat/events?after=0&only=' + id)).body.events;
// What P9 told the parent, in order: its notes and the lines it sent as P9.
const told = async (instance, id) => (await events(instance, id)).filter((e) => (e.type === 'note' || e.type === 'user') && e.data.from === 'p9').map((e) => e.data.text);
async function until(check, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await pause(250)) { const got = await check(); if (got) return got; }
  throw new Error('timeout');
}

test('O139: a worker compacting after its turn tells its parent it will continue; the end line comes when it stops', { timeout: 240000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async ({ workspace }) => { fs.writeFileSync(path.join(workspace, 'profile.log'), ''); return { args: ['--acp-override', fake] }; });
  await call(instance, '/delegation', 'POST', { start: 'agent', max: 20, workers: [] });
  await call(instance, '/file-protection', 'POST', { on: false });
  const { body: { conversation: lead } } = await call(instance, '/chat', 'POST', { provider: 'claude' });
  await call(instance, `/chat/${lead}/prompt`, 'POST', { text: 'mcp' });
  const mcp = await until(async () => (await events(instance, lead)).find((e) => e.data?.content?.text?.startsWith('mcp:')), 30000);
  const [entry] = JSON.parse(mcp.data.content.text.slice(4));
  const client = new Client({ name: 'p9-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env: Object.fromEntries(entry.env.map(({ name, value }) => [name, value])) }));
  t.after(() => client.close());
  const tool = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

  // Compacts 0.5 s after its turn, works on for 6 s, then stops.
  const made = await tool('open_chat', { text: 'compactgo', title: 'Kid' });
  const compactingLine = '[p9] Kid is compacting and will continue.';
  await until(async () => (await told(instance, lead)).includes(compactingLine), 20000);
  assert.deepEqual(await told(instance, lead), [compactingLine], 'the end line went before the compaction run ended');
  const listed = (await tool('list_chats')).chats.find((c) => c.id === made.chat);
  assert.deepEqual([listed.state, listed.compacting], ['working', true], 'list_chats: ' + JSON.stringify(listed));
  const waited = await tool('wait_chat', { chat: made.chat, timeoutMs: 0 });
  assert.deepEqual([waited.state, waited.ended, waited.compacting], ['working', false, true], 'wait_chat: ' + JSON.stringify(waited));
  const ended = await until(async () => (await told(instance, lead)).find((text) => text.startsWith('[p9] Kid ended its turn')), 30000);
  assert.equal(ended, '[p9] Kid ended its turn: working after the compaction, then done');
  assert.deepEqual(await told(instance, lead), [compactingLine, ended], 'one compacting note, then one end line');
  assert.equal((await tool('wait_chat', { chat: made.chat, timeoutMs: 0 })).state, 'idle');
  assert.equal((await tool('list_chats')).chats.find((c) => c.id === made.chat).compacting, undefined);

  // A compaction that failed: no more updates come, so after 60 s of quiet the end line goes.
  await tool('send_chat', { chat: made.chat, text: 'compactstop' });
  await until(async () => (await told(instance, lead)).filter((text) => text === compactingLine).length === 2, 20000);
  const before = Date.now();
  await pause(20000);
  assert.equal((await told(instance, lead)).filter((text) => text.startsWith('[p9] Kid ended its turn')).length, 1, 'the end line went while it was still compacting');
  await until(async () => (await told(instance, lead)).filter((text) => text.startsWith('[p9] Kid ended its turn')).length === 2, 70000);
  assert.ok(Date.now() - before >= 30000, 'the quiet end came too soon');
  assert.equal((await tool('wait_chat', { chat: made.chat, timeoutMs: 0 })).state, 'idle');

  // No compaction: one end line after the hold, no compacting note.
  await tool('send_chat', { chat: made.chat, text: 'late' });
  await until(async () => (await told(instance, lead)).includes('[p9] Kid ended its turn: late reply'), 30000);
  assert.equal((await told(instance, lead)).filter((text) => text === compactingLine).length, 2);
  console.log('PASS O139: compacting note, then the end line at the run\'s end; quiet end after a failed compaction; plain end unchanged');
});
