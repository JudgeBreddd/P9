// D7/D8 (threat model row 53): an agent's sign-in command is typed into a new P9 terminal from a fixed table and never run
// by P9; the page names only the agent and the action. Item 15: there is no install command any more (both CLIs ship with
// P9; the wizard's Install writes a launcher, setup-wizard.test.mjs). Chat Focus's "not signed in" error opens the
// wizard's agents step. Stand-in CLIs on a private PATH and a private tmux socket: nothing here installs or signs in anything,
// and no test presses Enter in a terminal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
const COMMANDS = { 'claude:login': 'claude auth login', 'codex:login': 'codex login' };

// A daemon whose PATH holds node, tmux and the given stand-in CLIs only, on its own tmux socket and TMUX_TMPDIR.
// without: a machine lacking those programs instead (item 15): every program in /usr/bin but them, plus node and tmux.
async function start(t, clis, { without } = {}) {
  const tmpdir = await mkdtemp(path.join(os.tmpdir(), 'p9-tmux-')), bin = await mkdtemp(path.join(os.tmpdir(), 'p9-bin-')), socket = 'p9a-' + randomUUID().slice(0, 8);
  t.after(() => rm(bin, { recursive: true, force: true }));
  for (const name of clis) await writeFile(path.join(bin, name), '#!/bin/sh\necho stand-in "$0" "$@" ran >&2\nexit 9\n', { mode: 0o755 });
  const tmuxDir = path.dirname(execFileSync('sh', ['-c', 'command -v tmux']).toString().trim());
  let PATH = [bin, path.dirname(process.execPath), tmuxDir, '/bin'].join(':');
  if (without) {
    const programs = await mkdtemp(path.join(os.tmpdir(), 'p9-path-'));
    t.after(() => rm(programs, { recursive: true, force: true }));
    const links = [...(await readdir('/usr/bin')).map((name) => path.join('/usr/bin', name)), process.execPath, path.join(tmuxDir, 'tmux')];
    for (const file of links) if (!without.includes(path.basename(file))) await symlink(file, path.join(programs, path.basename(file))).catch(() => {});
    PATH = [bin, programs].join(':');
  }
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

test('D8: /setup says which agent CLIs are on PATH, in ~/.local/bin or in P9\'s bin folder', { skip: !linux, timeout: 60000 }, async (t) => {
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
  // Item 15: the launcher the wizard's Install writes counts.
  await mkdir(path.join(instance.directory, '.local', 'share', 'p9', 'bin'), { recursive: true });
  await writeFile(path.join(instance.directory, '.local', 'share', 'p9', 'bin', 'codex'), '#!/bin/sh\n', { mode: 0o755 });
  assert.equal((await call(instance, '/setup')).codexCli, true);
});

test('D7/D8: /setup/agent-terminal types only the table\'s command into a new terminal in the workspace, never runs it', { skip: !linux, timeout: 60000 }, async (t) => {
  const { instance, tmux } = await start(t, ['claude', 'codex']);
  for (const body of [{}, { agent: 'claude' }, { agent: 'x', action: 'login' }, { agent: 'claude', action: 'run' }, { agent: ['claude'], action: 'login' },
    { agent: 'claude', action: ['login'] }, { agent: 'claude', action: 'toString' }, { agent: 'constructor', action: 'login' }, { agent: '__proto__', action: 'login' },
    { agent: 'claude', action: 'login', command: 'id' }, { agent: 'claude', action: 'login', cwd: '/' },
    // Item 15: the old official install commands are gone from the table.
    { agent: 'claude', action: 'install' }, { agent: 'codex', action: 'install' }]) {
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
  assert.equal((await call(instance, '/terminals')).terminals.filter((x) => x.state === 'running').length, 2);
  console.log('PASS D7/D8 route: 13 bad bodies refused, install among them; the two sign-in commands typed, not run, in the workspace');
});

// The desktop: a chat that is not signed in offers Sign in, which opens the wizard at the agents step (by name: item 15
// put the pick step before it). Claude's CLI is not on PATH and Claude was never picked, yet the step shows Claude, the
// chat's own agent, with the browser sign-in (the CLI P9 ships); Codex's CLI is there, signed out (Sign in in a terminal).
// No row offers an install command. The terminal button closes the wizard and shows the dock on the typed command, not run.
test('D7/D8: Chat Focus "Sign in" opens the agents step with the chat\'s agent; Sign in in a terminal opens the dock on the typed command', { skip: !linux, timeout: 60000 }, async (t) => {
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
  assert.match(await body.innerText(), /Claude[\s\S]*Not signed in[\s\S]*Codex/);
  assert.equal(await body.locator('[data-act="start:claude"]').innerText(), 'Sign in', 'browser sign-in, with the CLI P9 ships');
  assert.equal(await body.locator('[data-act="term:claude:login"]').count(), 0, 'no terminal sign-in without the CLI on PATH');
  assert.equal(await body.locator('[data-act$=":install"]').count(), 0, 'no install command (item 15)');
  assert.doesNotMatch(await body.innerText(), /official install|claude\.ai\/install|npm install/);
  assert.equal(await body.locator('[data-act="term:codex:login"]').innerText(), 'Sign in in a terminal');
  await shot('d7-d8-wizard-agents', page.locator('#welDlg'));

  // Sign in in a terminal (Codex): codex login typed into a new terminal, not run.
  await body.locator('[data-act="term:codex:login"]').click();
  await page.waitForFunction(() => !document.querySelector('#welDlg').open, null, { timeout: left() });
  let fresh;
  for (const end = Date.now() + 10000; Date.now() < end && !fresh; await wait(100)) {
    fresh = (await call(instance, '/terminals')).terminals.find((x) => x.state === 'running');
  }
  await typedNotRun(tmux, fresh.id, COMMANDS['codex:login']);
  await page.locator('#dock:not([hidden])', { hasText: 'codex login' }).waitFor({ timeout: left() });
  await shot('d7-sign-in-in-terminal');
  assert.deepEqual(errors, []);
  console.log('PASS D7/D8 desktop: Sign in on the chat error opens the agents step with Claude on it; no install command; Sign in in a terminal types codex login, not run');
});

// Item 15: the wizard's Install for the agents picked writes a launcher in P9's bin folder for the CLI P9 ships (no
// download, no admin password); the page sends two booleans and nothing else.
test('Item 15: /setup/agents writes a launcher for each agent picked, pointing at the CLI P9 ships; no other body is accepted', { skip: !linux, timeout: 60000 }, async (t) => {
  const { instance } = await start(t, []);
  const bin = path.join(instance.directory, '.local', 'share', 'p9', 'bin');
  for (const body of [{}, { claude: true }, { claude: true, codex: false, x: 1 }, { claude: 'yes', codex: false }, { claude: false, codex: false }, [], ['claude'],
    { claude: true, codex: false, path: '/tmp/x' }, { claude: 1, codex: 0 }]) {
    const r = await call(instance, '/setup/agents', 'POST', body);
    assert.deepEqual([r.status, r.error], [400, 'request-refused'], JSON.stringify(body));
  }
  assert.deepEqual(await readdir(bin).catch(() => []), [], 'nothing written for a refused body');
  let s = await call(instance, '/setup');
  assert.deepEqual([s.claudeCli, s.codexCli, s.dependencies.filter((x) => x.id === 'claude' || x.id === 'codex').map((x) => [x.id, x.ok, x.admin])],
    [false, false, [['claude', false, false], ['codex', false, false]]]);

  const r = await call(instance, '/setup/agents', 'POST', { claude: false, codex: true });
  assert.deepEqual([r.status, r.installed], [200, ['codex']]);
  assert.deepEqual(await readdir(bin), ['codex']);
  assert.equal((await stat(bin)).mode & 0o077, 0, 'the bin folder is the owner\'s only');
  const mode = (await stat(path.join(bin, 'codex'))).mode;
  assert.ok((mode & 0o100) && !(mode & 0o022), 'the launcher runs for its owner, and only its owner can change it (the umask decides the rest): ' + mode.toString(8));
  const text = await readFile(path.join(bin, 'codex'), 'utf8');
  // Two absolute paths, node and the Codex CLI the adapter ships, and nothing from the request.
  assert.match(text, /^#!\/bin\/sh\n# Written by P9 \(item 15\)[^\n]*\nexec '\/[^'\n]+' '\/[^'\n]+\/@openai\/codex\/bin\/codex\.js' "\$@"\n$/);
  s = await call(instance, '/setup');
  assert.deepEqual([s.claudeCli, s.codexCli], [false, true]);
  // The launcher runs P9's own Codex, not the adapter (codex-acp answers --version with its own name).
  const version = execFileSync(path.join(bin, 'codex'), ['--version'], { timeout: 20000, env: { ...process.env, PATH: '/usr/bin:/bin' } }).toString();
  assert.match(version, /^codex-cli \d+\.\d+\.\d+/);

  const both = await call(instance, '/setup/agents', 'POST', { claude: true, codex: true });
  assert.deepEqual([both.status, both.installed, await readdir(bin)], [200, ['claude', 'codex'], ['claude', 'codex']]);
  assert.equal((await call(instance, '/setup')).claudeCli, true);
  console.log('PASS item 15 agents: 9 bad bodies refused; Install writes owner-only launchers in an owner-only folder for the agents picked; the Codex one runs P9\'s copy: ' + version.trim());
});

// Item 15 (threat model row 61): a system package P9 cannot carry. The command comes from deps.mjs's table for a
// dependency that is missing now, and is typed into a new P9 terminal, never run: the owner presses Enter and sudo asks there.
test('Item 15 (threat model row 61): /setup/admin-terminal types the table\'s command for a missing system package, never runs it', { skip: !linux, timeout: 60000 }, async (t) => {
  const { instance, tmux } = await start(t, [], { without: ['ssh'] });
  const s = await call(instance, '/setup');
  const by = Object.fromEntries(s.dependencies.map((x) => [x.id, x]));
  assert.deepEqual([by.ssh.ok, by.ssh.admin, by.tmux.ok, by.tmux.admin, by.tmux.command], [false, true, true, false, null]);
  assert.match(by.ssh.why, /SSH/);
  assert.equal(by.sandbox, undefined, 'a window that opened has its sandbox: the wizard never asks for it');
  assert.match(by.ssh.command, /^sudo .*\bopenssh/, 'the package manager\'s command for the SSH client');
  for (const body of [{}, { id: ['ssh'] }, { id: 'ssh', command: 'id' }, { id: 'ssh', cwd: '/' }, [], { name: 'ssh' }]) {
    const r = await call(instance, '/setup/admin-terminal', 'POST', body);
    assert.deepEqual([r.status, r.error], [400, 'request-refused'], JSON.stringify(body));
  }
  // Only a dependency that is missing now: tmux is there, the agents need no admin, the rest are not in the table.
  for (const id of ['tmux', 'claude', 'codex', 'sandbox', 'libatomic1', '__proto__', 'constructor', 'x; id']) {
    const r = await call(instance, '/setup/admin-terminal', 'POST', { id });
    assert.deepEqual([r.status, r.error], [409, 'nothing-to-install'], id);
  }
  assert.deepEqual((await call(instance, '/terminals')).terminals, [], 'nothing opened for a refused request');
  const r = await call(instance, '/setup/admin-terminal', 'POST', { id: 'ssh' });
  assert.deepEqual([r.status, r.command], [201, by.ssh.command]);
  await typedNotRun(tmux, r.terminal, by.ssh.command);
  assert.doesNotMatch(tmux('capture-pane', '-p', '-J', '-t', '=p9-' + r.terminal + ':'), /\[sudo\]|password/i, 'sudo never started');
  console.log('PASS item 15 admin route: 6 bad bodies refused, 8 ids that are not missing refused; ' + by.ssh.command + ' typed, not run');
});

// Item 15 on the desktop: the wizard asks Claude, Codex or both with the one line that says why, Install writes the picked
// one and Next reaches its sign-in; the terminal step, with the SSH client missing, is the admin screen: the reason first,
// then why it needs the password, then the command, and Run in a terminal types it into the dock, not run.
test('Item 15: wizard asks Claude, Codex or both with its why line, installs the pick, reaches sign-in; the admin screen gives the reason first', { skip: !linux, timeout: 60000 }, async (t) => {
  const deadline = Date.now() + 55000, left = () => Math.max(1000, deadline - Date.now());
  const { instance, tmux } = await start(t, [], { without: ['ssh'] });
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-c13-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + path.join(home, 'profile')], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), wait(15000)]); proc.kill(); });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const shot = async (name, what = page) => { await page.waitForTimeout(400); const png = await what.screenshot({ type: 'png' }); if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png.toString('base64')); };
  const title = () => page.locator('#welT').innerText();
  const body = page.locator('#welBody'), foot = page.locator('#welFoot');

  // The page sends two booleans or a dependency's name only: anything else is refused before the daemon.
  for (const [action, b] of [['installAgents', { claude: true, codex: false, path: '/x' }], ['installAgents', { claude: 'yes', codex: false }], ['adminTerminal', { id: 'sandbox' }],
    ['adminTerminal', { id: 'ssh', command: 'id' }], ['adminTerminal', { id: 'libatomic1' }]]) {
    assert.deepEqual(await page.evaluate(([a, x]) => window.p9.chat(a, x), [action, b]), { status: 400, body: { error: 'request-refused' } }, action + JSON.stringify(b));
  }

  // Nothing installed or signed in: the setup card opens the wizard at the first step not done, the pick.
  await page.locator('#cards [data-key="welcome"] .open').click({ timeout: left() });
  await page.waitForFunction(() => document.querySelector('#welDlg').open, null, { timeout: left() });
  for (let i = 0; i < 4 && await title() !== 'Claude, Codex or both?'; i++) await foot.locator('[data-act="next"]').click({ timeout: left() });
  assert.equal(await title(), 'Claude, Codex or both?');
  // The why line comes first, then the two agents, each with what it needs; Install waits for a pick.
  const why = 'P9\'s chats run on an agent, and you need an account with the one you pick: pick the one you already have.';
  assert.equal(await body.locator('[data-why]').innerText(), why);
  const text = await body.innerText();
  assert.ok(text.indexOf(why) === 0 && text.indexOf('Claude Code, by Anthropic.') > 0 && text.indexOf('Codex, by OpenAI.') > text.indexOf('Claude Code, by Anthropic.'), text);
  assert.equal(await foot.locator('[data-act="install"]').isDisabled(), true, 'Install waits for a pick');
  await shot('c13-pick-step', page.locator('#welDlg'));
  await body.locator('[data-act="choose:codex"]').click();
  await body.locator('[data-act="choose:claude"]').click();
  assert.match(await body.innerText(), /Install sets up both from the copy that comes with P9: nothing is downloaded and no admin password is needed\./);
  await body.locator('[data-act="choose:codex"]').click(); // Remove
  assert.match(await body.innerText(), /Install sets up Claude from the copy/);
  assert.equal(await body.locator('[data-act="choose:codex"]').innerText(), 'Pick');
  await shot('c13-pick-claude', page.locator('#welDlg'));
  await foot.locator('[data-act="install"]').click();
  await body.locator('[data-installed]').waitFor({ timeout: left() });
  assert.equal(await body.locator('[data-installed]').innerText(), 'Installed: Claude');
  assert.deepEqual(await readdir(path.join(instance.directory, '.local', 'share', 'p9', 'bin')), ['claude'], 'only the pick');
  await shot('c13-pick-installed', page.locator('#welDlg'));
  // Next: sign-in, for the one picked only.
  await foot.locator('[data-act="install"]').click();
  await page.waitForFunction(() => document.querySelector('#welT').textContent === 'Sign in to an agent', null, { timeout: left() });
  assert.equal(await body.locator('[data-act="start:claude"]').innerText(), 'Sign in');
  assert.equal(await body.locator('[data-act="start:codex"]').count(), 0, 'Codex was not picked');
  assert.equal(await body.locator('[data-act="term:claude:login"]').innerText(), 'Sign in in a terminal', 'the launcher is a CLI on PATH now');
  await shot('c13-sign-in', page.locator('#welDlg'));

  // Signed in (the credential file a sign-in leaves; the wizard looks again every 10 s), then on to the terminal step:
  // tmux is there, the SSH client is not, so it is the admin screen.
  await mkdir(path.join(instance.directory, '.claude'), { recursive: true });
  await writeFile(path.join(instance.directory, '.claude', '.credentials.json'), '{}');
  await page.waitForFunction(() => document.querySelector('#welFoot [data-act="next"]')?.disabled === false, null, { timeout: left() });
  for (let i = 0; i < 3 && await title() !== 'This needs your admin password'; i++) await foot.locator('[data-act="next"]').click({ timeout: left() });
  assert.equal(await title(), 'This needs your admin password');
  const ssh = body.locator('[data-admin="ssh"]');
  const said = await ssh.innerText(), command = await ssh.locator('[data-command]').innerText();
  const reason = said.indexOf('Server mode and Send to server reach your other machine over SSH.'), password = said.indexOf('only an admin can change that, so your computer asks for your password.');
  assert.ok(said.startsWith('SSH client') && reason > 0 && password > reason && said.indexOf(command) > password, 'reason, then why the password, then the command: ' + said);
  assert.match(command, /^sudo .*\bopenssh/);
  assert.equal(await body.locator('[data-admin="tmux"]').count(), 0, 'tmux is there');
  await shot('c13-admin-screen', page.locator('#welDlg'));
  await ssh.locator('[data-act="admin:ssh"]').click();
  await page.waitForFunction(() => !document.querySelector('#welDlg').open, null, { timeout: left() });
  let made;
  for (const end = Date.now() + 10000; Date.now() < end && !made; await wait(100)) made = (await call(instance, '/terminals')).terminals.find((x) => x.state === 'running');
  await typedNotRun(tmux, made.id, command);
  await page.locator('#dock:not([hidden])', { hasText: 'openssh' }).waitFor({ timeout: left() });
  await shot('c13-admin-in-terminal');
  assert.deepEqual(errors, []);
  console.log('PASS item 15 desktop: why line first, Install waits for a pick, Install writes Claude only, Next reaches its sign-in; admin screen: reason, why the password, command; typed, not run');
});
