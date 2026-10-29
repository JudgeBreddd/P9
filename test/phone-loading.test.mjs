import test from 'node:test';
import assert from 'node:assert/strict';
import { remoteDaemon } from './helpers.mjs';
import { phone, seedChat } from './phone-c16-helpers.mjs';

// L2: while the chat list is still loading the phone shows the moving P9 mark, never a blank screen.
test('L2: a slow first load shows the P9 logo, breathing, until the list arrives', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  seedChat(server);
  const { page } = await phone(t, server);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route(/\/chat(\?.*)?$/, async (route) => { await held; await route.continue(); });
  await page.reload();
  await page.waitForSelector('#boot', { state: 'visible', timeout: 10000 });
  // The mark is the real P9 logo (the brand PNG, not the old drawn ring that read as a D), in the screen's middle, breathing
  // (two samples differ).
  await page.locator('#boot img').evaluate((el) => el.decode());
  assert.deepEqual(await page.locator('#boot img').evaluate((el) => [new URL(el.src).pathname, el.naturalWidth]), ['/p9-icon.png', 512]);
  assert.equal(await page.locator('#boot svg').count(), 0, 'no drawn mark');
  const turn = () => page.evaluate(() => getComputedStyle(document.querySelector('#boot img')).transform);
  const first = await turn();
  await page.waitForTimeout(400);
  const second = await turn();
  assert.notEqual(first, second, 'the logo is not breathing: ' + first);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#boot img')).animationName), 'breathe');
  const box = await page.locator('#boot img').boundingBox();
  assert.ok(Math.abs(box.x + box.width / 2 - 195) < 2 && box.width >= 80, 'the mark is not centred on a 390 px screen: ' + JSON.stringify(box));
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT phone-loading ' + (await page.screenshot({ animations: 'disabled' })).toString('base64'));
  // It never blocks the screen: a tap lands on what is under it (the + in the top bar), so a New chat can start mid-load.
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#boot')).pointerEvents), 'none');
  const under = await page.evaluate(() => { const bar = document.querySelector('[data-bar="chat"]').getBoundingClientRect(); return document.elementFromPoint(bar.left + 10, bar.top + 10)?.closest('#boot') !== null; });
  assert.equal(under, false, 'the mark covers the top bar');
  release();
  await page.waitForSelector('#boot', { state: 'detached', timeout: 10000 });
  await page.waitForSelector('#chatList .row', { timeout: 10000 });
  console.log('PASS L2: the P9 logo breathed while the list loaded (' + first + ' then ' + second + ') and went when it arrived');
});

test('L2: with reduced motion the mark stays still', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  const { page } = await phone(t, server);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route(/\/chat(\?.*)?$/, async (route) => { await held; await route.continue(); });
  await page.reload();
  await page.waitForSelector('#boot', { state: 'visible', timeout: 10000 });
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#boot img')).animationName), 'none');
  release();
  await page.waitForSelector('#boot', { state: 'detached', timeout: 10000 });
  console.log('PASS L2: with reduced motion the mark does not animate');
});
