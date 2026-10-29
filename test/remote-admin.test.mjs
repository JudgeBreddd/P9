// Threat model row I2: the admin password typed into the app for one admin step on a remote, never in a terminal there.
// The remote install's tool check before it unpacks anything (apps/desktop/tools.sh in remote-install.mjs's script), the
// password through stdin to a stub sudo, and Keep it running's linger with the password (scripts/background.sh keep admin).
// HOME is a temp folder; ssh, sudo, apt-get, loginctl, systemctl and node are stubs, so nothing here touches this machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installRemote, PASSWORD, adminLocal, adminArgs } from '../apps/desktop/remote-install.mjs';
import { remoteMode } from '../apps/desktop/remote.mjs';
import { stage, bash, nodeLog, stopDaemon } from './install-runtime.test.mjs';

const skip = process.platform === 'win32' ? 'sh' : false;
const PW = "right p@ss 'w$rd \\n `x`";
const read = (file) => readFile(file, 'utf8').catch(() => '');
const real = (tool) => execFileSync('sh', ['-c', 'command -v ' + tool], { encoding: 'utf8' }).trim();

// sudo: records each argument on its own line; like the real one, after a -v that worked (and with no -k) it reads no
// password, so the line stays on stdin for the command (what p9_admin must stop). Else it reads the password line, refuses a wrong one (or every one, with the
// not-allowed file), validates for -v, else runs what follows -- with P9_ROOT set. The expected password sits outside dir.
async function sudoStub(bin, dir) {
  const expect = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-admin-pw-')), 'expect');
  await writeFile(expect, PW);
  await writeFile(path.join(bin, 'sudo'), '#!/bin/sh\nfor a; do printf "%s\\n" "$a"; done >> "' + dir + '/sudo-argv.txt"; echo --- >> "' + dir + '/sudo-argv.txt"\n'
    + 'case " $* " in *" -k "*) rm -f "' + dir + '/cached" ;; esac\n'
    + 'if [ -f "' + dir + '/cached" ]; then shift 3; [ "$1" = -- ] && shift; export P9_ROOT=1; exec "$@"; fi\n'
    + 'IFS= read -r pw || true\n[ -f "' + dir + '/not-allowed" ] && { echo "me is not in the sudoers file." >&2; exit 1; }\n'
    + '[ "$pw" = "$(cat "' + expect + '")" ] || { echo "Sorry, try again." >&2; exit 1; }\n'
    + 'while [ $# -gt 0 ] && [ "$1" != -- ]; do [ "$1" = -v ] && { : > "' + dir + '/cached"; exit 0; }; shift; done\nshift; export P9_ROOT=1; exec "$@"\n');
  await chmod(path.join(bin, 'sudo'), 0o755);
  return expect;
}

// A remote with almost nothing: PATH is only bin, which has sh, bash and the few tools the script uses before the check,
// but no tar, gzip, git, curl or systemd. apt-get "installs" them (stubs, and links to this machine's tar and gzip).
async function bare() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-admin-')), home = path.join(dir, 'home'), bin = path.join(dir, 'bin'), src = path.join(dir, 'src', 'p9');
  await mkdir(home); await mkdir(bin); await mkdir(path.join(src, 'scripts'), { recursive: true });
  for (const t of ['sh', 'bash', 'cat', 'mktemp', 'mkdir', 'rm', 'id']) await symlink(real(t), path.join(bin, t));
  // install.sh there: what it read from stdin's first line is only compared, never written.
  const expect = await sudoStub(bin, dir);
  await writeFile(path.join(src, 'scripts', 'install.sh'), 'echo "ARGS $*" > "$HOME/args.txt"\nIFS= read -r p || true\n[ "$p" = "$(cat "' + expect + '")" ] && echo PW-OK > "$HOME/pw-ok.txt"\nexit 0\n');
  await writeFile(path.join(bin, 'apt-get'), '#!/bin/sh\necho "$*" >> "' + dir + '/apt.txt"; cat >> "' + dir + '/apt-stdin.txt"\n[ "$1" = install ] || exit 0\n'
    + 'for t in git systemctl systemd-run sha256sum flock setsid curl; do printf "#!/bin/sh\\nexit 0\\n" > "' + bin + '/$t"; ' + real('chmod') + ' +x "' + bin + '/$t"; done\n'
    + real('ln') + ' -sf ' + real('tar') + ' "' + bin + '/tar"; ' + real('ln') + ' -sf ' + real('gzip') + ' "' + bin + '/gzip"\n');
  await chmod(path.join(bin, 'apt-get'), 0o755);
  const ssh = path.join(bin, 'ssh');
  await writeFile(ssh, '#!/bin/sh\nfor a; do printf "%s\\n" "$a"; done >> "' + dir + '/ssh-args.txt"\nfor last; do :; done\nexport HOME="' + home + '" PATH="' + bin + '"\nexec sh -c "$last"\n');
  await chmod(ssh, 0o755);
  const archive = () => spawn('tar', ['-czf', '-', '-C', path.dirname(src), 'p9'], { stdio: ['ignore', 'pipe', 'ignore'] }).stdout;
  return { dir, home, bin, ssh, archive };
}
// Every file under dir (links skipped): none may hold the password.
async function files(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await files(p)); else if (!(await lstat(p)).isSymbolicLink()) out.push(p);
  }
  return out;
}
async function noPassword(dir, events) {
  // p@ss: a piece no quoting changes, so a shell-quoted copy is found too.
  assert.ok(!JSON.stringify(events).includes('p@ss'), 'an event carries the password');
  for (const f of await files(dir)) assert.ok(!(await read(f)).includes('p@ss'), 'the password is in ' + path.relative(dir, f));
}
const COMMAND = 'apt-get update; apt-get install -y git systemd coreutils tar gzip util-linux curl';

