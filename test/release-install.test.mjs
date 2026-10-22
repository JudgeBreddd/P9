// Phase 13: install-path fixes from the README cold read.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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
  // The agent packages ship once, in the daemon (extraResources); a second copy in app.asar made the installer 608 MB.
  const left = build.files.filter((entry) => entry.startsWith('!node_modules/')).map((entry) => entry.slice('!node_modules/'.length, -'/**'.length));
  assert.deepEqual(left, ['@openai', '@anthropic-ai', '@agentclientprotocol']);
  const seen = new Set(), queue = ['apps/desktop/main.mjs'];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    assert.ok(shipped(file), file + ' is imported by the desktop app but not in build.files');
    const text = readFileSync(path.join(root, file), 'utf8');
    for (const [, spec] of text.matchAll(/(?:from |import\(|require\()'([^'.][^']*)'/g)) assert.ok(!left.some((scope) => spec.startsWith(scope + '/')), file + ' imports ' + spec + ', which build.files leaves out of app.asar');
    for (const [, spec] of text.matchAll(/from '(\.{1,2}\/[^']+)'/g)) queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)));
  }
  const { hostScript } = await import('../apps/server/process-tree.mjs');
  const packed = hostScript('file:///p9/resources/app.asar/apps/server/process-tree.mjs');
  assert.equal(packed, '/p9/resources/daemon/scripts/windows-host.ps1');
  assert.ok(build.extraResources.some(({ from, to }) => from === 'scripts/windows-host.ps1' && to === 'daemon/scripts/windows-host.ps1'));
  // electron-builder leaves a file an extraResources entry names out of app.asar (CI 2026-10-22 lost package.json).
  for (const { from } of build.extraResources) assert.ok(!shipped(from), from + ' is in build.files and extraResources, so app.asar loses it');
  console.log('PASS R2-1: ' + seen.size + ' desktop modules all in build.files; packaged host script is ' + packed);
});

