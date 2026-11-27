// Phone parity (v0.1.6 chunk 2): the phone's terminal knows it is a phone (T6), Paste (T2) and tap-to-type (T1), the
// agent's pictures and real links in a reply (P9), every mode behind the desktop's red warning (P6), and the desktop's
// chat controls the phone lacked (P10: questions, effort and fast mode, slash commands, a new chat's folder), and
// images attached from the phone (P8).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { remoteDaemon, passkeyDevice, enrollDevice, root } from './helpers.mjs';

// The dev space keeps no files: the picture goes out in the log as "P9_SHOT <name> <base64>" (not on GitHub).
const shot = async (page, name) => { const png = await page.screenshot({ animations: 'disabled' }); /* a sheet's slide-in is finished first */ if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png.toString('base64')); };
async function setup(paths) {
  await mkdir(path.join(paths.workspace, 'hub'), { recursive: true });
  await mkdir(path.join(paths.workspace, 'proj', 'sub'), { recursive: true });
  await writeFile(path.join(paths.workspace, 'hub', 'registry.json'), JSON.stringify({ scripts: [], apps: [], pages: [] }));
  await writeFile(path.join(paths.directory, 'settings.json'), JSON.stringify({ registry: 'hub/registry.json', hub: 'hub', server_host: 'test-server' }));
  return { args: ['--settings', path.join(paths.directory, 'settings.json')] };
}
// The dev space has no network, so Chromium reports navigator.onLine false: the page is told it is online.
async function phoneOn(t) {
  const server = await remoteDaemon(t, { setup, args: ['--acp-override', path.join(root, 'test/fake-acp-agent.mjs')] });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const device = await passkeyDevice(browser, server, 'phone-parity');
  const session = await enrollDevice(server, device);
  await device.context.addCookies([{ name: 'p9s', value: session.token, url: server.origin, httpOnly: true, secure: true, sameSite: 'Strict' }]);
  await device.context.addInitScript(() => Object.defineProperty(navigator, 'onLine', { get: () => true, configurable: true }));
  await device.page.goto(server.origin + '/phone/');
  await device.page.evaluate((csrf) => sessionStorage.setItem('p9-csrf', csrf), session.csrf);
  await device.page.reload();
  await device.page.setViewportSize({ width: 390, height: 844 });
  return { ...device, server, session };
}
// New chat is the Chats list's + (c1's shell): from a chat, back to the list first. Waits for the chat this tap made to
// be shown, not just any change: straight after a reload the page is still choosing its first chat, and a chat made
// then is a stub, drawn (with its mode) once its history is in.
async function newChat(page, agent, made201 = () => {}, folder = '') {
  const made = page.waitForResponse((response) => new URL(response.url()).pathname === '/chat' && response.request().method() === 'POST' && response.status() === 201, { timeout: 10000 });
  if (await page.isVisible('[data-bar="chat"] [data-back]')) await page.click('[data-bar="chat"] [data-back]');
  await page.click('#newChat');
  await page.click(`#sheet[open] [data-new="${agent}"]`);
  const id = String((await (await made).json()).conversation);
  made201();
  // Shown = the chat screen's link (set as it is drawn); the hidden select alone also names the newest chat on the list.
  await page.waitForFunction((id) => location.hash === '#chat=' + id && document.querySelector('#conversation').value === id && !document.querySelector('#events').textContent.includes('Loading'), id, { timeout: 10000 });
  if (folder) {
    await page.locator('[data-chat-folder]').click();
    let at = ''; for (const part of folder.split('/')) { at = [at, part].filter(Boolean).join('/'); await page.locator('[data-chat-folder-at="' + at + '"]').click(); }
    await page.locator('[data-chat-folder-select]').click();
    await page.waitForFunction((id) => location.hash.startsWith('#chat=') && location.hash !== '#chat=' + id, id, { timeout: 10000 });
    // The folder's chat replaces the first one (phone.ts: a new chat, then the hash, then its read): shown as above, not just named.
    const next = decodeURIComponent((await page.evaluate(() => location.hash)).slice(6));
    await page.waitForFunction((id) => document.querySelector('#conversation').value === id && !document.querySelector('#events').textContent.includes('Loading') && !document.querySelector('#sheet').open, next, { timeout: 10000 });
    return next;
  }
  return id;
}
const send = async (page, text) => { await page.fill('#prompt', text); await page.click('#composer button[type="submit"]'); };
// P4: a mode is picked as a thumb does it, from the pill's sheet.
const pickMode = async (page, value) => { await page.click('#modePill'); await page.click(`#sheet[open] [data-mode="${value}"]`); };

test('T6, T2, T1: a phone terminal has P9_PHONE=1, a desktop one does not; Paste sends the clipboard on its tap only', { timeout: 90000 }, async (t) => {
  const { page, context, server } = await phoneOn(t);
  const screen = () => page.locator('#screen .xterm-rows').innerText();
  const shows = (text) => page.waitForFunction((want) => document.querySelector('#screen .xterm-rows')?.textContent.includes(want), text, { timeout: 10000 });
  const connected = () => page.waitForFunction(() => document.querySelector('#termState').textContent === 'Connected', null, { timeout: 10000 });
  const type = async (line) => { await page.click('#screen'); await page.keyboard.type(line); await page.keyboard.press('Enter'); };

  await page.click('[data-nav="terminal"]');
  await page.click('#newTerminal');
  await connected();
  // T1: one tap on the screen and the keys go to the shell (the hidden textarea has focus).
  await page.click('#screen');
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea')), true, 'a tap did not focus the terminal');
  await type('echo PH-$P9_PHONE-END');
  await shows('PH-1-END');
  // Made on the desktop after the phone's (so the tmux server already runs): its shell has no P9_PHONE.
  const desk = (await server.desk('/terminals', 'POST', {})).body.terminal;
  assert.ok(desk, 'the desktop terminal was not made');
  await page.click('#refreshTerminal');
  await page.waitForFunction((id) => [...document.querySelectorAll('#terminal option')].some((o) => o.value === id), desk, { timeout: 10000 });
  // The terminal is picked from the title's sheet (c7's Terminal bar).
  await page.click('#pickTerminal');
  await page.click(`#sheet[open] [data-term="${desk}"]`);
  await connected();
  await type('echo DK-$P9_PHONE-END');
  await shows('DK--END');

  // T2: Paste reads the clipboard on the tap and the shell runs it.
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.origin });
  await page.evaluate(() => navigator.clipboard.writeText('echo P9-PASTE-4""2'));
  await page.click('[data-key="paste"]');
  await shows('P9-PASTE-4""2');
  await page.click('#screen');
  await page.keyboard.press('Enter');
  await shows('P9-PASTE-42');
  // A clipboard the browser refuses says so; one that answers past 4 s asks for another tap and sends nothing.
  await page.evaluate(() => { navigator.clipboard.readText = () => Promise.reject(new DOMException('denied', 'NotAllowedError')); });
  await page.click('[data-key="paste"]');
  await page.waitForFunction(() => document.querySelector('#termState').textContent.startsWith('Paste not allowed'), null, { timeout: 5000 });
  await page.evaluate(() => { navigator.clipboard.readText = () => new Promise((resolve) => setTimeout(() => resolve('echo P9-LATE-4""2\r'), 4300)); });
  await page.click('[data-key="paste"]');
  await page.waitForFunction(() => document.querySelector('#termState').textContent === 'Paste took too long: tap Paste again', null, { timeout: 8000 });
  await type('echo P9-AFTER-4""2');
  await shows('P9-AFTER-42');
  assert.ok(!(await screen()).includes('P9-LATE-42'), 'a paste read after 4 s reached the shell');
});

test('P9: the phone shows the agent\'s own pictures and real links, and loads nothing remote', { timeout: 90000 }, async (t) => {
  const { page, server } = await phoneOn(t);
  const remote = [];
  page.on('request', (request) => { const url = request.url(); if (!url.startsWith(server.origin) && !url.startsWith('data:')) remote.push(url); });
  await newChat(page, 'claude');
  await send(page, 'images');
  // O249: each picture is fetched when it scrolls into view; these are in view.
  await page.waitForFunction(() => [...document.querySelectorAll('#events .agent-imgs img')].filter((img) => img.src && img.complete && img.naturalWidth).length === 2, null, { timeout: 15000 });
  const sources = await page.$$eval('#events .agent-imgs img', (list) => list.map((img) => [img.src.slice(0, 22), img.naturalWidth, img.naturalHeight]));
  assert.deepEqual(sources, [['data:image/png;base64,', 320, 200], ['data:image/png;base64,', 120, 90]]);
  // A tap opens it full screen; another tap closes it.
  await page.click('#events .agent-imgs img >> nth=1');
  assert.equal(await page.evaluate(() => document.querySelector('dialog.picture').open), true);
  await page.click('dialog.picture');
  assert.equal(await page.evaluate(() => document.querySelector('dialog.picture').open), false);
  // An image from a tool call folded into "Ran 3 tools" shows in the chat with the fold closed, once, as on the desktop.
  await send(page, 'images in steps');
  await page.waitForFunction(() => [...document.querySelectorAll('#events .md')].some((el) => el.textContent.includes('Built.')), null, { timeout: 15000 });
  const folded = page.locator('#events [data-kind="group"]').last();
  assert.equal(await folded.locator('summary').first().textContent(), 'Ran 3 tools');
  assert.equal(await folded.evaluate((el) => el.querySelector(':scope > details').open), false, 'the fold opened itself');
  assert.equal(await folded.locator('.agent-imgs img').count(), 1, 'the image is missing or shown twice');
  assert.equal(await folded.locator('.agent-imgs img').isVisible(), true, 'the image is hidden in the closed fold');
  await folded.locator('.agent-imgs img[src]').waitFor({ timeout: 15000 });
  assert.deepEqual(await folded.locator('.agent-imgs img').evaluate(async (img) => { await img.decode(); return [img.src.slice(0, 22), img.naturalWidth, img.naturalHeight]; }), ['data:image/png;base64,', 200, 100]);
  await folded.scrollIntoViewIfNeeded();
  await shot(page, 'phone-folded-tool-image');

  // The fake agent echoes the prompt: one web link becomes a real link with its host; the rest stay text.
  await send(page, 'see [the docs](https://docs.example.test/p) [x](javascript:alert(1)) [f](file:///etc/passwd) [u](https://u:p@a.test/)');
  await page.waitForFunction(() => [...document.querySelectorAll('#events .md')].some((el) => el.textContent.includes('echo:see')), null, { timeout: 15000 });
  const links = await page.$$eval('#events a', (list) => list.map((a) => [a.getAttribute('href'), a.textContent, a.target, a.rel, a.nextElementSibling?.textContent ?? '']));
  assert.deepEqual(links, [['https://docs.example.test/p', 'the docs', '_blank', 'noopener noreferrer', '(docs.example.test)']]);
  // In the sentence, not the Mission hub's link card (a.link).
  assert.equal(await page.$eval('#events .md a', (a) => getComputedStyle(a).display), 'inline', 'a reply link is drawn as a card');
  await page.locator('#events .md a').last().scrollIntoViewIfNeeded();
  await shot(page, 'phone-reply-link-image');
  assert.deepEqual(remote, [], 'the phone loaded something remote');
});

