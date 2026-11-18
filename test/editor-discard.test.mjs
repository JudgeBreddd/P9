// O173 (part B): a draft in a real file's modal (the Chat Focus Files pane) can be thrown away. Before, the modal kept the
// 'live:' draft over a close and offered only Save, so the edit came back on every reopen. Real Electron, a real daemon.
// The dev space keeps no files: the picture goes out in the log as "P9_SHOT <name> <base64>".
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, root, openFiles } from './helpers.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const settle = async (check, what, ms = 10000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (await check()) return; assert.fail('timed out: ' + what); };

test('O173 Discard: a real file\'s modal drops the draft, shows the disk copy, writes nothing, and a reopen shows no draft', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async (paths) => {
    const w = paths.workspace;
    for (const dir of ['_tyler', 'hub', 'proj']) await mkdir(path.join(w, dir), { recursive: true });
    await writeFile(path.join(w, 'hub/registry.json'), JSON.stringify({ scripts: [], apps: [], pages: [] }));
    await writeFile(path.join(w, 'AGENTS.md'), '# Projects\n\n**Main project: Proj** (`proj/`)\n');
    await writeFile(path.join(w, 'proj/notes.md'), 'on disk\n');
    await writeFile(path.join(paths.directory, 'settings.json'), JSON.stringify({ waiting: '_tyler', registry: 'hub/registry.json', primary: 'AGENTS.md' }));
    return { args: ['--acp-override', fake, '--settings', path.join(paths.directory, 'settings.json')] };
  });
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-discard-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1300, height: 860 }).catch(() => {});
  await openFiles(page);
  await page.locator('#tree .where', { hasText: 'proj' }).waitFor({ timeout: 10000 });
  const disk = () => readFile(path.join(instance.workspace, 'proj/notes.md'), 'utf8');
  const ta = () => page.locator('#mdlBody textarea');
  const openFile = async () => { await page.locator('#tree [data-lfile="proj/notes.md"]').click();
    await page.waitForFunction(() => document.querySelector('#mdlBody textarea')?.value.length > 0, null, { timeout: 8000 }); };

  await openFile();
  assert.equal(await page.locator('#mdlFoot [data-discard]').count(), 0, 'no Discard without a draft');
  await ta().fill('unwanted edit\n');
  const discard = page.locator('#mdlFoot [data-discard]');
  await discard.waitFor({ timeout: 3000 }).catch(() => {});
  console.log('P9_SHOT o173-draft ' + (await page.screenshot({ animations: 'disabled' })).toString('base64'));
  assert.equal(await discard.count(), 1, 'a draft offers Discard beside Save');
  await discard.click();
  await page.waitForFunction(() => document.querySelector('#mdlBody textarea')?.value === 'on disk\n', null, { timeout: 8000 });
  assert.equal(await page.locator('#mdlFoot [data-savefile]').count(), 0, 'no draft left to save');
  assert.equal(await disk(), 'on disk\n', 'the file on disk is untouched');

  // Closed without saving after a Discard, the modal opens on the disk copy, not the old draft.
  await ta().fill('second unwanted\n');
  await page.locator('#mdlFoot [data-discard]').click();
  await page.keyboard.press('Escape');
  await openFile();
  assert.equal(await ta().inputValue(), 'on disk\n', 'a reopen shows the disk copy, no draft');
  assert.equal(await disk(), 'on disk\n');
  // A save on its way cannot be called back, so Discard waits for it: main holds the save before it reaches the daemon, a
  // Discard clicked meanwhile does nothing, and once the save lands the disk and the view both hold the saved text.
  await app.evaluate(({ ipcMain }) => {
    const h = ipcMain._invokeHandlers.get('p9:mission'); ipcMain.removeHandler('p9:mission');
    globalThis.o173 = { held: 0 }; globalThis.o173.gate = new Promise((go) => { globalThis.o173.go = go; });
    ipcMain.handle('p9:mission', async (e, action, ...rest) => { if (action === 'save') { globalThis.o173.held++; await globalThis.o173.gate; } return h(e, action, ...rest); });
  });
  await ta().fill('kept\n');
  await page.locator('#mdlFoot [data-savefile]').click();
  await settle(() => app.evaluate(() => globalThis.o173.held === 1), 'the save is held in main');
  const held = await page.evaluate(() => { const b = document.querySelector('#mdlFoot [data-discard]'); b?.click(); return { shown: !!b, disabled: !!b?.disabled }; });
  await page.waitForTimeout(800);
  await app.evaluate(() => globalThis.o173.go());
  await settle(async () => (await disk()) === 'kept\n', 'the held save writes');
  await page.waitForTimeout(800);
  assert.equal(await ta().inputValue(), await disk(), 'after the held save the view shows what is on disk');
  assert.equal(await disk(), 'kept\n', 'the saved text is on disk');
  assert.deepEqual(held, { shown: true, disabled: true }, 'Discard is disabled while a save is on its way');
  // The same through Ctrl S, with the modal closed and the file reopened while the save is held: the reopen is a new modal on
  // the same shared draft, so it must see the save on its way too, and the save's answer redraws the reopened modal.
  await app.evaluate(() => { globalThis.o173 = { held: 0 }; globalThis.o173.gate = new Promise((go) => { globalThis.o173.go = go; }); });
  await ta().fill('reopened\n');
  await page.keyboard.press('Control+s');
  await settle(() => app.evaluate(() => globalThis.o173.held === 1), 'the Ctrl S save is held in main');
  await page.keyboard.press('Escape');
  await openFile();
  const again = await page.evaluate(() => { const b = document.querySelector('#mdlFoot [data-discard]'); b?.click(); return { shown: !!b, disabled: !!b?.disabled }; });
  await page.waitForTimeout(800);
  await app.evaluate(() => globalThis.o173.go());
  await settle(async () => (await disk()) === 'reopened\n', 'the held Ctrl S save writes');
  await page.waitForTimeout(800);
  assert.equal(await ta().inputValue(), await disk(), 'after a close and reopen, the held save leaves the view on what is on disk');
  assert.equal(await page.locator('#mdlFoot [data-savefile]').count(), 0, 'the reopened modal redraws as saved when the save answers');
  assert.deepEqual(again, { shown: true, disabled: true }, 'a reopened modal sees the save on its way: Discard disabled');
  console.log('PASS O173 discard live');
});
