// O122: P9 opens in Chat (or the first view still on, if Chat is off). No landing page, and its video and poster are never asked for at startup (the startup trace of
// 2026-11-15 put the landing at 3.67 MiB of video plus a 193 KiB poster before the first useful paint). Old settings files
// that still say startLast load with the name kept. With no flag, the first run opens the setup wizard by itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, root, versionSeen } from './helpers.mjs';

const MEDIA = /horizon-loop[^/]*\.mp4|black-hole[^/]*\.webp/; // the landing's two media files (black-hole.css is the connecting screen's, not media)

async function launch(t, instance, profile, env) {
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  const asked = [];
  page.on('request', (request) => asked.push(request.url()));
  return { app, page, asked };
}

test('Start in Chat: the first view is Chat, no landing media is asked for, and an old startLast file keeps its name', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t);
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-start-')), profile = path.join(home, 'profile');
  await mkdir(profile, { recursive: true });
  // A file from 0.1.8: the name and startLast. startLast is gone; the file must still load (zoom and name kept).
  await writeFile(path.join(profile, 'p9-settings.json'), JSON.stringify({ zoom: 1.1, closeOnSend: false, focus: { chat: true, dev: true, mission: true }, name: 'Tess', startLast: false }));
  await versionSeen(profile);
  const env = { ...process.env, P9_FIRST_RUN: 'off' }; delete env.ELECTRON_RUN_AS_NODE; delete env.P9_LANDING;
  const { app, page, asked } = await launch(t, instance, profile, env);
  // Every 100 ms from the first frame for 3 s: what is on screen.
  const look = () => page.evaluate(() => {
    const shell = document.querySelector('.shell'), land = document.querySelector('#land');
    return { focus: shell?.dataset.focus, shown: !!shell && getComputedStyle(shell).visibility !== 'hidden' && shell.getBoundingClientRect().width > 0,
      landing: !!land?.open || !!land?.hasAttribute('data-pending') && getComputedStyle(shell).visibility === 'hidden' };
  }).catch((error) => ({ error: error.message }));
  await page.locator('.shell').waitFor({ timeout: 20000 });
  const seen = [];
  for (let i = 0; i < 30; i++) { seen.push(await look()); await page.waitForTimeout(100); }
  await page.waitForTimeout(2000); // the old 3 s fallback start, and any late media fetch
  seen.push(await look());
  const media = await page.evaluate((re) => [
    ...performance.getEntriesByType('resource').map((e) => e.name),
    ...[...document.querySelectorAll('[src], [poster]')].flatMap((e) => [e.getAttribute('src'), e.getAttribute('poster')]),
  ].filter((u) => u && new RegExp(re).test(u)), MEDIA.source);
  console.log('P9_START ' + JSON.stringify({ first: seen[0], last: seen.at(-1), asked: asked.filter((u) => MEDIA.test(u)), media }));
  assert.deepEqual(seen.filter((s) => s.landing || s.error), [], 'no landing page at any point');
  assert.deepEqual(seen.filter((s) => s.focus !== 'chat' || !s.shown), [], 'Chat is the first and only view drawn');
  assert.deepEqual(asked.filter((u) => MEDIA.test(u)), [], 'no request for the landing video or poster');
  assert.deepEqual(media, [], 'no landing media in the page');
  const settings = await page.evaluate(() => window.p9.getSettings());
  assert.equal(settings.zoom, 1.1, 'the old file loaded rather than the defaults');
  assert.equal(settings.name, 'Tess');
  assert.equal('startLast' in settings, false);
  // The top-left mark keeps the window in Chat (it opened the landing before).
  await page.click('#brandBtn');
  await page.waitForTimeout(300);
  assert.deepEqual(await look(), { focus: 'chat', shown: true, landing: false });
  // Settings keeps "Your name" and no longer offers "Start in my last focus mode".
  await page.click('#setBtn');
  assert.equal(await page.locator('#setName').inputValue(), 'Tess');
  assert.equal(await page.locator('#setStartLast').count(), 0);
  await app.close();

  // A file that still holds startLast: true (saved by 0.1.8) opens in Chat and keeps its name; the next save drops the key.
  await writeFile(path.join(profile, 'p9-settings.json'), JSON.stringify({ zoom: 1.1, closeOnSend: false, focus: { chat: true, dev: true, mission: true }, name: 'Tess', startLast: true }));
  const again = await launch(t, instance, profile, env);
  await again.page.locator('.shell').waitFor({ timeout: 20000 });
  await again.page.waitForTimeout(1000);
  assert.equal(await again.page.evaluate(() => document.querySelector('.shell').dataset.focus), 'chat');
  const kept = await again.page.evaluate(() => window.p9.getSettings());
  assert.deepEqual([kept.zoom, kept.name, 'startLast' in kept], [1.1, 'Tess', false]);
  await again.page.evaluate((s) => window.p9.setSettings(s), kept);
  assert.equal('startLast' in JSON.parse(await readFile(path.join(profile, 'p9-settings.json'), 'utf8')), false);
  console.log('PASS start in Chat: ' + JSON.stringify(seen.at(-1)));
});

