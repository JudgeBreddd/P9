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
import { unitOf, windowsLockEndpoint, windowsStateRoot, windowsTaskName } from '../apps/server/windows.mjs';
import { childEnv } from '../apps/server/child-env.mjs';
import { found, placeTmux } from '../apps/server/deps.mjs';

// One version, package.json's (release r2 R2-9).
const VERSION = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;

// desktop.json per state folder, read once and kept (review item 27: every request read it). Read again when the daemon refuses
// the cookie (401) or nothing is at the socket: a restarted daemon writes new credentials and may have a new socket.
const known = new Map();
const again = (error) => error?.status === 401 || error?.code === 'ECONNREFUSED' || error?.code === 'ENOENT';
async function withCredentials(state, send) {
  const cached = known.get(state);
  if (cached) { try { return await send(cached); } catch (error) { if (!again(error)) throw error; } }
  const credentials = JSON.parse(await readFile(path.join(state, 'desktop.json'), 'utf8'));
  known.set(state, credentials);
  return send(credentials);
}

// timeout: 2 s on this machine; a remote's check passes more (O248: a busy slow link answers later, and is not down).
export const health = (state, timeout = 2000) => withCredentials(state, (credentials) => new Promise((resolve, reject) => {
    const req = request({ socketPath: credentials.socketPath ?? path.join(state, 'daemon.sock'), path: '/health',
      headers: { host: 'p9.local', origin: ORIGIN, cookie: `p9=${credentials.cookie}` }, timeout }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => res.statusCode === 200 ? resolve(JSON.parse(body)) : reject(Object.assign(new Error('unhealthy'), { status: res.statusCode })));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  }));

