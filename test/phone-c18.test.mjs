import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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

// c18 part 2 (threat model row 66; Builder, 2026-10-27, A. 2): the phone changes what the desktop's Settings changes, through the
// desktop's own routes, behind its session, CSRF and op ID. settings.json is in the test home (main.mjs's default place).
const SETTINGS = { primary: 'AGENTS.md', registry: 'registry.json', waiting: 'needs-you' };
const settingsFile = (paths) => path.join(paths.directory, '.config', 'p9', 'settings.json');
const withSettings = async (paths) => {
  await mkdir(path.dirname(settingsFile(paths)), { recursive: true });
  await writeFile(path.join(paths.workspace, 'AGENTS.md'), '# work\n'); await writeFile(path.join(paths.workspace, 'registry.json'), '{"scripts":[],"apps":[],"pages":[]}');
  await mkdir(path.join(paths.workspace, 'needs-you'));
  await writeFile(settingsFile(paths), JSON.stringify(SETTINGS));
  return {};
};
const onDisk = async (server) => JSON.parse(await readFile(settingsFile(server), 'utf8'));
const op = () => ({ 'x-p9-op': randomUUID() });

test('c18 row 66: the phone turns the agent lock and File protection on and off and saves settings.json; refused without a session or CSRF, or with a bad body', { skip: process.platform === 'win32', timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, { setup: withSettings });
  const { session } = await phone(t, server);
  const post = (route, body, extra = {}) => server.remote(route, { method: 'POST', session, body, headers: { ...op(), ...extra } });
  // The agent lock: on and off from the phone, and the desktop sees it.
  assert.deepEqual([(await post('/agent-lock', { on: true })).status, (await server.desk('/agent-lock')).body], [200, { on: true }]);
  assert.deepEqual((await post('/agent-lock', { on: false })).body, { on: false });
  // File protection: the phone reads it and turns it off and on again.
  assert.deepEqual((await server.remote('/file-protection', { session })).body, { on: true });
  assert.deepEqual([(await post('/file-protection', { on: false })).body, (await server.desk('/file-protection')).body], [{ on: false }, { on: false }]);
  assert.deepEqual((await post('/file-protection', { on: true })).body, { on: true });
  // Refused: no session, a wrong CSRF token, a body of any other shape; nothing changed.
  for (const route of ['/agent-lock', '/file-protection']) {
    assert.equal((await server.remote(route, { method: 'POST', body: { on: true }, headers: op() })).status, 401, route + ' no session');
    assert.equal((await post(route, { on: route === '/agent-lock' }, { 'x-p9-csrf': 'wrong' })).status, 403, route + ' wrong CSRF');
    for (const bad of [{ on: 'off' }, { on: false, x: 1 }, {}]) assert.equal((await post(route, bad)).status, 400, route + ' ' + JSON.stringify(bad));
  }
  assert.deepEqual([(await server.desk('/agent-lock')).body, (await server.desk('/file-protection')).body], [{ on: false }, { on: true }]);

  // settings.json: the phone reads it (not the desktop's phone address) and saves a row through the same checks, keeping .bak.
  const read = await server.remote('/setup/settings', { session });
  assert.deepEqual(read.body, { settings: SETTINGS, error: null }, 'no remoteOrigin for the phone');
  assert.equal((await server.desk('/setup/settings')).body.remoteOrigin, server.origin, 'the desktop still gets it');
  const saved = await post('/setup/settings', { server_host: 'box' });
  assert.deepEqual([saved.status, saved.body], [200, { settings: { ...SETTINGS, server_host: 'box' } }]);
  assert.deepEqual(await onDisk(server), { ...SETTINGS, server_host: 'box' });
  assert.deepEqual(JSON.parse(await readFile(settingsFile(server) + '.bak', 'utf8')), SETTINGS);
  for (const [body, extra, status, error] of [[{ nope: 1 }, {}, 400, 'request-refused'], [{ server_host: 'a b' }, {}, 400, 'settings-refused'], [{}, {}, 400, 'request-refused'],
    [{ server_host: 'other' }, { 'x-p9-csrf': 'wrong' }, 403, 'request-refused']]) {
    const refused = await post('/setup/settings', body, extra);
    assert.deepEqual([refused.status, refused.body?.error], [status, error], JSON.stringify(body));
  }
  assert.equal((await server.remote('/setup/settings', { method: 'POST', body: { server_host: 'other' }, headers: op() })).status, 401);
  assert.deepEqual(await onDisk(server), { ...SETTINGS, server_host: 'box' }, 'nothing written by a refused save');
  // The rest of /setup and new files stay the desktop's.
  for (const route of ['/setup/starter', '/setup/login', '/setup/agent-terminal']) assert.equal((await post(route, {})).status, 404, route);
  assert.equal((await post('/files', { path: 'phone-made.txt', content: 'x' })).status, 404);
  console.log('PASS c18 row 66: phone lock on/off, protection off/on, settings row saved with .bak; no session 401, bad CSRF 403, bad body 400, nothing changed');
});