// Chat Focus can still be turned off (Builder, 2026-11-16: "b"): P9 opens in Chat only while Chat is on. A file with Chat
// off (here Dev off too) opens on the first view still on, keeps Chat off and keeps the rest of its settings.
test('Start in Chat: with Chat Focus off, P9 opens on the first view still on and keeps the settings', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t);
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-start-off-')), profile = path.join(home, 'profile');
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(profile, 'p9-settings.json'), JSON.stringify({ zoom: 1.1, closeOnSend: true, focus: { chat: false, dev: false, mission: true }, name: 'Tess', startLast: true }));
  await versionSeen(profile);
  const env = { ...process.env, P9_FIRST_RUN: 'off' }; delete env.ELECTRON_RUN_AS_NODE; delete env.P9_LANDING;
  const { page } = await launch(t, instance, profile, env);
  await page.locator('.shell').waitFor({ timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('.shell').dataset.focus === 'mission', null, { timeout: 5000 })
    .catch(() => {});
  assert.equal(await page.evaluate(() => document.querySelector('.shell').dataset.focus), 'mission', 'the first view still on');
  const kept = await page.evaluate(() => window.p9.getSettings());
  assert.deepEqual({ focus: kept.focus, zoom: kept.zoom, closeOnSend: kept.closeOnSend, name: kept.name, startLast: 'startLast' in kept },
    { focus: { chat: false, dev: false, mission: true }, zoom: 1.1, closeOnSend: true, name: 'Tess', startLast: false });
  assert.deepEqual(await page.evaluate(() => ['chat', 'dev', 'mission'].map((f) => !document.querySelector(`[data-focus-btn="${f}"]`)?.hidden)), [false, false, true]);
  // The top-left mark does not open a Chat that is turned off.
  await page.click('#brandBtn');
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => document.querySelector('.shell').dataset.focus), 'mission');
  // Chat's box in Settings is off and can be turned back on; Mission's is the last one on, so it is locked.
  await page.click('#setBtn');
  await page.locator('#setDlg[open]').waitFor();
  await page.click('[data-set-page="Dev Focus"]').catch(() => {});
  assert.deepEqual(await page.evaluate(() => ['chat', 'mission'].map((f) => { const b = document.querySelector('#setF-' + f); return b && [b.checked, b.disabled]; })),
    [[false, false], [true, true]], "Chat's box off and free; Mission's on and locked");
  console.log('PASS chat-off file opens on the first view on: ' + JSON.stringify(kept.focus));
});

// The first run used to start when the landing page closed. With no landing, it starts with the window: the wizard while a
// setup check fails (this daemon has no settings), then the walkthrough.
test('Start in Chat: the first run opens the setup wizard by itself, then the walkthrough', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t);
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-start-first-')), profile = path.join(home, 'profile');
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(profile, 'p9-settings.json'), JSON.stringify({ focus: { chat: true, dev: true, mission: true } }));
  await versionSeen(profile);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.P9_LANDING; delete env.P9_FIRST_RUN;
  const { page } = await launch(t, instance, profile, env);
  await page.locator('#welDlg[open]').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('#walk').count(), 0, 'the walkthrough waits for the wizard');
  await page.click('#welFoot [data-act="skip"]');
  await page.locator('#walk').waitFor({ timeout: 5000 });
  assert.equal(await page.evaluate(() => document.querySelector('.shell').dataset.focus), 'chat');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#walk'));
  await page.reload();
  await page.locator('.shell').waitFor();
  await page.waitForTimeout(1500);
  assert.deepEqual(await page.evaluate(() => [!!document.querySelector('#welDlg[open]'), !!document.querySelector('#walk')]), [false, false], 'the first run happens once');
  console.log('PASS first run at start');
});
