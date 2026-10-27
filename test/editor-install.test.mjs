// D5 (threat model row 52): Dev Focus's editor server is installed from the pinned download only, checked by SHA-256 and
// product.json's commit, and a fresh Linux install without it shows the cause and one Install button. Everything runs on a
// stand-in tarball served on loopback, in throwaway folders: never against this machine's own P9 folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { root, daemon } from './helpers.mjs';
import { installEditorHost, editorDownload, EDITOR_DOWNLOADS, EDITOR_COMMIT } from '../apps/desktop/editor-host.mjs';

const linux = process.platform === 'linux';
// A stand-in REH: product.json with the given commit and a codium-server that exits at once.
async function standIn(t, commit = EDITOR_COMMIT) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-reh-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'src', 'bin'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'product.json'), JSON.stringify({ commit }));
  await writeFile(path.join(dir, 'src', 'bin', 'codium-server'), '#!/bin/sh\nexit 3\n', { mode: 0o755 });
  assert.equal(spawnSync('tar', ['-czf', path.join(dir, 'reh.tar.gz'), '-C', path.join(dir, 'src'), '.']).status, 0);
  const bytes = readFileSync(path.join(dir, 'reh.tar.gz'));
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}
async function serve(t, bytes) {
  const hits = [];
  const server = createServer((req, res) => { hits.push(req.url); res.writeHead(200, { 'content-type': 'application/gzip' }); res.end(bytes); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { url: 'http://127.0.0.1:' + server.address().port + '/reh.tar.gz', hits };
}

test('D5: the pinned downloads are the README\'s, Linux only', { timeout: 60000 }, () => {
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.ok(readme.includes(EDITOR_DOWNLOADS.x64[0]), 'x64 URL as in the README');
  assert.ok(readme.includes(EDITOR_DOWNLOADS.x64[1]), 'x64 SHA-256 as in the README');
  assert.deepEqual(editorDownload('linux', 'x64'), EDITOR_DOWNLOADS.x64);
  assert.equal(editorDownload('linux', 'ia32'), null);
  assert.equal(editorDownload('win32', 'x64'), null);
  assert.equal(editorDownload('darwin', 'arm64'), null);
});

test('D5: install checks the SHA-256 and the commit, keeps an old install, and leaves no temp folder', { skip: !linux, timeout: 60000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-editor-dir-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const good = await standIn(t), { url } = await serve(t, good.bytes);

  // A download that does not match the pin: nothing unpacked, nothing installed, no temp folder.
  await assert.rejects(installEditorHost({ dir, download: [url, 'f'.repeat(64)] }), /editor-download-mismatch/);
  assert.deepEqual(await readdir(dir), []);

  // Too big for the cap: stopped, nothing left.
  await assert.rejects(installEditorHost({ dir, download: [url, good.sha256], max: 10 }), /editor-download-too-big/);
  assert.deepEqual(await readdir(dir), []);

  // Nothing listening: a plain failure.
  await assert.rejects(installEditorHost({ dir, download: ['http://127.0.0.1:9/reh.tar.gz', good.sha256] }), /editor-download-failed/);
  assert.deepEqual(await readdir(dir), []);

  // A good download whose product.json names another commit: refused after unpacking, nothing installed.
  const other = await standIn(t, 'a'.repeat(40)), otherServed = await serve(t, other.bytes);
  await assert.rejects(installEditorHost({ dir, download: [otherServed.url, other.sha256] }), /editor-host-commit-mismatch/);
  assert.deepEqual(await readdir(dir), []);

  // The good one installs.
  assert.deepEqual(await installEditorHost({ dir, download: [url, good.sha256] }), { installed: path.join(dir, 'codium-server') });
  assert.equal(JSON.parse(await readFile(path.join(dir, 'codium-server', 'product.json'), 'utf8')).commit, EDITOR_COMMIT);
  assert.ok(existsSync(path.join(dir, 'codium-server', 'bin', 'codium-server')));
  assert.deepEqual(await readdir(dir), ['codium-server']);

  // Installing again keeps the old folder beside the new one, never deleted.
  await writeFile(path.join(dir, 'codium-server', 'mine.txt'), 'kept');
  await installEditorHost({ dir, download: [url, good.sha256] });
  const names = (await readdir(dir)).sort();
  assert.equal(names.length, 2);
  assert.equal(names[0], 'codium-server');
  assert.match(names[1], /^codium-server\.replaced-\d+$/);
  assert.equal(await readFile(path.join(dir, names[1], 'mine.txt'), 'utf8'), 'kept');
});

// Item 16: the AppImage carries the pinned file (resources/editor/reh.tar.gz) and installs it from disk on its first start; the
// same checks as a download, and no network.
test('Item 16: the AppImage\'s own copy installs through the same SHA-256 and commit checks', { skip: !linux, timeout: 60000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-editor-copy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const good = await standIn(t), copy = path.join(dir, 'resources', 'editor', 'reh.tar.gz'), target = path.join(dir, 'share');
  await mkdir(path.dirname(copy), { recursive: true });
  await writeFile(copy, good.bytes);
  // A copy that is not the pinned file, or no copy at all: nothing installed, no temp folder.
  await assert.rejects(installEditorHost({ dir: target, download: [copy, 'f'.repeat(64)] }), /editor-download-mismatch/);
  assert.deepEqual(await readdir(target), []);
  await assert.rejects(installEditorHost({ dir: target, download: [copy + '.gone', good.sha256] }), /editor-download-failed/);
  assert.deepEqual(await readdir(target), []);
  assert.deepEqual(await installEditorHost({ dir: target, download: [copy, good.sha256] }), { installed: path.join(target, 'codium-server') });
  assert.equal(JSON.parse(await readFile(path.join(target, 'codium-server', 'product.json'), 'utf8')).commit, EDITOR_COMMIT);
  // The AppImage build ships it under that name, beside the daemon's node.
  const linuxBuild = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).build.linux.extraResources;
  assert.ok(linuxBuild.some(each => each.from === '.build/editor/reh.tar.gz' && each.to === 'editor/reh.tar.gz'));
});

// The desktop on a fresh Linux install: no editor server. Dev Focus names it and offers Install; Install downloads the
// stand-in (loopback, its SHA-256 given through the test-only variables), and Dev Focus opens again past "not installed".
test('D5: Dev Focus without the editor server names it and installs it with one button', { skip: !linux, timeout: 60000 }, async t => {
  const deadline = Date.now() + 50000, left = () => Math.max(1000, deadline - Date.now());
  const instance = await daemon(t);
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-d5-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const good = await standIn(t), served = await serve(t, good.bytes);
  const env = { ...process.env, HOME: home, P9_EDITOR_SERVER_URL: served.url, P9_EDITOR_SERVER_SHA256: good.sha256 };
  delete env.ELECTRON_RUN_AS_NODE; delete env.P9_EDITOR_HOST;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + path.join(home, 'profile')], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise(resolve => setTimeout(resolve, 15000))]); proc.kill(); });
  const shot = async (name, page) => {
    const png = await page.screenshot({ type: 'png' });
    if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png.toString('base64'));
  };
  const nextPage = () => app.waitForEvent('window', { predicate: page => page.url().startsWith('p9://dev/'), timeout: left() });
  const shell = await app.firstWindow();
  await shell.locator('#cards .card').first().waitFor({ timeout: left() });
  let page = nextPage();
  await shell.keyboard.press('Control+2');
  let dev = await page;
  await dev.locator('#cause').waitFor({ timeout: left() });
  assert.match(await dev.locator('#cause').innerText(), /needs VSCodium's editor server \(release 1\.121\.03429\), and it is not installed/);
  assert.ok((await dev.locator('#cause').innerText()).includes(path.join(home, '.local', 'share', 'p9', 'codium-server')));
  assert.equal(await dev.locator('#install').innerText(), 'Install the editor server');
  await shot('d5-dev-focus-install-prompt', dev);

  // The IPC takes no arguments and only the Dev Focus page: the shell's page and an extra argument are refused.
  const refused = await app.evaluate(async ({ ipcMain, webContents, BrowserWindow }) => {
    const handler = ipcMain._invokeHandlers.get('p9dev:install-editor'), results = [];
    const shellContents = BrowserWindow.getAllWindows()[0].webContents, devContents = webContents.getAllWebContents().find(c => c.getURL().startsWith('p9://dev/'));
    for (const [sender, args] of [[shellContents, []], [devContents, ['x']]]) {
      try { await handler({ sender, senderFrame: sender.mainFrame }, ...args); results.push(false); } catch (e) { results.push(e.message === 'ipc-sender-refused'); }
    }
    return results;
  });
  assert.deepEqual(refused, [true, true]);
  assert.equal(served.hits.length, 0, 'nothing downloaded before the button');

  page = nextPage();
  await dev.locator('#install').click();
  dev = await page;
  await dev.locator('#cause').waitFor({ timeout: left() });
  assert.equal(served.hits.length, 1);
  const installed = path.join(home, '.local', 'share', 'p9', 'codium-server');
  assert.equal(JSON.parse(await readFile(path.join(installed, 'product.json'), 'utf8')).commit, EDITOR_COMMIT);
  // The stand-in server exits at once, so Dev Focus now says it did not start: no longer "not installed", no button.
  // With no systemd user session (a container) issue #14's page names that cause instead.
  assert.match(await dev.locator('#cause').innerText(), /the editor server on this computer did not start|this computer has no systemd user session/);
  assert.equal(await dev.locator('#install').count(), 0);
  await shot('d5-dev-focus-after-install', dev);
});

