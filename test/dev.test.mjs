import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, chmod, readdir, stat, utimes, symlink, link, copyFile, rm } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { root, daemon } from './helpers.mjs';
import { startEditorHost, stopEditorHost, hostWritable, openInCode, EDITOR_DIR, EDITOR_COMMIT } from '../apps/desktop/editor-host.mjs';

const host = process.env.P9_EDITOR_HOST ?? path.join(EDITOR_DIR, 'codium-server');
const win = process.platform === 'win32';
const skip = !['linux', 'win32'].includes(process.platform) || !existsSync(host) ? 'needs the editor host at ' + host : false;
// Windows: remote URIs carry C:\x as /C:/x. Folder links are junctions (symlinks need Developer Mode or admin).
const uriPath = file => (win ? '/' + file.replaceAll('\\', '/') : file);
const folderLink = (target, link) => symlink(target, link, win ? 'junction' : undefined);
const sddl = file => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Acl -LiteralPath '${file}').Sddl`], { encoding: 'utf8' }).stdout.trim();
// The token user as SDDL text writes it: the SID, or LA for the built-in Administrator (RID 500, the GitHub Windows runner).
const userSid = () => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "(New-Object Security.AccessControl.RawSecurityDescriptor('O:' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)).GetSddlForm('Owner').Substring(2)"], { encoding: 'utf8' }).stdout.trim();
// A stand-in Windows host: the layout editor-host.mjs runs (node.exe, out\server-main.js), with a script that records its
// pid and args and never prints the listening line.
async function fakeWindowsHost(prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  await mkdir(path.join(dir, 'out'));
  await writeFile(path.join(dir, 'product.json'), JSON.stringify({ commit: EDITOR_COMMIT }));
  await link(process.execPath, path.join(dir, 'node.exe')).catch(() => copyFile(process.execPath, path.join(dir, 'node.exe')));
  await writeFile(path.join(dir, 'out', 'server-main.js'), "const fs = require('fs'), path = require('path');\n"
    + "fs.writeFileSync(path.join(__dirname, '..', 'args'), process.argv.slice(2).join('\\n'));\n"
    + "fs.writeFileSync(path.join(__dirname, '..', 'pid'), String(process.pid));\nsetTimeout(() => {}, 60000);\n");
  return dir;
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const evidence = process.env.P9_EVIDENCE;
const editorScopes = () => spawnSync('systemctl', ['--user', 'list-units', '--no-legend', '--plain', 'p9-editor-host-*.scope'], { encoding: 'utf8' }).stdout.split('\n').map(line => line.split(' ')[0]).filter(Boolean);
async function inotifyWatches(cgroup) {
  let count = 0;
  for (const pid of (await readFile(cgroup + '/cgroup.procs', 'utf8')).split('\n').filter(Boolean))
    for (const fd of await readdir('/proc/' + pid + '/fdinfo').catch(() => [])) count += ((await readFile('/proc/' + pid + '/fdinfo/' + fd, 'utf8').catch(() => '')).match(/^inotify wd:/gm) ?? []).length;
  return count;
}
const stage = name => process.env.P9_TRACE && console.error('stage', Math.round(performance.now()), name);

test('Phase 8: the editor host binds loopback only', { skip }, async () => {
  await assert.rejects(startEditorHost({ address: '0.0.0.0' }), /editor-host-loopback-only/);
});

test('Phase 8: a host that never starts is stopped, and its token file is owner-only', { skip: process.platform !== 'linux' }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-fake-host-')), data = path.join(dir, 'data');
  await mkdir(path.join(dir, 'bin'));
  await writeFile(path.join(dir, 'product.json'), JSON.stringify({ commit: EDITOR_COMMIT }));
  await writeFile(path.join(dir, 'bin', 'codium-server'), '#!/bin/sh\nprintf "%s\\n" "$@" > ' + path.join(dir, 'args') + '\nsleep 60\n');
  await chmod(path.join(dir, 'bin', 'codium-server'), 0o755);
  await mkdir(data, { mode: 0o755 });
  await writeFile(path.join(data, 'connection-token'), 'old', { mode: 0o644 });
  const unit = 'p9-editor-host-test-' + process.pid;
  await assert.rejects(startEditorHost({ host: dir, data, unit, timeout: 1500 }), /editor-host-timeout/);
  assert.notEqual(spawnSync('systemctl', ['--user', 'is-active', unit + '.scope'], { encoding: 'utf8' }).stdout.trim(), 'active');
  assert.equal((await stat(data)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(data, 'connection-token'))).mode & 0o777, 0o600);

  // Every state folder the host writes (settings, extensions, workspaceStorage) sits inside the owner-only data folder,
  // which is the only non-workspace path the dev view lets writes through.
  const args = (await readFile(path.join(dir, 'args'), 'utf8')).split('\n');
  for (const flag of ['--user-data-dir', '--server-data-dir', '--extensions-dir']) assert.ok(args[args.indexOf(flag) + 1]?.startsWith(data + '/'), flag);
});

test('Phase 8: a quit while the host starts kills it, scope or not', { skip: process.platform !== 'linux' }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-quit-host-'));
  await mkdir(path.join(dir, 'bin'));
  await writeFile(path.join(dir, 'product.json'), JSON.stringify({ commit: EDITOR_COMMIT }));
  await writeFile(path.join(dir, 'bin', 'codium-server'), '#!' + process.execPath + '\nsetTimeout(() => {}, 60000);\n');
  await chmod(path.join(dir, 'bin', 'codium-server'), 0o755);
  const unit = 'p9-editor-host-quit-' + process.pid;
  for (const delay of [0, 50, 300]) {
    // Checked right after the quit, as the app would leave it: Electron exits then, so the start timeout's own cleanup never runs.
    const quit = new AbortController(), started = startEditorHost({ host: dir, data: path.join(dir, 'data'), unit, timeout: 3000, signal: quit.signal });
    started.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, delay));
    stopEditorHost(unit); quit.abort();
    await new Promise(resolve => setTimeout(resolve, 500));
    const left = spawnSync('systemctl', ['--user', 'is-active', unit + '.scope'], { encoding: 'utf8' }).stdout.trim() === 'active';
    await assert.rejects(started);
    spawnSync('systemctl', ['--user', 'reset-failed', unit + '.scope']);
    assert.equal(left, false, 'host scope still running after a quit at ' + delay + ' ms');
  }
});

test('Phase 8 (Windows): a host that never starts is stopped, and its data folder and token file are user-only', { skip: !win }, async () => {
  const dir = await fakeWindowsHost('p9-fake-host-'), data = path.join(dir, 'data'), sid = userSid();
  // A data folder and token left looser by something else: Everyone may read both.
  await mkdir(data);
  await writeFile(path.join(data, 'connection-token'), 'old');
  spawnSync('icacls', [data, '/grant', '*S-1-1-0:(OI)(CI)R'], { stdio: 'ignore' });
  assert.match(sddl(data), /;WD\)/);
  const unit = 'p9-editor-host-test-' + process.pid;
  await assert.rejects(startEditorHost({ host: dir, data, unit, timeout: 3000 }), /editor-host-timeout/);
  const pid = Number(await readFile(path.join(dir, 'pid'), 'utf8'));
  // Windows ends a job's processes just after its owner exits (stopEditorHost waits for the owner): allow 1 s.
  for (let waited = 0; alive(pid) && waited < 1000; waited += 10) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(alive(pid), false, 'fake host ' + pid + ' still running 1 s after the stop');
  assert.equal(sddl(data).replace(/^O:.*?D:[A-Z]*/, ''), '(A;OICI;FA;;;' + sid + ')');
  assert.equal(sddl(path.join(data, 'connection-token')).replace(/^O:.*?D:[A-Z]*/, ''), '(A;;FA;;;' + sid + ')');
  assert.notEqual(await readFile(path.join(data, 'connection-token'), 'utf8'), 'old');
  const args = (await readFile(path.join(dir, 'args'), 'utf8')).split('\n');
  for (const flag of ['--user-data-dir', '--server-data-dir', '--extensions-dir']) assert.ok(args[args.indexOf(flag) + 1]?.startsWith(data + path.sep), flag);
});

test('Phase 8 (Windows): a quit while the host starts kills it', { skip: !win }, async () => {
  const dir = await fakeWindowsHost('p9-quit-host-'), unit = 'p9-editor-host-quit-' + process.pid;
  for (const delay of [0, 50, 300, 1500]) {
    await rm(path.join(dir, 'pid'), { force: true });
    const quit = new AbortController(), started = startEditorHost({ host: dir, data: path.join(dir, 'data'), unit, timeout: 5000, signal: quit.signal });
    started.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, delay));
    stopEditorHost(unit); quit.abort();
    await assert.rejects(started);
    await new Promise(resolve => setTimeout(resolve, 1500)); // a host that was still starting would have written its pid by now
    const pid = existsSync(path.join(dir, 'pid')) ? Number(await readFile(path.join(dir, 'pid'), 'utf8')) : null;
    assert.equal(pid !== null && alive(pid), false, 'host ' + pid + ' still running after a quit at ' + delay + ' ms');
  }
});

test('Phase 8: unguarded host-folder writes take only plain files inside it', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-host-path-')), data = path.join(dir, 'data'), workspace = path.join(dir, 'ws');
  await mkdir(path.join(data, 'sub'), { recursive: true }); await mkdir(workspace);
  await writeFile(path.join(workspace, 'a.txt'), 'x'); await writeFile(path.join(data, 'plain.json'), '{}');
  // Windows without Developer Mode cannot make file symlinks; the hardlink and junction cases still run.
  const fileLinks = await symlink(path.join(workspace, 'a.txt'), path.join(data, 'sym.txt')).then(() => true, error => { if (!win) throw error; t.diagnostic('file symlink case not run: ' + error.code); return false; });
  await link(path.join(workspace, 'a.txt'), path.join(data, 'hard.txt'));
  await folderLink(workspace, path.join(data, 'dirlink'));
  assert.equal(await hostWritable(data, path.join(data, 'plain.json')), true);
  assert.equal(await hostWritable(data, path.join(data, 'sub', 'new.json')), true);
  for (const name of [...(fileLinks ? ['sym.txt'] : []), 'hard.txt', 'dirlink/a.txt', 'dirlink/new.txt', 'missing/new.txt']) assert.equal(await hostWritable(data, path.join(data, name)), false, name);
  assert.equal(await hostWritable(data, path.join(workspace, 'a.txt')), false);
  assert.equal(await hostWritable(data, 'relative.json'), false);
  // Rename, delete and mkdir act on the link itself, so a symlinked last name is fine; a path through a linked folder is not.
  for (const name of [...(fileLinks ? ['sym.txt'] : []), 'dirlink', 'sub/new']) assert.equal(await hostWritable(data, path.join(data, name), 'name'), true, name);
  for (const name of ['dirlink/a.txt', 'dirlink/sub']) assert.equal(await hostWritable(data, path.join(data, name), 'name'), false, name);
});

test('Phase 8: the host stops on quit even when systemctl fails', { skip: process.platform !== 'linux' }, async () => {
  const unit = 'p9-editor-host-nosystemctl-' + process.pid, bin = await mkdtemp(path.join(os.tmpdir(), 'p9-no-systemctl-'));
  const host = spawn('systemd-run', ['--user', '--scope', '--quiet', '--collect', '--unit=' + unit, 'sleep', '60'], { stdio: 'ignore' });
  await new Promise(resolve => setTimeout(resolve, 1000));
  const state = () => spawnSync('systemctl', ['--user', 'is-active', unit + '.scope'], { encoding: 'utf8' }).stdout.trim();
  assert.equal(state(), 'active');
  await writeFile(path.join(bin, 'systemctl'), '#!/bin/sh\nexit 1\n');
  await chmod(path.join(bin, 'systemctl'), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = bin + ':' + saved;
  let stopped;
  try { stopped = stopEditorHost(unit); } finally { process.env.PATH = saved; }
  if (state() === 'active') { host.kill('SIGKILL'); spawnSync('systemctl', ['--user', 'stop', unit + '.scope']); }
  assert.equal(stopped, true);
  assert.notEqual(state(), 'active');
});

test('Phase 8: Open in VS Code stays inside the real workspace', { skip: !['linux', 'win32'].includes(process.platform) }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-open-')), workspace = path.join(dir, 'ws'), outside = path.join(dir, 'outside');
  await mkdir(workspace); await mkdir(outside);
  await writeFile(path.join(outside, 'secret.txt'), 'x');
  // On Windows "notes:12" is stream 12 of a file named notes; any stream name is refused there.
  await writeFile(path.join(workspace, 'notes:12'), 'x');
  if (win) await writeFile(path.join(workspace, 'notes.txt:side'), 'x');
  await folderLink(outside, path.join(workspace, 'linked'));
  const code = win ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe') : '/bin/true', reason = 'test';
  assert.deepEqual(await openInCode({ workspace, name: 'linked/secret.txt', line: 1, reason, code }), { ok: false, error: 'request-refused' });
  assert.deepEqual(await openInCode({ workspace, name: 'notes:12', line: 1, reason, code }), { ok: false, error: 'request-refused' });
  if (win) assert.deepEqual(await openInCode({ workspace, name: 'notes.txt:side', line: 1, reason, code }), { ok: false, error: 'request-refused' });
  assert.deepEqual(await openInCode({ workspace, name: 'missing.txt', line: 1, reason, code }), { ok: false, error: 'request-refused' });
});

test('Phase 8: Dev Focus edits real files through the guarded save', { skip, timeout: 240000 }, async t => {
  const instance = await daemon(t);
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-dev-home-'));
  const profile = path.join(home, 'profile'), fakeCode = path.join(home, win ? 'code.exe' : 'code'), opened = path.join(home, 'opened.txt');
  // Where the app keeps the editor host's data and its state: %LOCALAPPDATA%\P9 on Windows (pointed at home here).
  const hostData = win ? path.join(home, 'P9', 'editor') : path.join(home, '.local', 'share', 'p9', 'editor');
  const openLog = win ? path.join(home, 'P9', 'state', 'open-in-vscode.jsonl') : path.join(home, '.local', 'state', 'p9', 'open-in-vscode.jsonl');
  const homeEnv = win ? { LOCALAPPDATA: home } : { HOME: home };
  await writeFile(path.join(instance.workspace, 'sample.ts'), 'const count: number = "not a number";\nexport { count };\n');
  await writeFile(path.join(instance.workspace, 'race.txt'), 'disk version 1\n');
  await writeFile(path.join(instance.workspace, 'plain.txt'), 'before\n');
  await writeFile(path.join(instance.workspace, 'sneaky.txt'), 'disk version 1\n');
  if (win) {
    // A real exe (openInCode spawns without a shell), built with the C# compiler in .NET Framework 4, which Windows ships.
    const source = path.join(home, 'code.cs');
    await writeFile(source, 'class C { static void Main(string[] a) { System.IO.File.WriteAllText(System.AppDomain.CurrentDomain.BaseDirectory + "opened.txt", string.Join("\\n", a) + "\\n"); } }');
    const csc = spawnSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'), ['/nologo', '/out:' + fakeCode, source], { encoding: 'utf8' });
    assert.equal(csc.status, 0, csc.stdout);
  } else {
    await writeFile(fakeCode, '#!/bin/sh\nprintf "%s\\n" "$@" > ' + opened + '\n');
    await chmod(fakeCode, 0o755);
  }
  // Phase 15: a dependency folder as big as a real one (the OOM was one inotify watch per folder) next to a few plain folders.
  for (let i = 0; i < 300; i++) await mkdir(path.join(instance.workspace, 'node_modules', 'pkg' + i, 'lib'), { recursive: true });
  for (const plain of ['src', 'docs', 'notes']) await mkdir(path.join(instance.workspace, plain), { recursive: true });
  // Phase 15: the Python debugger, installed the way a user would, from Open VSX (the host's own gallery) into the
  // editor host's extensions folder. ponytail: downloads about 10 MB each run; a cached .vsix if the gate must run offline.
  await writeFile(path.join(instance.workspace, 'debug_me.py'), 'total = 0\nfor n in range(1, 5):\n    total += n\nprint(total)\n');
  // ponytail: downloads debugpy (and ms-python.python, vscode-python-envs) from Open VSX every run, so this test needs the network; vendor the VSIX if gate runs go offline.
  const [installer, ...installerArgs] = win ? [path.join(host, 'node.exe'), path.join(host, 'out', 'server-main.js')] : [path.join(host, 'bin', 'codium-server')];
  const installed = spawnSync(installer, [...installerArgs, '--install-extension', 'ms-python.debugpy@2026.6.0',
    '--extensions-dir', path.join(hostData, 'extensions')], { encoding: 'utf8', env: { ...process.env, ...homeEnv }, timeout: 120000 });
  assert.match(installed.stdout, /'ms-python\.debugpy' v2026\.6\.0 was successfully installed/, installed.stderr);
  const hostsBefore = new Set(win ? [] : editorScopes());
  const env = { ...process.env, ...homeEnv, P9_EDITOR_HOST: host, P9_SPELL_CHECK: 'off', P9_CODE: fakeCode }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise(resolve => setTimeout(resolve, 15000))]); proc.kill(); });
  stage('const shell = await app.firstW'); const shell = await app.firstWindow();
  await shell.locator('#cards .card').first().waitFor();
  const devWindow = app.waitForEvent('window', { predicate: page => page.url().startsWith('p9://dev/'), timeout: 60000 });
  await shell.keyboard.press('Control+2');
  stage('const dev = await devWindow;'); const dev = await devWindow;
  const errors = []; dev.on('pageerror', error => errors.push(error.stack ?? error.message)); // the stack names where it came from
  await dev.waitForFunction(() => window.devFocusReady || document.querySelector('#status')?.textContent, null, { timeout: 120000 });
  assert.equal(await dev.locator('#status').textContent(), '');
  stage('const config = await dev.evalu'); // The view sits exactly over the shell's Dev pane (Playwright screenshots one WebContents, so this is the overlay's proof).
  // It draws above the shell, so it leaves the cards' column free and hides while a dialog is open (Builder, 2026-10-17: "the chat toast isnt there in dev mode").
  const pane = await shell.evaluate(() => { const r = document.querySelector('#fDev').getBoundingClientRect(), c = document.querySelector('#cards').getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), height: Math.round(r.height), cardsLeft: c.height > 0 ? Math.round(c.left) : null, right: Math.round(r.right) }; });
  const devBounds = () => app.evaluate(({ BrowserWindow }) => { const child = BrowserWindow.getAllWindows()[0].contentView.children[0]; return { bounds: child.getBounds(), visible: child.getVisible() }; });
  const view = await devBounds();
  assert.ok(pane.cardsLeft !== null, 'the test profile shows cards (Set up)');
  assert.deepEqual({ x: view.bounds.x, y: view.bounds.y, height: view.bounds.height, visible: view.visible }, { x: pane.x, y: pane.y, height: pane.height, visible: true });
  assert.ok(view.bounds.x + view.bounds.width <= pane.cardsLeft && view.bounds.x + view.bounds.width > pane.right - 400, 'editor stops short of the cards: ' + JSON.stringify({ view, pane }));
  await shell.locator('#setBtn').click();
  await shell.waitForFunction(() => document.querySelector('#setDlg').open);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal((await devBounds()).visible, false, 'a dialog hides the editor');
  await shell.keyboard.press('Escape');
  for (let i = 0; i < 20 && !(await devBounds()).visible; i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await devBounds()).visible, true, 'closing the dialog shows the editor again');
  stage('config'); const config = await dev.evaluate(() => window.p9dev.config());
  assert.equal(config.workspace, instance.workspace);
  stage('// watcher excludes'); // The watcher runs (plain folders watched) but skips the 600 node_modules folders.
  // ponytail: Linux only (inotify watches per cgroup); Windows has no per-folder watch to count.
  if (!win) {
    const hostUnit = editorScopes().find(unit => !hostsBefore.has(unit));
    const cgroup = '/sys/fs/cgroup' + spawnSync('systemctl', ['--user', 'show', hostUnit, '-p', 'ControlGroup', '--value'], { encoding: 'utf8' }).stdout.trim();
    let watches = 0;
    for (let i = 0; i < 60 && watches < 4; i++) { await new Promise(resolve => setTimeout(resolve, 500)); watches = await inotifyWatches(cgroup); }
    assert.ok(watches >= 4 && watches < 100, 'editor host inotify watches: ' + watches);
  }
  stage('// editor follows the look'); // Picking a theme in the shell recolours the editor (its accent: AMOLED makes every background black), no reload.
  const editorAccent = () => dev.evaluate(() => getComputedStyle(document.querySelector('.monaco-workbench')).getPropertyValue('--vscode-button-background').trim().toLowerCase());
  const loads = await dev.evaluate(() => performance.getEntriesByType('navigation').length + ':' + performance.timeOrigin);
  const seen = [];
  for (const theme of ['redline', 'duskwood', 'event-horizon-prime']) {
    const want = await shell.evaluate(theme => {
      document.querySelector('#themeBtn').click(); document.querySelector('[data-theme-pick="' + theme + '"]').click();
      const ctx = document.createElement('canvas').getContext('2d');
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim(); ctx.fillRect(0, 0, 1, 1);
      return '#' + [...ctx.getImageData(0, 0, 1, 1).data].map(n => n.toString(16).padStart(2, '0')).join('');
    }, theme);
    await dev.waitForFunction(want => [want, want.slice(0, 7)].includes(getComputedStyle(document.querySelector('.monaco-workbench')).getPropertyValue('--vscode-button-background').trim().toLowerCase()), want, { timeout: 10000 })
      .catch(async () => assert.fail(theme + ': editor accent ' + await editorAccent() + ', shell ' + want));
    seen.push(want);
    if (evidence) { await mkdir(evidence, { recursive: true }); await dev.evaluate(() => window.devFocus.open('sample.ts').catch(() => {})); await dev.screenshot({ path: path.join(evidence, 'dev-look-' + theme + '.png') }); }
  }
  assert.equal(new Set(seen).size, 3, 'three different accents: ' + seen);
  assert.equal(await dev.evaluate(() => performance.getEntriesByType('navigation').length + ':' + performance.timeOrigin), loads, 'the editor page did not reload');

  // The REH answers only with the token, and only on loopback.
  const origin = 'http://127.0.0.1:' + config.port;
  const resource = origin + '/vscode-remote-resource?path=' + encodeURIComponent(uriPath(path.join(instance.workspace, 'plain.txt')));
  assert.equal((await fetch(resource)).status, 403);
  assert.equal((await fetch(resource + '&tkn=' + 'f'.repeat(64))).status, 403);
  assert.equal(await (await fetch(resource + '&tkn=' + config.token)).text(), 'before\n');
  const lan = Object.values(os.networkInterfaces()).flat().find(address => address.family === 'IPv4' && !address.internal);
  if (lan) await assert.rejects(fetch(`http://${lan.address}:${config.port}/`), /fetch failed/);
  // Only the dev view may call its IPC; the shell's frame is refused.
  const refused = await app.evaluate(async ({ ipcMain, BrowserWindow }) => {
    const sender = BrowserWindow.getAllWindows()[0].webContents, frame = { sender, senderFrame: sender.mainFrame };
    const results = [];
    for (const channel of ['p9dev:config', 'p9dev:save', 'p9dev:open-in-code', 'p9dev:host-path', 'p9dev:open-folder']) {
      try { await ipcMain._invokeHandlers.get(channel)(frame, { path: 'race.txt', hash: '0'.repeat(64), content: 'x' }); results.push(false); }
      catch (error) { results.push(error.message === 'ipc-sender-refused'); }
    }
    return results;
  });
  assert.deepEqual(refused, [true, true, true, true, true]);
  assert.deepEqual(await shell.evaluate(() => typeof window.p9dev), 'undefined');

  stage('// A normal save'); // A normal save reaches disk through the daemon.
  await dev.evaluate(async () => {
    const { v, open } = window.devFocus, editor = await open('plain.txt');
    await editor.edit(edit => edit.replace(new v.Range(0, 0, editor.document.lineCount, 0), 'after\n'));
    await editor.document.save();
  });
  assert.equal(await readFile(path.join(instance.workspace, 'plain.txt'), 'utf8'), 'after\n');
  // Long lines wrap at the window edge (Builder, 2026-10-19: "everything continues forever to the right").
  assert.equal(await dev.evaluate(() => window.devFocus.v.workspace.getConfiguration('editor').get('wordWrap')), 'on');
  if (evidence) { await writeFile(path.join(instance.workspace, 'long.txt'), 'word '.repeat(120) + '\n'); await dev.evaluate(() => window.devFocus.open('long.txt')); await dev.screenshot({ path: path.join(evidence, 'dev-wrap.png') }); }
  stage('// an image file'); // An image file shows as a picture (Builder, 2026-10-19: "photos ... blocked").
  // It runs on p9://webview, walled off from the editor page and window.p9dev (threat model row 5).
  await writeFile(path.join(instance.workspace, 'pic.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64'));
  await dev.evaluate(() => { const { v, root } = window.devFocus; return v.commands.executeCommand('vscode.open', v.Uri.joinPath(v.Uri.parse(root.toString()), 'pic.png')); });
  let pic = [];
  for (let i = 0; i < 60 && !pic.some(([, w]) => w > 0); i++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    for (const frame of dev.frames().filter(frame => frame !== dev.mainFrame()))
      pic = await frame.evaluate(() => [...document.images].map(img => [location.origin, img.naturalWidth, (() => { try { return typeof window.top.p9dev; } catch { return 'walled'; } })()])).catch(() => pic);
  }
  if (evidence) await dev.screenshot({ path: path.join(evidence, 'dev-image.png') });
  assert.ok(pic.some(([, w]) => w === 2), 'pic.png shows: ' + JSON.stringify(pic));
  assert.deepEqual(pic.find(([, w]) => w === 2), ['p9://webview', 2, 'walled'], 'the image preview is walled off from the editor page');
  // CRLF and BOM files get a save basis (their bytes match what the editor shows) and keep their line endings and BOM.
  await writeFile(path.join(instance.workspace, 'crlf.txt'), 'one\r\ntwo\r\n');
  await writeFile(path.join(instance.workspace, 'bom.txt'), '﻿one\n');
  const kept = await dev.evaluate(async () => {
    const { v, open } = window.devFocus, saved = [];
    for (const name of ['crlf.txt', 'bom.txt']) {
      const editor = await open(name);
      await editor.edit(edit => edit.insert(new v.Position(0, 0), 'zero'));
      saved.push(await editor.document.save());
    }
    return saved;
  });
  assert.deepEqual(kept, [true, true]);
  assert.equal(await readFile(path.join(instance.workspace, 'crlf.txt'), 'utf8'), 'zeroone\r\ntwo\r\n');
  assert.equal(await readFile(path.join(instance.workspace, 'bom.txt'), 'utf8'), '﻿zeroone\n');

  stage('// Race:'); // Race: the disk changes after the editor loaded the file; the save is refused, disk keeps the other writer's text, the draft stays.
  await dev.evaluate(async () => {
    const { v, open } = window.devFocus, editor = await open('race.txt');
    await editor.edit(edit => edit.replace(new v.Range(0, 0, editor.document.lineCount, 0), 'editor draft\n'));
  });
  await writeFile(path.join(instance.workspace, 'race.txt'), 'other writer\n');
  const race = await dev.evaluate(async () => {
    const { v } = window.devFocus, document = v.window.activeTextEditor.document;
    const saved = await document.save().catch(error => 'threw: ' + error.message);
    return { saved, dirty: document.isDirty, text: document.getText() };
  });
  assert.equal(await readFile(path.join(instance.workspace, 'race.txt'), 'utf8'), 'other writer\n');
  assert.equal(race.saved, false);
  assert.equal(race.dirty, true);
  assert.equal(race.text, 'editor draft\n');
  // That race was caught by VS Code's own mtime+size check. A writer that keeps the size and restores the mtime gets past it;
  // then only the guarded save stands between the draft and the disk: it refuses on the hash and keeps a recovery draft.
  const sneaky = path.join(instance.workspace, 'sneaky.txt');
  await dev.evaluate(async () => {
    const { v, open } = window.devFocus, editor = await open('sneaky.txt');
    await editor.edit(edit => edit.replace(new v.Range(0, 0, editor.document.lineCount, 0), 'editor draft 2\n'));
  });
  const before = await stat(sneaky);
  await writeFile(sneaky, 'other writer!!\n');
  await utimes(sneaky, before.atime, before.mtime);
  const guarded = await dev.evaluate(async () => {
    const document = window.devFocus.v.window.activeTextEditor.document;
    const saved = await document.save().catch(error => 'threw: ' + error.message);
    return { saved, dirty: document.isDirty, text: document.getText() };
  });
  assert.equal(await readFile(sneaky, 'utf8'), 'other writer!!\n');
  assert.deepEqual(guarded, { saved: false, dirty: true, text: 'editor draft 2\n' });
  const drafts = (await readdir(instance.recovery)).filter(name => name.startsWith('.p9-conflict-'));
  assert.equal(drafts.length, 1);
  assert.match(await readFile(path.join(instance.recovery, drafts[0]), 'utf8'), /editor draft 2/);
  // A read of the file while the draft is unsaved (a diff, an extension) does not move the hash the draft was based on.
  const reread = path.join(instance.workspace, 'reread.txt');
  await writeFile(reread, 'disk version 1\n');
  await dev.evaluate(async () => {
    const { v, open } = window.devFocus, editor = await open('reread.txt');
    await editor.edit(edit => edit.replace(new v.Range(0, 0, editor.document.lineCount, 0), 'editor draft 3\n'));
  });
  const rereadBefore = await stat(reread);
  await writeFile(reread, 'other writer!!\n');
  await utimes(reread, rereadBefore.atime, rereadBefore.mtime);
  const reread3 = await dev.evaluate(async () => {
    const { v } = window.devFocus, document = v.window.activeTextEditor.document;
    await v.workspace.fs.readFile(document.uri);
    return { saved: await document.save().catch(error => 'threw: ' + error.message), dirty: document.isDirty };
  });
  assert.equal(await readFile(reread, 'utf8'), 'other writer!!\n');
  assert.deepEqual(reread3, { saved: false, dirty: true });
  // Nor does a read while the buffer is clean but stale (a same-size, same-mtime disk change VS Code's watcher cannot see):
  // the save basis is the text the editor shows, so an edit made on it is refused.
  const stale = path.join(instance.workspace, 'stale.txt');
  await writeFile(stale, 'disk version 1\n');
  await dev.evaluate(() => window.devFocus.open('stale.txt'));
  const staleBefore = await stat(stale);
  await writeFile(stale, 'other writer!!\n');
  await utimes(stale, staleBefore.atime, staleBefore.mtime);
  const stale4 = await dev.evaluate(async () => {
    const { v } = window.devFocus, editor = v.window.activeTextEditor, document = editor.document;
    await v.workspace.fs.readFile(document.uri);
    await editor.edit(edit => edit.replace(new v.Range(0, 0, document.lineCount, 0), 'editor draft 4\n'));
    return { saved: await document.save().catch(error => 'threw: ' + error.message), dirty: document.isDirty };
  });
  assert.equal(await readFile(stale, 'utf8'), 'other writer!!\n');
  assert.deepEqual(stale4, { saved: false, dirty: true });

  stage('// Creating a file'); // New files go through the create-only route: a new name is made, then saves like any opened file;
  // a name already on disk is replaced by a guarded save (Save As after Replace), and a locked name is refused while File protection is on.
  await writeFile(path.join(instance.workspace, 'exists.txt'), 'disk only\n');
  // The replace is the guarded save, not a raw write: a name that links outside the workspace is still refused.
  await writeFile(path.join(home, 'outside.txt'), 'outside\n');
  await symlink(path.join(home, 'outside.txt'), path.join(instance.workspace, 'link.txt'));
  const created = await dev.evaluate(async () => {
    const { v, root } = window.devFocus, out = [];
    for (const [name, text] of [['new.txt', 'x'], ['new.txt', 'y'], ['exists.txt', 'replaced'], ['.env.new', 'KEY=1'], ['link.txt', 'through']]) {
      try { await v.workspace.fs.writeFile(v.Uri.joinPath(v.Uri.parse(root.toString()), name), new TextEncoder().encode(text)); out.push('written'); }
      catch (error) { out.push(error.message); }
    }
    return out;
  });
  assert.deepEqual(created.slice(0, 3), ['written', 'written', 'written']);
  assert.match(created[3], /could not create/);
  assert.match(created[4], /could not save|refused/);
  assert.equal(await readFile(path.join(home, 'outside.txt'), 'utf8'), 'outside\n');
  assert.equal(await readFile(path.join(instance.workspace, 'new.txt'), 'utf8'), 'y');
  assert.equal(await readFile(path.join(instance.workspace, 'exists.txt'), 'utf8'), 'replaced');
  assert.equal(existsSync(path.join(instance.workspace, '.env.new')), false);
  // Another name for a workspace file (a symlink outside it) fails closed instead of skipping the guarded save.
  const alias = path.join(home, 'alias');
  await folderLink(instance.workspace, alias);
  const aliased = await dev.evaluate(async alias => {
    const { v, root } = window.devFocus;
    try { await v.workspace.fs.writeFile(v.Uri.parse(root.toString()).with({ path: alias + '/plain.txt' }), new TextEncoder().encode('bypass\n')); return 'written'; }
    catch (error) { return error.message; }
  }, uriPath(alias));
  assert.match(aliased, /writes only inside the workspace/);
  assert.equal(await readFile(path.join(instance.workspace, 'plain.txt'), 'utf8'), 'after\n');
  // Nor does a symlink planted inside the editor host's own folder, whose writes otherwise pass through.
  // Windows: a hardlink (file symlinks need Developer Mode), removed after so plain.txt has one link again.
  const planted = path.join(hostData, 'planted.txt');
  await (win ? link : symlink)(path.join(instance.workspace, 'plain.txt'), planted);
  const viaHost = await dev.evaluate(async planted => {
    const { v, root } = window.devFocus;
    try { await v.workspace.fs.writeFile(v.Uri.parse(root.toString()).with({ path: planted }), new TextEncoder().encode('bypass\n')); return 'written'; }
    catch (error) { return error.message; }
  }, uriPath(planted));
  assert.match(viaHost, /not a plain file inside the editor host folder/);
  assert.equal(await readFile(path.join(instance.workspace, 'plain.txt'), 'utf8'), 'after\n');
  await rm(planted);
  // Nor does a folder link there: a delete through it would reach the workspace file.
  const linkedFolder = path.join(hostData, 'ws-link');
  await folderLink(instance.workspace, linkedFolder);
  const deleted = await dev.evaluate(async folderLink => {
    const { v, root } = window.devFocus;
    try { await v.workspace.fs.delete(v.Uri.parse(root.toString()).with({ path: folderLink + '/plain.txt' })); return 'deleted'; }
    catch (error) { return error.message; }
  }, uriPath(linkedFolder));
  assert.match(deleted, /real folder is outside the editor host folder/);
  assert.equal(await readFile(path.join(instance.workspace, 'plain.txt'), 'utf8'), 'after\n');
  // The guard was on before the workbench took input; subframes are held to p9://dev/; each session serves only its own origin.
  assert.equal(await dev.evaluate(() => document.querySelector('#workbench').inert), false);
  const locks = await app.evaluate(async ({ webContents, session }) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL().startsWith('p9://dev/'));
    return { frames: contents.listenerCount('will-frame-navigate'), crossApp: (await contents.session.fetch('p9://app/')).status,
      crossDev: (await session.defaultSession.fetch('p9://dev/')).status, own: (await contents.session.fetch('p9://dev/')).status };
  });
  assert.deepEqual(locks, { frames: 1, crossApp: 404, crossDev: 404, own: 200 });

  stage('// TypeScript'); // TypeScript's language server reports the error; the terminal runs a shell.
  const lsp = await dev.evaluate(async () => {
    const { v, open } = window.devFocus, editor = await open('sample.ts');
    for (let i = 0; i < 120; i++) {
      const errors = v.languages.getDiagnostics(editor.document.uri).filter(d => d.severity === v.DiagnosticSeverity.Error);
      if (errors.length) return errors.map(d => d.message);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return [];
  });
  assert.ok(lsp.some(message => /not assignable/.test(message)), JSON.stringify(lsp));
  const terminal = await dev.evaluate(async shellPath => {
    const { v } = window.devFocus, term = v.window.createTerminal({ name: 'P9 test', shellPath });
    term.show(); term.sendText('echo P9_TERMINAL_OK');
    return term.processId;
  }, win ? 'cmd.exe' : '/bin/sh');
  assert.ok(Number.isSafeInteger(terminal) && terminal > 0);
  // Ctrl+` hides and shows the terminal drawer (the workbench's panel).
  const panelShown = () => dev.evaluate(() => { const panel = document.querySelector('.part.panel'); return !!panel && panel.offsetParent !== null && panel.offsetHeight > 0; });
  assert.equal(await panelShown(), true);
  // The new terminal takes focus asynchronously; a key pressed before that lands nowhere.
  await dev.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'));
  await dev.keyboard.press('Control+Backquote');
  await dev.waitForFunction(() => { const panel = document.querySelector('.part.panel'); return !panel || panel.offsetParent === null || panel.offsetHeight === 0; });
  await dev.waitForFunction(() => document.activeElement?.className.includes('native-edit-context'));
  // From the editor, Playwright's CDP key never reaches the keybinding (Monaco's EditContext ignores it); real input does.
  // The editor takes focus before its keybindings are wired, so a key sent at once can land nowhere: resend, up to 5 times.
  for (let tries = 0; ; tries++) {
    await app.evaluate(({ webContents }) => {
      const contents = webContents.getAllWebContents().find(item => item.getURL().startsWith('p9://dev/'));
      contents.sendInputEvent({ type: 'keyDown', keyCode: '`', modifiers: ['control'] });
      contents.sendInputEvent({ type: 'keyUp', keyCode: '`', modifiers: ['control'] });
    });
    try { await dev.waitForFunction(() => document.querySelector('.part.panel')?.offsetHeight > 0, null, { timeout: 3000 }); break; }
    catch (error) { if (tries === 4) throw error; }
  }
  await dev.waitForTimeout(2000);
  stage('// File tree'); // Builder, 2026-10-17: "i cant see my file tree in dev mode" (the Explorer service was never loaded).
  await dev.evaluate(() => window.devFocus.v.commands.executeCommand('workbench.view.explorer'));
  await dev.waitForFunction(() => [...document.querySelectorAll('.explorer-folders-view .monaco-list-row')].some(row => row.textContent.includes('sample.ts')), null, { timeout: 15000 });
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await dev.evaluate(() => window.devFocus.open('sample.ts'));
    await dev.waitForTimeout(1500);
    await shell.screenshot({ path: path.join(evidence, 'dev-focus-shell.png') });
    await dev.screenshot({ path: path.join(evidence, 'dev-focus.png') });
  }

  stage('// Python debugger'); // debugpy stops at a breakpoint on line 4 and reads the loop's total there.
  const debugged = await dev.evaluate(async python => {
    const { v } = window.devFocus;
    const folder = v.workspace.workspaceFolders[0], file = v.Uri.joinPath(folder.uri, 'debug_me.py');
    v.debug.addBreakpoints([new v.SourceBreakpoint(new v.Location(file, new v.Position(3, 0)))]);
    const stopped = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the debugger never stopped')), 90000);
      const sub = v.debug.onDidChangeActiveStackItem(item => { if (item && 'frameId' in item) { clearTimeout(timer); sub.dispose(); resolve(item); } });
    });
    const started = await v.debug.startDebugging(folder, { type: 'debugpy', request: 'launch', name: 'P9 debug test', program: file.fsPath,
      python, console: 'internalConsole', justMyCode: true });
    const frame = await stopped;
    const [top] = (await frame.session.customRequest('stackTrace', { threadId: frame.threadId, levels: 1 })).stackFrames;
    const { scopes } = await frame.session.customRequest('scopes', { frameId: top.id });
    const { variables } = await frame.session.customRequest('variables', { variablesReference: scopes[0].variablesReference });
    await v.debug.stopDebugging(frame.session);
    return { started, type: frame.session.type, line: top.line, total: variables.find(item => item.name === 'total')?.value };
  }, win ? process.env.P9_PYTHON ?? path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python312', 'python.exe') : '/usr/bin/python3');
  assert.deepEqual(debugged, { started: true, type: 'debugpy', line: 4, total: '10' });

  stage('// Extension gallery'); // The Extensions view searches Open VSX: a not-installed extension shows up (network).
  await dev.evaluate(() => window.devFocus.v.commands.executeCommand('workbench.extensions.search', 'redhat.vscode-yaml'));
  await dev.locator('.extension-list-item .name', { hasText: 'YAML' }).first().waitFor({ timeout: 45000 });
  await dev.waitForFunction(() => [...document.querySelectorAll('.extension-list-item img.icon')].some(img => img.complete && img.naturalWidth > 0), null, { timeout: 30000 });
  if (evidence) await dev.screenshot({ path: path.join(evidence, 'dev-extension-gallery.png') });
  // Its page shows the README text in the webview box (Builder, 2026-10-18: "my extensions dont show text inside the box").
  await dev.locator('.extension-list-item .name', { hasText: 'YAML' }).first().click();
  let readme = '';
  for (let i = 0; i < 60 && readme.length < 200; i++, await new Promise(resolve => setTimeout(resolve, 500)))
    for (const frame of dev.frames().filter(frame => frame.url().includes('/assets/fake-')))
      readme = await frame.evaluate(() => document.body?.innerText ?? '').catch(() => readme);
  assert.ok(readme.length >= 200 && /YAML/.test(readme), 'the extension page shows its README: ' + JSON.stringify(readme.slice(0, 200)));
  // Its README images show too (Builder, 2026-10-18: "extensions in dev dont show the images that come with them"): badges and a
  // raw.githubusercontent.com demo, each loaded with a real size.
  let pics = [];
  for (let i = 0; i < 60 && !(pics.length && pics.every(([, w]) => w > 0)); i++, await new Promise(resolve => setTimeout(resolve, 500)))
    for (const frame of dev.frames().filter(frame => frame.url().includes('/assets/fake-')))
      pics = await frame.evaluate(() => [...document.images].map(img => [new URL(img.src).host, img.naturalWidth])).catch(() => pics);
  assert.ok(pics.length >= 2 && pics.every(([, w]) => w > 0), 'README images load: ' + JSON.stringify(pics));
  if (evidence) await dev.screenshot({ path: path.join(evidence, 'dev-extension-page.png') });

  stage('// Open in VS Code'); // Open in VS Code: the file and line reach code -g, and the reason is logged.
  assert.deepEqual(await dev.evaluate(() => window.p9dev.openInCode('sample.ts', 1, 'test reason')), { ok: true });
  assert.deepEqual(await dev.evaluate(() => window.p9dev.openInCode('../outside.txt', 1, 'x')), { ok: false, error: 'request-refused' });
  for (let i = 0; i < 20 && !existsSync(opened); i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await readFile(opened, 'utf8'), '-g\n' + path.join(instance.workspace, 'sample.ts') + ':1\n');
  const log = (await readFile(openLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(log.map(({ file, line, reason }) => ({ file, line, reason })), [{ file: 'sample.ts', line: 1, reason: 'test reason' }]);

  stage('// Ctrl+1'); // Ctrl+1 inside the editor still switches focus.
  // Playwright's keys go straight to the page over CDP; sendInputEvent takes the real input path, so before-input-event sees it.
  await app.evaluate(({ webContents }) => webContents.getAllWebContents().find(contents => contents.getURL().startsWith('p9://dev/'))
    .sendInputEvent({ type: 'keyDown', keyCode: '1', modifiers: ['control'] }));
  await shell.waitForFunction(() => document.querySelector('.shell').dataset.focus === 'chat');
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children[0].getVisible()), false);
  assert.deepEqual(errors, []);
  // A normal quit stops the editor host: its port no longer answers.
  await app.close();
  await assert.rejects(fetch(origin + '/version'), /fetch failed/);
});

