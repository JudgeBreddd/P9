import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from '@playwright/test';
import { remoteDaemon, enrollDevice, passkeyDevice } from './helpers.mjs';

// A phone-sized browser on the phone page, signed in.
async function phone(t, server, { touchScreen = false } = {}) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ hasTouch: touchScreen, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal',
    hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await page.goto(server.origin + '/login');
  const session = await enrollDevice(server, { name: 'phone-terminal-touch', page, context });
  await context.addCookies([{ name: 'p9s', value: session.token, url: server.origin, httpOnly: true, secure: true, sameSite: 'Strict' }]);
  await page.goto(server.origin + '/phone/');
  await page.evaluate((csrf) => sessionStorage.setItem('p9-csrf', csrf), session.csrf);
  await page.reload();
  // ponytail: the dev space runs tests with no network, so Chromium says navigator.onLine is false and the phone keeps
  // New terminal disabled; say online here rather than change the sandbox (same as the other phone terminal tests).
  await context.addInitScript(() => { Object.defineProperty(navigator, 'onLine', { get: () => true, configurable: true }); });
  await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { get: () => true, configurable: true }); dispatchEvent(new Event('online')); });
  return { page, session };
}

// L1: sign-in must not eat the message. A chat the daemon never ran, with a finished turn, so Send goes straight out.
const CHAT = '00000000-0000-4000-8000-0000000000c1';
function seedChat(server) {
  const db = new DatabaseSync(path.join(server.directory, '.local', 'state', 'p9-foundation', 'p9.db'));
  db.prepare('INSERT INTO conversations (id, provider, title, state, created) VALUES (?, ?, ?, ?, ?)').run(CHAT, 'claude', 'Draft chat', 'idle', Date.now());
  const event = db.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)');
  event.run(CHAT, 'user', JSON.stringify({ text: 'hello' }), Date.now());
  event.run(CHAT, 'turn-end', JSON.stringify({ stopReason: 'end_turn' }), Date.now());
  db.close();
}
// The prompt route is answered here (status, or 202), and every attempt is kept: the daemon never sees the message.
async function stubPrompt(page, status) {
  const attempts = [];
  await page.route('**/chat/*/prompt', (route) => {
    attempts.push({ csrf: route.request().headers()['x-p9-csrf'], body: route.request().postDataJSON() });
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(status === 202 ? { accepted: true } : { error: 'login-required' }) });
  });
  return attempts;
}
async function openChat(page, server) {
  await page.waitForSelector('h1:text("Chats")');
  await page.goto(server.origin + '/phone/#chat=' + CHAT);
  await page.waitForSelector('#prompt', { state: 'visible', timeout: 15000 });
}

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