// install.sh runs the same install (as node scripts/install-editor.mjs); release-install.test.mjs checks the order.
test('D5: install-editor.mjs leaves an install on the pinned commit alone', { skip: !linux, timeout: 60000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-d5-script-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const host = path.join(home, '.local', 'share', 'p9', 'codium-server');
  await mkdir(host, { recursive: true });
  await writeFile(path.join(host, 'product.json'), JSON.stringify({ commit: EDITOR_COMMIT }));
  const env = { ...process.env, HOME: home, P9_EDITOR_SERVER_URL: 'http://127.0.0.1:9/never', P9_EDITOR_SERVER_SHA256: '0'.repeat(64) };
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'install-editor.mjs')], { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already installed/);
  // Missing, with a download that fails its checksum: exits non-zero and installs nothing (install.sh then goes on).
  await rm(path.join(host, 'product.json'));
  const good = await standIn(t), served = await serve(t, good.bytes);
  // Async: the stand-in server runs in this process, so a blocking spawn would starve it.
  const bad = await promisify(execFile)(process.execPath, [path.join(root, 'scripts', 'install-editor.mjs')], { env: { ...env, P9_EDITOR_SERVER_URL: served.url }, encoding: 'utf8', timeout: 30000 })
    .then(() => ({ code: 0, stderr: '' }), error => error);
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /editor-download-mismatch/);
  assert.deepEqual(await readdir(path.join(home, '.local', 'share', 'p9')), ['codium-server']);
});
