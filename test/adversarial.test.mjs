// Phase 12 adversarial tests (threat model surfaces 3, 5, 7, 10, 11): hostile chat and repository content against the
// real Electron shell and Dev Focus, and a real ACP agent and a real P9 terminal reaching for locked files and a fake API key.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { _electron } from '@playwright/test';
import { root, remoteDaemon } from './helpers.mjs';
import { EDITOR_DIR } from '../apps/desktop/editor-host.mjs';

const MARKER = 'P9FAKESENTINEL7f3a';
const FAKE_KEY = 'sk-ant-api03-' + MARKER + '-not-a-real-key';
const fake = path.join(root, 'test/fake-acp-agent.mjs');
const LOCKED = ['.p9-locked.txt', '.env', 'secrets/key.txt', '.git/config'];
const editorHost = process.env.P9_EDITOR_HOST ?? path.join(EDITOR_DIR, 'codium-server');

async function plantLocked(workspace) {
  for (const name of LOCKED) {
    await mkdir(path.join(workspace, path.dirname(name)), { recursive: true });
    await writeFile(path.join(workspace, name), 'locked ' + MARKER + ' ' + FAKE_KEY + '\n');
  }
}

test('Phase 12: an ACP agent and a P9 terminal reach for locked files and a fake API key', async (t) => {
  const server = await remoteDaemon(t, { args: ['--acp-override', fake], setup: async (paths) => {
    await plantLocked(paths.workspace);
    return { env: { ANTHROPIC_API_KEY: FAKE_KEY, P9_FAKE_SENTINEL_KEY: FAKE_KEY } };
  } });
  const probe = path.join(root, 'test/locked-probe.mjs');
  const args = server.port + ' ' + server.host + ' ' + MARKER;

  // P9's own file route refuses every locked name even to the authenticated desktop, for reads and writes.
  for (const name of LOCKED) {
    const read = await server.desk('/files?path=' + encodeURIComponent(name));
    assert.notEqual(read.status, 200, name);
    assert.ok(!read.text.includes(MARKER), name + ' leaked through GET /files');
    const write = await server.desk('/files', 'PUT', { path: name, content: 'overwritten', hash: '0'.repeat(64) });
    assert.notEqual(write.status, 200, name);
    assert.match(await readFile(path.join(server.workspace, name), 'utf8'), new RegExp(MARKER), name + ' changed on disk');
  }

  // An ACP agent the daemon started runs the probe.
  const chat = await server.desk('/chat', 'POST', { provider: 'claude' });
  assert.equal(chat.status, 201, chat.text);
  assert.equal((await server.desk('/chat/' + chat.body.conversation + '/prompt', 'POST', { text: 'probe ' + server.port + ' ' + server.host + ' ' + probe + ' ' + MARKER })).status, 202);
  let agentLine, cursor = 0;
  for (let i = 0; i < 40 && !agentLine; i++) {
    const events = (await server.desk('/chat/events?after=' + cursor + '&wait=2000')).body;
    cursor = events.cursor;
    agentLine = events.events.map((event) => event.data?.content?.text ?? '').find((text) => text.startsWith('PROBE '));
  }
  assert.ok(agentLine, 'agent probe reply');

  // A real P9 terminal (tmux pane) runs the same probe.
  const terminal = (await server.desk('/terminals', 'POST', {})).body.terminal;
  const out = path.join(server.directory, 'terminal-probe.txt');
  const socketName = server.extra.args[server.extra.args.indexOf('--tmux-socket') + 1];
  execFileSync('tmux', ['-L', socketName, 'send-keys', '-t', '=p9-' + terminal + ':', process.execPath + ' ' + probe + ' ' + args + ' > ' + out, 'Enter']);
  let terminalLine;
  for (let i = 0; i < 100 && !terminalLine; i++) { await wait(100); terminalLine = await readFile(out, 'utf8').catch(() => '').then((text) => text.includes('PROBE ') ? text : null); }
  assert.ok(terminalLine, 'terminal probe output');

  for (const [who, line] of [['agent', agentLine], ['terminal', terminalLine]]) {
    const result = JSON.parse(line.slice(line.indexOf('PROBE ') + 6));
    // The daemon's API key never reaches the child's environment.
    assert.deepEqual(result.sentinelNames, [], who + ' environment carries the fake key');
    // P9's remote route gives nothing without a login.
    for (const name of LOCKED) {
      assert.equal(result.remote[name].status, 401, who + ' remote ' + name);
      assert.equal(result.remote[name].leaked, false, who + ' remote ' + name);
    }
    // The stated limit (SECURITY.md surfaces 4, 11): the child runs as you, so it reads the locked files straight from disk.
    assert.deepEqual(result.disk, Object.fromEntries(LOCKED.map((name) => [name, true])), who + ' disk ' + JSON.stringify(result.disk));
  }
  console.log('PASS agent and terminal: fake API key absent from both environments; P9 routes refuse 4 locked names (desktop GET/PUT, remote 401); direct disk reads succeed as SECURITY.md states');
});

