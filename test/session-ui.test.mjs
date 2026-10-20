import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));

test('Phase 9: session controls define all four exits and persistence is one click', async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'p9-phase9-ui-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--user-data-dir=' + profile], env, chromiumSandbox: true });
  const page = await application.firstWindow();
  await page.click('#themeBtn');
  await page.click('[data-theme-pick="redline"]');
  await page.click('#stopAll');
  await page.waitForTimeout(500);
  const dialog = page.locator('#stopDlg');
  const text = await dialog.innerText();
  for (const label of ['Close Window', 'Quit UI', 'Stop Session', 'Stop All']) assert.match(text, new RegExp(label));
  assert.match(text, /Persistent is the default/);
  assert.equal(await page.locator('#sessionMode').innerText(), 'Persistent: on');
  if (process.env.P9_PHASE9_SCREENSHOT) {
    await mkdir(path.dirname(process.env.P9_PHASE9_SCREENSHOT), { recursive: true });
    await page.screenshot({ path: process.env.P9_PHASE9_SCREENSHOT });
  }
  await page.click('#sessionMode');
  assert.equal(await page.locator('#sessionMode').innerText(), 'Dies with app: on');
  assert.match(await page.locator('#sessionModeNote').innerText(), /runs Stop All first/);
  await page.click('#sessionMode');
  assert.equal(await page.locator('#sessionMode').innerText(), 'Persistent: on');
  await application.close();
  console.log('PASS phase9 UI: Close Window, Quit UI, Stop Session and Stop All are visible; persistent is default; dies-with-app is one click');
});
