// Mission M5 custom cards (threat model row M5): a space file's HTML in the chat-artifact frame, fed one script's JSON.
// Server: the file is read inside the workspace only, the script runs under the data tile rules, any JSON comes back.
// Screen: a probe card tries the network, P9 and the top window and gets none of them; the JSON arrives; a bad script
// and a card that throws show their error on the card. Desktop 1280 in a dark and a light theme, the phone at 390x844.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, symlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium, _electron } from '@playwright/test';
import { daemon, http, authenticated, remoteDaemon, passkeyDevice, enrollDevice, root, versionSeen } from './helpers.mjs';

const node = process.execPath;
const print = (value) => [node, '-e', `process.stdout.write(${JSON.stringify(JSON.stringify(value))})`];
const SCRIPTS = [
  { id: 'nums', title: 'Numbers', cmd: print({ count: 12, label: '<b>not markup</b>' }) },
  { id: 'oops', title: 'Broken', cmd: [node, '-e', 'process.stdout.write("oops, not JSON")'] },
];
const SETTINGS = { primary: 'projects/AGENTS.md', registry: 'hub/registry.json', waiting: '_waiting', space: 'hub/space.json' };
const CARD = `<!doctype html><style>body{font:14px system-ui;margin:0;padding:4px 0;color:CanvasText}b{font-size:28px}</style>
<p><b id="count">…</b> notes in the inbox</p><p id="label"></p>
<script>addEventListener('p9data', (e) => { document.getElementById('count').textContent = e.detail.count; document.getElementById('label').textContent = e.detail.label; });</script>`;
// Everything a card should not reach. Each attempt writes what happened into #out; p9data is written into #data.
const probe = (port) => `<!doctype html><style>body{font:12px ui-monospace,monospace;margin:0;color:CanvasText;white-space:pre-wrap}
.bg{background:url(http://127.0.0.1:${port}/bg.png)}</style><link rel="stylesheet" href="http://127.0.0.1:${port}/x.css">
<div class="bg" id="data">no data yet</div><pre id="out"></pre><script>
const out = {}, v = [];
document.addEventListener('securitypolicyviolation', e => v.push(e.effectiveDirective));
const put = (k, val) => { out[k] = val; document.getElementById('out').textContent = JSON.stringify({ out, v }); };
const tryit = async (k, f) => { try { put(k, 'ok:' + await f()); } catch (e) { put(k, 'blocked:' + e.name); } };
tryit('origin', () => self.origin);
tryit('parentDocument', () => parent.document.title);
tryit('parentP9', () => typeof parent.p9);
tryit('windowP9', () => typeof window.p9);
tryit('top', () => { top.location = 'https://example.com/'; return 'set'; });
tryit('fetchLocal', () => fetch('http://127.0.0.1:${port}/x').then(r => r.status));
const img = new Image(); img.onload = () => put('img', 'ok:loaded'); img.onerror = () => put('img', 'blocked:error'); img.src = 'http://127.0.0.1:${port}/i.png';
addEventListener('p9data', e => { document.getElementById('data').textContent = 'data:' + JSON.stringify(e.detail); });
setTimeout(() => put('done', true), 1500);
</script>`;
const space = (extra = []) => ({ sections: [{ id: 'home', title: 'Home', text: 'Custom cards.', cards: [
  { id: 'inbox', title: 'Inbox', html: 'cards/inbox.html', script: 'nums' },
  { id: 'probe', title: 'Probe', html: 'cards/probe.html', script: 'nums' },
  { id: 'broken', title: 'Broken script', html: 'cards/inbox.html', script: 'oops' },
  { id: 'throws', title: 'Throws', html: 'cards/throws.html', script: 'nums' },
  ...extra] }] });

