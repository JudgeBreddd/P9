// Dev Focus editor host: VSCodium's remote extension host (REH), started by the desktop on loopback only.
// It runs extensions, terminals and language servers as you; their direct disk writes are "runs as you, not guarded" (SECURITY.md surface 5).
import { spawn, spawnSync } from 'node:child_process';
import { appendFile, chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import { childEnv } from '../server/child-env.mjs';
import { windowsJobCommand } from '../server/process-tree.mjs';

// os.homedir(), not a named import: the server's test daemon swaps os.homedir for its fixture home (test/home-fixture.mjs).
const home = os.homedir(), win = process.platform === 'win32';
// Windows: per user under %LOCALAPPDATA%\P9 (no admin), beside the daemon's own state.
export const EDITOR_DIR = win ? path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'P9') : path.join(home, '.local', 'share', 'p9');
// The one VSCodium REH P9 is tested with (1.121.03429, README has the download and its SHA-256).
export const EDITOR_COMMIT = '824c4c46a288b839f13b24022655329c2aeb9f81';
// D5 (threat model row 52): the REH download for each Linux processor, with the SHA-256 VSCodium publishes beside it (x64's
// is the README's). P9_EDITOR_SERVER_URL/_SHA256 are for tests only; they give no more than P9_EDITOR_HOST already does.
const REH = 'https://github.com/VSCodium/vscodium/releases/download/1.121.03429/vscodium-reh-linux-';
export const EDITOR_DOWNLOADS = {
  x64: [REH + 'x64-1.121.03429.tar.gz', '9b27e6957f7cca9b52686eb9866db131e75d37d180ea5ba0f6cdf44b799f75d9'],
  arm64: [REH + 'arm64-1.121.03429.tar.gz', '30713cc768ac2727731484d6fcc93b56a1cc0a102dc4c9bc92eff1d7c4d37282'],
};
// D12 (threat model row 56): Dev Focus draws its own text, so Electron's spellchecker never sees it; an extension does the job.
// Code Spell Checker 4.10.0 from Open VSX (3.2 MB, English dictionaries inside, no network once installed). The SHA-256 is of the
// file Open VSX served on 2026-10-27 (it publishes none). P9_SPELL_URL is for tests only; it gives no more than P9_EDITOR_HOST does.
export const SPELL_CHECKER = ['https://open-vsx.org/api/streetsidesoftware/code-spell-checker/4.10.0/file/streetsidesoftware.code-spell-checker-4.10.0.vsix',
  '0b587a38c4c78887a782158f727bbdaddfab2deae3ce0d80efbab40d56475638'];
export const OPEN_LOG = win ? path.join(EDITOR_DIR, 'state', 'open-in-vscode.jsonl') : path.join(home, '.local', 'state', 'p9', 'open-in-vscode.jsonl');
const LOOPBACK = '127.0.0.1';