test('P6: every mode on the phone; the loosened ones ask first in red; a chat made here starts in the last pick, a loosened one only after "don\'t show again"', { timeout: 90000 }, async (t) => {
  const { page, server } = await phoneOn(t);
  const id = await newChat(page, 'codex');
  const labels = () => page.$$eval('#mode option', (list) => list.map((o) => o.textContent));
  assert.deepEqual((await labels()).slice(1), ['Mode: Read-only', 'Mode: Workspace access', 'Mode: Auto review', 'Mode: Full access']);
  // Cancel puts "as set" back and nothing is kept.
  // A timeline of the warning and the select, printed if the pick is lost (Chromium closes a dialog a frame late).
  await page.evaluate(() => { const log = window.p6log = [], dlg = document.querySelector('#looseDlg'), sel = document.querySelector('#mode');
    const at = (what) => log.push([Math.round(performance.now()), what, dlg.open, dlg.returnValue, sel.value, sel.dataset.was]);
    dlg.addEventListener('close', () => at('close')); sel.addEventListener('change', () => at('change'));
    new MutationObserver(() => at('options')).observe(sel, { childList: true }); });
  const p6dump = async () => JSON.stringify(await page.evaluate(() => window.p6log));
  await pickMode(page, 'Full access');
  await page.waitForFunction(() => document.querySelector('#looseDlg').open, null, { timeout: 5000 });
  assert.equal(await page.textContent('#looseT'), 'Turn on Full access for Codex?');
  assert.match(await page.textContent('#looseP'), /without a sandbox/);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#looseDlg')).borderTopColor), 'rgb(255, 123, 139)');
  await shot(page, 'phone-mode-warning');
  // A redraw while the warning is open (the desktop sets Read-only) must not make the waiting pick the one Cancel keeps.
  assert.equal((await server.desk('/chat/' + id + '/prompt', 'POST', { text: 'hi', mode: 'Read-only', op: crypto.randomUUID() })).status, 202);
  await page.waitForFunction(() => document.querySelector('#mode option').textContent === 'Mode: Read-only', null, { timeout: 10000 });
  await page.click('#looseDlg button[value="no"]');
  assert.equal(await page.inputValue('#mode'), '');
  assert.equal(await page.evaluate(() => localStorage.getItem('p9-mode:codex')), null);
  // Turn on: the prompt goes in Full access and the daemon's mode event names it in the label.
  await pickMode(page, 'Full access');
  await page.waitForFunction(() => document.querySelector('#looseDlg').open, null, { timeout: 5000 });
  await page.click('#looseDlg button[value="yes"]');
  await page.waitForFunction(() => document.querySelector('#mode').value === 'Full access', null, { timeout: 5000 }).catch(async (error) => { throw new Error('P6 timeline ' + await p6dump(), { cause: error }); });
  await send(page, 'mode');
  await page.waitForFunction(() => [...document.querySelectorAll('#events .md')].some((el) => el.textContent.includes('mode:agent-full-access')), null, { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('#mode option').textContent === 'Mode: Full access', null, { timeout: 5000 });
  // A new Codex chat made on this phone does not start there: "Turn on" was for that chat only (review #2), so it starts
  // "as set", with no silent loosened mode. A Claude one neither (its own last pick: none yet).
  await newChat(page, 'codex');
  assert.equal(await page.evaluate(() => localStorage.getItem('p9-mode:codex')), 'Full access');
  assert.equal(await page.inputValue('#mode'), '');
  await newChat(page, 'claude');
  assert.equal(await page.inputValue('#mode'), '');
  assert.ok((await labels()).includes('Mode: Bypass permissions'));
  // "Don't show again" is kept for that mode on this phone, past a reload.
  await pickMode(page, 'Bypass permissions');
  await page.waitForFunction(() => document.querySelector('#looseDlg').open, null, { timeout: 5000 });
  await page.click('#looseDlg button[value="never"]');
  // Kept once the warning has closed, a frame after the tap in Chromium: the select shows the pick from the moment it is
  // picked, so waiting on it let the reload come first and nothing was kept (pass8 to pass10).
  await page.waitForFunction(() => localStorage.getItem('p9-mode:claude') === 'Bypass permissions' && localStorage.getItem('p9-mode-ok:Bypass permissions'), null, { timeout: 5000 });
  // Tapped while the first read runs (held here until the chat is made), the new chat is a stub, drawn once its history
  // is in: it still starts in the last pick. pass8 and pass9 lost it there.
  let release;
  const go = new Promise((resolve) => { release = resolve; setTimeout(resolve, 10000); });
  const firstRead = (url) => url.pathname === '/chat/events' && url.searchParams.has('only') && !url.searchParams.has('until');
  await page.route(firstRead, async (route) => { await go; await route.continue(); });
  await page.reload();
  await newChat(page, 'claude', release);
  await page.unroute(firstRead);
  assert.equal(await page.inputValue('#mode'), 'Bypass permissions');
  await pickMode(page, 'Auto');
  await pickMode(page, 'Bypass permissions');
  assert.equal(await page.evaluate(() => document.querySelector('#looseDlg').open), false);
});

// The phone's picked chat (the hidden #conversation select the composer, queue and Mode read) follows the chat on screen.
test('P6: the composer stays on the chat on screen when that chat leaves the list (stopped unused on the desktop)', { timeout: 60000 }, async (t) => {
  const { page, server } = await phoneOn(t);
  const other = await newChat(page, 'claude'), id = await newChat(page, 'codex');
  assert.equal((await server.desk('/chat/' + id + '/stop', 'POST')).status, 200);
  // The list drops it (O21: the picker keeps the open chat's own option, outside the list's groups, so the composer stays on it).
  await page.waitForFunction((id) => ![...document.querySelectorAll('#conversation optgroup option')].some((option) => option.value === id), id, { timeout: 10000 });
  assert.notEqual(await page.inputValue('#conversation'), other, 'the composer on the stopped chat now sends to another chat');
  assert.equal(await page.inputValue('#conversation'), id, 'the composer is still on the chat on screen');
});

test('P10: an agent\'s question is answered or declined on the phone', { timeout: 90000 }, async (t) => {
  const { page } = await phoneOn(t);
  await newChat(page, 'claude');
  const replied = (want) => page.waitForFunction((w) => [...document.querySelectorAll('#events .md')].some((el) => el.textContent.includes(w)), want, { timeout: 15000 });
  await send(page, 'ask');
  await page.waitForSelector('#events form[data-question] input[value="blue"]', { timeout: 15000 });
  assert.equal(await page.isChecked('#events form[data-question] input[value=""]'), true, 'an optional choice starts on No answer');
  await page.check('#events form[data-question] input[value="blue"]');
  await page.click('#events form[data-question] button[type="submit"]');
  await replied('ask:{"action":"accept","content":{"colour":"blue"}}');
  await send(page, 'ask-text');
  await page.waitForSelector('#events form[data-question] input[name="f0"][type="text"]', { timeout: 15000 });
  await page.click('#events form[data-question] [data-decline]');
  await replied('ask:{"action":"decline"}');
  assert.equal(await page.locator('#events form[data-question]').count(), 0);
});

test('P10: effort and fast mode, slash commands and a recent chat\'s folder on the phone', { timeout: 90000 }, async (t) => {
  const { page, server } = await phoneOn(t);
  // A reply that does not come says what the chat showed and which chat was on screen.
  const replied = (want) => page.waitForFunction((w) => [...document.querySelectorAll('#events .md')].some((el) => el.textContent.includes(w)), want, { timeout: 15000 })
    .catch(async (e) => { throw new Error(`no reply "${want}"; ` + JSON.stringify(await page.evaluate(() => ({ hash: location.hash, conversation: document.querySelector('#conversation').value, prompt: document.querySelector('#prompt').value, note: document.querySelector('#composerNote').textContent, events: document.querySelector('#events').innerText.slice(-1500) }))), { cause: e }); });
  assert.equal((await server.desk('/chat', 'POST', { provider: 'claude', folder: 'proj/sub' })).status, 201);
  await page.reload();
  await page.waitForSelector('#chatList [data-chat]', { timeout: 10000 });
  await newChat(page, 'claude', undefined, 'proj/sub');
  await send(page, 'cwd');
  await replied('/proj/sub');
  // Effort and fast mode sit under the modes in the pill's sheet, and stay put once it closes.
  await page.click('#modePill');
  await page.waitForSelector('#sheet[open] #pickers select[data-config="effort"]', { timeout: 10000 });
  await page.selectOption('#pickers select[data-config="effort"]', 'high');
  await page.selectOption('#pickers select[data-config="fast"]', 'on');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#sheet').open && document.querySelector('#modeHome #pickers select[data-config="fast"]')?.value === 'on', null, { timeout: 5000 });
  await send(page, 'config');
  await replied('effort=high,fast=on');
  await page.fill('#prompt', '/re');
  await page.waitForSelector('#slash:not([hidden]) [data-cmd="review"]', { timeout: 10000 });
  assert.deepEqual(await page.$$eval('#slash [data-cmd]', (els) => els.map((el) => el.dataset.cmd)), ['review']);
  await page.click('#slash [data-cmd="review"]');
  assert.equal(await page.inputValue('#prompt'), '/review ');
  assert.equal(await page.isHidden('#slash'), true);
  await page.fill('#prompt', '/');
  assert.equal(await page.locator('#slash [data-cmd]').count(), 3);
  await page.fill('#prompt', 'hello');
  assert.equal(await page.isHidden('#slash'), true);
});

test('P8: images attach on the phone from the + sheet or a paste, show as chips and reach the agent; refused ones say why', { timeout: 90000 }, async (t) => {
  const { page } = await phoneOn(t);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', bytes = Buffer.from(png, 'base64');
  const seen = `[image image/png ${bytes.length}]`;
  const replied = (want) => page.waitForFunction((w) => [...document.querySelectorAll('#events .md')].some((el) => el.textContent.trim() === w), want, { timeout: 15000 });
  const chips = (n) => page.waitForFunction((k) => document.querySelectorAll('#attached .chip-img').length === k, n, { timeout: 10000 });
  const noted = (want) => page.waitForFunction((w) => { const el = document.querySelector('#composerNote'); return !el.hidden && el.textContent.includes(w); }, want, { timeout: 10000 });
  const put = (kind, count) => page.evaluate(([b64, kind, k]) => {
    const dt = new DataTransfer(), bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    for (let i = 0; i < k; i += 1) dt.items.add(new File([bin], (kind === 'paste' ? 'pasted' : 'dropped') + i + '.png', { type: 'image/png' }));
    const init = { bubbles: true, cancelable: true };
    document.querySelector('#prompt').dispatchEvent(kind === 'paste' ? new ClipboardEvent('paste', { ...init, clipboardData: dt }) : new DragEvent('drop', { ...init, dataTransfer: dt }));
  }, [png, kind, count]);
  const paste = (count) => put('paste', count);
  // O68: + opens the phone's own chooser in the one tap (it offers the library, the camera and the files itself).
  const choose = async (files) => {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10000 }), page.click('#attach')]);
    await chooser.setFiles(files);
    return page.$eval('#attachInput', (el) => [el.accept, el.getAttribute('capture'), document.querySelector('#sheet').open]);
  };
  await newChat(page, 'claude');
  assert.deepEqual(await choose([{ name: 'shot.png', mimeType: 'image/png', buffer: bytes }]), ['', null, false], 'A2 step 1: the chooser greys nothing out');
  await chips(1);
  // A2 step 1: a file that is not a photo attaches too, as a chip with its name (sent at the end of this test).
  await choose([{ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') }]);
  await page.waitForSelector('#attached .chip-file >> text=notes.txt', { timeout: 10000 });
  await page.click('#attached [aria-label="Remove notes.txt"]');
  // A2 step 1: a big paste of text attaches as pasted.txt; a short one stays text (not taken from the box).
  const pasteText = (text) => page.evaluate((text) => { const dt = new DataTransfer(); dt.setData('text/plain', text); const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }); document.querySelector('#prompt').dispatchEvent(ev); return ev.defaultPrevented; }, text);
  assert.equal(await pasteText('short'), false, 'a short paste stays text');
  await page.fill('#prompt', 'an old prompt'); await page.evaluate(() => document.querySelector('#prompt').select());
  assert.equal(await pasteText('x'.repeat(5001)), false, 'a big paste over a selection replaces it as text');
  // A send tapped while the paste is still being read waits for it instead of going without the file.
  await page.fill('#prompt', 'hi');
  assert.deepEqual(await page.evaluate((text) => {
    const ta = document.querySelector('#prompt'); ta.selectionStart = ta.selectionEnd = ta.value.length;
    const dt = new DataTransfer(); dt.setData('text/plain', text); const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    ta.dispatchEvent(ev); document.querySelector('#composer').requestSubmit(); return [ev.defaultPrevented, document.querySelector('#composerNote').textContent];
  }, 'x'.repeat(5001)), [true, 'Still attaching a file. Send again in a moment.'], 'a big paste is taken from the box; the send waits');
  await page.waitForSelector('#attached .chip-file >> text=pasted.txt', { timeout: 10000 });
  assert.equal(await page.inputValue('#prompt'), 'hi', 'nothing was sent while attaching');
  await page.fill('#prompt', '');
  assert.match(await page.textContent('#composerNote'), /A big paste went in as pasted\.txt/);
  // Four files a message: a fifth big paste is refused, and goes into the box as text instead of being lost.
  for (let i = 0; i < 3; i += 1) assert.equal(await pasteText('x'.repeat(5001)), true);
  await page.waitForFunction(() => document.querySelectorAll('#attached .chip-file').length === 4);
  assert.equal(await pasteText('y'.repeat(5001)), true);
  await page.waitForFunction(() => document.querySelector('#prompt').value === 'y'.repeat(5001));
  assert.match(await page.textContent('#composerNote'), /four files a message at most/);
  for (let i = 0; i < 4; i += 1) await page.click('#attached [aria-label="Remove pasted.txt"] >> nth=0');
  await page.fill('#prompt', '');
  // Round 9 review: a file does not queue. A message with pasted.txt that cannot go now (here the phone is offline) is refused, and
  // a big paste made while it would queue stays text in the box, so with the file removed it queues whole (round 14: all 5001).
  // Rounds 13 to 16: advice to swap pasted.txt for its text could delete the only copy of a paste, so the note gives none.
  const online = (on) => page.evaluate((on) => Object.defineProperty(navigator, 'onLine', { get: () => on, configurable: true }), on);
  const submit = () => page.evaluate(() => document.querySelector('#composer').requestSubmit());
  assert.equal(await pasteText('w'.repeat(5001)), true);
  await page.waitForSelector('#attached .chip-file >> text=pasted.txt', { timeout: 10000 });
  await online(false); await page.fill('#prompt', 'wait'); await submit();
  await noted('attachments go only with a message sent now');
  assert.doesNotMatch(await page.textContent('#composerNote'), /✕/, 'no advice to remove the paste');
  await page.locator('#composer').scrollIntoViewIfNeeded(); await shot(page, 'phone-paste-offline-note');
  // The paste again, with what the phone does when the handler leaves it alone: the text goes in at the caret.
  assert.equal(await page.evaluate((text) => {
    const ta = document.querySelector('#prompt'); ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length;
    const dt = new DataTransfer(); dt.setData('text/plain', text); const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    ta.dispatchEvent(ev); if (!ev.defaultPrevented) document.execCommand('insertText', false, text); return ev.defaultPrevented;
  }, 'w'.repeat(5001)), false, 'offline, a big paste stays text');
  await noted('A big paste stays as text');
  assert.equal(await page.locator('#attached .chip-file').count(), 1, 'no second pasted.txt');
  await page.click('#attached [aria-label="Remove pasted.txt"]');
  await page.click('#attached [aria-label="Remove shot.png"]'); // the photo does not queue either
  await submit();
  await page.waitForFunction(() => document.querySelector('[data-unqueue]')?.closest('article').querySelector('p').textContent === 'wait' + 'w'.repeat(5001), null, { timeout: 10000 });
  await page.click('#queued summary'); // the queue opens from its strip
  await page.click('[data-unqueue]');
  await online(true);
  await choose([{ name: 'shot.png', mimeType: 'image/png', buffer: bytes }]);
  await chips(1);
  await page.fill('#prompt', '');
  await choose([{ name: 'lib.png', mimeType: 'image/png', buffer: bytes }]);
  await chips(2);
  await paste(1);
  await chips(3);
  const box = await page.locator('#attached .chip-img img').first().boundingBox();
  assert.deepEqual([box.width, box.height], [48, 48]);
  await page.locator('#composer').scrollIntoViewIfNeeded();
  await shot(page, 'phone-composer-attach');
  await page.click('#attached [aria-label="Remove pasted0.png"]');
  await page.click('#attached [aria-label="Remove lib.png"]');
  await chips(1);
  // A dropped picture attaches the same way.
  await put('drop', 1);
  await chips(2);
  await page.click('#attached [aria-label="Remove dropped0.png"]');
  await chips(1);
  // A paste made while a send is on its way stays when that send is answered: only the sent photo leaves.
  let release, reached; const gate = new Promise((r) => { release = r; }), hit = new Promise((r) => { reached = r; });
  const onPrompt = (url) => url.pathname.endsWith('/prompt');
  await page.route(onPrompt, async (route) => { reached(); await gate; await route.continue(); }, { times: 1 });
  await send(page, 'look'); await hit;
  assert.equal(await pasteText('z'.repeat(5001)), true, 'a big paste while the send is on its way');
  await page.waitForSelector('#attached .chip-file >> text=pasted.txt', { timeout: 10000 });
  release();
  await replied('echo:look' + seen);
  await chips(0);
  assert.equal(await page.locator('#attached .chip-file', { hasText: 'pasted.txt' }).count(), 1, 'the paste made meanwhile is still attached');
  await page.click('#attached [aria-label="Remove pasted.txt"]');
  assert.equal(await page.isHidden('#attached'), true);
  assert.equal(await page.isHidden('#composerNote'), true);
  // A send of only a photo leaves the box alone: what is typed while it is on its way stays, spaces and all.
  await paste(1); await chips(1);
  let release2, reached2; const gate2 = new Promise((r) => { release2 = r; }), hit2 = new Promise((r) => { reached2 = r; });
  await page.route(onPrompt, async (route) => { reached2(); await gate2; await route.continue(); }, { times: 1 });
  await send(page, ''); await hit2;
  await page.fill('#prompt', '  next ');
  release2();
  await chips(0);
  assert.equal(await page.inputValue('#prompt'), '  next ', 'a photo-only send leaves what was typed meanwhile byte for byte');
  await page.fill('#prompt', '');
  // The sent photo shows in its message, fetched from the daemon by hash.
  await page.waitForSelector('#events .user-imgs img[src^="data:image/png;base64,"]', { timeout: 10000 });
  await page.locator('#events .user-imgs img').last().scrollIntoViewIfNeeded(); await shot(page, 'phone-sent-photo');
  // Four a message: the fifth is refused with the reason.
  await paste(5);
  await chips(4);
  await noted('Not attached: four images a message at most.');
  // Offline the text would queue; images are not queued, so nothing goes and the box keeps both.
  await page.evaluate(() => Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true }));
  await send(page, 'later');
  await noted('Not sent: attachments go only with a message sent now.');
  assert.equal(await page.inputValue('#prompt'), 'later');
  assert.equal(await page.isHidden('#queued'), true);
  await chips(4);
  await page.evaluate(() => Object.defineProperty(navigator, 'onLine', { get: () => true, configurable: true }));
  await send(page, 'look');
  await replied('echo:look' + seen.repeat(4));
  // After a reload the sent photos still show, fetched again by hash.
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#events .user-imgs img[src^="data:image/png;base64,"]').length === 6, null, { timeout: 15000 });
  // A2 step 1: any file goes as a file. The agent gets its real path in the chat's own folder and its edit is on disk; the sent
  // message names the file. One over 6 MiB is refused before sending, with the reason.
  await choose([{ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('from the phone') }]);
  await page.waitForSelector('#attached .chip-file >> text=notes.txt', { timeout: 10000 });
  await page.locator('#composer').scrollIntoViewIfNeeded(); await shot(page, 'phone-a2-file-chip');
  await send(page, 'edit attached');
  const reply = await (await page.waitForFunction(() => [...document.querySelectorAll('#events .md')].map((el) => el.textContent.trim()).find((text) => text.startsWith('edited:')), null, { timeout: 15000 })).jsonValue();
  const [name, uri] = reply.slice('edited:'.length).split('=');
  assert.equal(name, 'notes.txt');
  assert.match(uri, /\/attachments\/[0-9a-f-]+\/notes\.txt$/, 'saved in the chat\'s own folder');
  assert.equal(await readFile(fileURLToPath(uri), 'utf8'), 'from the phone edited by the agent', 'the agent\'s edit is on disk');
  await page.waitForSelector('#events .msg.user .sent-files >> text=notes.txt', { timeout: 10000 });
  await shot(page, 'phone-a2-file-sent');
  assert.equal(await page.isHidden('#attached'), true);
  await choose([{ name: 'big.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(6 * 1024 * 1024 + 1) }]);
  await noted('Not attached: big.bin: over 6 MiB, the most a file can be.');
  assert.equal(await page.isHidden('#attached'), true);
});
// CI job 135799199043: after the reload P8 saw fewer than its 5 sent photos for 15 s. The chat's folder answer redraws the
// chat while a photo is still loading; the redraw kept the list's key (the photo cache's size, unchanged when a photo lands),
// so the photo that arrived next drew nothing. Here the photo's answer is held until the folder answer has been drawn.
test('P8: a sent photo shows after a reload when the chat folder answer arrives before the photo', { timeout: 60000 }, async (t) => {
  const { page } = await phoneOn(t);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  await newChat(page, 'claude');
  await page.evaluate((b64) => {
    const dt = new DataTransfer(); dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'p.png', { type: 'image/png' }));
    document.querySelector('#prompt').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
  }, png);
  await page.waitForFunction(() => document.querySelectorAll('#attached .chip-img').length === 1, null, { timeout: 10000 });
  await send(page, 'look');
  await page.waitForFunction(() => document.querySelectorAll('#events .user-imgs img[src^="data:image/png;base64,"]').length === 1, null, { timeout: 15000 });
  const folder = page.waitForResponse((r) => /\/chat\/[^/]+\/folder$/.test(new URL(r.url()).pathname), { timeout: 15000 });
  let held = 0;
  await page.route('**/images/**', async (route) => { held += 1; await folder; await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50)))); await route.continue(); });
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#events .user-imgs img[src^="data:image/png;base64,"]').length === 1, null, { timeout: 15000 })
    .catch(async (e) => { throw new Error('the photo never drew (image requests held: ' + held + ', imgs: ' + await page.locator('#events .user-imgs img').count() + '): ' + e.message); });
});
test('P4: one tap on send posts the message and the box keeps focus (the keyboard stays up)', { timeout: 60000 }, async (t) => {
  const { page } = await phoneOn(t);
  await newChat(page, 'claude');
  await page.focus('#prompt');
  await page.fill('#prompt', 'one tap');
  await page.click('#composer button[type="submit"]');
  await page.waitForFunction(() => [...document.querySelectorAll('#events .md')].some((el) => el.textContent.includes('echo:one tap')), null, { timeout: 15000 });
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'prompt');
  assert.equal(await page.inputValue('#prompt'), '');
});
const sendLabel = (page, text) => page.waitForFunction((want) => document.querySelector('#composer button[type="submit"]').textContent === want, text, { timeout: 15000 });
const said = (page, text) => page.waitForFunction((want) => [...document.querySelectorAll('#events .md')].some((el) => el.textContent.includes(want)), text, { timeout: 15000 });
test('P4: during a turn, text goes in with Steer or waits with Queue, and a queued one can be taken back', { timeout: 90000 }, async (t) => {
  const { page } = await phoneOn(t);
  await newChat(page, 'claude');
  await send(page, 'slow');
  await said(page, 'working');
  await sendLabel(page, 'Stop');
  assert.equal(await page.isHidden('button[data-when="queue"]'), true, 'no Queue with an empty box');
  await page.fill('#prompt', 'later');
  await sendLabel(page, 'Steer');
  await page.click('button[data-when="queue"]');
  await page.waitForSelector('#queued:not([hidden]) article:has-text("later") >> text=Queued', { state: 'attached', timeout: 15000 });
  assert.equal(await page.inputValue('#prompt'), '');
  await page.evaluate(() => { const strip = document.querySelector('#queued details'); if (!strip.open) strip.querySelector('summary').click(); }); // O109: the queue is one folded line until opened
  await page.click('#queued [data-unhold]');
  await page.waitForFunction(() => document.querySelector('#prompt').value === 'later' && document.querySelector('#queued').hidden, null, { timeout: 15000 });
  await page.click('#composer button[type="submit"]');
  await said(page, 'got:later'); // the turn is left running: the daemon's teardown stops it
});
test('P4: with an empty box during a turn the send button is Stop, and Stop ends the turn', { timeout: 60000 }, async (t) => {
  const { page } = await phoneOn(t);
  await newChat(page, 'claude');
  await send(page, 'slow');
  await said(page, 'working');
  await sendLabel(page, 'Stop');
  await page.click('#composer button[type="submit"]');
  await sendLabel(page, 'Send message');
  await send(page, 'after');
  await said(page, 'echo:after');
});
// O21 (2026-11-23): Send read the Stop state left by the last redraw, not the box. Text that reached the box with no input
// event (a keyboard's own insert, dictation) after the box was empty during a turn made the tap a Stop: the turn was
// cancelled, or with no turn left nothing happened at all, until a key redrew the button.
test('O21: a tap on Send with text in the box sends it, even when the button still says Stop from an empty box', { timeout: 60000 }, async (t) => {
  const { page } = await phoneOn(t);
  await newChat(page, 'claude');
  await send(page, 'slow');
  await said(page, 'working');
  await sendLabel(page, 'Stop');
  const posts = [];
  page.on('request', (request) => { if (request.method() === 'POST' && /\/chat\/[^/]+\/(cancel|prompt)$/.test(new URL(request.url()).pathname)) posts.push([new URL(request.url()).pathname.split('/').pop(), request.postDataJSON()?.text]); });
  await page.evaluate(() => { document.querySelector('#prompt').value = 'nudge'; }); // no input event: the button still says Stop
  assert.equal(await page.textContent('#composer button[type="submit"]'), 'Stop');
  await page.click('#composer button[type="submit"]');
  // Sent, not just posted: the daemon took it (the box is cleared only on its 202) and it is in the chat.
  await page.waitForFunction(() => document.querySelector('#prompt').value === '' && [...document.querySelectorAll('#events article')].some((el) => el.textContent.includes('nudge')), null, { timeout: 15000 });
  await page.waitForTimeout(500);
  assert.deepEqual(posts, [['prompt', 'nudge']], 'the tap stopped the turn or sent nothing: ' + JSON.stringify(posts));
  console.log('PASS O21: text put in the box with no input event went as a send on the Stop-labelled button, nothing cancelled');
});
// P18: typing during a turn shows a slim card over the box (the desktop's Steer / Queue chip and its Ctrl Enter
// interrupt); Interrupt stops the turn and sends the text as the next prompt, and nothing typed is lost on the way.
test('P18: a card over the box during a turn: Steer, Queue, Interrupt; Interrupt stops the turn and sends', { timeout: 90000 }, async (t) => {
  const { page } = await phoneOn(t);
  await newChat(page, 'claude');
  await send(page, 'slow');
  await said(page, 'working');
  await sendLabel(page, 'Stop');
  assert.equal(await page.isHidden('#midTurn'), true, 'no card with an empty box');
  await page.fill('#prompt', 'do this instead');
  await page.waitForSelector('#midTurn:not([hidden])', { timeout: 5000 });
  assert.equal(await page.textContent('#midTurnLabel'), 'Claude is working');
  assert.equal(await page.$eval('#midTurnLabel', (el) => el.scrollWidth <= el.clientWidth), true, 'the label shows whole');
  assert.deepEqual(await page.$$eval('#midTurn button', (all) => all.map((b) => [b.textContent, b.dataset.when, b.offsetHeight >= 34])), [['Steer', 'steer', true], ['Queue', 'queue', true], ['Interrupt', 'now', true]]);
  const box = await page.$eval('#midTurn', (el) => { const r = el.getBoundingClientRect(), b = document.querySelector('#box').getBoundingClientRect(); return [Math.round(r.height), r.bottom <= b.top, r.right <= 390]; });
  assert.ok(box[0] <= 44 && box[1] && box[2], 'slim, above the box, on screen: ' + box);
  await shot(page, 'p18-card');
  await page.click('#midTurn [data-when="now"]');
  await said(page, 'echo:do this instead');
  assert.equal(await page.inputValue('#prompt'), '', 'sent, so the box is empty');
  assert.equal(await page.isHidden('#composerNote'), true, 'no error line');
});
test('P18: a message held for the turn comes back to the box when the turn is stopped', { timeout: 90000 }, async (t) => {
  const { page } = await phoneOn(t);
  await newChat(page, 'claude');
  await send(page, 'slow');
  await said(page, 'working');
  await page.fill('#prompt', 'keep me');
  await page.click('#midTurn [data-when="queue"]');
  await page.waitForSelector('#queued:not([hidden]) article:has-text("keep me")', { state: 'attached', timeout: 15000 });
  assert.equal(await page.inputValue('#prompt'), '');
  await page.click('#composer button[type="submit"]'); // the empty box's Stop
  await page.waitForFunction(() => document.querySelector('#prompt').value === 'keep me' && document.querySelector('#queued').hidden, null, { timeout: 15000 });
  await shot(page, 'p18-kept');
});
// #547 review: a GET /agents that landed after a new chat's start pick was drawn drew the Mode list again as "as set", so
// the next prompt went without the pick.
test('O267b: a late GET /agents keeps a new chat\'s start pick, and its prompt goes in it', { timeout: 90000 }, async (t) => {
  const { page } = await phoneOn(t);
  let reads = 0, release; const held = new Promise((resolve) => { release = resolve; });
  await page.route((url) => url.pathname === '/agents', async (route) => { if (++reads > 1) await held; return route.continue(); }); // the page's first read answers; the next ones wait
  await page.evaluate(() => localStorage.setItem('p9-mode:claude', 'Plan'));
  const first = page.waitForResponse((r) => new URL(r.url()).pathname === '/agents');
  await page.reload(); await first;
  await newChat(page, 'claude');
  assert.equal(await page.inputValue('#mode'), 'Plan', 'the new chat starts in the last pick');
  assert.ok(reads > 1, 'a GET /agents is still on its way');
  await page.evaluate(() => { window.modeDraws = 0; new MutationObserver(() => window.modeDraws++).observe(document.querySelector('#mode'), { childList: true }); });
  release();
  await page.waitForFunction(() => window.modeDraws > 0, null, { timeout: 10000 }); // the late answer drew the Mode list again
  assert.equal(await page.inputValue('#mode'), 'Plan', 'still the pick after the redraw');
  await send(page, 'mode');
  await said(page, 'mode:plan');
});
// #547 review: a malformed GET /agents answer replaced the agents' names before it was found malformed.
test('O267b: a malformed GET /agents answer keeps the names there are', { timeout: 90000 }, async (t) => {
  const { page } = await phoneOn(t);
  await page.route((url) => url.pathname === '/agents', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ agents: [{ id: 'claude', name: 'Broken', modes: 'not a list' }] }) }));
  const answered = page.waitForResponse((r) => new URL(r.url()).pathname === '/agents');
  await page.reload(); await answered;
  await newChat(page, 'claude');
  assert.equal(await page.getAttribute('#prompt', 'placeholder'), 'Message Claude');
});
test('P4: the message box is one line empty, grows to six, then scrolls; 16 px text', { timeout: 60000 }, async (t) => {
  const { page } = await phoneOn(t);
  await newChat(page, 'claude');
  const size = () => page.$eval('#prompt', (el) => [el.offsetHeight, el.scrollHeight > el.clientHeight, getComputedStyle(el).fontSize, el.placeholder, el.getAttribute('aria-label')]);
  assert.deepEqual(await size(), [34, false, '16px', 'Message Claude', 'Message']);
  await page.fill('#prompt', 'one\ntwo\nthree');
  assert.deepEqual((await size()).slice(0, 2), [78, false]);
  await page.fill('#prompt', Array.from({ length: 10 }, (_, i) => 'line ' + i).join('\n'));
  assert.deepEqual((await size()).slice(0, 2), [144, true]);
  await send(page, 'short');
  await page.waitForFunction(() => document.querySelector('#prompt').value === '' && document.querySelector('#prompt').offsetHeight === 34, null, { timeout: 15000 });
});
test('P4: the composer is one rounded box at the foot of the chat: the message, then +, the mode pill and a round send', { timeout: 60000 }, async (t) => {
  const { page } = await phoneOn(t);
  await newChat(page, 'claude');
  const rect = (sel) => page.locator(sel).boundingBox();
  const [slot, box, text, plus, pillBox, sendBox] = [await rect('#composerSlot'), await rect('#box'), await rect('#prompt'), await rect('#attach'), await rect('#modePill'), await rect('#send')];
  assert.deepEqual(await page.$eval('#box', (el) => [getComputedStyle(el).borderTopLeftRadius, el.parentElement.id]), ['22px', 'composerSlot']);
  assert.ok(box.x >= 8 && box.x + box.width <= 382 && box.y + box.height <= slot.y + slot.height, 'the box sits 8 px in from each side, inside the slot');
  // A chat hides the tab bar (c1's chat screen), so the slot is the foot of the screen.
  assert.ok(!await page.isVisible('nav') && Math.abs(slot.y + slot.height - 844) <= 1, 'the slot sits at the foot of the screen: ' + (slot.y + slot.height));
  // Line 2 under the message: + at the left, then the pill, the send at the right, all on one row inside the box.
  for (const [name, r] of [['+', plus], ['pill', pillBox], ['send', sendBox]]) assert.ok(r.y >= text.y + text.height - 0.5 && r.y + r.height <= box.y + box.height + 0.5, name + ' sits under the message, inside the box');
  assert.ok(plus.x < pillBox.x && pillBox.x + pillBox.width < sendBox.x && sendBox.x + sendBox.width >= box.x + box.width - 12, 'the row reads +, pill, then send at the right');
  assert.deepEqual([plus.width, plus.height, sendBox.width, sendBox.height], [44, 44, 36, 36]);
  assert.equal(await page.evaluate(() => document.elementFromPoint(...(({ x, y }) => [x - 3, y - 3])(document.querySelector('#send').getBoundingClientRect()))?.id), 'send', 'the send takes taps 4 px past its edge (a 44 px target)');
  assert.equal(await page.textContent('#modePill'), 'Mode ▾');
  await shot(page, 'phone-composer');
  // The pill opens the Mode sheet with the one in use ticked, and reads the pick after it.
  await page.click('#modePill');
  assert.equal(await page.textContent('#sheetTitle'), 'Mode');
  assert.deepEqual(await page.$$eval('#sheet[open] [data-mode]', (els) => els.map((el) => el.textContent + (el.getAttribute('aria-checked') === 'true' ? ' ✓' : ''))).then((l) => l.slice(0, 2)), ['As set ✓', 'Auto']);
  await shot(page, 'phone-mode-sheet');
  await page.click('#sheet[open] [data-mode="Auto"]');
  await page.waitForFunction(() => document.querySelector('#modePill').textContent === 'Auto ▾' && !document.querySelector('#sheet').open, null, { timeout: 5000 });
  assert.equal(await page.inputValue('#mode'), 'Auto');
  assert.equal(await page.getAttribute('#modePill', 'aria-label'), 'Mode: Auto');
  // The pickers went back home when the sheet closed (a later sheet's HTML would have wiped them). The dialog's close
  // event comes a task after open turns false, so this waits for it.
  await page.waitForSelector('#modeHome #more', { state: 'attached', timeout: 5000 });
  // The model is the top bar's Model sheet (c1's), the same path Phase 11 takes past its offline stop.
  const replied = (want) => page.waitForFunction((w) => [...document.querySelectorAll('#events .md')].some((el) => el.textContent.trim() === w), want, { timeout: 15000 });
  await send(page, 'model'); await replied('model:default');
  await page.click('#modelBtn'); await page.click('#sheet[open] [data-model="opus"]');
  await page.waitForFunction(() => !document.querySelector('#sheet').open, null, { timeout: 5000 });
  await send(page, 'model'); await replied('model:opus');
  // No sideways scroll on a 390 px phone.
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
});

