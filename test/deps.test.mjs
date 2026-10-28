// Item 15 (threat model row 61): deps.mjs's table. The AppArmor rule's command round-trips through the shell exactly
// (a path P9 cannot quote is refused), and scripts/deps.mjs exits 3 only when P9 cannot run without what is missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { dependencies, placeTmux, profileText, sandboxDependency, PROFILE, TMUX_SHA256 } from '../apps/server/deps.mjs';
import { root } from './helpers.mjs';

const linux = process.platform === 'linux';
const restricted = (profile) => async (file) => {
  if (file === '/proc/sys/kernel/apparmor_restrict_unprivileged_userns') return '1\n';
  if (file === PROFILE && profile !== undefined) return profile;
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
};

test('Item 15 (row 61): the sandbox rule names this Electron only, and its command prints exactly that rule', { skip: !linux, timeout: 60000 }, async (t) => {
  for (const electron of ['/srv/p9/p9/node_modules/electron/dist/electron', "/opt/it's p9/my copy/node_modules/electron/dist/electron"]) {
    const missing = await sandboxDependency({ electron, read: restricted() });
    assert.deepEqual([missing.id, missing.ok, missing.admin], ['sandbox', false, true]);
    assert.match(profileText(electron), /^profile p9-electron "[^"]+" flags=\(unconfined\) \{\n {2}userns,\n\}\n$/m);
    const [printf, rest] = missing.command.split(' | ');
    assert.equal(rest, `sudo tee ${PROFILE} >/dev/null && sudo apparmor_parser -r ${PROFILE}`);
    assert.equal(execFileSync('sh', ['-c', printf]).toString(), profileText(electron), electron);
    // The rule already there, exactly: nothing to do. Another text (an older P9, or the clone moved): written again.
    const on = async () => ['brave.14', 'p9-electron.7'];
    assert.deepEqual(Object.values(await sandboxDependency({ electron, read: restricted(profileText(electron)), loaded: on })).slice(1, 3), [true, false]);
    // The file written but never loaded (apparmor_parser failed): still missing, so install.sh says so instead of passing.
    assert.equal((await sandboxDependency({ electron, read: restricted(profileText(electron)), loaded: async () => ['p9-electron-old.2'] })).ok, false);
    assert.equal((await sandboxDependency({ electron, read: restricted(profileText('/elsewhere/electron')), loaded: on })).ok, false);
    assert.equal((await sandboxDependency({ electron, read: async () => '0\n' })).command, null, 'a kernel that does not restrict userns needs no rule');
  }
  for (const electron of ['/a"b/electron', '/a\\b/electron', '/a\nb/electron', '/a\rb/electron', '/a\x00b/electron',
    '/a*b/electron', '/a?b/electron', '/a[b]/electron', '/a{b}/electron', '/a^b/electron']) {
    assert.throws(() => profileText(electron), /profile-path-refused/, JSON.stringify(electron));
  }
  // pnpm's layout: node_modules/electron is a link, and AppArmor attaches by the real path (CI run 40614561848). The rule
  // names the clone's real folder (here reached through a link, as a clone under a linked home is) and pnpm's real
  // layout, its version a glob, and it is the same before Electron is downloaded (a new install asks first) and after.
  const top = await realpath(await mkdtemp(path.join(os.tmpdir(), 'p9-pnpm-')));
  t.after(() => rm(top, { recursive: true, force: true }));
  const clone = path.join(top, 'clone'), linked = path.join(top, 'linked');
  await mkdir(path.join(clone, 'node_modules'), { recursive: true });
  await symlink(clone, linked);
  const electron = path.join(linked, 'node_modules/electron/dist/electron');
  const before = profileText(electron);
  assert.match(before, new RegExp('^profile p9-electron "' + clone + '/node_modules/\\.pnpm/electron@\\*/node_modules/electron/dist/electron" ', 'm'));
  const dist = path.join(clone, 'node_modules/.pnpm/electron@44.7.2/node_modules/electron/dist');
  await mkdir(dist, { recursive: true });
  await writeFile(path.join(dist, 'electron'), '');
  await symlink('.pnpm/electron@44.7.2/node_modules/electron', path.join(clone, 'node_modules/electron'));
  assert.equal(profileText(electron), before, 'the downloaded Electron needs no new rule');
  console.log('PASS item 15 sandbox rule: two paths round-trip through sh exactly; ten unquotable paths refused; a pnpm link names the real file');
});

