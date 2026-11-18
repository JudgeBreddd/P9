// Mission M5 custom cards (threat model row M5): a space file's HTML in the chat-artifact frame, fed one script's JSON.
// Server: the file is read inside the workspace only, the script runs under the data tile rules, any JSON comes back.
// Screen: a probe card tries the network, P9 and the top window and gets none of them; the JSON arrives; a bad script
// and a card that throws show their error on the card. Desktop 1280 in a dark and a light theme, the phone at 390x844.
// Wall 4: a card's feeder script and its title-bar buttons are not rows; the buttons sit in the card's title bar.
// Wall 15: a card opens one of its folder's files in P9's text viewer on a click; a call with no click, or a file outside
// the folder, opens nothing. Wall 6: the folder's fix text puts Fix with Claude on the viewer; it starts a Claude chat
// with that text and the file, read again by the daemon.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, symlink, mkdtemp, unlink, utimes } from 'node:fs/promises';
import os from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium, _electron } from '@playwright/test';
import { daemon, http, authenticated, remoteDaemon, passkeyDevice, enrollDevice, root, versionSeen } from './helpers.mjs';

const node = process.execPath;
const print = (value) => [node, '-e', `process.stdout.write(${JSON.stringify(JSON.stringify(value))})`];
const SCRIPTS = [
  // hub/nums.json, when the test writes it, is a changed answer from the same allowed script (O45).
  { id: 'nums', title: 'Numbers', cmd: [node, '-e', `const f = require('fs'), n = 'hub/nums.json'; process.stdout.write(f.existsSync(n) ? f.readFileSync(n, 'utf8') : ${JSON.stringify(JSON.stringify({ count: 12, label: '<b>not markup</b>' }))})`] },
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
const space = (extra = []) => ({ sections: [{ id: 'home', title: 'Home', text: 'Custom cards.', buttons: [
  { id: 'homefeed', title: 'Home feed', cmd: print({ count: 3 }) }, { id: 'hello', title: 'Say hi', cmd: print('hi') },
  { id: 'ship', title: 'Ship it', cmd: print('shipped'), confirm: true }, { id: 'plain', title: 'Plain row', cmd: print('plain') }], cards: [
  { id: 'inbox', title: 'Inbox', html: 'cards/inbox.html', script: 'nums', buttons: ['hello', 'ship', 'ghost'] },
  { id: 'probe', title: 'Probe', html: 'cards/probe.html', script: 'nums' },
  { id: 'broken', title: 'Broken script', html: 'cards/inbox.html', script: 'oops' },
  { id: 'throws', title: 'Throws', html: 'cards/throws.html', script: 'nums' },
  { id: 'tall', title: 'Tall', html: 'cards/tall.html', script: 'homefeed' },
  { id: 'logs', title: 'Logs', html: 'cards/logs.html', script: 'nums', folder: { path: 'logs', pattern: '*.log', fix: 'Find why this log failed.' } },
  ...extra] }] });

async function files(paths, port, extra) {
  const w = paths.workspace;
  for (const folder of ['hub', 'cards', 'projects/event-horizon', '_waiting']) await mkdir(path.join(w, folder), { recursive: true });
  await writeFile(path.join(w, SETTINGS.registry), JSON.stringify({ scripts: SCRIPTS, apps: [], pages: [] }));
  await writeFile(path.join(w, SETTINGS.primary), '# Projects\n\n**Main project: P9 — Event Horizon** (`event-horizon/`)\n');
  await writeFile(path.join(w, 'projects/event-horizon/AGENTS.md'), '# P9\n\n**Status:** **Open**\n');
  await writeFile(path.join(w, 'cards/inbox.html'), CARD);
  await writeFile(path.join(w, 'cards/probe.html'), probe(port));
  await mkdir(path.join(w, 'logs'), { recursive: true });
  await writeFile(path.join(w, 'logs/a.log'), 'line one of a.log\nthe whole log, not its last lines\n');
  await writeFile(path.join(w, 'logs/b.txt'), 'not a log');
  await writeFile(path.join(w, 'cards/logs.html'), '<!doctype html><script>p9open("logs/a.log")</script><button id="a" onclick="p9open(\'logs/a.log\')">a.log</button>'
    + '<button id="b" onclick="p9open(\'logs/b.txt\')">b.txt</button><script>document.body.dataset.ready = 1</script>');
  await writeFile(path.join(w, 'cards/tall.html'), '<!doctype html><style>body{margin:0}</style><div style="height:480px">Tall</div>');
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
// O129 instrumentation, not a fix. On CI, Playwright's protocol log (pw:protocol) is kept in memory while an M5 card click runs, and
// its last 200 lines are printed when that click does not finish, so the next hang shows which wait it sits in. It uses
// playwright-core's own `debug` (the one its logger writes through), switched on only for the click; DEBUG is put back so no child
// process inherits it.
const pwDebug = process.env.CI === 'true' ? createRequire(createRequire(createRequire(import.meta.url).resolve('@playwright/test')).resolve('playwright'))('playwright-core/lib/utilsBundle').debug : null;
const pwLog = [], pwWas = {};
const protocolLog = (on) => {
  if (!pwDebug || !on === !pwWas.on) return;
  const env = process.env.DEBUG;
  if (on) {
    pwLog.length = 0; Object.assign(pwWas, { on: true, log: pwDebug.log, names: pwDebug.disable() });
    pwDebug.log = (...a) => { pwLog.push(a.join(' ').slice(0, 500)); if (pwLog.length > 1000) pwLog.splice(0, 500); };
    pwDebug.enable([pwWas.names, 'pw:protocol'].filter(Boolean).join(','));
  } else { pwDebug.enable(pwWas.names); pwDebug.log = pwWas.log; pwWas.on = false; }
  if (env === undefined) delete process.env.DEBUG; else process.env.DEBUG = env;
};
const shot = (name, png) => { if (process.env.CI !== 'true') console.log('P9_SHOT ' + name + ' ' + png.toString('base64')); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('M5 cards (server): the HTML file is read inside the workspace only; the script waits for Allow and returns any JSON', { timeout: 60000 }, async (t) => {
  const extra = [{ id: 'outside', title: 'Outside', html: '../secret.html', script: 'nums' }, { id: 'notes', title: 'Not html', html: 'cards/a.md', script: 'nums' },
    { id: 'gone', title: 'Gone', html: 'cards/none.html', script: 'nums' }, { id: 'linked', title: 'Linked', html: 'cards/link.html', script: 'nums' },
    { id: 'priv', title: 'Private', html: '_' + 'private/card.html', script: 'nums' }];
  const instance = await daemon(t, undefined, false, async (paths) => {
    const result = await files(paths, 9, extra);
    await writeFile(path.join(paths.directory, 'secret.html'), '<p>outside the workspace</p>');
    await symlink(path.join(paths.directory, 'secret.html'), path.join(paths.workspace, 'cards/link.html'));
    await mkdir(path.join(paths.workspace, '_private'), { recursive: true }); await writeFile(path.join(paths.workspace, '_' + 'private/card.html'), '<p>private card</p>');
    return result;
  });
  const overview = (await call(instance, '/mission')).body;
  const home = overview.space.find((section) => section.id === 'home');
  assert.deepEqual(home.cards.map((c) => c.id), ['inbox', 'probe', 'broken', 'throws', 'tall', 'logs', 'gone', 'linked', 'priv'], 'a card with .. or a non-.html file is dropped');
  // Review 3 L2: a _private card (P11) draws with File protection on, and its version is its hash as for any card, so an edit
  // to it draws again; before, the overview read it under the lock and gave it no version.
  assert.equal((await call(instance, '/file-protection')).body.on, true);
  assert.deepEqual([(await call(instance, '/mission/card?id=priv')).body.html, home.cards.find((c) => c.id === 'priv').v],
    ['<p>private card</p>', createHash('sha256').update('<p>private card</p>').digest('hex').slice(0, 12)]);
  assert.ok(overview.invalid.some((x) => x.cards !== undefined && x.reason === 'malformed-record'), JSON.stringify(overview.invalid));
  const hidden = overview.scripts.filter((x) => x.hidden).map((x) => x.id).sort();
  assert.deepEqual(hidden, ['hello', 'homefeed', 'nums', 'oops', 'ship'], 'feeders and title-bar buttons come marked hidden; plain stays a row');
  assert.deepEqual(home.cards.find((c) => c.id === 'inbox').buttons, ['hello', 'ship', 'ghost']);

  const card = await call(instance, '/mission/card?id=inbox');
  assert.deepEqual([card.status, card.body.html], [200, CARD]);
  assert.equal((await call(instance, '/mission/card?id=gone')).body.error, 'not-found');
  const linked = await call(instance, '/mission/card?id=linked');
  assert.ok(linked.status !== 200 && !JSON.stringify(linked.body).includes('outside the workspace'), 'a symlink out of the workspace is not read: ' + JSON.stringify(linked));
  assert.equal((await call(instance, '/mission/card?id=nope')).status, 404);
  assert.match((await call(instance, '/mission/folder/file?id=logs&path=logs%2Fa.log')).body.text, /the whole log/, 'a card\'s folder file reads under the card\'s ID');
  assert.equal((await call(instance, '/mission/folder/file?id=logs&path=logs%2Fb.txt')).status, 404, 'a file the pattern leaves out does not');

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
  let ws; const server = await remoteDaemon(t, { setup: (paths) => { ws = paths.workspace; return files(paths, port); }, args: ['--acp-override', path.join(root, 'test/fake-acp-agent.mjs')] });
  for (const id of ['inbox', 'probe', 'broken', 'throws', 'tall', 'logs']) assert.equal((await server.desk('/mission/data/allow', 'POST', { id })).status, 200);

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
    // A draw of the whole window on demand: the section's text changes on disk and the rail's Mission button reads it again.
    const redraw = async (text, edit = () => {}) => { const s = { ...space().sections[0], text }; edit(s);
      await writeFile(path.join(ws, SETTINGS.space), JSON.stringify({ sections: [s] }));
      await page.evaluate(() => document.querySelector('[data-focus-btn="mission"]').click());
      await page.locator('#mdlBody [data-space-text]', { hasText: text }).waitFor({ timeout: 10000 }); };
    await inbox.locator('#count', { hasText: '12' }).waitFor({ timeout: 20000 });
    assert.equal(await inbox.locator('#label').textContent(), '<b>not markup</b>', 'the JSON arrived as data: markup in it stays text');
    assert.equal(await inbox.locator('#label b').count(), 0);
    await card('broken').locator('.card-note', { hasText: 'printed something that is not JSON' }).waitFor({ timeout: 15000 });
    assert.match(await card('broken').locator('.card-note').innerText(), /oops, not JSON/, 'a bad script shows its error on the card');
    await card('throws').locator('.card-note', { hasText: 'card boom' }).waitFor({ timeout: 15000 });
    assert.equal(await page.locator('#mdlT').innerText(), 'Home · 7 items', 'the title counts cards and the one plain row');
    assert.deepEqual(await page.locator('#mdlBody .mlist [data-i]').allInnerTexts().then((x) => x.map((t) => t.split('\n')[0])), ['Plain row'], 'feeders and title-bar buttons are not rows');
    assert.deepEqual(await card('inbox').locator('h3 .cbtn').allInnerTexts(), ['Say hi', 'Ship it', 'ghost not found']);
    assert.ok(await card('inbox').locator('h3 .cbtn', { hasText: 'not found' }).isDisabled(), 'an ID nothing has is a dead chip');
    const head = await card('inbox').locator('h3').boundingBox(), chip = await card('inbox').locator('h3 .cbtn').first().boundingBox();
    assert.ok(chip.height <= 26 && chip.y >= head.y - 4 && chip.y + chip.height <= head.y + head.height + 4, 'the chips are small and sit in the title bar: ' + JSON.stringify([head, chip]));
    // Wall 3: each card's box fits its content, not a fixed 200 px: the short inbox shrinks, the 480 px card grows.
    const tall = async (id) => (await card(id).locator('iframe').boundingBox()).height;
    for (const end = Date.now() + 10000; Date.now() < end && (await tall('inbox') >= 200 || await tall('tall') < 480); await sleep(200));
    const [hi, ht] = [await tall('inbox'), await tall('tall')];
    assert.ok(hi >= 60 && hi < 200, 'the short card shrinks to its content: ' + hi);
    assert.ok(ht >= 480 && ht <= 490, 'the tall card grows to its content: ' + ht);
    if (theme === 'event-horizon-prime') { // an edit to the card file shows on its own, within one 20 s poll
      await writeFile(path.join(ws, 'cards/inbox.html'), CARD.replace('notes in the inbox', 'notes, edited live'));
      await inbox.locator('p', { hasText: 'notes, edited live' }).waitFor({ timeout: 30000 });
      await inbox.locator('#count', { hasText: '12' }).waitFor({ timeout: 10000 });
    }
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
    if (theme === 'daylight') { // O45 (Builder, 2026-11-09): the window pulls each card's script every 30 s; an answer that did not
      // change must not draw the window again (that made every card's frame again, and a click on a card then was lost).
      await page.evaluate(() => { window.__o45 = Date.now(); new MutationObserver(rs => rs.some(r => [...r.removedNodes].some(n => n.nodeName === 'IFRAME' || n.querySelector?.('iframe'))) && (window.__o45 = Date.now()))
        .observe(document.querySelector('#mdlBody'), { childList: true, subtree: true }); });
      for (const end = Date.now() + 20000; Date.now() < end && Date.now() - await page.evaluate(() => window.__o45) < 3000; await sleep(200));
      const frames = () => page.evaluate(() => [...document.querySelectorAll('#mdlBody [data-card] iframe')].map(f => f.dataset.o45 ?? 'new'));
      await page.evaluate(() => document.querySelectorAll('#mdlBody [data-card] iframe').forEach(f => { f.dataset.o45 = 'kept'; }));
      assert.deepEqual(await frames(), Array(6).fill('kept'), 'six card frames, quiet for 3 s, before the pulls');
      await sleep(36000); // one 30 s pull at least, and its answers
      assert.deepEqual(await frames(), Array(6).fill('kept'), 'a pull with the same answers keeps every card frame');
      // A changed answer must still reach the card (on the next pull, or the one after: a tile's answer is kept 30 s).
      await writeFile(path.join(ws, 'hub/nums.json'), JSON.stringify({ count: 13, label: '<b>not markup</b>' }));
      await inbox.locator('#count', { hasText: '13' }).waitFor({ timeout: 65000 });
      // O94: that changed answer drew the whole window, and every card kept its frame (a click in a card then still lands).
      assert.deepEqual(await frames(), Array(6).fill('kept'), 'a changed answer draws the window and keeps every card frame');
      await redraw('Custom cards, drawn again.');
      assert.deepEqual(await frames(), Array(6).fill('kept'), 'a changed section keeps every card frame too');
      assert.match(await card('throws').locator('.card-note').innerText(), /card boom/, 'a kept card still says the error it stopped with');
      await redraw('Custom cards, one renamed.', (s) => { s.cards[0] = { ...s.cards[0], title: 'Messages' }; });
      assert.deepEqual(await frames(), Array(6).fill('kept'), 'a renamed card keeps its frame');
      assert.equal(await card('inbox').locator('iframe').getAttribute('title'), 'Messages', 'the kept frame takes the new name');
      // Where an element cannot move without reloading (no Element.moveBefore: phone Safari, older browsers), each draw makes
      // the frames again, and the last answer still reaches the new frame.
      await page.evaluate(() => { window.__mb = Element.prototype.moveBefore; delete Element.prototype.moveBefore; });
      // M5 CI (job 133105928886): the wait below timed out with the section still on its old text. Overview reads overlap (the 20 s
      // poll, a Mission click) and can answer out of order; the older answer, last, drew the window back. Here an overview asked
      // before the write answers just after the one asked after it (Electron's handler map is internal: a missing one fails here).
      const held = await app.evaluate(({ ipcMain }) => { const map = ipcMain._invokeHandlers, real = map?.get('p9:mission'), log = globalThis.__m5held = [];
        if (!real) return 'not held: ' + (map ? 'no p9:mission handler' : 'no ipcMain._invokeHandlers'); let stale = null, release = null;
        globalThis.__m5arm = () => { log.push(Date.now() + ' armed'); globalThis.__m5armed = true; };
        map.set('p9:mission', (e, kind, ...a) => { const p = Promise.resolve(real(e, kind, ...a)); if (kind !== 'overview') return p;
          if (!stale) { log.push(Date.now() + ' stale asked'); return (stale = p.then((r) => new Promise((res) => { log.push(Date.now() + ' stale read'); release = () => setTimeout(() => { log.push(Date.now() + ' stale answered'); res(r); }, 0); }))); }
          if (!globalThis.__m5armed) { log.push(Date.now() + ' other read before the write'); return p; }
          map.set('p9:mission', real); log.push(Date.now() + ' fresh asked');
          return p.then((r) => { log.push(Date.now() + ' fresh answered'); release(); return r; }); });
        return 'held'; });
      assert.equal(held, 'held');
      await page.evaluate(() => document.querySelector('[data-focus-btn="mission"]').click());
      for (const end = Date.now() + 5000; Date.now() < end && !(await app.evaluate(() => globalThis.__m5held.some((s) => s.endsWith(' stale read')))); await sleep(50));
      await page.evaluate(() => { const t = window.__m5text = []; new MutationObserver(() => t.push(Date.now() + ' ' + (document.querySelector('#mdlBody [data-space-text]')?.textContent ?? 'none'))).observe(document.querySelector('#mdlBody'), { childList: true, subtree: true, characterData: true }); });
      await app.evaluate(() => globalThis.__m5arm());
      const timeline = async () => (await app.evaluate(() => globalThis.__m5held)).join(', ') + ' | page: ' + (await page.evaluate(() => window.__m5text.filter((x, i, a) => x.slice(14) !== a[i - 1]?.slice(14)))).join(', ');
      await redraw('Custom cards, no moveBefore.').catch(async (e) => { throw new Error('the new section text never showed: ' + await timeline(), { cause: e }); });
      await sleep(1500);
      console.log('P9M5HELD ' + await timeline()); // the forcing's order, shown on a pass too
      // Any draw after the new text counts, not only the end state: another read can put the new text back before a check (run 003805).
      const drawn = (await page.evaluate(() => window.__m5text)).map((x) => x.slice(14)), first = drawn.indexOf('Custom cards, no moveBefore.');
      assert.deepEqual(drawn.slice(first).filter((x) => x !== 'Custom cards, no moveBefore.' && x !== 'none'), [], 'an older overview answering last does not draw the old text back: ' + await timeline());
      assert.equal(await page.locator('#mdlBody [data-space-text]').innerText(), 'Custom cards, no moveBefore.', 'the window ends on the new text: ' + await timeline());
      assert.deepEqual(await frames(), Array(6).fill('new'), 'without moveBefore every card frame is made again');
      await inbox.locator('#count', { hasText: '13' }).waitFor({ timeout: 15000 });
      await page.evaluate(() => { Element.prototype.moveBefore = window.__mb; });
    }
    await card('inbox').scrollIntoViewIfNeeded();
    shot('m5-desktop-1280-' + theme, await page.screenshot());
    // A title-bar press opens the button's run window; a confirm button still asks first.
    await card('inbox').locator('h3 .cbtn', { hasText: 'Ship it' }).click();
    await page.locator('#mdlFoot', { hasText: 'asks before it runs' }).waitFor({ timeout: 5000 });
    await page.click('#mdlFoot [data-run]');
    assert.equal(await page.locator('#mdlFoot [data-run]').innerText(), 'Confirm run', 'the first press only arms it');
    if (theme === 'event-horizon-prime') shot('wall4-ship-window', await page.screenshot());
    if (theme === 'event-horizon-prime') { // wall 15: the card's load-time p9open opened nothing; a click opens the whole file
      await page.click('#mdlBack');
      const logs = card('logs').frameLocator('iframe');
      // CI-only failure (M5 :212, :223, :257): a click in the logs card right after Back is sometimes lost. Record what moves in the
      // window and what reaches the card's frame around the click; on a miss print it, with a screenshot, instead of a bare timeout.
      const clickAfterBack = async (button, opened, name) => {
        protocolLog(true); // switched off again in finally, also when a wait below throws before the click
        let hear;
        try {
          await page.evaluate(() => { const log = window.__m5 = [], at = s => log.push([Date.now(), s]), body = document.querySelector('#mdlBody');
            const of = f => f.closest('[data-card]')?.dataset.tile ?? '?', ro = new ResizeObserver(es => es.forEach(e => at(`size ${of(e.target)} ${Math.round(e.contentRect.height)}`)));
            body.querySelectorAll('iframe').forEach(f => ro.observe(f));
            new MutationObserver(rs => rs.forEach(r => { r.addedNodes.forEach(n => n.nodeName === 'IFRAME' && (at('new frame ' + of(n)), ro.observe(n))); r.removedNodes.forEach(n => n.nodeName === 'IFRAME' && at('frame gone')); })).observe(body, { childList: true, subtree: true });
            body.addEventListener('scroll', () => at('scroll ' + body.scrollTop));
            addEventListener('message', e => e.data?.p9 === 'frame' && e.data.kind !== 'selection' && at(`message ${e.data.kind} ${e.data.path ?? e.data.h ?? ''}`));
            new MutationObserver(() => at('title ' + document.querySelector('#mdlT').textContent)).observe(document.querySelector('#mdlT'), { childList: true, characterData: true, subtree: true });
            document.addEventListener('pointerdown', e => at(`pointerdown on the page: ${e.target.id || e.target.className || e.target.nodeName} at ${e.clientX},${e.clientY}`), true);
            const r = document.querySelector('[data-tile="logs"] iframe').getBoundingClientRect(); at(`logs frame top ${Math.round(r.top)} height ${Math.round(r.height)}, body top ${Math.round(body.getBoundingClientRect().top)}`); });
          const frame = await (await card('logs').locator('iframe').elementHandle()).contentFrame();
          const said = []; hear = m => m.text().startsWith('P9M5 ') && said.push([+m.text().split(' ')[1], 'in the card: ' + m.text().split(' ').slice(2).join(' ')]);
          page.on('console', hear); // the card's own record, kept even when the frame is made again before the miss is seen
          await frame.evaluate(() => { const at = s => console.log(`P9M5 ${Date.now()} ${s}`), open = window.p9open;
            for (const k of ['pointermove', 'pointerdown', 'pointerup', 'click']) addEventListener(k, e => at(`${k} on ${e.target.id || e.target.nodeName} at ${e.clientX},${e.clientY}, activation ${navigator.userActivation?.isActive}`), { capture: true, once: k === 'pointermove' });
            window.p9open = path => { at(`p9open ${path}, activation ${navigator.userActivation?.isActive}`); return open(path); }; });
          // The cause: a card frame (its own process) that was out of view draws nothing, and until it has drawn again Chromium gives
          // a click on it to the page's <iframe> element, so the card never sees it ("pointerdown on the page: art-frame"). Its
          // script runs anyway, so data-ready says nothing about that. Scroll it in and let it draw two frames before the click.
          // CI #115 linux 6: the scroll below waited 30 s for the button to be stable. Playwright's check counts frames inside the
          // card, and a card frame that layout pushed back out of view draws none. Scroll the frame itself in from the page
          // (no stability wait there), then bound each wait and print what moved instead of a bare timeout.
          const moved = (what) => async (e) => { throw new Error(`${name}: ${what}; ms:\n` + (await page.evaluate(() => window.__m5).catch(() => [])).map(([ms, s]) => `${ms} ${s}`).join('\n'), { cause: e }); };
          await card('logs').locator('iframe').evaluate((f) => f.scrollIntoView({ block: 'center' }));
          await logs.locator(button).scrollIntoViewIfNeeded({ timeout: 10000 }).catch(moved('the button never stood still'));
          await Promise.race([frame.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))),
            sleep(10000).then(() => { throw new Error('no frame drawn in 10 s'); })]).catch(moved('the card drew no frame'));
          const t = [[Date.now(), 'click ' + button + ' starts']];
          const record = async (what, e) => { // the timeline from the click, and whether the window and the card frame still answer
            const tail = pwLog.slice(-200); protocolLog(false);
            if (tail.length) console.log(`${name}: Playwright protocol, the last ${tail.length} lines before "${what}" (O129):\n` + tail.join('\n'));
            const answers = async (f) => Promise.race([f.evaluate(() => 'answers').catch((x) => 'gone: ' + x.message.split('\n')[0]), sleep(2000).then(() => 'no answer in 2 s')]);
            const win = await answers(page);
            t.push([Date.now(), `the window ${win}, the card frame ${await answers(frame)}; frames: ${page.frames().length}`]);
            // A stalled card frame can stall the page's screenshot too (#152 runs: empty). Then take the window's last drawn frame from
            // the main process; if neither comes, say why in the timeline instead of printing an empty image.
            const bound = (p, what) => Promise.race([p, sleep(5000).then(() => { throw new Error(what + ': nothing in 5 s'); })]);
            const why = [], png = await page.screenshot({ timeout: 5000 }).then((b) => b.toString('base64') || why.push('page screenshot: empty') && '').catch((x) => { why.push('page screenshot: ' + x.message.split('\n')[0]); })
              || await bound(app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.capturePage().then((i) => i.isEmpty() ? Promise.reject(new Error('empty image')) : i.toPNG().toString('base64'))), 'window capture')
                .then((b) => (t.push([Date.now(), 'screenshot from the window capture (' + why[0] + ')']), b)).catch((x) => { why.push('window capture: ' + x.message.split('\n')[0]); });
            if (png) console.log(`P9_SHOT ${name}-miss ${png}`); else t.push([Date.now(), 'no screenshot: ' + why.join('; ')]);
            const all = [...t, ...win === 'answers' ? await page.evaluate(() => window.__m5) : [], ...said].sort((a, b) => a[0] - b[0]);
            page.off('console', hear);
            throw new Error(`${name}: ${what}; the window says ${JSON.stringify(await page.locator('#mdlT').innerText({ timeout: 2000 }).catch(() => '?'))}; ms from the click:\n` + all.map(([ms, s]) => `${ms - t[0][0]} ${s}`).join('\n'), { cause: e });
          };
          // CI #142 linux 6 (:257): the click hung 30 s after "performing click action" (input sent, no answer). Bound it at 10 s:
          // the waits above already scrolled the button in and saw the card draw, and here a click takes well under a second.
          await logs.locator(button).click({ timeout: 10000 }).catch((e) => record('the click did not finish in 10 s', e));
          t.push([Date.now(), 'click returned']);
          console.log(`${name}: click took ${t[1][0] - t[0][0]} ms`);
          await opened.waitFor({ timeout: 10000 }).catch((e) => record('lost click', e));
        } finally { if (hear) page.off('console', hear); protocolLog(false); }
      };
      await card('logs').scrollIntoViewIfNeeded();
      await sleep(1000);
      assert.equal(await page.locator('#mdlT').innerText(), 'Home · 7 items', 'p9open with no click opens nothing');
      await logs.locator('body[data-ready]').waitFor({ timeout: 10000 });
      await card('logs').locator('iframe').evaluate((f) => { f.dataset.o94 = 'before a.log'; });
      await clickAfterBack('#a', page.locator('#mdlBody pre', { hasText: 'the whole log, not its last lines' }), 'm5-257');
      assert.equal(await page.locator('#mdlT').innerText(), 'a.log');
      shot('wall15-log-open', await page.screenshot());
      await page.click('#mdlBack');
      await card('logs').scrollIntoViewIfNeeded();
      await logs.locator('body[data-ready]').waitFor({ timeout: 10000 }); // Back draws the window whole: a new frame
      assert.equal(await card('logs').locator('iframe').evaluate((f) => f.dataset.o94 ?? 'fresh'), 'fresh', 'after Back the card frames are made fresh (O94 keeps only a frame still in the window)');
      await clickAfterBack('#b', page.locator('#mdlBody pre', { hasText: 'Could not read it' }), 'm5-212');
      assert.equal(await page.locator('#mdlFoot [data-fix]').count(), 0, 'no Fix with Claude on a file that did not open');
      await page.click('#mdlBack');
      await card('logs').scrollIntoViewIfNeeded();
      await logs.locator('body[data-ready]').waitFor({ timeout: 10000 });
      await clickAfterBack('#a', page.locator('#mdlT', { hasText: 'a.log' }), 'm5-223');
      await page.locator('#mdlFoot [data-fix]').click({ timeout: 10000 });
      await page.locator('#mdlBody', { hasText: 'Find why this log failed.' }).waitFor({ timeout: 30000 });
      assert.match(await page.locator('#mdlBody').innerText(), /Find why this log failed\.[\s\S]*logs\/a\.log[\s\S]*the whole log, not its last lines/);
      const fixes = (await page.evaluate(() => window.p9.chat('list'))).body.conversations.filter((c) => c.title.startsWith('Fix: '));
      assert.deepEqual(fixes.map((c) => [c.provider, c.title]), [['claude', 'Fix: a.log']]);
      shot('wall6-fix-chat', await page.screenshot());
      const refused = await page.evaluate(async () => [(await window.p9.mission('fix', { id: 'logs', path: 'logs/b.txt' })).status, (await window.p9.mission('fix', { id: 'inbox', path: 'logs/a.log' })).status]);
      assert.deepEqual(refused, [404, 404], 'a file outside the folder, or a card with no folder, starts no chat');
      assert.equal((await page.evaluate(() => window.p9.chat('list'))).body.conversations.filter((c) => c.title.startsWith('Fix: ')).length, 1);
    }
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
  await phone.clock.install(); // the tiles' 30 s refresh is then the page's own timer, moved on below
  // O71: Mission redraws rows as its fresh answer and the opened cards arrive, so a tap can land as a row moves and leave it
  // closed (Throws, CI #121's group 6 dump). After each tap, wait for that row to be open; tap again if it is not. A row
  // counts as open only if it is still open 200 ms later: a close from a redraw can come just after the tap opened it.
  // Bottom row first: a row grows when it opens and again when its card loads, which moves every row below it.
  // Tapping from the bottom up means no row still to be tapped can move under the pointer.
  for (const title of ['Throws', 'Broken script', 'Probe', 'Inbox']) {
    const isOpen = () => phone.locator(`#mission dialog[open] details:has(> summary:has-text("${title}"))`).evaluate((row) => row.open).catch(() => false);
    const staysOpen = async () => await isOpen() && (await phone.waitForTimeout(200), await isOpen());
    for (let tap = 0; tap < 3 && !await staysOpen(); tap++) {
      await phone.click(`#mission dialog[open] summary:has-text("${title}")`);
      for (let i = 0; i < 10 && !await isOpen(); i++) await phone.waitForTimeout(100);
    }
  }
  const pinbox = phone.locator('#mission dialog[open] [data-tile="inbox"]');
  await pinbox.frameLocator('iframe').locator('#count', { hasText: '13' }).waitFor({ timeout: 20000 }); // the desktop's changed answer
  // A note that never says it prints what each card row held (open or not, its note, the frame's state), so a miss explains itself.
  const held = (e) => phone.evaluate(() => [...document.querySelectorAll('#mission [data-tile]')].map((tile) => ({ id: tile.dataset.tile, inOpenWindow: !!tile.closest('dialog[open]'),
    rowOpen: tile.closest('details')?.open, timer: tile.dataset.timer, rendered: tile.dataset.rendered, note: tile.querySelector('.card-note')?.textContent ?? tile.textContent.slice(0, 200) })))
    .then((all) => { throw new Error('the phone\'s cards held: ' + JSON.stringify(all), { cause: e }); });
  await phone.locator('#mission dialog[open] [data-tile="broken"] .card-note', { hasText: 'not JSON' }).waitFor({ timeout: 15000 }).catch(held);
  await phone.locator('#mission dialog[open] [data-tile="throws"] .card-note', { hasText: 'card boom' }).waitFor({ timeout: 15000 }).catch(held);
  // One 30 s refresh brings the card new JSON but never runs it again: its error line must stay.
  const refreshed = phone.waitForResponse((r) => r.url().includes('/mission/data?id=throws'));
  await phone.clock.fastForward(30000);
  await refreshed; await phone.waitForTimeout(300);
  assert.match(await phone.locator('#mission dialog[open] [data-tile="throws"] .card-note').innerText(), /card boom/, 'the card keeps its error line after a refresh');
  await phone.locator('#mission dialog[open] [data-tile="throws"] .card-note').scrollIntoViewIfNeeded();
  shot('m5-phone', await phone.screenshot());
  assert.equal(hits, 0, 'nothing reached the network server from the phone either');
});

