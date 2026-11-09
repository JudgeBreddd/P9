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
import { mkdir, writeFile, symlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
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
      // CI-only failure (M5 :212, :223): a click in the logs card right after Back is sometimes lost. Record what moves in the
      // window and what reaches the card's frame around the click; on a miss print it, with a screenshot, instead of a bare timeout.
      const clickAfterBack = async (button, opened, name) => {
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
        const said = [], hear = m => m.text().startsWith('P9M5 ') && said.push([+m.text().split(' ')[1], 'in the card: ' + m.text().split(' ').slice(2).join(' ')]);
        page.on('console', hear); // the card's own record, kept even when the frame is made again before the miss is seen
        await frame.evaluate(() => { const at = s => console.log(`P9M5 ${Date.now()} ${s}`), open = window.p9open;
          for (const k of ['pointerdown', 'click']) addEventListener(k, e => at(`${k} on ${e.target.id || e.target.nodeName} at ${e.clientX},${e.clientY}, activation ${navigator.userActivation?.isActive}`), true);
          window.p9open = path => { at(`p9open ${path}, activation ${navigator.userActivation?.isActive}`); return open(path); }; });
        // The cause: a card frame (its own process) that was out of view draws nothing, and until it has drawn again Chromium gives
        // a click on it to the page's <iframe> element, so the card never sees it ("pointerdown on the page: art-frame"). Its
        // script runs anyway, so data-ready says nothing about that. Scroll it in and let it draw two frames before the click.
        await logs.locator(button).scrollIntoViewIfNeeded();
        await frame.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const t = [[Date.now(), 'click ' + button + ' starts']];
        await logs.locator(button).click();
        t.push([Date.now(), 'click returned']);
        await opened.waitFor({ timeout: 10000 }).finally(() => page.off('console', hear)).catch(async (e) => {
          console.log(`P9_SHOT ${name}-miss ` + (await page.screenshot()).toString('base64'));
          const all = [...t, ...await page.evaluate(() => window.__m5), ...said].sort((a, b) => a[0] - b[0]);
          throw new Error(`${name}: lost click; the window says ${JSON.stringify(await page.locator('#mdlT').innerText())}; ms from the click:\n` + all.map(([ms, s]) => `${ms - t[0][0]} ${s}`).join('\n'), { cause: e });
        });
      };
      await card('logs').scrollIntoViewIfNeeded();
      await sleep(1000);
      assert.equal(await page.locator('#mdlT').innerText(), 'Home · 7 items', 'p9open with no click opens nothing');
      await logs.locator('#a').click();
      await page.locator('#mdlBody pre', { hasText: 'the whole log, not its last lines' }).waitFor({ timeout: 10000 });
      assert.equal(await page.locator('#mdlT').innerText(), 'a.log');
      shot('wall15-log-open', await page.screenshot());
      await page.click('#mdlBack');
      await card('logs').scrollIntoViewIfNeeded();
      await logs.locator('body[data-ready]').waitFor({ timeout: 10000 }); // Back draws the window whole: a new frame
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
  for (const title of ['Inbox', 'Probe', 'Broken script', 'Throws']) await phone.click(`#mission dialog[open] summary:has-text("${title}")`);
  const pinbox = phone.locator('#mission dialog[open] [data-tile="inbox"]');
  await pinbox.frameLocator('iframe').locator('#count', { hasText: '12' }).waitFor({ timeout: 20000 });
  await phone.locator('#mission dialog[open] [data-tile="broken"] .card-note', { hasText: 'not JSON' }).waitFor({ timeout: 15000 });
  await phone.locator('#mission dialog[open] [data-tile="throws"] .card-note', { hasText: 'card boom' }).waitFor({ timeout: 15000 });
  // One 30 s refresh brings the card new JSON but never runs it again: its error line must stay.
  const refreshed = phone.waitForResponse((r) => r.url().includes('/mission/data?id=throws'));
  await phone.clock.fastForward(30000);
  await refreshed; await phone.waitForTimeout(300);
  assert.match(await phone.locator('#mission dialog[open] [data-tile="throws"] .card-note').innerText(), /card boom/, 'the card keeps its error line after a refresh');
  await phone.locator('#mission dialog[open] [data-tile="throws"] .card-note').scrollIntoViewIfNeeded();
  shot('m5-phone', await phone.screenshot());
  assert.equal(hits, 0, 'nothing reached the network server from the phone either');
});
