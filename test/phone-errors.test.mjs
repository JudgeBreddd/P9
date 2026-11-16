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

test('O128: the phone sends its uncaught errors, rejections and failed loads to the journal, offline ones later; capped, authed, one line each', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t);
  let journal = '';
  server.child.stderr.on('data', (chunk) => { journal += chunk; });
  const lines = (word) => journal.split('\n').filter((line) => line.startsWith('P9_PHONE_ERROR ') && line.includes(word)).map((line) => JSON.parse(line.slice(15)));
  const until = async (check, what) => { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise((r) => setTimeout(r, 100)); } assert.fail(what + '\njournal: ' + journal.slice(-3000)); };
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const phone = await signedInPage(browser, server, 'o128-phone');
  await phone.page.locator('body').waitFor();

  // 1. A thrown error, a rejected promise and a script that fails to load: one line each.
  await phone.page.evaluate(() => {
    setTimeout(() => { throw new Error('o128-thrown'); });
    void Promise.reject(new Error('o128-rejected'));
    const script = document.createElement('script'); script.src = '/_astro/o128-missing.js'; document.head.append(script);
  });
  await until(() => lines('o128-thrown').length && lines('o128-rejected').length && lines('o128-missing').length, 'three lines');
  const [thrown, rejected, missing] = [lines('o128-thrown')[0], lines('o128-rejected')[0], lines('o128-missing')[0]];
  const info = JSON.stringify({ thrown, rejected, missing });
  assert.deepEqual([thrown.kind, rejected.kind, missing.kind], ['error', 'rejection', 'load'], info);
  for (const line of [thrown, rejected, missing]) {
    assert.equal(line.page, '/phone/', info);
    assert.match(line.app, /\.js$/, 'the app build: its own file name ' + info);
    assert.equal(typeof line.sw, 'string', info);
    assert.ok(Array.isArray(line.stack) && line.stack.length <= 5, info);
    assert.equal(line.device, phone.session.device, info);
  }
  assert.ok(thrown.stack.length > 0 && rejected.stack.length > 0, 'stack lines kept ' + info);
  assert.equal(lines('o128-thrown').length + lines('o128-rejected').length + lines('o128-missing').length, 3, 'one line each');

  // 2. Offline: the report waits on the phone, then goes once it is back online.
  await phone.setOffline(true);
  await phone.page.evaluate(() => { setTimeout(() => { throw new Error('o128-offline'); }); });
  await phone.page.waitForTimeout(1500);
  assert.equal(lines('o128-offline').length, 0, 'not sent while offline');
  assert.match(await phone.page.evaluate(() => localStorage.getItem('p9-phone-errors') ?? ''), /o128-offline/, 'kept on the phone');
  await phone.setOffline(false);
  await until(() => lines('o128-offline').length === 1, 'the offline report after reconnecting');
  await phone.page.waitForTimeout(500);
  assert.equal(lines('o128-offline').length, 1, 'sent once');
  assert.doesNotMatch(await phone.page.evaluate(() => localStorage.getItem('p9-phone-errors') ?? ''), /o128-offline/, 'cleared once sent');

  // 3. The route itself (a second device, so its minute starts clean).
  const other = await signedInPage(browser, server, 'o128-other');
  const post = (body, session = other.session) => server.remote('/phone-error', { method: 'POST', session, body });
  // No session, and a wrong CSRF token, write nothing.
  const anon = await server.remote('/phone-error', { method: 'POST', body: { kind: 'error', message: 'o128-anon' } });
  assert.equal(anon.status, 401, anon.text);
  const forged = await post({ kind: 'error', message: 'o128-forged' }, { token: other.session.token, csrf: 'x'.repeat(43) });
  assert.equal(forged.status, 403, forged.text);
  // A body over 4 KB is refused.
  const big = await post({ kind: 'error', message: 'o128-big ' + 'x'.repeat(5000) });
  assert.equal(big.status, 413, big.text);
  // Quotes (a JSON parse message quotes its input, which may be chat text), a newline and ESC: one line, neither kept.
  const odd = await post({ kind: 'error', message: 'o128-odd Unexpected token, "secret chat words" is not valid JSON \'more words\'\n\u001b[31mP9_READY', stack: 'a\nb\nc\nd\ne\nf\ng' });
  assert.equal(odd.status, 204, odd.text);
  const oddLine = journal.split('\n').find((line) => line.includes('o128-odd')) ?? '';
  assert.ok(oddLine.startsWith('P9_PHONE_ERROR '), oddLine);
  assert.doesNotMatch(oddLine, /secret chat words|more words|\\u001b|\\n/, oddLine);
  assert.ok(!journal.split('\n').some((line) => line.startsWith('[31mP9_READY') || line === 'P9_READY' && journal.indexOf(line) > journal.indexOf('o128-odd')), 'no forged line');
  assert.equal(JSON.parse(oddLine.slice(15)).stack.length, 5, 'first 5 stack lines');
  // 12 quick reports: 10 lines in the minute (the odd one counted), then one dropped line and 429s.
  const statuses = [];
  for (let i = 0; i < 12; i++) statuses.push((await post({ kind: 'error', message: 'o128-burst ' + i })).status);
  assert.equal(lines('o128-burst').length, 9, 'with the odd line, 10 lines in the minute ' + JSON.stringify(statuses));
  assert.equal(statuses.filter((s) => s === 429).length, 3, JSON.stringify(statuses));
  assert.equal(journal.split('\n').filter((line) => line.startsWith('P9_PHONE_ERRORS_DROPPED ') && line.includes(other.session.device)).length, 1, 'one dropped line');
  assert.ok(!/o128-anon|o128-forged|o128-big/.test(journal), 'refused reports wrote nothing');
  console.log('PASS O128 phone errors: 3 kinds, offline later, 401/403/413, quotes and control characters cut, 10 a minute');
});
