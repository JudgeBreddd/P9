// The landing on a window's first load, with no reload first (Builder, 2026-10-31: "when i first open P9, the animation doesnt
// animate ... it only animates the way it should when i go to a focus and then back"; "the first one is wrong"). With the video
// it opens on the page the top bar's mark opens: no intro, no P9 mark (2026-10-29: "A. remove it"). landing-video.test.mjs reloads first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, root, versionSeen } from './helpers.mjs';

test('Landing, first load: the main stage straight away, no P9 mark, the video plays', { timeout: 90000 }, async (t) => {
  const instance = await daemon(t);
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-land-first-')), profile = path.join(home, 'profile');
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(profile, 'p9-settings.json'), JSON.stringify({ focus: { chat: true, dev: true, mission: true } }));
  await versionSeen(profile);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.P9_LANDING;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  const look = () => page.evaluate(() => {
    const land = document.querySelector('#land'), cosmos = document.querySelector('.p9-cosmos'), video = cosmos?.querySelector('video');
    return { open: land.open, stage: land.dataset.stage, run: land.hasAttribute('data-run'), state: cosmos?.dataset.videoState, paused: video?.paused,
      time: video && Math.round(video.currentTime * 10) / 10, ready: video?.readyState, hidden: document.hidden, visibility: document.visibilityState,
      mark: !!land.querySelector('.land-mark') };
  });
  const seen = [];
  for (let i = 0; i < 14; i++) { seen.push(await look().catch(error => ({ error: error.message }))); await page.waitForTimeout(500); }
  for (const [i, s] of seen.entries()) console.log('P9_FIRST t=' + (i / 2) + 's ' + JSON.stringify(s));
  const shot = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
  console.log('P9_SHOT landing-first ' + shot);
  const shown = seen.filter(s => s.open), last = seen.at(-1);
  assert.ok(shown.length >= 10, 'the landing is open: ' + JSON.stringify(seen[0]));
  for (const s of shown) assert.deepEqual([s.stage, s.run, s.mark], ['main', false, false], 'no intro and no mark, from the first frame: ' + JSON.stringify(s));
  assert.equal(last.state, 'playing', 'the landing video plays on the first load');
  assert.ok(last.time > seen.at(-5).time, 'the video is moving');
  console.log('PASS landing first load: ' + JSON.stringify(last));
});