// Release r2 R2-6 / R2-8, as text: no PowerShell or NSIS here, so the Windows install itself proves them (passdown).
test('release r2 R2-6/R2-8: an update keeps the task and its workspace; the task runs on battery', () => {
  const nsh = readFileSync(path.join(root, 'scripts', 'installer.nsh'), 'utf8'), ps1 = readFileSync(path.join(root, 'scripts', 'install-windows.ps1'), 'utf8');
  const install = nsh.slice(nsh.indexOf('!macro customInstall'), nsh.indexOf('!macroend')), uninstall = nsh.slice(nsh.indexOf('!macro customUnInstall'));
  assert.doesNotMatch(install.split('\n').find((line) => line.includes('nsExec')), /-Workspace/, 'the installer must not reset the workspace');
  assert.match(uninstall, /\$\{ifNot\} \$\{isUpdated\}[^]*Unregister-ScheduledTask[^]*\$\{endIf\}/, 'an update must not unregister the task');
  assert.doesNotMatch(uninstall.slice(0, uninstall.indexOf('${ifNot}')), /Unregister-ScheduledTask/);
  // Stop-ScheduledTask ends only conhost.exe; the daemon outlived it (GitHub run 39540753837), so the uninstaller ends its node.exe.
  assert.match(uninstall.slice(0, uninstall.indexOf('${ifNot}')), /Stop-ScheduledTask[^\n]*\$\$_\.ExecutablePath -eq '\$INSTDIR\\resources\\daemon\\node\.exe'[^\n]*Stop-Process/, 'the uninstaller ends the daemon itself');
  // A silent install (/S) still shows a MessageBox with no /SD and waits for a click nobody can give. /SD goes after the text:
  // before it, makensis takes the text for a jump label and the build fails (GitHub run 39527149502).
  for (const box of nsh.split('\n').filter((line) => /^\s*MessageBox /.test(line))) assert.match(box, /"\s+\/SD ID\w+\s*$/, 'silent default, after the text (NSIS reads text after /SD as a jump label): ' + box.trim());
  // The installer is 32-bit: with redirection on, $SYSDIR's PowerShell is the 32-bit one, not the one a user opens.
  for (const part of [install, uninstall]) assert.match(part, /^[^]*?\$\{DisableX64FSRedirection\}[^]*nsExec[^]*\$\{EnableX64FSRedirection\}/, 'every PowerShell call runs with WOW64 redirection off');
  for (const part of [install, uninstall]) assert.ok(part.indexOf('${DisableX64FSRedirection}') < part.indexOf('nsExec'), 'redirection goes off before the first PowerShell call');
  // Windows PowerShell under a PowerShell 7 parent loads 7's modules and fails (GitHub run 39535290300: no task).
  assert.ok(ps1.search(/PSModulePath = .*-notmatch '\\\\PowerShell\\\\'/) >= 0 && ps1.search(/PSModulePath =/) < ps1.indexOf('Register-ScheduledTask'), "7's module folders leave PSModulePath before the task is registered");
  // Issue #6 B1: Set-Acl threw PrivilegeNotHeldException for a standard user over an earlier install; icacls, checked, instead.
  assert.doesNotMatch(ps1, /^[^#\n]*Set-Acl/m, 'no Set-Acl outside comments');
  assert.match(ps1, /icacls\.exe \$root \/inheritance:r \/grant:r \('\*' \+ \$sid \+ ':\(OI\)\(CI\)F'\)[^\n]*\n\s*if \(\$LASTEXITCODE -ne 0\) \{ throw/, 'owner-only through icacls, exit code checked');
  assert.match(ps1, /Get-ScheduledTask -TaskName 'P9 Foundation'[^]*'--workspace'/, 'no -Workspace reads the installed task');
  // Issue #6 B7: a task with no --workspace gave IndexOf -1, so argv[0] (node.exe) became the workspace.
  assert.doesNotMatch(ps1, /IndexOf\([^)]*'--workspace'\) \+ 1/);
  assert.match(ps1, /if \(\$i -ge 0\) \{ \$Workspace = \$old\.argv\[\$i \+ 1\] \}\s*\}\s*if \(-not \$Workspace\)/, 'no --workspace falls back to the new default');
  // Issue #6 B6 and B4: timestamped lines and the failing line in service-install.log; the task's daemon writes daemon.log.
  assert.match(ps1, /^trap \{ Say \('failed at line '/m);
  assert.match(ps1, /'-Mode', 'Daemon', '-Log', \('"' \+ \$log \+ '"'\)/);
  // Issue #6 B10: the installer stops the old task and daemon before it replaces files, as the uninstaller does.
  const init = nsh.slice(nsh.indexOf('!macro customInit'));
  assert.match(init, /^[^]*?\$\{DisableX64FSRedirection\}[^]*nsExec[^\n]*Stop-ScheduledTask[^\n]*\$\$_\.ExecutablePath -eq '\$INSTDIR\\resources\\daemon\\node\.exe'[^\n]*Stop-Process[^]*\$\{EnableX64FSRedirection\}/);
  assert.match(ps1, /New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries /);
  console.log('PASS R2-6/R2-8 (text): installer keeps the task workspace on update; task allowed on battery');
});

// scripts/install.sh, the one-command Linux install, run against stand-in tools: a PATH that holds only the stubs
// below and the coreutils it needs, so a tool on the real machine cannot hide a missing one.
test('install.sh: checks tools and Node, then installs, builds and starts the service in that order', { skip: process.platform !== 'linux' }, async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-install-sh-')), bin = path.join(home, 'bin'), log = path.join(home, 'log');
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(bin);
  for (const tool of ['realpath', 'dirname', 'mkdir', 'mktemp', 'mv', 'rm', 'rmdir', 'chmod']) {
    await symlink(['/usr/bin/', '/bin/'].map((dir) => dir + tool).find(existsSync), path.join(bin, tool));
  }
  const stub = (name, body) => writeFile(path.join(bin, name), '#!/bin/sh\n' + body + '\n', { mode: 0o755 });
  for (const tool of ['git', 'npm', 'tmux', 'systemctl', 'systemd-run']) await stub(tool, 'exit 0');
  await stub('node', '[ "$1" = --version ] && { echo "${FAKE_NODE:-v26.10.0}"; exit 0; }\necho "node $*" >> ' + log);
  await stub('pnpm', 'echo "pnpm $*" >> ' + log);
  // The Node download: curl writes a file, sha256sum passes only with FAKE_SUM_OK, tar unpacks a node that logs as p9node.
  await stub('uname', 'echo x86_64');
  await stub('curl', 'echo "curl $*" >> ' + log + '\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done\necho tarball > "$out"');
  await stub('sha256sum', 'read line; echo "sha256sum $line" >> ' + log + '\n[ -n "$FAKE_SUM_OK" ]');
  await stub('tar', 'echo "tar" >> ' + log + '\nwhile [ $# -gt 0 ]; do [ "$1" = -C ] && dir=$2; shift; done\nmkdir -p "$dir/node-v26.10.0-linux-x64/bin"\n'
    + 'printf \'#!/bin/sh\\n[ "$1" = --version ] && { echo v26.10.0; exit 0; }\\necho "p9node $*" >> ' + log + '\\n\' > "$dir/node-v26.10.0-linux-x64/bin/node"\n'
    + 'chmod +x "$dir/node-v26.10.0-linux-x64/bin/node"');
  const share = path.join(home, '.local', 'share', 'p9'), ownNode = path.join(share, 'node-v26.10.0-linux-x64');
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

  assert.ok(!ok.log.includes('curl'), 'no download when Node v26.10.0 is already there');

  // Wrong Node: a download that fails its checksum installs nothing and leaves nothing behind.
  const badSum = run({ FAKE_NODE: 'v24.19.0' });
  assert.equal(badSum.status, 1);
  assert.match(badSum.stdout, /does not match its pinned checksum/);
  assert.doesNotMatch(badSum.log, /^(tar|pnpm|p9node|node) ?/m, 'nothing unpacked or installed after a bad checksum');
  assert.deepEqual(readdirSync(share), [], 'no Node and no temp folder left');

  // Wrong Node, good download: P9's own Node is pinned, unpacked, and runs the service install.
  const oldNode = run({ FAKE_NODE: 'v24.19.0', FAKE_SUM_OK: '1' });
  assert.equal(oldNode.status, 0, oldNode.stdout + oldNode.stderr);
  assert.match(oldNode.log, new RegExp('^curl -fsSL -o \\S+/node\\.tar\\.gz https://nodejs\\.org/dist/v26\\.10\\.0/node-v26\\.10\\.0-linux-x64\\.tar\\.gz\n'
    + 'sha256sum cb5c9ce9c80d7b8821e3a258543c71b939138cf17c74d5cc44bbe85d6dbc5ad8  \\S+/node\\.tar\\.gz\ntar\npnpm install --frozen-lockfile\npnpm build\n'
    + 'p9node scripts/install-service\\.mjs ' + path.join(home, 'ws') + '\n$'));
  assert.deepEqual(readdirSync(share), ['node-v26.10.0-linux-x64'], 'temp folder removed');
  assert.ok(oldNode.stdout.includes('export PATH="' + path.join(ownNode, 'bin') + ':$PATH"'), 'PATH line printed');
  const cached = run({ FAKE_NODE: 'v24.19.0' });
  assert.equal(cached.status, 0, cached.stdout + cached.stderr);
  assert.match(cached.log, /^pnpm install --frozen-lockfile\npnpm build\np9node /, 'a second run reuses the downloaded Node');

  await rm(path.join(bin, 'tmux'));
  const noTmux = run();
  assert.equal(noTmux.status, 1);
  assert.match(noTmux.stdout, /MISSING: tmux\b/);
  assert.equal(noTmux.log, '', 'nothing installed with a tool missing');
  await stub('tmux', 'exit 0');

  // No pnpm and a global npm install that needs root: the ~/.local fallback is used and the run carries on.
  await rm(path.join(bin, 'pnpm'));
  await stub('npm', 'case "$*" in *--prefix*) mkdir -p "$HOME/.local/bin"; printf \'#!/bin/sh\\necho "pnpm $*" >> ' + log + '\\n\' > "$HOME/.local/bin/pnpm"; chmod +x "$HOME/.local/bin/pnpm";; *) exit 1;; esac');
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

// The Windows installer carries every licence notice in resources/licenses (package-windows.mjs gathers them).
test('Windows package: licence notices ship in resources/licenses', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.build.extraResources.some((entry) => entry.from === '.build/licenses' && entry.to === 'licenses'), 'licenses folder packaged');
  const pack = readFileSync(path.join(root, 'scripts', 'package-windows.mjs'), 'utf8');
  for (const file of ['LICENSE', 'LICENSES.md', 'third-party/DUWOP-LICENSE.md']) {
    assert.ok(pack.includes("'" + file + "'"), file + ' copied');
    assert.ok(existsSync(path.join(root, file)), file + ' exists');
  }
  assert.match(pack, /node-LICENSE/);
  assert.match(pack, /startsWith\('@fontsource'\)/);
  assert.ok(Object.keys(pkg.devDependencies).filter((name) => name.startsWith('@fontsource')).length >= 10, 'fonts found by the same filter');
  assert.match(readFileSync(path.join(root, 'scripts', 'extract-node-windows.ps1'), 'utf8'), /win-\$Arch\\LICENSE/);
});