// The fake agent echoes any prompt it does not know, so the hostile text comes back as the agent's own reply too.
const HOSTILE = '<img src=x onerror="window.__pwned=1;window.p9.mission(\'run\',{id:\'pwn\'})"><script>window.__pwned=2</script>';

async function hostileDaemon(t) {
  return remoteDaemon(t, { args: ['--acp-override', fake], setup: async (paths) => {
    const canary = path.join(paths.directory, 'pwned');
    const settings = { waiting: '_tyler', registry: 'hub/registry.json', primary: 'projects/AGENTS.md' };
    await mkdir(path.join(paths.workspace, '_tyler'), { recursive: true });
    await mkdir(path.join(paths.workspace, 'hub'), { recursive: true });
    await mkdir(path.join(paths.workspace, 'projects'), { recursive: true });
    await writeFile(path.join(paths.workspace, 'hub/registry.json'), JSON.stringify({ apps: [], pages: [], scripts: [
      { id: 'pwn', title: 'Canary', group: 'Health', cmd: [process.execPath, '-e', 'require("fs").writeFileSync(process.argv[1], "ran")', canary] }] }));
    await writeFile(path.join(paths.workspace, 'projects/AGENTS.md'), '# Projects\n\n**Main project: ' + HOSTILE + '** (`p9/`)\n');
    await writeFile(path.join(paths.workspace, '_tyler/hostile.md'), '# ' + HOSTILE + '\n\nA. yes\nB. no\n');
    await writeFile(path.join(paths.workspace, HOSTILE.slice(0, 60).replace(/\//g, '_') + '.md'), HOSTILE + '\n');
    // A repository that tries to run code the moment the editor opens it (surface 5: automatic tasks, workspace settings).
    await mkdir(path.join(paths.workspace, '.vscode'), { recursive: true });
    await writeFile(path.join(paths.workspace, '.vscode/tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [{ label: 'pwn', type: 'process',
      command: process.execPath, args: ['-e', 'require("fs").writeFileSync(process.argv[1], "task")', canary + '-task'], runOptions: { runOn: 'folderOpen' } }] }));
    await writeFile(path.join(paths.workspace, '.vscode/settings.json'), JSON.stringify({ 'task.allowAutomaticTasks': 'on',
      'security.workspace.trust.enabled': false, 'terminal.integrated.automationProfile.linux': { path: process.execPath, args: ['-e', 'require("fs").writeFileSync(process.argv[1], "profile")', canary + '-profile'] } }));
    const file = path.join(paths.directory, 'settings.json');
    await writeFile(file, JSON.stringify(settings));
    return { args: ['--settings', file] };
  } });
}

async function launch(t, server, extraEnv = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-adv-home-'));
  const env = { ...process.env, HOME: home, ...extraEnv }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', server.state, '--user-data-dir=' + path.join(home, 'profile')],
    env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), wait(15000)]); proc.kill(); });
  app.home = home;
  return app;
}

const pwned = (page) => page.evaluate(() => ({ flag: window.__pwned ?? null, handlers: document.querySelectorAll('[onerror],[onload],[onclick]').length,
  scripts: [...document.querySelectorAll('script')].filter((s) => s.textContent.includes('__pwned')).length }));

test('Phase 12: hostile chat and repository content never run code or reach IPC in the desktop shell', async (t) => {
  const server = await hostileDaemon(t);
  const canary = path.join(server.directory, 'pwned');
  const chat = await server.desk('/chat', 'POST', { provider: 'claude', title: HOSTILE });
  assert.equal(chat.status, 201, chat.text);
  assert.equal((await server.desk('/chat/' + chat.body.conversation + '/prompt', 'POST', { text: HOSTILE })).status, 202);
  const app = await launch(t, server);
  const shell = await app.firstWindow();
  const errors = []; shell.on('pageerror', (error) => errors.push(error.message));
  // Chat: the hostile title in the tab, the hostile prompt and the agent's echo in the transcript, all shown as text.
  await shell.locator('#tabs .tab').first().waitFor({ timeout: 20000 });
  await shell.locator('#tabs .tab').first().click();
  await shell.waitForFunction((text) => document.body.innerText.split(text).length > 2, HOSTILE, { timeout: 20000 });
  assert.ok((await shell.locator('#tabs').innerText()).includes('<img src=x'), 'title shown as text');
  // Mission Control: the hostile main-project name, question title and file name.
  await shell.keyboard.press('Control+3');
  await shell.waitForFunction(() => document.body.innerText.includes('<img src=x onerror'), null, { timeout: 20000 });
  await wait(1500);
  assert.deepEqual(await pwned(shell), { flag: null, handlers: 0, scripts: 0 });
  assert.equal(existsSync(canary), false, 'the canary script ran');
  console.log('PASS desktop shell: hostile chat title/prompt/agent reply and Mission Control name/question shown as text; no handler, no script, canary never ran' + (errors.length ? '; page errors: ' + errors.join(' | ') : ''));
});

