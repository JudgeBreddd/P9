// Threat model row I1: Keep P9 running on a remote? The per-host choice (apps/desktop/keep.mjs), the remote's start script
// (scripts/background.sh: up, keep, release, run over the stub ssh by remoteMode), READ starting a stopped background daemon,
// and the daemon's idle stop (apps/server/idle.mjs, --idle-exit). HOME is a temp folder; loginctl, systemctl, node and ssh
// are stubs (install-runtime.test.mjs stage), so nothing here touches this machine's own P9.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { stage, bash, nodeLog, stopDaemon } from './install-runtime.test.mjs';
import { createKeeper } from '../apps/desktop/keep.mjs';
import { READ, remoteMode, startServer } from '../apps/desktop/remote.mjs';
import { watchIdle } from '../apps/server/idle.mjs';
import { daemon, fixture, root } from './helpers.mjs';

const skip = process.platform === 'win32' ? 'sh' : false;
const read = (file) => readFile(file, 'utf8').catch(() => '');
const starts = async (s) => (await nodeLog(s)).split('\n').filter((line) => line.includes('apps/server/main.mjs')).length;
const sh = (s, args, env = s.env) => new Promise((resolve) => execFile('sh', args, { env, timeout: 40000 }, (error, out, err) => resolve({ code: error?.code ?? 0, out: out + err })));
const until = async (check, ms = 5000) => { const end = Date.now() + ms; while (!(await check())) { if (Date.now() > end) return false; await new Promise((r) => setTimeout(r, 100)); } return true; };
// A remote in background mode: install.sh --headless --background, as the app's Install runs it with no Yes remembered.
async function background(t, linger = 'refused') {
  const s = await stage(true, linger, { installed: false }), { code, out } = await bash(s, ['--headless', '--background']);
  t.after(() => stopDaemon(s));
  assert.equal(code, 0, out);
  return { ...s, start: path.join(s.runDir, 'start') };
}

// The choice: Yes, No, remembered, changed in Settings.
function keeper(saved) {
  const runs = [], saves = [];
  const k = createKeeper({ saved, named: (h) => /^[\w.-]+$/.test(h), run: async (host, action) => { runs.push(host + ' ' + action); return { phase: 'ok' }; }, save: async () => { saves.push({ ...k.keep }); } });
  return { k, runs, saves };
}
const settle = () => new Promise((r) => setImmediate(r));

test('Keep P9 running, Yes with Do not ask again: stored for this machine, and P9 there moves to its service', { timeout: 5000 }, async () => {
  const { k, runs, saves } = keeper();
  assert.equal(k.status('box', true).ask, true, 'asked after the first connect in background mode');
  await k.answer('box', true, true, true); await settle();
  assert.deepEqual(k.keep, { box: true }); assert.deepEqual(saves, [{ box: true }]); assert.deepEqual(runs, ['box keep']);
  assert.equal(k.status('box', true).ask, false);
  assert.deepEqual(k.status('box', true).keeping, { host: 'box', action: 'keep', phase: 'ok' });
});

test('Keep P9 running, No without Do not ask again: nothing stored, nothing run, not asked again this run', { timeout: 5000 }, async () => {
  const { k, runs, saves } = keeper();
  await k.answer('box', true, false, false); await settle();
  assert.deepEqual(k.keep, {}); assert.deepEqual(saves, []); assert.deepEqual(runs, [], 'already background: no release');
  assert.equal(k.status('box', true).ask, false);
  assert.equal(keeper().k.status('box', true).ask, true, 'a new run asks again');
});

test('A remembered choice: never asked, applied at each connect, once per run when it did not work', { timeout: 5000 }, async () => {
  const yes = keeper({ box: true, 'bad host': true, other: 'yes' });
  assert.deepEqual(yes.k.keep, { box: true }, 'only named hosts and true or false');
  assert.equal(yes.k.status('box', true).ask, false);
  yes.k.connected('box', false); await settle();
  assert.deepEqual(yes.runs, [], 'on its service already');
  yes.k.connected('box', true); await settle();
  assert.deepEqual(yes.runs, ['box keep']);
  yes.k.connected('box', true); await settle();
  assert.deepEqual(yes.runs, ['box keep'], 'not again this run');
  const no = keeper({ box: false });
  no.k.connected('box', true); await settle();
  assert.deepEqual(no.runs, [], 'background already');
  no.k.connected('box', false); await settle();
  assert.deepEqual(no.runs, ['box release']);
});