// A request that starts an agent waits for it: the daemon allows 45 s for the start (chat.mjs START_MS), then up to 5 s each for the
// mode, model and up to 6 effort settings. Everything else keeps the 10 s default.
export const AGENT_START_MS = 90_000;
// One authenticated request to the daemon over its Unix socket; resolves { status, body }.
// A 401 is not a result: the request was refused before it did anything, so it is sent again with desktop.json read again.
export async function daemonRequest(state, method, route, body, op = randomUUID(), timeout = 10000) {
  const data = body === undefined ? undefined : JSON.stringify(body);
  return withCredentials(state, (credentials) => new Promise((resolve, reject) => {
    const req = request({ socketPath: credentials.socketPath ?? path.join(state, 'daemon.sock'), path: route, method, timeout,
      headers: { host: 'p9.local', origin: ORIGIN, cookie: `p9=${credentials.cookie}`, 'x-p9-csrf': credentials.csrf,
        ...(method === 'GET' ? {} : { 'x-p9-op': op }), ...(data ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      // O251: a link that drops mid-body (a remote's ssh, a sleep) is an error, not a promise left waiting forever.
      res.on('close', () => { if (!res.complete) reject(Object.assign(new Error('dropped'), { status: res.statusCode })); });
      res.on('end', () => {
        if (res.statusCode === 401) return reject(Object.assign(new Error('unauthorized'), { status: 401, reply: text }));
        try { resolve({ status: res.statusCode, body: JSON.parse(text) }); } catch { reject(Object.assign(new Error('bad-response'), { status: res.statusCode })); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end(data);
  })).catch((error) => {
    // Still refused with desktop.json just read: the 401 as it was before the cache, a reply and not an error.
    if (error?.status === 401 && error.reply !== undefined) { try { return { status: 401, body: JSON.parse(error.reply) }; } catch { throw Object.assign(new Error('bad-response'), { status: 401 }); } }
    throw error;
  });
}

// D16: a daemon older than the app answers a route it lacks with a plain-text 404: that is not "not answering", and
// retrying never helps, so the page is told the daemon is out of date.
export const failedReply = (error) => error?.status === 404 ? { status: 404, body: { error: 'daemon-outdated' } } : { status: 503, body: { error: 'daemon-unavailable' } };

// O22: the bundled daemon node links libatomic.so.1, which a minimal or server Ubuntu lacks (the desktop has it). The
// loader's own error names the file; this turns it into the package to install, or null. Only names matching lib*.so*
// come back, so the value is safe for the doctor bundle and the window.
const LIBRARY_PACKAGES = { 'libatomic.so.1': 'libatomic1' };
export function missingLibrary(text) {
  const file = /error while loading shared libraries: (lib[\w+-]+\.so[\w.]*)/.exec(text ?? '')?.[1];
  return file ? LIBRARY_PACKAGES[file] ?? file : null;
}

// O72: some chats' Claude engines hold one inotify watch per folder under the chat's git root (O46: about 5,400 in a
// large workspace), so on a machine with a small limit (8,192 on some setups) two chats use it up and other programs
// that watch files fail with "no space left". Linux only; the file is a parameter so a test can stand one in.
export const WATCH_LIMIT_MIN = 65536;
export async function watchLimit(platform = process.platform, file = '/proc/sys/fs/inotify/max_user_watches') {
  if (platform !== 'linux') return null;
  const limit = Number.parseInt(await readFile(file, 'utf8').catch(() => ''), 10);
  if (!Number.isSafeInteger(limit)) return null;
  return { limit, warning: limit < WATCH_LIMIT_MIN ? `inotify watch limit ${limit} is below ${WATCH_LIMIT_MIN}: each chat can hold about `
    + `5,400 watches, so a few chats can use it up. Raise it: echo fs.inotify.max_user_watches=524288 | sudo tee `
    + `/etc/sysctl.d/60-p9-watches.conf && sudo sysctl --system` : null };
}

// install: the Linux service-install.log (appImageService), read only for a missing library.
export function collectBundle({ status, journal, daemon, install = '' }) {
  const allowed = new Set(['P9_READY', 'P9_START_FAILED']);
  return {
    version: VERSION, node: process.versions.node, platform: process.platform, missingLibrary: daemon?.status === 'ok' ? null : missingLibrary(install), // the log is cumulative: a daemon that answers has its libraries
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
// unit (O6b): a dev P9's own task, 'P9 p9-dev'; the name is fixed by windowsTaskName, never the caller's text.
export function windowsTask(unit = 'p9-foundation') {
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve) => execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `$t = Get-ScheduledTask -TaskName '${windowsTaskName(unitOf(unit))}' -ErrorAction SilentlyContinue; if ($t) { @{ state = [string]$t.State; `
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
// unit (O6b): a dev P9's task (install-windows.ps1 -Unit); the daily 'P9 Foundation' is not touched.
export function repairWindowsTask(resources, workspace, unit = 'p9-foundation') {
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve) => execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(resources, 'daemon', 'scripts', 'install-windows.ps1'), '-Node', path.join(resources, 'daemon', 'node.exe'),
    ...(workspace ? ['-Workspace', workspace] : []), ...(unitOf(unit) !== 'p9-foundation' ? ['-Unit', unitOf(unit)] : [])],
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
// if there is none, or restarts a launcher unit onto a new version. A unit (or drop-in) that does not run the launcher is a
// source checkout's, never touched; its command is returned as { checkout, seen } (seen: systemd's exact answer, which
// useInstalledDaemon checks again), checkout null when systemd's answer could not be read (O135). Output goes to ~/.local/share/p9/service-install.log, as Windows writes service-install.log.
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
    // O22: the staged node is run once first. A system library it cannot load (libatomic1 on a minimal Ubuntu) is named
    // here and returned, so the window says which package to install instead of "daemon unavailable".
    const missing = await new Promise((resolve) => execFile(path.join(dir, 'node'), ['--version'], { env, timeout: 30_000 },
      (error, stdout, stderr) => resolve(error ? say('node --version: failed ' + stderr.trim()).then(() => missingLibrary(stderr)) : null)));
    if (missing) { await say('missing library: ' + missing + ' (on Ubuntu: sudo apt install ' + missing + ')'); return { missing }; }
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
    // O135: a drop-in can point the service somewhere else (override.conf on the laptop, 2026-11-16, kept the source copy under
    // a launcher unit), so this reads what systemd runs, drop-ins included. Restarted only when the program it runs is the
    // launcher itself; another program (even one whose arguments name the launcher), or an answer that cannot be read
    // (systemctl failed, empty, not `path=...`), is left as it is: logged and returned, never rewritten or restarted here.
    const runs = await new Promise((resolve) => execFile('systemctl', ['--user', 'show', 'p9-foundation.service', '-p', 'ExecStart', '--value'], { env, timeout: 30_000 },
      (error, stdout) => resolve(error ? '' : stdout)));
    const program = runs.match(/\bpath=(.*?) ; argv\[\]=/)?.[1];
    if (program !== path.join(share, 'launcher', 'p9-launch.sh')) {
      const checkout = program ? (runs.match(/argv\[\]=(.*?) ; /)?.[1] ?? program).slice(0, 300) : null;
      await say(checkout ? "a source checkout's unit; left as it is: " + checkout : 'what the service runs could not be read; left as it is');
      return { checkout, ...(checkout && { seen: runs }) };
    }
    if (previous !== version) return await run('systemctl', ['--user', 'restart', 'p9-foundation.service']);
  } catch (error) { await say('failed: ' + error.message); }
}

// O135 "use the installed daemon": a service whose unit (or a drop-in) runs another copy (appImageService's { checkout }) is
// moved onto the launcher, with the user's OK (the caller's dialog; this has no caller of its own yet). seen is the ExecStart
// line (systemctl show) the user was shown; a unit changed since then, or no checkout, is refused and nothing is touched.
// The workspace and phone flags are read from the unit file's own ExecStart (the unit, then its drop-ins in name order; an
// empty ExecStart= resets; only [Service] lines, written ExecStart, with any indentation and spaces round '='; an
// ExecStart-looking line in another section, in another case, or in a file with a line continuation is refused, and every
// drop-in with an ExecStart line is moved aside), split with systemd's quoting, because systemctl show prints argv unquoted and a space in a path
// cannot be told from the next argument there. After the program the words must be flag/value pairs of the flags
// install-service writes (--workspace, --state, --recovery, --remote-port with --remote-origin), each once, and the workspace
// must appear in seen, and systemd's own FragmentPath and DropInPaths (systemctl show) must name only the unit file and drop-ins read
// here (an override in a runtime, vendor or system dir, or either property missing, is refused: its quoted workspace could
// start with a local one), NeedDaemonReload must be exactly no (disk edited since the last reload is not what runs), only
// listed files are parsed (an unlisted file with an ExecStart line is refused), and that answer must be unchanged right before
// running work is stopped (else unit-changed); anything else ($ or % in the workspace, a line continuation, an unknown flag, a lone phone flag) is
// refused as workspace-unclear, never guessed. The unit is copied to p9-foundation.service.bak-<time> and each drop-in that
// sets ExecStart is renamed <name>.bak-<time> (Environment-only drop-ins stay); the staged daemon's install-service.mjs writes
// the launcher unit with the old workspace and phone flags. A failure at any step from the backup copy on (backup-failed,
// install-failed, or a daemon that never answers with this version within ms) puts every file back, reloads, enables and
// restarts the old service. Logs to service-install.log. Returns { done, version, backup } or { error, reason?, restored, backup }.
// probe, stop and move: how /health is asked, how running work is stopped first, how a drop-in is moved (the tests pass their own).
export async function useInstalledDaemon({ checkout, seen, state, ms = 90_000, probe = () => health(state), stop = () => daemonRequest(state, 'POST', '/stop-all', {}), move = rename } = {}) {
  const share = path.join(os.homedir(), '.local', 'share', 'p9'), units = path.join(os.homedir(), '.config', 'systemd', 'user');
  const unit = path.join(units, 'p9-foundation.service'), dropins = unit + '.d';
  const say = (text) => appendFile(path.join(share, 'service-install.log'), new Date().toISOString() + ' use the installed daemon: ' + text + '\n').catch(() => {});
  const show = () => new Promise((resolve) => execFile('systemctl', ['--user', 'show', 'p9-foundation.service', '-p', 'ExecStart', '--value'], { timeout: 30_000 },
    (error, stdout) => resolve(error ? null : stdout)));
  const refuse = async (error, why) => { await say('refused, ' + error + (why ? ': ' + why : '')); return { error }; };
  if (typeof checkout !== 'string' || !checkout || typeof seen !== 'string' || !seen) return refuse('checkout-required');
  if (await show() !== seen) return refuse('unit-changed');
  const where = () => new Promise((resolve) => execFile('systemctl', ['--user', 'show', 'p9-foundation.service', '-p', 'FragmentPath', '-p', 'DropInPaths', '-p', 'NeedDaemonReload'],
    { timeout: 30_000 }, (error, stdout) => resolve(error ? '' : stdout)));
  const loaded = await where(), listed = loaded.match(/^DropInPaths=(.*)$/m)?.[1].split(' ').filter(Boolean);
  let lines = [], unclear = loaded.match(/^FragmentPath=(.*)$/m)?.[1] !== unit || !listed || !/^NeedDaemonReload=no$/m.test(loaded);
  const execDropins = [], read = [];
  for (const [file, name] of [[unit], ...(await readdir(dropins).catch(() => [])).filter((n) => n.endsWith('.conf')).sort().map((n) => [path.join(dropins, n), n])]) {
    read.push(file);
    const all = (await readFile(file, 'utf8').catch(() => '')).split('\n'), continued = all.some((line) => /\\\s*$/.test(line));
    let section = null;
    for (const line of all) {
      const header = line.match(/^\s*\[([^\]]*)\]\s*$/);
      if (header) { section = header[1]; continue; }
      if (!/^\s*execstart\s*=/i.test(line)) continue;
      if (name && !listed?.includes(file)) { unclear = true; continue; }
      const value = line.match(/^\s*ExecStart\s*=\s*(.*?)\s*$/)?.[1];
      if (value === undefined || section !== 'Service' || continued) { unclear = true; continue; }
      lines = value ? [...lines, value] : [];
      if (name && !execDropins.includes(name)) execDropins.push(name);
    }
  }
  if (listed?.some((file) => !read.includes(file))) unclear = true;
  const words = lines.length === 1 ? systemdWords(lines[0].replace(/^[-@:+!]+/, '')) : null;
  const first = words?.findIndex((word) => word.startsWith('--')) ?? -1, pairs = first < 0 ? [] : words.slice(first), flags = {};
  for (let i = 0; i + 1 < pairs.length; i += 2) flags[pairs[i]] = pairs[i] in flags ? null : pairs[i + 1];
  const workspace = flags['--workspace'], port = flags['--remote-port'], origin = flags['--remote-origin'];
  if (unclear || !words || pairs.length % 2 || Object.values(flags).includes(null) || typeof workspace !== 'string' || /[$%]/.test(workspace)
    || Object.keys(flags).some((flag) => !['--workspace', '--state', '--recovery', '--remote-port', '--remote-origin'].includes(flag))
    || (port === undefined) !== (origin === undefined) || !seen.includes(' --workspace ' + workspace + ' ')) return refuse('workspace-unclear', loaded.trim().split('\n').join('; ') || 'no answer from systemctl show');
  if (!(await stat(workspace).catch(() => null))?.isDirectory()) return refuse('workspace-unread');
  const version = (await readFile(path.join(share, 'daemon', 'current'), 'utf8').catch(() => '')).trim();
  const dir = path.join(share, 'daemon', version);
  if (!version || !await stat(path.join(dir, '.complete')).catch(() => null)) return refuse('no-installed-daemon');
  if (await where() !== loaded) return refuse('unit-changed');
  await stop().catch(() => {});
  const stamp = new Date().toISOString().replace(/[:.]/g, '-'), backup = unit + '.bak-' + stamp, moved = [];
  let copied = false, error, reason;
  try {
    await copyFile(unit, backup);
    copied = true;
    for (const name of execDropins) {
      await move(path.join(dropins, name), path.join(dropins, name + '.bak-' + stamp));
      moved.push(name);
    }
  } catch (failed) { error = 'backup-failed'; reason = failed.message; }
  if (!error) {
    await say('backup ' + backup + (moved.length ? ', drop-ins moved aside: ' + moved.join(' ') : '') + '; installing ' + version);
    const args = [path.join(dir, 'scripts', 'install-service.mjs'), workspace, ...(port === undefined ? [] : ['--remote-port', port, '--remote-origin', origin])];
    const installed = await new Promise((resolve) => execFile(path.join(dir, 'node'), args, { timeout: 120_000 },
      (failed, stdout, stderr) => say('install-service: ' + (failed ? 'failed ' : 'ok ') + (stdout + stderr).trim()).then(() => resolve(!failed))));
    let answers = false;
    for (const end = Date.now() + ms; installed && !answers && Date.now() < end; ) {
      answers = await probe().then((h) => h?.version === version, () => false);
      if (!answers) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (answers) { await say('done, the service runs ' + version); return { done: true, version, backup }; }
    error = installed ? 'version-not-answering' : 'install-failed';
  }
  const why = reason ? { reason } : {};
  try {
    if (copied) await copyFile(backup, unit);
    for (const name of moved) await rename(path.join(dropins, name + '.bak-' + stamp), path.join(dropins, name));
    for (const step of [['daemon-reload'], ['enable', 'p9-foundation.service'], ['restart', 'p9-foundation.service']]) {
      if (!await new Promise((resolve) => execFile('systemctl', ['--user', ...step], { timeout: 60_000 }, (failed) => resolve(!failed)))) throw new Error(step[0] + ' failed');
    }
    await say(error + (reason ? ' (' + reason + ')' : '') + '; the old service is back');
    return { error, ...why, restored: true, backup: copied ? backup : null };
  } catch (failed) {
    await say(error + '; putting the old service back failed: ' + failed.message + (copied ? '; the old unit is ' + backup : ''));
    return { error, ...why, restored: false, backup: copied ? backup : null };
  }
}

// One ExecStart value split into words the way systemd does: whitespace separates; a word may be "double" or 'single' quoted
// as a whole; \\ \" \' \s and \t are escapes; %% is % and $$ is $. A line continuation, an unclosed quote, a quote inside a
// word or another escape gives null (the caller refuses rather than guess). Specifiers (%t) and $VARS stay as written.
export function systemdWords(line) {
  const words = [], escapes = { '\\': '\\', '"': '"', "'": "'", s: ' ', t: '\t' };
  let i = 0;
  while (i < line.length) {
    if (/\s/.test(line[i])) { i++; continue; }
    const quote = line[i] === '"' || line[i] === "'" ? line[i++] : null;
    let word = '';
    for (;;) {
      if (i >= line.length) { if (quote) return null; break; }
      const c = line[i];
      if (quote ? c === quote : /\s/.test(c)) { if (quote && i + 1 < line.length && !/\s/.test(line[i + 1])) return null; i += quote ? 1 : 0; break; }
      if (!quote && (c === '"' || c === "'")) return null;
      if (c === '\\') { if (!(line[i + 1] in escapes)) return null; word += escapes[line[i + 1]]; i += 2; continue; }
      if ((c === '%' || c === '$') && line[i + 1] === c) { word += c; i += 2; continue; }
      word += c; i++;
    }
    words.push(word);
  }
  return words;
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
// app), never from the daemon. state: the runtime folder. O6b: the state's own task and lock, so a dev window
// (%LOCALAPPDATA%\p9-dev\runtime) restarts 'P9 p9-dev' and never the daily 'P9 Foundation'.
export async function restartWindowsTask(state, ms) {
  const unit = unitOf(state), task = windowsTaskName(unit);
  const schtasks = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'schtasks.exe');
  const run = (args) => new Promise((resolve) => execFile(schtasks, args, { timeout: 30000, windowsHide: true }, (error) => resolve(!error)));
  const before = await health(state).then((h) => h.boot, () => null);
  await run(['/End', '/TN', task]);
  const lock = windowsLockEndpoint(unit === 'p9-foundation' ? windowsStateRoot() : path.win32.dirname(state));
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
  if (!await run(['/Run', '/TN', task])) return { error: 'restart-failed' };
  return answered(state, before, ms);
}

// The same on Linux: the p9-foundation user unit, restarted by systemd. No unit means there is nothing to restart
// (install-service.mjs makes one). Resolves { restarted: true } or { error }.
// The unit is named after its RuntimeDirectory, the state folder: p9-foundation, or the dev build's p9-dev beside it.
export const unitFor = (state) => unitOf(state) + '.service';
const systemctl = (...args) => new Promise((resolve) => execFile('systemctl', ['--user', ...args], { timeout: 60_000 }, (error) => resolve(!error)));
// RS2, a hung daemon (its SIGTERM handler never runs, so main.mjs's own 10 s stop never fires): systemd would wait the unit's
// TimeoutStopSec (90 s by default) before its SIGKILL, longer than this command used to wait. sh -c this with $1 the unit and $2
// the seconds of grace: systemctl restart; still stopping after the grace, the same main process is killed (KillMode=process:
// the main process only, tmux and detached apps stay). Killing the systemctl client leaves its restart job queued in systemd,
// which starts the unit once the old process is gone. Server mode runs the same lines over ssh (remote.mjs restartServer).
export const RESTART_UNIT = 'o=$(systemctl --user show -p MainPID --value "$1"); timeout "$2" systemctl --user restart "$1"; s=$?; '
  + 'if [ "$s" = 124 ]; then s=0; [ "$(systemctl --user show -p MainPID --value "$1")" != "$o" ] || systemctl --user kill --kill-who=main --signal=SIGKILL "$1" || s=1; fi; [ "$s" = 0 ]';
export const RESTART_GRACE = 20;
// Restart and Repair both restart the unit this way (Repair after its daemon-reload, reset-failed and enable).
const restartUnit = (state, grace) => new Promise((resolve) => execFile('sh', ['-c', RESTART_UNIT, 'sh', unitFor(state), String(grace)], { timeout: (grace + 60) * 1000 }, (error) => resolve(!error)));
export async function restartLinuxService(state, ms, grace = RESTART_GRACE) {
  if (!await systemctl('cat', unitFor(state))) return { error: 'service-missing' };
  const before = await health(state).then((h) => h.boot, () => null);
  if (!await restartUnit(state, grace)) return { error: 'restart-failed' };
  return answered(state, before, ms);
}

// Repair on Linux (MT1): the unit enabled and started again from its own file (daemon-reload, and reset-failed after a crash
// loop), so its drop-ins (phone flags, the GitHub token) stay. No unit: the installer's command, since a daemon this page talks
// to without a unit was started by hand and holds the lock a new unit would need. A hung daemon is killed after the grace,
// as in Restart (RS2).
export async function repairLinuxService(state, ms, grace = RESTART_GRACE) {
  if (!await systemctl('cat', unitFor(state))) return { error: 'service-missing', detail: 'run node scripts/install-service.mjs <workspace folder>' };
  const before = await health(state).then((h) => h.boot, () => null);
  for (const args of [['daemon-reload'], ['reset-failed', unitFor(state)], ['enable', unitFor(state)]]) await systemctl(...args);
  if (!await restartUnit(state, grace)) return { error: 'repair-failed' };
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
    status: command('systemctl', ['--user', 'show', unitFor(values.state), '--property=ActiveState,SubState,Result']),
    journal: command('journalctl', ['--user', '-u', unitFor(values.state), '-n', '100', '-o', 'json', '--no-pager']),
    install: await readFile(path.join(os.homedir(), '.local', 'share', 'p9', 'service-install.log'), 'utf8').then((text) => text.slice(-4000), () => ''),
  }) });
  const watches = await watchLimit();
  if (watches) bundle.watchLimit = watches.limit;
  if (watches?.warning) process.stderr.write('warning: ' + watches.warning + '\n');
  const text = JSON.stringify(bundle, null, 2) + '\n';
  if (values.bundle) await writeFile(values.bundle, text, { flag: 'wx', mode: 0o600 });
  else process.stdout.write(text);
  if (daemon.status !== 'ok') process.exitCode = 1;
  }
}