// Open Folder (threat model row 41): inside the workspace opens at once; outside asks once, then saves go to that folder through
// the daemon's guarded save; a folder that holds the workspace is refused; p9 edit goes back to the workspace.
test('Dev Focus: Open Folder inside and outside the workspace', { skip, timeout: 180000 }, async t => {
  const instance = await daemon(t);
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-dev-home-')), outside = path.join(instance.directory, 'outside');
  await mkdir(outside);
  await mkdir(path.join(instance.workspace, 'src'));
  await writeFile(path.join(outside, 'a.txt'), 'outside before\n');
  await writeFile(path.join(instance.workspace, 'src', 'b.txt'), 'inside before\n');
  const env = { ...process.env, ...(win ? { LOCALAPPDATA: home } : { HOME: home }), P9_EDITOR_HOST: host, P9_SPELL_CHECK: 'off' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + path.join(home, 'profile')], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise(resolve => setTimeout(resolve, 15000))]); proc.kill(); });
  // The native picker answers with the next folder in line; the confirm says yes and is counted.
  await app.evaluate(({ dialog }) => {
    globalThis.picks = []; globalThis.asked = [];
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [globalThis.picks.shift()] });
    dialog.showMessageBox = async (_window, options) => { globalThis.asked.push(options.message); return { response: 1 }; };
  });
  const pick = folder => app.evaluate((_electron, folder) => { globalThis.picks.push(folder); }, folder);
  const asked = () => app.evaluate(() => globalThis.asked);
  const nextPage = () => app.waitForEvent('window', { predicate: page => page.url().startsWith('p9://dev/'), timeout: 60000 });
  const ready = async page => { await page.waitForFunction(() => window.devFocusReady || document.querySelector('#status')?.textContent, null, { timeout: 120000 });
    assert.equal(await page.locator('#status').textContent(), ''); return page; };
  const shell = await app.firstWindow();
  await shell.locator('#cards .card').first().waitFor();
  let page = nextPage();
  await shell.keyboard.press('Control+2');
  let dev = await ready(await page);
  const save = (name, text) => dev.evaluate(async ([name, text]) => {
    const { v, open } = window.devFocus, editor = await open(name);
    await editor.edit(edit => edit.replace(new v.Range(0, 0, editor.document.lineCount, 0), text));
    return editor.document.save();
  }, [name, text]);

  // Inside the workspace: File > Open Folder (the workbench's own command) opens it at once, with no question.
  await pick(path.join(instance.workspace, 'src'));
  page = nextPage();
  await dev.evaluate(() => window.devFocus.v.commands.executeCommand('workbench.action.files.openFolder'));
  dev = await ready(await page);
  assert.deepEqual(await asked(), []);
  let config = await dev.evaluate(() => window.p9dev.config());
  assert.deepEqual([config.workspace, config.folder], [instance.workspace, path.join(instance.workspace, 'src')]);
  assert.equal(await dev.evaluate(() => window.devFocus.root.path), uriPath(path.join(instance.workspace, 'src')));
  assert.equal(await save('src/b.txt', 'inside after\n'), true);
  assert.equal(await readFile(path.join(instance.workspace, 'src', 'b.txt'), 'utf8'), 'inside after\n');
  if (evidence) { await mkdir(evidence, { recursive: true }); await dev.screenshot({ path: path.join(evidence, 'dev-open-folder-inside.png') }); }

  // Outside: one question naming the folder, then the editor shows it and saves land there, not in the workspace.
  await pick(outside);
  page = nextPage();
  await dev.evaluate(() => window.devFocus.v.commands.executeCommand('workbench.action.files.openFolder'));
  dev = await ready(await page);
  assert.deepEqual(await asked(), ['Open ' + outside + ' in Dev Focus?']);
  config = await dev.evaluate(() => window.p9dev.config());
  assert.deepEqual([config.workspace, config.folder], [outside, outside]);
  assert.equal(await save('a.txt', 'outside after\n'), true);
  assert.equal(await readFile(path.join(outside, 'a.txt'), 'utf8'), 'outside after\n');
  assert.equal(existsSync(path.join(instance.workspace, 'a.txt')), false);
  if (evidence) { await mkdir(evidence, { recursive: true }); await dev.screenshot({ path: path.join(evidence, 'dev-open-folder-outside.png') }); }
  // A change on disk is still a conflict there; the disk keeps the other change.
  await writeFile(path.join(outside, 'a.txt'), 'changed on disk\n');
  assert.equal(await dev.evaluate(async () => { const { v, open } = window.devFocus, editor = await open('a.txt');
    await editor.edit(edit => edit.insert(new v.Position(0, 0), 'mine ')); return editor.document.save().then(ok => (ok ? 'saved' : 'refused'), error => error.message); }) !== 'saved', true, 'a stale save is refused');
  assert.equal(await readFile(path.join(outside, 'a.txt'), 'utf8'), 'changed on disk\n');

  // A folder that holds the workspace is refused, and the open folder stays.
  await pick(instance.directory);
  assert.deepEqual(await dev.evaluate(() => window.p9dev.openFolder()), { error: 'root-refused' });
  assert.equal((await dev.evaluate(() => window.p9dev.config())).folder, outside);

  // p9 edit names a workspace file: Dev Focus goes back to the workspace and opens it there.
  page = nextPage();
  await app.evaluate(({ app }, file) => app.emit('second-instance', {}, [], '', { open: 'edit', path: file, line: 1 }), path.join(instance.workspace, 'note.txt'));
  dev = await ready(await page);
  config = await dev.evaluate(() => window.p9dev.config());
  assert.deepEqual([config.workspace, config.folder], [instance.workspace, null]);
  await dev.waitForFunction(() => window.devFocus.v.window.activeTextEditor?.document.uri.path.endsWith('/note.txt'), null, { timeout: 30000 });
  console.log('PASS Open Folder: inside at once, outside after one question, saves there guarded, a folder holding the workspace refused, p9 edit back to the workspace');
});

