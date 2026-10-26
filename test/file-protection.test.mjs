// File protection (threat model row 4; Builder, 2026-10-18): on by default the guarded save refuses locked names and the
// script list; the desktop turns it off only after a native warning, the choice survives a restart, and on means refused again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, restart, http, authenticated, root } from './helpers.mjs';
import { hash } from '../packages/files/index.mjs';
import { REPO } from '../apps/server/anymouse.mjs';

const LOCKED = ['.env', '_' + 'private/key.txt', 'secrets/token.txt', '.git/config', '.p9-mine.txt', 'registry.json'];
const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((result) => ({ status: result.status, body: JSON.parse(result.text) }));
const disk = (instance, name) => readFile(path.join(instance.workspace, name), 'utf8');
// Saves each locked file with its true hash; returns the status per file.
async function saveAll(instance, content) {
  const out = [];
  for (const name of LOCKED) out.push((await call(instance, '/files', 'PUT', { path: name, hash: hash(await disk(instance, name)), content })).status);
  return out;
}

test('File protection: refused while on, a native warning before off, kept across a restart', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async ({ workspace, directory }) => {
    for (const name of LOCKED) { await mkdir(path.dirname(path.join(workspace, name)), { recursive: true }); await writeFile(path.join(workspace, name), 'original ' + name); }
    await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ primary: 'note.txt', registry: 'registry.json', waiting: '_tyler' }));
    return { args: ['--settings', path.join(directory, 'settings.json')] };
  });

  // On by default: every locked name and the script list refused, nothing changed on disk, locked names left out of the listing.
  assert.deepEqual((await call(instance, '/file-protection')).body, { on: true });
  assert.deepEqual(await saveAll(instance, 'changed'), [400, 400, 400, 400, 400, 403]);
  for (const name of LOCKED) assert.equal(await disk(instance, name), 'original ' + name);
  assert.deepEqual((await call(instance, '/files/list?path=')).body.entries.map((e) => e.name), ['note.txt', 'registry.json']);
  // The route takes exactly { on: boolean }.
  for (const bad of [{ on: 'off' }, { on: false, x: 1 }, {}, [false], null]) assert.equal((await call(instance, '/file-protection', 'POST', bad)).status, 400);
  assert.deepEqual((await call(instance, '/file-protection')).body, { on: true });

  // The desktop: Keep answers leave it on; "Read about the risk" opens the docs and asks again; Turn off turns it off.
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-protect-')), opened = path.join(home, 'opened.txt'), browser = path.join(home, 'browser');
  await writeFile(browser, '#!/bin/sh\nprintf "%s\\n" "$1" >> ' + opened + '\n');
  await chmod(browser, 0o755);
  const env = { ...process.env, P9_OPEN_URL: browser }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + path.join(home, 'profile')], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#rChat').waitFor();
  const answers = (list) => app.evaluate(({ dialog }, list) => {
    globalThis.asked = [];
    dialog.showMessageBox = async (_window, options) => { globalThis.asked.push(options); return { response: list.shift() ?? 0 }; };
  }, list);
  const asked = () => app.evaluate(() => globalThis.asked.map(({ type, title, buttons, defaultId, cancelId, detail }) => ({ type, title, buttons, defaultId, cancelId, detail })));
  // Case: anything but one boolean from the shell's own frame is refused.
  const refused = await app.evaluate(async ({ ipcMain, BrowserWindow }) => {
    const sender = BrowserWindow.getAllWindows()[0].webContents, handler = ipcMain._invokeHandlers.get('p9:file-protection'), frame = { sender, senderFrame: sender.mainFrame };
    const out = [];
    for (const args of [['off'], [0], [false, false], [null]]) out.push(await handler(frame, ...args).then(() => 'accepted', (error) => error.message));
    out.push(await handler({ sender, senderFrame: null }, false).then(() => 'accepted', (error) => error.message));
    return out;
  });
  assert.deepEqual(refused, Array(5).fill('ipc-sender-refused'));

  await page.click('#setBtn');
  await page.locator('#setDlg[open] #setProtect:checked').waitFor();
  await answers([0]);
  // click, not uncheck: uncheck also checks the box ended up unchecked, and Keep puts it back, so a fast re-render failed it (flaky since 0.1.0).
  await page.click('#setProtect');
  await page.locator('#setProtect:checked').waitFor();
  const [warning] = await asked();
  assert.deepEqual({ ...warning, detail: undefined }, { type: 'warning', title: 'Turn off file protection?',
    buttons: ['Keep protection on', 'Turn off protection', 'Read about the risk'], defaultId: 0, cancelId: 0, detail: undefined });
  assert.match(warning.detail, /phone/); assert.match(warning.detail, /\.env/); assert.match(warning.detail, /turn protection back on/);
  assert.deepEqual((await call(instance, '/file-protection')).body, { on: true });

  await answers([2, 1]);
  await page.click('#setProtect');
  await page.locator('#setProtect:not(:checked)').waitFor();
  assert.equal((await asked()).length, 2);
  assert.equal((await readFile(opened, 'utf8')).trim(), 'https://github.com/' + REPO + '/blob/main/SECURITY.md#file-protection');
  assert.deepEqual((await call(instance, '/file-protection')).body, { on: false });
  if (process.env.P9_EVIDENCE) { await mkdir(process.env.P9_EVIDENCE, { recursive: true }); await page.screenshot({ path: path.join(process.env.P9_EVIDENCE, 'file-protection-off.png') }); }

  // Off: every one of them saves, and the listing shows them.
  assert.deepEqual(await saveAll(instance, 'changed'), [200, 200, 200, 200, 200, 200]);
  for (const name of LOCKED) assert.equal(await disk(instance, name), 'changed');
  assert.deepEqual((await call(instance, '/files/list?path=')).body.entries.map((e) => e.name), ['.env', '.git', '.p9-mine.txt', '_private', 'note.txt', 'registry.json', 'secrets']);

  // A restart keeps it off. Turning it on never asks, and on means refused again.
  instance.child.kill('SIGTERM');
  await once(instance.child, 'exit');
  const second = await restart(t, instance, 'state-2');
  assert.deepEqual((await call(second, '/file-protection')).body, { on: false });
  assert.deepEqual((await call(second, '/file-protection', 'POST', { on: true })).body, { on: true });
  assert.deepEqual(await saveAll(second, 'again'), [400, 400, 400, 400, 400, 403]);
  for (const name of LOCKED) assert.equal(await disk(second, name), 'changed');
  await answers([]);
  await app.evaluate(async ({ ipcMain, BrowserWindow }) => {
    const sender = BrowserWindow.getAllWindows()[0].webContents;
    return ipcMain._invokeHandlers.get('p9:file-protection')({ sender, senderFrame: sender.mainFrame }, true);
  });
  assert.equal((await asked()).length, 0);
});
