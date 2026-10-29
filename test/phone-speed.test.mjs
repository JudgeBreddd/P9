import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { remoteDaemon } from './helpers.mjs';
import { phone } from './phone-c16-helpers.mjs';

// Phone open speed (owner, 2026-10-29: about 2 min to open after Face ID on a work network). Opens the phone on Chrome's
// Fast 3G profile with six open chats of long history and logs, as "P9_TIME <case> <json>": the time to the first chat
// screen ('p9-chat-painted', phone.ts), the bytes the page and the service worker fetched, and each request.
const FAST3G = { offline: false, latency: 563, downloadThroughput: 180000, uploadThroughput: 84375 };
const CHATS = 6, TURNS = 60;

function seed(server) {
  const db = new DatabaseSync(path.join(server.directory, '.local', 'state', 'p9-foundation', 'p9.db'));
  const chat = db.prepare('INSERT INTO conversations (id, provider, title, state, created) VALUES (?, ?, ?, ?, ?)');
  const event = db.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)');
  const text = 'A long answer line that a real agent writes, with some detail in it. '.repeat(8);
  for (let c = 0; c < CHATS; c++) {
    const id = '00000000-0000-4000-8000-0000000005' + String(c).padStart(2, '0');
    chat.run(id, 'claude', 'Chat ' + c, 'idle', Date.now() - c);
    for (let i = 0; i < TURNS; i++) {
      event.run(id, 'user', JSON.stringify({ text: 'question ' + i }), Date.now());
      for (let k = 0; k < 4; k++) event.run(id, 'update', JSON.stringify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }), Date.now());
      event.run(id, 'turn-end', JSON.stringify({ stopReason: 'end_turn' }), Date.now());
    }
  }
  db.close();
}

// Throttles the page and every service worker. A worker is its own target, so the page's own throttle does not slow
// what the worker fetches; it is reached through the browser session (Target.sendMessageToTarget, answered by events).
async function throttle(page, cacheOff) {
  const cdp = await page.context().newCDPSession(page);
  for (const [method, params] of [['Network.enable', {}], ['Network.emulateNetworkConditions', FAST3G], ['Network.setCacheDisabled', { cacheDisabled: cacheOff }]]) await cdp.send(method, params);
  const top = await page.context().browser().newBrowserCDPSession();
  const workers = (await top.send('Target.getTargets')).targetInfos.filter((target) => target.type === 'service_worker');
  let id = 0;
  for (const worker of workers) {
    const { sessionId } = await top.send('Target.attachToTarget', { targetId: worker.targetId, flatten: false });
    for (const [method, params] of [['Network.enable', {}], ['Network.emulateNetworkConditions', FAST3G], ['Network.setCacheDisabled', { cacheDisabled: cacheOff }]]) {
      const n = ++id, done = new Promise((resolve) => { const on = (event) => { if (JSON.parse(event.message).id === n) { top.off('Target.receivedMessageFromTarget', on); resolve(); } }; top.on('Target.receivedMessageFromTarget', on); });
      await top.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: n, method, params }) });
      await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
  }
  return { cdp, workers: workers.length };
}

// One open: a reload under the throttle, to the first chat screen. Bytes: what the page loaded and, apart, what the
// service worker fetched from the network for it (its own requests, which the page's entries do not show).
async function open(page, name, cacheOff) {
  const { workers } = await throttle(page, cacheOff);
  const fetched = [];
  const note = (request) => { if (request.serviceWorker()) fetched.push(request); };
  page.context().on('request', note);
  const started = Date.now();
  await page.reload({ timeout: 180000 });
  await page.waitForFunction(() => performance.getEntriesByName('p9-chat-painted').length, null, { timeout: 180000, polling: 200 });
  const wall = Date.now() - started;
  page.context().off('request', note);
  const sizes = await Promise.all(fetched.map(async (request) => (await request.sizes().catch(() => ({ responseBodySize: 0 }))).responseBodySize));
  const out = await page.evaluate(() => {
    const entries = performance.getEntriesByType('resource');
    return { painted: Math.round(performance.getEntriesByName('p9-chat-painted')[0].startTime),
      requests: entries.map((e) => { const url = new URL(e.name); return [url.pathname + url.search.slice(0, 60), Math.round(e.startTime), Math.round(e.duration), e.transferSize, e.encodedBodySize]; }) };
  });
  const astro = out.requests.filter(([name]) => name.startsWith('/_astro/'));
  const early = astro.filter((r) => r[1] < out.painted);
  const result = { name, cacheOff, workers, wall, painted: out.painted, astroFiles: early.length, astroBytes: early.reduce((sum, r) => sum + r[4], 0), astroBeforePaint: early.map((r) => r[0]),
    workerFetches: fetched.length, workerBytes: sizes.reduce((a, b) => a + b, 0), workerAstro: fetched.filter((r) => new URL(r.url()).pathname.startsWith('/_astro/')).length,
    api: out.requests.filter(([name]) => !name.startsWith('/_astro/')) };
  console.log('P9_TIME ' + name + ' ' + JSON.stringify(result));
  return result;
}