// O55 (the message sent but its text stayed in the box, and each Send tap sent it again, mid-turn too): after a send the box is empty on every send path, a second tap on Send with nothing typed posts no prompt,
// and (next test) a mid-turn send the agent cannot take waits for the turn's end. Queue (the P4 test above), Interrupt (the P18 one) and the offline
// queue (phone-continue.test.mjs PH2) already assert their empty box; this one covers the default send as Steer, a held
// steer (a tool call running), a send with an image attached, the idle send, and the empty taps.
test('O55: a send empties the box on every path; an empty Send posts nothing', { timeout: 180000 }, async (t) => {
  const { page, server } = await phoneOn(t);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', bytes = Buffer.from(png, 'base64');
  const said = (want) => page.waitForFunction((w) => [...document.querySelectorAll('#events article')].some((el) => el.textContent.includes(w)), want, { timeout: 15000 });
  const noted = (want) => page.waitForFunction((w) => { const el = document.querySelector('#composerNote'); return !el?.hidden && el.textContent.includes(w); }, want, { timeout: 10000 });
  const untilLabel = (want) => page.waitForFunction((w) => document.querySelector('#composer button[type="submit"]').textContent === w, want, { timeout: 15000 });
  const box = () => page.inputValue('#prompt');
  let posts = 0;
  page.on('request', (request) => { try { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/prompt')) posts += 1; } catch {} });
  await newChat(page, 'claude');
  // Idle: the send empties the box, and a second tap with nothing typed posts nothing.
  await send(page, 'late'); await said('late reply');
  assert.equal(await box(), '', 'an idle send empties the box');
  const afterIdle = posts;
  await page.click('#composer button[type="submit"]');
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(posts, afterIdle, 'an empty Send with the agent idle posts no prompt');
  // The default send as Steer (no tool call running): the message goes into the turn and the box empties.
  await send(page, 'slow'); await said('working');
  const beforeSteer = posts;
  await send(page, 'steer me'); await said('got:steer me');
  assert.equal(await box(), '', 'a steered send empties the box');
  assert.equal(posts, beforeSteer + 1, 'the steer is one prompt post');
  // An empty tap mid-turn is Stop (P3), never a prompt; it ends the turn.
  await page.click('#composer button[type="submit"]');
  await untilLabel('Send message');
  assert.equal(posts, beforeSteer + 1, 'an empty Send mid-turn posts no prompt');
  // A held steer (a tool call running): held to the step's end, the box empties at once, one prompt post.
  await send(page, 'tools 1'); await page.waitForSelector('#events article[data-kind="tool"]', { timeout: 15000 });
  const beforeHeld = posts;
  await send(page, 'hold me');
  await page.waitForSelector('#queued:not([hidden]) article:has-text("hold me")', { state: 'attached', timeout: 10000 });
  assert.equal(await box(), '', 'a held steer empties the box');
  await said('got:hold me');
  assert.equal(posts, beforeHeld + 1, 'the held steer is one prompt post');
  // An image attached: the send empties the box and the chips.
  await page.evaluate((b64) => { const dt = new DataTransfer(), bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); dt.items.add(new File([bin], 'pic.png', { type: 'image/png' })); document.querySelector('#prompt').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt })); }, png);
  await page.waitForFunction(() => document.querySelectorAll('#attached .chip-img').length === 1, null, { timeout: 10000 });
  await send(page, 'with a picture');
  await said('echo:with a picture[image image/png ' + bytes.length + ']');
  assert.equal(await box(), '', 'a send with an image empties the box');
  assert.equal(await page.evaluate(() => document.querySelectorAll('#attached .chip-img').length), 0, 'the sent image leaves the chips');
  await shot(page, 'phone-o55-box-empty-after-send');
});

