// Phase 13: install-path fixes from the README cold read.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { root } from './helpers.mjs';
import { startEditorHost } from '../apps/desktop/editor-host.mjs';

test('Phase 13: an editor host that is not the pinned VSCodium commit is refused before it starts', { skip: process.platform !== 'linux' }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-wrong-host-'));
  await mkdir(path.join(dir, 'bin'));
  await writeFile(path.join(dir, 'product.json'), '{"commit":"0000000000000000000000000000000000000000"}');
  await writeFile(path.join(dir, 'bin', 'codium-server'), '#!/bin/sh\ntouch ' + path.join(dir, 'ran') + '\n');
  await chmod(path.join(dir, 'bin', 'codium-server'), 0o755);
  await assert.rejects(startEditorHost({ host: dir, data: path.join(dir, 'data') }), /editor-host-commit-mismatch/);
  assert.ok(!existsSync(path.join(dir, 'ran')));
});

test('Phase 13: a unit that fails to start is removed, so the installer can be run again', { skip: process.platform !== 'linux' }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-install-home-')), bin = path.join(home, 'bin'), workspace = path.join(home, 'ws');
  await mkdir(bin); await mkdir(workspace);
  // Stand-in systemctls that fail "enable --now", the way a unit that cannot start does, or the first
  // "daemon-reload", the way an unavailable user manager does (release r2 R2-10).
  for (const fails of ['enable', 'daemon-reload']) {
    await writeFile(path.join(bin, 'systemctl'), '#!/bin/sh\ncase "$*" in *' + fails + '*) [ -e "$HOME/failed-' + fails + '" ] || { touch "$HOME/failed-' + fails + '"; exit 1; } ;; esac\n'
      + 'case "$*" in *enable*) exit 1;; esac\nexit 0\n');
    await chmod(path.join(bin, 'systemctl'), 0o755);
    const env = { ...process.env, HOME: home, XDG_RUNTIME_DIR: home, PATH: bin + ':' + process.env.PATH };
    const unit = path.join(home, '.config', 'systemd', 'user', 'p9-foundation.service');
    for (const attempt of [1, 2]) {
      const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'install-service.mjs'), workspace], { env, encoding: 'utf8' });
      assert.notEqual(result.status, 0, 'attempt ' + attempt);
      assert.doesNotMatch(result.stderr, /EEXIST/, 'attempt ' + attempt + ' was refused by the leftover unit');
      assert.ok(!existsSync(unit), fails + ' attempt ' + attempt + ' left the unit behind');
    }
  }
});

test('Phase 13: a unit that starts but whose daemon never answers is removed too', { skip: process.platform !== 'linux' }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-install-home-')), bin = path.join(home, 'bin'), workspace = path.join(home, 'ws');
  await mkdir(bin); await mkdir(workspace); await mkdir(path.join(home, 'run'));
  // systemctl succeeds at everything, the way a daemon that crashes after start looks to "enable --now".
  // It also keeps a copy of the unit as written, before the installer removes it.
  await writeFile(path.join(bin, 'systemctl'), '#!/bin/sh\ncp "$HOME/.config/systemd/user/p9-foundation.service" "$HOME/unit.copy" 2>/dev/null\nexit 0\n');
  await chmod(path.join(bin, 'systemctl'), 0o755);
  const env = { ...process.env, HOME: home, XDG_RUNTIME_DIR: path.join(home, 'run'), PATH: bin + ':' + process.env.PATH };
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'install-service.mjs'), workspace], { env, encoding: 'utf8' });
  // The unit carries the installer's PATH, so tmux and agent CLIs found here are found by the service (R1-10).
  assert.ok(readFileSync(path.join(home, 'unit.copy'), 'utf8').includes('\nEnvironment="PATH=' + bin + ':'));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /daemon-not-answering/);
  assert.doesNotMatch(result.stdout, /P9_SERVICE_INSTALLED/);
  assert.ok(!existsSync(path.join(home, '.config', 'systemd', 'user', 'p9-foundation.service')));
});

// Release r2 R2-1: every module the desktop app loads ships in app.asar, and the Job script it hands PowerShell
// is the daemon's unpacked copy, which extraResources ships.
test('release r2 R2-1: build.files covers every module the desktop imports; the host script resolves outside app.asar', async () => {
  const { build } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const shipped = (file) => build.files.some((entry) => entry.endsWith('/**') ? file.startsWith(entry.slice(0, -2)) : file === entry);
  const seen = new Set(), queue = ['apps/desktop/main.mjs'];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    assert.ok(shipped(file), file + ' is imported by the desktop app but not in build.files');
    for (const [, spec] of readFileSync(path.join(root, file), 'utf8').matchAll(/from '(\.{1,2}\/[^']+)'/g)) queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)));
  }
  const { hostScript } = await import('../apps/server/process-tree.mjs');
  const packed = hostScript('file:///p9/resources/app.asar/apps/server/process-tree.mjs');
  assert.equal(packed, '/p9/resources/daemon/scripts/windows-host.ps1');
  assert.ok(build.extraResources.some(({ from, to }) => from === 'scripts/windows-host.ps1' && to === 'daemon/scripts/windows-host.ps1'));
  console.log('PASS R2-1: ' + seen.size + ' desktop modules all in build.files; packaged host script is ' + packed);
});

