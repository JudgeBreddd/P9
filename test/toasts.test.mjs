// D7 for every screen: a toast draws above any open modal (Settings, the connecting screen) and a click on it works there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));

test('D7: a toast is on top of Settings and the connecting screen opened after it, and a click on it opens its message', { timeout: 60000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'p9-toasts-'));
  const env = { ...process.env, P9_SAMPLE_DATA: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--user-data-dir=' + profile], env, timeout: 15000 });
  t.after(() => app.close());
  const page = await app.firstWindow({ timeout: 15000 });
  await page.locator('#cards .card').first().waitFor({ timeout: 15000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 900));
  await page.evaluate(() => document.documentElement.style.setProperty('--toast-life', '600s'));
  // The point a person would click: the toast's middle, as the page hit-tests it (an inert or covered toast is not hit).
  const onTop = (txt) => page.evaluate((txt) => {
    const el = [...document.querySelectorAll('#toasts .toast')].find(x => x.textContent.includes(txt)), r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  }, txt);
  const shot = async (name) => {
    await page.waitForTimeout(700); // the dialog painted and the toast's entry run, so the picture is the screen
    const png = (await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64')));
    if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png);
  };
  await page.evaluate(() => window.__toast({ kind: 'chat', txt: 'Before Settings opened', level: 'bad' }, true));
  await page.click('#setBtn');
  await page.locator('#setDlg[open]').waitFor({ timeout: 5000 });
  assert.equal(await onTop('Before Settings opened'), true, 'above Settings, opened after it');
  await shot('d7-toast-over-settings');
  await page.locator('#toasts .toast', { hasText: 'Before Settings opened' }).click({ timeout: 5000 });
  await page.locator('#mdl[open] #mdlBody', { hasText: 'Before Settings opened' }).waitFor({ timeout: 5000 });
  await page.evaluate(() => { document.querySelector('#mdl').close(); document.querySelector('#setDlg').close(); });
  // The connecting screen (a full-window modal) over a toast; then the toast is clicked there and its message opens over both.
  // (Closing a message dismisses its toast, so this half has its own.)
  await page.evaluate(() => window.__toast({ kind: 'chat', txt: 'Under the connecting screen', level: 'bad' }, true));
  await page.evaluate(() => { document.querySelector('#connecting').showModal(); });
  assert.equal(await onTop('Under the connecting screen'), true, 'above the connecting screen');
  await shot('d7-toast-over-connecting');
  await page.locator('#toasts .toast', { hasText: 'Under the connecting screen' }).click({ timeout: 5000 });
  await page.locator('#mdl[open] #mdlBody', { hasText: 'Under the connecting screen' }).waitFor({ timeout: 5000 });
  assert.equal(await onTop('Under the connecting screen'), true, 'still on top of the message it opened');
  console.log('PASS D7 toasts: on top of and clickable over Settings, the connecting screen, and the message panel');
});
