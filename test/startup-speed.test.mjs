// Desktop time to first window (phase 4, window-2). Measures only; it asserts that the shell came up, never a time, so the
// same file runs unchanged before and after a change. Five launches on one profile: the first is a first run (the pet is
// copied in), the other four a normal start. Logs one line, "P9_STARTUP <json>": per launch, ms from the launch call to
// the first window (Playwright's first page), to the shell page's first contentful paint, and to the chat list on screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, root } from './helpers.mjs';

const median = (list) => { const s = [...list].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

test('Startup speed: time to the first window, its first paint and the chat list, first run and normal starts', { timeout: 300000 }, async (t) => {
  const instance = await daemon(t);
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-startup-speed-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const launches = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
    const proc = app.process();
    try {
      const page = await app.firstWindow({ timeout: 20000 });
      const window = Date.now() - t0;
      await page.waitForURL(/^p9:\/\/app\//, { timeout: 20000 });
      await page.locator('#rChat').waitFor({ timeout: 20000 });
      const shell = Date.now() - t0;
      const fcpAt = await page.evaluate(() => new Promise((resolve) => new PerformanceObserver((list, observer) => {
        const e = list.getEntriesByName('first-contentful-paint')[0]; if (e) { observer.disconnect(); resolve(performance.timeOrigin + e.startTime); }
      }).observe({ type: 'paint', buffered: true })));
      launches.push({ window, fcp: Math.round(fcpAt - t0), shell });
    } finally {
      await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill();
    }
  }
  const warm = launches.slice(1), pick = (k) => median(warm.map((l) => l[k]));
  console.log('P9_STARTUP ' + JSON.stringify({ first: launches[0], warm: { window: pick('window'), fcp: pick('fcp'), shell: pick('shell') }, launches }));
  assert.equal(launches.length, 5, 'all five launches reached the chat list');
});