test('I2: tools missing before the unpack (no tar): the need list and the exact command, nothing unpacked; the password installs them, then P9', { skip, timeout: 60000 }, async () => {
  const s = await bare(), events = [];
  const stop = await installRemote({ host: 'test-host', ssh: s.ssh, archive: s.archive(), tell: (e) => events.push(e) });
  assert.equal(stop.phase, 'admin', JSON.stringify(stop));
  assert.equal(stop.command, COMMAND);
  assert.ok(stop.need.some((l) => /^tar: /.test(l)) && stop.need.some((l) => /^git: /.test(l)), stop.need.join('\n'));
  assert.ok(!existsSync(path.join(s.home, 'p9')), 'nothing unpacked before the tools are there');
  assert.equal(await read(path.join(s.dir, 'sudo-argv.txt')), '', 'no admin step without the password');
  const done = await installRemote({ host: 'test-host', ssh: s.ssh, archive: s.archive(), admin: PW, tell: (e) => events.push(e) });
  assert.equal(done.phase, 'done', JSON.stringify(done));
  assert.equal(await read(path.join(s.home, 'pw-ok.txt')), 'PW-OK\n', 'install.sh got the password on stdin');
  assert.equal(await read(path.join(s.home, 'args.txt')), 'ARGS --headless --background --admin-stdin\n');
  // Fix 6: the command sudo ran is the command the window showed, one argument, with the password nowhere near it.
  const calls = (await read(path.join(s.dir, 'sudo-argv.txt'))).split('---\n').filter(Boolean).map((c) => c.trimEnd().split('\n'));
  const ran = calls.filter((c) => c.includes('sh'));
  assert.equal(ran.length, 1, JSON.stringify(calls));
  assert.equal(ran[0].at(-1), stop.command);
  assert.equal(ran[0].at(-2), 'p9-admin');
  assert.equal(await read(path.join(s.dir, 'apt-stdin.txt')), '', 'the admin command reads nothing from the password pipe');
  await noPassword(s.dir, events);
});

test('I2: a wrong password stops at the admin step again, nothing run as admin, nothing unpacked', { skip, timeout: 40000 }, async () => {
  const s = await bare(), events = [];
  const r = await installRemote({ host: 'test-host', ssh: s.ssh, archive: s.archive(), admin: 'not it', tell: (e) => events.push(e) });
  assert.deepEqual({ phase: r.phase, error: r.error }, { phase: 'admin', error: 'wrong-password' });
  assert.equal(await read(path.join(s.dir, 'apt.txt')), '');
  assert.ok(!existsSync(path.join(s.home, 'p9')));
  await noPassword(s.dir, events);
});

test('I2: an account that cannot use sudo: not-allowed, nothing run as admin', { skip, timeout: 40000 }, async () => {
  const s = await bare(), events = [];
  await writeFile(path.join(s.dir, 'not-allowed'), '');
  const r = await installRemote({ host: 'test-host', ssh: s.ssh, archive: s.archive(), admin: PW, tell: (e) => events.push(e) });
  assert.deepEqual({ phase: r.phase, error: r.error }, { phase: 'failed', error: 'not-allowed' });
  assert.equal(await read(path.join(s.dir, 'apt.txt')), '');
  await noPassword(s.dir, events);
});

test('I2: the password is one line of 1 to 1024 characters; anything else is refused before ssh starts', { timeout: 5000 }, async () => {
  for (const bad of ['', 'a\nb', 'a\rb', 'a\0b', 'x'.repeat(1025), 42, null]) assert.equal(PASSWORD(bad), false, JSON.stringify(bad));
  assert.equal(PASSWORD('x'.repeat(1024)), true);
  assert.throws(() => installRemote({ host: 'test-host', ssh: '/nonexistent', admin: 'a\nb' }), /remote-install-password/);
  assert.deepEqual(await remoteMode('test-host', 'keep', '/nonexistent', 'a\nb'), { phase: 'failed' });
  assert.deepEqual(await remoteMode('test-host', 'release', '/nonexistent', PW), { phase: 'failed' }, 'the password is for keep only');
});