// O148: a bell row reopens a review where you left it (D10-6) by its file, not its row number. Open the new item from its bell
// row, close it, let a newer item sort above it, click Continue: the same file opens. Then that file goes: the row opens its
// own item, never the file that now sits at the old row.
test('O148 Continue reopens the review by its file after the queue moved, and never another file once it is gone', { timeout: 120000 }, async (t) => {
  const fake = path.join(root, 'test/fake-acp-agent.mjs');
  const instance = await daemon(t, undefined, false, async (paths) => {
    const w = paths.workspace; // the setup of top-right-bell.test's 733 test
    await mkdir(path.join(w, '_waiting'), { recursive: true }); await mkdir(path.join(w, 'hub'), { recursive: true });
    await writeFile(path.join(w, 'hub/registry.json'), JSON.stringify({ scripts: [], apps: [], pages: [] }));
    await writeFile(path.join(w, 'AGENTS.md'), '# Projects\n');
    await writeFile(path.join(w, '_waiting/old-question.md'), '# Old question\n\nA.\n');
    await writeFile(path.join(paths.directory, 'settings.json'), JSON.stringify({ waiting: '_waiting', registry: 'hub/registry.json', primary: 'AGENTS.md' }));
    return { args: ['--acp-override', fake, '--settings', path.join(paths.directory, 'settings.json')] };
  });
  const call = (route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
    headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body) }).then((result) => JSON.parse(result.text));
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-o148-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 900));
  await page.locator('#rBell b', { hasText: '1' }).waitFor({ timeout: 15000 });
  const item = (f) => path.join(instance.workspace, '_waiting', f);
  const bellRows = async () => { await page.click('#rBell'); const rows = await page.locator('#mdlBody .mlist li').allInnerTexts(); await page.keyboard.press('Escape'); return rows.map((r) => r.replace(/\s+/g, ' ').trim()); };
  // The waiting list reloads when a turn ends (queueSoon), so each change is followed by a turn.
  const id = (await call('/chat', 'POST', { provider: 'claude' })).conversation;
  await page.locator('#nav .row[data-chat="' + id + '"]').waitFor({ timeout: 15000 });
  const waitRows = async (want) => { await call('/chat/' + id + '/prompt', 'POST', { text: 'hello' });
    for (let n = 0; n < 15; n++) { const r = await bellRows(); if (want.test(r.join('|'))) return r; await page.waitForTimeout(1000); } return bellRows(); };
  // Continue: the bell row that opens the waiting items (a fresh one, "N item(s) need you").
  const opened = async () => { await page.click('#rBell'); await page.locator('#mdl[open] #mdlBody .mlist li', { hasText: /needs? you/ }).last().click();
    const file = page.locator('#mdl[open] #mdlBody .fileview'); await file.waitFor({ timeout: 5000 }); const f = await file.getAttribute('aria-label'); await page.keyboard.press('Escape'); return f; };
  await writeFile(item('b-mine.md'), '# The one I opened\n\nA.\n');
  assert.match((await waitRows(/1 item needs you/)).join('|'), /1 item needs you/);
  assert.equal(await opened(), '_waiting/b-mine.md', 'the bell row opens the new item');
  // A newer item arrives and sorts first (newest first): the remembered row number is now that item.
  await writeFile(item('a-newer.md'), '# Newer\n\nA.\n'); const later = new Date(Date.now() + 60000); await utimes(item('a-newer.md'), later, later);
  assert.match((await waitRows(/2 items need you/)).join('|'), /2 items need you/);
  assert.equal(await opened(), '_waiting/b-mine.md', 'Continue reopens the same file after the queue moved');
  // The file is answered elsewhere and goes: the row opens its own item, never the file now at the old row.
  await unlink(item('b-mine.md'));
  assert.match((await waitRows(/1 item needs you/)).join('|'), /1 item needs you/);
  assert.equal(await opened(), '_waiting/a-newer.md', 'a gone file opens the row\'s own item, never another file');
  console.log('PASS O148: Continue reopens the review by its file after the queue moved; a gone file opens the row\'s own item');
});

