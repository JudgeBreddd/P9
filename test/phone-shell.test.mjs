// The phone shell (v0.1.6 phone spec §1, §4, §7; plan P5): one fixed column the size of the visible viewport, a 44 px top bar on every
// tab, a tab bar that hides when the viewport shrinks (what a keyboard does), a shared bottom sheet, and a composer slot that
// stays at the bottom of the chat screen. Chromium cannot prove iPhone keyboard timing, the left-edge swipe or momentum scroll.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { remoteDaemon, passkeyDevice, enrollDevice, root } from './helpers.mjs';

// The dev space keeps no files: the picture goes out in the log as "P9_SHOT <name> <base64>" (not on GitHub).
const shot = async (page, name) => { const png = await page.screenshot(); if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png.toString('base64')); };
async function setup(paths) {
  await mkdir(path.join(paths.workspace, 'hub'), { recursive: true });
  await writeFile(path.join(paths.workspace, 'hub', 'registry.json'), JSON.stringify({ scripts: [], apps: [], pages: [] }));
  await writeFile(path.join(paths.directory, 'settings.json'), JSON.stringify({ registry: 'hub/registry.json', hub: 'hub', server_host: 'test-server' }));
  return { args: ['--settings', path.join(paths.directory, 'settings.json')] };
}
// No network in the dev space, so Chromium reports navigator.onLine false: the page is told it is online.
async function phoneOn(t, server, browser) {
  const device = await passkeyDevice(browser, server, 'phone-shell-' + Math.random().toString(36).slice(2, 7));
  const session = await enrollDevice(server, device);
  await device.context.addCookies([{ name: 'p9s', value: session.token, url: server.origin, httpOnly: true, secure: true, sameSite: 'Strict' }]);
  await device.context.addInitScript(() => { Object.defineProperty(navigator, "onLine", { get: () => !window.__off, configurable: true }); });
  return { ...device, session };
}
async function open(device, server, { fix = [], init } = {}) {
  const { page, session } = device;
  // The A/B: swap text in the served document, stylesheet and script so the old behaviour is back. The swap must hit.
  const hit = fix.map(() => false), seen = fix.map(() => '');
  await page.route('**/*', async (route) => {
    if (!fix.length || !['document', 'stylesheet', 'script'].includes(route.request().resourceType())) return route.continue();
    const response = await route.fetch({ url: route.request().url().replace('app.p9.localhost', '127.0.0.1'), headers: { ...route.request().headers(), host: server.host } });
    let body = await response.text();
    for (const [index, [from, to]] of fix.entries()) {
      if (typeof from === 'string' ? body.includes(from) : from.test(body)) { body = body.replace(from, to); hit[index] = true; }
      else if (!seen[index] && typeof from === 'string') { const at = body.indexOf(from.slice(0, 14)); if (at >= 0) seen[index] = body.slice(at, at + 160); }
    }
    await route.fulfill({ response, body });
  });
  // The phone's service worker re-fetches /_astro/ itself once it claims the page, and page.route never sees that fetch:
  // the reload would get the unpatched file whenever the worker wins the race. These pages run without it.
  await page.addInitScript(() => { if (navigator.serviceWorker) navigator.serviceWorker.register = async () => undefined; });
  if (init) await page.addInitScript(init);
  await page.goto(server.origin + '/phone/');
  await page.evaluate((csrf) => sessionStorage.setItem('p9-csrf', csrf), session.csrf);
  await page.reload();
  await page.setViewportSize({ width: 390, height: 844 });
  return { page, hits: () => hit.filter(Boolean).length, missed: () => fix.map((_, i) => hit[i] ? '' : 'patch ' + i + ' did not hit' + (seen[i] ? '; the served text reads: ' + seen[i] : '; its first 14 characters appear nowhere')).filter(Boolean).join(' | ') };
}

