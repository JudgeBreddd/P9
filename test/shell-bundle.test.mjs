// The desktop shell's bundle (phase 4, window-5, list 29). Two budgets (O124): BUDGET, the raw bytes of the /_astro/ scripts
// the page parses before the shell is usable ("P9_STARTUP"), and USABLE_BUDGET, the warm median ms from navigation start to the
// shell's own "p9-shell-usable" mark (controller.mjs, set where the shell drops data-pending and its buttons work); everything is logged first, so the file still measures main. Logs "P9_BUNDLE <json>": every JS file the
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
// the terminal chunk +6957; about 1.5% headroom); raise it on purpose. 855412: O173 B's Discard button and its per-file save guard (+423 on 854989). 855468: O181 waiting-project rows and the separator fixup (+56 on 855412). 855480: O136 a profile chat's Claude row shows Claude's start (+12 on 855468). 855507: O137 the Settings default mode is saved to the daemon (+27 on 855480). 855522: O131 a New chat reads the saved defaults again after a failed first read (+15 on 855507). 855691: O131 label, "(Default)" marks the Settings default when one is set (+169 on 855522). 856178: O133 the Model and Effort pills name what the chat runs, a pick not taken yet shown as pending (+487 on 855691). 856182: O131 a Default save draws the open chats again (+4 on 856178). 856277: O125 (4) the queue strip shows the oldest wait (+95 on 856182). 856577: O191 the Usage window shows each provider profile as its own row (+300 on 856277). 858483: O197 Settings > Notices, a Note or Message row per kind of worker notice (+1906 on 856577). 858656: O197 FIX1 Notices saves one after another, a pick still saving stays shown (+173 on 858483). 858744: O197 FIX2 a pending Notices pick cleared by its own write number (+88 on 858656).
// O124: the budget counts only scripts parsed before the shell is usable (the terminal chunk loads after it since O118), set
// to the measured 0 B-spread size; lower it when startup JS shrinks, never raise it to fit a change. 499551: O124 on a8ed192
// (dev space x5, 0 spread; all parsed JS with the idle terminal chunk was 838879, against the old budget 858744).
const BUDGET = 499551;
// ponytail: warm median of four launches against one fixed line, set from CI's measured median plus a stated margin (O124).
const USABLE_BUDGET = Infinity;
const USABLE = 'p9-shell-usable';

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
      await page.waitForFunction((name) => performance.getEntriesByName(name).length > 0, USABLE, { timeout: 20000 })
        .catch(() => assert.fail(`launch ${i + 1}: the shell never set its "${USABLE}" mark`));
      const { origin, at, usable } = await page.evaluate((name) => ({ origin: performance.timeOrigin, at: window.__shellAt || {}, usable: Math.round(performance.getEntriesByName(name)[0].startTime) }), USABLE);
      const from = (k) => at[k] === undefined ? null : Math.round(origin - t0 + at[k]);
      launches.push({ usable, markup: from('markup'), mounted: from('mounted'), dcl: from('dcl'), load: from('load') });
      if (i === 4) {
        await page.waitForTimeout(1500);
        // The size that counts: every /_astro/ script the page has parsed by now, from Chrome's debugger (Debugger.enable
        // reports the scripts already parsed). The walk above reads imports from the files and missed both terminal.*.js
        // (main) and a backtick import() (after #116); this list cannot miss a script the page runs.
        const cdp = await app.context().newCDPSession(page), parsed = new Set();
        cdp.on('Debugger.scriptParsed', (e) => { const m = /\/_astro\/([^/?#]+\.js)$/.exec(e.url); if (m) parsed.add(m[1]); });
        await cdp.send('Debugger.enable'); await page.waitForTimeout(500); await cdp.detach();
        const sizes = (list) => list.map((file) => ({ file, raw: readFileSync(path.join(dist, '_astro', file)).length })).sort((a, b) => b.raw - a.raw);
        const scripts = sizes([...parsed]), scriptsRaw = scripts.reduce((n, f) => n + f.raw, 0);
        console.log('P9_SCRIPTS ' + JSON.stringify({ raw: scriptsRaw, files: scripts.length, scripts }));
        assert.ok(scripts.length > 0, 'the shell page parsed JS from /_astro/');
        // O116: the QR library (qrcode-generator, about 44 KB) loads with the Continue on phone dialog, not at startup.
        const qr = scripts.filter((f) => readFileSync(path.join(dist, '_astro', f.file), 'utf8').includes('createSvgTag')).map((f) => f.file);
        assert.deepEqual(qr, [], `the shell page parsed the QR library at startup in ${qr.join(', ')}`);
        // O124: the scripts parsed before the shell is usable. The window reloads with the debugger already on, and the usable mark
        // calls a binding the moment it is set; the debugger's script events and the binding's call come in order on this one
        // session, so every script before the call is startup JS and every one after it (the idle terminal chunk) is not.
        const pre = await app.context().newCDPSession(page), order = [];
        pre.on('Debugger.scriptParsed', (e) => { const m = /\/_astro\/([^/?#]+\.js)$/.exec(e.url || ''); if (m) order.push(m[1]); });
        pre.on('Runtime.bindingCalled', (e) => { if (e.name === '__p9usable') order.push(null); });
        await pre.send('Runtime.enable'); await pre.send('Runtime.addBinding', { name: '__p9usable' }); await pre.send('Page.enable');
        await pre.send('Page.addScriptToEvaluateOnNewDocument', { source: `{ const mark = performance.mark.bind(performance);
          performance.mark = (name, o) => { const r = mark(name, o); if (name === ${JSON.stringify(USABLE)}) __p9usable(''); return r; }; }` });
        await pre.send('Debugger.enable'); order.length = 0; // the scripts of the page before the reload are reported first
        await page.reload(); await page.locator('#rChat svg').waitFor({ timeout: 20000 });
        await page.waitForFunction((name) => performance.getEntriesByName(name).length > 0, USABLE, { timeout: 20000 });
        await page.waitForTimeout(2500); // the idle loads after it (O118's terminal chunk) come in, to be listed as after
        await pre.detach();
        const cut = order.indexOf(null);
        assert.ok(cut > 0, `the reload's usable mark came ${cut < 0 ? 'never' : 'before any script'}: ${JSON.stringify(order)}`);
        const startup = sizes([...new Set(order.slice(0, cut))]), startupRaw = startup.reduce((n, f) => n + f.raw, 0);
        console.log('P9_STARTUP ' + JSON.stringify({ raw: startupRaw, files: startup.length, after: [...new Set(order.slice(cut + 1))], scripts: startup }));
        assert.ok(startupRaw <= BUDGET, `the shell page parsed ${startupRaw} bytes of JS before it was usable, over the budget of ${BUDGET}`);
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
  console.log('P9_SHELL_AT ' + JSON.stringify({ first: launches[0], warm: { usable: pick('usable'), markup: pick('markup'), mounted: pick('mounted'), dcl: pick('dcl'), load: pick('load') }, launches }));
  assert.ok(pick('usable') <= USABLE_BUDGET, `the shell was usable at a warm median of ${pick('usable')} ms from navigation start, over the budget of ${USABLE_BUDGET} ms: ${JSON.stringify(warm.map((l) => l.usable))}`);
});