// Release r2 R2-6 / R2-8, as text: no PowerShell or NSIS here, so the Windows install itself proves them (passdown).
test('release r2 R2-6/R2-8: an update keeps the task and its workspace; the task runs on battery', () => {
  const nsh = readFileSync(path.join(root, 'scripts', 'installer.nsh'), 'utf8'), ps1 = readFileSync(path.join(root, 'scripts', 'install-windows.ps1'), 'utf8');
  const install = nsh.slice(nsh.indexOf('!macro customInstall'), nsh.indexOf('!macroend')), uninstall = nsh.slice(nsh.indexOf('!macro customUnInstall'));
  assert.doesNotMatch(install.split('\n').find((line) => line.includes('nsExec')), /-Workspace/, 'the installer must not reset the workspace');
  assert.match(uninstall, /\$\{ifNot\} \$\{isUpdated\}[^]*Unregister-ScheduledTask[^]*\$\{endIf\}/, 'an update must not unregister the task');
  assert.doesNotMatch(uninstall.slice(0, uninstall.indexOf('${ifNot}')), /Unregister-ScheduledTask/);
  assert.match(ps1, /Get-ScheduledTask -TaskName 'P9 Foundation'[^]*'--workspace'/, 'no -Workspace reads the installed task');
  assert.match(ps1, /New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries /);
  console.log('PASS R2-6/R2-8 (text): installer keeps the task workspace on update; task allowed on battery');
});

// scripts/install.sh, the one-command Linux install, run against stand-in tools: a PATH that holds only the stubs
// below and the three coreutils it needs, so a tool on the real machine cannot hide a missing one.
test('install.sh: checks tools and Node, then installs, builds and starts the service in that order', { skip: process.platform !== 'linux' }, async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-install-sh-')), bin = path.join(home, 'bin'), log = path.join(home, 'log');
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(bin);
  for (const tool of ['realpath', 'dirname', 'mkdir']) {
    await symlink(['/usr/bin/', '/bin/'].map((dir) => dir + tool).find(existsSync), path.join(bin, tool));
  }
  const stub = (name, body) => writeFile(path.join(bin, name), '#!/bin/sh\n' + body + '\n', { mode: 0o755 });
  for (const tool of ['git', 'npm', 'tmux', 'systemctl', 'systemd-run', 'curl', 'sha256sum', 'tar']) await stub(tool, 'exit 0');
  await stub('node', '[ "$1" = --version ] && { echo "${FAKE_NODE:-v26.10.0}"; exit 0; }\necho "node $*" >> ' + log);
  await stub('pnpm', 'echo "pnpm $*" >> ' + log);
  const run = (env = {}) => {
    rmSync(log, { force: true });
    const result = spawnSync('/bin/bash', [path.join(root, 'scripts', 'install.sh'), 'ws'],
      { cwd: home, encoding: 'utf8', env: { HOME: home, XDG_RUNTIME_DIR: home, PATH: bin, ...env } });
    return { ...result, log: existsSync(log) ? readFileSync(log, 'utf8') : '' };
  };

  const ok = run();
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(ok.log, 'pnpm install --frozen-lockfile\npnpm build\nnode scripts/install-service.mjs ' + path.join(home, 'ws') + '\n');
  assert.ok(existsSync(path.join(home, 'ws')), 'workspace folder made');

  const oldNode = run({ FAKE_NODE: 'v24.19.0' });
  assert.equal(oldNode.status, 1);
  assert.match(oldNode.stdout, /needs Node v26\.10\.0, found 'v24\.19\.0'/);
  assert.equal(oldNode.log, '', 'nothing installed with the wrong Node');

  await rm(path.join(bin, 'tmux'));
  const noTmux = run();
  assert.equal(noTmux.status, 1);
  assert.match(noTmux.stdout, /MISSING: tmux\b/);
  assert.equal(noTmux.log, '', 'nothing installed with a tool missing');
  await stub('tmux', 'exit 0');

  // No pnpm and a global npm install that needs root: the ~/.local fallback is used and the run carries on.
  await rm(path.join(bin, 'pnpm'));
  await stub('npm', 'case "$*" in *--prefix*) mkdir -p "$HOME/.local/bin"; printf \'#!/bin/sh\\necho "pnpm $*" >> ' + log + '\\n\' > "$HOME/.local/bin/pnpm"; chmod +x "$HOME/.local/bin/pnpm";; *) exit 1;; esac');
  await symlink(['/usr/bin/chmod', '/bin/chmod'].find(existsSync), path.join(bin, 'chmod'));
  const fallback = run();
  assert.equal(fallback.status, 0, fallback.stdout + fallback.stderr);
  assert.match(fallback.log, /^pnpm install --frozen-lockfile\npnpm build\n/);

  await mkdir(path.join(home, '.config', 'systemd', 'user'), { recursive: true });
  await writeFile(path.join(home, '.config', 'systemd', 'user', 'p9-foundation.service'), '');
  const again = run();
  assert.equal(again.status, 0);
  assert.match(again.stdout, /already installed/);
  assert.equal(again.log, '', 'an existing install is left alone');
});