// ---- Chunk 5: D11 (save only on Ctrl+S / Save, white dot while unsaved) and D12 (spell check) ----
// The dev space has no editor server and no systemd user bus. There, the pinned release is unpacked from the private fixtures folder
// (untracked: the sprint put it there) and started through a stand-in systemd-run that only runs the command; on a machine
// with the editor server and a user bus (the server itself, CI) the real ones are used.
const fixtures = path.join(root, '_private', 'fixtures');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let preparedEditor;
const editorFor = () => preparedEditor ??= (async () => {
  if (process.platform !== 'linux') return null;
  const bus = spawnSync('systemd-run', ['--user', '--scope', '--quiet', 'true'], { timeout: 10000 }).status === 0;
  if (existsSync(host) && bus) return { host, path: process.env.PATH };
  if (!existsSync(path.join(fixtures, 'reh.tar.gz'))) return null;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-reh-')), unpacked = path.join(dir, 'codium-server'), shims = path.join(dir, 'shims');
  await mkdir(unpacked); await mkdir(shims);
  assert.equal(spawnSync('tar', ['-xzf', path.join(fixtures, 'reh.tar.gz'), '-C', unpacked]).status, 0);
  // Stand-ins for the user manager: systemd-run records which process is the scope's, and systemctl stop/kill ends it and its children.
  const pids = path.join(dir, 'pids'); await mkdir(pids);
  await writeFile(path.join(shims, 'systemd-run'), [`#!${process.execPath}`,
    "const fs = require('fs'), { spawn } = require('child_process');",
    "const args = process.argv.slice(2), unit = (args.find(a => a.startsWith('--unit=')) ?? '').slice(7), at = args.findIndex(a => !a.startsWith('--'));",
    `fs.writeFileSync(${JSON.stringify(pids)} + '/' + unit, String(process.pid));`,
    "spawn(args[at], args.slice(at + 1), { stdio: 'inherit' }).on('exit', code => process.exit(code ?? 1));", ''].join('\n'), { mode: 0o755 });
  await writeFile(path.join(shims, 'systemctl'), [`#!${process.execPath}`,
    "const fs = require('fs'), args = process.argv.slice(2), unit = args.find(a => a.endsWith('.scope'));",
    "if (!unit || !args.some(a => a === 'stop' || a === 'kill')) process.exit(0);",
    `let root; try { root = Number(fs.readFileSync(${JSON.stringify(pids)} + '/' + unit.slice(0, -6), 'utf8')); } catch { process.exit(0); }`,
    "const parent = {}; for (const d of fs.readdirSync('/proc').filter(n => /^[0-9]+$/.test(n))) { try { parent[d] = fs.readFileSync('/proc/' + d + '/stat', 'utf8').replace(/^.*[)] /, '').split(' ')[1]; } catch {} }",
    "const kill = pid => { for (const [child, p] of Object.entries(parent)) if (Number(p) === pid) kill(Number(child)); try { process.kill(pid, 'SIGKILL'); } catch {} };",
    'kill(root);', ''].join('\n'), { mode: 0o755 });
  return { host: unpacked, path: shims + ':' + process.env.PATH };
})();
// The dev space prints a failure's detail only when the whole run ends; print it where it happens too.
// The editor asks the extension gallery on start; with no network that rejects (not what these tests check).
const online = errors => errors.filter(error => !/EAI_AGAIN|ENOTFOUND|ECONNREFUSED/.test(error));
const logged = body => async t => { try { await body(t); } catch (error) { console.log('FAILED ' + (error.stack ?? error)); throw error; } };
// Prints the picture into the run's log (the dev space keeps no files) and, with P9_EVIDENCE, saves it.
async function shot(page, name) {
  const png = await page.screenshot({ type: 'jpeg', quality: 80 });
  console.log('SHOT ' + name + ' ' + png.toString('base64'));
  if (evidence) { await mkdir(evidence, { recursive: true }); await writeFile(path.join(evidence, name + '.jpg'), png); }
}
async function openDevFocus(t, editor, extra = {}) {
  const instance = await daemon(t), home = await mkdtemp(path.join(os.tmpdir(), 'p9-dev-home-'));
  const env = { ...process.env, HOME: home, PATH: editor.path, P9_EDITOR_HOST: editor.host, ...extra }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + path.join(home, 'profile')], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), sleep(15000)]); proc.kill(); });
  const shell = await app.firstWindow();
  await shell.locator('#cards .card').first().waitFor();
  const devWindow = app.waitForEvent('window', { predicate: page => page.url().startsWith('p9://dev/'), timeout: 60000 });
  await shell.keyboard.press('Control+2');
  const dev = await devWindow;
  const errors = []; dev.on('pageerror', error => errors.push(error.stack ?? error.message));
  await dev.waitForFunction(() => window.devFocusReady || document.querySelector('#status')?.textContent, null, { timeout: 120000 });
  assert.equal(await dev.locator('#status').textContent(), '');
  return { instance, home, app, shell, dev, errors };
}