// O55 (2026-11-12, "the send button mid-turn does not send and the text stays"): an agent that takes no steering (the stand-in agent
// without steering), so the daemon answered a mid-turn send 409 turn-running (O255: it holds it now, 202). The phone keeps it for the turn's end
// as the desktop does: the box empties, the phone says Queued, and it is sent when the turn ends. Fails on main (the text stayed
// with "Not sent: turn-running"). A turn answering another chat's question (solo) is held by the daemon already (202), and
// only the daemon's own peer-help path can start one, so this test does not drive it.
test('O55: a mid-turn send the agent cannot steer waits for the turn to end, and the box empties', { timeout: 180000 }, async (t) => {
  const { page, server } = await phoneOn(t);
  await writeFile(path.join(server.workspace, 'no-steering'), ''); // read at the chat's start: its agent advertises no steering
  const said = (want) => page.waitForFunction((w) => [...document.querySelectorAll('#events article')].some((el) => el.textContent.includes(w)), want, { timeout: 30000 });
  await newChat(page, 'claude');
  await send(page, 'tools 1'); await page.waitForSelector('#events article[data-kind="tool"]', { timeout: 15000 });
  await send(page, 'after the turn');
  await page.waitForSelector('#queued:not([hidden]) article:has-text("after the turn")', { state: 'attached', timeout: 10000 });
  assert.equal(await page.inputValue('#prompt'), '', 'the box empties');
  assert.equal(await page.evaluate(() => document.querySelector('#composerNote').hidden), true, 'no "Not sent" note');
  assert.match(await page.textContent('#queued'), /Queued/);
  await shot(page, 'phone-o55-queued-mid-turn');
  await said('after the turn'); // sent as the next prompt once the tool call and the turn end
  assert.equal(await page.inputValue('#prompt'), '', 'the box is still empty once it has gone');
});

test('O55 round 1: two taps while the first send is still in flight send the message once, also through the queue fallback', { timeout: 180000 }, async (t) => {
  const { page, server } = await phoneOn(t);
  await writeFile(path.join(server.workspace, 'no-steering'), '');
  await newChat(page, 'claude');
  await send(page, 'tools 1'); await page.waitForSelector('#events article[data-kind="tool"]', { timeout: 15000 });
  // The first answer to the mid-turn send is held back, so the second tap lands while the first is still in flight.
  let release; const held = new Promise((resolve) => { release = resolve; });
  t.after(release); // a step before the release that fails must not leave the route held
  let first = true; const posts = [];
  page.on('request', (request) => { if (request.url().endsWith('/prompt')) posts.push(JSON.parse(request.postData()).when ?? 'now'); });
  await page.route((url) => url.pathname.endsWith('/prompt'), async (route) => { if (first) { first = false; await held; } await route.continue(); });
  await page.fill('#prompt', 'only once');
  await page.click('#composer button[type="submit"]');
  await page.click('#composer button[type="submit"]'); // the same text is still in the box: the first has not answered
  await page.waitForTimeout(500);
  const queuedAtOnce = await page.locator('#queued article').count();
  release();
  await page.waitForFunction(() => [...document.querySelectorAll('#events article')].some((el) => el.textContent.includes('only once')), null, { timeout: 40000 });
  await page.waitForTimeout(3000); // a duplicate would have gone out by now
  // The daemon may join held messages into one prompt, so count the text, not the articles.
  const users = await page.evaluate(() => [...document.querySelectorAll('#events article[data-kind="user"]')].reduce((sum, el) => sum + el.textContent.split('only once').length - 1, 0));
  t.diagnostic('O55r1 posts: ' + posts.join(',') + ' queued rows before release: ' + queuedAtOnce + ' users: ' + users);
  assert.equal(users, 1, 'the message shows once in the chat, not twice; prompt posts: ' + posts.join(',') + '; queued rows before release: ' + queuedAtOnce);
  await page.waitForFunction(() => [...document.querySelectorAll('#events article[data-kind="agent"]')].some((el) => el.textContent.includes('only once')), null, { timeout: 40000 });
  const replies = await page.evaluate(() => [...document.querySelectorAll('#events article[data-kind="agent"]')].reduce((sum, el) => sum + el.textContent.split('only once').length - 1, 0));
  assert.equal(replies, 1, 'exactly one reply to it, not one per duplicate: ' + replies);
  assert.equal(await page.inputValue('#prompt'), '', 'the box is empty');
});

test('O55 round 2: a send that never gets its answer lets go at the deadline, keeps the draft, and the retry sends it once', { timeout: 180000 }, async (t) => {
  const { page } = await phoneOn(t);
  await newChat(page, 'claude');
  // The daemon gets the first send and runs it, but its answer is held past the phone's deadline (the connection stays open).
  let release; const held = new Promise((resolve) => { release = resolve; });
  t.after(release);
  let first = true; const ops = [];
  page.on('request', (request) => { if (request.url().endsWith('/prompt')) ops.push(request.headers()['x-p9-op']); });
  await page.route((url) => url.pathname.endsWith('/prompt'), async (route) => {
    if (!first) return route.continue();
    first = false;
    // (route.fetch cannot resolve the .localhost name, so it goes to the loopback address with the page's own Host.)
    const request = route.request(), real = await route.fetch({ url: request.url().replace('app.p9.localhost', '127.0.0.1'), headers: { ...request.headers(), host: new URL(request.url()).host } });
    await held; await route.fulfill({ response: real }).catch(() => {});
  });
  await page.fill('#prompt', 'stalled once');
  await page.click('#composer button[type="submit"]');
  // Not before the deadline: the box is shut to a second tap meanwhile, and the text is still there.
  await page.waitForFunction(() => !document.querySelector('#composerNote').hidden, null, { timeout: 60000 });
  assert.match(await page.textContent('#composerNote'), /Not sent yet/);
  assert.equal(await page.inputValue('#prompt'), 'stalled once', 'the draft is kept');
  // The guard has let go: the same send again is the same operation, so the daemon replays what it already did.
  await page.click('#composer button[type="submit"]');
  await page.waitForFunction(() => document.querySelector('#prompt').value === '', null, { timeout: 15000 });
  await page.waitForFunction(() => [...document.querySelectorAll('#events article[data-kind="agent"]')].some((el) => el.textContent.includes('stalled once')), null, { timeout: 15000 });
  await page.waitForTimeout(2000);
  release();
  const count = (kind) => page.evaluate((k) => [...document.querySelectorAll('#events article[data-kind="' + k + '"]')].reduce((sum, el) => sum + el.textContent.split('stalled once').length - 1, 0), kind);
  t.diagnostic('O55r2 ops: ' + ops.join(','));
  assert.equal(ops.length, 2, 'two posts');
  assert.equal(ops[0], ops[1], 'the retry reuses the operation ID');
  assert.equal(await count('user'), 1, 'the message shows once');
  assert.equal(await count('agent'), 1, 'one reply');
});

