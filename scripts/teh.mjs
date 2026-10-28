import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { connect } from 'node:net';
import { appendFile, chmod, copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { execFile, execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { ORIGIN } from '../packages/protocol/index.mjs';
import { windowsLockEndpoint, windowsStateRoot } from '../apps/server/windows.mjs';
import { childEnv } from '../apps/server/child-env.mjs';
import { found, placeTmux } from '../apps/server/deps.mjs';

// One version, package.json's (release r2 R2-9).
const VERSION = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;

export async function health(state) {
  const credentials = JSON.parse(await readFile(path.join(state, 'desktop.json'), 'utf8'));
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: credentials.socketPath ?? path.join(state, 'daemon.sock'), path: '/health',
      headers: { host: 'p9.local', origin: ORIGIN, cookie: `p9=${credentials.cookie}` }, timeout: 2000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => res.statusCode === 200 ? resolve(JSON.parse(body)) : reject(new Error('unhealthy')));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

// A request that starts an agent waits for it: the daemon allows 45 s for the start (chat.mjs START_MS), then up to 5 s each for the
// mode, model and up to 6 effort settings. Everything else keeps the 10 s default.
export const AGENT_START_MS = 90_000;
// One authenticated request to the daemon over its Unix socket; resolves { status, body }.
export async function daemonRequest(state, method, route, body, op = randomUUID(), timeout = 10000) {
  const credentials = JSON.parse(await readFile(path.join(state, 'desktop.json'), 'utf8'));
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: credentials.socketPath ?? path.join(state, 'daemon.sock'), path: route, method, timeout,
      headers: { host: 'p9.local', origin: ORIGIN, cookie: `p9=${credentials.cookie}`, 'x-p9-csrf': credentials.csrf,
        ...(method === 'GET' ? {} : { 'x-p9-op': op }), ...(data ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(text) }); } catch { reject(Object.assign(new Error('bad-response'), { status: res.statusCode })); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end(data);
  });
}

// D16: a daemon older than the app answers a route it lacks with a plain-text 404: that is not "not answering", and
// retrying never helps, so the page is told the daemon is out of date.
export const failedReply = (error) => error?.status === 404 ? { status: 404, body: { error: 'daemon-outdated' } } : { status: 503, body: { error: 'daemon-unavailable' } };

export function collectBundle({ status, journal, daemon }) {
  const allowed = new Set(['P9_READY', 'P9_START_FAILED']);
  return {
    version: VERSION, node: process.versions.node, platform: process.platform,
    daemon: daemon?.status === 'ok' ? { status: 'ok', phase: 3, writes: daemon.writes === 'guarded' ? 'guarded' : 'unavailable',
      recoveryRecordCount: Number.isSafeInteger(daemon.recoveryRecordCount) && daemon.recoveryRecordCount >= 0
        ? daemon.recoveryRecordCount : null } : { status: 'unavailable' },
    unit: Object.fromEntries(status.split('\n').filter((line) => /^(?:ActiveState|SubState|Result)=[a-z-]+$/.test(line))
      .map((line) => line.split('='))),
    logs: journal.split('\n').flatMap((line) => {
      try {
        const record = JSON.parse(line);
        if (record.MESSAGE) {
          try {
            const event = JSON.parse(record.MESSAGE);
            if (event.event === 'P9_DRAFT_RETAINED') return [{ event: 'P9_DRAFT_RETAINED' }];
            if (event.event === 'P9_REQUEST_FAILED' && ['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EDQUOT', 'EIO', 'INTERNAL_FAILURE'].includes(event.code)) {
              return [{ event: event.event, code: event.code }];
            }
          } catch {}
        }
        return allowed.has(record.MESSAGE) ? [{ event: record.MESSAGE }] : [];
      } catch { return []; }
    }),
  };
}

function command(command, args) {
  try { return execFileSync(command, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return ''; }
}

// The 'P9 Foundation' task: { state, execute, arguments }, or null when there is none. execute is conhost.exe for this
// version's task and powershell.exe for v0.1.1's visible one (issue #6). The desktop app uses it to say which (B3).
export function windowsTask() {
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve) => execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    "$t = Get-ScheduledTask -TaskName 'P9 Foundation' -ErrorAction SilentlyContinue; if ($t) { @{ state = [string]$t.State; "
    + "execute = $t.Actions[0].Execute; arguments = $t.Actions[0].Arguments } | ConvertTo-Json -Compress } else { 'null' }"],
  { encoding: 'utf8', timeout: 15000, windowsHide: true }, (error, stdout) => { try { resolve(error ? null : JSON.parse(stdout)); } catch { resolve(null); } }));
}

