// Phone Files pane images (threat model rows 23/26/27 adds; the owner, 2026-10-29: build it in v0.1.6): the phone's file view
// shows a workspace image read-only, through GET /files/image under the phone's own root, with the desktop's checks and words.
// The dev space keeps no files: pictures go out in the log as "P9_SHOT <name> <base64>" (not on GitHub).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { crc32, deflateSync } from 'node:zlib';
import { chromium } from '@playwright/test';
import { remoteDaemon, passkeyDevice, enrollDevice } from './helpers.mjs';
import { fileImageError } from '../apps/web/src/helpers.mjs';

// A real 64x48 PNG (a diagonal gradient), so the picture shows the image itself.
const png = (() => {
  const chunk = (type, data) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8);
    out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 8 + data.length); return out; };
  const [w, h] = [64, 48], rows = [];
  for (let y = 0; y < h; y++) { rows.push(0); for (let x = 0; x < w; x++) { const t = (x + y) / (w + h); rows.push(Math.round(40 + 200 * t), Math.round(120 - 60 * t), Math.round(220 - 160 * t)); } }
  const head = Buffer.alloc(13); head.writeUInt32BE(w, 0); head.writeUInt32BE(h, 4); head[8] = 8; head[9] = 2;
  return Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), chunk('IHDR', head), chunk('IDAT', deflateSync(Buffer.from(rows))), chunk('IEND', Buffer.alloc(0))]);
})();
const shot = async (page, name) => { const out = await page.screenshot(); if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + out.toString('base64')); };

test('Phone Files pane: a workspace image shows read-only through GET /files/image, under the phone\'s root, with the desktop\'s words (A/B)', { timeout: 120000, skip: process.platform === 'win32' && 'Windows CI has no Playwright Chromium' }, async (t) => {
  const server = await remoteDaemon(t, { setup: async (paths) => {
    await mkdir(path.join(paths.workspace, 'pics'), { recursive: true });
    await writeFile(path.join(paths.workspace, 'pics', 'dot.png'), png);
    await writeFile(path.join(paths.workspace, 'pics', 'notes.png'), 'secret text named like an image\n');
    return {};
  } });
  const outside = path.join(server.directory, 'outside');
  await mkdir(outside); await writeFile(path.join(outside, 'away.png'), png);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const device = await passkeyDevice(browser, server, 'phone-image'), session = await enrollDevice(server, device), page = device.page;
  await device.context.addInitScript(() => Object.defineProperty(navigator, 'onLine', { get: () => true }));
  await device.context.addCookies([{ name: 'p9s', value: session.token, url: server.origin, httpOnly: true, secure: true, sameSite: 'Strict' }]);
  await page.goto(server.origin + '/phone/');
  await page.evaluate((csrf) => sessionStorage.setItem('p9-csrf', csrf), session.csrf);
  await page.reload();
  await page.setViewportSize({ width: 390, height: 844 });

  // The image, whole, read-only: no editor, no Save, no file menu.
  await page.click('[data-nav="files"]');
  await page.click('#fileList button[data-name="pics"]');
  await page.click('#fileList button[data-name="dot.png"]');
  await page.waitForFunction(() => document.querySelector('#imageView img')?.naturalWidth === 64, null, { timeout: 10000 });
  assert.equal(await page.locator('#openPath').innerText(), 'dot.png');
  assert.equal(await page.locator('#fileState').innerText(), 'Read-only');
  assert.deepEqual([await page.locator('#editor').isVisible(), await page.locator('#save').isVisible(), await page.locator('#moreFile').isVisible()], [false, false, false]);
  await shot(page, 'phone-files-image');
  // A file named like an image that is not one: the desktop's words, and no img.
  await page.click('#closeFile');
  await page.click('#fileList button[data-name="notes.png"]');
  await page.locator('#imageView .note', { hasText: fileImageError['not-an-image'] }).waitFor({ timeout: 10000 });
  assert.equal(await page.locator('#imageView img').count(), 0);
  await shot(page, 'phone-files-image-refused');
  // Closed: the image view is emptied and hidden, so the next text file gets the editor back.
  await page.click('#closeFile');
  assert.equal(await page.locator('#imageView').isVisible(), false);
  assert.equal(await page.locator('#imageView *').count(), 0);

  // Under the phone's own root (row 41): the route reads there only by the root the daemon returned, as GET /files does.
  const op = () => ({ 'x-p9-op': crypto.randomUUID() });
  const root = (await server.remote('/files/root', { method: 'POST', session, body: { path: outside }, headers: op() })).body.root;
  assert.equal(root, await realpath(outside));
  const image = (file, at) => server.remote('/files/image?' + new URLSearchParams({ path: file, ...(at === undefined ? {} : { root: at }) }), { session });
  const away = await image('away.png', root);
  assert.deepEqual([away.status, away.body.mimeType, away.body.data], [200, 'image/png', png.toString('base64')]);
  assert.deepEqual((await image('away.png', outside + '/')).body, { error: 'dev-root-changed' }, 'another spelling of the root is refused');
  assert.equal((await image('away.png')).status, 404, 'without the root it is the workspace');
});
