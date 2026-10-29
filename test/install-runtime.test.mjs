// install.sh with no XDG_RUNTIME_DIR, as a non-interactive ssh session (a desktop's Install on a remote) can run it, and its
// background mode (threat model row I1). A copy of the real script with /run/user/ moved into a temp folder; HOME is a temp
// folder too (a space and a quote in its path), stub tools on PATH, and a stub node that records the XDG_RUNTIME_DIR it was
// handed. Run as the daemon (--state), the stub makes desktop.json and holds the daemon's lock, as apps/server/main.mjs does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installRemote } from '../apps/desktop/remote-install.mjs';

const skip = process.platform === 'win32' ? 'sh' : false;
const uid = String(process.getuid?.());

// The stub daemon: desktop.json in its --state folder, written while the ownership lock is held, until SIGTERM (the real one's stop).
export const STUB_DAEMON = 's=; p=; for a; do [ "$p" = --state ] && s=$a; p=$a; done\n'
  + 'if [ -n "$s" ]; then mkdir -p "$s" "$HOME/.local/state/p9-foundation"\n'
  + '  flock -o -n "$HOME/.local/state/p9-foundation/daemon.lock" sh -c \'echo "{}" > "$0"; exec sleep 30\' "$s/desktop.json" & f=$!\n'
  + '  trap \'kill $f; rm -f "$s/desktop.json"; exit 0\' TERM; wait $f; exit 0; fi\n';

