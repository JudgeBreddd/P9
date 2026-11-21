// O203: the walkthrough's steps load with the first walkthrough, not at startup. A load that fails says so in a toast and is
// tried again on the next open. The chunk's request is cancelled through the window's session (CDP Fetch never sees p9://),
// as in terminal-after-window.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, root, versionSeen } from './helpers.mjs';

const walk = readdirSync(path.join(root, 'apps/web/dist/_astro')).find((file) => /^walkthrough\..*\.js$/.test(file));

test('O203: a walkthrough whose steps failed to load says so, and opens on the next try', { timeout: 120000 }, async (t) => {
  assert.ok(walk, 'the walkthrough is its own chunk, not in the startup scripts');
  const instance = await daemon(t);
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-o203-')), 'profile');
  await mkdir(profile); await versionSeen(profile);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow({ timeout: 20000 });
  await page.waitForURL(/^p9:\/\/app\//, { timeout: 20000 });
  await page.locator('#rChat svg').waitFor({ timeout: 20000 });
  const block = (on) => app.evaluate(({ BrowserWindow }, { on, walk }) => {
    globalThis.o203Failed ??= 0;
    BrowserWindow.getAllWindows()[0].webContents.session.webRequest.onBeforeRequest(on ? (details, done) => {
      const hit = details.url.endsWith('/_astro/' + walk); if (hit) globalThis.o203Failed++;
      done({ cancel: hit });
    } : null);
  }, { on, walk });
  const open = async () => { await page.keyboard.press('Control+k'); await page.locator('#palette li', { hasText: 'Walkthrough' }).click(); };
  await block(true);
  await open();
  await page.locator('#toasts .toast', { hasText: 'Walkthrough did not load' }).waitFor({ timeout: 10000 });
  assert.equal(await page.locator('#walk').count(), 0, 'no bubble without its steps');
  assert.ok(await app.evaluate(() => globalThis.o203Failed) >= 1, 'the chunk request was cancelled');
  await block(false);
  // How long the first open waits for its steps: from the palette click to the bubble (logged, not asserted).
  await page.evaluate(() => {
    addEventListener('click', (e) => { if (e.target.closest('#palette li')) window.o203Click = performance.now(); }, true);
    new MutationObserver((m, o) => { if (document.querySelector('#walk')) { window.o203Shown = performance.now(); o.disconnect(); } }).observe(document.body, { childList: true });
  });
  await open();
  await page.locator('#walk .eyebrow', { hasText: /^1 of / }).waitFor({ timeout: 10000 });
  console.log('P9_O203 ' + JSON.stringify({ firstOpenMs: await page.evaluate(() => Math.round(window.o203Shown - window.o203Click)) }));
});
