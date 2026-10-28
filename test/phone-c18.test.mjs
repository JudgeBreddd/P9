import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { remoteDaemon, root } from './helpers.mjs';
import { phone } from './phone-c16-helpers.mjs';

// c18: the phone's Theme picker, Settings and Rebuild + reload (threat model rows 63 and 64). The build is a stand-in
// (P9_BUILD): the real pnpm build would rewrite apps/web/dist, which the other tests in this copy are serving.
// The sheet slides in for 300 ms; a picture taken during it is half see-through.
const shot = async (page, name) => { await page.waitForTimeout(500); const png = await page.screenshot(); if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png.toString('base64')); };
async function standIn(paths, body) {
  const file = path.join(paths.directory, 'build.sh');
  await writeFile(file, '#!/bin/sh\n' + body + '\n');
  await chmod(file, 0o755);
  return file;
}
const marker = (server) => path.join(server.directory, 'built.txt');
const builds = async (server) => (await readFile(marker(server), 'utf8').catch(() => '')).split('\n').filter(Boolean);
const rebuilding = (paths, extraEnv = {}) => async () => ({ env: { ...extraEnv,
  P9_BUILD: await standIn(paths, 'sleep 2\npwd >> ' + JSON.stringify(path.join(paths.directory, 'built.txt'))) } });

test('c18 row 64: POST /rebuild runs the build in the checkout, one at a time; refused without a session, CSRF or with a body', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, { setup: (paths) => rebuilding(paths)() });
  const { session } = await phone(t, server);
  assert.deepEqual((await server.remote('/rebuild', { session })).body, { available: true, running: false });
  assert.equal((await server.remote('/rebuild', { method: 'POST', body: {} })).status, 401, 'no session');
  assert.equal((await server.remote('/rebuild', { method: 'POST', session, body: {}, headers: { 'x-p9-csrf': 'wrong' } })).status, 403, 'wrong CSRF token');
  const extra = await server.remote('/rebuild', { method: 'POST', session, body: { command: 'rm -rf /' } });
  assert.deepEqual([extra.status, extra.body], [400, { error: 'request-refused' }], 'a body is refused: the phone picks nothing');
  assert.deepEqual(await builds(server), [], 'nothing was built by a refused request');

  const first = server.remote('/rebuild', { method: 'POST', session, body: {} });
  for (let i = 0; i < 50 && !(await server.remote('/rebuild', { session })).body.running; i++) await new Promise((r) => setTimeout(r, 100));
  const second = await server.remote('/rebuild', { method: 'POST', session, body: {} });
  assert.deepEqual([second.status, second.body], [409, { error: 'rebuild-running' }], 'a second rebuild while one runs');
  const done = await first;
  assert.deepEqual([done.status, done.body], [200, { rebuilt: true }]);
  assert.deepEqual(await builds(server), [path.resolve(root)], 'one build, in the checkout the daemon serves');
  assert.equal((await server.remote('/rebuild', { session })).body.running, false);
  console.log('PASS c18 row 64: one build in the checkout; second during it 409; no session 401, bad CSRF 403, a body 400');
});

test('c18 row 64: a failed build answers 500 with the last 3 lines of its errors, at most 300 characters', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, { setup: async (paths) => ({ env: { P9_BUILD: await standIn(paths,
    'for n in 1 2 3 4 5; do echo "error line $n" >&2; done\necho "' + 'x'.repeat(400) + '" >&2\nexit 1') } }) });
  const { session } = await phone(t, server);
  const failed = await server.remote('/rebuild', { method: 'POST', session, body: {} });
  assert.equal(failed.status, 500);
  assert.equal(failed.body.error, 'build-failed');
  assert.equal(failed.body.detail, ('error line 4\nerror line 5\n' + 'x'.repeat(400)).slice(0, 300));
  console.log('PASS c18 row 64: a failed build is 500 build-failed with only its last 3 stderr lines, capped at 300');
});

test('c18 row 64: an installed (packaged) server has no Rebuild + reload: the route refuses and the phone shows why', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, { setup: async (paths) => rebuilding(paths, { P9_PACKAGED: '1' })() });
  const { page, session } = await phone(t, server);
  assert.deepEqual((await server.remote('/rebuild', { session })).body, { available: false, running: false });
  const refused = await server.remote('/rebuild', { method: 'POST', session, body: {} });
  assert.deepEqual([refused.status, refused.body], [403, { error: 'rebuild-unsupported' }]);
  await page.click('[data-bar="chat"] #setBtn');
  await page.waitForSelector('#phoneSettings h2:text("Maintenance")');
  assert.equal(await page.locator('#mtRebuild').count(), 0, 'no Rebuild + reload button on an installed server');
  assert.match(await page.locator('#phoneSettings').innerText(), /runs an installed build/);
  assert.deepEqual(await builds(server), []);
  console.log('PASS c18 row 64: packaged server: GET available false, POST 403, no button on the phone');
});

