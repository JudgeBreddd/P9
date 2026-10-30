// Server mode (threat model row 50): the window talks to a P9 daemon on another machine through the user's own ssh, the way
// VS Code Remote-SSH does. One `ssh -N` forwards the server daemon's Unix socket, and its Dev Focus editor's (editor.sock), to
// sockets in an owner-only folder here; that folder also gets the server's desktop.json, socket path rewritten, so every daemonRequest(state, ...) works unchanged.
// ssh is run with fixed argv (no shell here) and BatchMode: keys or an agent only, never a password prompt. A remote with no
// key gets one login with the password (ssh-login.mjs, threat model row 78); every call here then rides it (ControlPath).
// After that login the person may say yes to P9's own key (row 79): every call then offers it too (sshOptions).
// Windows: its OpenSSH has no control master, so there ssh stays key-only, as before.
import { spawn, execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { health } from '../../scripts/teh.mjs';
// The admin password's shape (row I2): one line, at most 1024 characters. Also remote-install.mjs's.
export const PASSWORD = (value) => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\0\r\n]/.test(value);

// A Host alias or host name: no leading dash (ssh would read it as an option), no spaces, no shell characters.
export const HOST = /^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,252}$/;
// The owner-only folder for that login's control socket (and its askpass helper while it asks); %C: ssh's hash of the host.
export const CONTROL_DIR = path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), 'p9-ssh-' + (process.getuid?.() ?? 0));
const WINDOWS = process.platform === 'win32';
const CONTROL = WINDOWS ? [] : ['-o', 'ControlPath=' + CONTROL_DIR + '/%C'];
const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', ...CONTROL];
// Row 79: P9's own key (main sets the path; ssh-login.mjs makes it only after a yes). Any IdentityFile on the command line
// stops ssh trying its default key files, so the ones that exist are listed first, in ssh's order: the person's keys still go first.
let KEY = null;
export const useKey = (file) => { KEY = file; };
const DEFAULT_KEYS = ['id_rsa', 'id_ecdsa', 'id_ecdsa_sk', 'id_ed25519', 'id_ed25519_sk', 'id_xmss', 'id_dsa'];
const identity = () => KEY && existsSync(KEY)
  ? [...DEFAULT_KEYS.map(k => path.join(os.homedir(), '.ssh', k)).filter(existsSync), KEY].flatMap(f => ['-o', 'IdentityFile=' + f]) : [];
export const sshOptions = () => [...SSH_OPTIONS, ...identity()];
// What ssh writes when key-only login is refused or the host key is not known yet: then the password window can log in.
export const LOGIN = /Permission denied|Host key verification failed|No more authentication methods/;
// Row 78: the host key differs from the one known_hosts has. Checked before LOGIN (it ends in the same failed line): never a
// password window or a yes, only ssh-host-key-changed and the known_hosts line ssh pointed at (printable, at most 300 long).
export const CHANGED = /REMOTE HOST IDENTIFICATION HAS CHANGED/;
export const knownHostsLine = (err) => { const m = /Offending \S+ key in ([^\x00-\x1f\x7f]{1,300}):(\d{1,7})$/m.exec(err); return m ? { file: m[1], line: Number(m[2]) } : null; };
const changed = (err) => Object.assign(new Error('ssh-host-key-changed'), { knownHosts: knownHostsLine(err) });
// Why an ssh read failed. Windows stays key-only in 0.1.6 (its OpenSSH has no control master, so no password window): a
// remote that refuses every key says it needs a key from this computer (ssh-key-needed), and how to add one. An unknown
// host key there is not that, so it stays server-unreachable. P9_SSH_KEYS_ONLY=1 gives the same keys-only behaviour on any
// platform (as P9_SSH names the ssh to run), so the Windows path can be tested.
const KEYLESS = /Permission denied|No more authentication methods/;
export const sshFailure = (err, windows = WINDOWS || process.env.P9_SSH_KEYS_ONLY === '1') => CHANGED.test(err) ? changed(err)
  : new Error(!LOGIN.test(err) ? 'server-unreachable' : !windows ? 'ssh-login-needed' : KEYLESS.test(err) ? 'ssh-key-needed' : 'server-unreachable');
// What the server runs over ssh: its runtime folder, then its desktop credentials. The server's login shell expands $XDG_RUNTIME_DIR;
// a non-tty ssh session can come without it (a home server, 2026-10-26), so systemd's own default /run/user/<uid> stands in.
// exit 0: a server that answers always succeeds, so an ssh failure is server-unreachable and a missing file is server-no-p9.
// Background mode (threat model row I1: no service there, by the person's choice or because linger was refused): with no
// service's desktop.json and the background marker there, READ starts P9 with its start script first (it does nothing while
// one runs) and reads the folder that one uses. So every connect, a reconnect too, starts a P9 that stopped when idle.
const RUN = '"$HOME/.local/share/p9/run"';
export const READ = 'r="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"; b=' + RUN + '; if [ ! -e "$r/p9-foundation/desktop.json" ] && [ -f "$b/background" ]; then r="$b"; sh "$b/start" up >&2 || true; fi; '
  + 'printf "%s\\n" "$r"; cat "$r/p9-foundation/desktop.json" 2>/dev/null; exit 0';

