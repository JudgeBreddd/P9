// N1 step 2 point 12: the phone's chat list groups by project the way the desktop's left panel does. One section per
// project in the order they were made, then Chats; a chat's project is the daemon's id, never its folder; an archived
// project's chats are under Chats and an archived chat is not listed. A chat moved into a project on the desktop moves
// on the phone without a reload.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { chromium } from '@playwright/test';
import { remoteDaemon, passkeyDevice, enrollDevice, http, authenticated, root } from './helpers.mjs';

// The desktop's own calls (every POST carries an x-p9-op).
const call = (server, route, body) => http({ socketPath: server.credentials.socketPath, route, method: body === undefined ? 'GET' : 'POST',
  headers: { ...authenticated(server.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-p9-op': randomUUID() }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => ({ status: r.status, ...JSON.parse(r.text) }));
const until = async (check, what) => {
  for (let i = 0; i < 150; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error('timed out: ' + what);
};
// The list as the phone draws it: each heading with the chat ids under it, in order.
const groups = (page) => page.evaluate(() => {
  const out = []; for (const el of document.querySelectorAll('#chatList > *')) {
    if (el.matches('h2.sec')) out.push([el.textContent, []]); else if (el.dataset.chat && out.length) out.at(-1)[1].push(el.dataset.chat);
  } return out;
});

test('phone: the chat list groups by project (point 12)', { timeout: 180000 }, async (t) => {
  const server = await remoteDaemon(t, { args: ['--acp-override', path.join(root, 'test/fake-acp-agent.mjs')] });
  await mkdir(path.join(server.workspace, 'site'), { recursive: true });
  const project = async (name, work) => { const r = await call(server, '/projects', { name, work }); assert.equal(r.status, 201, JSON.stringify(r)); return r.project.id; };
  const site = await project('Site', { kind: 'linked', folder: 'site' });
  const garden = await project('Garden', { kind: 'p9' });
  const old = await project('Old', { kind: 'p9' });
  const chat = async (body) => { const r = await call(server, '/chat', { provider: 'claude', ...body }); assert.equal(r.status, 201, JSON.stringify(r)); return r.conversation; };
  const inSite = await chat({ project: site }), inGarden = await chat({ project: garden }), loose = await chat({});
  const sameFolder = await chat({ folder: 'site' }), inOld = await chat({ project: old }), hidden = await chat({ project: site });
  assert.equal((await call(server, '/projects/' + old, { archived: true })).status, 200);
  assert.equal((await call(server, '/chat/' + hidden + '/archive', { archived: true })).status, 200);

  const browser = await chromium.launch();
  t.after(() => browser.close());
  const device = await passkeyDevice(browser, server, 'phone-projects');
  const session = await enrollDevice(server, device);
  const { page, context } = device;
  await page.setViewportSize({ width: 390, height: 844 });
  await context.addCookies([{ name: 'p9s', value: session.token, url: server.origin, httpOnly: true, secure: true, sameSite: 'Strict' }]);
  await context.addInitScript(() => { Object.defineProperty(navigator, 'onLine', { get: () => true, configurable: true }); if (navigator.serviceWorker) navigator.serviceWorker.register = async () => undefined; });
  await page.goto(server.origin + '/phone/');
  await page.evaluate((csrf) => sessionStorage.setItem('p9-csrf', csrf), session.csrf);
  await page.reload();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForSelector('h1:text("Chats")');
  await until(async () => (await groups(page)).length >= 3, 'the sections drawn: ' + JSON.stringify(await groups(page)));
  const sorted = (g) => g.map(([label, ids]) => [label, [...ids].sort()]);
  assert.deepEqual(sorted(await groups(page)), sorted([['Site', [inSite]], ['Garden', [inGarden]], ['Chats', [loose, sameFolder, inOld]]]),
    'projects in the order made, then Chats; the folder alone decides nothing, an archived project\'s chat is in Chats, an archived chat is not listed');

  // Moved into Garden on the desktop: the phone follows on its next poll.
  assert.equal((await call(server, '/chat/' + loose + '/project', { project: garden })).status, 200);
  await until(async () => JSON.stringify(sorted(await groups(page))) === JSON.stringify(sorted([['Site', [inSite]], ['Garden', [inGarden, loose]], ['Chats', [sameFolder, inOld]]])),
    'the moved chat under Garden: ' + JSON.stringify(await groups(page)));
});

test('phone: an empty chat shows and changes its starting folder', { timeout: 180000 }, async (t) => {
  const server = await remoteDaemon(t, { args: ['--acp-override', path.join(root, 'test/fake-acp-agent.mjs')] });
  await mkdir(path.join(server.workspace, 'site'), { recursive: true });
  const original = (await call(server, '/chat', { provider: 'claude' })).conversation;
  const browser = await chromium.launch(); t.after(() => browser.close());
  const device = await passkeyDevice(browser, server, 'phone-folder');
  const session = await enrollDevice(server, device);
  const { page, context } = device;
  await page.setViewportSize({ width: 390, height: 844 });
  await context.addCookies([{ name: 'p9s', value: session.token, url: server.origin, httpOnly: true, secure: true, sameSite: 'Strict' }]);
  await context.addInitScript(() => { Object.defineProperty(navigator, 'onLine', { get: () => true, configurable: true }); if (navigator.serviceWorker) navigator.serviceWorker.register = async () => undefined; });
  await page.goto(server.origin + '/phone/'); await page.evaluate((csrf) => sessionStorage.setItem('p9-csrf', csrf), session.csrf); await page.reload();
  await page.locator(`[data-chat="${original}"]`).click();
  await page.locator('[data-chat-folder]').filter({ hasText: server.workspace }).waitFor();
  await page.locator('[data-chat-folder]').click();
  await page.locator('[data-chat-folder-at="site"]').waitFor();
  await page.waitForTimeout(500);
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT phone-folder-picker ' + (await page.screenshot()).toString('base64'));
  await page.locator('[data-chat-folder-at="site"]').click();
  await page.locator('[data-chat-folder-select]').click();
  await until(async () => { const x = (await call(server, '/chat')).conversations; return x.length === 1 && x[0].folder === 'site' && x[0].id !== original; }, 'phone folder swap');
  await page.locator('[data-chat-folder]').filter({ hasText: path.join(server.workspace, 'site') }).waitFor();
  const id = (await call(server, '/chat')).conversations[0].id;
  await page.locator('#prompt').fill('cwd'); await page.locator('#composer button[type=submit]').click();
  await page.locator('#events', { hasText: 'cwd:new:' + path.join(server.workspace, 'site') }).waitFor({ timeout: 20000 });
  assert.equal(await page.locator('[data-chat-folder]').count(), 0, 'sent chat cannot change folder');
  assert.equal(await page.locator('.chat-folder-readonly').innerText(), path.join(server.workspace, 'site'));
  assert.notEqual(id, original);
});

test('phone: folder browsing and outside chat folders require unrestricted mode', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  const outside = path.join(server.directory, 'outside-workspace'); await mkdir(outside, { recursive: true });
  const browser = await chromium.launch(); t.after(() => browser.close());
  const device = await passkeyDevice(browser, server, 'phone-folder-security');
  const session = await enrollDevice(server, device);
  const folderRoute = '/files/folders?' + new URLSearchParams({ path: outside });
  const remote = (route, options = {}) => server.remote(route, { session, ...options });
  assert.equal((await remote(folderRoute)).status, 403, 'file protection on refuses outside browsing');
  assert.equal((await server.desk('/file-protection', 'POST', { on: false })).status, 200);
  assert.equal((await remote(folderRoute)).status, 200, 'unrestricted permits folder browsing');
  const create = () => remote('/chat', { method: 'POST', body: { provider: 'claude', folder: outside }, headers: { 'x-p9-op': randomUUID() } });
  assert.equal((await create()).status, 201, 'unrestricted permits outside chat folder');
  assert.equal((await server.desk('/agent-lock', 'POST', { on: true })).status, 200);
  assert.equal((await remote(folderRoute)).status, 403, 'agent lock refuses outside browsing');
  assert.equal((await create()).status, 400, 'agent lock refuses outside chat folder');
  assert.equal((await server.desk('/agent-lock', 'POST', { on: false })).status, 200);
  assert.equal((await server.desk('/file-protection', 'POST', { on: true })).status, 200);
  assert.equal((await create()).status, 400, 'file protection refuses outside chat folder');
});
