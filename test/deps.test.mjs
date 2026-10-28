// Item 15 (threat model row 61): deps.mjs's table. The AppArmor rule's command round-trips through the shell exactly
// (a path P9 cannot quote is refused), and scripts/deps.mjs exits 3 only when P9 cannot run without what is missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dependencies, profileText, sandboxDependency, PROFILE } from '../apps/server/deps.mjs';
import { root } from './helpers.mjs';

const linux = process.platform === 'linux';
const restricted = (profile) => async (file) => {
  if (file === '/proc/sys/kernel/apparmor_restrict_unprivileged_userns') return '1\n';
  if (file === PROFILE && profile !== undefined) return profile;
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
};

test('Item 15 (row 61): the sandbox rule names this Electron only, and its command prints exactly that rule', { skip: !linux, timeout: 60000 }, async () => {
  for (const electron of ['/srv/p9/p9/node_modules/electron/dist/electron', "/opt/it's p9/my copy/node_modules/electron/dist/electron"]) {
    const missing = await sandboxDependency({ electron, read: restricted() });
    assert.deepEqual([missing.id, missing.ok, missing.admin], ['sandbox', false, true]);
    assert.match(profileText(electron), /^profile p9-electron "[^"]+" flags=\(unconfined\) \{\n {2}userns,\n\}\n$/m);
    const [printf, rest] = missing.command.split(' | ');
    assert.equal(rest, `sudo tee ${PROFILE} >/dev/null && sudo apparmor_parser -r ${PROFILE}`);
    assert.equal(execFileSync('sh', ['-c', printf]).toString(), profileText(electron), electron);
    // The rule already there, exactly: nothing to do. Another text (an older P9, or the clone moved): written again.
    assert.deepEqual(Object.values(await sandboxDependency({ electron, read: restricted(profileText(electron)) })).slice(1, 3), [true, false]);
    assert.equal((await sandboxDependency({ electron, read: restricted(profileText('/elsewhere/electron')) })).ok, false);
    assert.equal((await sandboxDependency({ electron, read: async () => '0\n' })).command, null, 'a kernel that does not restrict userns needs no rule');
  }
  for (const electron of ['/a"b/electron', '/a\\b/electron', '/a\nb/electron', '/a\rb/electron', '/a\x00b/electron']) {
    assert.throws(() => profileText(electron), /profile-path-refused/, JSON.stringify(electron));
  }
  console.log('PASS item 15 sandbox rule: two paths round-trip through sh exactly; five unquotable paths refused');
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
  assert.match(missing.stdout.toString(), /^- tmux: P9's terminals run inside tmux[^\n]*\n- ssh: Server mode[^\n]*\n$/);
  const command = run('--command').stdout.toString().trim();
  assert.ok(command === '' || /^sudo .*install.* tmux .*openssh/.test(command), command);
  // Only ssh missing: P9 still runs, so the install goes on (0) after asking.
  const some = await mkdtemp(path.join(os.tmpdir(), 'p9-deps-'));
  t.after(() => rm(some, { recursive: true, force: true }));
  execFileSync('sh', ['-c', `printf '#!/bin/sh\\n' > "${some}/tmux" && chmod 755 "${some}/tmux"`]);
  const sshOnly = spawnSync(process.execPath, ['scripts/deps.mjs', '--headless'], { cwd: root, env: { PATH: some, HOME: empty } });
  assert.deepEqual([sshOnly.status, sshOnly.stdout.toString().split('\n')[0].slice(0, 6)], [0, '- ssh:']);
});