// Registers the task again with the installer's own script and command line (installer.nsh): no -Workspace, so it keeps
// the old task's workspace or makes %USERPROFILE%\P9; no admin, so no UAC prompt. It also starts the daemon. Its output
// is added to service-install.log beside the app's exe, where the installer writes. resources: the app's resources folder.
// workspace: Setup's Change the folder (threat model row 32) passes the new folder, the one thing the new task differs in.
// BL8: the script gets the allowlist every P9 child gets (child-env.mjs) and the few more Windows names it or its task
// cmdlets read, never the app's whole environment.
const REPAIR_EXTRA = ['PROCESSOR_ARCHITECTURE', 'SystemDrive', 'ProgramFiles', 'USERDOMAIN', 'HOMEDRIVE', 'HOMEPATH'];
export const repairEnv = (source = process.env) => ({ ...childEnv(source, 'win32'),
  ...Object.fromEntries(Object.entries(source).filter(([key]) => REPAIR_EXTRA.some((name) => name.toLowerCase() === key.toLowerCase()))) });
export function repairWindowsTask(resources, workspace) {
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve) => execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(resources, 'daemon', 'scripts', 'install-windows.ps1'), '-Node', path.join(resources, 'daemon', 'node.exe'),
    ...(workspace ? ['-Workspace', workspace] : [])],
  { encoding: 'utf8', timeout: 120000, windowsHide: true, env: repairEnv() }, (error, stdout, stderr) =>
    writeFile(path.join(resources, '..', 'service-install.log'), `\r\n# ${workspace ? 'workspace change' : 'repair'} by the app ${new Date().toISOString()}: ${error ? 'failed' : 'ok'}\r\n${stdout}${stderr}`, { flag: 'a' })
      .catch(() => {}).then(() => resolve(!error))));
}

// AU4 (Linux AppImage): the daemon cannot run from the AppImage's mount, which goes away when the app quits. Each version is
// copied to <share>/daemon/<version> (.complete written last), daemon/current names the one launcher/p9-launch.sh starts,
// and when current changes only it and the one it replaced are kept (a rollback goes back to that). source: the
// resources/daemon folder. Returns { version, previous }. The launcher is copied as is the first time; after that as
// p9-launch.sh.next, which the app promotes after a healthy start (AU5, apps/desktop/rollback.mjs promoteLauncher).
export async function stageDaemon(source, share) {
  const version = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8')).version;
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('version-unreadable');
  const daemons = path.join(share, 'daemon'), target = path.join(daemons, version), current = path.join(daemons, 'current');
  await mkdir(daemons, { recursive: true, mode: 0o700 });
  if (!await stat(path.join(target, '.complete')).catch(() => null)) {
    for (const folder of [target + '.tmp', target]) await rm(folder, { recursive: true, force: true });
    await cp(source, target + '.tmp', { recursive: true });
    await writeFile(path.join(target + '.tmp', '.complete'), '');
    await rename(target + '.tmp', target);
  }
  const first = path.join(share, 'launcher', 'p9-launch.sh');
  const launcher = await stat(first).then(() => first + '.next', () => first);
  await mkdir(path.dirname(first), { recursive: true, mode: 0o700 });
  await copyFile(path.join(target, 'scripts', 'launcher', 'p9-launch.sh'), launcher + '.tmp');
  await chmod(launcher + '.tmp', 0o755);
  await rename(launcher + '.tmp', launcher);
  const previous = (await readFile(current, 'utf8').catch(() => '')).trim();
  await writeFile(current + '.tmp', version);
  await rename(current + '.tmp', current);
  // A second start of the same version keeps the one before it.
  if (previous !== version) for (const name of await readdir(daemons)) {
    if (![version, previous, 'current'].includes(name)) await rm(path.join(daemons, name), { recursive: true, force: true }).catch(() => {});
  }
  return { version, previous };
}