// ponytail: the host dies with the app (Phase 9 makes sessions persistent).
// Windows: the host runs in a Job Object made at process creation (scripts/windows-host.ps1 -Mode Job, as chats do); the
// PowerShell owner holds the only job handle, so ending it closes the handle and Windows kills the whole tree.
const windowsHosts = new Map();
// Stops the host's scope and waits; if systemd cannot stop it in time, kills everything in it, with systemd or without. Synchronous so a quit handler can use it.
// The .scope suffix matters: a bare name means name.service, which does not exist, and the stop silently does nothing.
export function stopEditorHost(unit) {
  if (win) {
    const owner = windowsHosts.get(unit);
    windowsHosts.delete(unit);
    if (!owner) return true;
    owner.kill('SIGKILL');
    // libuv's signal 0 reads the exit code, so a dead owner whose handle Node still holds reads as gone.
    // ponytail: this waits for the owner only. Windows ends the job's processes just after (measured 0-10 ms, 6 runs on
    // Windows desktop, 2026-10-17); waiting for them too would need the owner to hand back a job handle.
    for (let tries = 0; tries < 50; tries++) {
      try { process.kill(owner.pid, 0); } catch { return true; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
    console.error('p9: editor host ' + unit + ' may have survived its job owner being killed');
    return false;
  }
  const stopped = spawnSync('systemctl', ['--user', 'stop', unit + '.scope'], { stdio: 'ignore', timeout: 10000 });
  if (stopped.status === 0) return true;
  spawnSync('systemctl', ['--user', 'kill', '--signal=SIGKILL', unit + '.scope'], { stdio: 'ignore', timeout: 5000 });
  // Last resort without systemd: the kernel kills everything in the scope's cgroup, then the cgroup itself says whether it emptied.
  // The path is known because the host is started with --slice=app.slice. ponytail: if this fails too, nothing a user process
  // can do is left; the quit goes on and the host may run until logout (logged, SECURITY.md). Not done: refusing the quit
  // (event.preventDefault in will-quit) would trap the user in an app that cannot close.
  // A process started outside the user manager (over SSH, or GitHub's runner service) has no user@ in its own cgroup;
  // systemd's standard path for this user's manager is the fallback.
  const slice = readFileSync('/proc/self/cgroup', 'utf8').match(/^0::(.*\/user@\d+\.service)\//m)?.[1]
    ?? '/user.slice/user-' + process.getuid() + '.slice/user@' + process.getuid() + '.service';
  const scope = slice && path.join('/sys/fs/cgroup', slice, 'app.slice', unit + '.scope');
  if (scope && existsSync(path.dirname(scope))) {
    try { writeFileSync(path.join(scope, 'cgroup.kill'), '1'); } catch {}
    for (let tries = 0; tries < 20; tries++) {
      // populated counts the whole subtree, so a process left in a child cgroup still reads as running.
      let events = '';
      try { events = readFileSync(path.join(scope, 'cgroup.events'), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return true; }
      if (/^populated 0$/m.test(events)) return true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  console.error('p9: editor host ' + unit + ' may have survived stop, kill and cgroup.kill');
  return false;
}

// Writes the dev view lets through to the host's data folder are unguarded, so the real path must be a plain file there:
// not a symlink, and not a hardlink (a second name for a workspace file). ponytail: checked just before the write; a link
// swapped in between wins, and only code already running as the user could plant one.
// kind 'name' (rename, delete, mkdir act on the last name itself, never through it): only the real folder is checked.
export async function hostWritable(data, file, kind = 'write') {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return false;
  const [root, parent] = await Promise.all([realpath(data), realpath(path.dirname(file))]).catch(() => []);
  if (!parent || !(parent + path.sep).startsWith(root + path.sep)) return false;
  if (kind === 'name') return true;
  const found = await lstat(path.join(parent, path.basename(file))).catch(error => (error.code === 'ENOENT' ? null : undefined));
  return found === null || (found !== undefined && found.isFile() && found.nlink === 1);
}

// The caller may pick the unit name first, so it can register the quit handler before the host exists.
// socket: a Unix socket path instead of a loopback port (the daemon's editor for Server mode, reached through the tunnel).
export async function startEditorHost({ host = process.env.P9_EDITOR_HOST ?? path.join(EDITOR_DIR, 'codium-server'), address = LOOPBACK, data = path.join(EDITOR_DIR, 'editor'),
  unit = 'p9-editor-host-' + randomBytes(4).toString('hex'), timeout = 30000, signal, spell = false, socket } = {}) {
  if (address !== LOOPBACK) throw new Error('editor-host-loopback-only');
  if (process.platform !== 'linux' && !win) throw new Error('editor-host-unsupported-platform');
  const commit = JSON.parse(await readFile(path.join(host, 'product.json'), 'utf8')).commit;
  if (commit !== EDITOR_COMMIT) throw new Error('editor-host-commit-mismatch');
  await mkdir(data, { recursive: true, mode: 0o700 });
  if (win) userOnly(data, true); else await chmod(data, 0o700);
  if (spell) await installSpellChecker({ host, data }).then(result => { if (!/^(installed|present|offered-before)$/.test(result)) console.error('p9: spell checker not installed: ' + result); });
  // The token goes in an owner-only file: any local user can read a process's argv. A new file each start, so an old
  // file's looser mode never carries over.
  const token = randomBytes(32).toString('hex'), tokenFile = path.join(data, 'connection-token');
  await rm(tokenFile, { force: true });
  await writeFile(tokenFile, token, { mode: 0o600, flag: 'wx' });
  if (win) userOnly(tokenFile);
  // A transient scope (Linux) or Job Object (Windows) holds the whole tree (extension host, pty host, language servers),
  // so stopping it leaves nothing behind. Windows runs the REH's node.exe directly: its bin\codium-server.cmd only does that,
  // and a .cmd would need a shell.
  const server = win ? [path.join(host, 'node.exe'), path.join(host, 'out', 'server-main.js')]
    : ['systemd-run', '--user', '--scope', '--quiet', '--collect', '--slice=p9.slice', '--unit=' + unit, path.join(host, 'bin', 'codium-server')];
  const argv = [...server,
    ...(socket ? ['--socket-path', socket] : ['--host', LOOPBACK, '--port', '0']), '--connection-token-file', tokenFile, '--user-data-dir', path.join(data, 'data'),
    // Server state (workspaceStorage, which the Python extension writes on activation) defaults to ~/.vscodium-server, outside
    // the folder the dev view lets through; keep all of it in the owner-only data folder.
    '--server-data-dir', path.join(data, 'server'),
    '--extensions-dir', path.join(data, 'extensions'), '--disable-telemetry', '--accept-server-license-terms'];
  const full = win ? windowsJobCommand(argv) : argv;
  // signal: a quit before systemd has made the scope (so stopping it finds nothing) still kills the server itself.
  const child = spawn(full[0], full.slice(1), { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv(), signal, killSignal: 'SIGKILL' });
  if (win) windowsHosts.set(unit, child);
  const port = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('editor-host-timeout')), timeout);
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = /Extension host agent listening on (\S+)\s/.exec(output);
      if (match) { clearTimeout(timer); resolve(socket ? null : Number(match[1])); }
    });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('editor-host-exited: ' + code + ' ' + output.slice(-400))); });
  }).then(port => { if (signal?.aborted) throw new Error('editor-host-quit'); return port; })
    .catch(error => { stopEditorHost(unit); throw error; });
  child.stdout.resume();
  child.stderr.resume();
  return { port, socket, token, commit, unit, data, alive: () => child.exitCode === null && child.signalCode === null, stop: () => stopEditorHost(unit) };
}