test('D11: Dev Focus saves only on Ctrl+S or Save; the tab shows a white dot while unsaved', { skip: process.platform !== 'linux', timeout: 240000 }, logged(async t => {
  const editor = await editorFor();
  if (!editor) return t.skip('needs the editor server (P9_EDITOR_HOST, or the fixtures reh.tar.gz)');
  const { instance, dev, errors } = await openDevFocus(t, editor, { P9_SPELL_CHECK: 'off' });
  const plain = path.join(instance.workspace, 'plain.txt');
  await writeFile(plain, 'before\n');
  assert.equal(await dev.evaluate(() => window.devFocus.v.workspace.getConfiguration('files').get('autoSave')), 'off');
  await dev.evaluate(async () => {
    const { v, open } = window.devFocus, editor = await open('plain.txt');
    await editor.edit(edit => edit.insert(new v.Position(0, 0), 'typed '));
  });
  // The old behaviour wrote the edit one second after the last change; wait three times that, and a window change on top.
  await sleep(3500);
  assert.equal(await readFile(plain, 'utf8'), 'before\n', 'an edit is not on disk until Save');
  assert.equal(await dev.evaluate(() => window.devFocus.v.window.activeTextEditor.document.isDirty), true);
  const dot = await dev.evaluate(() => {
    const label = document.querySelector('.tab.dirty .tab-actions .action-label');
    return label && { color: getComputedStyle(label).color, mark: getComputedStyle(label, '::before').content };
  });
  assert.ok(dot, 'the edited tab is marked unsaved');
  assert.equal(dot.color, 'rgb(255, 255, 255)', 'the unsaved dot is white');
  assert.notEqual(dot.mark, 'none', 'the dot is drawn');
  await shot(dev, 'd11-unsaved-dot');
  // Ctrl+S saves, through the guarded save, and the dot goes.
  await dev.evaluate(() => window.devFocus.v.commands.executeCommand('workbench.action.focusActiveEditorGroup'));
  await dev.keyboard.press('Control+s');
  for (let i = 0; i < 60 && (await readFile(plain, 'utf8')) === 'before\n'; i++) await sleep(250);
  assert.equal(await readFile(plain, 'utf8'), 'typed before\n', 'Ctrl+S writes the edit');
  await dev.waitForFunction(() => !document.querySelector('.tab.dirty'), null, { timeout: 10000 });
  await shot(dev, 'd11-saved');
  // File > Save is the same command.
  await dev.evaluate(async () => { const { v } = window.devFocus; await v.window.activeTextEditor.edit(edit => edit.insert(new v.Position(0, 0), 'again ')); });
  await sleep(2500);
  assert.equal(await readFile(plain, 'utf8'), 'typed before\n');
  await dev.evaluate(() => window.devFocus.v.commands.executeCommand('workbench.action.files.save'));
  for (let i = 0; i < 60 && (await readFile(plain, 'utf8')) === 'typed before\n'; i++) await sleep(250);
  assert.equal(await readFile(plain, 'utf8'), 'again typed before\n', 'Save writes the edit');
  assert.deepEqual(online(errors), []);
}));

