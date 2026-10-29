// Landing v5: the rendered loop plays inside #land in place of the WebGL sky; P9_LANDING=original is the rollback switch.
// Threat model row 3 (adds, landing v5): the app CSP's media-src 'self' is what lets the bundled video play.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, root, versionSeen } from './helpers.mjs';

test('Landing v5: the video plays in #land, the old sky loop is off, send-to-server keeps createSky, reduced motion shows the poster, the switch restores the sky', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t);
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-land-v5-')), profile = path.join(home, 'profile');
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(profile, 'p9-settings.json'), JSON.stringify({ focus: { chat: true, dev: true, mission: true } }));
  await versionSeen(profile);
  const launch = async (landing) => {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.P9_LANDING;
    if (landing) env.P9_LANDING = landing;
    const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
    const proc = app.process();
    t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
    const page = await app.firstWindow();
    await page.waitForFunction(() => document.querySelector('#land').open, null, { timeout: 20000 });
    // Which canvases asked for WebGL (createSky's first call), whether or not this machine has a GPU. A reload before the
    // landing closes shows it again.
    await app.context().addInitScript(() => {
      window.__gl = []; const get = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (kind, ...rest) { if (kind === 'webgl' && this.id) window.__gl.push(this.id); return get.call(this, kind, ...rest); };
    });
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#land').open && Array.isArray(window.__gl), null, { timeout: 20000 });
    return { app, page };
  };
  const look = (page) => page.evaluate(() => {
    const cosmos = document.querySelector('.p9-cosmos'), video = cosmos.querySelector('video'), sky = document.querySelector('#landSky');
    return { inLand: cosmos.parentElement.id, hidden: cosmos.hidden, state: cosmos.dataset.videoState, paused: video.paused,
      shown: getComputedStyle(video).display !== 'none' && getComputedStyle(video).opacity === '1', poster: cosmos.querySelector('img').complete && cosmos.querySelector('img').naturalWidth,
      skyHidden: sky.hidden, skyWidth: sky.width, skyWant: Math.round(sky.clientWidth * Math.min(devicePixelRatio || 1, 2)) };
  });

  let { app, page } = await launch();
  // The bundled video, past the CSP, playing in front of its poster.
  await page.waitForFunction(() => document.querySelector('.p9-cosmos').dataset.videoState === 'playing', null, { timeout: 15000 })
    .catch(async () => assert.fail('the landing video did not play: ' + JSON.stringify(await look(page))));
  const t0 = await page.evaluate(() => document.querySelector('.p9-cosmos video').currentTime);
  await page.waitForFunction((at) => document.querySelector('.p9-cosmos video').currentTime > at + 0.3, t0, { timeout: 5000 });
  let seen = await look(page);
  assert.equal(seen.inLand, 'land', 'mounted inside #land, not behind the shell');
  assert.equal(seen.hidden, false);
  assert.equal(seen.shown, true);
  assert.ok(seen.poster > 0, 'the poster loaded');
  // The old sky is never set up (no WebGL asked for, its canvas never sized); send-to-server's createSky still is.
  const gl = await page.evaluate(() => window.__gl);
  assert.ok(!gl.includes('landSky'), 'the landing sky is not set up: ' + gl);
  assert.ok(gl.includes('moveSky'), 'createSky still runs for send-to-server: ' + gl);
  assert.equal(seen.skyHidden, true);
  assert.equal(seen.skyWidth, 300);
  if (process.env.P9_EVIDENCE) {
    await mkdir(process.env.P9_EVIDENCE, { recursive: true });
    await page.waitForTimeout(3200); // past the 2.6 s intro, to the main stage
    await writeFile(path.join(process.env.P9_EVIDENCE, 'landing-v5-app.png'), Buffer.from(await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64')), 'base64'));
  }
  // Reduced motion: the video stops and hides; the still poster stays.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => document.querySelector('.p9-cosmos').dataset.videoState === 'still', null, { timeout: 5000 });
  seen = await look(page);
  assert.equal(seen.paused, true);
  assert.equal(seen.shown, false, 'reduced motion hides the video');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForFunction(() => document.querySelector('.p9-cosmos').dataset.videoState === 'playing', null, { timeout: 5000 });
  // Closing the landing (a focus pick) pauses it.
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('#land').dataset.stage === 'main', null, { timeout: 5000 });
  await page.keyboard.press('Digit1');
  await page.waitForFunction(() => !document.querySelector('#land').open, null, { timeout: 5000 });
  await page.waitForFunction(() => document.querySelector('.p9-cosmos video').paused, null, { timeout: 5000 });
  await app.close();

  // The rollback switch: the WebGL sky is back and drawing at full size, and the video is never mounted.
  ({ app, page } = await launch('original'));
  assert.ok((await page.evaluate(() => window.__gl)).includes('landSky'), 'original: the landing sky is set up again');
  await page.keyboard.press('Space');
  // Without WebGL (no GPU) the sky is off by design (landing-sky.mjs), so there is nothing to size.
  if (await page.evaluate(() => !!document.createElement('canvas').getContext('webgl'))) await page.waitForFunction(() => { const c = document.querySelector('#landSky'); return c.width === Math.round(c.clientWidth * Math.min(devicePixelRatio || 1, 2)); }, null, { timeout: 5000 })
    .catch(async () => assert.fail('original: the sky is not drawing: ' + JSON.stringify(await look(page))));
  seen = await look(page);
  assert.equal(seen.hidden, true);
  assert.equal(seen.skyHidden, false);
  assert.equal(seen.state, undefined, 'the video is not mounted in original mode');
  console.log('PASS landing v5: ' + JSON.stringify(seen));
});