test('c18 row 66: the phone\'s Security settings: one toggle each, protection off asks first, Unrestricted mode turns all off and back; Mission Control files save', { skip: process.platform === 'win32', timeout: 180000 }, async (t) => {
  const server = await remoteDaemon(t, { setup: withSettings });
  const { page } = await phone(t, server);
  const asked = [];
  let answer = false;
  page.on('dialog', (dialog) => { asked.push(dialog.message()); return answer ? dialog.accept() : dialog.dismiss(); });
  const open = async () => { if (await page.locator('#sheet[open]').count()) await page.evaluate(() => document.querySelector('#sheet').close());
    await page.click('[data-bar="chat"] #setBtn'); await page.waitForSelector('#phoneSettings #setFree'); };
  const checked = () => page.$$eval('#phoneSettings label.set input', (boxes) => Object.fromEntries(boxes.map((b) => [b.id, b.checked])));
  const daemonSide = async () => [(await server.desk('/agent-lock')).body.on, (await server.desk('/file-protection')).body.on];
  const local = () => page.evaluate(() => ['p9-mode-ok:Full access', 'p9-mode-ok:Bypass permissions', 'p9-mode:codex', 'p9-mode:claude'].map((k) => localStorage.getItem(k)));
  const settled = (want) => page.waitForFunction((want) => JSON.stringify([...document.querySelectorAll('#phoneSettings label.set input')].map((b) => b.checked)) === want, JSON.stringify(want), { timeout: 5000 });
  await open();
  assert.deepEqual(await page.$$eval('#phoneSettings h2', (h) => h.map((x) => x.textContent)), ['Security settings', 'Mission Control files', 'Maintenance']);
  assert.deepEqual(await page.$$eval('#phoneSettings label.set strong', (s) => s.map((x) => x.textContent)), ['Agent lock', 'File protection', 'Warn before Full access and Bypass permissions', 'Unrestricted mode']);
  assert.deepEqual(await checked(), { setLock: false, setProtect: true, setWarn: true, setFree: false }, 'the defaults');
  // One toggle each.
  await page.click('#setLock'); await settled([true, true, true, false]);
  assert.deepEqual(await daemonSide(), [true, true]);
  await page.click('#setLock'); await settled([false, true, true, false]);
  // File protection off asks first; Cancel keeps it on, OK turns it off; on never asks.
  await page.click('#setProtect'); await settled([false, true, true, false]);
  assert.equal(asked.length, 1); assert.match(asked[0], /^Turn off file protection\?/); assert.match(asked[0], /\.env/);
  assert.deepEqual(await daemonSide(), [false, true], 'Cancel kept protection on');
  answer = true; await page.click('#setProtect'); await settled([false, false, true, false]);
  assert.deepEqual(await daemonSide(), [false, false]);
  await page.click('#setProtect'); await settled([false, true, true, false]);
  assert.equal(asked.length, 2, 'turning protection on never asks');
  await page.click('#setWarn'); await settled([false, true, false, false]);
  assert.deepEqual(await local(), ['1', '1', null, null]);
  await page.click('#setWarn'); await settled([false, true, true, false]);
  assert.deepEqual(await local(), [null, null, null, null]);
  // Unrestricted mode, with the lock on: Cancel changes nothing; OK turns every restriction off.
  await page.click('#setLock'); await settled([true, true, true, false]);
  answer = false; await page.click('#setFree'); await settled([true, true, true, false]);
  assert.match(asked.at(-1), /^Turn on Unrestricted mode\?/);
  assert.deepEqual([await daemonSide(), await local()], [[true, true], [null, null, null, null]], 'Cancel changed nothing');
  answer = true; await page.click('#setFree'); await settled([false, false, false, true]);
  assert.deepEqual([await daemonSide(), await local()], [[false, false], ['1', '1', 'Full access', 'Bypass permissions']]);
  await page.locator('#phoneSettings h2').first().scrollIntoViewIfNeeded(); await shot(page, 'phone-security-unrestricted');
  await page.reload(); await page.waitForSelector('h1:text("Chats")'); await open();
  assert.deepEqual(await checked(), { setLock: false, setProtect: false, setWarn: false, setFree: true }, 'still on after a reload');
  // Off puts the defaults back: protection on, the warnings on, new chats in the agents' own modes, the lock off.
  const before = asked.length;
  await page.click('#setFree'); await settled([false, true, true, false]);
  assert.deepEqual([await daemonSide(), await local(), asked.length], [[false, true], [null, null, null, null], before]);

  // Mission Control files: the desktop's rows; a value saves when the box is left, a refused one keeps its reason.
  const host = page.locator('#phoneSettings [data-mission="server_host"]');
  await host.fill('box'); await host.blur();
  await page.waitForFunction(() => document.querySelector('#phoneSettings [data-mission="server_host"]')?.value === 'box' && !document.querySelector('[data-mission-err]'));
  for (let i = 0; i < 30 && (await onDisk(server)).server_host !== 'box'; i++) await page.waitForTimeout(100);
  assert.deepEqual(await onDisk(server), { ...SETTINGS, server_host: 'box' });
  await host.fill('a b'); await host.blur();
  await page.waitForSelector('#phoneSettings [data-mission-err]');
  assert.match(await page.locator('#phoneSettings [data-mission-err]').innerText(), /^Not saved: server_host/);
  assert.deepEqual(await onDisk(server), { ...SETTINGS, server_host: 'box' });
  await page.locator('#phoneSettings [data-mission-err]').scrollIntoViewIfNeeded(); await shot(page, 'phone-mission-files');
  await page.reload(); await page.waitForSelector('h1:text("Chats")'); await open();
  assert.equal(await page.locator('#phoneSettings [data-mission="server_host"]').inputValue(), 'box', 'kept over a reload');
  console.log('PASS c18 row 66: phone toggles; protection off asks (Cancel keeps it); Unrestricted on/off with one confirm, kept over a reload; a Mission row saved, a bad one refused');
});
