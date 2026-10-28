import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { root, daemon } from './helpers.mjs';
import { EDITOR_DIR } from '../apps/desktop/editor-host.mjs';

const host = process.env.P9_EDITOR_HOST ?? path.join(EDITOR_DIR, 'codium-server');
const skip = process.platform !== 'linux' || !existsSync(host) ? 'needs the Linux editor host at ' + host : false;
const run = (command, args, options) => new Promise(resolve => {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('exit', code => resolve({ code, stderr }));
});

// Threat model row 14's Required cases.
test('Phase 18: p9 edit and p9 diff open workspace files in the running app, and nothing outside it', { skip, timeout: 180000 }, async t => {
  const instance = await daemon(t);
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-cli-home-')), w = instance.workspace;
  await writeFile(path.join(w, 'a.txt'), 'one\ntwo\nthree\n');
  await writeFile(path.join(w, 'b.txt'), 'one\nTWO\nthree\n');
  await writeFile(path.join(w, 'marker.txt'), 'last\n');
  await mkdir(path.join(w, 'folder'));
  await writeFile(path.join(instance.directory, 'secret.txt'), 'outside\n');
  await symlink(path.join(instance.directory, 'secret.txt'), path.join(w, 'link.txt'));
  // No --user-data-dir: the CLI's second instance must find the same profile (HOME's), as it would for Builder.
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), P9_EDITOR_HOST: host }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  let mainErr = '';
  proc.stderr.on('data', chunk => { mainErr += chunk; });
  t.after(async () => { await Promise.race([app.close(), new Promise(resolve => setTimeout(resolve, 15000))]); proc.kill(); });
  const shell = await app.firstWindow();
  await shell.locator('#cards .card').first().waitFor();
  const p9 = (...args) => run(process.execPath, [path.join(root, 'scripts/p9.mjs'), '--state', instance.state, ...args], { cwd: w, env });

  // 1. p9 edit with the app on Chat Focus: the app switches to Dev Focus, starts the editor and opens the file at the line.
  const devWindow = app.waitForEvent('window', { predicate: page => page.url().startsWith('p9://dev/'), timeout: 60000 });
  assert.deepEqual(await p9('edit', 'a.txt:3'), { code: 0, stderr: '' });
  const dev = await devWindow;
  await dev.waitForFunction(() => window.devFocusReady, null, { timeout: 120000 });
  const active = () => dev.evaluate(() => {
    const { v, root } = window.devFocus, input = v.window.tabGroups.activeTabGroup.activeTab?.input, rel = uri => uri.path.slice(root.path.length + 1);
    if (!input) return null;
    return input.original ? { diff: [rel(input.original), rel(input.modified)] } : { edit: rel(input.uri), line: v.window.activeTextEditor?.selection.active.line + 1 };
  });
  const opened = async want => dev.waitForFunction(want => {
    const input = window.devFocus.v.window.tabGroups.activeTabGroup.activeTab?.input;
    return input && (input.original ?? input.uri).path.endsWith('/' + want);
  }, want, { timeout: 30000 });
  await opened('a.txt');
  assert.deepEqual(await active(), { edit: 'a.txt', line: 3 });
  assert.equal(await shell.evaluate(() => document.querySelector('.shell').dataset.focus), 'dev');

  // p9 diff opens the diff editor; a second request reaches the same app (still one window, the CLI's own Electron exits).
  assert.deepEqual(await p9('diff', 'a.txt', path.join(w, 'b.txt')), { code: 0, stderr: '' });
  await dev.waitForFunction(() => window.devFocus.v.window.tabGroups.activeTabGroup.activeTab?.input?.original, null, { timeout: 30000 });
  assert.deepEqual(await active(), { diff: ['a.txt', 'b.txt'] });
  if (process.env.P9_EVIDENCE) await dev.screenshot({ path: path.join(process.env.P9_EVIDENCE, 'p9-diff.png') });
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);

  // 2. The CLI refuses outside paths, a symlink out, a .. path out, a folder and a missing file: exit 2, nothing opened.
  for (const args of [['edit', path.join(instance.directory, 'secret.txt')], ['edit', 'link.txt'], ['edit', '../secret.txt'],
    ['edit', 'folder'], ['edit', 'missing.txt'], ['diff', 'a.txt', 'link.txt'], ['edit', 'a.txt:0']]) {
    const result = await p9(...args);
    assert.equal(result.code, 2, args.join(' '));
    assert.match(result.stderr, /^p9: /, args.join(' '));
  }

  // 3. The same requests sent straight to the running app, skipping the CLI's check, plus bad shapes: each is refused.
  const electron = createRequire(import.meta.url)('electron'), a = path.join(w, 'a.txt'), secret = path.join(instance.directory, 'secret.txt');
  const crafted = [
    { open: 'edit', path: secret, line: 1 }, { open: 'edit', path: path.join(w, 'link.txt'), line: 1 },
    { open: 'edit', path: path.join(w, '..', 'secret.txt'), line: 1 }, { open: 'edit', path: path.join(w, 'folder'), line: 1 },
    { open: 'edit', path: 'a.txt', line: 1 }, { open: 'edit', path: a, line: 0 }, { open: 'edit', path: a, line: 1.5 },
    { open: 'edit', path: a, line: 1, run: 'x' }, { open: 'diff', a, b: secret }, { open: 'save', path: a, line: 1 }, [a],
  ];
  for (const request of crafted) {
    const result = await run(electron, [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--p9-open', JSON.stringify(request)], { env });
    assert.equal(result.code, 0, JSON.stringify(request));
  }
  // A good request after them opens, so the bad ones had their turn; each one was refused, and none is the active tab.
  await run(electron, [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--p9-open', JSON.stringify({ open: 'edit', path: path.join(w, 'marker.txt'), line: 1 })], { env });
  await opened('marker.txt');
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(mainErr.match(/p9: open request refused/g)?.length, crafted.length, mainErr);
  const tabs = await dev.evaluate(() => window.devFocus.v.window.tabGroups.all.flatMap(group => group.tabs.map(tab => tab.label)));
  assert.ok(!tabs.some(label => /secret|link|folder/.test(label)), tabs.join(', '));
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
});