// The AppImage's start: copies its daemon (stageDaemon), then installs the p9-foundation unit with ~/P9 as the workspace
// if there is none, or restarts a launcher unit onto a new version. A unit without the launcher is a source checkout's,
// never touched. Output goes to ~/.local/share/p9/service-install.log, as Windows writes service-install.log.
// ponytail: tmux missing means no unit (install-service.mjs refuses); the log says so, the page says daemon-unreachable.
// AU5: the AppImage itself is kept as appimage/<version>.AppImage, with the one before it, for a rollback (p9-launch.sh).
export async function appImageService(resources, image = process.env.APPIMAGE) {
  const share = path.join(os.homedir(), '.local', 'share', 'p9'), log = path.join(share, 'service-install.log');
  const say = (text) => appendFile(log, new Date().toISOString() + ' ' + text + '\n').catch(() => {});
  try {
    const { version, previous } = await stageDaemon(path.join(resources, 'daemon'), share);
    const unit = await readFile(path.join(os.homedir(), '.config', 'systemd', 'user', 'p9-foundation.service'), 'utf8').catch(() => null);
    const dir = path.join(share, 'daemon', version);
    // The AppImage's own folders on PATH are gone once it quits; the unit keeps the rest (install-service.mjs).
    const env = { ...process.env, PATH: (process.env.PATH ?? '').split(':').filter((entry) => !process.env.APPDIR || !entry.startsWith(process.env.APPDIR)).join(':') };
    const run = (file, args) => new Promise((resolve) => execFile(file, args, { env, timeout: 60_000 }, (error, stdout, stderr) =>
      say(path.basename(file) + ' ' + path.basename(args[0]) + ': ' + (error ? 'failed ' : 'ok ') + stdout + stderr).then(() => resolve(!error))));
    await say('daemon ' + version + ', before it ' + (previous || 'none'));
    // K7: the daemon cannot start without tmux. A system tmux wins; with none, the AppImage's pinned copy goes into P9's
    // bin folder first (before the slow copy below and the service), so a machine with no tmux needs no admin password and no network.
    if (!await found('tmux', { env })) await say('tmux from the AppImage: ' + await placeTmux({ from: path.join(resources, 'tmux', 'tmux') }));
    // A copy that fails (a full disk) costs the rollback only; the service below goes on.
    try {
      const kept = path.join(share, 'appimage'), copy = path.join(kept, version + '.AppImage');
      await mkdir(kept, { recursive: true, mode: 0o700 });
      if (!await stat(copy).catch(() => null)) {
        await copyFile(image, copy + '.tmp');
        await chmod(copy + '.tmp', 0o755);
        await rename(copy + '.tmp', copy);
        await say('kept ' + copy);
      }
      if (previous !== version) for (const name of await readdir(kept)) {
        if (![version, previous].map((each) => each + '.AppImage').includes(name)) await rm(path.join(kept, name), { force: true }).catch(() => {});
      }
    } catch (error) { await say('the AppImage was not kept: ' + error.message); }
    if (unit === null) {
      const workspace = path.join(os.homedir(), 'P9');
      await mkdir(workspace, { recursive: true });
      return await run(path.join(dir, 'node'), [path.join(dir, 'scripts', 'install-service.mjs'), workspace]);
    }
    if (!unit.includes(path.join(share, 'launcher', 'p9-launch.sh'))) return await say("a source checkout's unit; left as it is");
    if (previous !== version) return await run('systemctl', ['--user', 'restart', 'p9-foundation.service']);
  } catch (error) { await say('failed: ' + error.message); }
}

// RS1: a restart is done when /health answers with a boot other than the one before it (the old daemon's, or none when it
// was not answering); a service that started but never answers is reported, not called restarted. Up to 90 s, the most a
// first start has taken on CI (Wait-Daemon). Resolves { restarted: true } or { error }.
// probe: how /health is asked; Server mode passes its own, which re-reads the restarted server's credentials (remote.mjs).
export async function answered(state, before, ms = 90_000, probe = health) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 500))) {
    const boot = await probe(state).then((h) => h.boot, () => null);
    if (boot && (boot.pid !== before?.pid || boot.started !== before?.started)) return { restarted: true };
  }
  return { error: 'daemon-not-answering' };
}

// Restarts the 'P9 Foundation' task (W3): /End stops its conhost, the host sees its parent gone and closes the job, which
// ends node.exe. The daemon's lock pipe (main.mjs) is waited out, up to 15 s, so the next start does not hit
// daemon-already-running: the API pipe can close before the lock does. Call it from outside the daemon's job (the desktop
// app), never from the daemon. state: the runtime folder.
export async function restartWindowsTask(state, ms) {
  const schtasks = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'schtasks.exe');
  const run = (args) => new Promise((resolve) => execFile(schtasks, args, { timeout: 30000, windowsHide: true }, (error) => resolve(!error)));
  const before = await health(state).then((h) => h.boot, () => null);
  await run(['/End', '/TN', 'P9 Foundation']);
  const lock = windowsLockEndpoint(windowsStateRoot());
  for (let tries = 0; ; tries++) {
    const gone = await new Promise((resolve) => {
      const socket = connect(lock);
      socket.once('connect', () => { socket.destroy(); resolve(false); });
      socket.once('error', (error) => resolve(error.code === 'ENOENT'));
    });
    if (gone) break;
    if (tries === 60) return { error: 'daemon-did-not-stop' };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!await run(['/Run', '/TN', 'P9 Foundation'])) return { error: 'restart-failed' };
  return answered(state, before, ms);
}

