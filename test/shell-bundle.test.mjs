// The desktop shell's bundle (phase 4, window-5, list 29). Measures only; it asserts that the shell page loads JS and comes
// up, never a size, so the same file runs unchanged before and after a change. Logs "P9_BUNDLE <json>": every JS file the
// built shell page (apps/web/dist/index.html) loads, followed through its imports, with raw and gzip bytes; then one
// launch to the chat list and "P9_SHOT shell <png base64>" so the shell's look can be compared side by side.
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

test('Shell bundle: JS the desktop shell page loads, and its look', { timeout: 120000 }, async (t) => {
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

  const instance = await daemon(t);
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-shell-bundle-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  try {
    const page = await app.firstWindow({ timeout: 20000 });
    await page.waitForURL(/^p9:\/\/app\//, { timeout: 20000 });
    await page.locator('#rChat').waitFor({ timeout: 20000 });
    await page.waitForTimeout(1500);
    const png = await page.screenshot({ animations: 'disabled' });
    if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT shell ' + png.toString('base64'));
    assert.ok(await page.locator('[data-p9-island]').count() === 1, 'the shell markup is on the page once');
  } finally {
    await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill();
  }
});
