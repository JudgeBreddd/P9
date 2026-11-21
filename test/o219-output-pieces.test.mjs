// O219: a Codex (ACP v2) command's streamed output reaches the ledger as pieces, each once, marked _meta['p9/append']
// (apps/server/acp-v2.mjs). The window and the phone add each piece to the tool's text: the output reads once, whole,
// in order. Desktop on the real daemon and the fake v2 agent; phone on the same events seeded into the ledger.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { _electron } from '@playwright/test';
import { daemon, remoteDaemon, http, authenticated, root } from './helpers.mjs';
import { phone, CHAT, seedChat, openChat } from './phone-c16-helpers.mjs';

const fake = path.join(root, 'test/fake-acp-v2-agent.mjs');
const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((result) => JSON.parse(result.text));
const until = async (check, what, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 200))) if (await check()) return;
  assert.fail('timed out: ' + what);
};
const piece = (text) => ({ sessionUpdate: 'tool_call_update', toolCallId: 'exec-3', content: [{ type: 'content', content: { type: 'text', text } }], _meta: { 'p9/append': true } });

test('O219 desktop: a streamed command\'s pieces read once, whole, in the tool\'s output', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const id = (await call(instance, '/chat', 'POST', { provider: 'codex' })).conversation;
  await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'stream' });
  let events = [];
  await until(async () => (events = (await call(instance, '/chat/events?after=0&only=' + id)).events).some((e) => e.type === 'turn-end'), 'the turn ends');
  const rows = events.filter((e) => e.data?.toolCallId === 'exec-3' && e.data.content?.some((c) => c.type === 'content'));
  assert.deepEqual(rows.map((e) => [e.data.content[0].content.text, e.data._meta?.['p9/append']]), [['one\n', true], ['two\nthree\n', true]], 'the ledger has each piece once');
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-o219-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('#navList .row[data-chat="' + id + '"]').waitFor({ timeout: 20000 });
  await page.locator('#nav .row[data-chat="' + id + '"]').click();
  const pane = page.locator('.pane[data-id="' + id + '"]');
  await pane.locator('details.tool', { hasText: 'make' }).waitFor({ timeout: 15000 });
  assert.equal(await pane.locator('details.tool', { hasText: 'make' }).locator('pre').textContent(), 'one\ntwo\nthree\n');
  assert.deepEqual(errors, []);
  console.log('PASS O219 desktop: output one/two/three once');
});

test('O219 phone: a streamed command\'s pieces read once, whole, in the tool\'s detail', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  seedChat(server);
  const d = new DatabaseSync(path.join(server.directory, '.local', 'state', 'p9-foundation', 'p9.db'), { timeout: 5000 }), now = Date.now();
  const update = (data) => d.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)').run(CHAT, 'update', JSON.stringify(data), now);
  update({ sessionUpdate: 'tool_call', toolCallId: 'exec-3', title: 'make', kind: 'execute', status: 'in_progress', content: [{ type: 'terminal', terminalId: 'exec-3' }] });
  update(piece('one\n')); update(piece('two\nthree\n'));
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'exec-3', status: 'completed' });
  update({ sessionUpdate: 'tool_call', toolCallId: 'exec-4', title: 'long', kind: 'execute', status: 'completed' });
  for (const n of [1, 2, 3]) update({ ...piece(String(n).repeat(1500)), toolCallId: 'exec-4' });
  d.close();
  const { page } = await phone(t, server);
  await openChat(page, server);
  const tool = page.locator('#events article[data-kind=tool]', { hasText: 'make' });
  await tool.waitFor({ timeout: 15000 });
  assert.equal(await tool.locator('pre').textContent(), 'completed\none\ntwo\nthree\n');
  assert.equal(await page.locator('#events article[data-kind=tool]', { hasText: 'long' }).locator('pre').textContent(), 'completed\n' + '2'.repeat(500) + '3'.repeat(1500), 'a long streamed output shows its last 2,000 characters');
  console.log('PASS O219 phone: detail one/two/three once');
});
