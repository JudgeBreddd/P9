// D20: the desktop's connecting screen shows the same P9 black hole as the phone's loading screen (black-hole.html): inline SVG
// with no image request, bobbing in a turning ring, still with reduced motion; the dialog's words and progress row unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));

test('D20: the connecting screen draws the P9 black hole inline, moving, and still with reduced motion', { timeout: 60000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'p9-conn-hole-'));
  const env = { ...process.env, P9_SAMPLE_DATA: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--user-data-dir=' + profile], env, timeout: 15000 });
  t.after(() => app.close());
  const page = await app.firstWindow({ timeout: 15000 });
  await page.locator('#cards .card').first().waitFor({ timeout: 15000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 900));
  const shot = async (name) => {
    await page.waitForTimeout(300); // the dialog painted
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
    if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png);
  };
  const open = () => page.evaluate(() => { const d = document.querySelector('#connecting');
    document.querySelector('#connT').textContent = 'Connecting to test-host';
    document.querySelector('#connWhy').textContent = 'Opening the ssh tunnel and waiting for P9 there to answer.';
    document.querySelector('#connProgress').hidden = false; document.querySelector('#connStep').textContent = 'Installing the web app\'s packages';
    document.querySelector('#connTime').textContent = '0:12'; if (!d.open) d.showModal(); });
  const names = () => page.evaluate(() => ['.hole', '.shade', '.ring'].map((part) => getComputedStyle(document.querySelector('#connecting .bh ' + part)).animationName));
  for (const theme of ['event-horizon-prime', 'daylight']) {
    await page.click('#themeBtn'); await page.click('[data-theme-pick="' + theme + '"]'); await page.keyboard.press('Escape');
    await open();
    await page.locator('#connecting[open] .conn-hole svg.bh').waitFor({ timeout: 5000 });
    // The mark links nothing (no img, image, use, src or href) and the page never fetched the 512 px icon; a black core, no blur.
    const mark = await page.evaluate(() => { const hole = document.querySelector('#connecting .conn-hole');
      return { linked: hole.querySelectorAll('img, image, use, [src], [href]').length, core: getComputedStyle(hole.querySelector('.core')).fill,
        blurs: hole.querySelectorAll('feGaussianBlur').length, icon: performance.getEntriesByType('resource').filter((r) => /p9-icon/.test(r.name)).length }; });
    assert.deepEqual(mark, { linked: 0, core: 'rgb(0, 0, 0)', blurs: 0, icon: 0 });
    assert.deepEqual(await names(), ['bob', 'shade', 'spin']);
    const pose = () => page.evaluate(() => getComputedStyle(document.querySelector('#connecting .bh .hole')).transform);
    const first = await pose(); await page.waitForTimeout(250);
    assert.notEqual(await pose(), first, 'the hole is not bobbing');
    // The dialog's words and progress row are still there, under the mark.
    assert.deepEqual(await page.evaluate(() => ['#connT', '#connWhy', '#connProgress'].map((s) => document.querySelector(s).getBoundingClientRect().top > document.querySelector('#connecting .bh').getBoundingClientRect().bottom)), [true, true, true]);
    // An error toast over the dialog's own dark sky stays readable in a light theme: its red is mixed into the popover, not
    // see-through (Event Horizon Prime has its own glass toast, light text on a dark tint, readable over the sky).
    const toast = await page.evaluate(() => { const t = document.createElement('div'); t.className = 'toast bad'; t.textContent = 'Chat setup: unavailable';
      document.querySelector('#toasts').append(t);
      return getComputedStyle(t).backgroundColor; });
    if (theme === 'daylight') assert.doesNotMatch(toast, /\/ 0?\.\d|rgba\(.*, 0?\.\d+\)|transparent/, 'the error toast is see-through: ' + toast);
    await shot('d20-connecting-' + theme);
    await page.evaluate(() => document.querySelector('#toasts .toast.bad:last-child').remove());
    await page.evaluate(() => document.querySelector('#connecting').close());
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open();
  assert.deepEqual(await names(), ['none', 'none', 'none']);
  console.log('PASS D20: the connecting screen draws the black hole inline, moving, still with reduced motion');
});
