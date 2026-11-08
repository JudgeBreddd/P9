// Settings → Maintenance (MT1) below the page: Restart and Repair on Linux (RS1: done only when a new daemon answers; RS2: a
// hung one killed after the grace), the
// environment the Windows repair runs with (BL8), and the Updates row against a stand-in updater (the A ↔ B1 shape).
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { root } from './helpers.mjs';
import { health, restartLinuxService, repairLinuxService, repairEnv, unitFor, windowsTask, repairWindowsTask, restartWindowsTask } from '../scripts/teh.mjs';
import { unitOf, windowsTaskName } from '../apps/server/windows.mjs';

// Restart and Repair act on the unit that owns the window's state folder: a dev window (p9-dev) never restarts the daily daemon.
test('the unit is named after the state folder', () => {
  assert.equal(unitFor('/run/user/1000/p9-dev'), 'p9-dev.service');
  assert.equal(unitFor('/run/user/1000/p9-foundation'), 'p9-foundation.service');
  assert.equal(unitFor('/tmp/fixture/state'), 'p9-foundation.service');
  assert.equal(unitFor('/tmp/p9-Dev;rm'), 'p9-foundation.service');
});

// A stand-in systemctl that runs the unit's ExecStart for real and never touches the machine's own user units. Every call
// is logged. $HOME/restart-mode: "nothing" is a restart that leaves the old daemon running, "dead" one that starts nothing.
// As in systemd, a restart is a job of the manager (here a detached process), so a client killed meanwhile leaves it
// running; its stop sends SIGTERM and SIGKILLs only after $HOME/stop-timeout seconds (TimeoutStopSec; 10 unless named).
const SYSTEMCTL = String.raw`
import { appendFileSync, existsSync, readFileSync, writeFileSync, rmSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
const [, , , command, ...rest] = process.argv, unit = rest.at(-1), pid = path.join(process.env.HOME, 'p9-foundation.service.pid');
const file = path.join(process.env.HOME, '.config/systemd/user/p9-foundation.service');
if (command !== 'job') appendFileSync(path.join(process.env.HOME, 'systemctl.log'), [command, ...rest].join(' ') + '\n');
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
    const limit = path.join(process.env.HOME, 'stop-timeout'), timeout = existsSync(limit) ? Number(readFileSync(limit, 'utf8')) : 10;
    const id = Number(readFileSync(pid, 'utf8')), end = Date.now() + timeout * 1000;
    process.kill(id);
    while (true) { try { process.kill(id, Date.now() > end ? 'SIGKILL' : 0); } catch { break; } Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); }
  } catch {}
  // RuntimeDirectory=: systemd removes the daemon's state folder when the unit stops.
  rmSync(pid, { force: true }); rmSync(path.join(process.env.XDG_RUNTIME_DIR, 'p9-foundation'), { recursive: true, force: true });
};
if (command === 'cat') process.exit(existsSync(file) ? 0 : 1);
if (command === 'enable' && rest.includes('--now')) start();
if (command === 'disable') stop();
if (command === 'show') process.stdout.write((existsSync(pid) ? readFileSync(pid, 'utf8') : '0') + '\n');
if (command === 'kill' && rest.includes('--kill-who=main') && rest.includes('--signal=SIGKILL')) try { process.kill(Number(readFileSync(pid, 'utf8')), 'SIGKILL'); } catch {}
if (command === 'job') { stop(); if (mode !== 'dead') start(); }
if (command === 'restart' && mode !== 'nothing') spawn(process.execPath, [process.argv[1], '--user', 'job', unit], { detached: true, stdio: 'ignore' }).on('exit', (code) => process.exit(code ?? 1));
`;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// A temp HOME with the stand-in systemctl first on PATH and the unit installed and running, as install-service.mjs makes it.
async function unitHome(t) {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'p9-restart-'))), bin = path.join(home, 'bin'), run = path.join(home, 'run');
  const workspace = path.join(home, 'workspace');
  for (const directory of [bin, workspace]) await mkdir(directory);
  await mkdir(run, { mode: 0o700 });
  await writeFile(path.join(bin, 'systemctl'), '#!' + process.execPath + '\n' + SYSTEMCTL);
  await chmod(path.join(bin, 'systemctl'), 0o755);
  // teh.mjs runs systemctl from this process's PATH, so the stand-in is set here, not only in a child's env.
  const saved = { HOME: process.env.HOME, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, PATH: process.env.PATH };
  Object.assign(process.env, { HOME: home, XDG_RUNTIME_DIR: run, PATH: bin + ':' + process.env.PATH });
  const installed = spawnSync(process.execPath, [path.join(root, 'scripts/install-service.mjs'), workspace], { env: process.env, encoding: 'utf8' });
  t.after(() => {
    spawnSync(path.join(bin, 'systemctl'), ['--user', 'disable', '--now', 'p9-foundation.service'], { env: process.env });
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
  assert.match(installed.stdout, /P9_SERVICE_INSTALLED/, installed.stderr);
  return { home, state: path.join(run, 'p9-foundation'), unit: path.join(home, '.config/systemd/user/p9-foundation.service'),
    mode: (value) => writeFile(path.join(home, 'restart-mode'), value) };
}

test('Restart and Repair on Linux: done only when a new daemon answers; no unit, a dead or an unchanged daemon is reported, and the unit\'s drop-ins stay', { skip: process.platform !== 'linux', timeout: 180000 }, async (t) => {
  const { home, state, unit, mode } = await unitHome(t);

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
    ['cat p9-foundation.service', 'daemon-reload', 'reset-failed p9-foundation.service', 'enable p9-foundation.service',
      'show -p MainPID --value p9-foundation.service', 'restart p9-foundation.service']);
  assert.equal(await readFile(path.join(unit + '.d', 'phone.conf'), 'utf8'), '[Service]\nEnvironment=P9_REMOTE=1\n');

  // No unit: nothing is restarted or installed; the answer says how to install it.
  await rename(unit, unit + '.away');
  const running = (await health(state)).boot;
  assert.deepEqual(await restartLinuxService(state), { error: 'service-missing' });
  assert.equal((await repairLinuxService(state)).error, 'service-missing');
  assert.deepEqual((await health(state)).boot, running);
  await rename(unit + '.away', unit);
});

