// Artifacts (item 19, threat model row 65): an agent's artifact block opens in the side panel's sandboxed frame. The six
// types render; escape attempts from inside the frame fail; the agent's mode is used, a chip's click reopens it, and the
// chat's text box stays usable; comments go back as one message; the plan view takes comments too. The desktop runs in
// real Electron with the test sample data (window.__artifact: reply() is the sample chat's own reply path, so the artifact
// arrives as agent text, a chip, then the turn's end opens it). Pictures go out in the log as "P9_SHOT <name> <base64>"
// and to P9_SCREENSHOTS when set. Each wait has its own deadline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, chromium } from '@playwright/test';
import { remoteDaemon, passkeyDevice, enrollDevice } from './helpers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const F = '```';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function launch(t) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'p9-art-'));
  const env = { ...process.env, P9_SAMPLE_DATA: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--user-data-dir=' + profile], env, timeout: 30000 });
  t.after(() => app.close());
  const page = await app.firstWindow();
  await page.locator('#cards .card').first().waitFor({ timeout: 20000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 900));
  await page.waitForFunction(() => !!window.__artifact, null, { timeout: 10000 });
  const shot = async name => {
    const png = await page.screenshot({ animations: 'disabled' });
    if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png.toString('base64'));
    if (process.env.P9_SCREENSHOTS) { await mkdir(process.env.P9_SCREENSHOTS, { recursive: true }); await writeFile(path.join(process.env.P9_SCREENSHOTS, name + '.png'), png); }
  };
  // The agent replies with text; the turn's end opens the newest artifact. Returns the frame's document once it has rendered.
  const reply = async (text, where = '#side') => {
    const before = await page.evaluate(() => window.__artifact.state()?.art.src ?? null);
    await page.evaluate(text => window.__artifact.reply(text), text);
    await page.waitForFunction(b => window.__artifact.state() && window.__artifact.state().art.src !== b, before, { timeout: 15000 });
    return rendered(where);
  };
  const rendered = async (where = '#side') => {
    await page.locator(where + ' .art[data-rendered]').waitFor({ timeout: 20000 });
    assert.equal(await page.locator(where + ' .art').getAttribute('data-rendered'), 'rendered', 'the frame says: ' + await page.locator(where + ' .art-state').textContent());
    return (await page.locator(where + ' .art-frame').elementHandle()).contentFrame();
  };
  const select = (frame, css) => frame.evaluate(css => { const r = document.createRange(); r.selectNodeContents(document.querySelector(css)); getSelection().removeAllRanges(); getSelection().addRange(r); }, css);
  const userTexts = () => page.evaluate(() => window.__artifact.events().filter(e => e.t === 'user').map(e => e.text));
  return { app, page, shot, reply, rendered, select, userTexts };
}

test('artifacts: the six types render in the sandboxed frame', { timeout: 60000 }, async (t) => {
  const { page, shot, reply } = await launch(t);
  const types = [
    ['markdown', `${F}markdown artifact Notes\n## Heading\n\nSome **bold** text and a [link](https://example.com).\n\n<b>raw html stays text</b>\n${F}`,
      async f => { assert.equal(await f.locator('h2').textContent(), 'Heading'); assert.equal(await f.locator('b').count(), 0, 'raw HTML in Markdown is text'); }],
    ['code', `${F}python artifact Script\ndef hello():\n    return "<script>"\n${F}`,
      async f => assert.match(await f.locator('pre code').textContent(), /return "<script>"/)],
    ['html', `${F}html artifact Page\n<!doctype html><h1 id="t">Hello</h1><script>document.getElementById('t').textContent += ' from a script'</script>\n${F}`,
      async f => assert.equal(await f.locator('#t').textContent(), 'Hello from a script')],
    ['svg', `${F}svg artifact Circle\n<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><circle id="c" cx="60" cy="60" r="50" fill="tomato"/></svg>\n${F}`,
      async f => assert.equal(await f.locator('#c').getAttribute('r'), '50')],
    ['mermaid', `${F}mermaid artifact Flow\nflowchart LR\n  A[Ask] --> B[Build] --> C[Ship]\n${F}`,
      async f => { await f.locator('pre.mermaid svg').waitFor({ timeout: 15000 }); assert.match(await f.locator('pre.mermaid svg').textContent(), /Build/); }],
    ['react', `${F}jsx artifact Counter\nimport { useState } from 'react';\nexport default function App() {\n  const [n, setN] = useState(0);\n  return <button id="b" onClick={() => setN(n + 1)}>Clicked {n}</button>;\n}\n${F}`,
      async f => { await f.locator('#b').waitFor({ timeout: 10000 }); await f.locator('#b').click(); assert.equal(await f.locator('#b').textContent(), 'Clicked 1'); }],
  ];
  for (const [kind, text, check] of types) await t.test(kind, async () => {
    const f = await reply('Here it is:\n\n' + text);
    assert.equal(await page.locator('#side .art').count(), 1);
    await check(f);
    await shot('artifact-' + kind);
  });
});

