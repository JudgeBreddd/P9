// O118: the terminal chunk (xterm, about a third of the shell's JS) loads after the shell is drawn, not while it starts, and is
// there by the time the terminal is opened. One profile, launches until five of each kind are measured, each logged as
// "P9_O118 <json>" (ms on the page's clock from its navigation start) so the same file measures main and a branch:
// - waited: the shell is drawn, then the test waits for the terminal chunk to load without a press, and opens the terminal;
// - early: the terminal button is pressed the moment the shell is drawn (the worst open: the chunk may not be in yet).
// Each launch measures a reload of its fresh window, instrumented through the page's own debugger session (Playwright's init
// script, added after the launch, missed most loads); a reload is the same on both sides. Resource timing does not list p9:// files, so the load start is when Vite's preload helper puts the chunk's <link> tags into
// <head> (it does that for every dynamic import with deps, on main and on the branch alike).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { _electron } from '@playwright/test';
import { daemon, root, versionSeen } from './helpers.mjs';

const astro = path.join(root, 'apps/web/dist/_astro');
const raw = (file) => readFileSync(path.join(astro, file)).length;
// The terminal chunk: the built file holding xterm's own helper textarea class.
const termFiles = readdirSync(astro).filter((file) => file.endsWith('.js') && readFileSync(path.join(astro, file), 'utf8').includes('xterm-helper-textarea'));