// Round 3: three ways the send's recovery could still fail. Each of these failed on the round 2 head.
test('O55 round 3: Interrupt with a stalled event read lets go of the composer, keeps the draft, and a later send goes', { timeout: 180000 }, async (t) => {
  const { page } = await phoneOn(t);
  await newChat(page, 'claude');
  await send(page, 'slow');
  await said(page, 'working');
  await page.fill('#prompt', 'do this instead');
  await page.waitForSelector('#midTurn:not([hidden])', { timeout: 5000 });
  // Interrupt's own reads of the chat (wait=1000) never answer; the cancel itself does.
  let release; const held = new Promise((resolve) => { release = resolve; });
  t.after(release);
  await page.route((url) => url.pathname.endsWith('/chat/events') && url.search.includes('wait=1000'), async (route) => { await held; await route.abort().catch(() => {}); });
  await page.click('#midTurn [data-when="now"]');
  // Either the turn ended and the message went, or the box says it is still stopping and keeps the text: never locked.
  await page.waitForFunction(() => document.querySelector('#prompt').value === '' || (!document.querySelector('#composerNote').hidden && !/^Stopping/.test(document.querySelector('#composerNote').textContent)), null, { timeout: 60000 });
  await page.fill('#prompt', 'later one');
  await page.evaluate(() => document.querySelector('#composer').requestSubmit());
  // Sent or queued behind the turn, the box empties; a locked composer would leave the text there.
  await page.waitForFunction(() => document.querySelector('#prompt').value === '', null, { timeout: 15000 });
});

for (const status of [202, 409]) test(`O55 round 3: a ${status} whose body never finishes is not an answer: the draft stays and the retry is the same operation`, { timeout: 180000 }, async (t) => {
  const { page } = await phoneOn(t);
  await newChat(page, 'claude');
  // The first send reaches the daemon; the phone sees the status line and then a body that never ends.
  await page.evaluate((code) => {
    const real = window.fetch.bind(window); let first = true;
    window.fetch = async (input, init = {}) => {
      if (!String(input).endsWith('/prompt') || !first) return real(input, init);
      first = false;
      await real(input, { ...init, signal: undefined });
      const body = new ReadableStream({ start(controller) { init.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError'))); } });
      return new Response(body, { status: code, headers: { 'content-type': 'application/json' } });
    };
  }, status);
  const ops = [];
  page.on('request', (request) => { if (request.url().endsWith('/prompt')) ops.push(request.headers()['x-p9-op']); });
  await page.fill('#prompt', 'half answered');
  await page.click('#composer button[type="submit"]');
  await page.waitForFunction(() => /Not sent yet/.test(document.querySelector('#composerNote').textContent), null, { timeout: 60000 });
  assert.equal(await page.inputValue('#prompt'), 'half answered', 'the draft is kept: no complete answer came');
  await page.click('#composer button[type="submit"]');
  await page.waitForFunction(() => document.querySelector('#prompt').value === '', null, { timeout: 15000 });
  await said(page, 'echo:half answered');
  await page.waitForTimeout(2000);
  assert.equal(ops.length, 2, 'two posts');
  assert.equal(ops[0], ops[1], 'the retry reuses the operation ID');
  const users = await page.evaluate(() => [...document.querySelectorAll('#events article[data-kind="user"]')].reduce((sum, el) => sum + el.textContent.split('half answered').length - 1, 0));
  assert.equal(users, 1, 'the message shows once');
});

test('O55 round 3: a send that stalled while the turn started is retried as the same submission, not as a steer', { timeout: 180000 }, async (t) => {
  const { page } = await phoneOn(t);
  await newChat(page, 'claude');
  let release; const held = new Promise((resolve) => { release = resolve; });
  t.after(release);
  let first = true; const ops = [];
  page.on('request', (request) => { if (request.url().endsWith('/prompt')) ops.push(request.headers()['x-p9-op'] + ' ' + (JSON.parse(request.postData()).when ?? 'now')); });
  await page.route((url) => url.pathname.endsWith('/prompt'), async (route) => {
    if (!first) return route.continue();
    first = false;
    const request = route.request(), real = await route.fetch({ url: request.url().replace('app.p9.localhost', '127.0.0.1'), headers: { ...request.headers(), host: new URL(request.url()).host } });
    await held; await route.fulfill({ response: real }).catch(() => {});
  });
  await page.fill('#prompt', 'slow');
  await page.click('#composer button[type="submit"]');
  await page.waitForFunction(() => /Not sent yet/.test(document.querySelector('#composerNote').textContent), null, { timeout: 60000 });
  // The daemon ran the first send, so the turn is going now: the box would build a steer from the screen.
  await page.waitForSelector('#midTurn:not([hidden])', { timeout: 10000 });
  await page.click('#midTurn [data-when="steer"]');
  await page.waitForFunction(() => document.querySelector('#prompt').value === '', null, { timeout: 15000 });
  await page.waitForTimeout(2000);
  const users = await page.evaluate(() => [...document.querySelectorAll('#events article[data-kind="user"]')].reduce((sum, el) => sum + el.textContent.split('slow').length - 1, 0));
  assert.equal(ops.length, 2, 'two posts: ' + ops.join(' | '));
  assert.equal(ops[0].split(' ')[0], ops[1].split(' ')[0], 'the same operation ID, not a steer with a new one: ' + ops.join(' | '));
  assert.equal(users, 1, 'the message shows once');
});

// Round 4: the pending send's identity is what the user did, and it ends only with a definitive answer. Both failed on the round 3 head.
test('O55 round 4: timeout, then outcome-unknown, then a changed turn state, then another retry: the same ID and body throughout', { timeout: 180000 }, async (t) => {
  const { page } = await phoneOn(t);
  await newChat(page, 'claude');
  let release; const held = new Promise((resolve) => { release = resolve; });
  t.after(release);
  let calls = 0; const posts = [];
  page.on('request', (request) => { if (request.url().endsWith('/prompt')) posts.push(request.headers()['x-p9-op'] + ' ' + request.postData()); });
  await page.route((url) => url.pathname.endsWith('/prompt'), async (route) => {
    calls++;
    if (calls === 1) { // the daemon runs it, the answer is held past the deadline
      const request = route.request(), real = await route.fetch({ url: request.url().replace('app.p9.localhost', '127.0.0.1'), headers: { ...request.headers(), host: new URL(request.url()).host } });
      await held; return route.fulfill({ response: real }).catch(() => {});
    }
    // ponytail: the daemon's own outcome-unknown (the first try still running) is simulated, as in the round 3 body tests.
    if (calls === 2) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'outcome-unknown' }) });
    return route.continue();
  });
  await page.fill('#prompt', 'slow');
  await page.click('#composer button[type="submit"]');
  await page.waitForFunction(() => /Not sent yet/.test(document.querySelector('#composerNote').textContent), null, { timeout: 60000 });
  await page.waitForSelector('#midTurn:not([hidden])', { timeout: 10000 }); // the turn is running now: the box would build a steer
  await page.click('#midTurn [data-when="steer"]');
  await page.waitForFunction(() => /still working on your first try/.test(document.querySelector('#composerNote').textContent), null, { timeout: 15000 });
  assert.equal(await page.inputValue('#prompt'), 'slow', 'outcome-unknown is not an answer: the draft stays');
  await page.click('#midTurn [data-when="steer"]');
  await page.waitForFunction(() => document.querySelector('#prompt').value === '', null, { timeout: 15000 });
  await page.waitForTimeout(2000);
  const users = await page.evaluate(() => [...document.querySelectorAll('#events article[data-kind="user"]')].reduce((sum, el) => sum + el.textContent.split('slow').length - 1, 0));
  assert.equal(posts.length, 3, 'three posts: ' + posts.join(' | '));
  assert.deepEqual([...new Set(posts)].length, 1, 'the same ID and the same body each time: ' + posts.join(' | '));
  assert.equal(users, 1, 'the message shows once');
});

test('O55 round 4: a send that applied a picked effort keeps its identity when the adapter\'s config catches up, and the retry is the same operation', { timeout: 180000 }, async (t) => {
  const { page } = await phoneOn(t);
  await newChat(page, 'claude');
  let release; const held = new Promise((resolve) => { release = resolve; });
  t.after(release);
  let first = true; const posts = [];
  page.on('request', (request) => { if (request.url().endsWith('/prompt')) posts.push(request.headers()['x-p9-op'] + ' ' + request.postData()); });
  await page.route((url) => url.pathname.endsWith('/prompt'), async (route) => {
    if (!first) return route.continue();
    first = false;
    const request = route.request(), real = await route.fetch({ url: request.url().replace('app.p9.localhost', '127.0.0.1'), headers: { ...request.headers(), host: new URL(request.url()).host } });
    await held; await route.fulfill({ response: real }).catch(() => {});
  });
  await page.click('#modePill');
  await page.waitForSelector('#sheet[open] #pickers select[data-config="effort"]', { timeout: 10000 });
  await page.selectOption('#pickers select[data-config="effort"]', 'high');
  await page.keyboard.press('Escape');
  await page.fill('#prompt', 'effort retry');
  await page.click('#composer button[type="submit"]');
  // The daemon applied the effort before its answer stalled: the page's picker now reports it as current, so the screen no longer differs.
  await page.waitForFunction(() => document.querySelector('#pickers select[data-config="effort"]')?.dataset.current === 'high', null, { timeout: 30000 });
  await page.waitForFunction(() => /Not sent yet/.test(document.querySelector('#composerNote').textContent), null, { timeout: 60000 });
  await page.click('#composer button[type="submit"]');
  await page.waitForFunction(() => document.querySelector('#prompt').value === '', null, { timeout: 15000 });
  await page.waitForTimeout(2000);
  const users = await page.evaluate(() => [...document.querySelectorAll('#events article[data-kind="user"]')].reduce((sum, el) => sum + el.textContent.split('effort retry').length - 1, 0));
  assert.equal(posts.length, 2, 'two posts: ' + posts.join(' | '));
  assert.equal(posts[0], posts[1], 'the same ID and the same body (the picked effort included): ' + posts.join(' | '));
  assert.equal(users, 1, 'the message shows once');
});