// RS2: a hung daemon (SIGSTOP stands in for a busy event loop: its SIGTERM handler never runs) under systemd's 90 s stop
// timeout. Restart used to give up at 60 s while systemd still waited; now the same main process is killed after the grace,
// systemd's restart job starts the unit, and a new daemon answers. A daemon that stops within the grace is never killed.
test('Restart on Linux, a hung daemon: killed after the grace instead of waiting out systemd\'s 90 s, then a new one answers', { skip: process.platform !== 'linux', timeout: 150000 }, async (t) => {
  const { home, state } = await unitHome(t);
  await writeFile(path.join(home, 'stop-timeout'), '90');
  const hung = (await health(state)).boot.pid;
  process.kill(hung, 'SIGSTOP');
  t.after(() => { try { process.kill(hung, 'SIGKILL'); } catch {} });
  const began = Date.now();
  assert.deepEqual(await restartLinuxService(state, undefined, 2), { restarted: true });
  assert.ok(Date.now() - began < 30000, 'not left to the 90 s stop timeout: ' + (Date.now() - began) + ' ms');
  const fresh = (await health(state)).boot.pid;
  assert.notEqual(fresh, hung);
  for (const end = Date.now() + 3000; alive(hung) && Date.now() < end;) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(alive(hung), false, 'the hung daemon is gone');
  assert.match(await readFile(path.join(home, 'systemctl.log'), 'utf8'), /^kill --kill-who=main --signal=SIGKILL p9-foundation\.service$/m);

  // A daemon that answers stops within the grace: restarted, nothing killed.
  await writeFile(path.join(home, 'stop-timeout'), '10');
  await writeFile(path.join(home, 'systemctl.log'), '');
  assert.deepEqual(await restartLinuxService(state), { restarted: true });
  assert.notEqual((await health(state)).boot.pid, fresh);
  assert.doesNotMatch(await readFile(path.join(home, 'systemctl.log'), 'utf8'), /^kill /m);
});

// RS2 for Repair: the same hung daemon, and Repair restarts the unit the way Restart does, so it is killed after the grace
// too instead of Repair giving up at 60 s while systemd still waits 90 s.
test('Repair on Linux, a hung daemon: killed after the grace, then a new one answers', { skip: process.platform !== 'linux', timeout: 150000 }, async (t) => {
  const { home, state } = await unitHome(t);
  await writeFile(path.join(home, 'stop-timeout'), '90');
  const hung = (await health(state)).boot.pid;
  process.kill(hung, 'SIGSTOP');
  t.after(() => { try { process.kill(hung, 'SIGKILL'); } catch {} });
  const began = Date.now();
  assert.deepEqual(await repairLinuxService(state, undefined, 2), { restarted: true });
  assert.ok(Date.now() - began < 30000, 'not left to the 90 s stop timeout: ' + (Date.now() - began) + ' ms');
  assert.notEqual((await health(state)).boot.pid, hung);
  for (const end = Date.now() + 3000; alive(hung) && Date.now() < end;) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(alive(hung), false, 'the hung daemon is gone');
  assert.match(await readFile(path.join(home, 'systemctl.log'), 'utf8'), /^kill --kill-who=main --signal=SIGKILL p9-foundation\.service$/m);
});