test('Settings > Remote changes the choice: Ask again, Stops, Keeps running for a remote not in use', { timeout: 5000 }, async () => {
  const { k, runs } = keeper({ box: true });
  await k.set('box', true, null); await settle();
  assert.deepEqual(k.keep, {}); assert.deepEqual(runs, []); assert.equal(k.status('box', true).ask, true, 'Ask: the question comes back');
  await k.set('box', false, false); await settle();
  assert.deepEqual(k.keep, { box: false }); assert.deepEqual(runs, ['box release'], 'this window\'s remote, on its service: released now');
  await k.set('other', null, true); await settle();
  assert.deepEqual(k.keep, { box: false, other: true }); assert.deepEqual(runs, ['box release'], 'not connected: at its next connect');
  // The stored choice follows a later Keep it running press, or the next connect would undo it.
  await k.answer('box', true, true, false);
  assert.equal(k.keep.box, true);
});

// The start script on the remote.
test('start up twice: one daemon; a folder that is not owner-only is refused', { skip, timeout: 40000 }, async (t) => {
  const s = await background(t);
  assert.equal(await starts(s), 1);
  const again = await sh(s, [s.start, 'up']);
  assert.equal(again.code, 0, again.out);
  assert.equal(await starts(s), 1, 'the running one is used');
  await chmod(s.runDir, 0o755);
  const loose = await sh(s, [s.start, 'up']);
  assert.notEqual(loose.code, 0);
  assert.match(loose.out, /P9_BACKGROUND unsafe-folder/);
});

test('READ at a connect starts a background daemon that stopped when idle, and reports its folder', { skip, timeout: 40000 }, async (t) => {
  const s = await background(t);
  await stopDaemon(s);
  assert.ok(await until(() => !existsSync(path.join(s.runDir, 'p9-foundation', 'desktop.json'))), 'stopped');
  const { code, out } = await sh(s, ['-c', READ], { ...s.env, XDG_RUNTIME_DIR: s.run });
  assert.equal(code, 0, out);
  assert.equal(out.split('\n')[0], s.runDir);
  assert.equal(await starts(s), 2);
});

test('Keep it running where linger is allowed: linger, the old daemon stopped, the service installed, background mode off', { skip, timeout: 60000 }, async (t) => {
  const s = await background(t, 'allowed');
  assert.equal((await remoteMode('test-host', 'keep', path.join(s.bin, 'ssh'))).phase, 'ok');
  assert.equal(await read(s.lingerLog), '--no-ask-password enable-linger\n');
  assert.match(await nodeLog(s), /XDG=\S+ scripts\/install-service\.mjs /);
  assert.ok(!existsSync(path.join(s.runDir, 'background')) && existsSync(path.join(s.runDir, 'lingered')));
  assert.ok(!existsSync(path.join(s.runDir, 'p9-foundation', 'desktop.json')), 'the background daemon stopped');
  // No: the service off, linger off (P9 turned it on), the background daemon again.
  await writeFile(path.join(s.home, '.config', 'systemd', 'user', 'p9-foundation.service'), '');
  assert.equal((await remoteMode('test-host', 'release', path.join(s.bin, 'ssh'))).phase, 'ok');
  assert.match(await read(s.systemctlLog), /--user disable --now p9-foundation\.service/);
  assert.match(await read(s.lingerLog), /--no-ask-password disable-linger\n$/);
  assert.ok(!existsSync(path.join(s.home, '.config', 'systemd', 'user', 'p9-foundation.service')));
  assert.ok(existsSync(path.join(s.runDir, 'background')) && !existsSync(path.join(s.runDir, 'lingered')));
  assert.equal(await starts(s), 2);
});

