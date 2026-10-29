// install.sh with no XDG_RUNTIME_DIR, as a non-interactive ssh session (a desktop's Install on a remote) can run it.
// A copy of the real script with /run/user/ moved into a temp folder; stub tools on PATH, and a stub node that records
// the XDG_RUNTIME_DIR it was handed (install-service.mjs's systemctl --user calls get the same environment).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installRemote } from '../apps/desktop/remote-install.mjs';

const skip = process.platform === 'win32' ? 'sh' : false;
const uid = String(process.getuid?.());

async function stage(folder) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-xdg-')), home = path.join(dir, 'home'), bin = path.join(dir, 'bin');
  const run = path.join(dir, 'run', 'user', uid), log = path.join(dir, 'node.log');
  await mkdir(path.join(home, '.config', 'systemd', 'user'), { recursive: true }); await mkdir(bin);
  // An installed service: install.sh takes its update path, which runs node (deps, the editor server) and stops.
  await writeFile(path.join(home, '.config', 'systemd', 'user', 'p9-foundation.service'), '');
  // 'theirs': a folder that is there but not this user's (a link to /, owned by root), which install.sh must not use.
  if (folder === 'theirs') { await mkdir(path.dirname(run), { recursive: true }); await symlink('/', run); } else if (folder) await mkdir(run, { recursive: true });
  const real = await readFile(new URL('../scripts/install.sh', import.meta.url), 'utf8');
  await mkdir(path.join(dir, 'src', 'p9', 'scripts'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'p9', 'scripts', 'install.sh'), real.replaceAll('/run/user/', path.join(dir, 'run', 'user') + '/'));
  for (const t of ['git', 'systemctl', 'systemd-run', 'sha256sum', 'curl']) await writeFile(path.join(bin, t), '#!/bin/sh\nexit 0\n');
  await writeFile(path.join(bin, 'node'), '#!/bin/sh\n[ "$1" = --version ] && { echo v26.10.0; exit 0; }\necho "XDG=$XDG_RUNTIME_DIR $*" >> "' + log + '"\n');
  // ssh: runs the command as the remote's non-interactive login would, with no XDG_RUNTIME_DIR.
  await writeFile(path.join(bin, 'ssh'), '#!/bin/sh\nfor last; do :; done\nunset XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS\nexport HOME="' + home + '" PATH="' + bin + ':$PATH"\nexec sh -c "$last"\n');
  for (const t of ['git', 'systemctl', 'systemd-run', 'sha256sum', 'curl', 'node', 'ssh']) await chmod(path.join(bin, t), 0o755);
  const env = { ...process.env, HOME: home, PATH: bin + ':' + process.env.PATH };
  delete env.XDG_RUNTIME_DIR; delete env.DBUS_SESSION_BUS_ADDRESS;
  return { dir, home, bin, run, log, env, script: path.join(dir, 'src', 'p9', 'scripts', 'install.sh') };
}
const bash = (s) => new Promise((resolve) => {
  const child = spawn('bash', [s.script, '--headless'], { env: s.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.setEncoding('utf8').on('data', (c) => { out += c; }); child.stderr.setEncoding('utf8').on('data', (c) => { out += c; });
  child.once('close', (code) => resolve({ code, out }));
});
const nodeLog = (s) => readFile(s.log, 'utf8').catch(() => '');

test('install.sh with no XDG_RUNTIME_DIR: /run/user/<uid> stands in and reaches what runs after it', { skip, timeout: 30000 }, async () => {
  const s = await stage(true), { code, out } = await bash(s);
  assert.equal(code, 0, out);
  const calls = (await nodeLog(s)).trim().split('\n');
  assert.ok(calls.length >= 2 && calls.every((line) => line.startsWith('XDG=' + s.run + ' ')), calls.join('\n'));
  assert.match(out, /P9 is already installed/);
});

for (const [name, folder] of [['no /run/user/<uid>', false], ['a /run/user/<uid> that is not this user\'s', 'theirs']]) test('install.sh with no XDG_RUNTIME_DIR and ' + name + ': one how-to, non-zero, nothing run', { skip: skip || (folder && uid === '0' ? 'root owns /' : false), timeout: 30000 }, async () => {
  const s = await stage(folder), { code, out } = await bash(s);
  assert.notEqual(code, 0);
  assert.match(out.trim(), /^P9 runs as a service of this user.*loginctl enable-linger \S+ .*Install again\.$/);
  assert.equal(await nodeLog(s), '', 'no step after the check ran');
});

test('Install on a remote with no user session: the window gets the how-to line, not a raw error', { skip, timeout: 30000 }, async () => {
  const s = await stage(false);
  const archive = spawn('tar', ['-czf', '-', '-C', path.join(s.dir, 'src'), 'p9'], { stdio: ['ignore', 'pipe', 'ignore'] }).stdout;
  const result = await installRemote({ host: 'test-host', ssh: path.join(s.bin, 'ssh'), archive, version: '0.1.6' });
  assert.equal(result.phase, 'failed', JSON.stringify(result));
  const shown = result.tail.split('\n').filter((line) => line.trim() && !line.startsWith('P9_INSTALL'));
  assert.equal(shown.length, 1, result.tail);
  assert.match(shown[0], /loginctl enable-linger \S+ .*Install again\.$/);
  console.log('PASS install without XDG_RUNTIME_DIR: the window shows: ' + shown[0]);
});
