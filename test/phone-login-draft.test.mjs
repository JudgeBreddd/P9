import test from 'node:test';
import assert from 'node:assert/strict';
import { remoteDaemon } from './helpers.mjs';
import { phone, CHAT, seedChat, stubPrompt, openChat } from './phone-c16-helpers.mjs';

test('L1a: a reopened app (no tab storage) still has its CSRF token, so Send does not sign out', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  seedChat(server);
  const { page, session } = await phone(t, server, { touchScreen: false });
  // The phone swiped away and reopened: the cookie lives, sessionStorage is empty; the login kept the token on the phone.
  await page.evaluate((csrf) => { sessionStorage.removeItem('p9-csrf'); localStorage.setItem('p9-csrf', JSON.stringify({ token: csrf, at: Date.now() })); }, session.csrf);
  await page.reload();
  const attempts = await stubPrompt(page, 202);
  await openChat(page, server);
  await page.fill('#prompt', 'sent after a reopen');
  await page.click('#composer button[type="submit"]');
  await page.waitForFunction(() => document.querySelector('#prompt').value === '', null, { timeout: 10000 });
  assert.equal(new URL(page.url()).pathname, '/phone/', 'the phone went to ' + page.url());
  assert.deepEqual(attempts.map((a) => [a.csrf, a.body.text]), [[session.csrf, 'sent after a reopen']]);
  console.log('PASS L1a: Send after the app was reopened carried the kept CSRF token, no sign-in');
});

test('L1b: a 401 on Send keeps the message through the sign-in and puts it back in the box, unsent', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  seedChat(server);
  const { page } = await phone(t, server, { touchScreen: false });
  const attempts = await stubPrompt(page, 401);
  await openChat(page, server);
  await page.fill('#prompt', 'my long unsent message');
  await page.click('#composer button[type="submit"]');
  await page.waitForURL(/\/login/, { timeout: 10000 });
  assert.equal(new URL(page.url()).hash, '#chat=' + CHAT, 'the sign-in forgot which chat it came from');
  // Sign in for real (the virtual passkey): the login page hands back to the same chat.
  await page.click('#login');
  await page.waitForURL(/\/phone\//, { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('#prompt')?.value === 'my long unsent message', null, { timeout: 15000 });
  // Put back, never sent twice: the one refused try is the only one the daemon was asked.
  assert.equal(attempts.length, 1);
  console.log('PASS L1b: the unsent message came back in its chat after sign-in, and was not sent again');
});