test('c18: the Chats bar has New chat, Theme and Settings; a theme survives a reload; fonts load; Rebuild + reload reloads', { timeout: 180000 }, async (t) => {
  const server = await remoteDaemon(t, { setup: (paths) => rebuilding(paths)() });
  const { page, session } = await phone(t, server);
  const refused = [];
  page.on('console', (message) => { if (/Content.Security.Policy|Refused to load/i.test(message.text())) refused.push(message.text()); });
  const fonts = [];
  page.on('response', (response) => { if (response.url().endsWith('.woff2')) fonts.push([response.status(), response.headers()['content-type']]); });
  await page.reload();
  await page.waitForSelector('h1:text("Chats")');
  assert.deepEqual(await page.$$eval('[data-bar="chat"] button[id]', (buttons) => [...new Set(buttons.map((b) => b.id + ':' + b.getAttribute('aria-label')))]),
    ['newChat:New chat', 'themeBtn:Theme', 'setBtn:Settings']);
  const boot = await server.remote('/duwop-boot.js', { session });
  assert.deepEqual([boot.status, boot.headers['content-type']], [200, 'text/javascript; charset=utf-8']);

  // Theme: the desktop's picker in the sheet; the pick is this phone's, kept across a reload, and the browser bar follows.
  const before = await page.evaluate(() => document.documentElement.dataset.theme);
  // A full-screen sheet (c12's p9-sheet full: true), closed, leaves no full class for the Theme sheet.
  await page.evaluate(() => { dispatchEvent(new CustomEvent('p9-sheet', { detail: { title: 'Full', html: '<p>x</p>', full: true } })); document.querySelector('#sheet').close(); });
  await page.click('[data-bar="chat"] #themeBtn');
  await page.waitForSelector('#themeMenu .tcard');
  assert.equal(await page.$eval('#sheet', (sheet) => sheet.classList.contains('full')), false, 'Theme sheet opened full-screen after a full sheet');
  const other = await page.$eval('#themeMenu [data-theme-pick]:not([data-theme-pick="' + before + '"])', (card) => card.dataset.themePick);
  await page.click('#themeMenu [data-theme-pick="' + other + '"]');
  await page.waitForTimeout(300);
  await page.$eval('dialog.sheet', (sheet) => { sheet.scrollTop = 0; });
  await shot(page, 'phone-theme-picker');
  const card = await page.locator('#themeMenu .tcard').first().boundingBox();
  assert.ok(card.width > 120 && card.width < 200, 'theme cards sit two to a row: ' + JSON.stringify(card));
  const barBefore = await page.$eval('meta[name="theme-color"]', (meta) => meta.content);
  await page.reload();
  await page.waitForSelector('h1:text("Chats")');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), other, 'the picked theme is back after a reload');
  assert.equal(await page.$eval('meta[name="theme-color"]', (meta) => meta.content), barBefore, 'the browser bar takes the theme');
  assert.match(barBefore, /^#[0-9a-f]{6}$/);
  await page.evaluate(() => document.fonts.ready);
  assert.ok(fonts.length > 0 && fonts.every(([status, type]) => status === 200 && type === 'font/woff2'), 'theme fonts: ' + JSON.stringify(fonts));
  assert.deepEqual(refused, [], 'nothing refused by the CSP');

  // Settings > Maintenance > Rebuild + reload: Rebuilding… until the daemon answers, then the page loads again.
  await page.click('[data-bar="chat"] #setBtn');
  await page.waitForSelector('#mtRebuild:text("Rebuild + reload")');
  await shot(page, 'phone-settings');
  await page.evaluate(() => { window.beforeRebuild = true; });
  await page.click('#mtRebuild');
  await page.waitForSelector('#mtRebuild:text("Rebuilding…")');
  assert.equal(await page.locator('#mtRebuild').isDisabled(), true);
  await shot(page, 'phone-rebuilding');
  await page.waitForFunction(() => !window.beforeRebuild, null, { timeout: 30000 });
  await page.waitForSelector('h1:text("Chats")');
  assert.deepEqual(await builds(server), [path.resolve(root)]);
  await page.click('[data-bar="chat"] #setBtn');
  await page.waitForSelector('#mtRebuild:text("Rebuild + reload")');
  await shot(page, 'phone-rebuild-done');
  console.log('PASS c18: three buttons; theme ' + other + ' kept over a reload; ' + fonts.length + ' fonts under the CSP; Rebuild + reload built once and reloaded');
});