test('Phase 12: a hostile repository runs nothing when Dev Focus opens it', { skip: process.platform !== 'linux' || !existsSync(editorHost) ? 'needs the Linux editor host at ' + editorHost : false, timeout: 240000 }, async (t) => {
  const server = await hostileDaemon(t);
  const canary = path.join(server.directory, 'pwned');
  const app = await launch(t, server, { P9_EDITOR_HOST: editorHost, P9_FAKE_SENTINEL_KEY: FAKE_KEY });
  const shell = await app.firstWindow();
  await shell.locator('#cards .card').first().waitFor();
  const devWindow = app.waitForEvent('window', { predicate: (page) => page.url().startsWith('p9://dev/'), timeout: 60000 });
  await shell.keyboard.press('Control+2');
  const dev = await devWindow;
  await dev.waitForFunction(() => window.devFocusReady || document.querySelector('#status')?.textContent, null, { timeout: 120000 });
  // Open the hostile file and the hostile tasks file in the editor, then give folder-open tasks time to fire.
  const name = HOSTILE.slice(0, 60).replace(/\//g, '_') + '.md';
  await dev.evaluate(async (file) => { await window.devFocus.open(file); await window.devFocus.open('.vscode/tasks.json'); }, name);
  await wait(10000);
  for (const suffix of ['', '-task', '-profile']) assert.equal(existsSync(canary + suffix), false, 'canary' + suffix + ' ran');
  assert.deepEqual(await pwned(dev), { flag: null, handlers: 0, scripts: 0 });
  // Every editor-host process (server, extension host, pty host) started from an allowlisted environment (cold-read L1).
  const { readdirSync, readFileSync } = await import('node:fs');
  // This test's editor host only: its binary path in the command line and this test's HOME in the environment.
  const reh = readdirSync('/proc').filter((pid) => /^\d+$/.test(pid)).flatMap((pid) => {
    try {
      const environ = readFileSync('/proc/' + pid + '/environ', 'utf8').split('\0');
      return readFileSync('/proc/' + pid + '/cmdline', 'utf8').includes(editorHost) && environ.includes('HOME=' + app.home) ? [environ] : [];
    } catch { return []; }
  });
  assert.ok(reh.length >= 2, 'editor-host processes found: ' + reh.length);
  assert.equal(reh.filter((environ) => environ.some((entry) => entry.includes(MARKER))).length, 0, 'an editor-host process carries the fake key');
  // The page cannot move its own main frame to another p9://dev/ file, which would still get the preload (cold-read L4).
  await dev.evaluate(() => { location.href = 'p9://dev/prime-theme.json'; });
  await wait(1500);
  assert.equal(dev.url().split(/[?#]/)[0], 'p9://dev/', 'Dev Focus main frame navigated to ' + dev.url());
  // Control: the same task run by hand does write its canary, so the empty check above means "blocked", not "broken".
  await dev.evaluate(() => window.devFocus.v.commands.executeCommand('workbench.action.tasks.runTask', 'pwn'));
  for (let i = 0; i < 100 && !existsSync(canary + '-task'); i++) await wait(200);
  assert.equal(existsSync(canary + '-task'), true, 'the manual control run never wrote its canary');
  console.log('PASS Dev Focus: folder-open task, workspace automation profile and hostile file content ran nothing after 10 s (manual control run: canary written); ' + reh.length + ' editor-host processes without the fake key');
});

test('Phase 12: terminal socket input that looks like tmux commands reaches the shell as keys, never tmux (cold-read L5)', async (t) => {
  const { default: WebSocket } = await import('ws');
  const { authenticated, leased } = await import('./helpers.mjs');
  const server = await remoteDaemon(t);
  const canary = path.join(server.directory, 'tmux-pwned');
  const terminal = (await server.desk('/terminals', 'POST', {})).body.terminal;
  const socketName = server.extra.args[server.extra.args.indexOf('--tmux-socket') + 1];
  const ws = new WebSocket('ws+unix://' + server.credentials.socketPath + ':/terminals/' + terminal + '/socket', { headers: authenticated(server.credentials) });
  let output = '';
  ws.on('message', (data, binary) => { if (binary) output += data.toString('latin1'); });
  const keys = leased(ws);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  t.after(() => ws.close());
  // No leading empty line: it detaches a control client, which would hide a raw-command path from this test.
  // Each line is a valid tmux command; run-shell is not a shell command, so only a tmux parse would write the canary.
  await keys.keys('set-option -g @p9pwn yes\nrun-shell "touch ' + canary + '"\nsend-keys -t =p9-' + terminal + ': "touch ' + canary + '" Enter\nprintf \'P9-%s-OK\\n\' ECHO\n');
  for (let i = 0; i < 100 && !output.includes('P9-ECHO-OK'); i++) await wait(100);
  await wait(500);
  assert.equal(existsSync(canary), false, 'a tmux command ran');
  assert.equal(execFileSync('tmux', ['-L', socketName, 'show-options', '-gqv', '@p9pwn']).toString().trim(), '');
  assert.ok(output.includes('P9-ECHO-OK'), 'the shell ran the last line: ' + JSON.stringify(output.slice(-300)));
  console.log('PASS terminal input: set-option, run-shell and send-keys lines reached the shell as text (printf answered); tmux option unset, canary absent');
});