test('D12: Dev Focus underlines misspelled words (Code Spell Checker, installed once)', { skip: process.platform !== 'linux', timeout: 300000 }, logged(async t => {
  const editor = await editorFor();
  if (!editor || !existsSync(path.join(fixtures, 'spell.vsix'))) return t.skip('needs the editor server and the fixtures spell.vsix');
  const served = await readFile(path.join(fixtures, 'spell.vsix'));
  const { createServer } = await import('node:http');
  const server = createServer((_request, response) => response.end(served)).listen(0, '127.0.0.1');
  t.after(() => server.close());
  await new Promise(resolve => server.once('listening', resolve));
  const { instance, home, dev, errors } = await openDevFocus(t, editor, { P9_SPELL_URL: 'http://127.0.0.1:' + server.address().port + '/spell.vsix' });
  await writeFile(path.join(instance.workspace, 'note.txt'), 'The quikc brwon fox jumps over the lazzy dog.\n');
  const found = await dev.evaluate(async () => {
    const { v, open } = window.devFocus, editor = await open('note.txt');
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const spelling = v.languages.getDiagnostics(editor.document.uri).filter(item => /cspell/i.test(String(item.source)));
      if (spelling.length) return spelling.map(item => editor.document.getText(item.range));
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return [];
  });
  assert.ok(['quikc', 'brwon', 'lazzy'].every(word => found.includes(word)), 'misspellings underlined: ' + JSON.stringify(found));
  assert.ok(!found.includes('fox') && !found.includes('dog') && !found.includes('jumps'), 'correct words left alone: ' + JSON.stringify(found));
  assert.ok(existsSync(path.join(home, '.local', 'share', 'p9', 'editor', 'spell-checker-offered')));
  await shot(dev, 'd12-spelling');
  assert.deepEqual(online(errors), []);
}));

