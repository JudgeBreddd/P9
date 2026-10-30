// Remote mode's ssh login for a remote with no key set up (attempt 2 item 3, threat model row 78). Key-only ssh was refused
// (remote.mjs LOGIN), so one ssh runs with SSH_ASKPASS: ssh runs the helper with its prompt, the helper asks main over a Unix
// socket, main asks the person in the password window (ask), and the answer goes back on the helper's stdout, a pipe to ssh.
// The password is never on a command line, in the environment, in a file or a log. The login stays as an ssh control master
// (ControlPersist, 10 minutes idle) that every later call in remote.mjs uses through ControlPath, so the person types it once.
// -> 'ok' | 'refused' (ssh said no after its tries) | 'cancelled' (the person closed the window) | 'failed'
// | { changed: knownHostsLine } (the host key differs from known_hosts: ssh stopped before any prompt).
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { HOST, LOGIN, CHANGED, knownHostsLine, CONTROL_DIR, sshOptions } from './remote.mjs';

const q = (s) => "'" + String(s).replaceAll("'", "'\\''") + "'";
// The helper's own code: argv is ssh's prompt and the socket path; an empty answer (Cancel) exits 1, which stops ssh asking.
const HELPER = "const c=require('net').connect(process.argv[2]);let o='';c.on('connect',()=>c.end(process.argv[1]||''));"
  + "c.setEncoding('utf8').on('data',d=>{o+=d});c.on('end',()=>{if(!o)process.exit(1);process.stdout.write(o+'\\n')});c.on('error',()=>process.exit(1))";

// ask({ prompt, again }) -> the password, 'yes' for a host key the person trusts, or null. again: the last password was wrong.
export async function sshLogin({ host, ssh = 'ssh', ask, dir = CONTROL_DIR }) {
  if (typeof host !== 'string' || !HOST.test(host)) return 'failed';
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const folder = await lstat(dir);
  if (!folder.isDirectory() || folder.uid !== process.getuid()) return 'failed'; // another user's folder: never ours to use
  await chmod(dir, 0o700);
  const id = randomBytes(8).toString('hex'), sock = path.join(dir, 'ask-' + id + '.sock'), helper = path.join(dir, 'ask-' + id), log = path.join(dir, 'ask-' + id + '.log');
  let passwords = 0, cancelled = false;
  const server = net.createServer({ allowHalfOpen: true }, (c) => {
    let prompt = '';
    c.setEncoding('utf8').on('error', () => {}).on('data', (d) => { prompt += d; if (prompt.length > 4096) c.destroy(); }).on('end', async () => {
      const key = /\(yes\/no/i.test(prompt);
      const answer = cancelled ? null : await Promise.resolve(ask({ prompt: prompt.slice(0, 2000), again: !key && passwords++ > 0 })).catch(() => null);
      if (typeof answer !== 'string' || !answer) cancelled = true;
      c.end(cancelled ? '' : answer);
    });
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(sock, resolve));
  try {
    await chmod(sock, 0o600);
    await writeFile(helper, '#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ' + q(process.execPath) + ' -e ' + q(HELPER) + ' -- "$1" ' + q(sock) + '\n', { mode: 0o700 });
    const err = await open(log, 'w', 0o600);
    const code = await new Promise((resolve) => {
      // detached: no controlling terminal, so an older ssh uses the helper too. The master keeps running after this exits.
      const child = spawn(ssh, ['-o', 'BatchMode=no', '-o', 'NumberOfPasswordPrompts=3', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
        '-o', 'ControlMaster=auto', '-o', 'ControlPersist=600', '-o', 'ControlPath=' + dir + '/%C', host, 'exit 0'],
      { env: { ...process.env, SSH_ASKPASS: helper, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: process.env.DISPLAY || ':0' }, stdio: ['ignore', 'ignore', err.fd], detached: true });
      const timer = setTimeout(() => child.kill(), 300000); // ponytail: 5 minutes for the whole login, the window included
      child.once('error', () => { clearTimeout(timer); resolve(-1); });
      child.once('exit', (exit) => { clearTimeout(timer); resolve(exit); });
    });
    await err.close();
    if (code === 0) return 'ok';
    if (cancelled) return 'cancelled';
    const said = await readFile(log, 'utf8').catch(() => '');
    if (CHANGED.test(said)) return { changed: knownHostsLine(said) };
    return LOGIN.test(said) ? 'refused' : 'failed';
  } finally {
    server.close();
    await Promise.all([sock, helper, log].map((file) => rm(file, { force: true })));
  }
}

// Row 79: P9's own key, made only after the person said yes. One ed25519 key, no passphrase (as a default ssh-keygen key),
// comment p9-event-horizon so its line on a remote can be found. ssh-keygen sits beside ssh. -> true when it is there.
export async function makeKey(file, ssh = 'ssh') {
  if (existsSync(file) && existsSync(file + '.pub')) return true;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await Promise.all([file, file + '.pub'].map((f) => rm(f, { force: true })));
  const keygen = path.isAbsolute(ssh) ? path.join(path.dirname(ssh), 'ssh-keygen') : 'ssh-keygen';
  return new Promise((resolve) => execFile(keygen, ['-q', '-t', 'ed25519', '-N', '', '-C', 'p9-event-horizon', '-f', file], { timeout: 30000 }, (error) => resolve(!error)));
}
// Adds the public key to the remote's ~/.ssh/authorized_keys over the login just made (sshOptions rides its master), the
// way ssh-copy-id does: only if that exact line is missing, never rewriting the file, 0700/0600 when it makes them. Then the
// key alone must log in, on a new connection. -> 'ok' | 'not-accepted' (added, but the remote refuses it) | 'failed'.
const ADD = 'umask 077; mkdir -p ~/.ssh && f=~/.ssh/authorized_keys && k=$(cat) && touch "$f" && '
  + '{ grep -qxF "$k" "$f" || { if [ -s "$f" ] && [ -n "$(tail -c1 "$f")" ]; then echo >> "$f"; fi; printf "%s\\n" "$k" >> "$f"; }; }';
export async function installKey({ host, ssh = 'ssh', file }) {
  if (typeof host !== 'string' || !HOST.test(host)) return 'failed';
  const pub = (await readFile(file + '.pub', 'utf8').catch(() => '')).trim();
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+ p9-event-horizon$/.test(pub)) return 'failed';
  const added = await new Promise((resolve) => execFile(ssh, [...sshOptions(), host, ADD], { timeout: 60000 }, (error) => resolve(!error)).stdin.end(pub + '\n'));
  if (!added) return 'failed';
  return new Promise((resolve) => execFile(ssh, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ControlPath=none', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityFile=' + file, host, 'exit 0'],
    { timeout: 30000 }, (error) => resolve(error ? 'not-accepted' : 'ok')));
}