// Round 5: the pending send's identity is the settings the user chose and that took effect. A cancelled warning, a no-op pick and an
// away-and-back change none of them, so the retry is still the same submission. Each failed on the round 4 head (it counted change events).
for (const how of ['a cancelled mode warning', 'a pick of the value already selected', 'a model changed away and back']) test(`O55 round 5: ${how} between the stalled send and its retry leaves the same ID and body`, { timeout: 180000 }, async (t) => {
  const { page } = await phoneOn(t);
  await newChat(page, 'codex');
  let release; const held = new Promise((resolve) => { release = resolve; });
  t.after(release);
  let first = true; const posts = [];
  page.on('request', (request) => { if (request.url().endsWith('/prompt')) posts.push(request.headers()['x-p9-op'] + ' ' + request.postData()); });
  await page.route((url) => url.pathname.endsWith('/prompt'), async (route) => {
    if (!first) return route.continue();
    first = false;
    const request = route.request(), real = await route.fetch({ url: request.url().replace('app.p9.localhost', '127.0.0.1'), headers: { ...request.headers(), host: new URL(request.url()).host } });
    await held; await route.fulfill({ response: real }).catch(() => {});
  });
  await page.fill('#prompt', 'slow');
  await page.click('#composer button[type="submit"]');
  await page.waitForFunction(() => /Not sent yet/.test(document.querySelector('#composerNote').textContent), null, { timeout: 60000 });
  if (how.includes('warning')) {
    await pickMode(page, 'Full access');
    await page.waitForFunction(() => document.querySelector('#looseDlg').open, null, { timeout: 5000 });
    await page.click('#looseDlg button[value="no"]');
    await page.waitForFunction(() => document.querySelector('#mode').value === '', null, { timeout: 5000 }); // Chromium closes the dialog a frame late
  } else await page.evaluate((away) => { // what the model menu does: set the value and fire change
    const model = document.querySelector('#model'), pick = (value) => { model.value = value; model.dispatchEvent(new Event('change')); }, now = model.value;
    if (away) { pick([...model.options].find((option) => option.value !== now).value); pick(now); } else pick(now);
  }, how.includes('away'));
  // The daemon ran the first send, so the turn is going now: the box would build a steer from the screen.
  await page.waitForSelector('#midTurn:not([hidden])', { timeout: 10000 });
  await page.click('#midTurn [data-when="steer"]');
  await page.waitForFunction(() => document.querySelector('#prompt').value === '', null, { timeout: 15000 });
  await page.waitForTimeout(2000);
  const users = await page.evaluate(() => [...document.querySelectorAll('#events article[data-kind="user"]')].reduce((sum, el) => sum + el.textContent.split('slow').length - 1, 0));
  assert.equal(posts.length, 2, 'two posts: ' + posts.join(' | '));
  assert.equal(posts[0], posts[1], 'the same ID and the same body: ' + posts.join(' | '));
  assert.equal(users, 1, 'the message shows once');
});
// Threat model row O48p: the phone starts chats with any provider.
test('CAT-1f on the phone: New chat lists every agent from GET /agents, a new one too', { timeout: 90000 }, async (t) => {
  const { page } = await phoneOn(t);
  // The real answer is read in the page (only the browser resolves the test host), then served with a third agent.
  const body = await page.evaluate(() => fetch('/agents').then((r) => r.json()));
  body.agents.push({ id: 'tester', name: 'Test Agent', short: 'Tester', modes: [{ name: 'Careful', tier: 0 }] });
  await page.route('**/agents', (route) => route.fulfill({ json: body }));
  await page.reload(); await page.locator('#newChat').waitFor();
  await page.click('#newChat'); await page.locator('#sheet[open]').waitFor();
  assert.deepEqual(await page.locator('#sheet[open] [data-new]').evaluateAll((all) => all.map((b) => b.dataset.new + ':' + b.textContent)),
    ['claude:New Claude chat', 'codex:New Codex chat', 'tester:New Tester chat']);
});
// USE-1 web on the phone: one plan card per agent in /usage limits, named from GET /agents (as text), each with its own
// signed-out mark and the daemon's stale mark, and two agents on one plan say so.
test('USE-1 web on the phone: Usage draws one plan card per agent in the usage limits, shared plans marked', { timeout: 90000 }, async (t) => {
  const { page } = await phoneOn(t);
  const [agents, usage] = await page.evaluate(() => Promise.all(['/agents', '/usage'].map((p) => fetch(p).then((r) => r.json()))));
  agents.agents.push({ id: 'kestrel', name: 'Kestrel Agent', short: '<i>Kes</i>', modes: [{ name: 'Careful', tier: 0 }] });
  const now = Date.now(), w = (p) => ({ usedPercent: p, resetsAt: now + 3600000, windowMins: 300 });
  usage.limits = { claude: { asOf: now, fiveHour: w(40), sevenDay: null, stale: false, pool: 'claude', sharedWith: ['kestrel'] }, codex: null,
    kestrel: { asOf: now - 20 * 60000, fiveHour: w(40), sevenDay: null, stale: true, pool: 'claude', sharedWith: ['claude'] }, signedOut: ['codex'] };
  // GET /agents answers 8 s late, after Usage is drawn with the bare id: the cards take the name within 3 s of the answer,
  // not at the next 20 s redraw.
  let answered; const named = new Promise((r) => { answered = r; });
  await page.route('**/agents', async (route) => { await new Promise((r) => setTimeout(r, 8000)); await route.fulfill({ json: agents }); answered(); });
  await page.route('**/usage', (route) => route.fulfill({ json: usage }));
  await page.reload(); await page.locator('#newChat').waitFor();
  await page.click('[data-nav="usage"]');
  const read = () => page.locator('#usage [data-limits] article.plan').evaluateAll((all) => all.map((a) => [a.querySelector('h2').textContent, a.querySelector('small').textContent, a.classList.contains('muted')]));
  const card = (want) => page.waitForFunction((w) => [...document.querySelectorAll('#usage [data-limits] h2')].some((h) => h.textContent === w), want, { timeout: 3000 });
  await page.waitForFunction(() => [...document.querySelectorAll('#usage [data-limits] h2')].some((h) => h.textContent === 'kestrel plan'), null, { timeout: 7000 });
  await named; await card('<i>Kes</i> plan').catch(() => {});
  assert.deepEqual(await read(), [['Claude plan', 'Last read just now · shared plan with <i>Kes</i>', false], ['Codex plan', 'Codex not logged in', true],
    ['<i>Kes</i> plan', 'Last read 20 min ago · shared plan with Claude', true]]);
  assert.equal(await page.locator('#usage i:text-is("Kes")').count(), 0, 'the name is text, not markup');
});
// #547 review 3: the agents' names arriving drew the plan cards again from the last read even after a newer read failed,
// so the cards came back over its "Usage unavailable".
test('USE-1 web on the phone: names arriving after a failed Usage read leave "Usage unavailable" up', { timeout: 90000 }, async (t) => {
  const { page } = await phoneOn(t);
  const usage = await page.evaluate(() => fetch('/usage').then((r) => r.json()));
  usage.limits = { claude: { asOf: Date.now(), fiveHour: { usedPercent: 40, resetsAt: Date.now() + 3600000, windowMins: 300 }, sevenDay: null, stale: false }, codex: null };
  let release; const held = new Promise((r) => { release = r; }); t.after(() => release());
  await page.route('**/agents', async (route) => { await held; await route.continue().catch(() => {}); });
  let reads = 0;
  await page.route('**/usage', (route) => (++reads === 1 ? route.fulfill({ json: usage }) : route.abort()));
  await page.reload(); await page.locator('#newChat').waitFor();
  await page.click('[data-nav="usage"]');
  await page.waitForSelector('#usage [data-limits]', { timeout: 15000 }); // the first read drew
  await page.click('#refreshUsage');
  await page.waitForSelector('#usage h2:text-is("Usage unavailable")', { timeout: 15000 }); // the second failed
  const named = page.waitForResponse((r) => new URL(r.url()).pathname === '/agents');
  release(); await named; await page.waitForTimeout(500); // the names' redraw acts by now
  assert.equal(await page.locator('#usage h2:text-is("Usage unavailable")').count(), 1, 'the failure is still shown');
  assert.equal(await page.locator('#usage [data-limits]').count(), 0, 'no cards from the older read');
});
test('O48 on the phone: New chat lists each provider profile\'s models; the chat it starts is on that profile and model; the phone reads id, name and model names only', { timeout: 90000 }, async (t) => {
  const { page, server, session } = await phoneOn(t);
  const KEY = 'sk-profile-test-0f3a9c71d2e84b56';
  const saved = await server.desk('/profiles', 'POST', { name: 'Far <b>Cloud', baseUrl: 'https://models.example.test/api/', models: ['glm-5.3', 'kimi-k3:cloud'], key: KEY });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const id = saved.body.profile.id;
  const names = await server.remote('/profiles/names', { session });
  assert.deepEqual(names.body, { profiles: [{ id, name: 'Far <b>Cloud', models: ['glm-5.3', 'kimi-k3:cloud'] }] }, 'the phone read more or less than id, name and model names');
  for (const never of ['models.example.test', KEY, 'baseUrl', 'secret', 'command']) assert.ok(!names.text.includes(never), 'the phone\'s read holds ' + never);
  assert.equal((await server.remote('/profiles/names')).status, 401, 'the names were read with no session');
  assert.equal((await server.remote('/profiles', { session })).status, 404);
  // A model the profile does not list: refused, nothing made.
  const before = (await server.desk('/chat')).body.conversations.length;
  assert.equal((await server.remote('/chat', { method: 'POST', session, body: { provider: 'claude', profile: id, model: 'opus' }, headers: { 'x-p9-op': crypto.randomUUID() } })).status, 400);
  assert.equal((await server.desk('/chat')).body.conversations.length, before, 'a refused profile chat was made');
  await page.waitForSelector('#newChat');
  if (await page.isVisible('[data-bar="chat"] [data-back]')) await page.click('[data-bar="chat"] [data-back]');
  await page.click('#newChat');
  await page.waitForSelector('#sheet[open] [data-profile]');
  assert.deepEqual(await page.$$eval('#sheet .opt', (rows) => rows.map((row) => row.textContent)), ['New Claude chat', 'New Codex chat', 'New Far <b>Cloud chat · glm-5.3', 'New Far <b>Cloud chat · kimi-k3:cloud']);
  assert.equal(await page.locator('#sheet b').count(), 0, 'a profile name was drawn as markup');
  assert.ok(!(await page.content()).includes('models.example.test'), 'the phone page holds the base URL');
  await shot(page, 'o48p-new-chat');
  const made = page.waitForResponse((response) => new URL(response.url()).pathname === '/chat' && response.request().method() === 'POST', { timeout: 10000 });
  await page.click('#sheet[open] [data-profile-model="kimi-k3:cloud"]');
  const reply = await made; assert.equal(reply.status(), 201, await reply.text());
  const chat = String((await reply.json()).conversation);
  await page.waitForFunction((id) => location.hash === '#chat=' + id && document.querySelector('#conversation').value === id, chat, { timeout: 10000 });
  const row = (await server.desk('/chat')).body.conversations.find((c) => c.id === chat);
  assert.deepEqual([row.provider, row.profile?.id, row.profile?.model], ['claude', id, 'kimi-k3:cloud'], 'the chat the phone started is not on the profile and model picked');
  console.log('PASS O48 on the phone: names read as id, name, models only (no base URL, key or key kind; 401 with no session; /profiles still 404); the sheet listed both models with the name as text; the chat started on the profile and model picked; an unlisted model was refused with no chat');
});

// O204 (O133's rule on the phone): the top bar names the model the chat runs, from its last config, not the last pick. A pick
// not taken yet shows as pending beside it, mid-turn and after a turn with no config, until a config reports it.
test('O204: a model picked mid-turn on the phone shows as pending; the bar keeps the running model until the config reports the pick', { timeout: 90000 }, async (t) => {
  const { page } = await phoneOn(t);
  const replied = (want) => page.waitForFunction((w) => [...document.querySelectorAll('#events .md')].some((el) => el.textContent.trim() === w), want, { timeout: 15000 });
  const bar = () => page.evaluate(() => { const b = document.querySelector('#modelBtn'); return [b.textContent.trim(), b.getAttribute('aria-label')]; });
  // The visible text first, so the old bar (the last pick, a bare 'Model' label) fails on what the reader sees.
  const is = async ([text, label], why = 'the bar') => { const [t1, l1] = await bar(); assert.equal(t1, text, why); assert.equal(l1, label, why); };
  const pick = async (value) => { await page.click('#modelBtn'); await page.click(`#sheet[open] [data-model="${value}"]`); await page.waitForFunction(() => !document.querySelector('#sheet').open, null, { timeout: 5000 }); };
  const running = ['Claude · Default (recommended)', 'Model: Default (recommended)'];
  await newChat(page, 'claude');
  await send(page, 'model'); await replied('model:default');
  await page.waitForFunction(() => !document.querySelector('[data-bar="chat"] .run'), null, { timeout: 15000 });
  assert.equal((await bar())[0], running[0]);
  // Picked and picked back: nothing pending.
  await pick('haiku'); await is(['Claude · Default (recommended) → Haiku', 'Model: Default (recommended), Haiku pending']);
  await pick('default'); await is(running);
  // Mid-turn (a tool call running): the pick is pending, the running model stays named.
  await send(page, 'tools 1'); await page.locator('[data-bar="chat"] .run').waitFor({ timeout: 10000 });
  await pick('opus');
  const pending = ['Claude · Default (recommended) → Opus', 'Model: Default (recommended), Opus pending'];
  await is(pending, 'mid-turn: the running model, the pick pending');
  await shot(page, 'o204-pending');
  assert.ok(await page.evaluate(() => { const q = document.querySelector('#modelBtn .pick-q').getBoundingClientRect(), b = document.querySelector('#modelBtn').getBoundingClientRect(); return q.width > 0 && q.right <= b.right + 0.5; }), 'the pending pick is in view on a 390 px bar beside Stop');
  await page.waitForFunction(() => !document.querySelector('[data-bar="chat"] .run'), null, { timeout: 20000 });
  await is(pending, 'the turn ended with no config for the pick: still pending');
  // The pick goes with the next send; the config that reports it moves the bar.
  await send(page, 'config'); await page.waitForFunction(() => [...document.querySelectorAll('#events .md')].some((el) => el.textContent.trim().startsWith('config:model=opus')), null, { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('#modelBtn').getAttribute('aria-label') === 'Model: Opus', null, { timeout: 10000 });
  assert.equal((await bar())[0], 'Claude · Opus');
  await shot(page, 'o204-taken');
});

// O204 review 1: a send refused for good leaves no pick pending (a newer pick made while it was on its way stays pending); an unsent
// pick does not outlive a reload; a running model the list no longer offers is named by its id, never by the option the select fell back to.
test('O204 review: a refused send clears its pick, a newer pick stays pending, a reload drops an unsent pick, a running model missing from the list is named by its id', { timeout: 120000 }, async (t) => {
  const { page, server } = await phoneOn(t);
  const replied = (want) => page.waitForFunction((w) => [...document.querySelectorAll('#events .md')].some((el) => el.textContent.trim() === w), want, { timeout: 15000 });
  const bar = () => page.evaluate(() => { const b = document.querySelector('#modelBtn'); return [b.textContent.trim(), b.getAttribute('aria-label')]; });
  const is = async (want, why) => assert.deepEqual(await bar(), want, why);
  const pick = async (value) => { await page.click('#modelBtn'); await page.click(`#sheet[open] [data-model="${value}"]`); await page.waitForFunction(() => !document.querySelector('#sheet').open, null, { timeout: 5000 }); };
  const noted = (want) => page.waitForFunction((w) => document.querySelector('#composerNote').textContent.includes(w), want, { timeout: 10000 });
  const running = ['Claude · Default (recommended)', 'Model: Default (recommended)'];
  const id = await newChat(page, 'claude');
  await send(page, 'model'); await replied('model:default');
  await page.waitForFunction(() => !document.querySelector('[data-bar="chat"] .run'), null, { timeout: 15000 });
  // A forced refusal: the pick that went with it is not pending, and the next send carries no model.
  const prompts = (url) => url.pathname.endsWith('/prompt'); // one matcher: unroute takes the same function
  const refuse = (route) => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'model-refused' }) });
  await page.route(prompts, refuse);
  await pick('haiku'); await send(page, 'refused one'); await noted('Not sent: model-refused');
  await is(running, 'refused: the rejected pick still shows as pending');
  assert.equal(await page.evaluate(() => document.querySelector('#model').value), 'default', 'refused: the select still holds the rejected pick');
  await page.unroute(prompts);
  // A newer pick made while a send is on its way stays pending when that send is refused.
  let release; const held = new Promise((resolve) => { release = resolve; }); t.after(() => release());
  await page.route(prompts, async (route) => { await held; await refuse(route).catch(() => {}); });
  await pick('opus'); await send(page, 'refused two');
  await page.waitForFunction(() => document.querySelector('#prompt').value === 'refused two', null, { timeout: 5000 });
  await pick('haiku'); release(); await noted('Not sent: model-refused');
  await is(['Claude · Default (recommended) → Haiku', 'Model: Default (recommended), Haiku pending'], 'a newer pick made during a refused send');
  await page.unroute(prompts);
  // A reload: an unsent pick is not kept, so the bar names the running model with nothing pending.
  await page.fill('#prompt', '');
  await page.reload();
  await page.waitForFunction((id) => document.querySelector('#conversation').value === id && document.querySelector('#modelBtn')?.textContent.includes('Default'), id, { timeout: 15000 });
  await is(running, 'after a reload');
  // The phone's own queue: a send answered 'turn-running' waits there, and its later send is refused for good: no pick pending.
  let tries = 0;
  const queueThenRefuse = (route) => (tries++ ? refuse(route) : route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'turn-running' }) }));
  await send(page, 'tools 1'); await page.locator('[data-bar="chat"] .run').waitFor({ timeout: 10000 });
  await page.route(prompts, queueThenRefuse);
  await pick('opus'); await send(page, 'queued one'); await noted('Not sent: model-refused');
  assert.equal(tries, 2, 'the queued send went once more and was refused');
  await is(running, 'a queued send refused for good: its pick still shows as pending');
  await page.unroute(prompts);
  await page.waitForFunction(() => !document.querySelector('[data-bar="chat"] .run'), null, { timeout: 20000 });
  await page.fill('#prompt', '');
  // The list stops offering the running model (the agent's next report): the bar names it by its id, nothing pending.
  await writeFile(path.join(server.workspace, 'models.json'), JSON.stringify([{ value: 'opus', name: 'Opus' }, { value: 'haiku', name: 'Haiku' }]));
  await page.click('#modePill');
  await page.waitForSelector('#sheet[open] #pickers select[data-config="effort"]', { timeout: 10000 });
  await page.selectOption('#pickers select[data-config="effort"]', 'high');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#sheet').open, null, { timeout: 5000 });
  await send(page, 'config'); await page.waitForFunction(() => [...document.querySelectorAll('#events .md')].some((el) => el.textContent.trim().startsWith('config:model=default,effort=high')), null, { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('#model').dataset.current === 'default' && ![...document.querySelector('#model').options].some((o) => o.value === 'default'), null, { timeout: 10000 });
  await is(['Claude · default', 'Model: default'], 'the running model missing from the list');
  // A pick made there is pending against that id.
  await pick('haiku'); await is(['Claude · default → Haiku', 'Model: default, Haiku pending'], 'a pick with the running model missing from the list');
  console.log('PASS O204 review: refused pick cleared; newer pick kept; reload drops an unsent pick; missing running model named by its id');
});

