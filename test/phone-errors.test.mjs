// O128 (Builder, 2026-11-16: "Yes for the logs"): the phone sends its own uncaught errors to the daemon, which writes one
// P9_PHONE_ERROR line each to its journal (stderr). Threat model row O128. The real phone page through the real remote
// listener; the errors are raised in the page itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { remoteDaemon, passkeyDevice, enrollDevice } from './helpers.mjs';

async function signedInPage(browser, server, name) {
  const device = await passkeyDevice(browser, server, name);
  const session = await enrollDevice(server, device);
  await device.context.addCookies([{ name: 'p9s', value: session.token, url: server.origin, httpOnly: true, secure: true, sameSite: 'Strict' }]);
  await device.page.goto(server.origin + '/phone/');
  // The dev space has no network, so Chromium thinks it is offline: the CDP conditions set navigator.onLine (see phone.test).
  const cdp = await device.context.newCDPSession(device.page);
  const setOffline = async (offline) => {
    await device.context.setOffline(offline);
    await cdp.send('Network.emulateNetworkConditions', { offline, latency: 1, downloadThroughput: -1, uploadThroughput: -1 });
  };
  await setOffline(false);
  await device.page.evaluate((csrf) => sessionStorage.setItem('p9-csrf', csrf), session.csrf);
  await device.page.reload();
  return { ...device, session, setOffline };
}

