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
  await until(async () => (await call(server, '/chat?lists=fresh')).lists?.claude?.state === 'ok', 'the agent model list is available');
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
  assert.equal(await page.locator('#gap').isHidden(), true, 'no gap before swap');
  await page.waitForFunction(() => [...document.querySelectorAll('#model option')].some(o => o.value === 'haiku'), null, { timeout: 20000 });
  await page.click('#modePill'); await page.click('#sheet[open] [data-mode="Plan"]');
  await page.click('#modelBtn'); await page.click('#sheet[open] [data-model="haiku"]');
  await page.locator('#prompt').fill('draft survives');
  await page.locator('#attachInput').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64') });
  await page.locator('#attached img[alt="photo.png"]').waitFor();
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT phone-folder-welcome ' + (await page.screenshot()).toString('base64'));
  await page.locator('[data-chat-folder]').click();
  await page.locator('[data-chat-folder-at="site"]').waitFor();
  await page.waitForTimeout(500);
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT phone-folder-picker ' + (await page.screenshot()).toString('base64'));
  await page.locator('[data-chat-folder-at="site"]').click();
  // O61: the chat list read after the swap is held; text typed meanwhile (the sheet dismissed) must go with the new chat.
  let swapped = false, free; const gate = new Promise((done) => { free = done; });
  await page.route('**/chat/*/delete', (route) => { swapped = true; return route.continue(); });
  await page.route(/\/chat\?lists=fresh/, async (route) => { if (swapped) await gate; return route.continue().catch(() => {}); });
  await page.locator('[data-chat-folder-select]').click();
  await until(async () => { const x = (await call(server, '/chat')).conversations; return x.length === 1 && x[0].folder === 'site' && x[0].id !== original; }, 'phone folder swap');
  await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector('#sheet').close());
  assert.equal(await page.locator('#prompt').inputValue(), 'draft survives', 'the box lost its text during the swap');
  await page.locator('#prompt').fill('draft survives, with more typed during the swap');
  // The chat on screen is already the new one, so the text is saved under it and a send would go to it, with the read still held.
  const swappedTo = (await call(server, '/chat')).conversations[0].id;
  await page.waitForFunction((id) => location.hash === '#chat=' + encodeURIComponent(id) && document.querySelector('#conversation').value === id && JSON.parse(localStorage.getItem('p9-drafts') ?? '{}')[id] === 'draft survives, with more typed during the swap', swappedTo, { timeout: 5000 });
  assert.equal(await page.evaluate((id) => Object.keys(JSON.parse(localStorage.getItem('p9-drafts') ?? '{}')).includes(id), original), false, 'text is kept under the deleted chat');
  free(); await page.unroute(/\/chat\?lists=fresh/);
  await page.locator('[data-chat-folder]').filter({ hasText: path.join(server.workspace, 'site') }).waitFor();
  assert.equal(await page.locator('#mode').inputValue(), 'Plan');
  assert.equal(await page.locator('#model').inputValue(), 'haiku');
  await page.locator('#attached img[alt="photo.png"]').waitFor({ timeout: 10000 });
  assert.equal(await page.locator('#prompt').inputValue(), 'draft survives, with more typed during the swap');
  await page.reload();
  await page.locator('#attached img[alt="photo.png"]').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('#prompt').inputValue(), 'draft survives, with more typed during the swap');
  assert.equal(await page.locator('#gap').isHidden(), true, 'no gap immediately after swap');
  const id = (await call(server, '/chat')).conversations[0].id;
  await page.locator('#prompt').fill('photo check'); await page.locator('#composer button[type=submit]').click();
  await page.locator('#events', { hasText: '[image image/png' }).waitFor({ timeout: 20000 });
  await page.locator('#prompt').fill('cwd'); await page.locator('#composer button[type=submit]').click();
  await page.locator('#events', { hasText: 'cwd:new:' + path.join(server.workspace, 'site') }).waitFor({ timeout: 20000 });
  for (const text of ['hello', 'again']) { await page.locator('#prompt').fill(text); await page.locator('#composer button[type=submit]').click(); await page.locator('#events', { hasText: 'echo:' + text }).waitFor({ timeout: 20000 }); }
  assert.equal(await page.locator('[data-chat-folder]').count(), 0, 'sent chat cannot change folder');
  assert.equal(await page.locator('.chat-folder-readonly').innerText(), path.join(server.workspace, 'site'));
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT phone-folder-readonly ' + (await page.screenshot()).toString('base64'));
  assert.equal(await page.locator('#gap').isHidden(), true, 'the empty chat swap does not report a history gap');
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