test('O118: the terminal chunk loads after the shell is drawn, and the terminal opens on a press', { skip: process.platform === 'win32' ? 'tmux' : false, timeout: 480000 }, async (t) => {
  assert.equal(termFiles.length, 1, 'one built terminal chunk: ' + termFiles.join(', '));
  const term = termFiles[0];
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--tmux-socket', 'p9t-' + randomUUID().slice(0, 8)] }));
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-o118-')), 'profile');
  await mkdir(profile); await versionSeen(profile);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const init = () => {
    const at = window.__o118 = { links: {}, long: [] }; const now = () => Math.round(performance.now());
    const tick = () => { if (document.querySelector('#rChat svg')) at.mounted = now(); else setTimeout(tick, 2); };
    tick();
    new MutationObserver((list) => { for (const m of list) for (const n of m.addedNodes) {
      const file = n.tagName === 'LINK' && /\/_astro\/([^/?#]+)$/.exec(n.href || '')?.[1]; if (file && !(file in at.links)) at.links[file] = now();
    } }).observe(document, { childList: true, subtree: true });
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) at.long.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: 'longtask', buffered: true }); } catch {}
  };
  const runs = [];
  for (let i = 0; i < 20 && runs.filter((r) => r.early).length < 5; i++) {
    const early = runs.filter((r) => !r.early).length >= 5;
    const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
    const proc = app.process();
    try {
      const page = await app.firstWindow({ timeout: 20000 });
      await page.waitForURL(/^p9:\/\/app\//, { timeout: 20000 });
      await page.locator('#rChat svg').waitFor({ timeout: 20000 });
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Page.enable'); await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: '(' + init + ')()' });
      await page.reload(); await page.locator('#rChat svg').waitFor({ timeout: 20000 });
      const termLinked = () => page.evaluate((file) => !!window.__o118?.links[file], term);
      let pressed;
      if (early) { pressed = Date.now(); await page.click('#rTerm'); }
      else {
        for (let k = 0; k < 80 && !(await termLinked()); k++) await page.waitForTimeout(100);
        await page.waitForTimeout(500); pressed = Date.now(); await page.click('#rTerm');
      }
      await page.locator('#dState', { hasText: /^Connected$/ }).waitFor({ timeout: 20000 });
      await page.locator('#termView .xterm').waitFor({ timeout: 5000 });
      const open = Date.now() - pressed;
      const at = await page.evaluate(() => ({ ...window.__o118, load: Math.round(performance.getEntriesByType('navigation')[0]?.loadEventStart ?? -1) }));
      if (!at.links) { console.log('P9_O118_SKIP the init script did not run on this launch'); continue; }
      // Startup JS: every /_astro/ script the page has parsed (Chrome's debugger, as shell-bundle counts it) less the chunks
      // whose preload links went in after the shell was drawn (the load event is no boundary: the shell's own chunk is a
      // dynamic import that starts after it).
      const parsed = new Set();
      cdp.on('Debugger.scriptParsed', (e) => { const m = /\/_astro\/([^/?#]+\.js)$/.exec(e.url || ''); if (m) parsed.add(m[1]); });
      await cdp.send('Debugger.enable'); await page.waitForTimeout(300); await cdp.detach();
      const after = (file) => at.links[file] !== undefined && at.links[file] >= at.mounted;
      const all = [...parsed].reduce((n, f) => n + raw(f), 0), startup = [...parsed].filter((f) => !after(f)).reduce((n, f) => n + raw(f), 0);
      const longBeforeMount = at.long.filter(([s]) => s < at.mounted).reduce((n, [, d]) => n + d, 0);
      const longFirstSecond = at.long.filter(([s]) => s >= at.mounted && s < at.mounted + 1000).reduce((n, [, d]) => n + d, 0);
      const run = { early, load: at.load, mounted: at.mounted, termLink: at.links[term] ?? null, open, all, startup, longBeforeMount, longFirstSecond };
      runs.push(run);
      console.log('P9_O118 ' + JSON.stringify(run));
    } finally {
      await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill();
    }
  }
  const waited = runs.filter((r) => !r.early), early = runs.filter((r) => r.early);
  assert.equal(waited.length, 5, 'five waited launches measured'); assert.equal(early.length, 5, 'five early launches measured');
  const median = (list) => { const s = [...list].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const sum = (rows, k) => ({ median: median(rows.map((r) => r[k])), min: Math.min(...rows.map((r) => r[k])), max: Math.max(...rows.map((r) => r[k])) });
  console.log('P9_O118_SUM ' + JSON.stringify({ load: sum(runs, 'load'), mounted: sum(runs, 'mounted'), termLink: sum(waited, 'termLink'), startup: sum(waited, 'startup'), all: sum(waited, 'all'),
    longBeforeMount: sum(runs, 'longBeforeMount'), longFirstSecond: sum(waited, 'longFirstSecond'), openAfterIdle: sum(waited, 'open'), openEarly: sum(early, 'open'), terminal: term, terminalRaw: raw(term) }));
  // Every waited launch: the terminal chunk loaded without a press, and only once the shell was drawn.
  for (const run of waited) {
    assert.ok(run.termLink !== null, 'the terminal chunk loaded without a press: ' + JSON.stringify(run));
    assert.ok(run.termLink >= run.mounted, 'the terminal chunk started loading before the shell was drawn: ' + JSON.stringify(run));
  }
});

// O118: a terminal chunk that fails to load (the idle load or a press) is tried again on the next open, not kept failed for the
// window's life. The chunk's request fails once through the page's debugger (the desktop serves the build from memory).
test('O118: a terminal chunk that failed to load loads on the next open', { skip: process.platform === 'win32' ? 'tmux' : false, timeout: 120000 }, async (t) => {
  const term = termFiles[0];
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--tmux-socket', 'p9t-' + randomUUID().slice(0, 8)] }));
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-o118f-')), 'profile');
  await mkdir(profile); await versionSeen(profile);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  try {
    const page = await app.firstWindow({ timeout: 20000 });
    await page.waitForURL(/^p9:\/\/app\//, { timeout: 20000 });
    await page.locator('#rChat svg').waitFor({ timeout: 20000 });
    // CDP Fetch never sees the desktop's own scheme (p9://), so the window's session cancels the chunk's request instead. This
    // replaces main.mjs's subframe guard for this window only; the test loads no frame.
    const block = (on) => app.evaluate(({ BrowserWindow }, { on, term }) => {
      const web = BrowserWindow.getAllWindows()[0].webContents.session.webRequest;
      globalThis.o118Seen ??= []; globalThis.o118Failed ??= 0;
      web.onBeforeRequest(on ? (details, done) => {
        globalThis.o118Seen.push(details.url);
        const hit = details.url.endsWith('/_astro/' + term); if (hit) globalThis.o118Failed++;
        done({ cancel: hit });
      } : null);
    }, { on, term });
    const counts = () => app.evaluate(() => ({ failed: globalThis.o118Failed, seen: (globalThis.o118Seen ?? []).slice(0, 40) }));
    // The reload would take the chunk from the cache, which no request filter sees.
    const cdp = await page.context().newCDPSession(page); await cdp.send('Network.enable'); await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await block(true);
    await page.reload(); await page.locator('#rChat svg').waitFor({ timeout: 20000 });
    await page.click('#rTerm');
    await page.locator('#dState', { hasText: 'Terminal did not load' }).waitFor({ timeout: 10000 }).catch(async (error) => {
      const at = await page.evaluate(() => ({ state: document.querySelector('#dState')?.textContent, dock: document.querySelector('#dock')?.hidden, xterm: !!document.querySelector('#termView .xterm') }));
      throw new Error('O118 retry: ' + JSON.stringify({ ...await counts(), at }), { cause: error });
    });
    assert.ok((await counts()).failed >= 1, 'the chunk request was failed');
    await block(false);
    await page.click('#dHide');
    // The open starts the retry at once, and the dock stops saying the last try failed.
    assert.equal(await page.evaluate(() => { document.querySelector('#rTerm').click(); return document.querySelector('#dState').textContent; }), '', 'the retry clears the failure note');
    await page.locator('#dState', { hasText: /^Connected$/ }).waitFor({ timeout: 20000 });
    await page.locator('#termView .xterm').waitFor({ timeout: 5000 });
  } finally {
    await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill();
  }
});
