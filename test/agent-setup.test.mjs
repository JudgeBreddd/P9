// D7/D8 (threat model row 53): an agent's official install or sign-in command is typed into a new P9 terminal from a fixed
// table and never run by P9; the page names only the agent and the action. Chat Focus's "not signed in" error opens the
// wizard's agents step. Stand-in CLIs on a private PATH and a private tmux socket: nothing here installs or signs in anything,
// and no test presses Enter in a terminal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, http, authenticated, root } from './helpers.mjs';

const linux = process.platform === 'linux';
const fake = path.join(root, 'test/fake-acp-agent.mjs');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const call = (instance, route, method = 'GET', body) => http({ socketPath: instance.credentials.socketPath, route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((result) => ({ status: result.status, ...JSON.parse(result.text) }));
const COMMANDS = { 'claude:install': 'curl -fsSL https://claude.ai/install.sh | bash', 'claude:login': 'claude auth login',
  'codex:install': 'npm install -g @openai/codex', 'codex:login': 'codex login' };

// A daemon whose PATH holds node, tmux and the given stand-in CLIs only, on its own tmux socket and TMUX_TMPDIR.
async function start(t, clis) {
  const tmpdir = await mkdtemp(path.join(os.tmpdir(), 'p9-tmux-')), bin = await mkdtemp(path.join(os.tmpdir(), 'p9-bin-')), socket = 'p9a-' + randomUUID().slice(0, 8);
  t.after(() => rm(bin, { recursive: true, force: true }));
  for (const name of clis) await writeFile(path.join(bin, name), '#!/bin/sh\necho stand-in "$0" "$@" ran >&2\nexit 9\n', { mode: 0o755 });
  const tmuxDir = path.dirname(execFileSync('sh', ['-c', 'command -v tmux']).toString().trim());
  const PATH = [bin, path.dirname(process.execPath), tmuxDir, '/bin'].join(':');
  const env = { ...process.env, TMUX_TMPDIR: tmpdir };
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake, '--tmux-socket', socket], path: PATH, env: { TMUX_TMPDIR: tmpdir } }));
  t.after(() => { try { execFileSync('tmux', ['-L', socket, 'kill-server'], { env, stdio: 'ignore' }); } catch {} });
  const tmux = (...args) => execFileSync('tmux', ['-L', socket, ...args], { env }).toString();
  return { instance, tmux };
}
// The terminal's line holds the command and the shell has not run it (a run prints "stand-in ... ran" or "not found").
async function typedNotRun(tmux, terminal, command) {
  const target = '=p9-' + terminal + ':';
  let pane = '';
  for (const end = Date.now() + 10000; Date.now() < end && !(pane = tmux('capture-pane', '-p', '-J', '-t', target)).includes(command);) await wait(100);
  assert.ok(pane.includes(command), 'not typed: ' + pane);
  await wait(1000);
  pane = tmux('capture-pane', '-p', '-J', '-t', target);
  assert.ok(!/stand-in|not found|no such file|curl:/i.test(pane), 'it ran: ' + pane);
  return tmux('display-message', '-p', '-t', target, '#{pane_current_path}').trim();
}

test('D8: /setup says which agent CLIs are on PATH or in ~/.local/bin', { skip: !linux, timeout: 60000 }, async (t) => {
  const { instance } = await start(t, ['claude']);
  let s = await call(instance, '/setup');
  assert.deepEqual([s.claudeCli, s.codexCli], [true, false]);
  // Claude's installer puts it in ~/.local/bin, often not on a service's PATH yet.
  await mkdir(path.join(instance.directory, '.local', 'bin'), { recursive: true });
  await writeFile(path.join(instance.directory, '.local', 'bin', 'codex'), '#!/bin/sh\n', { mode: 0o755 });
  s = await call(instance, '/setup');
  assert.deepEqual([s.claudeCli, s.codexCli], [true, true]);
  // A folder by that name is not a program.
  await rm(path.join(instance.directory, '.local', 'bin', 'codex'));
  await mkdir(path.join(instance.directory, '.local', 'bin', 'codex'));
  assert.equal((await call(instance, '/setup')).codexCli, false);
});

test('D7/D8: /setup/agent-terminal types only the table\'s command into a new terminal in the workspace, never runs it', { skip: !linux, timeout: 60000 }, async (t) => {
  const { instance, tmux } = await start(t, ['claude', 'codex']);
  for (const body of [{}, { agent: 'claude' }, { agent: 'x', action: 'login' }, { agent: 'claude', action: 'run' }, { agent: ['claude'], action: 'login' },
    { agent: 'claude', action: ['login'] }, { agent: 'claude', action: 'toString' }, { agent: 'constructor', action: 'login' }, { agent: '__proto__', action: 'login' },
    { agent: 'claude', action: 'login', command: 'id' }, { agent: 'claude', action: 'login', cwd: '/' }]) {
    const r = await call(instance, '/setup/agent-terminal', 'POST', body);
    assert.deepEqual([r.status, r.error], [400, 'request-refused'], JSON.stringify(body));
  }
  assert.deepEqual((await call(instance, '/terminals')).terminals, [], 'nothing opened for a refused request');
  const workspace = await realpath(instance.workspace);
  for (const [key, command] of Object.entries(COMMANDS)) {
    const [agent, action] = key.split(':');
    const r = await call(instance, '/setup/agent-terminal', 'POST', { agent, action });
    assert.equal(r.status, 201, key);
    assert.equal(r.command, command);
    assert.match(r.terminal, /^[0-9a-f-]{36}$/);
    assert.equal(await realpath(await typedNotRun(tmux, r.terminal, command)), workspace, key + ' opens in the workspace');
  }
  assert.equal((await call(instance, '/terminals')).terminals.filter((x) => x.state === 'running').length, 4);
  console.log('PASS D7/D8 route: 11 bad bodies refused; the four official commands typed, not run, in the workspace');
});

