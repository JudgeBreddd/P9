import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from '@playwright/test';
import { enrollDevice } from './helpers.mjs';

// A phone-sized browser on the phone page, signed in.
export async function phone(t, server, { touchScreen = false } = {}) {
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

// A chat the daemon never ran: a finished turn (Send goes straight out), or one with no end yet (the phone reads it as running).
export const CHAT = '00000000-0000-4000-8000-0000000000c1';
export function seedChat(server, { running = false } = {}) {
  const db = new DatabaseSync(path.join(server.directory, '.local', 'state', 'p9-foundation', 'p9.db'));
  db.prepare('INSERT INTO conversations (id, provider, title, state, created) VALUES (?, ?, ?, ?, ?)').run(CHAT, 'claude', 'Draft chat', 'idle', Date.now());
  const event = db.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)');
  event.run(CHAT, 'user', JSON.stringify({ text: 'hello' }), Date.now());
  if (!running) event.run(CHAT, 'turn-end', JSON.stringify({ stopReason: 'end_turn' }), Date.now());
  db.close();
}
// The prompt route is answered here (status, or 202), and every attempt is kept: the daemon never sees the message.
export async function stubPrompt(page, status) {
  const attempts = [];
  await page.route('**/chat/*/prompt', (route) => {
    attempts.push({ csrf: route.request().headers()['x-p9-csrf'], body: route.request().postDataJSON() });
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(status === 202 ? { accepted: true } : { error: 'login-required' }) });
  });
  return attempts;
}
export async function openChat(page, server) {
  await page.waitForSelector('h1:text("Chats")');
  await page.goto(server.origin + '/phone/#chat=' + CHAT);
  await page.waitForSelector('#prompt', { state: 'visible', timeout: 15000 });
}

