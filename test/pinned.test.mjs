// The strip above a chat's composer (AR1 the plan, AR2 pinned cards) and Hand off (PH5). The real daemon, the fake agent,
// a private tmux socket; the strip in real Electron. Hand off is never followed by Enter here: that would start a real
// Remote Control session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { Client } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { daemon, http, authenticated, root } from './helpers.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const call = (instance, route, method = 'GET', body) => http({ socketPath: instance.credentials.socketPath, route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((result) => ({ status: result.status, ...JSON.parse(result.text) }));
const said = async (instance, id, type) => {
  const all = [];
  for (let after = 0, page; (page = await call(instance, '/chat/events?after=' + after + '&only=' + id)).events.length; after = page.cursor) all.push(...page.events);
  return all.filter((e) => e.type === type);
};
const until = async (check, what, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await wait(200)) if (await check()) return;
  assert.fail('timed out: ' + what);
};

// A daemon on its own tmux socket and TMUX_TMPDIR, so nothing here types into another session's tmux.
async function start(t) {
  const tmpdir = await mkdtemp(path.join(os.tmpdir(), 'p9-tmux-')), socket = 'p9h-' + randomUUID().slice(0, 8);
  const env = { ...process.env, TMUX_TMPDIR: tmpdir };
  const instance = await daemon(t, undefined, false, async ({ workspace }) => {
    await mkdir(path.join(workspace, 'proj'));
    for (const folder of ['', 'proj']) await writeFile(path.join(workspace, folder, 'uuid-sessions'), '');
    return { args: ['--acp-override', fake, '--tmux-socket', socket], env: { TMUX_TMPDIR: tmpdir } };
  });
  t.after(() => { try { execFileSync('tmux', ['-L', socket, 'kill-server'], { env, stdio: 'ignore' }); } catch {} });
  const tmux = (...args) => execFileSync('tmux', ['-L', socket, ...args], { env }).toString();
  return { instance, tmux };
}
async function chat(instance, provider, folder) {
  const id = (await call(instance, '/chat', 'POST', { provider, ...(folder && { folder }) })).conversation;
  await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'hello' });
  await until(async () => (await said(instance, id, 'connected')).length, provider + ' connected');
  return { id, session: (await said(instance, id, 'connected'))[0].data.session };
}
// The terminal's line holds the command; the shell has not run it (a run would start claude or print "not found").
async function typedNotRun(tmux, terminal, command) {
  const target = '=p9-' + terminal + ':';
  let pane = '';
  for (let i = 0; i < 50 && !(pane = tmux('capture-pane', '-p', '-J', '-t', target)).includes(command); i++) await wait(100);
  assert.ok(pane.includes(command), 'not typed: ' + pane);
  await wait(1000);
  pane = tmux('capture-pane', '-p', '-J', '-t', target);
  assert.ok(!/not found|no such file|remote control/i.test(pane), 'it ran: ' + pane);
  assert.notEqual(tmux('display-message', '-p', '-t', target, '#{pane_current_command}').trim(), 'claude');
  return tmux('display-message', '-p', '-t', target, '#{pane_current_path}').trim();
}

test('PH5 Hand off: the Claude chat stops, a P9 terminal opens in its folder with the resume command typed but not run; Codex and unknown chats are refused', { timeout: 90000 }, async (t) => {
  const { instance, tmux } = await start(t);
  const { id, session } = await chat(instance, 'claude', 'proj');
  assert.match(session, /^[0-9a-f-]{36}$/);
  const r = await call(instance, '/chat/' + id + '/handoff', 'POST');
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.deepEqual(Object.keys(r).sort(), ['session', 'status', 'terminal']);
  assert.equal(r.session, session);
  assert.deepEqual((await said(instance, id, 'handed-off')).map((e) => e.data), [{ session }]);
  assert.equal((await call(instance, '/chat')).conversations.find((c) => c.id === id).state, 'stopped');
  // Claude Code keeps sessions per folder: the terminal starts in the chat's.
  assert.equal(await typedNotRun(tmux, r.terminal, 'claude --resume ' + session + ' --remote-control'), await realpath(path.join(instance.workspace, 'proj')));

  // Codex has no Remote Control; a chat with no session yet has nothing to resume; an unknown chat is 404. None of them stops.
  const codex = await chat(instance, 'codex');
  const fresh = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  for (const [chatId, status, error] of [[codex.id, 409, 'handoff-unavailable'], [fresh, 409, 'handoff-unavailable'], [randomUUID(), 404, 'unknown-conversation'], ['nope', 404, 'unknown-conversation']]) {
    const refused = await call(instance, '/chat/' + chatId + '/handoff', 'POST');
    assert.deepEqual([refused.status, refused.error, refused.terminal], [status, error, undefined], chatId);
  }
  assert.notEqual((await call(instance, '/chat')).conversations.find((c) => c.id === codex.id).state, 'stopped');
  assert.equal((await call(instance, '/terminals')).terminals.length, 1);
  console.log('PASS PH5 Hand off: chat stopped, handed-off event, terminal in the chat folder with the command typed and not run; Codex, no-session and unknown chats refused, nothing stopped');
});