test('Item 15: dependencies() gives each missing system package its reason and its manager\'s command; Windows has none', { timeout: 60000 }, async (t) => {
  const empty = await mkdtemp(path.join(os.tmpdir(), 'p9-deps-'));
  t.after(() => rm(empty, { recursive: true, force: true }));
  const manager = { name: 'apt', command: 'sudo apt-get update; sudo apt-get install -y' };
  const list = await dependencies({ platform: 'linux', env: { PATH: empty }, home: empty, manager, desktop: false });
  assert.deepEqual(list.map((x) => [x.id, x.ok, x.admin, x.command]), [['claude', false, false, null], ['codex', false, false, null],
    ['tmux', false, true, 'sudo apt-get update; sudo apt-get install -y tmux'], ['ssh', false, true, 'sudo apt-get update; sudo apt-get install -y openssh-client']]);
  assert.ok(list.every((x) => x.why.length > 20), 'every item says why');
  assert.deepEqual((await dependencies({ platform: 'linux', env: { PATH: empty }, home: empty, manager: null, desktop: false })).filter((x) => x.admin).map((x) => x.command), [null, null]);
  assert.deepEqual((await dependencies({ platform: 'win32', env: { PATH: empty }, home: empty })).map((x) => x.id), ['claude', 'codex']);
});

test('Item 15: scripts/deps.mjs exits 3 only when P9 cannot run without what is missing (install.sh tells that from a failed check)', { skip: !linux, timeout: 60000 }, async (t) => {
  const empty = await mkdtemp(path.join(os.tmpdir(), 'p9-deps-'));
  t.after(() => rm(empty, { recursive: true, force: true }));
  const run = (...args) => spawnSync(process.execPath, ['scripts/deps.mjs', '--headless', ...args], { cwd: root, env: { PATH: empty, HOME: empty } });
  const missing = run();
  assert.equal(missing.status, 3, missing.stderr.toString());
  assert.match(missing.stdout.toString(), /^- tmux: P9's terminals run inside tmux[^\n]*\n- ssh: Remote mode[^\n]*\n$/);
  const command = run('--command').stdout.toString().trim();
  assert.ok(command === '' || /^sudo .*install.* tmux .*openssh/.test(command), command);
  // Only ssh missing: P9 still runs, so the install goes on (0) after asking.
  const some = await mkdtemp(path.join(os.tmpdir(), 'p9-deps-'));
  t.after(() => rm(some, { recursive: true, force: true }));
  execFileSync('sh', ['-c', `printf '#!/bin/sh\\n' > "${some}/tmux" && chmod 755 "${some}/tmux"`]);
  const sshOnly = spawnSync(process.execPath, ['scripts/deps.mjs', '--headless'], { cwd: root, env: { PATH: some, HOME: empty } });
  assert.deepEqual([sshOnly.status, sshOnly.stdout.toString().split('\n')[0].slice(0, 6)], [0, '- ssh:']);
});

test('Item 15 (row 60): tmux comes from P9\'s pinned build with no admin password; a failed or changed download places nothing', { timeout: 60000 }, async (t) => {
  const bin = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-tmux-')), 'bin');
  t.after(() => rm(path.dirname(bin), { recursive: true, force: true }));
  const bytes = Buffer.from('a static tmux');
  const sums = { x64: createHash('sha256').update(bytes).digest('hex') };
  const urls = [];
  const serve = (body, ok = true) => async (url) => { urls.push(url); return new Response(body, { status: ok ? 200 : 404 }); };
  assert.equal(await placeTmux({ arch: 'x64', bin, sums, get: serve('a changed tmux') }), 'checksum-mismatch');
  assert.equal(await placeTmux({ arch: 'x64', bin, sums, get: serve(bytes, false) }), 'download-failed');
  assert.equal(await placeTmux({ arch: 'x64', bin, sums, get: async () => { throw new Error('offline'); } }), 'download-failed');
  assert.equal(await placeTmux({ arch: 'riscv64', bin, sums, get: serve(bytes) }), 'no-build');
  await assert.rejects(stat(path.join(bin, 'tmux')), /ENOENT/, 'nothing placed until the bytes match');
  assert.equal(await placeTmux({ arch: 'x64', bin, sums, get: serve(bytes) }), 'placed');
  assert.deepEqual([(await readFile(path.join(bin, 'tmux'))).equals(bytes), (await stat(path.join(bin, 'tmux'))).mode & 0o777], [true, 0o755]);
  assert.equal(urls[0], 'https://github.com/JudgeBreddd/P9/releases/download/deps-tmux-3.8/tmux-linux-x64');
  assert.deepEqual(Object.keys(TMUX_SHA256), ['x64', 'arm64']);
  // A server update imports scripts/deps.mjs for ensureDependencies() (apps/server/update.mjs): the import prints nothing.
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e',
    'const m = await import(process.argv[1]); console.log(typeof m.ensureDependencies);', pathToFileURL(path.join(root, 'scripts/deps.mjs')).href]);
  assert.equal(imported.stdout.toString(), 'function\n', imported.stderr.toString());
  console.log('PASS item 15 tmux: mismatch, 404, offline and an unknown arch place nothing; matching bytes placed 0755; scripts/deps.mjs imports clean');
});