// O210 (plan A): a project's heading opens its sprints (GET /projects/:id on the phone's listener), drawn with no chats too.
// A sprint not closed has one button that types the ask into a chat of the project: its newest chat that is no sprint's,
// else a new one in the project. The text is added once to what the chat already has typed. Start and Close stay
// desktop presses; the agent asks the user here. A multi-line approval (start_sprint's scripts) shows its lines.
test('O210: the phone shows a project\'s sprints, and Ask to start / close types the ask into a chat of the project', { timeout: 180000 }, async (t) => {
  const server = await remoteDaemon(t, { args: ['--acp-override', path.join(root, 'test/fake-acp-agent.mjs')] });
  const project = async (name) => { const r = await call(server, '/projects', { name, work: { kind: 'p9' } }); assert.equal(r.status, 201, JSON.stringify(r)); return r.project.id; };
  const site = await project('Site'), empty = await project('Empty');
  const own = (await call(server, '/chat', { provider: 'claude', project: site })).conversation;
  const prep = async (id, title) => { const r = await call(server, '/projects/' + id + '/sprints', { title }); assert.equal(r.status, 201, JSON.stringify(r)); return r.sprint; };
  const s1 = await prep(empty, 'S1'), s2 = await prep(site, 'S2');

  const browser = await chromium.launch();
  t.after(() => browser.close());
  const device = await passkeyDevice(browser, server, 'phone-sprints');
  const session = await enrollDevice(server, device);
  const { page, context } = device;
  await page.setViewportSize({ width: 390, height: 844 });
  await context.addCookies([{ name: 'p9s', value: session.token, url: server.origin, httpOnly: true, secure: true, sameSite: 'Strict' }]);
  await context.addInitScript(() => { Object.defineProperty(navigator, 'onLine', { get: () => true, configurable: true }); if (navigator.serviceWorker) navigator.serviceWorker.register = async () => undefined; });
  await page.goto(server.origin + '/phone/');
  await page.evaluate((csrf) => sessionStorage.setItem('p9-csrf', csrf), session.csrf);
  await page.reload();
  await page.setViewportSize({ width: 390, height: 844 });
  await until(async () => JSON.stringify(await groups(page)) === JSON.stringify([['Site', [own]], ['Empty', []]]), 'a project with no chat is listed too: ' + JSON.stringify(await groups(page)));
  const rows = () => page.evaluate(() => [...document.querySelectorAll('#sheet[open] .sprint-row')].map((r) => [r.querySelector('b').textContent, r.querySelector('small').textContent, r.querySelector('button')?.textContent ?? null]));
  const prompt = () => page.locator('#prompt').inputValue();
  const shown = (id) => page.waitForFunction((id) => location.hash === '#chat=' + id && document.querySelector('#conversation').value === id, id, { timeout: 10000 });

  // A project with no chat: its prepared sprint, and the ask goes to a new chat made in that project.
  await page.click(`#chatList [data-project="${empty}"]`);
  await until(async () => (await rows()).length === 1, 'Empty\'s sprint row: ' + await page.evaluate(() => document.querySelector('#sheetBody')?.innerHTML.slice(0, 300)));
  assert.deepEqual(await rows(), [['S1', 'Prepared, not started', 'Ask to start']]);
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT phone-sprints ' + (await page.screenshot()).toString('base64'));
  await page.click('#sheet[open] [data-sprint-ask="start"]');
  await until(async () => (await call(server, '/chat')).conversations.some((c) => c.project === empty), 'a chat made in Empty');
  const made = (await call(server, '/chat')).conversations.find((c) => c.project === empty).id;
  await shown(made);
  assert.equal(await prompt(), `Start the sprint "S1" (sprint ${s1}) with start_sprint.`);

  // A project with its own chat: the ask is added once to that chat's typed text, never sent by the tap.
  await page.click('[data-bar="chat"] [data-back]'); await page.click(`#chatList [data-chat="${own}"]`); await shown(own);
  await page.fill('#prompt', 'first this'); await page.click('[data-bar="chat"] [data-back]');
  for (let i = 0; i < 2; i++) {
    await page.click(`#chatList [data-project="${site}"]`);
    await until(async () => (await rows()).length === 1, 'Site\'s sprint row');
    await page.click('#sheet[open] [data-sprint-ask="start"]');
    await shown(own);
    if (i === 0) await page.click('[data-bar="chat"] [data-back]');
  }
  assert.equal(await prompt(), `first this\nStart the sprint "S2" (sprint ${s2}) with start_sprint.`);
  assert.equal((await call(server, '/chat/events?after=0&only=' + own)).events.filter((e) => e.type === 'user').length, 0, 'the tap sent something');
  assert.equal((await call(server, '/chat')).conversations.length, 2, 'a chat was made though the project has one');

  // Every state, as GET /projects/:id gives it: a started sprint asks to close (paused too), a closed one asks nothing.
  // The started sprint's lead is the project's chat here, so the ask goes to a new chat: a lead (or a worker) never asks.
  const at = Date.now();
  const real = await call(server, '/projects/' + site);
  await page.route('**/projects/' + site, async (route) => { const body = structuredClone(real);
    body.project.sprints = [real.project.sprints[0], { lead: own, title: 'Run', files: [], prep: false, started: at }, { lead: 'p1', title: 'Held', files: [], prep: false, started: at, paused: true },
      { lead: 'c1', title: 'Done', files: [], prep: false, started: at, closed: { at, by: 'owner' } }];
    return route.fulfill({ json: body }); });
  await page.click('[data-bar="chat"] [data-back]');
  await page.click(`#chatList [data-project="${site}"]`);
  await until(async () => (await rows()).length === 4, 'four sprint rows');
  const time = new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  assert.deepEqual(await rows(), [['S2', 'Prepared, not started', 'Ask to start'], ['Run', 'Started ' + time, 'Ask to close'], ['Held', 'Paused · Started ' + time, 'Ask to close'], ['Done', 'Closed ' + time, null]]);
  await page.click('#sheet[open] [data-lead="' + own + '"]');
  await until(async () => (await call(server, '/chat')).conversations.filter((c) => c.project === site).length === 2, 'a new chat in Site');
  const asker = (await call(server, '/chat')).conversations.find((c) => c.project === site && c.id !== own).id;
  await shown(asker);
  assert.equal(await prompt(), `Close the sprint "Run" (sprint ${own}) with close_sprint.`);
  await page.unroute('**/projects/' + site);

  // A question of several lines (start_sprint's, one script per line) is drawn line by line.
  assert.equal((await call(server, '/chat/' + asker + '/prompt', { text: 'perm-json ' + JSON.stringify({ title: 'Start it. Scripts, one per line:\na (after-close): node a.mjs\nb (after-close): node b.mjs' }) })).status, 202);
  await page.waitForSelector('#events .msg.ask.open', { timeout: 15000 });
  assert.equal(await page.locator('#events .msg.ask.open > div').first().innerText(), 'Start it. Scripts, one per line:\na (after-close): node a.mjs\nb (after-close): node b.mjs');

  // O210 fix1 (Reviewer on #402): a reply for a sheet no longer open is dropped. Empty's GET is held; the sheet is closed
  // and Site's opened and drawn; Empty's reply then arrives and must not replace Site's rows, or Ask would go to Empty.
  let release; const held = new Promise((r) => { release = r; });
  const hold = async (route) => { await held; return route.fulfill({ json: await call(server, '/projects/' + empty) }); };
  const arrived = () => page.waitForResponse((r) => r.url().endsWith('/projects/' + empty));
  const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 200)))); // ponytail: the dropped reply's parse and draw are a few microtasks after its response
  const closeSheet = () => page.evaluate(() => document.querySelector('#sheet').close());
  await page.route('**/projects/' + empty, hold);
  await page.click('[data-bar="chat"] [data-back]');
  await page.click(`#chatList [data-project="${empty}"]`);
  await closeSheet();
  await page.click(`#chatList [data-project="${site}"]`);
  await until(async () => (await rows()).length === 1, 'Site\'s row while Empty\'s reply is held');
  let late = arrived(); release(); await late; await settle();
  assert.deepEqual([await page.locator('#sheetTitle').textContent(), await rows()], ['Site', [['S2', 'Prepared, not started', 'Ask to start']]], 'a late reply for Empty replaced Site\'s sheet');
  await page.click('#sheet[open] [data-sprint-ask="start"]');
  await shown(asker); // Site's newest chat that is no sprint's (Empty's would be `made`)
  // The same with a failing reply, while another sheet is open: that sheet stays as it is.
  release = null; const held2 = new Promise((r) => { release = r; });
  await page.unroute('**/projects/' + empty, hold);
  const hold2 = async (route) => { await held2; return route.fulfill({ status: 500, json: { error: 'held' } }); };
  await page.route('**/projects/' + empty, hold2);
  await page.click('[data-bar="chat"] [data-back]');
  await page.click(`#chatList [data-project="${empty}"]`);
  await closeSheet();
  await page.evaluate(() => dispatchEvent(new CustomEvent('p9-sheet', { detail: { title: 'Other', html: '<p id="otherSheet">another picker</p>' } })));
  late = arrived(); release(); await late; await settle();
  assert.deepEqual(await page.evaluate(() => [document.querySelector('#sheetTitle').textContent, document.querySelector('#sheetBody').innerHTML]), ['Other', '<p id="otherSheet">another picker</p>'], 'a late failure for Empty replaced another sheet');
  await page.unroute('**/projects/' + empty, hold2);
});