// Every attempt runs inside one HTML artifact and writes what happened. A/B (in the report): the frame without its sandbox
// attribute and CSP turns the CSP and sandbox checks red; the Electron layer (request block) still holds the network.
test('artifacts: escape attempts from inside the frame fail', { timeout: 60000 }, async (t) => {
  let hits = 0; const server = createServer((_q, s) => { hits++; s.end('ok'); }); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const port = server.address().port;
  const { page, app, reply } = await launch(t);
  const probe = `<!doctype html><pre id="out"></pre><form id="f" method="post" action="p9://frame/"><input name="x" value="1"></form><script>
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
tryit('fetchApp', () => fetch('p9://app/index.html').then(r => r.status));
tryit('notification', () => Notification.requestPermission());
const img = new Image(); img.onload = () => put('img', 'ok:loaded'); img.onerror = () => put('img', 'blocked:error'); img.src = 'http://127.0.0.1:${port}/i.png';
setTimeout(() => { try { document.getElementById('f').submit(); put('form', 'submitted'); } catch (e) { put('form', 'blocked:' + e.name); } }, 300);
setTimeout(() => put('done', true), 1500);
</script>`;
  const f = await reply(`${F}html artifact Probe\n${probe}\n${F}`);
  let r = null;
  for (const end = Date.now() + 10000; Date.now() < end && !r?.out.done; await sleep(200)) r = JSON.parse(await f.locator('#out').textContent().catch(() => '{}') || '{}');
  assert.ok(r?.out.done, 'the probe finished and its frame is still the probe (the form post did not navigate it): ' + JSON.stringify(r));
  const o = r.out;
  assert.equal(o.origin, 'ok:null', 'sandbox without allow-same-origin: an opaque origin');
  assert.match(o.parentDocument, /^blocked:SecurityError/, 'parent.document');
  assert.match(o.parentP9, /^blocked:SecurityError/, 'parent.p9');
  assert.equal(o.windowP9, 'ok:undefined', 'window.p9 inside the frame');
  assert.match(o.top, /^blocked:/, 'top.location =');
  assert.match(o.fetchLocal, /^blocked:TypeError/, 'fetch to a local server');
  assert.match(o.fetchApp, /^blocked:TypeError/, 'fetch to P9 itself');
  assert.equal(o.img, 'blocked:error', 'an <img src="http://...">');
  assert.ok(['ok:denied', 'ok:default'].includes(o.notification) && o.notification !== 'ok:granted', 'notifications: ' + o.notification);
  assert.ok(r.v.includes('connect-src') && r.v.includes('img-src'), 'the frame CSP refused the network: ' + r.v.join(', '));
  assert.equal(hits, 0, 'nothing reached the local server');
  assert.equal(page.url(), 'p9://app/', 'the shell is still P9');
  // The shell's CSP is why the frame is a page of its own: a srcdoc frame inherits it, and its inline script never runs.
  const srcdoc = await page.evaluate(() => new Promise(done => {
    const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts'); f.srcdoc = '<script>parent.postMessage("srcdoc-ran", "*")</script>';
    const hear = e => { if (e.data === 'srcdoc-ran') done('ran'); }; addEventListener('message', hear); document.body.append(f);
    setTimeout(() => { f.remove(); done('did not run'); }, 1500);
  }));
  assert.equal(srcdoc, 'did not run', 'a srcdoc frame runs under the shell CSP');
  const frames = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.mainFrame.framesInSubtree.map(f => f.url));
  assert.ok(frames.includes('p9://frame/'), 'the frame is p9://frame/: ' + frames.join(', '));
});

