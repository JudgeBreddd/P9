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