// The same on Linux: the p9-foundation user unit, restarted by systemd. No unit means there is nothing to restart
// (install-service.mjs makes one). Resolves { restarted: true } or { error }.
// The unit is named after its RuntimeDirectory, the state folder: p9-foundation, or the dev build's p9-dev beside it.
export const unitFor = (state) => (/^p9-[a-z-]+$/.test(path.basename(String(state))) ? path.basename(String(state)) : 'p9-foundation') + '.service';
const systemctl = (...args) => new Promise((resolve) => execFile('systemctl', ['--user', ...args], { timeout: 60_000 }, (error) => resolve(!error)));
export async function restartLinuxService(state, ms) {
  if (!await systemctl('cat', unitFor(state))) return { error: 'service-missing' };
  const before = await health(state).then((h) => h.boot, () => null);
  if (!await systemctl('restart', unitFor(state))) return { error: 'restart-failed' };
  return answered(state, before, ms);
}

// Repair on Linux (MT1): the unit enabled and started again from its own file (daemon-reload, and reset-failed after a crash
// loop), so its drop-ins (phone flags, the GitHub token) stay. No unit: the installer's command, since a daemon this page talks
// to without a unit was started by hand and holds the lock a new unit would need.
export async function repairLinuxService(state, ms) {
  if (!await systemctl('cat', unitFor(state))) return { error: 'service-missing', detail: 'run node scripts/install-service.mjs <workspace folder>' };
  const before = await health(state).then((h) => h.boot, () => null);
  for (const args of [['daemon-reload'], ['reset-failed', unitFor(state)], ['enable', unitFor(state)]]) await systemctl(...args);
  if (!await systemctl('restart', unitFor(state))) return { error: 'repair-failed' };
  return answered(state, before, ms);
}

// Windows has no unit or journal: the task stands in for the unit (SubState conhost is this version's task, powershell
// v0.1.1's) and the last 100 lines of daemon.log for the journal (issue #6 B4).
export function windowsSources(task, log) {
  return { status: 'ActiveState=' + (task ? String(task.state).toLowerCase() : 'missing')
      + '\nSubState=' + (task ? path.win32.basename(String(task.execute), '.exe').toLowerCase() : 'missing'),
    journal: log.split(/\r?\n/).filter(Boolean).slice(-100).map((line) => JSON.stringify({ MESSAGE: line })).join('\n') };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    state: { type: 'string' }, bundle: { type: 'string' },
  } });
  if (positionals[0] === 'devices' && values.state) {
    // teh devices [approve|refuse <enrollment id> | lock|revoke <device id> | reset]: the desktop side of phone enrollment.
    const [, action, id] = positionals;
    const route = !action ? null : action === 'reset' ? '/devices/reset'
      : ['approve', 'refuse'].includes(action) && id ? `/devices/enrollments/${encodeURIComponent(id)}/${action}`
      : ['lock', 'revoke'].includes(action) && id ? `/devices/${encodeURIComponent(id)}/${action}` : undefined;
    if (route === undefined) throw new Error('use-devices-[approve|refuse|lock|revoke <id>|reset]');
    const result = route ? await daemonRequest(values.state, 'POST', route, {}) : await daemonRequest(values.state, 'GET', '/devices');
    process.stdout.write(JSON.stringify(result.body, null, 2) + '\n');
    if (result.status !== 200) process.exitCode = 1;
  } else {
  if (positionals.join(' ') !== 'doctor' || !values.state) throw new Error('use-doctor-or-devices-with-state');
  const daemon = await health(values.state).catch(() => ({ status: 'unavailable' }));
  // daemon.log sits next to the runtime folder (install-windows.ps1).
  const bundle = collectBundle({ daemon, ...(process.platform === 'win32' ? windowsSources(await windowsTask(),
    await readFile(path.join(values.state, '..', 'daemon.log'), 'utf8').catch(() => '')) : {
    status: command('systemctl', ['--user', 'show', 'p9-foundation.service', '--property=ActiveState,SubState,Result']),
    journal: command('journalctl', ['--user', '-u', 'p9-foundation.service', '-n', '100', '-o', 'json', '--no-pager']),
  }) });
  const text = JSON.stringify(bundle, null, 2) + '\n';
  if (values.bundle) await writeFile(values.bundle, text, { flag: 'wx', mode: 0o600 });
  else process.stdout.write(text);
  if (daemon.status !== 'ok') process.exitCode = 1;
  }
}