test('D12: the spell checker is installed once, from a pinned download', { timeout: 60000 }, async t => {
  const { createServer } = await import('node:http');
  const { SPELL_CHECKER, installSpellChecker } = await import('../apps/desktop/editor-host.mjs');
  const { createHash } = await import('node:crypto');
  const body = Buffer.from('not really an extension');
  const server = createServer((_request, response) => response.end(body)).listen(0, '127.0.0.1');
  t.after(() => server.close());
  await new Promise(resolve => server.once('listening', resolve));
  const url = 'http://127.0.0.1:' + server.address().port + '/x.vsix', good = createHash('sha256').update(body).digest('hex');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-spell-')), data = path.join(dir, 'data'), fake = path.join(dir, 'host');
  await mkdir(data); await mkdir(path.join(fake, 'bin'), { recursive: true });
  await writeFile(path.join(fake, 'bin', 'codium-server'), '#!/bin/sh\nprintf "%s\\n" "$@" > ' + path.join(dir, 'args') + '\nexit 0\n', { mode: 0o755 });
  assert.match(SPELL_CHECKER[0], /^https:\/\/open-vsx\.org\//);
  // A download that is not the pinned file installs nothing and leaves no marker or temp folder.
  assert.equal(await installSpellChecker({ host: fake, data, download: [url, '0'.repeat(64)] }), 'checksum-mismatch');
  assert.deepEqual((await readdir(data)).sort(), []);
  assert.equal(existsSync(path.join(dir, 'args')), false, 'the host was not asked to install it');
  // The pinned file goes to the host's own --install-extension, then the offer is marked and not repeated.
  assert.equal(await installSpellChecker({ host: fake, data, download: [url, good] }), 'installed');
  const args = (await readFile(path.join(dir, 'args'), 'utf8')).split('\n');
  assert.equal(args[0], '--install-extension');
  assert.ok(args.includes('--extensions-dir') && args.includes(path.join(data, 'extensions')));
  assert.deepEqual((await readdir(data)).sort(), ['spell-checker-offered']);
  await rm(path.join(dir, 'args'));
  assert.equal(await installSpellChecker({ host: fake, data, download: [url, good] }), 'offered-before');
  assert.equal(existsSync(path.join(dir, 'args')), false);
  // Offline: a failed download is reported, never thrown, and the next start tries again (no marker).
  const dead = await mkdtemp(path.join(os.tmpdir(), 'p9-spell-'));
  assert.equal(await installSpellChecker({ host: fake, data: dead, download: ['http://127.0.0.1:1/x.vsix', good] }), 'download-failed');
  assert.deepEqual(await readdir(dead), []);
});