test('O128: the phone sends the structure of its uncaught errors, rejections and failed loads to the journal, never their text; offline ones later; capped, authed, one line each', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t);
  let journal = '';
  server.child.stderr.on('data', (chunk) => { journal += chunk; });
  const lines = (device, match = () => true) => journal.split('\n').filter((line) => line.startsWith('P9_PHONE_ERROR '))
    .map((line) => JSON.parse(line.slice(15))).filter((line) => line.device === device && match(line));
  const until = async (check, what) => { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise((r) => setTimeout(r, 100)); } assert.fail(what + '\njournal: ' + journal.slice(-3000)); };
  const SECRET = /private draft words/;
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const phone = await signedInPage(browser, server, 'o128-phone');
  await phone.page.locator('body').waitFor();
  const device = phone.session.device;
  // A script of P9's own origin that throws, rejects with an Error and rejects with a plain string, each carrying
  // unquoted private text. The query keeps it off the service worker, so the test serves it.
  await phone.page.route('**/_astro/o128-throw.js?t=1', (route) => route.fulfill({ contentType: 'text/javascript', body: [
    "setTimeout(() => { throw new Error('o128 private draft words thrown'); });",
    "void Promise.reject(new Error('o128 private draft words rejected'));",
    "void Promise.reject('o128 private draft words plain');"].join('\n') }));

  // 1. A thrown error, two rejections and a script that fails to load: one line each, structure only.
  await phone.page.evaluate(() => {
    for (const src of ['/_astro/o128-throw.js?t=1', '/_astro/o128-missing.js']) { const script = document.createElement('script'); script.src = src; document.head.append(script); }
  });
  const thrownOf = (l) => l.kind === 'error' && l.name === 'Error', rejectedOf = (l) => l.kind === 'rejection' && l.name === 'Error';
  const plainOf = (l) => l.kind === 'rejection' && l.name === 'string', missingOf = (l) => l.kind === 'load' && l.file === '/_astro/o128-missing.js';
  await until(() => [thrownOf, rejectedOf, plainOf, missingOf].every((f) => lines(device, f).length), 'four lines');
  const [thrown, rejected, plain, missing] = [thrownOf, rejectedOf, plainOf, missingOf].map((f) => lines(device, f)[0]);
  const info = JSON.stringify({ thrown, rejected, plain, missing });
  for (const line of [thrown, rejected, plain, missing]) {
    assert.deepEqual(Object.keys(line).sort(), ['app', 'device', 'file', 'frames', 'kind', 'name', 'page', 'sw'], 'no text field ' + info);
    assert.equal(line.page, '/phone/', info);
    assert.match(line.app, /\.js$/, 'the app build: its own file name ' + info);
    assert.ok(Array.isArray(line.frames) && line.frames.length <= 5, info);
  }
  for (const line of [thrown, rejected]) assert.match(line.frames[0] ?? '', /^\/_astro\/o128-throw\.js:\d+:\d+$/, 'the throwing frame, path and position ' + info);
  assert.deepEqual(plain.frames, [], 'a plain value has no stack ' + info);
  assert.equal(lines(device).length, 4, 'one line each');
  assert.doesNotMatch(journal, SECRET, 'no message text in the journal');

  // 1b. The service worker's own failure, raised inside the worker through its tell(): the page reports it as kind sw,
  // structure only.
  const worker = phone.context.serviceWorkers()[0] ?? await phone.context.waitForEvent('serviceworker', { timeout: 20000 });
  await phone.page.evaluate(() => navigator.serviceWorker.ready);
  await worker.evaluate(() => { const e = new TypeError('o128 private draft words sw'); tell(e); });
  await until(() => lines(device, (l) => l.kind === 'sw').length === 1, 'the service worker line');
  const swLine = lines(device, (l) => l.kind === 'sw')[0];
  assert.equal(swLine.name, 'TypeError', JSON.stringify(swLine));
  assert.match(swLine.sw, /\.js$/, 'the worker build ' + JSON.stringify(swLine));
  assert.doesNotMatch(journal, SECRET, 'no worker message text in the journal');

  // 2. Offline: the report waits on the phone as structure only, then goes once it is back online.
  await phone.setOffline(true);
  await phone.page.evaluate(() => { setTimeout(() => { const e = new Error('o128 private draft words offline'); e.name = 'OfflineCheck'; throw e; }); });
  await phone.page.waitForTimeout(1500);
  const offlineOf = (l) => l.name === 'OfflineCheck';
  assert.equal(lines(device, offlineOf).length, 0, 'not sent while offline');
  const stored = await phone.page.evaluate(() => localStorage.getItem('p9-phone-errors') ?? '');
  assert.match(stored, /OfflineCheck/, 'kept on the phone');
  assert.doesNotMatch(stored, SECRET, 'the stored report has no message text');
  // The first send after reconnecting gets no answer (the network is not back yet at that instant: here the context is
  // online one step before the CDP conditions are): the phone keeps the report and tries again by itself.
  let refused = 0;
  await phone.context.route('**/phone-error', (route) => (refused++ ? route.fallback() : route.abort('internetdisconnected')));
  await phone.setOffline(false);
  await until(() => lines(device, offlineOf).length === 1, 'the offline report after reconnecting');
  assert.ok(refused >= 2, 'the first send after reconnecting failed, a later one went: ' + refused);
  await phone.page.waitForTimeout(500);
  assert.equal(lines(device, offlineOf).length, 1, 'sent once');
  assert.doesNotMatch(await phone.page.evaluate(() => localStorage.getItem('p9-phone-errors') ?? ''), /OfflineCheck/, 'cleared once sent');
  await phone.context.unroute('**/phone-error');

  // 3. The route itself (a second device, so its minute starts clean).
  const other = await signedInPage(browser, server, 'o128-other');
  const post = (body, session = other.session) => server.remote('/phone-error', { method: 'POST', session, body });
  // No session, and a wrong CSRF token, write nothing.
  const anon = await server.remote('/phone-error', { method: 'POST', body: { kind: 'error', name: 'AnonCheck' } });
  assert.equal(anon.status, 401, anon.text);
  const forged = await post({ kind: 'error', name: 'ForgedCheck' }, { token: other.session.token, csrf: 'x'.repeat(43) });
  assert.equal(forged.status, 403, forged.text);
  // A body over 4 KB is refused.
  const big = await post({ kind: 'error', name: 'BigCheck', pad: 'x'.repeat(5000) });
  assert.equal(big.status, 413, big.text);
  // A hand-made report: text fields, a name with ESC and a newline, a quoted page, foreign and wordy frames. Only fields
  // matching their pattern are written; the rest is dropped, so nothing of the text reaches the journal.
  const frames = ['/a.js:1:2', 'http://elsewhere/x.js:1:2', '/b private draft words:1:2', '/c.js:3', ...Array.from({ length: 7 }, (_, i) => `/d${i}.js:${i}:1`)];
  const odd = await post({ kind: 'odd', name: 'Bad\u001b[31m\nP9_READY', message: 'o128 private draft words', stack: 'Error: private draft words',
    page: '/phone/"private draft words"', file: '/x.js\nP9_READY', app: 'a b', sw: 'v1', frames });
  assert.equal(odd.status, 204, odd.text);
  const [oddLine] = lines(other.session.device);
  assert.deepEqual(oddLine, { device: other.session.device, kind: 'error', name: 'other', page: '', file: '', app: '', sw: 'v1',
    frames: ['/a.js:1:2', '/d0.js:0:1', '/d1.js:1:1', '/d2.js:2:1', '/d3.js:3:1'] }, JSON.stringify(oddLine));
  assert.ok(!journal.split('\n').some((line) => line.startsWith('P9_READY') && journal.indexOf(line) > journal.indexOf(other.session.device)), 'no forged line');
  // 12 quick reports: 10 lines in the minute (the odd one counted), then one dropped line and 429s.
  const statuses = [];
  for (let i = 0; i < 12; i++) statuses.push((await post({ kind: 'error', name: 'BurstCheck' })).status);
  assert.equal(lines(other.session.device, (l) => l.name === 'BurstCheck').length, 9, 'with the odd line, 10 lines in the minute ' + JSON.stringify(statuses));
  assert.equal(statuses.filter((s) => s === 429).length, 3, JSON.stringify(statuses));
  assert.equal(journal.split('\n').filter((line) => line.startsWith('P9_PHONE_ERRORS_DROPPED ') && line.includes(other.session.device)).length, 1, 'one dropped line');
  assert.ok(!/AnonCheck|ForgedCheck|BigCheck/.test(journal), 'refused reports wrote nothing');
  assert.doesNotMatch(journal, SECRET, 'no message text anywhere in the journal');
  console.log('PASS O128 phone errors: 4 kinds plus a service worker failure as structure only, no text stored or sent, offline later, 401/403/413, patterns enforced, 10 a minute');
});