test('I2: Keep it running where linger needs an admin: refused with the command, a wrong password, then the password keeps it running', { skip, timeout: 90000 }, async (t) => {
  const s = await stage(true, 'refused', { installed: false });
  t.after(() => stopDaemon(s));
  const { code, out } = await bash(s, ['--headless', '--background']);
  assert.equal(code, 0, out);
  // loginctl: linger for this account only as admin (P9_ROOT, set by the stub sudo).
  await writeFile(path.join(s.bin, 'loginctl'), '#!/bin/sh\n[ "$1" = show-user ] && exit 1\necho "$*" >> "' + s.lingerLog + '"\n[ "$2" = disable-linger ] && exit 0\n'
    + '[ -n "${P9_ROOT:-}" ] && { mkdir -p "' + s.run + '"; exit 0; }\necho "Interactive authentication required." >&2; exit 1\n');
  await sudoStub(s.bin, s.dir);
  const ssh = path.join(s.bin, 'ssh'), me = os.userInfo().username;
  assert.deepEqual(await remoteMode('test-host', 'keep', ssh), { phase: 'refused', command: 'loginctl enable-linger ' + me });
  assert.deepEqual(await remoteMode('test-host', 'keep', ssh, 'not it'), { phase: 'wrong-password' });
  assert.ok(existsSync(path.join(s.runDir, 'background')), 'still in background mode');
  assert.deepEqual(await remoteMode('test-host', 'keep', ssh, PW), { phase: 'ok' });
  assert.match(await read(s.lingerLog), new RegExp('^enable-linger ' + me + '$', 'm'));
  assert.match(await nodeLog(s), /scripts\/install-service\.mjs /);
  assert.ok(!existsSync(path.join(s.runDir, 'background')));
  const calls = (await read(path.join(s.dir, 'sudo-argv.txt'))).split('---\n').filter((c) => c.includes('p9-admin\n'));
  assert.equal(calls.at(-1).trimEnd().split('\n').at(-1), 'loginctl enable-linger ' + me);
  await noPassword(s.dir, []);
});

// Row 61 (commit C): the wizard's Install on this computer. adminLocal runs deps.mjs's command less its sudo, through the same
// p9_admin; sh is a wrapper that puts the stub sudo and apt-get first on PATH.
async function local() {
  const s = await bare(), sh = path.join(s.dir, 'sh-here');
  await writeFile(sh, '#!/bin/sh\nPATH="' + s.bin + '"; export PATH\nexec ' + real('sh') + ' "$@"\n');
  await chmod(sh, 0o755);
  return { ...s, sh };
}
test('Row 61: the wizard password installs the package: the command shown less sudo, the password nowhere', { skip, timeout: 30000 }, async () => {
  const s = await local();
  assert.deepEqual(await adminLocal('sudo apt-get install -y tmux', PW, s.sh), { ok: true });
  assert.match(await read(path.join(s.dir, 'apt.txt')), /^install -y tmux$/m);
  const ran = (await read(path.join(s.dir, 'sudo-argv.txt'))).split('---\n').filter((c) => c.includes('p9-admin\n'));
  assert.equal(ran.at(-1).trimEnd().split('\n').at(-1), 'apt-get install -y tmux');
  assert.equal(await read(path.join(s.dir, 'apt-stdin.txt')), '');
  await noPassword(s.dir, []);
});
test('Row 61: a wrong password or an account without sudo runs nothing; only tmux or ssh and one password string pass', { skip, timeout: 30000 }, async () => {
  const s = await local();
  assert.deepEqual(await adminLocal('sudo apt-get install -y tmux', 'not it', s.sh), { error: 'wrong-password' });
  await writeFile(path.join(s.dir, 'not-allowed'), '');
  assert.deepEqual(await adminLocal('sudo apt-get install -y tmux', PW, s.sh), { error: 'not-allowed' });
  assert.equal(await read(path.join(s.dir, 'apt.txt')), '');
  assert.deepEqual(await adminLocal('apt-get install -y tmux', PW, s.sh), { error: 'admin-refused' }, 'deps.mjs commands start with sudo');
  for (const bad of [['sandbox', 'x'], ['libatomic1', 'x'], ['ssh', 'a\nb'], ['ssh', ''], ['ssh', 'x', 'id'], ['tmux'], 'tmux', null]) assert.equal(adminArgs(bad), false, JSON.stringify(bad));
  assert.equal(adminArgs(['ssh', PW]), true);
});
