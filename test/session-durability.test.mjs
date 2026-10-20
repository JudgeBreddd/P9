import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));
const main = path.join(root, 'apps/server/main.mjs');
const fixtureImport = path.join(root, 'test/home-fixture.mjs');
const fake = path.join(root, 'test/fake-acp-agent.mjs');
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', timeout: 10000, ...options });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function waitFor(check, label, attempts = 100) {
  let value;
  for (let i = 0; i < attempts; i += 1) {
    try { value = await check(); if (value) return value; } catch {}
    await delay(100);
  }
  throw new Error('timeout: ' + label);
}

function call(credentials, route, method = 'GET', body, operation = randomUUID()) {
  return new Promise((resolve, reject) => {
    const headers = { host: 'p9.local', origin: 'http://p9.local', cookie: `p9=${credentials.cookie}`, 'x-p9-csrf': credentials.csrf };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers['x-p9-op'] = operation;
    const req = request({ socketPath: credentials.socketPath, path: route, method, headers, timeout: 30000 }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text), headers: response.headers }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function events(credentials, match, after = 0) {
  const seen = [];
  for (let i = 0; i < 50; i += 1) {
    const result = await call(credentials, `/chat/events?after=${after}&wait=1000`);
    seen.push(...result.body.events);
    after = result.body.cursor;
    const hit = result.body.events.find(match);
    if (hit) return { hit, seen, cursor: after };
  }
  throw new Error('event-timeout');
}

test('Phase 9: real systemd restart and SIGKILL preserve only P9 tmux work; ACP resumes without replay', async (t) => {
  assert.equal(process.platform, 'linux', 'gate:9 requires Linux');
  assert.ok(process.env.XDG_RUNTIME_DIR && existsSync(path.join(process.env.XDG_RUNTIME_DIR, 'bus')), 'gate:9 requires the real systemd user bus');
  assert.match(run('tmux', ['-V']), /^tmux /, 'gate:9 requires real tmux');
  run('systemctl', ['--user', 'show-environment']);

  const base = await mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'p9-phase9-'));
  const workspace = path.join(base, 'workspace'), state = path.join(base, 'state'), recovery = path.join(base, 'recovery');
  const tmuxTmp = path.join(base, 'tmux'), suffix = randomUUID().slice(0, 8);
  const unit = `p9-phase9-${suffix}.service`, hubUnit = `p9-phase9-session-hub-${suffix}.service`;
  const socket = `p9-phase9-${suffix}`, unrelated = `p9-unrelated-${suffix}`;
  await Promise.all([mkdir(workspace), mkdir(recovery, { mode: 0o700 }), mkdir(tmuxTmp, { mode: 0o700 })]);
  await writeFile(path.join(workspace, 'note.txt'), 'phase9');
  const environment = { ...process.env, P9_TEST_HOME: base, TMPDIR: process.env.TMPDIR, TMUX_TMPDIR: tmuxTmp };
  const tmux = (which, args) => run('tmux', ['-L', which, ...args], { env: environment });
  tmux(unrelated, ['new-session', '-d', '-s', 'tyler-unrelated']);
  run('systemd-run', ['--user', '--unit', hubUnit, '--collect', '--property=KillMode=process', '--', 'sleep', '300']);
  const hubPid = Number(run('systemctl', ['--user', 'show', hubUnit, '-p', 'MainPID', '--value']).trim());

  const daemonArgs = [process.execPath, '--import', fixtureImport, main, '--workspace', workspace, '--state', state, '--recovery', recovery,
    '--acp-override', fake, '--tmux-socket', socket];
  const properties = ['--property=Type=simple', '--property=KillMode=process', '--property=Restart=on-failure', '--property=RestartSec=100ms'];
  const envArgs = ['--setenv=P9_TEST_HOME=' + base, '--setenv=TMPDIR=' + process.env.TMPDIR, '--setenv=TMUX_TMPDIR=' + tmuxTmp,
    '--setenv=PATH=' + process.env.PATH, '--setenv=XDG_RUNTIME_DIR=' + process.env.XDG_RUNTIME_DIR,
    '--setenv=DBUS_SESSION_BUS_ADDRESS=' + (process.env.DBUS_SESSION_BUS_ADDRESS ?? '')];
  run('systemd-run', ['--user', '--unit', unit, '--collect', ...properties, ...envArgs, '--', ...daemonArgs]);
  t.after(() => {
    try { run('systemctl', ['--user', 'stop', unit, hubUnit, 'p9-tmux-' + socket + '.service']); } catch {}
    try { run('tmux', ['-L', socket, 'kill-server'], { env: environment, stdio: 'ignore' }); } catch {}
    try { run('tmux', ['-L', unrelated, 'kill-server'], { env: environment, stdio: 'ignore' }); } catch {}
  });
  let credentials = await waitFor(async () => JSON.parse(await readFile(path.join(state, 'desktop.json'), 'utf8')), 'daemon credentials');
  assert.equal(run('systemctl', ['--user', 'show', unit, '-p', 'KillMode', '--value']).trim(), 'process');

  const terminal = await call(credentials, '/terminals', 'POST', {});
  assert.equal(terminal.status, 201, JSON.stringify(terminal.body));
  const sessionName = 'p9-' + terminal.body.terminal;
  const panePid = Number(tmux(socket, ['display-message', '-p', '-t', sessionName, '#{pane_pid}']).trim());
  assert.ok(alive(panePid));
  // The tmux server is its own unit, not a child of the daemon; a job a pane detaches must still end with Stop All.
  const tmuxUnit = 'p9-tmux-' + socket + '.service';
  assert.equal(run('systemctl', ['--user', 'is-active', tmuxUnit]).trim(), 'active');
  const marker = '30' + String(Date.now() % 10000).padStart(4, '0');
  tmux(socket, ['new-window', '-d', '-t', '=' + sessionName, 'nohup sleep ' + marker + ' >/dev/null 2>&1 & sleep 1']);
  const detached = () => run('pgrep', ['-f', '^sleep ' + marker + '$'], { stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  await waitFor(() => detached(), 'detached pane job');
  const chats = {};
  let cursor = 0;
  for (const provider of ['claude', 'codex']) {
    const created = await call(credentials, '/chat', 'POST', { provider });
    chats[provider] = created.body.conversation;
    assert.equal((await call(credentials, `/chat/${chats[provider]}/prompt`, 'POST', { text: provider + '-before' })).status, 202);
    cursor = (await events(credentials, (event) => event.conversation === chats[provider] && event.type === 'turn-end', cursor)).cursor;
  }

  const effectOperation = randomUUID();
  assert.equal((await call(credentials, `/chat/${chats.codex}/prompt`, 'POST', { text: 'effect-slow' }, effectOperation)).status, 202);
  cursor = (await events(credentials, (event) => event.conversation === chats.codex && event.type === 'update'
    && event.data.sessionUpdate === 'agent_message_chunk' && event.data.content.text === 'effect:1', cursor)).cursor;
  const profile = path.join(base, 'electron-profile');
  const electronEnv = { ...environment };
  delete electronEnv.ELECTRON_RUN_AS_NODE;
  const application = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', state, '--user-data-dir=' + profile], env: electronEnv,
    chromiumSandbox: true, timeout: 20000 });
  await application.firstWindow();
  const beforeClosePid = Number(run('systemctl', ['--user', 'show', unit, '-p', 'MainPID', '--value']).trim());
  await application.close();
  assert.equal(Number(run('systemctl', ['--user', 'show', unit, '-p', 'MainPID', '--value']).trim()), beforeClosePid);
  const replayed = await call(credentials, `/chat/${chats.codex}/prompt`, 'POST', { text: 'effect-slow' }, effectOperation);
  assert.equal(replayed.headers['x-p9-replayed'], '1');
  assert.equal((await readFile(path.join(workspace, 'phase9-side-effects'), 'utf8')).trim().split('\n').length, 1);
  assert.equal((await call(credentials, `/chat/${chats.codex}/cancel`, 'POST', {})).status, 200);
  cursor = (await events(credentials, (event) => event.conversation === chats.codex && event.type === 'turn-end', cursor)).cursor;

  run('systemctl', ['--user', 'restart', unit]);
  const firstCookie = credentials.cookie;
  credentials = await waitFor(async () => { const next = JSON.parse(await readFile(path.join(state, 'desktop.json'), 'utf8')); return next.cookie !== firstCookie && next; }, 'restart credentials');
  assert.ok(alive(panePid));
  assert.equal(Number(run('systemctl', ['--user', 'show', hubUnit, '-p', 'MainPID', '--value']).trim()), hubPid);
  assert.match(tmux(unrelated, ['list-sessions']), /tyler-unrelated/);
  for (const provider of ['claude', 'codex']) {
    assert.equal((await call(credentials, `/chat/${chats[provider]}/prompt`, 'POST', { text: provider + '-after-restart' })).status, 202);
    const resumed = await events(credentials, (event) => event.conversation === chats[provider] && event.type === 'turn-end', cursor);
    assert.ok(resumed.seen.some((event) => event.conversation === chats[provider] && event.type === 'resumed'), provider + ' did not resume');
    cursor = resumed.cursor;
  }

  assert.equal((await call(credentials, `/chat/${chats.claude}/prompt`, 'POST', { text: 'permission' })).status, 202);
  const pending = await events(credentials, (event) => event.conversation === chats.claude && event.type === 'approval', cursor);
  cursor = pending.cursor;
  const killedPid = Number(run('systemctl', ['--user', 'show', unit, '-p', 'MainPID', '--value']).trim());
  process.kill(killedPid, 'SIGKILL');
  const killedCookie = credentials.cookie;
  credentials = await waitFor(async () => { const next = JSON.parse(await readFile(path.join(state, 'desktop.json'), 'utf8')); return next.cookie !== killedCookie && next; }, 'SIGKILL restart', 150);
  assert.ok(alive(panePid));
  const afterKill = await events(credentials, (event) => event.conversation === chats.claude && event.type === 'interrupted', cursor);
  cursor = afterKill.cursor;
  const stale = await call(credentials, `/chat/${chats.claude}/answer`, 'POST', { request: pending.hit.data.request, answer: { optionId: 'allow' } });
  assert.equal(stale.status, 404);
  const allEvents = (await call(credentials, '/chat/events?after=0')).body.events;
  assert.equal(allEvents.filter((event) => event.conversation === chats.claude && event.type === 'user' && event.data.text === 'permission').length, 1);

  assert.equal((await call(credentials, `/chat/${chats.codex}/prompt`, 'POST', { text: 'crash' })).status, 202);
  await events(credentials, (event) => event.conversation === chats.codex && event.type === 'exited', cursor);

  const instance = createHash('sha256').update(path.join(base, '.local', 'state', 'p9-foundation')).digest('hex').slice(0, 8);
  const stubbornUnit = `p9-run-${instance}-${randomUUID()}`;
  const stubborn = spawn('systemd-run', ['--user', '--scope', '--quiet', '--collect', '--unit', stubbornUnit,
    '--property=RefuseManualStop=yes', '--', 'sleep', '300'], { env: environment, stdio: 'ignore' });
  await waitFor(() => run('systemctl', ['--user', 'is-active', stubbornUnit + '.scope']).trim() === 'active', 'stubborn owned scope');
  const failedStop = await call(credentials, '/stop-all', 'POST', {});
  assert.equal(failedStop.status, 500);
  assert.equal(failedStop.body.components.scripts, 'cleanup-failed-reconcile');
  run('systemctl', ['--user', 'kill', '--kill-whom=all', '--signal=SIGKILL', stubbornUnit + '.scope']);
  await waitFor(() => !alive(stubborn.pid), 'stubborn scope cleanup');

  await writeFile(path.join(workspace, 'slow-init'), '');
  const racing = await call(credentials, '/chat', 'POST', { provider: 'claude', title: 'barrier-race' });
  const starting = call(credentials, `/chat/${racing.body.conversation}/prompt`, 'POST', { text: 'never-replayed' });
  await waitFor(() => run('systemctl', ['--user', 'list-units', '--plain', '--no-legend', `p9-chat-${instance}-*.scope`]).includes('p9-chat-'), 'starting adapter scope');
  const stopped = Promise.all([call(credentials, '/stop-all', 'POST', {}), call(credentials, '/stop-all', 'POST', {})]);
  await delay(100);
  const refusedStart = await call(credentials, '/terminals', 'POST', {});
  assert.equal(refusedStart.status, 503);
  await unlink(path.join(workspace, 'slow-init'));
  const [startingResult, stopResults] = await Promise.all([starting, stopped]);
  assert.ok([202, 409, 502].includes(startingResult.status));
  assert.deepEqual(stopResults.map((result) => result.status), [200, 200]);
  assert.ok(!alive(panePid));
  assert.throws(() => detached(), 'a detached pane job survived Stop All');
  let tmuxState;
  try { tmuxState = run('systemctl', ['--user', 'is-active', tmuxUnit]).trim(); } catch (error) { tmuxState = String(error.stdout).trim(); }
  assert.ok(['inactive', 'failed'].includes(tmuxState), 'tmux unit after Stop All: ' + tmuxState);
  assert.equal(Number(run('systemctl', ['--user', 'show', hubUnit, '-p', 'MainPID', '--value']).trim()), hubPid);
  assert.match(tmux(unrelated, ['list-sessions']), /tyler-unrelated/);
  assert.deepEqual((await call(credentials, '/terminals')).body.terminals.map((item) => item.state), ['stopped']);
  console.log('PASS phase9 durability: window close kept the daemon and one side effect; restart + SIGKILL kept tmux; providers resumed; pending approval expired; adapter crash stopped; failed kill reported; creation barrier refused a concurrent start; repeated Stop All verified P9 work gone; unrelated tmux and session-hub sentinel untouched');
});