test('Item 15: a server update\'s check (update.mjs) leaves the agents\' launchers alone and answers on its last line', { skip: !linux, timeout: 60000 }, async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-deps-update-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  // The launcher the daemon wrote for its own tree; tmux on PATH, so nothing is downloaded.
  const bin = path.join(home, '.local', 'share', 'p9', 'bin');
  const tools = path.join(home, 'tools');
  await mkdir(bin, { recursive: true });
  await mkdir(tools);
  await writeFile(path.join(bin, 'claude'), '#!/bin/sh\necho the daemon\'s own\n', { mode: 0o755 });
  await writeFile(path.join(tools, 'tmux'), '#!/bin/sh\n', { mode: 0o755 });
  // update.mjs's own call, from a build folder, naming the checkout's Electron (none here: a headless checkout).
  const checked = spawnSync(process.execPath, ['--input-type=module', '-e',
    'const { ensureDependencies } = await import(process.argv[1]); process.stdout.write("\\n" + JSON.stringify(await ensureDependencies({ electron: process.argv[2] })) + "\\n");',
    pathToFileURL(path.join(root, 'scripts/deps.mjs')).href, path.join(home, 'source', 'node_modules', 'electron', 'dist', 'electron')],
  { env: { ...process.env, HOME: home, PATH: tools + path.delimiter + process.env.PATH }, timeout: 30000 });
  assert.equal(checked.status, 0, checked.stderr.toString());
  const result = JSON.parse(checked.stdout.toString().trim().split('\n').at(-1));
  assert.deepEqual(result.placed, []);
  assert.ok(Array.isArray(result.missing) && !result.missing.some((m) => m.id === 'sandbox' || m.id === 'tmux'), JSON.stringify(result));
  assert.equal(await readFile(path.join(bin, 'claude'), 'utf8'), '#!/bin/sh\necho the daemon\'s own\n', 'a launcher pointed at the build folder breaks when a failed update removes it');
  console.log('PASS item 15 update check: launcher untouched, no Electron at the checkout so no sandbox ask, JSON on the last line');
});