// O247: a tap on a chat row made while the list redraws still opens that chat. Before, any change to a row (another chat
// starting a turn reads "Working…") rewrote the whole list under the finger, and the tap went nowhere until tried again.
test('O247 phone: a tap held while the chat list redraws still opens the chat', { timeout: 180000 }, async (t) => {
  const server = await remoteDaemon(t, { args: ['--acp-override', path.join(root, 'test/fake-acp-agent.mjs')] });
  const chat = async (title) => {
    const r = await call(server, '/chat', { provider: 'claude', title }); assert.equal(r.status, 201, JSON.stringify(r));
    await call(server, '/chat/' + r.conversation + '/prompt', { text: 'hello' });
    await until(async () => (await call(server, '/chat/events?after=0&only=' + r.conversation)).events.some((e) => e.type === 'turn-end'), title + ' answered');
    return r.conversation;
  };
  for (let i = 1; i <= 8; i++) await chat('Filler ' + i); // below the two used: the list overflows a short screen (the scroll case)
  const tapped = await chat('Tapped'), busy = await chat('Busy');
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const device = await passkeyDevice(browser, server, 'phone-o247');
  const session = await enrollDevice(server, device);
  const { page, context } = device;
  await page.setViewportSize({ width: 390, height: 844 });
  await context.addCookies([{ name: 'p9s', value: session.token, url: server.origin, httpOnly: true, secure: true, sameSite: 'Strict' }]);
  await context.addInitScript(() => { Object.defineProperty(navigator, 'onLine', { get: () => true, configurable: true }); if (navigator.serviceWorker) navigator.serviceWorker.register = async () => undefined; });
  await page.goto(server.origin + '/phone/');
  await page.evaluate((csrf) => sessionStorage.setItem('p9-csrf', csrf), session.csrf);
  await page.reload();
  await page.waitForSelector(`#chatList .row[data-chat="${tapped}"]`);
  // Real touches (CDP): a finger down, then up, as a phone sends them, with pointer events and the tap's click.
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  const middle = async (id) => { const r = await page.locator(`#chatList .row[data-chat="${id}"]`).boundingBox(); return [r.x + r.width / 2, r.y + r.height / 2]; };
  const run = (id) => page.locator(`#chatList .row[data-chat="${id}"]`).getAttribute('data-run').catch(() => '');
  // Prompts a chat, then waits until the phone has taken in that prompt's events: it saves its event cursor (p9-cursor) after
  // each read it has handled, and the list redraw is asked for right after. A held list still shows the chat idle.
  const newest = async (id) => Math.max(0, ...(await call(server, '/chat/events?after=0&only=' + id)).events.map((e) => Number(e.cursor)));
  const prompted = async (id) => {
    const before = await newest(id);
    await call(server, '/chat/' + id + '/prompt', { text: 'slow' });
    await until(async () => (await call(server, '/chat')).conversations.find((c) => c.id === id)?.state === 'turn', id + ' running');
    const after = await newest(id); assert.ok(after > before, 'the prompt made events');
    await until(async () => Number(await page.evaluate(() => localStorage.getItem('p9-cursor'))) >= after, 'the phone took in the prompt');
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));
  };
  await page.evaluate(() => { const now = () => performance.now(); addEventListener('pointerdown', (e) => { window.__ids = { down: e.pointerId, downAt: now() }; }, true); addEventListener('click', (e) => { Object.assign(window.__ids, { click: e.pointerId, at: now() }); }, true); addEventListener('pointercancel', (e) => { Object.assign(window.__ids, { cancel: e.pointerId, cancelAt: now() }); }, true); window.__watch = (sel, attr, value) => { delete window.__ids.seen; const mo = new MutationObserver(() => { if (document.querySelector(sel)?.getAttribute(attr) === value) { window.__ids.seen = now(); mo.disconnect(); } }); mo.observe(document.body, { subtree: true, childList: true, attributes: true }); }; });
  let [x, y] = await middle(tapped);
  await touch('touchStart', x, y);
  await prompted(busy); // its row turns to "Working…": the list redraws
  assert.notEqual(await run(busy), 'working', 'the list waits while the finger is down');
  await page.evaluate((id) => window.__watch(`#chatList .row[data-chat="${id}"]`, 'data-run', 'working'), busy);
  await touch('touchEnd');
  await until(async () => page.evaluate(() => location.hash), 'a chat opened');
  assert.equal(await page.evaluate(() => decodeURIComponent(location.hash)), '#chat=' + tapped, 'the tapped chat opened');
  await until(async () => (await page.evaluate(() => window.__ids.seen)) !== undefined, 'the list redrew after the tap');
  const ids = await page.evaluate(() => window.__ids);
  assert.equal(ids.click, ids.down, 'the tap\'s click carries its touch\'s pointer id');
  assert.ok(ids.seen - ids.at < 300, 'redrawn ' + Math.round(ids.seen - ids.at) + ' ms after the tap\'s click, not on the fallback');
  await page.evaluate(() => history.back());
  await until(async () => (await run(busy)) === 'working', 'the list redrew after the tap');
  // A finger that scrolls instead of tapping. The browser takes the touch (pointercancel): the list scrolls, redraws while the
  // finger is still down, and no chat opens.
  await page.setViewportSize({ width: 390, height: 420 });
  const scrolled = () => page.evaluate(() => { let e = document.querySelector('#chatList'); while (e && !(e.scrollHeight > e.clientHeight && /auto|scroll/.test(getComputedStyle(e).overflowY))) e = e.parentElement; return (e || document.scrollingElement).scrollTop; });
  assert.equal(await scrolled(), 0, 'the list starts at the top');
  [x, y] = await middle(tapped);
  await touch('touchStart', x, y);
  await prompted(tapped);
  assert.notEqual(await run(tapped), 'working', 'held while the finger rests on the row');
  await page.evaluate((id) => window.__watch(`#chatList .row[data-chat="${id}"]`, 'data-run', 'working'), tapped);
  for (let i = 1; i <= 8; i++) await touch('touchMove', x, y - i * 15);
  await until(async () => (await scrolled()) > 0, 'the list scrolled');
  await until(async () => (await run(tapped)) === 'working', 'the list redrew once the scroll took the touch, the finger still down');
  // The cancel ended the hold, not the 10 s cap: the browser cancelled this touch, and the list redrew right after the cancel,
  // sooner than 10 s from the touch's start (both timed in the page).
  const cancel = await page.evaluate(() => window.__ids);
  assert.equal(cancel.cancel, cancel.down, 'the browser cancelled this touch');
  assert.ok(cancel.seen >= cancel.cancelAt && cancel.seen - cancel.cancelAt < 300, 'redrawn right after the cancel');
  assert.ok(cancel.seen - cancel.downAt < 9500, 'redrawn ' + Math.round(cancel.seen - cancel.downAt) + ' ms after the touch began, before the 10 s cap');
  await touch('touchEnd');
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => location.hash), '', 'a scroll opens no chat');
  console.log('PASS O247 phone: a touch held while the list redrew opened the tapped chat; the list redrew after it and after a scroll');
});
