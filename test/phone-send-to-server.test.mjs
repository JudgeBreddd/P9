import test from 'node:test';
import assert from 'node:assert/strict';
import { remoteDaemon } from './helpers.mjs';
import { phone, seedChat, openChat } from './phone-c16-helpers.mjs';

// L4: Send to server is desktop-only by design (server.mjs: "the phone never sees these routes"), so the phone must not
// offer it, and must say in one line where it lives, in the chat's own menu (the model sheet under the title).
test('L4: the phone chat menu says where Send to server lives, and offers no button for it', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  seedChat(server);
  const { page } = await phone(t, server);
  await openChat(page, server);
  await page.click('#modelBtn');
  await page.waitForSelector('#sheet[open]');
  const text = await page.locator('#sheetBody').innerText();
  assert.match(text, /Send to server is in the desktop app/);
  assert.equal(await page.locator('#sheet button', { hasText: /send to server/i }).count(), 0, 'the phone must not offer a Send to server button');
  await page.screenshot({ path: (process.env.P9_SCREENSHOTS || '/tmp') + '/phone-send-to-server.png' });
  console.log('PASS L4: the chat menu says where Send to server lives; no button');
});