// Why Dev Focus did not start, as the page names it: the editor server is missing, is another release, or (anything else)
// failed to start. Only the first two can be fixed with the install button.
export const editorProblem = error => error?.code === 'ENOENT' && /product\.json/.test(error.message) ? 'missing'
  : error?.message === 'editor-host-commit-mismatch' ? 'other-release' : 'failed';
export const editorDownload = (platform = process.platform, arch = process.arch) => {
  if (process.env.P9_EDITOR_SERVER_URL) return [process.env.P9_EDITOR_SERVER_URL, process.env.P9_EDITOR_SERVER_SHA256];
  return platform === 'linux' ? EDITOR_DOWNLOADS[arch] ?? null : null;
};

// Server mode's Dev Focus (threat model row 50): the server's daemon runs one REH on an owner-only Unix socket in its state
// folder, and the desktop reaches it through the tunnel's second forward. Its own data folder, so an editor the desktop app
// runs on the same computer never shares its token file. One start or install at a time; a host that exited starts again.
export function daemonEditor({ socket, unit, host, data = path.join(EDITOR_DIR, 'editor-server'), start = startEditorHost, install = installEditorHost }) {
  let queue = Promise.resolve(), running = null;
  const serial = job => (queue = queue.then(job, job));
  return {
    start: () => serial(async () => {
      if (running?.alive()) return running;
      // A daemon that died left its editor's scope and socket behind; the REH will not bind over a socket file.
      if (running || existsSync(socket)) stopEditorHost(unit);
      running = null;
      await rm(socket, { force: true });
      running = await start({ host, data, unit, socket, spell: process.env.P9_SPELL_CHECK !== 'off' });
      // The REH binds with the daemon's umask; owner-only like daemon.sock (the state folder is 0700 as well).
      await chmod(socket, 0o600);
      return running;
    }),
    install: () => serial(async () => {
      if (running?.alive()) throw new Error('editor-running');
      return install();
    }),
    writable: async (file, kind) => Boolean(running?.alive()) && hostWritable(data, file, kind),
    stop: () => { if (running) stopEditorHost(unit); running = null; },
  };
}