// O152 (Window, 2026-11-17): an open Mission window was written with innerHTML on every redraw (a poll's changed answer, about
// every 30 s), so the node under the pointer, focus and open state were replaced while the owner read or clicked it. Now the
// section window and a panel window (Usage) are patched in place: after a redraw the same nodes are there, and focus stays.
test('O152 an open Mission section or Usage window keeps its nodes and focus across a redraw', { timeout: 120000 }, async (t) => {
  let ws; const server = await remoteDaemon(t, { setup: (paths) => { ws = paths.workspace; return files(paths, 9); } });
  const profile = path.join(server.directory, 'electron-profile');
  await mkdir(profile); await versionSeen(profile);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', server.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.click('#rMission');
  // A redraw: the section's text changes on disk and the rail's Mission button reads the space again. #mdlT is set on each
  // modal draw, so its mutations count the draws.
  const redraw = async (text) => {
    const n = await page.evaluate(() => window.__o152 ?? 0);
    await writeFile(path.join(ws, SETTINGS.space), JSON.stringify({ sections: [{ ...space().sections[0], text }] }));
    await page.evaluate(() => document.querySelector('[data-focus-btn="mission"]').click());
    for (const end = Date.now() + 10000; Date.now() < end && await page.evaluate(() => window.__o152 ?? 0) === n; await sleep(100));
    assert.ok(await page.evaluate(() => window.__o152 ?? 0) > n, 'the open window was drawn again');
  };
  await page.evaluate(() => new MutationObserver(() => { window.__o152 = (window.__o152 ?? 0) + 1; }).observe(document.querySelector('#mdlT'), { childList: true, characterData: true, subtree: true }));
  await page.click('#fMission [data-group="Home"]');
  const plain = page.locator('#mdlBody .mlist [data-i]', { hasText: 'Plain row' });
  await plain.waitFor({ timeout: 10000 });
  await plain.focus();
  await page.evaluate(() => { window.__row = document.activeElement; });
  await redraw('Custom cards, drawn again.');
  await page.locator('#mdlBody [data-space-text]', { hasText: 'Custom cards, drawn again.' }).waitFor({ timeout: 10000 });
  assert.deepEqual(await page.evaluate(() => [window.__row.isConnected, document.activeElement === window.__row]), [true, true], 'the section window kept the row and its focus');
  // A window with a footer (a script's Run) and then one without: the old footer and its handlers are gone (#298 FIX1).
  const run = page.locator('#mdlFoot [data-run]');
  await plain.click(); await run.waitFor({ timeout: 10000 });
  await page.click('#mdlBack'); await plain.waitFor({ timeout: 10000 });
  assert.equal(await run.count(), 0, 'Back to the section window leaves no Run button in the footer');
  await plain.click(); await run.waitFor({ timeout: 10000 });
  await page.keyboard.press('Escape');
  await page.click('#rUsage');
  await page.locator('#mdl[open] #mdlBody > *').first().waitFor({ timeout: 10000 });
  await sleep(2000); // Usage's own first read
  await page.evaluate(() => { window.__win = document.querySelector('#mdlBody').firstElementChild; });
  await redraw('Custom cards, Usage open.');
  assert.equal(await run.count(), 0, 'Usage opened after a script window has no Run button in the footer');
  assert.equal(await page.evaluate(() => window.__win.isConnected), true, 'the Usage window kept its panel node');
  console.log('PASS O152: an open Mission section or Usage window keeps its nodes and focus across a redraw');
});
