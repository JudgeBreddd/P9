// O220: a Codex (ACP v2) command that failed (exit 2) or was killed (SIGTERM) carries a tag on its tool, in the window
// and on the phone; one that worked carries none. The exit reaches the ledger as a tool_call_update with
// _meta['p9/exit'] {exitCode, signal} (apps/server/acp-v2.mjs); the readers take only a whole number other than 0 or a
// short signal name (exitTag, helpers.mjs). Desktop on the real daemon and the fake v2 agent; phone on seeded events.
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

test('O220 desktop: a failed command shows "exit 2", a killed one "SIGTERM", one that worked no tag', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const id = (await call(instance, '/chat', 'POST', { provider: 'codex' })).conversation;
  await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'exitcode' });
  let events = [];
  await until(async () => (events = (await call(instance, '/chat/events?after=0&only=' + id)).events).some((e) => e.type === 'turn-end'), 'the turn ends');
  assert.deepEqual(events.filter((e) => e.data?._meta?.['p9/exit']).map((e) => [e.data.toolCallId, e.data._meta['p9/exit']]),
    [['exec-8', { exitCode: 2, signal: null }], ['exec-9', { exitCode: null, signal: 'SIGTERM' }]], 'the ledger has the two exits');
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-o220-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('#navList .row[data-chat="' + id + '"]').waitFor({ timeout: 20000 });
  await page.locator('#nav .row[data-chat="' + id + '"]').click();
  const pane = page.locator('.pane[data-id="' + id + '"]'), tag = (title) => pane.locator('details.tool', { hasText: title }).locator('summary [data-exit]');
  await pane.locator('details.tool', { hasText: 'okcmd' }).waitFor({ timeout: 15000 });
  assert.deepEqual(await tag('build').allTextContents(), ['exit 2']);
  assert.deepEqual(await tag('sleeper').allTextContents(), ['SIGTERM']);
  assert.equal(await tag('okcmd').count(), 0, 'exit 0: no tag');
  assert.deepEqual(errors, []);
  console.log('PASS O220 desktop: exit 2, SIGTERM, none for exit 0');
});

test('O220 phone: a failed command shows "exit 2", a killed one "SIGTERM"; exit 0 and what is not a code or a signal show none', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  seedChat(server);
  const d = new DatabaseSync(path.join(server.directory, '.local', 'state', 'p9-foundation', 'p9.db'), { timeout: 5000 }), now = Date.now();
  const update = (data) => d.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)').run(CHAT, 'update', JSON.stringify(data), now);
  const cases = [['build', { exitCode: 2, signal: null }], ['sleeper', { exitCode: null, signal: 'SIGTERM' }], ['okcmd', { exitCode: 0, signal: null }],
    ['fraction', { exitCode: 1.5, signal: null }], ['texty', { exitCode: '2', signal: '<b>x</b>' }], ['longsig', { exitCode: null, signal: 'S'.repeat(40) }], ['notobj', 'exit 9']];
  for (const [i, [title, exit]] of cases.entries()) {
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Next: ' + title + '. ' } }); // a message apart: three tool calls in a row fold into one row
    update({ sessionUpdate: 'tool_call', toolCallId: 'exec-' + i, title, kind: 'execute', status: 'in_progress' });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'exec-' + i, _meta: { 'p9/exit': exit } });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'exec-' + i, status: title === 'okcmd' ? 'completed' : 'failed' }); // a later update keeps the tag
  }
  d.close();
  const { page } = await phone(t, server);
  await openChat(page, server);
  const tag = (title) => page.locator('#events article[data-kind=tool]', { hasText: title }).locator('summary .exit');
  await page.locator('#events article[data-kind=tool]', { hasText: 'notobj' }).waitFor({ timeout: 15000 });
  assert.deepEqual(await tag('build').allTextContents(), ['exit 2']);
  assert.deepEqual(await tag('sleeper').allTextContents(), ['SIGTERM']);
  for (const title of ['okcmd', 'fraction', 'texty', 'longsig', 'notobj']) assert.equal(await tag(title).count(), 0, title + ': no tag');
  assert.equal(await page.locator('#events b').count(), 0, 'nothing the agent sent became markup');
  console.log('PASS O220 phone: exit 2, SIGTERM; none for exit 0 or junk');
});