// Installs the pinned REH into dir/codium-server: download to a temp folder inside dir, check the SHA-256 while writing,
// unpack with tar (no shell), check product.json's commit, then move any old folder aside (kept) and rename the new one in.
// Any failure leaves the existing install as it was and no temp folder behind.
export async function installEditorHost({ dir = EDITOR_DIR, download = editorDownload(), max = 200 * 1024 * 1024, timeout = 600000 } = {}) {
  if (!download) throw new Error('editor-download-unavailable');
  const [url, sha256] = download;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = await mkdtemp(path.join(dir, '.editor-download-'));
  try {
    const file = path.join(temp, 'reh.tar.gz'), hash = createHash('sha256');
    // An absolute path is the copy the AppImage carries (item 16): read from disk, checked the same way as a download.
    const source = path.isAbsolute(url) ? createReadStream(url)
      : await fetch(url, { signal: AbortSignal.timeout(timeout) }).then(response => response.ok && response.body ? Readable.fromWeb(response.body) : null, () => null);
    if (!source) throw new Error('editor-download-failed');
    let size = 0;
    await pipeline(source, async function* (chunks) {
      for await (const chunk of chunks) {
        if ((size += chunk.length) > max) throw new Error('editor-download-too-big');
        hash.update(chunk);
        yield chunk;
      }
    }, createWriteStream(file, { mode: 0o600 })).catch(error => { throw new Error(error.message === 'editor-download-too-big' ? error.message : 'editor-download-failed'); });
    if (hash.digest('hex') !== sha256) throw new Error('editor-download-mismatch');
    const target = path.join(temp, 'codium-server');
    await mkdir(target);
    const code = await new Promise(resolve => spawn('tar', ['-xzf', file, '-C', target], { shell: false, stdio: 'ignore' })
      .once('error', () => resolve(-1)).once('exit', resolve));
    if (code !== 0) throw new Error('editor-unpack-failed');
    const commit = await readFile(path.join(target, 'product.json'), 'utf8').then(text => JSON.parse(text).commit, () => null);
    if (commit !== EDITOR_COMMIT) throw new Error('editor-host-commit-mismatch');
    const final = path.join(dir, 'codium-server');
    if (existsSync(final)) await rename(final, final + '.replaced-' + Date.now());
    await rename(target, final);
    return { installed: final };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

// Installs the spell checker into the editor host's extensions folder, once: download to a temp folder inside data, check the
// SHA-256, hand the file to the host's own --install-extension (no shell). A marker file means "offered", so an extension the
// user later removes stays removed. Never throws: offline, or any failure, leaves Dev Focus as it was and returns why (no marker,
// so the next start tries again). ponytail: the download holds the editor's start for up to the timeout on a stalled network.
export async function installSpellChecker({ host, data, download = [process.env.P9_SPELL_URL ?? SPELL_CHECKER[0], SPELL_CHECKER[1]], timeout = 20000, max = 20 * 1024 * 1024 }) {
  const marker = path.join(data, 'spell-checker-offered'), extensions = path.join(data, 'extensions');
  if (existsSync(marker)) return 'offered-before';
  const offered = () => writeFile(marker, new Date().toISOString() + '\n', { mode: 0o600 });
  if ((await readdir(extensions).catch(() => [])).some(name => name.startsWith('streetsidesoftware.code-spell-checker-'))) { await offered(); return 'present'; }
  const temp = await mkdtemp(path.join(data, '.spell-download-'));
  try {
    const response = await fetch(download[0], { signal: AbortSignal.timeout(timeout) }).catch(() => null);
    if (!response?.ok) return 'download-failed';
    const bytes = Buffer.from(await response.arrayBuffer().catch(() => Buffer.alloc(0)));
    if (!bytes.length || bytes.length > max) return 'download-failed';
    if (createHash('sha256').update(bytes).digest('hex') !== download[1]) return 'checksum-mismatch';
    const file = path.join(temp, 'spell-checker.vsix');
    await writeFile(file, bytes, { mode: 0o600 });
    const server = win ? [path.join(host, 'node.exe'), path.join(host, 'out', 'server-main.js')] : [path.join(host, 'bin', 'codium-server')];
    const code = await new Promise(resolve => spawn(server[0], [...server.slice(1), '--install-extension', file, '--extensions-dir', extensions,
      '--user-data-dir', path.join(data, 'data'), '--server-data-dir', path.join(data, 'server'), '--accept-server-license-terms'],
      { shell: false, stdio: 'ignore', env: childEnv(), timeout: 120000, killSignal: 'SIGKILL' }).once('error', () => resolve(-1)).once('exit', resolve));
    if (code !== 0) return 'install-failed';
    await offered();
    return 'installed';
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

// Windows' 0o700 and 0o600 do nothing: replace the ACL with one full-control entry for the current user, inherited by
// what is created inside (a file's grant has no inheritance flags: with them, icacls leaves its ACL empty). whoami.exe by full path (a Git Bash or MSYS whoami on PATH has no /user).
function userOnly(target, folder = false) {
  const who = spawnSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', timeout: 10000 });
  const sid = /"(S-1-[\d-]+)"/.exec(who.stdout ?? '')?.[1];
  if (!sid) throw new Error('editor-host-acl: no user SID');
  // /reset first: /inheritance:r drops only inherited entries, so an explicit grant on a folder left from before would stay.
  for (const args of [['/reset'], ['/inheritance:r', '/grant:r', '*' + sid + (folder ? ':(OI)(CI)F' : ':F')]]) {
    const grant = spawnSync('icacls', [target, ...args, '/q'], { encoding: 'utf8', timeout: 10000, env: childEnv() });
    if (grant.status !== 0) throw new Error('editor-host-acl: ' + (grant.stderr || grant.stdout).trim());
  }
}

// Windows' code.cmd is a batch file (a shell would be needed to run it); Code.exe sits one folder above it and takes -g too.
export function windowsCode(environment = process.env) {
  const dirs = (Object.entries(environment).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '').split(';').filter(Boolean);
  for (const dir of dirs) if (existsSync(path.join(dir, 'code.cmd')) && existsSync(path.join(dir, '..', 'Code.exe'))) return path.resolve(dir, '..', 'Code.exe');
  return 'Code.exe';
}

// "Open in VS Code": one click opens the file at the line and appends why to a log the retirement gate counts.
// Containment is checked on real paths, so a symlink inside the workspace cannot point VS Code outside it. A name with a
// colon-number part (notes:12) is refused: code -g would read it as a line number. On Windows any colon after the drive
// is refused: it names an NTFS alternate stream (a.txt:x).
export async function openInCode({ workspace, name, line, reason, code = process.env.P9_CODE ?? (win ? windowsCode() : '/usr/bin/code') }) {
  if (typeof name !== 'string' || !Number.isSafeInteger(line) || line < 1 || typeof reason !== 'string' || !reason.trim() || reason.length > 500) return { ok: false, error: 'request-refused' };
  const [real, file] = await Promise.all([realpath(workspace), realpath(path.resolve(workspace, name))]).catch(() => []);
  if (!file || !file.startsWith(real + path.sep) || file.split(':').slice(1).some(part => /^\d+$/.test(part))
    || (win && file.slice(2).includes(':'))) return { ok: false, error: 'request-refused' };
  // Logged before the spawn, so a click that opens VS Code is always counted.
  await mkdir(path.dirname(OPEN_LOG), { recursive: true, mode: 0o700 });
  await appendFile(OPEN_LOG, JSON.stringify({ time: new Date().toISOString(), file: name, line, reason: reason.trim() }) + '\n', { mode: 0o600 });
  const error = await new Promise(resolve => {
    const child = spawn(code, ['-g', file + ':' + line], { shell: false, detached: true, stdio: 'ignore' });
    child.once('spawn', () => { child.unref(); resolve(null); });
    child.once('error', resolve);
  });
  if (error) return { ok: false, error: error.code ?? 'spawn-failed' };
  return { ok: true };
}
