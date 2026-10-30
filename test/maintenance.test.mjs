// Settings → Maintenance (MT1) below the page: Restart and Repair on Linux (RS1: done only when a new daemon answers), the
// environment the Windows repair runs with (BL8), and the Updates row against a stand-in updater (the A ↔ B1 shape).
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { root } from './helpers.mjs';
import { health, restartLinuxService, repairLinuxService, repairEnv, unitFor } from '../scripts/teh.mjs';

// Restart and Repair act on the unit that owns the window's state folder: a dev window (p9-dev) never restarts the daily daemon.
test('the unit is named after the state folder', () => {
  assert.equal(unitFor('/run/user/1000/p9-dev'), 'p9-dev.service');
  assert.equal(unitFor('/run/user/1000/p9-foundation'), 'p9-foundation.service');
  assert.equal(unitFor('/tmp/fixture/state'), 'p9-foundation.service');
  assert.equal(unitFor('/tmp/p9-Dev;rm'), 'p9-foundation.service');
});

// A stand-in systemctl that runs the unit's ExecStart for real and never touches the machine's own user units. Every call
// is logged. $HOME/restart-mode: "nothing" is a restart that leaves the old daemon running, "dead" one that starts nothing.
const SYSTEMCTL = String.raw`
import { appendFileSync, existsSync, readFileSync, writeFileSync, rmSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
const [, , , command, ...rest] = process.argv, unit = rest.at(-1), pid = path.join(process.env.HOME, 'p9-foundation.service.pid');
const file = path.join(process.env.HOME, '.config/systemd/user/p9-foundation.service');
appendFileSync(path.join(process.env.HOME, 'systemctl.log'), [command, ...rest].join(' ') + '\n');
const mode = existsSync(path.join(process.env.HOME, 'restart-mode')) ? readFileSync(path.join(process.env.HOME, 'restart-mode'), 'utf8').trim() : '';
const start = () => {
  const line = readFileSync(file, 'utf8').match(/^ExecStart=(.*)$/m)[1];
  const argv = [...line.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((m) => m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1').replaceAll('%%', '%')
    : m[2].replace('%t', process.env.XDG_RUNTIME_DIR));
  const log = openSync(path.join(process.env.HOME, 'daemon.log'), 'a');
  const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: ['ignore', log, log] });
  writeFileSync(pid, String(child.pid)); child.unref();
};
const stop = () => {
  try {
    const id = Number(readFileSync(pid, 'utf8')), end = Date.now() + 10000;
    process.kill(id);
    while (true) { try { process.kill(id, Date.now() > end ? 'SIGKILL' : 0); } catch { break; } }
  } catch {}
  // RuntimeDirectory=: systemd removes the daemon's state folder when the unit stops.
  rmSync(pid, { force: true }); rmSync(path.join(process.env.XDG_RUNTIME_DIR, 'p9-foundation'), { recursive: true, force: true });
};
if (command === 'cat') process.exit(existsSync(file) ? 0 : 1);
if (command === 'enable' && rest.includes('--now')) start();
if (command === 'disable') stop();
if (command === 'restart' && mode !== 'nothing') { stop(); if (mode !== 'dead') start(); }
`;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('Restart and Repair on Linux: done only when a new daemon answers; no unit, a dead or an unchanged daemon is reported, and the unit\'s drop-ins stay', { skip: process.platform !== 'linux', timeout: 180000 }, async (t) => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'p9-restart-'))), bin = path.join(home, 'bin'), run = path.join(home, 'run');
  const workspace = path.join(home, 'workspace');
  for (const directory of [bin, workspace]) await mkdir(directory);
  await mkdir(run, { mode: 0o700 });
  await writeFile(path.join(bin, 'systemctl'), '#!' + process.execPath + '\n' + SYSTEMCTL);
  await chmod(path.join(bin, 'systemctl'), 0o755);
  // teh.mjs runs systemctl from this process's PATH, so the stand-in is set here, not only in a child's env.
  Object.assign(process.env, { HOME: home, XDG_RUNTIME_DIR: run, PATH: bin + ':' + process.env.PATH });
  const installed = spawnSync(process.execPath, [path.join(root, 'scripts/install-service.mjs'), workspace], { env: process.env, encoding: 'utf8' });
  t.after(() => spawnSync(path.join(bin, 'systemctl'), ['--user', 'disable', '--now', 'p9-foundation.service'], { env: process.env }));
  assert.match(installed.stdout, /P9_SERVICE_INSTALLED/, installed.stderr);
  const state = path.join(run, 'p9-foundation'), unit = path.join(home, '.config/systemd/user/p9-foundation.service');
  const mode = (value) => writeFile(path.join(home, 'restart-mode'), value);

  // A restart: the old daemon is gone and one new one answers, with a boot of its own.
  const first = (await health(state)).boot;
  assert.equal(typeof first.pid, 'number'); assert.equal(typeof first.started, 'number');
  assert.deepEqual(await restartLinuxService(state), { restarted: true });
  const second = (await health(state)).boot;
  assert.notEqual(second.pid, first.pid);
  assert.equal(alive(first.pid), false, 'the old daemon is gone');
  assert.equal(Number(await readFile(path.join(home, 'p9-foundation.service.pid'), 'utf8')), second.pid, 'exactly one daemon: the one the unit started');

  // A restart that changes nothing (the old daemon still answers) and one that starts nothing both fail.
  await mode('nothing');
  assert.deepEqual(await restartLinuxService(state, 3000), { error: 'daemon-not-answering' });
  assert.deepEqual((await health(state)).boot, second);
  await mode('dead');
  assert.deepEqual(await restartLinuxService(state, 3000), { error: 'daemon-not-answering' });
  await assert.rejects(health(state));

  // Repair brings the dead one back from the unit's own file and keeps its drop-ins (phone flags, the GitHub token).
  await mode('');
  await mkdir(unit + '.d');
  await writeFile(path.join(unit + '.d', 'phone.conf'), '[Service]\nEnvironment=P9_REMOTE=1\n');
  await writeFile(path.join(home, 'systemctl.log'), '');
  assert.deepEqual(await repairLinuxService(state), { restarted: true });
  assert.notEqual((await health(state)).boot.pid, second.pid);
  assert.deepEqual((await readFile(path.join(home, 'systemctl.log'), 'utf8')).trim().split('\n'),
    ['cat p9-foundation.service', 'daemon-reload', 'reset-failed p9-foundation.service', 'enable p9-foundation.service', 'restart p9-foundation.service']);
  assert.equal(await readFile(path.join(unit + '.d', 'phone.conf'), 'utf8'), '[Service]\nEnvironment=P9_REMOTE=1\n');

  // No unit: nothing is restarted or installed; the answer says how to install it.
  await rename(unit, unit + '.away');
  const running = (await health(state)).boot;
  assert.deepEqual(await restartLinuxService(state), { error: 'service-missing' });
  assert.equal((await repairLinuxService(state)).error, 'service-missing');
  assert.deepEqual((await health(state)).boot, running);
  await rename(unit + '.away', unit);
});

