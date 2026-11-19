// The desktop shell's bundle (phase 4, window-5, list 29). Its one size assert is "P9_SCRIPTS" (the JS the page parses at
// startup) against BUDGET; everything is logged first, so the file still measures main. Logs "P9_BUNDLE <json>": every JS file the
// built shell page (apps/web/dist/index.html) loads, followed through its imports, with raw and gzip bytes; then one
// launch per run x5 with "P9_SHELL_AT <json>" (below) and, on the last, "P9_SHOT shell <png base64>" so the shell's look can be compared side by side,
// and "P9_SCRIPTS <json>": the /_astro/ scripts the page has parsed, from Chrome's debugger, with raw bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, root } from './helpers.mjs';

const dist = path.join(root, 'apps/web/dist');
// ponytail: one fixed budget, raw bytes of JS parsed at startup (827844 after window-5; 841636 with @xterm/xterm 6.1.0-beta.337,
// the terminal chunk +6957; about 1.5% headroom); raise it on purpose. 855412: O173 B's Discard button and its per-file save guard (+423 on 854989). 855468: O181 waiting-project rows and the separator fixup (+56 on 855412). 855480: O136 a profile chat's Claude row shows Claude's start (+12 on 855468). 855507: O137 the Settings default mode is saved to the daemon (+27 on 855480). 855522: O131 a New chat reads the saved defaults again after a failed first read (+15 on 855507). 855691: O131 label, "(Default)" marks the Settings default when one is set (+169 on 855522).
const BUDGET = 855691;

test('Shell bundle: JS the desktop shell page loads, and its look', { timeout: 300000 }, async (t) => {
  const html = readFileSync(path.join(dist, 'index.html'), 'utf8');
  const seen = new Map(), todo = [...html.matchAll(/["'(](\/_astro\/[^"'()\s]+\.js)/g)].map((m) => m[1]);
  while (todo.length) {
    const url = todo.pop(); if (seen.has(url)) continue;
    const file = path.join(dist, url); if (!existsSync(file)) continue;
    const src = readFileSync(file);
    seen.set(url, { raw: src.length, gzip: gzipSync(src).length });
    const dir = path.posix.dirname(url);
    for (const m of src.toString().matchAll(/(?:from|import)\s*\(?\s*["'](\.\.?\/[^"']+\.js)["']/g)) todo.push(path.posix.join(dir, m[1]));
  }
  const files = [...seen].map(([url, s]) => ({ file: path.posix.basename(url), ...s })).sort((a, b) => b.raw - a.raw);
  const sum = (k) => files.reduce((n, f) => n + f[k], 0);
  const inlineScripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].reduce((n, m) => n + m[1].length, 0);
  console.log('P9_BUNDLE ' + JSON.stringify({ jsRaw: sum('raw'), jsGzip: sum('gzip'), files: files.length, htmlBytes: html.length, inlineScripts, island: html.includes('<astro-island'), top: files.slice(0, 6) }));
  assert.ok(files.length > 0, 'the shell page loads JS');

  // Five launches on one profile (the first is a first run). Per launch, ms from the launch call: the shell's markup on the
  // page (#rChat has a size), the shell's code run (mountShell has put its icon in #rChat), DOMContentLoaded and load.
  const instance = await daemon(t);
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-shell-bundle-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const init = () => {
    const at = window.__shellAt = {}; const now = () => Math.round(performance.now());
    document.addEventListener('DOMContentLoaded', () => { at.dcl = now(); });
    addEventListener('load', () => { at.load = now(); });
    const tick = () => {
      const el = document.getElementById('rChat');
      if (el && at.markup === undefined && el.getBoundingClientRect().width) at.markup = now();
      if (el && at.mounted === undefined && el.querySelector('svg')) at.mounted = now();
      if (at.mounted === undefined || at.markup === undefined) setTimeout(tick, 2);
    };
    tick();
  };
  const launches = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
    await app.context().addInitScript(init);
    const proc = app.process();
    try {
      const page = await app.firstWindow({ timeout: 20000 });
      await page.waitForURL(/^p9:\/\/app\//, { timeout: 20000 });
      await page.locator('#rChat svg').waitFor({ timeout: 20000 });
      const { origin, at } = await page.evaluate(() => ({ origin: performance.timeOrigin, at: window.__shellAt || {} }));
      const from = (k) => at[k] === undefined ? null : Math.round(origin - t0 + at[k]);
      launches.push({ markup: from('markup'), mounted: from('mounted'), dcl: from('dcl'), load: from('load') });
      if (i === 4) {
        await page.waitForTimeout(1500);
        // The size that counts: every /_astro/ script the page has parsed by now, from Chrome's debugger (Debugger.enable
        // reports the scripts already parsed). The walk above reads imports from the files and missed both terminal.*.js
        // (main) and a backtick import() (after #116); this list cannot miss a script the page runs.
        const cdp = await app.context().newCDPSession(page), parsed = new Set();
        cdp.on('Debugger.scriptParsed', (e) => { const m = /\/_astro\/([^/?#]+\.js)$/.exec(e.url); if (m) parsed.add(m[1]); });
        await cdp.send('Debugger.enable'); await page.waitForTimeout(500); await cdp.detach();
        const scripts = [...parsed].map((file) => ({ file, raw: readFileSync(path.join(dist, '_astro', file)).length })).sort((a, b) => b.raw - a.raw);
        const scriptsRaw = scripts.reduce((n, f) => n + f.raw, 0);
        console.log('P9_SCRIPTS ' + JSON.stringify({ raw: scriptsRaw, files: scripts.length, scripts }));
        assert.ok(scripts.length > 0, 'the shell page parsed JS from /_astro/');
        assert.ok(scriptsRaw <= BUDGET, `the shell page parsed ${scriptsRaw} bytes of JS at startup, over the budget of ${BUDGET}`);
        const png = await page.screenshot({ animations: 'disabled' });
        if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT shell ' + png.toString('base64'));
        assert.ok(await page.locator('[data-p9-island]').count() === 1, 'the shell markup is on the page once');
      }
    } finally {
      await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill();
    }
  }
  const median = (list) => { const s = [...list].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const warm = launches.slice(1), pick = (k) => median(warm.map((l) => l[k]));
  console.log('P9_SHELL_AT ' + JSON.stringify({ first: launches[0], warm: { markup: pick('markup'), mounted: pick('mounted'), dcl: pick('dcl'), load: pick('load') }, launches }));
});
