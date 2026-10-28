// Phone parity (v0.1.6 chunk 2): the phone's terminal knows it is a phone (T6), Paste (T2) and tap-to-type (T1), the
// agent's pictures and real links in a reply (P9), every mode behind the desktop's red warning (P6), and the desktop's
// chat controls the phone lacked (P10: questions, effort and fast mode, slash commands, a new chat's folder), and
// images attached from the phone (P8).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
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
  if (folder) await page.selectOption('#sheet[open] #startIn', folder);
  await page.click(`#sheet[open] [data-new="${agent}"]`);
  const id = String((await (await made).json()).conversation);
  made201();
  // Shown = the chat screen's link (set as it is drawn); the hidden select alone also names the newest chat on the list.
  await page.waitForFunction((id) => location.hash === '#chat=' + id && document.querySelector('#conversation').value === id && !document.querySelector('#events').textContent.includes('Loading'), id, { timeout: 10000 });
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
  await page.waitForFunction(() => document.querySelectorAll('#events .agent-imgs img').length === 2, null, { timeout: 15000 });
  const sources = await page.$$eval('#events .agent-imgs img', (list) => list.map((img) => [img.src.slice(0, 22), img.naturalWidth, img.naturalHeight]));
  assert.deepEqual(sources, [['data:image/png;base64,', 320, 200], ['data:image/png;base64,', 120, 90]]);
  // A tap opens it full screen; another tap closes it.
  await page.click('#events .agent-imgs img >> nth=1');
  assert.equal(await page.evaluate(() => document.querySelector('dialog.picture').open), true);
  await page.click('dialog.picture');
  assert.equal(await page.evaluate(() => document.querySelector('dialog.picture').open), false);

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
  await page.waitForFunction((id) => ![...document.querySelectorAll('#conversation option')].some((option) => option.value === id), id, { timeout: 10000 });
  assert.notEqual(await page.inputValue('#conversation'), other, 'the composer on the stopped chat now sends to another chat');
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
  const replied = (want) => page.waitForFunction((w) => [...document.querySelectorAll('#events .md')].some((el) => el.textContent.includes(w)), want, { timeout: 15000 });
  assert.equal((await server.desk('/chat', 'POST', { provider: 'claude', folder: 'proj/sub' })).status, 201);
  await page.reload();
  // The folder list is drawn when the New chat sheet opens, so the list has that chat first.
  await page.waitForSelector('#chatList [data-chat]', { timeout: 10000 });
  await page.click('#newChat');
  assert.equal(await page.locator('#sheet[open] #startIn option[value="proj/sub"]').count(), 1);
  assert.equal(await page.isVisible('#sheet[open] #startIn'), true);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#sheet').open, null, { timeout: 5000 });
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
  const choose = async (pick, files) => {
    await page.click('#attach');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10000 }), page.click(`#sheet[open] [data-pick="${pick}"]`)]);
    await chooser.setFiles(files);
    return page.$eval('#attachInput', (el) => [el.accept, el.getAttribute('capture')]);
  };
  await newChat(page, 'claude');
  await page.click('#attach');
  assert.deepEqual(await page.$$eval('#sheet[open] [data-pick]', (els) => els.map((el) => el.textContent)), ['Photo library', 'Take photo', 'File']);
  assert.equal(await page.textContent('#sheetTitle'), 'Attach');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#sheet').open, null, { timeout: 5000 });
  // Each choice opens the phone's own picker: the camera asked for on Take photo, the four types on File.
  assert.deepEqual(await choose('camera', [{ name: 'shot.png', mimeType: 'image/png', buffer: bytes }]), ['image/*', 'environment']);
  await chips(1);
  assert.deepEqual(await choose('file', [{ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') }]), ['image/png,image/jpeg,image/gif,image/webp', null]);
  await noted('Not attached: notes.txt: PNG, JPEG, GIF or WebP only.');
  assert.deepEqual(await choose('library', [{ name: 'lib.png', mimeType: 'image/png', buffer: bytes }]), ['image/*', null]);
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
  await send(page, 'look');
  await replied('echo:look' + seen);
  await chips(0);
  assert.equal(await page.isHidden('#attached'), true);
  assert.equal(await page.isHidden('#composerNote'), true);
  // The sent photo shows in its message, fetched from the daemon by hash.
  await page.waitForSelector('#events .user-imgs img[src^="data:image/png;base64,"]', { timeout: 10000 });
  // Four a message: the fifth is refused with the reason.
  await paste(5);
  await chips(4);
  await noted('Not attached: four images a message at most.');
  // Offline the text would queue; images are not queued, so nothing goes and the box keeps both.
  await page.evaluate(() => Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true }));
  await send(page, 'later');
  await noted('Not sent: images go only with a message sent now.');
  assert.equal(await page.inputValue('#prompt'), 'later');
  assert.equal(await page.isHidden('#queued'), true);
  await chips(4);
  await page.evaluate(() => Object.defineProperty(navigator, 'onLine', { get: () => true, configurable: true }));
  await send(page, 'look');
  await replied('echo:look' + seen.repeat(4));
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
  await page.waitForSelector('#queued:not([hidden]) article:has-text("later") >> text=Queued', { timeout: 15000 });
  assert.equal(await page.inputValue('#prompt'), '');
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
  await page.waitForSelector('#queued:not([hidden]) article:has-text("keep me")', { timeout: 15000 });
  assert.equal(await page.inputValue('#prompt'), '');
  await page.click('#composer button[type="submit"]'); // the empty box's Stop
  await page.waitForFunction(() => document.querySelector('#prompt').value === 'keep me' && document.querySelector('#queued').hidden, null, { timeout: 15000 });
  await shot(page, 'p18-kept');
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
