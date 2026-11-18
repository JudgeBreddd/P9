// S1: the login page's Enroll button waits for its request. Two quick taps asked the desktop for two approvals; a refusal must leave it usable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { remoteDaemon as start, passkeyDevice as device } from './helpers.mjs';

test('S1: the Enroll button is off while its request waits and back on after a refusal', { timeout: 60000 }, async (t) => {
  const server = await start(t);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const { page } = await device(browser, server, 'phone-s1');
  let hits = 0, release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route('**/auth/enroll', async (route) => { hits++; await gate; await route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"refused"}' }); });
  await page.goto(server.origin + '/login');
  await page.fill('#name', 'phone-s1');
  await page.evaluate(() => { const button = document.getElementById('enroll'); button.click(); button.click(); });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(hits, 1, 'two taps sent one request');
  assert.equal(await page.locator('#enroll').isDisabled(), true, 'disabled while the request waits');
  release();
  await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Refused'), null, { timeout: 10000 });
  assert.equal(await page.locator('#enroll').isDisabled(), false, 'usable again after the refusal');
});

// O149: at 390 px wide the Device name box ran past the right edge (an input's width counts only its content, a button's counts
// its padding and border too). Every field and button on the login page stays inside the screen.
test('O149: the login page fields and buttons fit a 390 px wide phone screen', { timeout: 60000 }, async (t) => {
  const server = await start(t);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await page.goto(server.origin + '/login');
  const edges = await page.evaluate(() => ({ width: document.documentElement.clientWidth,
    right: Object.fromEntries(['login', 'name', 'enroll'].map((id) => [id, document.getElementById(id).getBoundingClientRect().right])) }));
  const png = await page.screenshot({ type: 'png' });
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT o149-login-390 ' + png.toString('base64'));
  for (const [id, right] of Object.entries(edges.right)) assert.ok(right <= edges.width, `#${id} ends at ${right} px, past the ${edges.width} px screen`);
  assert.equal(edges.right.name, edges.right.enroll, 'the Device name box ends where the button under it ends');
});