// The desktop: a chat that is not signed in offers Sign in, which opens the wizard at the agents step. Claude's CLI is
// missing (Install in a terminal) and Codex's is there but signed out (Sign in in a terminal). Each button closes the
// wizard and shows the dock on a terminal holding the command, not yet run.
test('D7/D8: Chat Focus "Sign in" opens the agents step; its terminal buttons open the dock on the typed command', { skip: !linux, timeout: 60000 }, async (t) => {
  const deadline = Date.now() + 55000, left = () => Math.max(1000, deadline - Date.now());
  const { instance, tmux } = await start(t, ['codex']);
  const id = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  assert.equal((await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'auth-required' })).status, 202);
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-d7-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + path.join(home, 'profile')], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), wait(15000)]); proc.kill(); });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const shot = async (name, what = page) => { await page.waitForTimeout(400); const png = await what.screenshot({ type: 'png' }); if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png.toString('base64')); };

  // The page may name an agent and an action only: anything else is refused before the daemon.
  for (const body of [{ agent: 'claude', action: 'login', command: 'id' }, { agent: 'claude', action: 'rm' }, { agent: 'x', action: 'login' }]) {
    assert.deepEqual(await page.evaluate((b) => window.p9.chat('agentTerminal', b), body), { status: 400, body: { error: 'request-refused' } }, JSON.stringify(body));
  }

  await page.locator('#tabs .tab[data-id="' + id + '"]').click({ timeout: left() });
  const pane = page.locator('.pane[data-id="' + id + '"]');
  const signIn = pane.locator('[data-signin]');
  await signIn.waitFor({ timeout: left() });
  assert.match(await signIn.locator('xpath=..').innerText(), /^Claude Code is not signed in on this computer\./);
  await shot('d7-chat-not-signed-in');
  await signIn.click();
  await page.waitForFunction(() => document.querySelector('#welDlg').open && document.querySelector('#welT').textContent === 'Sign in to an agent', null, { timeout: left() });
  const body = page.locator('#welBody');
  assert.match(await body.innerText(), /Claude command line[\s\S]*Not found on this computer\. Install types Claude Code's official install command into a P9 terminal; press Enter there to run it\.[\s\S]*Not installed/);
  assert.equal(await body.locator('[data-act="term:claude:install"]').innerText(), 'Install in a terminal');
  assert.equal(await body.locator('[data-act="term:claude:login"]').count(), 0, 'no terminal sign-in without the CLI');
  assert.equal(await body.locator('[data-act="term:codex:install"]').count(), 0, 'Codex is installed');
  assert.equal(await body.locator('[data-act="term:codex:login"]').innerText(), 'Sign in in a terminal');
  assert.equal(await body.locator('[data-act="start:claude"]').innerText(), 'Sign in', 'browser sign-in still there');
  await shot('d7-d8-wizard-agents', page.locator('#welDlg'));

  // Install: the wizard closes and the dock shows the new terminal with Claude's official install command, not run.
  await body.locator('[data-act="term:claude:install"]').click();
  await page.waitForFunction(() => !document.querySelector('#welDlg').open, null, { timeout: left() });
  await page.locator('#dock:not([hidden])').waitFor({ timeout: left() });
  let terminals = (await call(instance, '/terminals')).terminals.filter((x) => x.state === 'running');
  assert.equal(terminals.length, 1);
  await typedNotRun(tmux, terminals[0].id, COMMANDS['claude:install']);
  await page.locator('#dock', { hasText: 'claude.ai/install.sh' }).waitFor({ timeout: left() });
  await shot('d8-install-in-terminal');

  // Sign in in a terminal (Codex): the same, with codex login.
  await signIn.click();
  await page.waitForFunction(() => document.querySelector('#welDlg').open, null, { timeout: left() });
  await body.locator('[data-act="term:codex:login"]').click();
  await page.waitForFunction(() => !document.querySelector('#welDlg').open, null, { timeout: left() });
  let fresh;
  for (const end = Date.now() + 10000; Date.now() < end && !fresh; await wait(100)) {
    fresh = (await call(instance, '/terminals')).terminals.find((x) => x.state === 'running' && x.id !== terminals[0].id);
  }
  await typedNotRun(tmux, fresh.id, COMMANDS['codex:login']);
  await page.locator('#dock', { hasText: 'codex login' }).waitFor({ timeout: left() });
  await shot('d7-sign-in-in-terminal');
  assert.deepEqual(errors, []);
  console.log('PASS D7/D8 desktop: Sign in on the chat error opens the agents step; Install and Sign in in a terminal type the official commands, not run');
});