test('artifacts: the agent picks the mode, a chip reopens it, the text box stays usable', { timeout: 60000 }, async (t) => {
  const { page, shot, reply, userTexts } = await launch(t);
  const mode = () => page.evaluate(() => window.__side.current());
  await reply(`${F}html artifact pinned Pinned one\n<h1>Pinned</h1>\n${F}`);
  assert.deepEqual(await mode(), { slot: 'artifact', mode: 'pinned' });
  // Fresh install: a pinned artifact goes with its chat. Another focus hides it; back in Chat it shows again, still pinned.
  await page.click('#rMission');
  assert.equal(await mode(), null, 'Mission: no artifact on screen');
  assert.equal(await page.locator('#side').isHidden(), true, 'Mission: the panel is hidden');
  await page.click('#rChat');
  assert.deepEqual(await mode(), { slot: 'artifact', mode: 'pinned' }, 'back in Chat: shown and still pinned');
  assert.equal(await page.locator('#side').isVisible(), true);
  await shot('a2-pin-follows-chat');
  await reply(`${F}html artifact full Full one\n<h1>Full</h1>\n${F}`);
  assert.deepEqual(await mode(), { slot: 'artifact', mode: 'full' });
  await shot('artifact-full');
  await page.evaluate(() => window.__side.back()); // full with nothing before it closes (what Escape does)
  assert.equal(await mode(), null);
  await reply(`${F}html artifact Panel one\n<h1>Panel</h1>\n${F}`);
  assert.deepEqual(await mode(), { slot: 'artifact', mode: 'panel' });
  // The text box beside it takes a message.
  const ta = page.locator('#chats .pane textarea').first();
  await ta.click(); await ta.fill('typed beside the artifact'); await ta.press('Enter');
  await page.waitForFunction(() => window.__artifact.events().some(e => e.t === 'user' && e.text === 'typed beside the artifact'), null, { timeout: 5000 });
  // Closed, then its chip reopens it (the pinned one, in its own mode).
  await page.click('#side [data-side-close]');
  assert.equal(await mode(), null);
  await page.locator('#chats .artifact-chip[data-title="Pinned one"]').first().click();
  assert.deepEqual(await mode(), { slot: 'artifact', mode: 'pinned' });
  assert.ok((await userTexts()).includes('typed beside the artifact'));
  // Dev Focus with the chat beside the editor: the artifact shows over that chat, above its text box, which still works.
  await page.evaluate(() => window.__side.close('artifact'));
  await page.click('#rDev'); await page.click('#sideToggle'); await page.waitForFunction(() => window.__side.current()?.slot === 'dan-chat', null, { timeout: 5000 });
  await reply(`${F}html artifact Over the chat\n<h1>Over</h1>\n${F}`, '#side .art-over');
  const box = await page.locator('#sideChats .pane textarea').boundingBox(), over = await page.locator('#side .art-over').boundingBox();
  assert.ok(over.y + over.height <= box.y + 1, 'the artifact ends above the text box: ' + JSON.stringify({ over, box }));
  assert.equal(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName, [box.x + box.width / 2, box.y + box.height / 2]), 'TEXTAREA', 'nothing covers the text box');
  await page.locator('#sideChats .pane textarea').fill('typed under the artifact'); await page.locator('#sideChats .pane textarea').press('Enter');
  await page.waitForFunction(() => window.__artifact.events().some(e => e.t === 'user' && e.text === 'typed under the artifact'), null, { timeout: 5000 });
  await shot('artifact-dev-over-chat');
});