test('AR1/AR2 strip: the plan and a pinned card sit above the composer, HTML shows as text, an unpinned card stays gone on replay; Hand off from the window', { timeout: 150000 }, async (t) => {
  const { instance, tmux } = await start(t);
  const { id, session } = await chat(instance, 'claude');
  await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'plan' });
  await until(async () => (await said(instance, id, 'update')).some((e) => e.data.sessionUpdate === 'plan'), 'plan sent');
  await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'mcp' });
  let entry;
  await until(async () => (entry = (await said(instance, id, 'update')).find((e) => e.data.content?.text?.startsWith('mcp:'))), 'mcp entry');
  const [server] = JSON.parse(entry.data.content.text.slice(4));
  const client = new Client({ name: 'p9-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])) }));
  t.after(() => client.close());
  const tool = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  // Before the window opens, so it shows them from the ledger: one card stays, one is pinned and unpinned.
  assert.equal((await tool('pin_card', { id: 'status', kind: 'markdown', text: '**Build** green, 3 of 4 checks.\n\n<img src=x onerror="window.pwned=1"> <b>not bold</b>' })).pinned, 'status');
  assert.equal((await tool('pin_card', { id: 'gone', kind: 'checklist', text: '- [ ] never shown' })).pinned, 'gone');
  assert.equal((await tool('unpin_card', { id: 'gone' })).unpinned, 'gone');

  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-pinned-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), wait(15000)]); proc.kill(); });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('#rBots [data-bot="' + id + '"]').waitFor({ timeout: 15000 });
  await page.locator('#tabs .tab[data-id="' + id + '"]').click();
  const pane = page.locator('.pane[data-id="' + id + '"]');
  const strip = pane.locator('.bottom .pinned');
  await strip.locator('[data-card="status"]').waitFor({ timeout: 15000 });
  // The plan moved from the history to the strip, above the composer.
  assert.deepEqual(await strip.locator('.plan li').allTextContents(), ['✓Read the chat ledger', '▸Pin the plan above the composer', '○Check it on the phone']);
  assert.equal(await pane.locator('.hist .plan').count(), 0);
  const box = async (selector) => (await page.locator(selector).first().boundingBox());
  assert.ok((await strip.boundingBox()).y < (await box('.pane[data-id="' + id + '"] .composer')).y);
  const card = strip.locator('[data-card="status"]');
  assert.equal(await card.locator('.eyebrow').textContent(), 'status · markdown');
  assert.match(await card.textContent(), /<img src=x onerror="window\.pwned=1"> <b>not bold<\/b>/);
  assert.equal(await card.locator('strong').innerText(), 'Build');
  assert.equal(await strip.locator('img, b, script').count(), 0);
  assert.equal(await strip.locator('[data-card="gone"]').count(), 0);
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT strip-plan-card ' + (await pane.screenshot({ type: 'png' })).toString('base64'));

  // Live: a pin shows at once and an unpin takes it away.
  await tool('pin_card', { id: 'live', kind: 'table', text: '| check | state |\n|---|---|\n| lint | ok |' });
  await strip.locator('[data-card="live"] table').waitFor({ timeout: 15000 });
  await tool('unpin_card', { id: 'live' });
  await strip.locator('[data-card="live"]').waitFor({ state: 'detached', timeout: 15000 });

  // Hand off from the window (the desktop's own route): the chat stops, the dock shows the terminal with the command typed.
  await pane.locator('[data-handoff]').click();
  await pane.locator('.hist', { hasText: 'Handed off: press Enter in the terminal' }).waitFor({ timeout: 15000 });
  await page.locator('#dock:not([hidden])').waitFor({ timeout: 15000 });
  const terminal = (await call(instance, '/terminals')).terminals.find((x) => x.state === 'running').id;
  await typedNotRun(tmux, terminal, 'claude --resume ' + session + ' --remote-control');
  await pane.locator('.state[data-s="stopped"]').waitFor({ timeout: 15000 });
  assert.equal(await strip.locator('[data-card="status"]').count(), 1);
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT handoff ' + (await page.screenshot({ type: 'png' })).toString('base64'));
  assert.deepEqual(errors, []);
  console.log('PASS AR1/AR2 strip: plan and card above the composer, HTML as text, unpinned card absent on replay, live pin/unpin; Hand off stopped the chat and typed the command in the dock terminal');
});