// linger: 'allowed' (systemd's default for a user's own account: the folder appears) or 'refused' (a polkit rule asks for a password).
// installed: a service is there already (install.sh takes its update path). home: the home folder's name.
export async function stage(folder, linger = 'refused', { installed = true, home: homeName = "o'k home" } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-xdg-')), home = path.join(dir, homeName), bin = path.join(dir, 'bin');
  const run = path.join(dir, 'run', 'user', uid), log = path.join(dir, 'node.log'), lingerLog = path.join(dir, 'loginctl.log'), systemctlLog = path.join(dir, 'systemctl.log');
  await mkdir(path.join(home, '.config', 'systemd', 'user'), { recursive: true }); await mkdir(bin);
  // An installed service: install.sh takes its update path, which runs node (deps, the editor server) and stops.
  if (installed) await writeFile(path.join(home, '.config', 'systemd', 'user', 'p9-foundation.service'), '');
  // 'theirs': a folder that is there but not this user's (a link to /, owned by root), which install.sh must not use.
  if (folder === 'theirs') { await mkdir(path.dirname(run), { recursive: true }); await symlink('/', run); } else if (folder) await mkdir(run, { recursive: true });
  const real = await readFile(new URL('../scripts/install.sh', import.meta.url), 'utf8');
  const checkout = path.join(dir, "src it's", 'p9');
  await mkdir(path.join(checkout, 'scripts'), { recursive: true });
  await writeFile(path.join(checkout, 'scripts', 'install.sh'), real.replaceAll('/run/user/', path.join(dir, 'run', 'user') + '/'));
  await writeFile(path.join(checkout, 'scripts', 'background.sh'), (await readFile(new URL('../scripts/background.sh', import.meta.url), 'utf8')).replaceAll('/run/user/', path.join(dir, 'run', 'user') + '/'));
  // install.sh sources apps/desktop/tools.sh (row I2), as a checkout has it.
  await mkdir(path.join(checkout, 'apps', 'desktop'), { recursive: true });
  await writeFile(path.join(checkout, 'apps', 'desktop', 'tools.sh'), await readFile(new URL('../apps/desktop/tools.sh', import.meta.url), 'utf8'));
  for (const t of ['git', 'systemd-run', 'sha256sum', 'curl', 'pnpm']) await writeFile(path.join(bin, t), '#!/bin/sh\nexit 0\n');
  await writeFile(path.join(bin, 'systemctl'), '#!/bin/sh\necho "$*" >> "' + systemctlLog + '"\n');
  await writeFile(path.join(bin, 'node'), '#!/bin/sh\n[ "$1" = --version ] && { echo v26.10.0; exit 0; }\necho "XDG=$XDG_RUNTIME_DIR $*" >> "' + log + '"\n' + STUB_DAEMON);
  // ssh: runs the command as the remote's non-interactive login would, with no XDG_RUNTIME_DIR.
  await writeFile(path.join(bin, 'ssh'), '#!/bin/sh\nfor last; do :; done\nunset XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS\nexport HOME="' + home + '" PATH="' + bin + ':$PATH"\nexec sh -c "$last"\n');
  await writeFile(path.join(bin, 'loginctl'), '#!/bin/sh\n[ "$1" = show-user ] && exit 1\necho "$*" >> "' + lingerLog + '"\n[ "$2" = disable-linger ] && exit 0\n'
    + (linger === 'allowed' ? 'mkdir -p "' + run + '"\n' : 'echo "Interactive authentication required." >&2; exit 1\n'));
  for (const t of ['git', 'systemctl', 'systemd-run', 'sha256sum', 'curl', 'pnpm', 'node', 'ssh', 'loginctl']) await chmod(path.join(bin, t), 0o755);
  const env = { ...process.env, HOME: home, PATH: bin + ':' + process.env.PATH };
  delete env.XDG_RUNTIME_DIR; delete env.DBUS_SESSION_BUS_ADDRESS;
  return { dir, home, bin, run, log, lingerLog, systemctlLog, env, checkout, runDir: path.join(home, '.local', 'share', 'p9', 'run'), script: path.join(checkout, 'scripts', 'install.sh') };
}
export const bash = (s, args = ['--headless']) => new Promise((resolve) => {
  const child = spawn('bash', [s.script, ...args], { env: s.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.setEncoding('utf8').on('data', (c) => { out += c; }); child.stderr.setEncoding('utf8').on('data', (c) => { out += c; });
  child.once('close', (code) => resolve({ code, out }));
});
export const nodeLog = (s) => readFile(s.log, 'utf8').catch(() => '');
const read = (file) => readFile(file, 'utf8').catch(() => '');
// The stub daemons this test started: stopped as the real one is.
export async function stopDaemon(s) {
  const pid = Number(await read(path.join(s.runDir, 'daemon.pid')));
  if (pid) try { process.kill(pid, 'SIGTERM'); } catch {}
}

test('install.sh with no XDG_RUNTIME_DIR: /run/user/<uid> stands in and reaches what runs after it', { skip, timeout: 30000 }, async () => {
  const s = await stage(true), { code, out } = await bash(s);
  assert.equal(code, 0, out);
  const calls = (await nodeLog(s)).trim().split('\n');
  assert.ok(calls.length >= 2 && calls.every((line) => line.startsWith('XDG=' + s.run + ' ')), calls.join('\n'));
  assert.match(out, /P9 is already installed/);
});

// Run by hand on a desktop (no --headless): the how-to stays, the person is at a terminal already.
for (const [name, folder] of [['no /run/user/<uid>', false], ['a /run/user/<uid> that is not this user\'s', 'theirs']]) test('install.sh (a desktop) with no XDG_RUNTIME_DIR and ' + name + ': one how-to, non-zero, nothing run', { skip: skip || (folder && uid === '0' ? 'root owns /' : false), timeout: 30000 }, async () => {
  const s = await stage(folder), { code, out } = await bash(s, []);
  assert.notEqual(code, 0);
  assert.match(out.trim(), /^P9 runs as a service of this user.*loginctl enable-linger \S+ .*Install again\.$/);
  assert.equal(await nodeLog(s), '', 'no step after the check ran');
});

test('install.sh --headless with no XDG_RUNTIME_DIR and no folder: linger for the own account, no password ask, then the folder is used', { skip, timeout: 30000 }, async () => {
  const s = await stage(false, 'allowed'), { code, out } = await bash(s);
  assert.equal(code, 0, out);
  assert.equal(await readFile(s.lingerLog, 'utf8'), '--no-ask-password enable-linger\n', 'its own account (no name), never a password prompt');
  const calls = (await nodeLog(s)).trim().split('\n');
  assert.ok(calls.every((line) => line.startsWith('XDG=' + s.run + ' ')), calls.join('\n'));
});

test('install.sh --headless with XDG unset and linger refused: no password ask, no wait, and P9 runs in background mode', { skip, timeout: 30000 }, async (t) => {
  const s = await stage(false, 'refused', { installed: false }), started = Date.now(), { code, out } = await bash(s);
  t.after(() => stopDaemon(s));
  assert.equal(code, 0, out);
  assert.equal(await readFile(s.lingerLog, 'utf8'), '--no-ask-password enable-linger\n');
  assert.ok(Date.now() - started < 5000, 'no 10 s wait for a folder that cannot come');
  assert.ok(!(await nodeLog(s)).includes('install-service.mjs'), 'no service');
  assert.ok(existsSync(path.join(s.runDir, 'background')) && existsSync(path.join(s.runDir, 'p9-foundation', 'desktop.json')));
});

test('install.sh --headless --background (the desktop\'s No): no linger, no service; start written 0700 and run, paths with a space and a quote', { skip, timeout: 30000 }, async (t) => {
  const s = await stage(true, 'allowed', { installed: false }), { code, out } = await bash(s, ['--headless', '--background']);
  t.after(() => stopDaemon(s));
  assert.equal(code, 0, out);
  assert.equal(await read(s.lingerLog), '', 'loginctl never ran');
  const log = await nodeLog(s);
  assert.ok(!log.includes('install-service.mjs'), log);
  const daemon = log.split('\n').find((line) => line.includes('apps/server/main.mjs'));
  assert.ok(daemon?.includes(path.join(s.checkout, 'apps', 'server', 'main.mjs') + ' --workspace ' + path.join(s.home, 'work') + ' --state ' + path.join(s.runDir, 'p9-foundation')), log);
  assert.match(daemon, / --idle-exit 300$/);
  assert.equal((await stat(s.runDir)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(s.runDir, 'start'))).mode & 0o777, 0o700);
  assert.ok(existsSync(path.join(s.runDir, 'background')));
});

test('Install on a remote whose home folder path is too long for a socket: the window gets one clear line', { skip, timeout: 30000 }, async () => {
  const s = await stage(false, 'refused', { installed: false, home: 'h'.repeat(70) });
  const archive = spawn('tar', ['-czf', '-', '-C', path.dirname(s.checkout), 'p9'], { stdio: ['ignore', 'pipe', 'ignore'] }).stdout;
  const result = await installRemote({ host: 'test-host', ssh: path.join(s.bin, 'ssh'), archive, version: '0.1.6' });
  assert.equal(result.phase, 'failed', JSON.stringify(result));
  const shown = result.tail.split('\n').filter((line) => line.trim() && !line.startsWith('P9_INSTALL'));
  assert.equal(shown.length, 1, result.tail);
  assert.match(shown[0], /^P9 cannot run for this user here: Linux allows 107 characters .* it is \d{3}\.$/);
  assert.match(result.tail, /^P9_INSTALL socket-path-too-long$/m);
  console.log('PASS long home: the window shows: ' + shown[0]);
});