test('artifacts: comments go back as one message; Cancel sends nothing; the plan view takes comments; memory', { timeout: 60000 }, async (t) => {
  const { app, page, shot, reply, rendered, select, userTexts } = await launch(t);
  const metrics = () => app.evaluate(({ app }) => app.getAppMetrics().map(m => ({ pid: m.pid, type: m.type, ws: m.memory.workingSetSize })));
  const before = await metrics(), pids = new Set(before.map(m => m.pid));
  const f = await reply(`${F}markdown artifact Design\n# Design\n\nThe first point.\n\nThe second point.\n${F}`);
  await sleep(1500);
  const after = await metrics(), added = after.filter(m => !pids.has(m.pid)), sum = l => l.reduce((a, m) => a + m.ws, 0);
  console.log('P9_MEM frame: new processes ' + JSON.stringify(added) + ' whole app workingSetKB ' + sum(before) + ' -> ' + sum(after) + ' (delta ' + (sum(after) - sum(before)) + ')');
  const sent0 = (await userTexts()).length;
  const add = async (css, text) => {
    await select(f, css);
    await page.waitForFunction(q => document.querySelector('#side .art-quote')?.textContent === q, await f.locator(css).textContent(), { timeout: 5000 });
    await page.locator('#side .art-notes textarea').fill(text); await page.click('#side [data-art-add]');
  };
  // Cancel sends nothing.
  await add('p:nth-of-type(1)', 'dropped');
  await page.click('#side [data-art-cancel]');
  assert.equal(await page.locator('#side .art-list li').count(), 0);
  assert.equal((await userTexts()).length, sent0, 'Cancel sent nothing');
  // Two highlights, two comments, one message with both quotes.
  await add('p:nth-of-type(1)', 'Make this one shorter.');
  await add('p:nth-of-type(2)', 'And <b>this</b> one bolder.');
  assert.equal(await page.locator('#side .art-list li').count(), 2);
  assert.equal(await page.locator('#side .art-list b').count(), 0, 'a comment is text');
  await shot('artifact-two-comments');
  await page.click('#side [data-art-send]');
  await page.waitForFunction(n => window.__artifact.events().filter(e => e.t === 'user').length > n, sent0, { timeout: 5000 });
  const texts = await userTexts();
  assert.equal(texts.length, sent0 + 1, 'one message');
  assert.equal(texts.at(-1), 'Comments on "Design":\n\n> The first point.\n\nMake this one shorter.\n\n> The second point.\n\nAnd <b>this</b> one bolder.');
  assert.equal(await page.locator('#side .art-list li').count(), 0, 'sent comments are cleared');
  // Plan view: Claude's plan-mode plan (an "Approve Plan" call) opens in the same panel and takes a comment.
  await page.evaluate(() => { window.__artifact.events().push({ t: 'tool', status: 'completed', title: 'Approve Plan', plan: '# Plan\n\n1. Read the send path.\n2. Build the frame.' }); window.__artifact.render(); });
  await page.locator('#chats .open-plan:not([data-open-plan="entries"])').last().click(); // the tool's, not the pinned plan's Open
  const pf = await rendered();
  assert.equal(await page.locator('#side .art-title').textContent(), 'Plan');
  await select(pf, 'li:nth-of-type(2)');
  await page.waitForFunction(() => document.querySelector('#side .art-quote')?.textContent === 'Build the frame.', null, { timeout: 5000 });
  await page.locator('#side .art-notes textarea').fill('Do this first.'); await page.click('#side [data-art-add]');
  await shot('artifact-plan');
  await page.click('#side [data-art-send]');
  await page.waitForFunction(() => window.__artifact.events().filter(e => e.t === 'user').at(-1)?.text.startsWith('Comments on "Plan"'), null, { timeout: 5000 });
  assert.equal((await userTexts()).at(-1), 'Comments on "Plan":\n\n> Build the frame.\n\nDo this first.');
});

