// D15a (threat model row 67): installing P9 on a remote that has none, through a stand-in ssh that runs the command in a
// stand-in home on this machine. install.sh is a stub that records its arguments and what it read from stdin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installRemote, script } from '../apps/desktop/remote-install.mjs';

const skip = process.platform === 'win32' ? 'sh' : false;

async function stage() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-rinstall-')), home = path.join(dir, 'home'), bin = path.join(dir, 'bin');
  await mkdir(home); await mkdir(bin); await mkdir(path.join(dir, 'src', 'p9', 'scripts'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'p9', 'scripts', 'install.sh'),
    'echo "ARGS $*" > "$HOME/args.txt"; cat > "$HOME/stdin.txt"; echo "Built in ' + dir + '/deep/folder/build.log"\n');
  await writeFile(path.join(dir, 'src', 'p9', 'README.md'), 'p9\n');
  // ssh: the options and host are dropped, the last argument runs as the remote's login shell would run it.
  const ssh = path.join(bin, 'ssh');
  await writeFile(ssh, '#!/bin/sh\nfor last; do :; done\necho "$*" >> "' + dir + '/ssh-args.txt"\nexport HOME="' + home + '" PATH="' + bin + ':$PATH"\nexec sh -c "$last"\n');
  // curl for a packaged app's download: logs the URL, writes the stage's archive.
  await writeFile(path.join(bin, 'curl'), '#!/bin/sh\nfor a; do [ "$prev" = -o ] && out="$a"; prev="$a"; done\nfor last; do :; done\necho "$last" >> "' + dir + '/urls.txt"\ntar -czf "$out" -C "' + dir + '/src" p9\n');
  await chmod(ssh, 0o755); await chmod(path.join(bin, 'curl'), 0o755);
  const archive = () => spawn('tar', ['-czf', '-', '-C', path.join(dir, 'src'), 'p9'], { stdio: ['ignore', 'pipe', 'ignore'] }).stdout;
  return { dir, home, ssh, archive };
}
const exists = (p) => access(p).then(() => true, () => false);

test('D15a: a checkout\'s source lands in ~/p9 there and install.sh runs headless with no input', { skip, timeout: 30000 }, async () => {
  const s = await stage(), events = [];
  const result = await installRemote({ host: 'test-host', ssh: s.ssh, archive: s.archive(), version: '0.1.6', tell: (e) => events.push(e) });
  assert.equal(result.phase, 'done', JSON.stringify(result));
  assert.equal(await readFile(path.join(s.home, 'args.txt'), 'utf8'), 'ARGS --headless\n');
  assert.equal(await readFile(path.join(s.home, 'stdin.txt'), 'utf8'), '', 'install.sh reads no answer, so its admin ask says no');
  assert.ok(await exists(path.join(s.home, 'p9', 'README.md')) && await exists(path.join(s.home, 'p9', '.p9-remote-install')));
  // ssh gets BatchMode, the host as its own argument, and the archive never in the command.
  const argv = await readFile(path.join(s.dir, 'ssh-args.txt'), 'utf8');
  assert.match(argv, /^-o BatchMode=yes .* test-host sh -c /);
  // What the window shows names files, never where they are on the remote.
  const shown = JSON.stringify(events);
  assert.ok(shown.includes('build.log') && !shown.includes(s.dir), shown);
  // A failed install can be tried again: its own ~/p9 gets install.sh again, nothing unpacked over it.
  await writeFile(path.join(s.home, 'p9', 'README.md'), 'kept\n');
  assert.equal((await installRemote({ host: 'test-host', ssh: s.ssh, archive: s.archive(), version: '0.1.6' })).phase, 'done');
  assert.equal(await readFile(path.join(s.home, 'p9', 'README.md'), 'utf8'), 'kept\n');
});

test('D15a: a ~/p9 this app did not make is left alone', { skip, timeout: 30000 }, async () => {
  const s = await stage();
  await mkdir(path.join(s.home, 'p9')); await writeFile(path.join(s.home, 'p9', 'mine.txt'), 'mine\n');
  const result = await installRemote({ host: 'test-host', ssh: s.ssh, archive: s.archive(), version: '0.1.6' });
  assert.equal(result.phase, 'already-there');
  assert.deepEqual(await readdir(path.join(s.home, 'p9')), ['mine.txt']);
  assert.equal(await exists(path.join(s.home, 'args.txt')), false, 'install.sh did not run');
});

test('D15a: a packaged app has the remote download its own version from the fixed release URL', { skip, timeout: 30000 }, async () => {
  const s = await stage();
  const result = await installRemote({ host: 'test-host', ssh: s.ssh, version: '0.1.6' });
  assert.equal(result.phase, 'done', JSON.stringify(result));
  assert.equal(await readFile(path.join(s.dir, 'urls.txt'), 'utf8'), 'https://github.com/JudgeBreddd/P9/archive/refs/tags/v0.1.6.tar.gz\n');
  assert.match(script('0.1.6'), /--proto =https/);
});

test('D15a: a host ssh would read as an option, or a version that is not one, is refused before ssh runs', { skip, timeout: 10000 }, async () => {
  const s = await stage();
  assert.throws(() => installRemote({ host: '-oProxyCommand=x', ssh: s.ssh, version: '0.1.6' }), /server-host-refused/);
  assert.throws(() => installRemote({ host: 'test-host', ssh: s.ssh, version: "0.1.6'; touch x; '" }), /remote-install-version/);
  assert.equal(await exists(path.join(s.dir, 'ssh-args.txt')), false);
});