// O6b + W3b: a dev P9 on Windows has its own Scheduled Task ('P9 p9-dev', %LOCALAPPDATA%\p9-dev), and everything a dev
// window does to a task (wake, Restart, Repair, Change the folder) names that one, never 'P9 Foundation'. The real
// functions run here against a stand-in powershell.exe and schtasks.exe under a temporary SystemRoot that log their
// argv; windows-installer.yaml registers both tasks on Windows. Linux-only: the stand-ins are node scripts.
test('O6b: a dev window\'s Windows task is its own: unit, task name, query, repair and restart never name P9 Foundation', { skip: process.platform === 'win32', timeout: 30000 }, async (t) => {
  assert.deepEqual(['C:\\Users\\u\\AppData\\Local\\P9\\runtime', 'C:\\Users\\u\\AppData\\Local\\p9-dev\\runtime', 'C:\\x\\P9-Dev\\runtime',
    'C:\\x\\p9-dev\\state', '/run/user/1000/p9-dev', '/run/user/1000/p9-foundation', '/tmp/x/state'].map(unitOf),
  ['p9-foundation', 'p9-dev', 'p9-foundation', 'p9-foundation', 'p9-dev', 'p9-foundation', 'p9-foundation']);
  assert.deepEqual(['p9-foundation', 'p9-dev'].map(windowsTaskName), ['P9 Foundation', 'P9 p9-dev']);
  const sys = await realpath(await mkdtemp(path.join(os.tmpdir(), 'p9-o6b-'))), log = path.join(sys, 'calls.log');
  const fake = `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify([require('node:path').basename(process.argv[1]), ...process.argv.slice(2)]) + '\\n'); process.stdout.write('null');\n`;
  await mkdir(path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0'), { recursive: true });
  for (const file of [path.join(sys, 'System32', 'schtasks.exe'), path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')]) {
    await writeFile(file, fake); await chmod(file, 0o755);
  }
  const saved = process.env.SystemRoot;
  process.env.SystemRoot = sys;
  t.after(() => { if (saved === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = saved; });
  const calls = async () => { const text = await readFile(log, 'utf8').catch(() => ''); await writeFile(log, ''); return text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); };
  // The query: the unit's task by name; the daily call unchanged; a name that is not a unit falls to the daily task, never into the command.
  for (const [unit, name] of [[undefined, 'P9 Foundation'], ['p9-dev', 'P9 p9-dev'], ["p9-dev'; Remove-Item x; '", 'P9 Foundation']]) {
    assert.equal(await windowsTask(unit), null);
    const [call] = await calls();
    assert.match(call.at(-1), new RegExp(`^\\$t = Get-ScheduledTask -TaskName '${name}' -ErrorAction SilentlyContinue;`));
  }
  // Repair and Change the folder: -Unit only for a dev unit, so the daily argv is the same as before.
  const resources = path.join(sys, 'app', 'resources');
  await mkdir(resources, { recursive: true });
  assert.equal(await repairWindowsTask(resources), true);
  assert.equal(await repairWindowsTask(resources, 'D:\\work', 'p9-dev'), true);
  const [daily, dev] = await calls();
  assert.deepEqual(daily.slice(-4), ['-File', path.join(resources, 'daemon', 'scripts', 'install-windows.ps1'), '-Node', path.join(resources, 'daemon', 'node.exe')]);
  assert.deepEqual(dev.slice(-4), ['-Workspace', 'D:\\work', '-Unit', 'p9-dev']);
  // Restart: /End and /Run on the state's own task (its lock pipe is gone here, so /Run follows at once).
  assert.deepEqual(await restartWindowsTask(path.join(sys, 'p9-dev', 'runtime'), 600), { error: 'daemon-not-answering' });
  assert.deepEqual(await calls(), [['schtasks.exe', '/End', '/TN', 'P9 p9-dev'], ['schtasks.exe', '/Run', '/TN', 'P9 p9-dev']]);
  assert.deepEqual(await restartWindowsTask(path.join(sys, 'P9', 'runtime'), 600), { error: 'daemon-not-answering' });
  assert.deepEqual(await calls(), [['schtasks.exe', '/End', '/TN', 'P9 Foundation'], ['schtasks.exe', '/Run', '/TN', 'P9 Foundation']]);
  // install-windows.ps1 (text; windows-installer.yaml runs it): -Unit checked, every task cmdlet on $taskName, a dev unit's own
  // root, --ownership only for it, and a dev install stops only its own daemon\<version>\node.exe, never the daily one.
  const ps1 = await readFile(path.join(root, 'scripts', 'install-windows.ps1'), 'utf8');
  assert.match(ps1, /\[string\]\$Unit = 'p9-foundation'\s*\)/);
  assert.match(ps1, /if \(\$Unit -cnotmatch '\^p9-\[a-z-\]\+\$'\) \{ Say \('invalid unit ' \+ \$Unit\); exit 1 \}/);
  assert.deepEqual(ps1.match(/'P9 Foundation'/g), ["'P9 Foundation'"], 'the daily name only where $taskName is chosen');
  assert.equal((ps1.match(/ScheduledTask -TaskName \$taskName/g) ?? []).length, 4, 'Get, Stop, Register and Start name $taskName');
  assert.match(ps1, /\$root = Join-Path \$env:LOCALAPPDATA \$\(if \(\$dev\) \{ \$Unit \} else \{ 'P9' \}\)/);
  assert.match(ps1, /Where-Object \{ \(-not \$dev -and \$_\.ExecutablePath -eq \$bundled\) -or \$_\.ExecutablePath -like \(\$daemons \+ '\\\*\\node\.exe'\) \}/);
  assert.match(ps1, /\$argv = @\(\$Node, \$Server, '--workspace', \$Workspace, '--state', \$state, '--recovery', \$recovery, '--settings', \$Settings\)\n[^\n]*\nif \(\$dev\) \{ \$argv \+= @\('--ownership', \$root\) \}\n\$payloadJson = @\{ argv = \$argv;/);
  // The desktop (text: these run only on win32): wake names the unit's task and repairs only the daily one; Restart, Repair and
  // Change the folder refuse a dev window whose task is missing before any dialog, and pass the unit on.
  const main = await readFile(path.join(root, 'apps', 'desktop', 'main.mjs'), 'utf8');
  const wake = main.slice(main.indexOf('const wake = async'), main.indexOf('// AU4: the AppImage'));
  assert.match(wake, /const unit = unitOf\(localState\), task = await windowsTask\(unit\);[^]*&& !repaired && unit === 'p9-foundation'\) \{[^]*\['\/Run', '\/TN', windowsTaskName\(unit\)\]/);
  const service = main.slice(main.indexOf('const service = repair =>'), main.indexOf("ipcMain.handle('p9:restart-service'"));
  assert.match(service, /const unit = win && !serverHost \? unitOf\(state\) : 'p9-foundation';\s*if \(unit !== 'p9-foundation' && !await windowsTask\(unit\)\) return \{ error: 'dev-task-missing' \};[^]*showMessageBox[^]*restartWindowsTask\(state\)[^]*repairWindowsTask\(process\.resourcesPath, undefined, unit\)/);
  const change = main.slice(main.indexOf("ipcMain.handle('p9:workspace-change'"), main.indexOf("ipcMain.handle('p9:pet-remove'"));
  assert.match(change, /const task = win \? unitOf\(state\) : 'p9-foundation';\s*if \(task !== 'p9-foundation' && !await windowsTask\(task\)\) return \{ error: 'dev-task-missing', workspace: old \};[^]*showOpenDialog/);
  assert.match(await readFile(path.join(root, 'apps', 'web', 'src', 'settings-view.mjs'), 'utf8'), /'dev-task-missing': \["This window runs on a second \(dev\) P9/);
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
  // O2: the Nightly switch shows its saved state where updates are on, and is not offered where they are off.
  assert.match(maintenanceGroup({ state: 'idle', current: '0.1.5', nightly: true }), /<input type="checkbox" id="mtUpdNightly" checked>/);
  assert.match(maintenanceGroup({ state: 'ready', current: '0.1.5', nightly: false }), /<input type="checkbox" id="mtUpdNightly" >/);
  assert.doesNotMatch(maintenanceGroup({ state: 'off', current: '0.1.5', reason: 'source checkout' }), /mtUpdNightly/);
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
