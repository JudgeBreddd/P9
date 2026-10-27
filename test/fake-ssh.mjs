// A stand-in for ssh in test/remote.test.mjs, run through a small sh wrapper the test writes (P9_SSH or connectServer's ssh).
// FAKE_RUNTIME plays the server's $XDG_RUNTIME_DIR: a remote command runs in sh with it set, so remote.mjs's real READ
// command is what runs. -N -L <local>:<remote> forwards a Unix socket, as OpenSSH does with StreamLocalBindMask=0177.
// Every call is appended to FAKE_SSH_LOG (argv and pid), so a test sees what ran and can kill the tunnel.
import { appendFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import net from 'node:net';

const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify({ pid: process.pid, argv }) + '\n');
let forward = null, tunnel = false, i = 0;
for (; i < argv.length && argv[i].startsWith('-'); i++) {
  if (argv[i] === '-o') i++;
  else if (argv[i] === '-L') forward = argv[++i];
  else if (argv[i] === '-N') tunnel = true;
}
const [host, ...command] = argv.slice(i);
if (!host) process.exit(255);
if (!tunnel) {
  const run = spawnSync('sh', ['-c', command.join(' ')], { env: { ...process.env, XDG_RUNTIME_DIR: process.env.FAKE_RUNTIME }, stdio: ['ignore', 'inherit', 'inherit'] });
  process.exit(run.status ?? 255);
}
const [local, remote] = forward.split(':');
process.umask(0o177);
rmSync(local, { force: true }); // StreamLocalBindUnlink=yes
net.createServer(socket => {
  const far = net.connect(remote);
  socket.pipe(far).pipe(socket);
  far.on('error', () => socket.destroy());
  socket.on('error', () => far.destroy());
}).listen(local);
process.on('SIGTERM', () => process.exit(0));