// O206: a refused send clears only the pick it carried. Opus goes and is held, the user picks Haiku and then Opus again, and
// the old refusal arrives: the newer Opus pick stays pending. The same through the phone's own queue. A plain refusal still clears.
test('O206: a refused send clears its own pick, not a newer pick of the same model, from the box and from the queue', { timeout: 120000 }, async (t) => {
  const { page } = await phoneOn(t);
  const replied = (want) => page.waitForFunction((w) => [...document.querySelectorAll('#events .md')].some((el) => el.textContent.trim() === w), want, { timeout: 15000 });
  const bar = () => page.evaluate(() => { const b = document.querySelector('#modelBtn'); return [b.textContent.trim(), b.getAttribute('aria-label')]; });
  const is = async (want, why) => assert.deepEqual(await bar(), want, why);
  const pick = async (value) => { await page.click('#modelBtn'); await page.click(`#sheet[open] [data-model="${value}"]`); await page.waitForFunction(() => !document.querySelector('#sheet').open, null, { timeout: 5000 }); };
  const noted = (want) => page.waitForFunction((w) => document.querySelector('#composerNote').textContent.includes(w), want, { timeout: 10000 });
  const running = ['Claude · Default (recommended)', 'Model: Default (recommended)'], opusPending = ['Claude · Default (recommended) → Opus', 'Model: Default (recommended), Opus pending'];
  await newChat(page, 'claude');
  await send(page, 'model'); await replied('model:default');
  await page.waitForFunction(() => !document.querySelector('[data-bar="chat"] .run'), null, { timeout: 15000 });
  const prompts = (url) => url.pathname.endsWith('/prompt'); // one matcher: unroute takes the same function
  const refuse = (route) => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'model-refused' }) });
  let release = () => {}; t.after(() => release());
  // From the box: Opus held, Haiku, Opus again, then the refusal.
  let held = new Promise((resolve) => { release = resolve; });
  await page.route(prompts, async (route) => { await held; await refuse(route).catch(() => {}); });
  await pick('opus'); await send(page, 'refused box');
  await page.waitForFunction(() => document.querySelector('#prompt').value === 'refused box', null, { timeout: 5000 });
  await pick('haiku'); await pick('opus'); release(); await noted('Not sent: model-refused');
  await is(opusPending, 'box: the newer Opus pick was cleared by the old refusal');
  await page.unroute(prompts);
  // A plain refusal (nothing picked after it) still clears its pick.
  await page.evaluate(() => { document.querySelector('#composerNote').textContent = ''; });
  await page.route(prompts, refuse);
  await page.fill('#prompt', ''); await send(page, 'refused plain'); await noted('Not sent: model-refused');
  await is(running, 'plain refusal: its pick still shows as pending');
  await page.unroute(prompts);
  await page.fill('#prompt', '');
  // A retry: the first try (Opus) gets outcome-unknown, Haiku then Opus are picked, the same text is sent again (the same send),
  // and the daemon's final answer to it is a refusal. That refusal is the first try's: the newer Opus pick stays pending.
  let calls = 0;
  await page.route(prompts, (route) => ++calls === 1 ? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'outcome-unknown' }) }) : refuse(route));
  await page.evaluate(() => { document.querySelector('#composerNote').textContent = ''; });
  await pick('opus'); await send(page, 'retried'); await noted('Not sent yet');
  await pick('haiku'); await pick('opus');
  await page.evaluate(() => { document.querySelector('#composerNote').textContent = ''; });
  await send(page, 'retried'); await noted('Not sent: model-refused');
  assert.equal(calls, 2, 'the retry went once more');
  await is(opusPending, 'retry: the replayed refusal of the first try cleared the newer Opus pick');
  await page.unroute(prompts);
  await pick('default'); await is(running);
  await page.fill('#prompt', '');
  // Through the queue: 'turn-running' queues the Opus send; once the drain's send is held, Haiku and Opus are picked, then it is refused.
  held = new Promise((resolve) => { release = resolve; });
  let tries = 0;
  await send(page, 'tools 1'); await page.locator('[data-bar="chat"] .run').waitFor({ timeout: 10000 });
  await page.route(prompts, async (route) => { if (!tries++) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'turn-running' }) }); await held; await refuse(route).catch(() => {}); });
  await page.evaluate(() => { document.querySelector('#composerNote').textContent = ''; });
  await pick('opus'); await send(page, 'queued one');
  for (let i = 0; i < 300 && tries < 2; i++) await page.waitForTimeout(100);
  assert.equal(tries, 2, 'the queued send went once more');
  await pick('haiku'); await pick('opus'); release(); await noted('Not sent: model-refused');
  await is(opusPending, 'queue: the newer Opus pick was cleared by the old refusal');
  await page.unroute(prompts);
  // A send kept in storage from before picks had a pid comes back after a reload; the same text sent again is that send (its draft
  // matches), and refused for good, its pick still clears.
  const id = await page.evaluate(() => document.querySelector('#conversation').value);
  await page.fill('#prompt', '');
  await page.evaluate((id) => localStorage.setItem('p9-inflight', JSON.stringify({ [id]: { draft: JSON.stringify(['kept', [], JSON.stringify([['model', 'opus']])]), sent: { text: 'kept, first try', model: 'opus' }, picks: [['model', { base: '', value: 'opus' }]] } })), id);
  await page.reload();
  await page.waitForFunction((id) => document.querySelector('#conversation').value === id && document.querySelector('#modelBtn')?.textContent.includes('Default'), id, { timeout: 15000 });
  await is(opusPending, 'a kept send: its pick shows as pending after the reload');
  let went; await page.route(prompts, (route) => { went = route.request().postDataJSON(); return refuse(route); });
  await send(page, 'kept'); await noted('Not sent: model-refused');
  assert.equal(went?.text, 'kept, first try', 'the kept send went again as itself (its first body), not rebuilt from the box');
  await is(running, 'a kept send without a pid: its refused pick still shows as pending');
  await page.unroute(prompts);
  console.log('PASS O206: newer same-model pick kept after an old refusal (box and queue); plain and kept-send refusals clear');
});
// O209: the queue transfer spends the model pick the send carried, by its pid. Opus goes and is held, the user picks Haiku and then
// Opus again, the held send is answered 'turn-running' and moves to the queue, and the queue's send is refused: the newer Opus
// stays pending. The same when the first try got outcome-unknown and the retry is the one answered 'turn-running'.
test('O209: a send moved to the queue keeps a newer pick of the same value, model or effort, held or retried, and spends it once the queued send is taken', { timeout: 120000 }, async (t) => {
  const { page, server } = await phoneOn(t);
  const replied = (want) => page.waitForFunction((w) => [...document.querySelectorAll('#events .md')].some((el) => el.textContent.trim() === w), want, { timeout: 15000 });
  const bar = () => page.evaluate(() => { const b = document.querySelector('#modelBtn'); return [b.textContent.trim(), b.getAttribute('aria-label')]; });
  const is = async (want, why) => assert.deepEqual(await bar(), want, why);
  const pick = async (value) => { await page.click('#modelBtn'); await page.click(`#sheet[open] [data-model="${value}"]`); await page.waitForFunction(() => !document.querySelector('#sheet').open, null, { timeout: 5000 }); };
  const noted = (want) => page.waitForFunction((w) => document.querySelector('#composerNote').textContent.includes(w), want, { timeout: 10000 });
  const clear = () => page.evaluate(() => { document.querySelector('#composerNote').textContent = ''; });
  const running = ['Claude · Default (recommended)', 'Model: Default (recommended)'], opusPending = ['Claude · Default (recommended) → Opus', 'Model: Default (recommended), Opus pending'];
  await newChat(page, 'claude');
  await send(page, 'model'); await replied('model:default');
  await page.waitForFunction(() => !document.querySelector('[data-bar="chat"] .run'), null, { timeout: 15000 });
  const prompts = (url) => url.pathname.endsWith('/prompt'); // one matcher: unroute takes the same function
  const busy = (route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'turn-running' }) });
  const refuse = (route) => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'model-refused' }) });
  let release = () => {}; t.after(() => release());
  // Held: the first send (Opus) waits, Haiku then Opus are picked, then 'turn-running' moves it to the queue, whose send is refused.
  const held = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  await page.route(prompts, async (route) => { if (++calls === 1) { await held; return busy(route).catch(() => {}); } return refuse(route); });
  await pick('opus'); await send(page, 'held');
  await page.waitForFunction(() => document.querySelector('#prompt').value === 'held', null, { timeout: 5000 });
  await pick('haiku'); await pick('opus'); await clear(); release(); await noted('Not sent: model-refused');
  assert.equal(calls, 2, 'the held send moved to the queue and the queue sent it');
  await is(opusPending, 'held: moving the send to the queue spent the newer Opus pick');
  await page.unroute(prompts);
  await pick('default'); await is(running);
  await page.fill('#prompt', '');
  // Retried: the first try (Opus) gets outcome-unknown, Haiku then Opus are picked, the retry is answered 'turn-running' and moves
  // to the queue (carrying the first try's pick), whose send is refused.
  calls = 0;
  await page.route(prompts, (route) => ++calls === 1 ? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'outcome-unknown' }) }) : calls === 2 ? busy(route) : refuse(route));
  await clear(); await pick('opus'); await send(page, 'retried'); await noted('Not sent yet');
  await pick('haiku'); await pick('opus'); await clear();
  await send(page, 'retried'); await noted('Not sent: model-refused');
  assert.equal(calls, 3, 'the retry went, moved to the queue, and the queue sent it');
  await is(opusPending, 'retried: moving the retry to the queue spent the newer Opus pick');
  await page.unroute(prompts);
  // A plain one (nothing picked while it was on its way): 'turn-running', then the queue's send refused, clears its pick.
  calls = 0;
  await page.route(prompts, (route) => ++calls === 1 ? busy(route) : refuse(route));
  await page.fill('#prompt', ''); await clear(); await send(page, 'plain'); await noted('Not sent: model-refused');
  assert.equal(calls, 2, 'the plain send moved to the queue and the queue sent it');
  await is(running, 'plain: the queue refusal left its pick pending');
  await page.unroute(prompts);
  // A config pick the same way (effort): High goes and is held, another effort then High again are picked, 'turn-running' moves it to
  // the queue, whose send is refused. A pick shows again after a redraw only while it is unsent, so this leaves the chat and comes back.
  const effort = '#pickers select[data-config="effort"]';
  const setEffort = async (value) => { await page.click('#modePill'); await page.waitForSelector(`#sheet[open] ${effort}`, { timeout: 10000 }); await page.selectOption(effort, value); await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('#sheet').open, null, { timeout: 5000 }); };
  const id = await page.evaluate(() => document.querySelector('#conversation').value);
  const current = await page.$eval(effort, (el) => el.dataset.current), other = await page.$eval(effort, (el) => [...el.options].map((o) => o.value).find((v) => v !== 'high' && v !== el.dataset.current));
  assert.ok(current !== 'high' && other, 'the agent offers an effort besides High and the current one: ' + current + ', ' + other);
  const heldConfig = new Promise((resolve) => { release = resolve; });
  calls = 0;
  await page.route(prompts, async (route) => { if (++calls === 1) { await heldConfig; return busy(route).catch(() => {}); } return refuse(route); });
  await page.fill('#prompt', ''); await clear(); await setEffort('high'); await send(page, 'held effort');
  await page.waitForFunction(() => document.querySelector('#prompt').value === 'held effort', null, { timeout: 5000 });
  await setEffort(other); await setEffort('high'); await clear(); release(); await noted('Not sent: model-refused');
  assert.equal(calls, 2, 'the held effort send moved to the queue and the queue sent it');
  await page.unroute(prompts);
  await page.fill('#prompt', '');
  await newChat(page, 'claude');
  await page.click('[data-bar="chat"] [data-back]'); await page.click(`#chatList [data-chat="${id}"]`);
  await page.waitForFunction((id) => document.querySelector('#conversation').value === id, id, { timeout: 10000 });
  assert.equal(await page.$eval(effort, (el) => el.value), 'high', 'effort: moving the send to the queue spent the newer High pick');
  // Taken from the queue: Opus goes and is held, Haiku then Opus are picked, 'turn-running' queues it, and the queue's send goes
  // through. Opus is in effect, so the newer Opus pick is spent then: when the model is changed elsewhere (here the desk picks Haiku),
  // coming back to the chat does not bring Opus back as this phone's pending pick.
  await page.waitForFunction(() => !document.querySelector('[data-bar="chat"] .run'), null, { timeout: 20000 });
  const heldTaken = new Promise((resolve) => { release = resolve; });
  calls = 0;
  await page.route(prompts, async (route) => { if (++calls === 1) { await heldTaken; return busy(route).catch(() => {}); } return route.continue(); });
  await page.fill('#prompt', ''); await clear(); await pick('opus'); await send(page, 'taken');
  await page.waitForFunction(() => document.querySelector('#prompt').value === 'taken', null, { timeout: 5000 });
  await pick('haiku'); await pick('opus'); release();
  await page.waitForFunction(() => document.querySelector('#model').dataset.current === 'opus', null, { timeout: 15000 });
  assert.equal(calls, 2, 'the held send moved to the queue and the queue sent it');
  await page.unroute(prompts);
  await page.waitForFunction(() => !document.querySelector('[data-bar="chat"] .run'), null, { timeout: 20000 });
  assert.equal((await server.desk('/chat/' + id + '/prompt', 'POST', { text: 'model', model: 'haiku', op: crypto.randomUUID() })).status, 202);
  await replied('model:haiku');
  await page.waitForFunction(() => !document.querySelector('[data-bar="chat"] .run'), null, { timeout: 20000 });
  await newChat(page, 'claude');
  await page.click('[data-bar="chat"] [data-back]'); await page.click(`#chatList [data-chat="${id}"]`);
  await page.waitForFunction((id) => document.querySelector('#conversation').value === id && document.querySelector('#model').dataset.current === 'haiku', id, { timeout: 10000 });
  await is(['Claude · Haiku', 'Model: Haiku'], 'taken from the queue: the newer Opus pick was not spent and came back as pending');
  console.log('PASS O209: queue transfer keeps a newer same-value pick (model held and retried, effort held); a plain one clears');
});

