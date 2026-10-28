import test from 'node:test';
import assert from 'node:assert/strict';
import { remoteDaemon } from './helpers.mjs';
import { phone } from './phone-c16-helpers.mjs';

// P1: where the phone's load time goes, on a good mobile link (20 Mbit/s down, 50 ms each way) and a 4x slower CPU:
// a first load on a new phone, a load after login, a reload, a new login, and each tab. Every request counts, the
// service worker's own included (the context sees those). Logged as P1 lines; the asserts are the fix's.
test('P1: the phone reads its app files once; a reload or a new login reads none again', { timeout: 180000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  const { page: setup, session } = await phone(t, server);
  const context = await setup.context().browser().newContext({ viewport: { width: 390, height: 844 } });
  t.after(() => context.close());
  await context.addCookies([{ name: 'p9s', value: session.token, url: server.origin, httpOnly: true, secure: true, sameSite: 'Strict' }]);
  await context.addInitScript((csrf) => { sessionStorage.setItem('p9-csrf', csrf); Object.defineProperty(navigator, 'onLine', { get: () => true, configurable: true }); }, session.csrf);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 50, downloadThroughput: 2.5e6, uploadThroughput: 1e6 });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  let seen = [];
  context.on('requestfinished', async (request) => {
    const sizes = await request.sizes().catch(() => null), response = await request.response().catch(() => null);
    seen.push({ url: new URL(request.url()).pathname, sw: Boolean(request.serviceWorker()), status: response?.status() ?? 0, kb: Math.round(Math.max(0, sizes?.responseBodySize ?? 0) / 102.4) / 10 }); // a cache hit says -1
  });
  const app = (rows) => rows.filter((r) => r.url.startsWith('/_astro/') && r.status === 200 && (r.sw || !rows.some((o) => o.sw && o.url === r.url)));
  const load = async (name, go) => {
    seen = [];
    const start = Date.now();
    await go();
    await page.locator('nav [data-nav="chat"]').waitFor();
    const ready = Date.now() - start;
    await page.waitForTimeout(3000); // the phone keeps a live connection open: networkidle never comes
    const files = app(seen);
    const out = { name, ready, requests: seen.length, kb: Math.round(seen.reduce((s, r) => s + r.kb, 0)), appFiles: files.length, appKb: Math.round(files.reduce((s, r) => s + r.kb, 0)) };
    console.log('P1 ' + JSON.stringify(out));
    console.log('P1 files ' + name + ' ' + JSON.stringify([...seen].sort((a, b) => b.kb - a.kb).slice(0, 8)));
    return out;
  };
  const first = await load('first-ever', () => page.goto(server.origin + '/phone/'));
  const loaded = await load('next-open', () => page.goto(server.origin + '/phone/'));
  const again = await load('reload', () => page.reload());
  for (const tab of ['terminal', 'mission', 'usage', 'files', 'chat']) {
    seen = [];
    const start = Date.now();
    await page.locator(`nav [data-nav="${tab}"]`).click();
    await page.waitForTimeout(1500);
    console.log('P1 tab ' + JSON.stringify({ tab, ms: Date.now() - start, requests: seen.length, kb: Math.round(seen.reduce((s, r) => s + r.kb, 0)), paths: seen.map((r) => r.url) }));
  }
  const relogin = await load('new-login', async () => { await page.goto(server.origin + '/login'); await page.goto(server.origin + '/phone/'); });
  assert.ok(first.appKb > 100, 'the first load reads the app');
  for (const later of [loaded, again, relogin]) assert.equal(later.appKb, 0, later.name + ' reads no app file again');
});