// The machine menu's state for a saved remote that is not in use: is a P9 running there? It checks desktop.json exists, never
// reads it (the cookie stays there). Fixed argv, no shell here, BatchMode, 4 s to connect, 8 s in all; only three words come back.
// A background-mode P9 (row I1) counts as there: it may be stopped, and connecting starts it.
export const PROBE = 'r="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"; { test -e "$r/p9-foundation/desktop.json" || test -f ' + RUN + '/background; } && echo p9; exit 0';
export const probeServer = (host, ssh = 'ssh') => new Promise(resolve => execFile(ssh, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=4', ...CONTROL, ...identity(), host, PROBE], { timeout: 8000 },
  (error, out) => resolve(error ? 'unreachable' : out.trim() === 'p9' ? 'p9' : 'no-p9')));

// Host aliases from ~/.ssh/config (no wildcards, no negations), for the Settings list. Include files are not followed.
// ponytail: Include lines are skipped; a host only in an included file can still be typed in.
export async function sshHosts(file = path.join(os.homedir(), '.ssh', 'config')) {
  const text = await readFile(file, 'utf8').catch(() => '');
  const hosts = text.split('\n').map(line => /^\s*Host\s+(.+)$/i.exec(line)?.[1].trim().split(/\s+/) ?? []).flat();
  return [...new Set(hosts.filter(h => HOST.test(h)))];
}

// Where a host's forward lives: the same path on every reconnect, so main's state folder stays valid across a drop.
export const serverFolder = (host, runtime = process.env.XDG_RUNTIME_DIR || os.tmpdir()) => path.join(runtime, 'p9-server', host);

function readServer(host, ssh) {
  // 60 s: a background start waits up to 30 s for its daemon.
  return new Promise((resolve, reject) => execFile(ssh, [...sshOptions(), host, READ], { timeout: 60000, maxBuffer: 65536 }, (error, out, err) => {
    if (error) return reject(sshFailure(err));
    const [runtime, ...rest] = out.split('\n');
    let credentials;
    try { credentials = JSON.parse(rest.join('\n')); } catch { return reject(new Error('server-no-p9')); }
    if (!/^\/[\w./-]+$/.test(runtime) || runtime.includes('..') || typeof credentials?.cookie !== 'string' || typeof credentials.csrf !== 'string') return reject(new Error('server-no-p9'));
    resolve({ remoteSocket: runtime + '/p9-foundation/daemon.sock', remoteEditor: runtime + '/p9-foundation/editor.sock', credentials: { cookie: credentials.cookie, csrf: credentials.csrf }, background: runtime.endsWith('/.local/share/p9/run') });
  }));
}