// O59: the chat header names the model the chat's Model sheet shows. A Claude chat next to a Codex chat on another
// model (as a chat that started a child chat on another agent): back on the Claude chat, no header it draws names the
// other chat's model. Every header text is recorded as it is drawn, so a wrong first draw fails even if a later one fixes it.
test('O59: back on a chat, its header names its own model, never the model of the chat shown before', { timeout: 90000 }, async (t) => {
  const { page } = await phoneOn(t);
  const replied = (want) => page.waitForFunction((w) => [...document.querySelectorAll('#events .md')].some((el) => el.textContent.trim() === w), want, { timeout: 15000 });
  const parent = await newChat(page, 'claude');
  await send(page, 'model'); await replied('model:default');
  await newChat(page, 'codex');
  await send(page, 'model'); await replied('model:default');
  await page.click('#modelBtn'); await page.click('#sheet[open] [data-model="opus"]');
  await page.waitForFunction(() => !document.querySelector('#sheet').open, null, { timeout: 5000 });
  await send(page, 'model'); await replied('model:opus');
  await page.waitForFunction(() => document.querySelector('#modelBtn').textContent.trim() === 'Codex · Opus', null, { timeout: 10000 });
  await page.evaluate(() => {
    const seen = window.o59 = [];
    new MutationObserver(() => { const b = document.querySelector('[data-bar="chat"] #modelBtn'); if (b) seen.push([document.querySelector('#conversation').value, b.textContent.trim()]); })
      .observe(document.querySelector('[data-bar="chat"]'), { subtree: true, childList: true, characterData: true, attributes: true });
  });
  await page.click('[data-bar="chat"] [data-back]');
  await page.click(`#chatList [data-chat="${parent}"]`);
  // Drawn: the chat's own model list is in the Model select (the sheet reads it); the header is drawn in the same pass.
  await page.waitForFunction((id) => document.querySelector('#conversation').value === id && document.querySelector('#model').value === 'default' && !document.querySelector('#events').textContent.includes('Loading'), parent, { timeout: 10000 });
  assert.equal(await page.locator('#modelBtn').innerText(), 'Claude · Default (recommended)', 'the header does not name the model the Model sheet shows');
  const drawn = await page.evaluate((id) => window.o59.filter(([chat]) => chat === id).map(([, text]) => text), parent);
  assert.deepEqual(drawn.filter((text) => text !== 'Claude · Default (recommended)'), [], 'the Claude chat\'s header named another model: ' + String(JSON.stringify(drawn)));
  await page.click('#modelBtn');
  assert.equal(await page.locator('#sheet[open] [data-model][aria-checked="true"]').innerText(), 'Default (recommended)');
});
// A2 step 6b: quote a reply on the phone. Quote under a reply, or a selection in one with its Comment button (the box does
// not open by itself, so Copy works), opens the comment box; Comment adds a small chip (the comment, else the quote's start);
// the pencil edits it, a tap on it shows the reply, a comment typed and not added is kept when the box is left, Cancel
// drops it, ✕ removes a chip; the next message carries the quotes first, each with its comment, and the chips go.
const until = async (check, what, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 200))) if (await check()) return;
  assert.fail('timed out: ' + what);
};
test('A2 step 6b: quote a whole reply or a selection on the phone, as a chip with its comment, sent first in the next message', { timeout: 90000 }, async (t) => {
  const { page } = await phoneOn(t);
  const posts = [];
  page.on('request', (request) => { if (request.method() === 'POST' && /\/chat\/[^/]+\/prompt$/.test(new URL(request.url()).pathname)) posts.push(request.postDataJSON()?.text); });
  await newChat(page, 'claude');
  await send(page, 'The first sentence. The second sentence.'); await said(page, 'echo:The first sentence.');
  for (const n of [1, 2]) { await send(page, `filler ${n}\n` + 'line\n'.repeat(30)); await said(page, `echo:filler ${n}`); } // so the chat scrolls
  const box = page.locator('.quote-box'), pop = page.locator('.comment-pop'), chips = page.locator('#attached .chip-quote');
  const labels = () => chips.locator('.quote-go').allTextContents();
  const reply = page.locator('#events article[data-kind="agent"]', { hasText: 'echo:The first sentence' });
  await reply.locator('[data-quote-reply]').click(); await box.waitFor({ timeout: 5000 });
  assert.equal(await box.locator('blockquote').textContent(), 'echo:The first sentence. The second sentence.', 'Quote takes the whole reply');
  await page.keyboard.type('why this?'); await page.keyboard.press('Enter');
  await chips.first().waitFor({ timeout: 5000 }); assert.equal(await box.count(), 0, 'Comment closes the box');
  assert.deepEqual(await labels(), ['why this?'], 'the chip shows the comment');
  // A selection: the Comment button, no box, and the text stays selected.
  const select = () => page.evaluate(() => { const p = [...document.querySelectorAll('#events article[data-kind="agent"]')].find((a) => a.textContent.includes('echo:The first sentence')).querySelector('p'), node = p.firstChild, r = document.createRange();
    r.setStart(node, 9); r.setEnd(node, 28); getSelection().removeAllRanges(); getSelection().addRange(r); });
  await select(); await pop.waitFor({ timeout: 5000 });
  assert.equal(await box.count(), 0, 'a selection does not open the box by itself');
  assert.equal(await page.evaluate(() => getSelection().toString()), 'first sentence. The', 'and stays selected (Copy works)');
  await shot(page, 'a2-phone-comment-button');
  // A selection changed after the button showed takes it away (it never quotes the old words); selected again, it is back.
  await page.evaluate(() => getSelection().modify('extend', 'backward', 'character'));
  await until(async () => await pop.count() === 0, 'a changed selection takes the Comment button away', 5000);
  await select(); await pop.waitFor({ timeout: 5000 });
  await pop.click(); await box.waitFor({ timeout: 5000 });
  assert.equal(await box.locator('blockquote').textContent(), 'first sentence. The', 'Comment quotes the selection');
  await box.locator('[type=submit]').click(); await until(async () => await chips.count() === 2, 'no comment: a second chip', 5000);
  assert.deepEqual(await labels(), ['why this?', '“first sentence. The”'], 'a chip without a comment shows the quote\'s start');
  // The pencil edits the comment where it is.
  await chips.first().locator('[data-quote-edit]').click(); await box.waitFor({ timeout: 5000 });
  assert.equal(await box.locator('textarea').inputValue(), 'why this?');
  await page.keyboard.type(' really'); await page.keyboard.press('Enter');
  await until(async () => (await labels())[0] === 'why this? really', 'the pencil changed the comment in place', 5000);
  assert.equal(await chips.count(), 2);
  // Left with a comment typed: kept as a chip; Cancel drops what was typed; ✕ removes a chip.
  await reply.locator('[data-quote-reply]').click(); await box.waitFor({ timeout: 5000 }); await page.keyboard.type('keep me');
  await page.mouse.click(195, 120); await until(async () => await box.count() === 0, 'a tap outside closes the box', 5000);
  await until(async () => await chips.count() === 3, 'the typed comment is kept as a chip', 5000);
  // The pencil, its comment cleared, then a tap outside: the chip goes back to the quote's start.
  await chips.nth(2).locator('[data-quote-edit]').click(); await box.waitFor({ timeout: 5000 });
  await page.keyboard.press('Control+A'); await page.keyboard.press('Backspace');
  await page.mouse.click(195, 120); await until(async () => await box.count() === 0, 'a tap outside closes the edit', 5000);
  await until(async () => (await labels())[2]?.startsWith('“echo:The first'), 'a cleared comment shows the quote\'s start', 5000);
  // A tap on a chip's ✕ while a comment is typed: the ✕ removes that chip, and the typed comment is still kept.
  await reply.locator('[data-quote-reply]').click(); await box.waitFor({ timeout: 5000 }); await page.keyboard.type('late');
  await chips.nth(2).locator('[data-unquote]').click(); await until(async () => await box.count() === 0, 'the ✕ tap closes the box', 5000);
  await until(async () => (await labels()).join('|') === 'why this? really|“first sentence. The”|late', 'the ✕ removed its chip and the typed one was kept', 5000);
  await reply.locator('[data-quote-reply]').click(); await box.waitFor({ timeout: 5000 }); await page.keyboard.type('dropped');
  await box.getByRole('button', { name: 'Cancel' }).click(); await until(async () => await box.count() === 0, 'Cancel closes it', 5000);
  assert.equal(await chips.count(), 3, 'Cancel adds nothing');
  await chips.nth(2).locator('[data-unquote]').click(); await until(async () => await chips.count() === 2, '✕ removes a chip', 5000);
  await shot(page, 'a2-phone-chips');
  // A tap on a chip scrolls its reply into the chat's view and marks it.
  const marked = () => page.evaluate(() => { const el = [...document.querySelectorAll('#events article[data-kind="agent"]')].find((a) => a.textContent.includes('echo:The first sentence')), r = el.getBoundingClientRect(), view = document.querySelector('#chatBody').getBoundingClientRect();
    return el.classList.contains('quote-src') && r.bottom > view.top && r.top < view.bottom; });
  await page.evaluate(() => { const c = document.querySelector('#chatBody'); c.scrollTo({ top: c.scrollHeight, behavior: 'instant' }); });
  await chips.first().locator('.quote-go').click();
  await until(marked, 'the chip shows its reply, marked', 5000);
  // The next message carries both quotes first, each with its comment; the chips go. The mark, taken off by hand just
  // before, is put back by the redraw the send brings. Its 1.6 s end is held for this, so a slow run cannot outlast it.
  posts.length = 0;
  await page.evaluate(() => { const set = window.p9SetTimeout = window.setTimeout; window.p9HeldMark = []; window.setTimeout = (f, ms, ...rest) => ms === 1600 ? (window.p9HeldMark.push(f), 0) : set(f, ms, ...rest); });
  await chips.first().locator('.quote-go').click(); await until(marked, 'a second tap marks it again', 5000);
  await page.evaluate(() => document.querySelector('#events .quote-src').classList.remove('quote-src'));
  await send(page, 'and this');
  await until(() => page.evaluate(() => !!document.querySelector('#events .quote-src')), 'a redraw keeps the mark', 5000);
  await said(page, 'echo:> echo:The first sentence.');
  await page.evaluate(() => { window.setTimeout = window.p9SetTimeout; window.p9HeldMark.forEach((f) => f()); }); // the mark's end, let go: it goes
  assert.equal(await page.locator('#events .quote-src').count(), 0, 'the mark goes when its time is up');
  assert.equal(posts.at(-1), '> echo:The first sentence. The second sentence.\n\nwhy this? really\n\n> first sentence. The\n\nand this');
  await until(async () => await chips.count() === 0, 'the sent quotes leave the box', 5000);
  assert.equal(await page.inputValue('#prompt'), '');
  // Send tapped while the pencil is open: the send carries the chip as it was, and the edit comes back as a chip, not lost.
  await reply.first().locator('[data-quote-reply]').click(); await box.waitFor({ timeout: 5000 }); await page.keyboard.type('x'); await page.keyboard.press('Enter'); // the first: the echo above also has its words
  await chips.first().waitFor({ timeout: 5000 });
  await chips.first().locator('[data-quote-edit]').click(); await box.waitFor({ timeout: 5000 }); await page.keyboard.type(' more');
  // The send's answer is held, so the edit lands while it waits; the 202 then drops only the chip sent.
  let release; const held = new Promise((r) => { release = r; }), isPrompt = (url) => /\/chat\/[^/]+\/prompt$/.test(new URL(url).pathname);
  await page.route(isPrompt, async (route) => { await held; await route.continue(); });
  posts.length = 0; await page.click('#composer button[type="submit"]');
  await until(async () => posts.length === 1, 'Send sent the chip', 5000);
  assert.equal(posts[0], '> echo:The first sentence. The second sentence.\n\nx');
  await until(async () => (await labels()).join('|') === 'x more', 'the edit comes back as a chip while the send waits', 5000);
  const echoes = () => page.locator('#events article[data-kind="agent"]', { hasText: 'echo:> echo:The first sentence' }).count(), before = await echoes();
  const answered = page.waitForResponse((r) => isPrompt(r.url())); release(); assert.equal((await answered).status(), 202);
  await page.unroute(isPrompt);
  await until(async () => await echoes() > before, 'the held send was answered', 15000);
  await page.waitForTimeout(500); // ponytail: a short settle; the 202's handling has no mark of its own to wait on
  assert.deepEqual(await labels(), ['x more'], 'after the 202 the edit is the only chip');
  // The pencil tapped again before the last edit's save has run: the new box starts from that edit, not the one before.
  await chips.first().locator('[data-quote-edit]').click(); await box.waitFor({ timeout: 5000 }); await page.keyboard.type(' again');
  await chips.first().locator('[data-quote-edit]').click();
  await until(async () => (await box.count()) === 1 && (await box.locator('textarea').inputValue()) === 'x more again', 'the new box starts from the edit just left', 5000);
  await page.keyboard.press('Escape'); await until(async () => await box.count() === 0, 'Esc closes it', 5000);
  assert.deepEqual(await labels(), ['x more again'], 'one chip, with the edit');
  // A redraw that leaves the chips as they were keeps their buttons (a tap between press and release is not lost).
  await chips.first().locator('[data-quote-edit]').evaluate((b) => { b.p9same = true; });
  await send(page, '/ping'); await said(page, 'echo:/ping'); // a command goes alone; the chip stays
  assert.equal(await chips.first().locator('[data-quote-edit]').evaluate((b) => b.p9same), true, 'the same button after the redraw');
});

// O266: after an automatic compaction the adapter sends the calls from before it again, same ids, pending, then each one's
// finish. The phone keeps the one row it has; it drew a second one, left pending (ended at the turn's end).
test('O266: a tool call sent again after a compaction keeps its one row on the phone', { timeout: 90000 }, async (t) => {
  const { page } = await phoneOn(t);
  await newChat(page, 'claude');
  await send(page, 'toolrepeat'); await said(page, 'after repeat');
  assert.equal(await page.$eval('#events', (el) => el.textContent.split('repeat me').length - 1), 1, 'one row for the call');
  // Finished by its own update, not marked ended at the turn's end.
  assert.equal(await page.locator('#events article[data-kind="tool"][data-status="completed"]', { hasText: 'repeat me' }).count(), 1, 'its one row, completed');
});
