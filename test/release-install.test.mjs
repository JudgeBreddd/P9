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
  // The daemon runs in p9.slice, capped so P9 can only take itself down (default share of RAM when unset).
  assert.ok(readFileSync(path.join(home, 'unit.copy'), 'utf8').includes('\nSlice=p9.slice\n'));
  assert.match(readFileSync(path.join(home, '.config', 'systemd', 'user', 'p9.slice'), 'utf8'), /\nMemoryHigh=25%\nMemoryMax=33%\n/);
  const bad = spawnSync(process.execPath, [path.join(root, 'scripts', 'install-service.mjs'), workspace], { env: { ...env, P9_MEMORY_MAX: '10G\nExecStart=/bin/sh' }, encoding: 'utf8' });
  assert.match(bad.stderr, /invalid-P9_MEMORY_MAX/);
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
  // B10: electron-builder drops a node_modules folder at the top of an extraResources source, so bundleDaemon's needs its own entry.
  assert.ok(build.extraResources.some(({ from, to }) => from === '.build/daemon-extra/node_modules' && to === 'daemon/node_modules'));
  console.log('PASS R2-1: ' + seen.size + ' desktop modules all in build.files; packaged host script is ' + packed);
});

// Release r2 R2-6 / R2-8, as text: no PowerShell or NSIS here, so the Windows install itself proves them (passdown).
test('release r2 R2-6/R2-8: an update keeps the task and its workspace; the task runs on battery', () => {
  const nsh = readFileSync(path.join(root, 'scripts', 'installer.nsh'), 'utf8'), ps1 = readFileSync(path.join(root, 'scripts', 'install-windows.ps1'), 'utf8');
  const install = nsh.slice(nsh.indexOf('!macro customInstall'), nsh.indexOf('!macroend')), uninstall = nsh.slice(nsh.indexOf('!macro customUnInstall'));
  assert.doesNotMatch(install.split('\n').find((line) => line.includes('nsExec')), /-Workspace/, 'the installer must not reset the workspace');
  // arm64 job 119719813897: with no -Node the hook took the runner's node from PATH; a tester's laptop has none.
  assert.match(install.split('\n').find((line) => line.includes('nsExec')), /install-windows\.ps1" -Node "\$INSTDIR\\resources\\daemon\\node\.exe"/, 'an installed build runs its own node.exe');
  // arm64 job 119734051928: 7za's ARM64 filter left node.exe out of the install.
  assert.match(readFileSync(path.join(root, 'scripts', 'package-windows.mjs'), 'utf8'), /arch === 'arm64' \? \{ ELECTRON_BUILDER_7Z_FILTER: 'BCJ2' \}/, 'arm64 installers use a filter NSIS extracts');
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
  // BL7 (v0.1.4 note 5): exact, not a lazy [^]*? that let any line in between pass: from the argv read to the default, the
  // only assignments are the saved folder and the unreadable payload's $null, so no --workspace reaches the default.
  const argvRead = ps1.indexOf('if ($i -ge 0) { $Workspace = $old.argv[$i + 1] }'), noWorkspace = ps1.slice(argvRead, ps1.indexOf('if (-not $Workspace) {', argvRead));
  assert.ok(argvRead >= 0 && noWorkspace.length > 0, 'the argv read comes before the default');
  assert.deepEqual(noWorkspace.match(/\$Workspace = [^;}\n]*/g).map((line) => line.trim()), ['$Workspace = $old.argv[$i + 1]', '$Workspace = $null'], 'no --workspace falls back to the new default');
  // Issue #6 B6 and B4: timestamped lines and the failing line in service-install.log; the task's daemon writes daemon.log.
  assert.match(ps1, /^trap \{ Say \('failed at line '/m);
  // AU4: the installed app's task runs the launcher, which passes -Mode Daemon itself; a source run's runs the host.
  assert.match(ps1, /\$hostArguments = @\('-Mode', 'Daemon'\)[^]*\$hostScript = \$launcher\s+\$hostArguments = @\(\)/);
  assert.match(ps1, /\$hostArguments \+ @\('-Log', \('"' \+ \$log \+ '"'\)/);
  // Issue #6 B10: the installer stops the old task and daemon before it replaces files, as the uninstaller does.
  const init = nsh.slice(nsh.indexOf('!macro customInit'));
  assert.match(init, /^[^]*?\$\{DisableX64FSRedirection\}[^]*nsExec[^\n]*Stop-ScheduledTask[^\n]*\$\$_\.ExecutablePath -eq '\$INSTDIR\\resources\\daemon\\node\.exe'[^\n]*Stop-Process[^]*\$\{EnableX64FSRedirection\}/);
  assert.match(ps1, /New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries /);
  console.log('PASS R2-6/R2-8 (text): installer keeps the task workspace on update; task allowed on battery');
});

// v0.1.3 review findings 1-3 and threat model row 32's Windows half; windows-installer.yaml runs them on Windows.
test('v0.1.4 install-windows.ps1: stops the daemon before re-registering, survives a bad payload, clears only P9 temp folders (text)', () => {
  const nsh = readFileSync(path.join(root, 'scripts', 'installer.nsh'), 'utf8'), ps1 = readFileSync(path.join(root, 'scripts', 'install-windows.ps1'), 'utf8');
  const teh = readFileSync(path.join(root, 'scripts', 'teh.mjs'), 'utf8'), main = readFileSync(path.join(root, 'apps', 'desktop', 'main.mjs'), 'utf8');
  // Finding 1: Register -Force and Start-ScheduledTask left a running daemon on the old folder.
  const stop = ps1.slice(0, ps1.indexOf('Register-ScheduledTask'));
  assert.match(stop, /Stop-ScheduledTask -TaskName 'P9 Foundation'[^]*\$_\.ExecutablePath -eq \$bundled[^]*Stop-Process[^]*Wait-Process/, 'the script ends the bundled daemon before it registers');
  // Finding 2: a payload it cannot read threw, so every reinstall and the app's repair failed.
  assert.match(ps1, /try \{\s*\$old = [^\n]*FromBase64String[^]*\} catch \{[^\n]*\$Workspace = \$null \}\s*\}\s*if \(-not \$Workspace\)/, 'an unreadable payload falls to the default folder');
  // the owner 2026-10-22, Fable review finding 1: a saved folder not there now (an unplugged drive) failed every reinstall with
  // workspace-not-found; replacing it with the default lost it for good. The task keeps it, logged; the daemon falls back.
  assert.match(ps1, /\$Workspace = \$old\.argv\[\$i \+ 1\][^]*if \(\$Workspace -and -not \(Test-Path -LiteralPath \$Workspace -PathType Container\)\) \{\s*Say \('saved workspace ' \+ \$Workspace \+ ' is not there now; the task keeps it[^\n]*\s*\$away = \$true\s*\}\s*\} catch/, 'a missing saved folder stays in the task and is logged');
  assert.match(ps1, /if \(-not \$away -and -not \(Test-Path -LiteralPath \$Workspace -PathType Container\)\) \{ throw 'workspace-not-found' \}/, 'only an explicit -Workspace must exist');
  // Finding 3: any electron-builder installer's folder matched app-64.7z.
  assert.doesNotMatch(ps1, /'app-64\.7z'/);
  assert.match(ps1, /ns\*\.tmp[^]*Test-Path -LiteralPath \(Join-Path \$_\.FullName 'p9-event-horizon\.marker'\)[^]*Remove-Item/);
  assert.match(nsh.slice(nsh.indexOf('!macro customInit')), /^[^]*?InitPluginsDir\s+FileOpen \$0 "\$PLUGINSDIR\\p9-event-horizon\.marker" w\s+FileClose \$0/, 'the installer marks its own folder');
  // Row 32: the app passes the folder to the same script and function the launch repair uses.
  assert.match(teh, /export function repairWindowsTask\(resources, workspace\)[^]*\.\.\.\(workspace \? \['-Workspace', workspace\] : \[\]\)/);
  const change = main.slice(main.indexOf("ipcMain.handle('p9:workspace-change'"), main.indexOf("ipcMain.handle('p9:pet-remove'"));
  assert.match(change, /if \(win\) \{[^]*\/stop-all[^]*repairWindowsTask\(process\.resourcesPath, folder\)[^]*repairWindowsTask\(process\.resourcesPath, old\)[^]*workspace-not-started/, 'Stop All, then the script, else the old folder again');
  // Fable review finding 3: wake()'s schtasks /Run between Stop All and the new task restarted the old task on the old folder.
  assert.match(main, /const wake = async \(\) => \{\s*if \(changing \|\| Date\.now\(\) - woke < 30000\) return;/, 'wake() does nothing during a change');
  assert.match(change, /changing = true;\s*try \{\s*const ran = await repairWindowsTask\(process\.resourcesPath, folder\)[^]*\} finally \{ changing = false; \}/, 'the change holds wake() off until it returns');
  // Fable review finding 1: the page names a saved folder that was not there at the daemon's start.
  assert.match(main, /h\.savedWorkspace \? \{ savedWorkspace: h\.savedWorkspace, workspace: h\.workspace \}/);
  assert.match(readFileSync(path.join(root, 'apps', 'web', 'src', 'Shell.tsx'), 'utf8'), /result\.savedWorkspace\) \{\s*label\.textContent = 'Workspace folder not found: ' \+ result\.savedWorkspace/);
  assert.match(change, /win \? path\.dirname\(stateReal\)/, "on Windows %LOCALAPPDATA%\\P9, the state folder's parent, is refused");
  console.log('PASS v0.1.4 (text): findings 1-3 and the Windows workspace change are wired');
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
  const run = (env = {}, args = ['ws']) => {
    rmSync(log, { force: true });
    const result = spawnSync('/bin/bash', [path.join(root, 'scripts', 'install.sh'), ...args],
      { cwd: home, encoding: 'utf8', env: { HOME: home, XDG_RUNTIME_DIR: home, PATH: bin, ...env } });
    return { ...result, log: existsSync(log) ? readFileSync(log, 'utf8') : '' };
  };

  const ok = run();
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(ok.log, 'pnpm install --frozen-lockfile\npnpm build\nnode scripts/install-service.mjs ' + path.join(home, 'ws') + '\n');
  assert.ok(existsSync(path.join(home, 'ws')), 'workspace folder made');

  assert.ok(!ok.log.includes('curl'), 'no download when Node v26.10.0 is already there');

  // --headless (a server with no screen): the install skips postinstall, the step that downloads Electron.
  const headless = run({}, ['--headless', 'ws']);
  assert.equal(headless.status, 0, headless.stdout + headless.stderr);
  assert.equal(headless.log, 'pnpm install --frozen-lockfile --ignore-scripts\npnpm build\nnode scripts/install-service.mjs ' + path.join(home, 'ws') + '\n');
  assert.match(headless.stdout, /P9 runs on this server/);
  assert.doesNotMatch(headless.stdout, /pnpm desktop/);

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
