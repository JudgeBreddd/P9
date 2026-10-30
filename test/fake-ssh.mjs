// A stand-in for ssh in test/remote.test.mjs, run through a small sh wrapper the test writes (P9_SSH or connectServer's ssh).
// FAKE_RUNTIME plays the server's $XDG_RUNTIME_DIR: a remote command runs in sh with it set, so remote.mjs's real READ
// command is what runs. -N -L <local>:<remote> (any number of them) forwards a Unix socket, as OpenSSH does with StreamLocalBindMask=0177.
// Every call is appended to FAKE_SSH_LOG (argv and pid), so a test sees what ran and can kill the tunnel.
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import net from 'node:net';

const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify({ pid: process.pid, argv }) + '\n');
const forwards = [];
const opts = {};
let tunnel = false, i = 0;
for (; i < argv.length && argv[i].startsWith('-'); i++) {
  if (argv[i] === '-o') { const [key, ...value] = argv[++i].split('='); if (key.toLowerCase() === 'identityfile') (opts.identityfile ??= []).push(value.join('=')); else opts[key.toLowerCase()] = value.join('='); }
  else if (argv[i] === '-L') forwards.push(argv[++i]);
  else if (argv[i] === '-N') tunnel = true;
}
const [host, ...command] = argv.slice(i);
if (!host || host.startsWith('unreachable')) process.exit(255); // a host named unreachable* is one ssh cannot reach
// A host named changed* answers with a host key that differs from known_hosts: OpenSSH's warning, whatever the options
// (StrictHostKeyChecking ask or yes stops there), as it prints it.
if (host.startsWith('changed')) {
  process.stderr.write('@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n'
    + '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\nIT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!\n'
    + 'Add correct host key in /tmp/fake-home/.ssh/known_hosts to get rid of this message.\nOffending ED25519 key in /tmp/fake-home/.ssh/known_hosts:7\n'
    + "  remove with:\n  ssh-keygen -f '/tmp/fake-home/.ssh/known_hosts' -R '" + host + "'\nHost key for " + host + ' has changed and you have requested strict checking.\nHost key verification failed.\n');
  process.exit(255);
}
// A host named password* has no key for this user: key-only ssh (BatchMode) is refused as OpenSSH says it. A login with
// BatchMode=no runs SSH_ASKPASS (at most NumberOfPasswordPrompts times); FAKE_PASSWORD right, it leaves a control master at
// ControlPath (%C: the host) that every later call rides. Each askpass run is logged with its exit code, and the names of any
// environment variables (FAKE_PASSWORD aside) that hold the password.
// FAKE_HOME is that remote's home: an IdentityFile whose .pub line is in its ~/.ssh/authorized_keys logs in with no password.
const keyed = () => { try { const lines = readFileSync(path.join(process.env.FAKE_HOME, '.ssh/authorized_keys'), 'utf8').split('\n'); return (opts.identityfile ?? []).some((f) => { try { return lines.includes(readFileSync(f + '.pub', 'utf8').trim()); } catch { return false; } }); } catch { return false; } };
if (host.startsWith('password')) {
  const master = opts.controlpath && opts.controlpath !== 'none' ? opts.controlpath.replace('%C', host) : null;
  if (!(master && existsSync(master)) && !keyed()) {
    const refuse = () => { process.stderr.write(host + ': Permission denied (publickey,password).\n'); process.exit(255); };
    if (opts.batchmode !== 'no' || !process.env.SSH_ASKPASS) refuse();
    let ok = false;
    for (let n = 0; n < Number(opts.numberofpasswordprompts || 3) && !ok; n++) {
      const asked = spawnSync(process.env.SSH_ASKPASS, ['tester@' + host + "'s password: "], { encoding: 'utf8', timeout: 60000 });
      const leaked = Object.entries(process.env).filter(([k, v]) => k !== 'FAKE_PASSWORD' && v.includes(process.env.FAKE_PASSWORD)).map(([k]) => k);
      appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify({ pid: process.pid, argv: [], askpass: asked.status, leaked }) + '\n');
      if (asked.status !== 0) break;
      ok = asked.stdout === process.env.FAKE_PASSWORD + '\n';
    }
    if (!ok) refuse();
    if (master) writeFileSync(master, '');
  }
}
// D15a's install (its script says P9_INSTALL) never runs here: FAKE_INSTALL, a sh script the test wrote, plays it, reading
// the source archive on stdin. Without one it fails, so no test installs into this machine's home.
if (!tunnel && command.join(' ').includes('P9_INSTALL')) {
  const run = spawnSync('sh', [process.env.FAKE_INSTALL ?? '/nonexistent'], { stdio: 'inherit' });
  process.exit(run.status ?? 255);
}
if (!tunnel) {
  // A host named no-p9* is a machine with no P9: an empty runtime folder.
  const input = command.join(' ').includes('authorized_keys') ? readFileSync(0) : undefined; // the key install's stdin
  const run = spawnSync('sh', ['-c', command.join(' ')], { env: { ...process.env, XDG_RUNTIME_DIR: host.startsWith('no-p9') ? '/nonexistent' : process.env.FAKE_RUNTIME, ...(process.env.FAKE_HOME && { HOME: process.env.FAKE_HOME }) }, stdio: [input ? 'pipe' : 'ignore', 'inherit', 'inherit'], input });
  process.exit(run.status ?? 255);
}
process.umask(0o177);
for (const forward of forwards) {
  const [local, remote] = forward.split(':');
  rmSync(local, { force: true }); // StreamLocalBindUnlink=yes
  net.createServer(socket => {
    const far = net.connect(remote);
    socket.pipe(far).pipe(socket);
    far.on('error', () => socket.destroy());
    socket.on('error', () => far.destroy());
  }).listen(local);
}
process.on('SIGTERM', () => process.exit(0));