test('The Windows repair runs with only the environment install-windows.ps1 needs (BL8)', () => {
  const env = repairEnv({ ANTHROPIC_API_KEY: 'sk-ant', OPENAI_API_KEY: 'sk-oa', GITHUB_TOKEN: 'ghp', P9_GITHUB_TOKEN: 'ghp', NODE_OPTIONS: '--require x',
    Path: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows', APPDATA: 'A', LOCALAPPDATA: 'L', TEMP: 'T', USERPROFILE: 'U',
    PROCESSOR_ARCHITECTURE: 'ARM64', SystemDrive: 'C:', ProgramFiles: 'C:\\Program Files', USERDOMAIN: 'D', HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\u' });
  assert.deepEqual(Object.keys(env).sort(), ['APPDATA', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PROCESSOR_ARCHITECTURE', 'Path', 'ProgramFiles',
    'SystemDrive', 'SystemRoot', 'TEMP', 'USERDOMAIN', 'USERPROFILE']);
  assert.equal(env.PROCESSOR_ARCHITECTURE, 'ARM64');
});

test('Updates row: one line and one button per updater state; no updater, no row', async () => {
  globalThis.window = { p9: { version: '0.1.5' } };
  const { maintenanceGroup } = await import('../apps/web/src/maintenance.mjs');
  assert.doesNotMatch(maintenanceGroup(null), /mtUpd/);
  const row = (u) => {
    const html = maintenanceGroup(u);
    return [/id="mtUpdText">([^<]*)</.exec(html)[1], /<button[^>]*id="(mtUpd\w+)"( disabled)?/.exec(html).slice(1, 3).join('')];
  };
  assert.deepEqual(row({ state: 'off', current: '0.1.5', reason: 'source checkout' }), ['You have P9 0.1.5. Automatic updates are off: source checkout.', 'mtUpdCheck disabled']);
  assert.deepEqual(row({ state: 'idle', current: '0.1.5', available: null }), ['You have P9 0.1.5. You have the newest P9.', 'mtUpdCheck']);
  assert.deepEqual(row({ state: 'checking', current: '0.1.5' }), ['You have P9 0.1.5. Checking for a newer P9…', 'mtUpdCheck disabled']);
  assert.deepEqual(row({ state: 'downloading', current: '0.1.5', available: '0.1.6' }), ['You have P9 0.1.5. Downloading P9 0.1.6…', 'mtUpdCheck disabled']);
  assert.deepEqual(row({ state: 'ready', current: '0.1.5', available: '0.1.6' }), ['You have P9 0.1.5. P9 0.1.6 is downloaded. Restart P9 to update.', 'mtUpdInstall']);
  assert.deepEqual(row({ state: 'error', current: '0.1.5', reason: 'offline' }), ['You have P9 0.1.5. The last check failed: offline.', 'mtUpdCheck']);
  assert.match(maintenanceGroup({ state: 'idle', current: '<b>' }), /You have P9 &lt;b&gt;\./, 'escaped');
  delete globalThis.window;
});

test('Updates off: the one Updates row is in Maintenance, and its Check now opens the newest release', async () => {
  globalThis.window = { p9: { version: '0.1.5', openUpdates: () => {} } };
  const { maintenanceGroup } = await import('../apps/web/src/maintenance.mjs');
  // A source checkout's updater says off; a build with no updater gives null. Both get the row that opens the releases page.
  for (const u of [{ state: 'off', current: '0.1.5', reason: 'source checkout' }, null]) {
    const html = maintenanceGroup(u);
    assert.equal(html.match(/<strong>Updates<\/strong>/g)?.length, 1, JSON.stringify(u));
    assert.match(html, /<button[^>]*id="mtUpdOpen">Check now<\/button>/);
    assert.doesNotMatch(html, /mtUpdCheck/);
    assert.match(/id="mtUpdText">([^<]*)</.exec(html)[1], /^You have P9 0\.1\.5\. Automatic updates are off(: source checkout)?\. Check now opens GitHub&#39;s newest release in your browser; if its number is higher, /);
  }
  assert.match(maintenanceGroup({ state: 'idle', current: '0.1.5' }), /id="mtUpdCheck" *>Check now/, 'an updater that is on checks for itself');
  delete globalThis.window;
});
