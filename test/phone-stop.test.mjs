import test from 'node:test';
import assert from 'node:assert/strict';
import { remoteDaemon } from './helpers.mjs';
import { phone, CHAT, seedChat, openChat } from './phone-c16-helpers.mjs';

// L3: the cancel route is answered here (the daemon never ran this chat), and every call is kept.
async function stubCancel(page) {
  const calls = [];
  await page.route('**/chat/*/cancel', (route) => {
    calls.push({ url: new URL(route.request().url()).pathname, csrf: route.request().headers()['x-p9-csrf'] });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ cancelled: true }) });
  });
  return calls;
}

test('L3: a running chat has a Stop in the top bar even with text in the box; an idle chat has none', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  seedChat(server, { running: true });
  const { page, session } = await phone(t, server);
  const calls = await stubCancel(page);
  await openChat(page, server);
  // Text in the box makes the composer's button Steer, which is where the desktop's Stop used to be hidden from the phone.
  await page.fill('#prompt', 'a half-typed follow-up');
  assert.equal(await page.locator('#send').getAttribute('data-stop'), 'false', 'the composer button should be Steer with text in the box');
  await page.waitForSelector('[data-bar="chat"] #stopTurn', { timeout: 10000 });
  const box = await page.locator('#stopTurn').boundingBox();
  assert.ok(box.width + 28 >= 44 && box.height + 28 >= 44, 'the Stop tap target is under 44 px: ' + JSON.stringify(box));
  await page.screenshot({ path: (process.env.P9_SCREENSHOTS || '/tmp') + '/phone-stop.png' });
  await page.click('#stopTurn', { force: true }); // P3: Stop is a plain labelled button beside the spinner
  await page.waitForTimeout(500);
  assert.deepEqual(calls, [{ url: '/chat/' + CHAT + '/cancel', csrf: session.csrf }]);
  assert.equal(await page.inputValue('#prompt'), 'a half-typed follow-up', 'Stop took the typed text');
  console.log('PASS L3: Stop in the top bar posted /chat/:id/cancel once; the typed text stayed');
});

test('L3: a chat with no running turn shows no Stop', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  seedChat(server);
  const { page } = await phone(t, server);
  await openChat(page, server);
  await page.waitForSelector('[data-bar="chat"] h1', { timeout: 10000 });
  assert.equal(await page.locator('#stopTurn').count(), 0);
  console.log('PASS L3: an idle chat has no Stop');
});