// Phone: an agent reply's chip opens the artifact in the full-screen sheet (the side panel's phone form); the frame is the
// server's /frame/; a comment goes back through the composer's send, and the composer keeps what was typed in it.
test('artifacts: the phone opens an artifact in the full sheet and sends a comment', { timeout: 60000 }, async (t) => {
  const setup = async (paths) => {
    await mkdir(path.join(paths.workspace, 'hub'), { recursive: true });
    await writeFile(path.join(paths.workspace, 'hub', 'registry.json'), JSON.stringify({ scripts: [], apps: [], pages: [] }));
    await writeFile(path.join(paths.directory, 'settings.json'), JSON.stringify({ registry: 'hub/registry.json', hub: 'hub', server_host: 'test-server' }));
    return { args: ['--settings', path.join(paths.directory, 'settings.json')] };
  };
  const server = await remoteDaemon(t, { setup, args: ['--acp-override', path.join(root, 'test/fake-acp-agent.mjs')] });
  const browser = await chromium.launch(); t.after(() => browser.close());
  const device = await passkeyDevice(browser, server, 'artifacts-' + Math.random().toString(36).slice(2, 7));
  const session = await enrollDevice(server, device), page = device.page;
  await device.context.addCookies([{ name: 'p9s', value: session.token, url: server.origin, httpOnly: true, secure: true, sameSite: 'Strict' }]);
  await device.context.addInitScript(() => { Object.defineProperty(navigator, 'onLine', { get: () => true, configurable: true }); if (navigator.serviceWorker) navigator.serviceWorker.register = async () => undefined; });
  await page.goto(server.origin + '/phone/');
  await page.evaluate((csrf) => sessionStorage.setItem('p9-csrf', csrf), session.csrf);
  await page.reload(); await page.setViewportSize({ width: 390, height: 844 });
  await page.click('#newChat', { timeout: 15000 }); await page.click('#sheet [data-new="claude"]');
  await page.waitForSelector('#composer', { state: 'visible', timeout: 15000 });
  // The fake agent answers "echo:" and the prompt, so the reply carries the artifact block.
  await page.fill('#prompt', 'Show this:\n' + F + 'html artifact Phone page\n<h1 id="t">On the phone</h1><p id="p">Comment on me.</p>\n' + F);
  await page.click('#composer button[type="submit"]');
  await page.locator('#events article[data-kind="agent"] .artifact-chip').waitFor({ timeout: 15000 });
  await page.fill('#prompt', 'my draft');
  await page.click('#events article[data-kind="agent"] .artifact-chip');
  await page.waitForSelector('#sheet.full[open]', { timeout: 5000 });
  await page.waitForFunction(() => !document.querySelector('#sheet').getAnimations().length, null, { timeout: 5000 }); // it slides in 24 px first
  const sheet = await page.locator('#sheet').boundingBox();
  assert.ok(Math.abs(sheet.height - 844) <= 1 && sheet.y <= 1, 'the sheet fills the viewport: ' + JSON.stringify(sheet));
  await page.locator('#sheet .art[data-rendered]').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('#sheet .art').getAttribute('data-rendered'), 'rendered');
  const f = await (await page.locator('#sheet .art-frame').elementHandle()).contentFrame();
  assert.equal(await f.locator('#t').textContent(), 'On the phone');
  assert.equal(f.url(), server.origin + '/frame/');
  const frameBox = await page.locator('#sheet .art-frame').boundingBox();
  assert.ok(frameBox.height > 300, 'the frame has room: ' + JSON.stringify(frameBox));
  await f.evaluate(() => { const r = document.createRange(); r.selectNodeContents(document.getElementById('p')); getSelection().removeAllRanges(); getSelection().addRange(r); });
  await page.waitForFunction(() => document.querySelector('#sheet .art-quote')?.textContent === 'Comment on me.', null, { timeout: 5000 });
  await page.locator('#sheet .art-notes textarea').fill('Shorter, please.'); await page.click('#sheet [data-art-add]');
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT artifact-phone-sheet ' + (await page.screenshot()).toString('base64'));
  if (process.env.P9_SCREENSHOTS) { await mkdir(process.env.P9_SCREENSHOTS, { recursive: true }); await writeFile(path.join(process.env.P9_SCREENSHOTS, 'artifact-phone-sheet.png'), await page.screenshot()); }
  await page.click('#sheet [data-art-send]');
  await page.locator('#events article[data-kind="user"]', { hasText: 'Comments on "Phone page"' }).waitFor({ timeout: 10000 });
  assert.match(await page.locator('#events article[data-kind="user"]').last().textContent(), /> Comment on me\.\s+Shorter, please\./);
  assert.equal(await page.inputValue('#prompt'), 'my draft', 'the composer keeps what was typed');
  // An artifact that navigates its own frame away (the phone has no will-frame-navigate or request block): nothing
  // reaches the other page, the frame is put back on /frame/, and the panel says so.
  let hits = 0; const other = createServer((_q, s) => { hits++; s.end('<h1>not P9</h1>'); }); await new Promise(r => other.listen(0, '127.0.0.1', r)); t.after(() => other.close());
  await page.keyboard.press('Escape'); await page.waitForSelector('#sheet:not([open])', { state: 'attached', timeout: 5000 });
  await page.fill('#prompt', 'Again:\n' + F + 'html artifact Away\n<p>leaving</p><script>location.href = "http://127.0.0.1:' + other.address().port + '/?text=" + encodeURIComponent(document.body.textContent)</script>\n' + F);
  await page.click('#composer button[type="submit"]');
  const away = page.locator('#events article[data-kind="agent"] .artifact-chip', { hasText: 'Away' });
  await away.waitFor({ timeout: 15000 }); await away.click();
  await page.waitForSelector('#sheet.full[open]', { timeout: 5000 });
  for (const end = Date.now() + 5000; Date.now() < end && !hits && !await page.locator('#sheet .art[data-rendered="error"]').count();) await sleep(100);
  await sleep(500); // a late request or load still has time to show
  assert.equal(hits, 0, 'the frame reached the other page');
  const g = await (await page.locator('#sheet .art-frame').elementHandle()).contentFrame();
  assert.equal(g.url(), server.origin + '/frame/', 'the frame is back on the frame page');
  assert.equal(await page.locator('#sheet .art').getAttribute('data-rendered'), 'error', 'the panel says the artifact left its frame');
});

