// Server mode (threat model row 50): the window talks to a P9 daemon on another machine through the user's own ssh, the way
// VS Code Remote-SSH does. One `ssh -N` forwards the server daemon's Unix socket, and its Dev Focus editor's (editor.sock), to
// sockets in an owner-only folder here; that folder also gets the server's desktop.json, socket path rewritten, so every daemonRequest(state, ...) works unchanged.
// ssh is run with fixed argv (no shell here) and BatchMode: keys or an agent only, never a password prompt.
import { spawn, execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { health } from '../../scripts/teh.mjs';

// A Host alias or host name: no leading dash (ssh would read it as an option), no spaces, no shell characters.
export const HOST = /^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,252}$/;
export const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];
// What the server runs over ssh: its runtime folder, then its desktop credentials. The server's login shell expands $XDG_RUNTIME_DIR;
// a non-tty ssh session can come without it (a home server, 2026-10-26), so systemd's own default /run/user/<uid> stands in.
// exit 0: a server that answers always succeeds, so an ssh failure is server-unreachable and a missing file is server-no-p9.
export const READ = 'r="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"; printf "%s\\n" "$r"; cat "$r/p9-foundation/desktop.json" 2>/dev/null; exit 0';

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
  return new Promise((resolve, reject) => execFile(ssh, [...SSH_OPTIONS, host, READ], { timeout: 20000, maxBuffer: 65536 }, (error, out) => {
    if (error) return reject(new Error('server-unreachable'));
    const [runtime, ...rest] = out.split('\n');
    let credentials;
    try { credentials = JSON.parse(rest.join('\n')); } catch { return reject(new Error('server-no-p9')); }
    if (!/^\/[\w./-]+$/.test(runtime) || runtime.includes('..') || typeof credentials?.cookie !== 'string' || typeof credentials.csrf !== 'string') return reject(new Error('server-no-p9'));
    resolve({ remoteSocket: runtime + '/p9-foundation/daemon.sock', remoteEditor: runtime + '/p9-foundation/editor.sock', credentials: { cookie: credentials.cookie, csrf: credentials.csrf } });
  }));
}

// restartServer(host): the server's own unit restarted over ssh, as Restart P9 restarts the local one. Fixed argv.
export function restartServer(host, ssh = 'ssh') {
  if (!HOST.test(host)) return Promise.resolve(false);
  return new Promise(resolve => execFile(ssh, [...SSH_OPTIONS, host, 'systemctl --user restart p9-foundation.service'], { timeout: 60000 }, error => resolve(!error)));
}

// connectServer({ host }) -> { state, host, close(), check() }. check() is /health, re-reading the credentials after a server restart. state is a folder holding daemon.sock and editor.sock (the forwards) and desktop.json.
// editor.sock answers only once Dev Focus has asked the server's daemon to start its editor (POST /dev/editor); ssh connects each forwarded socket when it is used.
// editor: false leaves the editor forward off (the move's tunnel has no use for it).
// onDrop runs when the tunnel ends without close() (lid closed, network gone, server restarted); the caller reconnects.
export async function connectServer({ host, ssh = 'ssh', runtime = process.env.XDG_RUNTIME_DIR || os.tmpdir(), editor = true, onDrop = () => {} }) {
  if (typeof host !== 'string' || !HOST.test(host)) throw new Error('server-host-refused');
  const { remoteSocket, remoteEditor, credentials } = await readServer(host, ssh);
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
  const child = spawn(ssh, [...SSH_OPTIONS, '-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'StreamLocalBindUnlink=yes', '-o', 'StreamLocalBindMask=0177',
    '-L', socketPath + ':' + remoteSocket, ...(editor ? ['-L', editorSocket + ':' + remoteEditor] : []), host], { stdio: 'ignore' });
  let closed = false, exited = false, ready = false;
  const close = async () => { closed = true; if (!exited) child.kill(); await rm(state, { recursive: true, force: true }); };
  child.on('exit', () => { exited = true; if (!closed) { closed = true; rm(state, { recursive: true, force: true }).catch(() => {}); if (ready) onDrop(); } });
  // Ready when the server daemon answers /health through the forward; 15 s, the same wait the installer gives a fresh daemon.
  for (let i = 0; i < 60; i++) {
    if (exited) break;
    if (await check().then(h => h.status === 'ok', () => false)) { ready = true; return { state, host, close, check }; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  await close();
  throw new Error('server-not-answering');
}
