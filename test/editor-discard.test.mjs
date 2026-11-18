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
  console.log('PASS O173 discard live');
});