test('Keep it running where linger needs an admin: refused, P9 stays in background mode, still running', { skip, timeout: 40000 }, async (t) => {
  const s = await background(t, 'refused');
  assert.equal((await remoteMode('test-host', 'keep', path.join(s.bin, 'ssh'))).phase, 'refused');
  assert.ok(existsSync(path.join(s.runDir, 'background')) && existsSync(path.join(s.runDir, 'p9-foundation', 'desktop.json')));
  assert.ok(!(await nodeLog(s)).includes('install-service.mjs'));
});

test('A remote installed before this choice has no start script: no-start, nothing run', { skip, timeout: 20000 }, async () => {
  const s = await stage(true);
  assert.equal((await remoteMode('test-host', 'release', path.join(s.bin, 'ssh'))).phase, 'no-start');
  assert.equal(await read(s.systemctlLog), '');
});

// The idle stop.
test('watchIdle: stops once nobody has used it; an open connection or a running turn holds it', { timeout: 10000 }, async () => {
  const fake = (count) => Object.assign(new EventEmitter(), { getConnections: (cb) => cb(null, count()) });
  let open = 0, turn = false, stopped = 0;
  const server = fake(() => open);
  const timer = watchIdle({ seconds: 0.3, servers: [server], turns: () => turn, stop: () => { stopped++; }, every: 50 });
  {
    open = 1; await new Promise((r) => setTimeout(r, 600)); assert.equal(stopped, 0, 'a connection open');
    open = 0; turn = true; await new Promise((r) => setTimeout(r, 600)); assert.equal(stopped, 0, 'a turn running');
    turn = false; server.emit('connection'); await new Promise((r) => setTimeout(r, 150)); assert.equal(stopped, 0, 'just used');
    assert.ok(await until(() => stopped === 1, 2000), 'idle: stopped');
  }
  clearInterval(timer);
});

test('The daemon with --idle-exit stays while a client is connected and exits once idle', { skip, timeout: 30000 }, async (t) => {
  const d = await daemon(t, undefined, false, async () => ({ args: ['--idle-exit', '1'] }));
  const socket = net.connect(path.join(d.state, 'daemon.sock'));
  await once(socket, 'connect');
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(d.child.exitCode, null, 'a client is connected');
  socket.destroy();
  assert.ok(await until(() => d.child.exitCode !== null, 8000), 'idle: exited');
  assert.equal(d.child.exitCode, 0);
});

test('The daemon refuses a state folder whose socket path is longer than Linux allows', { skip, timeout: 20000 }, async () => {
  const f = await fixture(), state = path.join(f.directory, 's'.repeat(110));
  await mkdir(state, { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, ['--import', './test/home-fixture.mjs', 'apps/server/main.mjs', '--workspace', f.workspace, '--state', state, '--recovery', f.recovery],
    { cwd: root, env: { PATH: process.env.PATH, P9_TEST_HOME: f.directory, XDG_STATE_HOME: f.directory }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { out += c; });
  const [code] = await once(child, 'exit');
  assert.notEqual(code, 0);
  assert.match(out, /socket-path-too-long/);
});

// Start P9 there (the connecting screen, never a terminal command).
test('Start P9 there: the user service where one is installed, the background start in background mode, none where neither', { skip, timeout: 40000 }, async (t) => {
  const service = await stage(true);
  assert.equal(await startServer('test-host', path.join(service.bin, 'ssh')), 'ok');
  assert.match(await read(service.systemctlLog), /^--user start p9-foundation\.service$/m);
  const s = await background(t);
  await stopDaemon(s);
  assert.ok(await until(() => !existsSync(path.join(s.runDir, 'p9-foundation', 'desktop.json'))), 'stopped');
  assert.equal(await startServer('test-host', path.join(s.bin, 'ssh')), 'ok');
  assert.equal(await starts(s), 2);
  assert.equal(await read(s.systemctlLog), '', 'background mode: not the service');
  const none = await stage(true, 'refused', { installed: false });
  assert.equal(await startServer('test-host', path.join(none.bin, 'ssh')), 'none');
  assert.equal(await startServer('-oProxyCommand=x', path.join(none.bin, 'ssh')), 'failed', 'HOST check');
});