async function files(paths, port, extra) {
  const w = paths.workspace;
  for (const folder of ['hub', 'cards', 'projects/event-horizon', '_waiting']) await mkdir(path.join(w, folder), { recursive: true });
  await writeFile(path.join(w, SETTINGS.registry), JSON.stringify({ scripts: SCRIPTS, apps: [], pages: [] }));
  await writeFile(path.join(w, SETTINGS.primary), '# Projects\n\n**Main project: P9 — Event Horizon** (`event-horizon/`)\n');
  await writeFile(path.join(w, 'projects/event-horizon/AGENTS.md'), '# P9\n\n**Status:** **Open**\n');
  await writeFile(path.join(w, 'cards/inbox.html'), CARD);
  await writeFile(path.join(w, 'cards/probe.html'), probe(port));
  await writeFile(path.join(w, 'cards/throws.html'), '<!doctype html><p>Before the error</p><script>throw new Error("card boom")</script>');
  await writeFile(path.join(w, SETTINGS.space), JSON.stringify(space(extra)));
  await writeFile(path.join(paths.directory, 'settings.json'), JSON.stringify(SETTINGS));
  return { args: ['--settings', path.join(paths.directory, 'settings.json')] };
}
const call = async (instance, route, method = 'GET', body) => {
  const result = await http({ socketPath: instance.credentials.socketPath, route, method, timeout: 30000,
    headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: result.status, body: JSON.parse(result.text) };
};
const shot = (name, png) => { if (process.env.CI !== 'true') console.log('P9_SHOT ' + name + ' ' + png.toString('base64')); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('M5 cards (server): the HTML file is read inside the workspace only; the script waits for Allow and returns any JSON', { timeout: 60000 }, async (t) => {
  const extra = [{ id: 'outside', title: 'Outside', html: '../secret.html', script: 'nums' }, { id: 'notes', title: 'Not html', html: 'cards/a.md', script: 'nums' },
    { id: 'gone', title: 'Gone', html: 'cards/none.html', script: 'nums' }, { id: 'linked', title: 'Linked', html: 'cards/link.html', script: 'nums' }];
  const instance = await daemon(t, undefined, false, async (paths) => {
    const result = await files(paths, 9, extra);
    await writeFile(path.join(paths.directory, 'secret.html'), '<p>outside the workspace</p>');
    await symlink(path.join(paths.directory, 'secret.html'), path.join(paths.workspace, 'cards/link.html'));
    return result;
  });
  const overview = (await call(instance, '/mission')).body;
  const home = overview.space.find((section) => section.id === 'home');
  assert.deepEqual(home.cards.map((c) => c.id), ['inbox', 'probe', 'broken', 'throws', 'gone', 'linked'], 'a card with .. or a non-.html file is dropped');
  assert.ok(overview.invalid.some((x) => x.cards !== undefined && x.reason === 'malformed-record'), JSON.stringify(overview.invalid));

  const card = await call(instance, '/mission/card?id=inbox');
  assert.deepEqual([card.status, card.body.html], [200, CARD]);
  assert.equal((await call(instance, '/mission/card?id=gone')).body.error, 'not-found');
  const linked = await call(instance, '/mission/card?id=linked');
  assert.ok(linked.status !== 200 && !JSON.stringify(linked.body).includes('outside the workspace'), 'a symlink out of the workspace is not read: ' + JSON.stringify(linked));
  assert.equal((await call(instance, '/mission/card?id=nope')).status, 404);

  const first = await call(instance, '/mission/data?id=inbox');
  assert.deepEqual([first.status, first.body.error], [409, 'allow-required'], 'the card\'s script waits for Allow');
  assert.equal((await call(instance, '/mission/data/allow', 'POST', { id: 'inbox' })).status, 200);
  assert.deepEqual((await call(instance, '/mission/data?id=inbox')).body, { json: { count: 12, label: '<b>not markup</b>' } }, 'any JSON, not a tile shape');
  await call(instance, '/mission/data/allow', 'POST', { id: 'broken' });
  assert.deepEqual((await call(instance, '/mission/data?id=broken')).body, { why: 'printed something that is not JSON', printed: 'oops, not JSON' });
});

test('M5 cards (screen): the sandbox holds, the JSON arrives, errors show on the card; desktop and phone', { timeout: 180000 }, async (t) => {
  let hits = 0; const other = createServer((_q, s) => { hits++; s.end('ok'); }); await new Promise((r) => other.listen(0, '127.0.0.1', r)); t.after(() => other.close());
  const port = other.address().port;
  const server = await remoteDaemon(t, { setup: (paths) => files(paths, port) });
  for (const id of ['inbox', 'probe', 'broken', 'throws']) assert.equal((await server.desk('/mission/data/allow', 'POST', { id })).status, 200);

  const profile = path.join(server.directory, 'electron-profile');
  await mkdir(profile); await versionSeen(profile);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', server.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.click('#rMission');
  for (const theme of ['event-horizon-prime', 'daylight']) {
    await page.click('#themeBtn'); await page.click('[data-theme-pick="' + theme + '"]'); await page.keyboard.press('Escape');
    await page.click('#fMission [data-group="Home"]');
    const card = (id) => page.locator(`#mdlBody [data-card][data-tile="${id}"]`);
    const inbox = card('inbox').frameLocator('iframe');
    await inbox.locator('#count', { hasText: '12' }).waitFor({ timeout: 20000 });
    assert.equal(await inbox.locator('#label').textContent(), '<b>not markup</b>', 'the JSON arrived as data: markup in it stays text');
    assert.equal(await inbox.locator('#label b').count(), 0);
    await card('broken').locator('.card-note', { hasText: 'printed something that is not JSON' }).waitFor({ timeout: 15000 });
    assert.match(await card('broken').locator('.card-note').innerText(), /oops, not JSON/, 'a bad script shows its error on the card');
    await card('throws').locator('.card-note', { hasText: 'card boom' }).waitFor({ timeout: 15000 });
    assert.equal(await page.locator('#mdlT').innerText(), 'Home · 4 items', 'the title counts cards');
    const left = async (sel) => (await page.locator(sel).first().boundingBox()).x;
    assert.ok(Math.abs(await left('#mdlBody [data-space-text]') - await left('#mdlBody [data-card] h3')) <= 2, 'the section text lines up with the cards, not on the window edge');

    let r = null;
    const pr = card('probe').frameLocator('iframe');
    for (const end = Date.now() + 15000; Date.now() < end && !(r?.out.done && r.data); await sleep(200)) {
      r = JSON.parse(await pr.locator('#out').textContent().catch(() => '{}') || '{}');
      if (r.out) r.data = await pr.locator('#data').textContent().catch(() => '');
      if (r.data && !r.data.startsWith('data:')) r.data = '';
    }
    assert.ok(r?.out?.done && r.data, 'the probe finished and got its data: ' + JSON.stringify(r));
    const o = r.out;
    assert.equal(o.origin, 'ok:null', 'sandboxed without allow-same-origin: an opaque origin');
    assert.match(o.parentDocument, /^blocked:SecurityError/, 'parent.document');
    assert.match(o.parentP9, /^blocked:SecurityError/, 'parent.p9');
    assert.equal(o.windowP9, 'ok:undefined', 'window.p9 inside the card');
    assert.match(o.top, /^blocked:/, 'top.location =');
    assert.match(o.fetchLocal, /^blocked:TypeError/, 'fetch');
    assert.equal(o.img, 'blocked:error', 'an <img> from the network');
    assert.ok(['connect-src', 'img-src', 'style-src-elem'].every((d) => r.v.includes(d)), 'the frame CSP refused fetch, images and CSS: ' + r.v.join(', '));
    assert.equal(hits, 0, 'nothing reached the network server');
    assert.equal(page.url(), 'p9://app/', 'the shell is still P9');
    await card('inbox').scrollIntoViewIfNeeded();
    shot('m5-desktop-1280-' + theme, await page.screenshot());
    await page.keyboard.press('Escape');
    await page.locator('#mdl[open]').waitFor({ state: 'detached', timeout: 5000 });
  }

  const browser = await chromium.launch();
  t.after(() => browser.close());
  const device = await passkeyDevice(browser, server, 'phone-m5');
  const session = await enrollDevice(server, device);
  await device.context.addCookies([{ name: 'p9s', value: session.token, url: server.origin, httpOnly: true, secure: true, sameSite: 'Strict' }]);
  await device.context.addInitScript(() => Object.defineProperty(Navigator.prototype, 'onLine', { get: () => true }));
  const phone = device.page;
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(server.origin + '/phone/');
  await phone.evaluate((csrf) => sessionStorage.setItem('p9-csrf', csrf), session.csrf);
  await phone.reload();
  await phone.click('[data-nav="mission"]');
  await phone.click('#mission [data-open]:has-text("Home")', { timeout: 15000 });
  for (const title of ['Inbox', 'Probe', 'Broken script', 'Throws']) await phone.click(`#mission dialog[open] summary:has-text("${title}")`);
  const pinbox = phone.locator('#mission dialog[open] [data-tile="inbox"]');
  await pinbox.frameLocator('iframe').locator('#count', { hasText: '12' }).waitFor({ timeout: 20000 });
  await phone.locator('#mission dialog[open] [data-tile="broken"] .card-note', { hasText: 'not JSON' }).waitFor({ timeout: 15000 });
  await phone.locator('#mission dialog[open] [data-tile="throws"] .card-note', { hasText: 'card boom' }).waitFor({ timeout: 15000 });
  await phone.locator('#mission dialog[open] [data-tile="throws"] .card-note').scrollIntoViewIfNeeded();
  shot('m5-phone', await phone.screenshot());
  assert.equal(hits, 0, 'nothing reached the network server from the phone either');
});
