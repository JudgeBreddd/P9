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
  const result = { name, cacheOff, workers, wall, painted: out.painted, astroFiles: astro.length, astroBytes: astro.reduce((sum, r) => sum + r[4], 0),
    workerFetches: fetched.length, workerBytes: sizes.reduce((a, b) => a + b, 0), workerAstro: fetched.filter((r) => new URL(r.url()).pathname.startsWith('/_astro/')).length,
    api: out.requests.filter(([name]) => !name.startsWith('/_astro/')) };
  console.log('P9_TIME ' + name + ' ' + JSON.stringify(result));
  return result;
}

test('Phone open speed on Fast 3G: first open, then reopens with the browser cache on and off (numbers in the log)', { timeout: 600000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  seed(server);
  const { page } = await phone(t, server);
  await page.waitForFunction(() => performance.getEntriesByName('p9-chat-painted').length, null, { timeout: 30000 });
  // The worker is installed and running by now (phone() loads the page twice).
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 20000 });
  const warm = await open(page, 'reopen-cache-on', false);
  const cold = await open(page, 'reopen-cache-off', true);
  assert.ok(warm.painted > 0 && cold.painted > 0);
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT phone-speed ' + (await page.screenshot()).toString('base64'));
});
