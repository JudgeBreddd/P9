import test from 'node:test';
import assert from 'node:assert/strict';
import { remoteDaemon } from './helpers.mjs';
import { phone, seedChat } from './phone-c16-helpers.mjs';

// L2: while the chat list is still loading the phone shows the moving P9 mark, never a blank screen.
test('L2: a slow first load shows the drawn black hole, bobbing in a turning ring, with no image request, until the list arrives', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  seedChat(server);
  const { page } = await phone(t, server);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route(/\/chat(\?.*)?$/, async (route) => { await held; await route.continue(); });
  // The mark is inline SVG: every image request on this load is refused and logged, and the mark still paints in full.
  const images = [];
  await page.route('**/*', (route) => { if (route.request().resourceType() !== 'image') return route.fallback(); images.push(new URL(route.request().url()).pathname); return route.abort(); });
  await page.reload();
  await page.waitForSelector('#boot svg', { state: 'visible', timeout: 10000 });
  const mark = await page.evaluate(() => { const boot = document.querySelector('#boot');
    return { linked: boot.querySelectorAll('img, image, use, [src], [href]').length, core: getComputedStyle(boot.querySelector('.core')).fill,
      blurs: boot.querySelectorAll('feGaussianBlur').length, ring: getComputedStyle(boot.querySelector('.ring')).stroke }; });
  assert.deepEqual({ ...mark, ring: mark.ring.startsWith('url(') }, { linked: 0, core: 'rgb(0, 0, 0)', blurs: mark.blurs, ring: true }, 'no linked image; a black core; a gradient ring');
  assert.ok(mark.blurs <= 1, 'glow filters stay light: ' + mark.blurs);
  assert.equal(images.filter((name) => /p9-icon/.test(name)).length, 0, 'the 512 px icon is not fetched: ' + images.join(', '));
  // It bobs (two samples of the hole differ) inside the ring, which turns (two samples differ), with the old timing.
  const pose = () => page.evaluate(() => ['.hole', '.ring'].map((part) => getComputedStyle(document.querySelector('#boot ' + part)).transform).join(' | '));
  const first = await pose();
  await page.waitForTimeout(250);
  const second = await pose();
  assert.notEqual(first.split(' | ')[0], second.split(' | ')[0], 'the hole is not bobbing: ' + first);
  assert.notEqual(first.split(' | ')[1], second.split(' | ')[1], 'the ring is not turning: ' + first);
  assert.deepEqual(await page.evaluate(() => ['.hole', '.shade', '.ring'].map((part) => getComputedStyle(document.querySelector('#boot ' + part)).animationName)), ['bob', 'shade', 'spin']);
  const box = await page.locator('#boot svg').boundingBox();
  assert.ok(Math.abs(box.x + box.width / 2 - 195) < 2 && box.width >= 80, 'the mark is not centred on a 390 px screen: ' + JSON.stringify(box));
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT phone-loading ' + (await page.screenshot({ animations: 'disabled' })).toString('base64'));
  // It never blocks the screen: a tap lands on what is under it (the + in the top bar), so a New chat can start mid-load.
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#boot')).pointerEvents), 'none');
  const under = await page.evaluate(() => { const bar = document.querySelector('[data-bar="chat"]').getBoundingClientRect(); return document.elementFromPoint(bar.left + 10, bar.top + 10)?.closest('#boot') !== null; });
  assert.equal(under, false, 'the mark covers the top bar');
  release();
  await page.waitForSelector('#boot', { state: 'detached', timeout: 10000 });
  await page.waitForSelector('#chatList .row', { timeout: 10000 });
  console.log('PASS L2: the black hole bobbed and its ring turned while the list loaded, with no image fetched (' + images.length + ' refused), and went when it arrived');
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
  assert.deepEqual(await page.evaluate(() => ['.hole', '.shade', '.ring'].map((part) => getComputedStyle(document.querySelector('#boot ' + part)).animationName)), ['none', 'none', 'none']);
  release();
  await page.waitForSelector('#boot', { state: 'detached', timeout: 10000 });
  console.log('PASS L2: with reduced motion the mark does not animate');
});
