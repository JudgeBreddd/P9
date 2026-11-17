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
      // O76: read on the page's own clock. The test tool's first lookup in a page takes 0.55 to 0.9 s since the shell lost
      // React (#116), while the page shows the chat button about 100 ms after it loads (8 launches, 2026-11-15), so a
      // tool-side wait timed the tool. Why the lookup is slow (probes, 2026-11-17, n=3 launches; hypothesis, not
      // proven): module-graph contention — the shell's JS is one dynamically imported module graph (~1.1 MB:
      // shell-start.js, terminal.js and imports), and its parse and evaluation probably keep the renderer's main
      // thread busy for roughly the first half-second after load, so the tool's first lookup, which injects its own
      // script on that same thread, queues behind the module work. Measured facts: the first lookup takes 0.55 to
      // 0.9 s; every later lookup is milliseconds; a parallel CDP ping stalls 463 ms mid-wait; terminal.js
      // (339 KB) has its parse notification arrive when the wait ends (notification arrival, not
      // a timing of its evaluation). What is not measured: the breakdown inside the graph; evaluation duration and task breakdown were not measured.
      // Shown = both sides of its box above zero and visible; gives up after 20 s, as the tool-side wait did.
      const shell = Math.round(await page.evaluate(() => new Promise((resolve, reject) => { const end = performance.now() + 20000; const look = () => {
        const e = document.querySelector('#rChat'), box = e?.getBoundingClientRect();
        if (box && box.width > 0 && box.height > 0 && getComputedStyle(e).visibility === 'visible') resolve(performance.timeOrigin + performance.now());
        else if (performance.now() > end) reject(new Error('the chat button was not shown within 20 s: ' + (e ? box.width + ' x ' + box.height + ', ' + getComputedStyle(e).visibility : 'not in the page')));
        else setTimeout(look, 5);
      }; look(); })) - t0);
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