// A new Claude chat through the + sheet; the chat screen opens on it.
async function newChat(page) {
  await page.click('#newChat'); await page.click('#sheet [data-new="claude"]');
  await page.waitForSelector('#composer', { state: 'visible' });
}
const checks = {
  // The page itself never scrolls: the column is exactly the window; every tab has a 44 px bar with the sync dot.
  async column(page) {
    await page.waitForSelector('h1:text("Chats")');
    const f = await page.evaluate(() => {
      const root = document.scrollingElement, app = document.querySelector('#app').getBoundingClientRect();
      return { scrolls: root.scrollHeight > root.clientHeight, top: app.top, height: app.height, inner: innerHeight };
    });
    assert.equal(f.scrolls, false, 'the page does not scroll');
    assert.deepEqual([f.top, f.height], [0, f.inner], 'the column is the window');
    for (const [view, title] of [['chat', 'Chats'], ['terminal', 'Terminal'], ['mission', 'Mission'], ['usage', 'Usage'], ['files', 'Files']]) {
      await page.click(`nav [data-nav="${view}"]`);
      const bar = page.locator(`section[data-view="${view}"] > .bar`);
      assert.equal(await bar.locator('h1').innerText(), title);
      assert.equal(Math.round((await bar.boundingBox()).height), 44, view + ' bar is 44 px');
      assert.equal(await bar.locator('.sync').count(), 1, view + ' shows the sync dot');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, view + ' has no sideways scroll');
    }
    await page.click('nav [data-nav="chat"]');
    assert.equal(await page.locator('#fileState').count(), 1, 'the Files bar keeps #fileState');
    await shot(page, 'c1-shell-844');
  },
  // The tab bar is visible at full height, gone when the viewport shrinks (what a keyboard does), back when it grows;
  // the composer stays whole and on screen in the short viewport.
  async keyboard(page) {
    await page.waitForSelector('h1:text("Chats")');
    assert.equal(await page.locator('nav').isVisible(), true);
    await page.setViewportSize({ width: 390, height: 500 });
    await page.waitForFunction(() => document.body.classList.contains('kbd'));
    assert.equal(await page.locator('nav').isVisible(), false, 'the tab bar yields to a short viewport');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => !document.body.classList.contains('kbd'));
    assert.equal(await page.locator('nav').isVisible(), true, 'the tab bar comes back');
  },
  // Inside a chat the tab bar is gone (the composer owns the bottom) and the composer rides a short viewport.
  async inchat(page) {
    await page.waitForSelector('h1:text("Chats")');
    assert.equal(await page.locator('nav').isVisible(), true, 'the Chats list has the tab bar');
    await newChat(page);
    assert.equal(await page.locator('nav').isVisible(), false, 'no tab bar inside a chat');
    await page.setViewportSize({ width: 390, height: 500 });
    await page.waitForFunction(() => document.body.classList.contains('kbd'));
    const slot = await page.locator('#composerSlot').boundingBox(), field = await page.locator('#prompt').boundingBox();
    assert.ok(slot.y + slot.height <= 500.5 && field.y >= 44 && field.y + field.height <= 500, 'the composer sits inside the short viewport');
    await shot(page, 'c1-shell-500');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => !document.body.classList.contains('kbd'));
    await page.click('[data-back]'); await page.waitForSelector('h1:text("Chats")');
    assert.equal(await page.locator('nav').isVisible(), true, 'the tab bar is back on the list');
  },
  // The composer slot is marked, is a fixed row under the chat scroller, holds today's composer, and still sends.
  async slot(page) {
    await page.waitForSelector('h1:text("Chats")');
    await newChat(page);
    assert.equal(await page.locator('#composerSlot #composer #prompt').count(), 1);
    const slot = await page.locator('#composerSlot').boundingBox();
    assert.ok(slot.y > 400 && slot.y + slot.height <= 844.5, 'the slot is the bottom row of the chat screen');
    await page.fill('#prompt', 'hello from the shell');
    await page.click('#composer button[type=submit]');
    await page.waitForFunction(() => /hello from the shell/.test(document.querySelector('#events').innerText), null, { timeout: 5000 });
  },
  // The shared sheet opens with a title and body; a tap on the backdrop closes it.
  async sheet(page) {
    await page.waitForSelector('h1:text("Chats")');
    await page.evaluate(() => dispatchEvent(new CustomEvent('p9-sheet', { detail: { title: 'Pick one', html: '<button class="opt" aria-checked="true">Alpha</button>' } })));
    await page.waitForSelector('#sheet[open] .opt');
    assert.equal(await page.locator('#sheetTitle').innerText(), 'Pick one');
    await page.mouse.click(195, 20);
    await page.waitForFunction(() => !document.querySelector('#sheet').open, null, { timeout: 3000 });
  },
};
const breaks = {
  column: { fix: [[/(#app\{[^}]*?)height:\s*var\(--vvh,\s*100dvh\)/, '$1height:300px']] },
  keyboard: { fix: [['body.kbd nav{display:none}', 'body.kbd nav{}']] },
  inchat: { fix: [['body.inchat nav{display:none}', 'body.inchat nav{}']] },
  slot: { fix: [['id="composerSlot"', 'id="composerSlotGone"']] },
  sheet: { init: () => { HTMLDialogElement.prototype.close = function () {}; } },
};

test('P5 and the shell: a fixed column, a 44 px bar on every tab, the tab bar yields to a short viewport, a composer slot, a shared sheet (A/B)', { timeout: 300000 }, async (t) => {
  const server = await remoteDaemon(t, { setup, args: ['--acp-override', path.join(root, 'test/fake-acp-agent.mjs')] });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  // Every check runs, and every failure is listed at the end: a run is too slow to find them one at a time.
  const failures = [];
  for (const [name, check] of Object.entries(checks)) {
    const good = await open(await phoneOn(t, server, browser), server);
    try { await check(good.page); } catch (error) { failures.push(name + ' (good page): ' + String(error.message).split('\n')[0]); await good.page.context().close(); continue; }
    await good.page.context().close();
    const bad = await open(await phoneOn(t, server, browser), server, breaks[name]);
    if (breaks[name].fix && bad.missed()) { failures.push(name + ' (A/B): ' + bad.missed()); await bad.page.context().close(); continue; }
    let broke = true;
    try { await check(bad.page); broke = false; } catch { /* the check failed on the broken page, as it must */ }
    await bad.page.context().close();
    if (!broke) failures.push(name + ' (A/B): the check passed on the broken page');
  }
  assert.deepEqual(failures, []);
});