// remoteMode(host, action): Keep P9 running there, Yes ('keep': linger for the user's own account, then the service) or No
// ('release': the service off, then the background daemon); start's own steps (scripts/background.sh). Fixed argv, BatchMode.
// password: keep only, the admin password the person typed (row I2), for loginctl enable-linger <user> where linger needs an
// admin: stdin's first line, never the command. -> { phase, command? }: phase 'ok' | 'refused' (linger needs an admin there;
// command: the one the password would run) | 'wrong-password' | 'not-allowed' | 'no-start' (a P9 installed before this) | 'failed'.
export function remoteMode(host, action, ssh = 'ssh', password = null) {
  if (!HOST.test(host) || !['keep', 'release'].includes(action) || (password !== null && (action !== 'keep' || !PASSWORD(password)))) return Promise.resolve({ phase: 'failed' });
  const command = 'b=' + RUN + '; [ -f "$b/start" ] || { echo P9_MODE no-start; exit 0; }; sh "$b/start" ' + action + (password !== null ? ' admin' : '');
  return new Promise(resolve => {
    const child = execFile(ssh, [...sshOptions(), host, command], { timeout: 180000 }, (error, out) => {
      const admin = /^P9_ADMIN (wrong-password|not-allowed)$/m.exec(out ?? '')?.[1];
      const phase = admin ?? /^P9_(?:KEEP|RELEASE|MODE) (ok|refused|no-start)$/m.exec(out ?? '')?.[1] ?? 'failed';
      const shown = /^P9_ADMIN command (loginctl enable-linger [\w.-]+)$/m.exec(out ?? '')?.[1];
      resolve({ phase, ...(phase === 'refused' && shown && { command: shown }) });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(password !== null ? password + '\n' : '');
  });
}

// remoteDeps(host): tmux or ssh missing on a remote that runs P9 (row 61 on a remote). The remote's start script computes
// the command (deps.mjs there). No password: { phase: 'admin', command } to show, or 'none'; with one, that command run
// through p9_admin there: 'ok', 'wrong-password', 'not-allowed' or 'failed'. Fixed argv, BatchMode, the password on stdin.
export function remoteDeps(host, ssh = 'ssh', password = null) {
  if (!HOST.test(host) || (password !== null && !PASSWORD(password))) return Promise.resolve({ phase: 'failed' });
  const command = 'b=' + RUN + '; [ -f "$b/start" ] || { echo P9_DEPS no-start; exit 0; }; sh "$b/start" deps' + (password !== null ? ' admin' : '');
  return new Promise(resolve => {
    const child = execFile(ssh, [...sshOptions(), host, command], { timeout: password !== null ? 600000 : 60000 }, (error, out) => {
      const admin = /^P9_ADMIN (wrong-password|not-allowed)$/m.exec(out ?? '')?.[1];
      const shown = password === null && /^P9_ADMIN command (.+)$/m.exec(out ?? '')?.[1];
      resolve(admin ? { phase: admin } : shown ? { phase: 'admin', command: shown } : { phase: /^P9_DEPS (ok|none)$/m.exec(out ?? '')?.[1] ?? 'failed' });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(password !== null ? password + '\n' : '');
  });
}

// startServer(host): Start P9 there, for a remote that answered without a running P9 (never a terminal command, row I1).
// Its user service if one is installed and P9 is not in background mode, else the background start script. Fixed argv, BatchMode.
// -> 'ok' | 'none' (nothing to start there: Install P9 there) | 'failed'.
export function startServer(host, ssh = 'ssh') {
  if (!HOST.test(host)) return Promise.resolve('failed');
  const command = 'b=' + RUN + '; export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"; '
    + 'if [ -e "$HOME/.config/systemd/user/p9-foundation.service" ] && [ ! -f "$b/background" ]; then systemctl --user start p9-foundation.service >/dev/null 2>&1; '
    + 'elif [ -f "$b/start" ]; then sh "$b/start" up >/dev/null 2>&1; else echo P9_START none; exit 0; fi && echo P9_START ok || echo P9_START failed';
  return new Promise(resolve => execFile(ssh, [...sshOptions(), host, command], { timeout: 60000 }, (error, out) =>
    resolve(/^P9_START (ok|none)$/m.exec(out ?? '')?.[1] ?? 'failed')));
}

// restartServer(host): the server's own unit restarted over ssh, as Restart P9 restarts the local one. Fixed argv.
export function restartServer(host, ssh = 'ssh') {
  if (!HOST.test(host)) return Promise.resolve(false);
  return new Promise(resolve => execFile(ssh, [...sshOptions(), host, 'systemctl --user restart p9-foundation.service'], { timeout: 60000 }, error => resolve(!error)));
}

// connectServer({ host }) -> { state, host, close(), check(), background }. background: P9 there runs in background mode (row I1). check() is /health, re-reading the credentials after a server restart. state is a folder holding daemon.sock and editor.sock (the forwards) and desktop.json.
// editor.sock answers only once Dev Focus has asked the server's daemon to start its editor (POST /dev/editor); ssh connects each forwarded socket when it is used.
// editor: false leaves the editor forward off (the move's tunnel has no use for it).
// onDrop runs when the tunnel ends without close() (lid closed, network gone, server restarted); the caller reconnects.
export async function connectServer({ host, ssh = 'ssh', runtime = process.env.XDG_RUNTIME_DIR || os.tmpdir(), editor = true, onDrop = () => {} }) {
  if (typeof host !== 'string' || !HOST.test(host)) throw new Error('server-host-refused');
  const { remoteSocket, remoteEditor, credentials, background } = await readServer(host, ssh);
  const state = serverFolder(host, runtime), parent = path.dirname(state);
  await mkdir(state, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700); await chmod(state, 0o700);
  const socketPath = path.join(state, 'daemon.sock'), editorSocket = path.join(state, 'editor.sock');
  await rm(socketPath, { force: true });
  await rm(editorSocket, { force: true });
  const save = c => writeFile(path.join(state, 'desktop.json'), JSON.stringify({ ...c, socketPath }), { mode: 0o600 });
  await save(credentials);
  // A restarted server daemon has new credentials, so its /health answers 401; the forward itself survives (one ssh channel per
  // connection). A failed /health re-reads them, one read at a time, and asks once more.
  let reading = null;
  const check = () => health(state).catch(async () => {
    reading ??= readServer(host, ssh).then(r => save(r.credentials)).finally(() => { reading = null; });
    await reading;
    return health(state);
  });
  const child = spawn(ssh, [...sshOptions(), '-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'StreamLocalBindUnlink=yes', '-o', 'StreamLocalBindMask=0177',
    '-L', socketPath + ':' + remoteSocket, ...(editor ? ['-L', editorSocket + ':' + remoteEditor] : []), host], { stdio: 'ignore' });
  let closed = false, exited = false, ready = false;
  const close = async () => { closed = true; if (!exited) child.kill(); await rm(state, { recursive: true, force: true }); };
  child.on('exit', () => { exited = true; if (!closed) { closed = true; rm(state, { recursive: true, force: true }).catch(() => {}); if (ready) onDrop(); } });
  // Ready when the server daemon answers /health through the forward; 15 s, the same wait the installer gives a fresh daemon.
  for (let i = 0; i < 60; i++) {
    if (exited) break;
    if (await check().then(h => h.status === 'ok', () => false)) { ready = true; return { state, host, close, check, background }; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  await close();
  throw new Error('server-not-answering');
}