test('Phone open speed on Fast 3G: a reopen keeps the build, the terminal loads after the first screen, one chat is read first (A/B, numbers in the log)', { timeout: 600000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  seed(server);
  const { page, session } = await phone(t, server);
  await page.waitForFunction(() => performance.getEntriesByName('p9-chat-painted').length, null, { timeout: 30000 });
  // The worker is installed and running by now (phone() loads the page twice).
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 20000 });
  // Chat 3 is the one last shown, so the next open reads its events first.
  const third = '00000000-0000-4000-8000-000000000503';
  await page.click('[data-chat="' + third + '"]'); await page.waitForSelector('#events article', { timeout: 20000 });
  await page.click('[data-back]'); await page.waitForSelector('#chatList [data-chat]', { timeout: 10000 });
  const warm = await open(page, 'reopen-cache-on', false);
  const cold = await open(page, 'reopen-cache-off', true);
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT phone-speed-list ' + (await page.screenshot()).toString('base64'));
  const misses = [];
  // Item 1: with the browser's own cache gone, the worker still has the build (before: 10 files, 1.09 MB again).
  if (cold.workerAstro !== 0) misses.push('item 1: the worker downloaded ' + cold.workerAstro + ' build files on a reopen');
  // Item 2: the terminal's code is not loaded before the first chat screen.
  if (cold.astroBeforePaint.some((name) => /terminal[^/]*\.js$/i.test(name))) misses.push('item 2: the terminal loaded before the first screen: ' + cold.astroBeforePaint.join(' '));
  // Item 3: the first read names one chat, the one last shown; the others read theirs when opened.
  const reads = cold.api.filter(([name]) => name.startsWith('/chat/events?after=0&tail='));
  if (reads.length !== 1 || !reads[0][0].endsWith('only=' + third)) misses.push('item 3: the first reads were ' + JSON.stringify(reads.map((r) => r[0])));
  // Another chat still opens with its history, and the list shows every chat (state from GET /chat).
  assert.equal(await page.locator('#chatList [data-chat]').count(), 6);
  // Item 3: a chat whose events are not read yet still shows its last line (GET /chat preview), as a read one does.
  const lines = await page.locator('#chatList [data-chat] small').allTextContents();
  if (lines.some((text) => !/^A long answer line/.test(text))) misses.push('item 3: a row without its last line: ' + JSON.stringify(lines));
  await page.click('[data-chat="00000000-0000-4000-8000-000000000501"]');
  await page.waitForSelector('#events article[data-kind=agent]', { timeout: 60000 });
  await page.click('[data-back]'); await page.waitForSelector('#chatList [data-chat]', { timeout: 10000 });
  // The terminal loaded after the first screen, while the phone was idle, or loads now on the tap.
  await page.click('[data-nav="terminal"]');
  await page.waitForFunction(() => performance.getEntriesByType('resource').some((e) => /\/_astro\/[^/]*terminal[^/]*\.js/i.test(e.name)), null, { timeout: 60000 })
    .catch(() => misses.push('no terminal chunk was ever loaded (its name has no "terminal"?)'));
  // Loading terminal…: a fresh page with no worker and the terminal's file held, tapped at once.
  const context = await page.context().browser().newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
  t.after(() => context.close());
  await context.addCookies([{ name: 'p9s', value: session.token, url: server.origin, httpOnly: true, secure: true, sameSite: 'Strict' }]);
  await context.addInitScript(() => { Object.defineProperty(navigator, 'onLine', { get: () => true, configurable: true }); window.requestIdleCallback = () => 0; });
  const slow = await context.newPage();
  let release; const held = new Promise((resolve) => { release = resolve; });
  await slow.route(/\/_astro\/[^/]*terminal[^/]*\.js/i, async (route) => { await held; await route.continue(); });
  await slow.goto(server.origin + '/phone/');
  await slow.waitForFunction(() => performance.getEntriesByName('p9-chat-painted').length, null, { timeout: 30000 });
  await slow.click('[data-nav="terminal"]');
  await slow.waitForSelector('#termState:text("Loading terminal…")', { timeout: 10000 }).catch(() => misses.push('item 2: no Loading terminal… on a tap before it loaded'));
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT phone-speed-terminal-loading ' + (await slow.screenshot()).toString('base64'));
  release();
  await slow.waitForFunction(() => document.querySelector('#termState')?.textContent !== 'Loading terminal…', null, { timeout: 30000 });
  assert.deepEqual(misses, []);
});