test('artifacts: a pinned artifact sits above the black hole; its top right corner and first line are not covered', { timeout: 60000 }, async (t) => {
  const { page, shot, reply } = await launch(t);
  const frame = await reply(`${F}html artifact pinned First line\n<h1 style="margin:0">First line of the artifact</h1><p>More</p>\n${F}`);
  const line = await frame.evaluate(() => { const r = document.querySelector('h1').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  for (const theme of ['event-horizon-prime', 'daylight']) {
    await page.click('#themeBtn'); await page.click('[data-theme-pick="' + theme + '"]'); await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    // What the page draws at each point: '' when it is the panel (or its frame), else the element on top of it. The black
    // hole (.stage::before) ignores the pointer, so it is made hit-testable here or elementFromPoint looks through it.
    const covers = await page.evaluate(line => {
      if (!document.querySelector('#holeHit')) document.head.append(Object.assign(document.createElement('style'), { id: 'holeHit', textContent: '.stage::before{pointer-events:auto!important}' }));
      const side = document.querySelector('#side'), s = side.getBoundingClientRect(), f = side.querySelector('.art-frame').getBoundingClientRect();
      const at = (x, y) => { const e = document.elementFromPoint(x, y); return e && side.contains(e) ? '' : (e?.outerHTML ?? 'nothing').slice(0, 160); };
      return {
        'top right corner': at(s.right - 4, s.top + 4),
        'first line start': at(f.x + line.x + 4, f.y + line.y + line.h / 2),
        'first line end': at(f.x + Math.min(line.x + line.w, f.width) - 4, f.y + line.y + line.h / 2),
        'first line top right': at(f.right - 4, f.y + line.y + 2),
      };
    }, line);
    assert.deepEqual(covers, { 'top right corner': '', 'first line start': '', 'first line end': '', 'first line top right': '' }, theme + ': nothing draws over the pinned panel');
    await shot('a1-pinned-over-blackhole-' + theme);
  }
});

test('artifacts: with an artifact panel open the notification cards sit below its header, so Pin and Full screen are on top', { timeout: 60000 }, async (t) => {
  const { page, shot, reply } = await launch(t);
  const cardsTop = () => page.locator('#cards').evaluate(e => Math.round(e.getBoundingClientRect().top));
  const before = await cardsTop();
  // '' when the button is the top element at its centre, else what is drawn there.
  const onTop = names => page.evaluate(names => Object.fromEntries(names.map(n => {
    const b = [...document.querySelectorAll('#side .art-bar button')].find(x => x.textContent.trim() === n);
    if (!b) return [n, 'missing'];
    const r = b.getBoundingClientRect(), e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return [n, b.contains(e) ? '' : (e?.outerHTML ?? 'nothing').slice(0, 160)];
  })), names);
  await reply(`${F}html artifact Panel one\n<h1>Panel</h1>\n${F}`);
  for (const theme of ['event-horizon-prime', 'daylight']) {
    await page.click('#themeBtn'); await page.click('[data-theme-pick="' + theme + '"]'); await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    assert.ok(await page.locator('#cards .card').first().isVisible(), theme + ': the cards show');
    assert.deepEqual(await onTop(['Pin', 'Full screen']), { Pin: '', 'Full screen': '' }, theme + ': Pin and Full screen are on top');
    const bar = await page.locator('#side .art-bar').boundingBox();
    assert.ok(await cardsTop() >= bar.y + bar.height, theme + ': the cards start below the panel header');
    await shot('a3-cards-below-panel-header-' + theme);
    await page.locator('#side .art-bar button', { hasText: 'Full screen' }).click();
    await page.waitForFunction(() => document.querySelector('.stage').dataset.sideMode === 'full');
    assert.deepEqual(await onTop(['Full screen']), { 'Full screen': '' }, theme + ': Full screen (to leave it) is on top in full mode');
    await page.locator('#side .art-bar button', { hasText: 'Full screen' }).click();
    await page.waitForFunction(() => document.querySelector('.stage').dataset.sideMode === 'panel');
  }
  await page.evaluate(() => window.__side.close('artifact'));
  assert.equal(await cardsTop(), before, 'with no panel the cards are back where they were');
});
