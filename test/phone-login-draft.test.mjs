import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
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

// P2 (v0.1.6): Mission answers and a new idea typed on the phone survive a sign-in: back in their boxes, unsent; an answer
// whose item went away during the sign-in is shown to copy, not dropped.
test('P2: a 401 on Send answer keeps the typed Mission answers and the new idea through the sign-in', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, { setup: missionSetup });
  const { page } = await phone(t, server, { touchScreen: false });
  await page.click('[data-nav="mission"]');
  await page.click('[data-open="work"]', { timeout: 15000 });
  await page.click('#w-work summary:text("+ New idea")');
  await page.fill('#w-work form[data-idea] [name="name"]', 'kept-idea');
  await page.fill('#w-work form[data-idea] [name="text"]', 'an idea typed before the session ended');
  await page.check('#w-work form[data-idea] [name="needs"]');
  await page.click('#w-work [data-close]');
  await page.click('[data-open="queue"]');
  for (const [title, text] of [['Pick a size', 'large, typed before the session ended'], ['Pick a color', 'blue, typed before the session ended']]) {
    await page.click(`#w-queue summary:text("${title}")`);
    await page.fill(`#w-queue details:has(summary:text("${title}")) textarea`, text);
  }
  await page.route('**/mission/answer', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"login-required"}' }), { times: 1 });
  await page.click('#w-queue details:has(summary:text("Pick a color")) button[type="submit"]');
  await page.waitForURL(/\/login/, { timeout: 10000 });
  await unlink(path.join(server.workspace, '_tyler', 'p9-size.md')); // answered elsewhere while this phone signs in
  await page.click('#login');
  await page.waitForURL(/\/phone\//, { timeout: 15000 });
  // Both windows open, stacked: the idea on top, Back shows the answers under it.
  const idea = page.locator('#w-work form[data-idea]');
  await idea.locator('[data-note]:text("Kept through sign-in, not sent")').waitFor({ timeout: 15000 });
  assert.deepEqual([await idea.locator('[name="name"]').inputValue(), await idea.locator('[name="text"]').inputValue(), await idea.locator('[name="needs"]').isChecked()],
    ['kept-idea', 'an idea typed before the session ended', true]);
  console.log('P9_SHOT p2-idea-kept ' + (await page.screenshot()).toString('base64'));
  await page.click('#w-work [data-close]');
  const color = page.locator('#w-queue details:has(summary:text("Pick a color"))');
  await color.locator('[data-note]:text("Kept through sign-in, not sent")').waitFor({ timeout: 15000 });
  assert.equal(await color.locator('textarea').inputValue(), 'blue, typed before the session ended');
  assert.match(await page.locator('#w-queue [data-kept]').innerText(), /p9-size\.md[\s\S]*large, typed before the session ended/, 'the gone item\'s answer is shown to copy');
  console.log('P9_SHOT p2-mission-kept ' + (await page.screenshot()).toString('base64'));
  assert.equal(await page.evaluate(() => localStorage.getItem('p9-mission-draft')), null, 'nothing left in storage once all is back');
  console.log('PASS P2: Mission answers and the new idea came back unsent; the gone item\'s answer is shown to copy');
});

// A workspace with two answerable Mission items and a hub, so the phone shows Waiting on you and + New idea.
async function missionSetup(paths) {
    for (const dir of ['hub', '_tyler', '_ideas/needs-done', 'projects']) await mkdir(path.join(paths.workspace, dir), { recursive: true });
  await writeFile(path.join(paths.workspace, 'hub', 'registry.json'), JSON.stringify({ scripts: [], apps: [], pages: [] }));
  await writeFile(path.join(paths.workspace, 'projects', 'AGENTS.md'), '# Projects\n');
  await writeFile(path.join(paths.workspace, '_tyler', 'p9-color.md'), '# Pick a color\n\nQ. Which one?\n\nA.\n');
  await writeFile(path.join(paths.workspace, '_tyler', 'p9-size.md'), '# Pick a size\n\nQ. How big?\n\nA.\n');
  const settings = path.join(paths.directory, 'settings.json');
  await writeFile(settings, JSON.stringify({ registry: 'hub/registry.json', primary: 'projects/AGENTS.md', waiting: '_tyler', hub: 'hub' }));
  return { args: ['--settings', settings] };
}

// P2 (v0.1.6): a Mission refresh (the Refresh button; the hub's 15 s retry redraws the same way) rebuilt the forms and
// wiped what was typed; the text stays, and a saved idea does not come back after the redraw that follows its save.
test('P2: a phone Mission refresh keeps the typed answer and idea; a saved idea leaves the form', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, { setup: missionSetup });
  const { page } = await phone(t, server, { touchScreen: false });
  await page.click('[data-nav="mission"]');
  await page.click('[data-open="queue"]', { timeout: 15000 });
  await page.click('#w-queue summary:text("Pick a color")');
  const answer = page.locator('#w-queue details:has(summary:text("Pick a color")) textarea');
  await answer.fill('blue, typed before a refresh');
  await page.click('#w-queue [data-close]');
  await page.click('[data-open="work"]');
  await page.click('#w-work summary:text("+ New idea")');
  await page.fill('#w-work form[data-idea] [name="name"]', 'refresh-idea');
  await page.fill('#w-work form[data-idea] [name="text"]', 'an idea typed before a refresh');
  await page.click('#w-work [data-close]');
  const fresh = Promise.all([page.waitForResponse(/\/mission$/), page.waitForResponse(/\/mission\/hub$/)]);
  await page.click('#refreshMission');
  await fresh; await page.waitForTimeout(300); // the hub draws after its answer is read
  assert.equal(await answer.inputValue(), 'blue, typed before a refresh');
  assert.equal(await answer.isVisible(), false, 'its window is closed');
  await page.click('[data-open="queue"]');
  assert.equal(await answer.isVisible(), true, 'the row holding the kept text is open');
  await page.click('#w-queue [data-close]');
  await page.click('[data-open="work"]');
  const idea = page.locator('#w-work form[data-idea]');
  assert.deepEqual([await idea.locator('[name="name"]').inputValue(), await idea.locator('[name="text"]').inputValue()], ['refresh-idea', 'an idea typed before a refresh']);
  console.log('P9_SHOT p2-refresh-kept ' + (await page.screenshot()).toString('base64'));
  await idea.locator('button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('#mission form[data-idea] [data-note]')?.textContent, null, { timeout: 10000 });
  assert.match(await idea.locator('[data-note]').innerText(), /^Saved /);
  await page.waitForResponse(/\/mission\/hub$/, { timeout: 10000 }); await page.waitForTimeout(300); // the redraw 900 ms after a save
  assert.deepEqual([await idea.locator('[name="name"]').inputValue(), await idea.locator('[name="text"]').inputValue()], ['', ''], 'a saved idea does not come back');
  assert.ok((await readdir(path.join(server.workspace, '_ideas'))).some((name) => name.startsWith('refresh-idea')), 'the idea was written');
  console.log('PASS P2: a Mission refresh kept the typed answer and idea; the saved idea left the form');
});
