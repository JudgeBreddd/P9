// O152: setHTML (apps/web/src/controller.mjs) patches a changed string in place instead of rebuilding the element. Mission's
// tiles, windows and top row go through it every poll (20-30 s); a rebuild replaced the node under the pointer, so a click that
// spanned a poll landed on the parent, and scroll and focus inside the patched element reset. The functions are read from the
// shipped source and run in a plain page, so this checks the code that ships, not a copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { root } from './helpers.mjs';

const source = await readFile(path.join(root, 'apps/web/src/controller.mjs'), 'utf8');
const from = source.indexOf('const written = new WeakMap();'), to = source.indexOf('\n', source.indexOf('const setHTML = '));
assert.ok(from > 0 && to > from, 'controller.mjs still has written ... setHTML in one run');
const code = source.slice(from, to) + '\nwindow.setHTML = setHTML;';

const tile = (count, label = 'Open') => `<p class="count">${count}</p><button id="b" style="width:120px;height:40px">${label}</button>`
  + `<div id="s" style="height:60px;overflow:auto"><div style="height:600px">rows</div></div><input id="i" value="">`;

// One page per test, so each of (a), (b), (c) passes or fails on its own.
async function open(t) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<div id="box"></div>');
  await page.addScriptTag({ content: code });
  await page.evaluate((html) => {
    window.setHTML(document.getElementById('box'), html);
    window.hits = [];
    document.addEventListener('click', (e) => window.hits.push(e.target.closest('button')?.id ?? e.target.id));
  }, tile(1));
  page.patch = (html) => page.evaluate((h) => window.setHTML(document.getElementById('box'), h), html);
  return page;
}

test('O152 (a) a redraw between press and release keeps the click on the button', { timeout: 30000 }, async (t) => {
  const page = await open(t);
  const b = await page.locator('#b').boundingBox();
  await page.mouse.move(b.x + 10, b.y + 10);
  await page.mouse.down();
  await page.patch(tile(2));
  await page.mouse.up();
  assert.deepEqual(await page.evaluate(() => window.hits), ['b'], 'the click lands on the button');
});

test('O152 (b) scroll and focus inside the patched element survive a changed answer', { timeout: 30000 }, async (t) => {
  const page = await open(t);
  await page.evaluate(() => { document.getElementById('s').scrollTop = 200; document.getElementById('i').focus(); window.keep = document.getElementById('s'); });
  await page.patch(tile(3));
  assert.deepEqual(await page.evaluate(() => [document.getElementById('s').scrollTop, document.activeElement?.id, window.keep === document.getElementById('s')]), [200, 'i', true]);
});

test('O152 (c) the hovered button is patched in place; ordinary patches land; an unchanged string is skipped', { timeout: 30000 }, async (t) => {
  const page = await open(t);
  const b = await page.locator('#b').boundingBox();
  await page.mouse.move(b.x + 10, b.y + 10);
  await page.evaluate(() => { window.hovered = document.querySelector('#b:hover'); });
  await page.patch(tile(4, 'Opened'));
  assert.deepEqual(await page.evaluate(() => [!!window.hovered, window.hovered === document.getElementById('b'), document.getElementById('b').textContent]), [true, true, 'Opened']);
  for (let n = 5; n < 10; n += 1) {
    await page.patch(tile(n));
    assert.equal(await page.locator('.count').textContent(), String(n));
  }
  const same = await page.evaluate((html) => { const box = document.getElementById('box'); const before = box.firstChild; box.firstChild.textContent = 'x'; window.setHTML(box, html); return [box.firstChild === before, box.firstChild.textContent]; }, tile(9));
  assert.deepEqual(same, [true, 'x'], 'an unchanged string is skipped (written)');
});
