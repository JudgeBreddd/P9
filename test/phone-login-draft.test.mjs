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

// P2 (v0.1.6): a session that ends while a file is being edited: Save's 401 goes to the login page, which says why, and the
// edit comes back in the editor after the login, still unsaved, the file on disk untouched.
test('P2: a 401 on Save keeps the file edit through the sign-in, and the login page says the sign-in ended', { timeout: 120000 }, async (t) => {
  const { writeFile, readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const server = await remoteDaemon(t, { setup: async (paths) => { await writeFile(path.join(paths.workspace, 'note.txt'), 'on disk\n'); return {}; } });
  const { page } = await phone(t, server, { touchScreen: false });
  await page.click('[data-nav="files"]');
  await page.click('#fileList button[data-name="note.txt"]', { timeout: 10000 });
  await page.waitForSelector('#fileState:text("Loaded")', { timeout: 10000 });
  await page.locator('.cm-content').click(); await page.keyboard.press('Control+A'); await page.keyboard.type('typed before the session ended');
  await page.route('**/files', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"login-required"}' }), { times: 1 });
  await page.click('#save');
  await page.waitForURL(/\/login/, { timeout: 10000 });
  await page.waitForSelector('#status:text("Your sign-in ended")', { timeout: 5000 });
  console.log('P9_SHOT p2-login-ended ' + (await page.screenshot()).toString('base64'));
  await page.click('#login');
  await page.waitForURL(/\/phone\//, { timeout: 15000 });
  await page.waitForSelector('#fileState:text("kept through sign-in")', { timeout: 15000 });
  assert.equal(await page.locator('.cm-content').innerText(), 'typed before the session ended');
  console.log('P9_SHOT p2-file-kept ' + (await page.screenshot()).toString('base64'));
  assert.equal(await page.locator('#save').isEnabled(), true, 'still unsaved: Save is live');
  assert.equal(await readFile(path.join(server.workspace, 'note.txt'), 'utf8'), 'on disk\n');
  console.log('PASS P2: the file edit came back after sign-in, unsaved, and the login page said why');
});
