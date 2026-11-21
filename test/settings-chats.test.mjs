// settings-chats: split from test/settings.test.mjs (O120), by area — the Settings dialog's chats surfaces.
// Same helpers, same fixtures, every test moved verbatim: none dropped, none weakened.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { deflateSync, crc32 } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { _electron } from '@playwright/test';
import { daemon, http, authenticated, root, versionSeen, openFiles } from './helpers.mjs';
import { REPO } from '../apps/server/anymouse.mjs';
import { AZURE, FIXTURE, OTHERS } from './azure-fixture.mjs';
const look = (on, roles = {}) => ({ on, size: 48, claude: null, codex: null, system: null, top: null, pane: null, ...roles });
const PETS = { chat: look(true), dev: look(false), mission: look(false) };
const SKIPPER = { system: 'skipper' }, DEFAULT_PETS = { chat: look(true, SKIPPER), dev: look(false, SKIPPER), mission: look(false, SKIPPER) };
const DOCS_URL = 'https://github.com/' + REPO + '#readme'; // main.mjs loads only inside Electron
const RELEASES_URL = 'https://github.com/' + REPO + '/releases/latest';
const PETDEX_URL = 'https://petdex.dev';
// 0.1.8: Mode, Model and Effort are pills in the message bar (controller.mjs pillMenu); each opens a menu of menuitemradio choices.
// pillValue reads a pill's value from its aria-label; pillItems lists a menu (the checked ones marked); choose picks (no submenus).
const pillOf = (pane, kind) => pane.locator(`[data-pill="${kind}"]`);
const pillValue = async (pane, kind) => (await pillOf(pane, kind).getAttribute('aria-label')).replace(kind + ': ', '');
const menuItem = (page, label) => page.locator('#pillMenu .item').filter({ has: page.locator(`.truncate:text-is("${label}")`) });
const pillItems = async (page, pane, kind) => { await pillOf(pane, kind).click(); await page.locator('#pillMenu:not([hidden])').waitFor(); const items = await page.locator('#pillMenu .item').evaluateAll((l) => l.map((b) => b.firstElementChild.textContent + (b.getAttribute('aria-checked') === 'true' ? ' ✓' : ''))); await page.keyboard.press('Escape'); return items; };
const choose = async (page, pane, kind, ...labels) => { await pillOf(pane, kind).click(); for (const label of labels) await menuItem(page, label).click(); };
const fake = path.join(root, 'test/fake-acp-agent.mjs');
const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((result) => JSON.parse(result.text));

// A petdex-shaped sheet: 8 x 9 frames of 192 x 208, with `filled[row]` opaque frames in each row.
function sheet(filled) {
  const w = 1536, h = 1872, raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < (filled[Math.floor(y / 208)] ?? 0) * 192; x++) raw.writeUInt32BE(0x3fa0ffff, y * (w * 4 + 1) + 1 + x * 4);
  const chunk = (type, data) => { const len = Buffer.alloc(4), crc = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type), data]); len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body)); return Buffer.concat([len, body, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('Pets: crafted folders refused; each waiting agent and each chat shows its own pet, per focus, dragged spots kept; add and remove (threat model row 16)', { timeout: 240000 }, async (t) => {
  // A Mission with files (an existing install): a fresh one opens at its onboarding card with no panels (fresh-install finding 2).
  const instance = await daemon(t, undefined, false, async ({ directory, workspace }) => {
    const file = path.join(directory, '.config', 'p9', 'settings.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ registry: 'mission/registry.json' }));
    await mkdir(path.join(workspace, 'mission'), { recursive: true });
    await writeFile(path.join(workspace, 'mission', 'registry.json'), JSON.stringify({ scripts: [], apps: [{ id: 'editor', title: 'Editor', cmd: ['true'] }], pages: [] }));
    return { args: ['--acp-override', fake] };
  });
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-pets-')), profile = path.join(home, 'profile'), pets = path.join(profile, 'pets'), src = path.join(home, 'src');
  const pet = async (dir, name, meta, files = {}) => {
    await mkdir(path.join(dir, name), { recursive: true });
    await writeFile(path.join(dir, name, 'pet.json'), JSON.stringify({ id: name, displayName: name, description: 'x', spritesheetPath: 'spritesheet.png', ...meta }));
    for (const [file, data] of Object.entries(files)) await writeFile(path.join(dir, name, file), data);
  };
  const png = sheet({ 0: 2, 3: 4, 4: 5, 6: 3, 7: 5 });
  // Evidence runs only: P9_REAL_PET and P9_REAL_PET2 swap in downloaded petdex sheets (.webp) so the screenshots show real pets.
  const art = async (file) => file ? [{ spritesheetPath: 'spritesheet.webp' }, { 'spritesheet.webp': await readFile(file) }] : [{}, { 'spritesheet.png': png }];
  const [meta1, files1] = await art(process.env.P9_REAL_PET), [meta2, files2] = await art(process.env.P9_REAL_PET2);
  await pet(pets, 'good-pet', { displayName: '<img src=x onerror=alert(1)>Pip', ...meta1 }, files1);
  await pet(pets, 'other-pet', { displayName: 'Other', ...meta2 }, files2);
  await pet(pets, 'dotdot', { spritesheetPath: '../good-pet/spritesheet.png' });
  await pet(pets, 'slash', { spritesheetPath: 'sub/spritesheet.png' });
  await pet(pets, 'link-image', {}); await symlink(path.join(pets, 'good-pet', 'spritesheet.png'), path.join(pets, 'link-image', 'spritesheet.png'));
  await symlink(path.join(pets, 'good-pet'), path.join(pets, 'link-folder'));
  await pet(pets, 'text', { spritesheetPath: 'spritesheet.webp' }, { 'spritesheet.webp': 'RIFF but not an image at all' });
  await pet(pets, 'huge', {}, { 'spritesheet.png': Buffer.concat([png.subarray(0, 8), Buffer.alloc(9 << 20)]) });
  await pet(pets, 'Bad_Name', {}, { 'spritesheet.png': png });
  // Folders offered to Add pets: one good (with an extra file and field that must not come along), and four that must be refused.
  await pet(src, 'new-pet', { displayName: 'New', extra: 'not copied' }, { 'spritesheet.png': png, 'run.sh': '#!/bin/sh\n' });
  await pet(src, 'Bad_Name', {}, { 'spritesheet.png': png });
  await pet(src, 'good-pet', {}, { 'spritesheet.png': png });
  await pet(src, 'link-sheet', {}); await symlink(path.join(src, 'new-pet', 'spritesheet.png'), path.join(src, 'link-sheet', 'spritesheet.png'));
  await pet(src, 'no-sheet', {});
  await writeFile(path.join(profile, 'p9-settings.json'), JSON.stringify({ zoom: 1, closeOnSend: false, focus: { chat: true, dev: true, mission: true }, pet: 'dotdot' })); // from before pets per role: one refused pet
  await versionSeen(profile);

  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const launch = async () => {
    const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
    const proc = app.process();
    t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
    const page = await app.firstWindow();
    await page.locator('#rChat').waitFor();
    return { app, page };
  };
  let { app, page } = await launch();
  const seen = await page.evaluate(async (names) => {
    const out = { list: await window.p9.listPets() };
    for (const name of names) out[name] = await window.p9.loadPet(name).then((p) => p.sprite.slice(0, 22), (e) => e.message.split(': ').pop());
    return out;
  }, ['good-pet', 'dotdot', 'slash', 'link-image', 'link-folder', 'text', 'huge', 'Bad_Name', '../good-pet']);
  assert.deepEqual({ ...seen.list, pets: seen.list.pets.sort((a, b) => a.name.localeCompare(b.name)), importable: typeof seen.list.importable }, // the count reads the real ~/.codex/pets until the Import step below
    { folder: pets, pets: [{ name: 'good-pet', displayName: '<img src=x onerror=alert(1)>Pip' }, { name: 'other-pet', displayName: 'Other' }], importable: 'number' });
  assert.equal(seen['good-pet'], process.env.P9_REAL_PET ? 'data:image/webp;base64' : 'data:image/png;base64,');
  for (const name of ['dotdot', 'slash', 'link-image', 'link-folder', 'text', 'huge', 'Bad_Name', '../good-pet']) assert.equal(seen[name], 'pet-refused', name);

  const ev = process.env.P9_EVIDENCE, shot = async (name) => { if (ev) await page.screenshot({ path: path.join(ev, name) }); else if (!process.env.GITHUB_ACTIONS) { await page.waitForTimeout(400); console.log('P9_SHOT ' + name.replace(/\.png$/, '') + ' ' + (await page.screenshot({ type: 'png' })).toString('base64')); } };
  const settingsNow = () => page.evaluate(() => window.p9.getSettings());
  // O123: no pet in the top bar, ever; the spinner and its words stay.
  const topPets = () => page.evaluate(() => document.querySelectorAll('#agentInd canvas, #indPets').length);
  const spinnerShows = async (text, what) => { assert.equal(await topPets(), 0, what + ': no top-bar pet'); assert.equal(await page.locator('#indGlyph').isVisible(), true, what + ': spinner'); assert.equal(await page.locator('#indText').innerText(), text, what); };
  const drawn = (sel) => page.waitForFunction((sel) => { const c = [...document.querySelectorAll(sel)]; return c.length && c.every((cv) => cv.getContext('2d').getImageData(96, 104, 1, 1).data[3] > 0); }, sel);
  const setPet = async (role, name) => { await page.click('#setBtn'); await page.selectOption('#setPet-' + role, name); await page.click('#setClose'); };

  // A running turn shows the spinner in every focus, and the indicator hides when the turn ends.
  const id = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'slow' });
  await page.locator('#agentInd[data-state="working"]').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('#indText').innerText(), 'Working…');
  assert.equal(await page.locator('#indGlyph').isVisible(), true);
  for (const focus of ['Control+2', 'Control+3', 'Control+1']) { await page.keyboard.press(focus); assert.equal(await page.locator('#agentInd').isVisible(), true, focus); }
  await call(instance, `/chat/${id}/cancel`, 'POST', {});
  await page.locator('#agentInd').waitFor({ state: 'hidden', timeout: 15000 });
  // After a compaction the agent works on with no prompt open (the spinner and pet went away): the
  // indicator comes back for that turn and hides on its closing usage_update.
  await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'compact' });
  await page.getByText('after compact').first().waitFor({ timeout: 15000 });
  assert.equal(await page.locator('#agentInd').getAttribute('data-state'), 'working', 'working again after the compaction');
  await page.locator('#agentInd').waitFor({ state: 'hidden', timeout: 15000 });

  // The old single-pet file became every focus's system pet (refused, so the spinner), shown in Chat only.
  assert.deepEqual((await settingsNow()).pet, { chat: look(true, { system: 'dotdot' }), dev: look(false, { system: 'dotdot' }), mission: look(false, { system: 'dotdot' }) });
  await page.click('#setBtn');
  await page.locator('#setPet-claude').waitFor();
  assert.equal(await page.locator('#setPet-claude option').count(), 3);
  assert.equal(await page.locator('#setDlg img').count(), 0, 'the pet name stays text');
  await page.selectOption('#setPet-codex', 'other-pet');
  await page.click('#setClose');
  // Claude waits with only a Codex pet, then with its own pet: the spinner either way.
  await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'permission' });
  await page.locator('#agentInd[data-state="waiting"]').waitFor({ timeout: 15000 });
  await spinnerShows('An agent waits on you', 'Claude waits, only a Codex pet');
  await setPet('claude', 'good-pet');
  await spinnerShows('An agent waits on you', 'Claude waits with its own pet');
  // Codex works too: still the spinner, no pet runs in the top bar.
  const codex = (await call(instance, '/chat', 'POST', { provider: 'codex' })).conversation;
  await call(instance, `/chat/${codex}/prompt`, 'POST', { text: 'slow' });
  // Busy shows as the working mark on its panel row or its in-chat pet running (chat open).
  const codexBusy = ([id, want]) => want === !!(document.querySelector(`#navList .row[data-chat="${id}"] [data-busy]`) || document.querySelector(`.pane[data-id="${id}"] canvas.pet[data-rows="7"]`));
  await page.waitForFunction(codexBusy, [codex, true], { timeout: 15000 });
  assert.equal(await topPets(), 0, 'a working agent shows no top-bar pet');
  await call(instance, `/chat/${codex}/cancel`, 'POST', {});
  await page.waitForFunction(codexBusy, [codex, false], { timeout: 15000 });
  // Codex waits too: the words count both.
  await call(instance, `/chat/${codex}/prompt`, 'POST', { text: 'permission' });
  await page.waitForFunction(() => document.querySelector('#indText').innerText === '2 agents wait on you', null, { timeout: 15000 });
  await spinnerShows('2 agents wait on you', 'two wait');
  await shot('pets-top-none.png');

  // Each chat holds its own agent's pet (the waiting row).
  const inChat = {};
  await page.click('#rBell'); await page.locator('#mdlBody .mlist [data-i]', { hasText: '2 agents need you' }).click();
  for (const n of [0, 1]) {
    if (n) await page.click('#mdlBack');
    await page.locator('#mdlBody .mlist button').nth(n).click();
    await page.locator('#mdlBody .pane canvas.pet').waitFor();
    const pane = page.locator('#mdlBody .pane');
    inChat[await pane.getAttribute('data-id')] = await pane.locator('canvas.pet').getAttribute('data-pet-name') + ':' + await pane.locator('canvas.pet').getAttribute('data-rows');
    await drawn('#mdlBody .pane canvas.pet');
    if (n === 0) await shot('pet-in-chat.png');
    if (n === 1) { // drag it to a quarter across, a third down the chat
      const box = await pane.boundingBox(), cv = await pane.locator('canvas.pet').boundingBox();
      await page.mouse.move(cv.x + cv.width / 2, cv.y + cv.height / 2); await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 3, { steps: 5 }); await page.mouse.up();
      await page.waitForFunction(() => localStorage.getItem('p9-pet-spots'));
    }
  }
  await page.click('#mdlX'); await page.locator('#mdl').waitFor({ state: 'hidden' });
  assert.deepEqual(inChat, { [id]: 'good-pet:6', [codex]: 'other-pet:6' });
  // Each chat keeps its own spot, and a chat window's spot is its own.
  const petSpots = () => page.evaluate(() => JSON.parse(localStorage.getItem('p9-pet-spots') || '{}'));
  assert.deepEqual(Object.keys(await petSpots()), ['mdlBody:' + codex], 'only the dragged chat window kept a spot');
  // D2: the spot is kept from the message box, in px, so it moves with the box.
  const dragged = (await petSpots())['mdlBody:' + codex];
  assert.ok(Array.isArray(dragged.box) && dragged.box.every(Number.isInteger) && dragged.box[1] < 0, JSON.stringify(dragged));
  assert.equal((await settingsNow()).pet.chat.top, null);

  // An agent's reply shows as Markdown, and markup in it stays text: no script, image or frame (threat model row 18). Only
  // plain http(s) addresses become links (v0.1.6 P9), opening outside P9, with the real host after text that is not it.
  const md = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  const hostile = '\n# Plan\n\n- **one**\n- two\n\n```js\nlet a = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<script>window.pwned = 1</script>\n\n<img src=x onerror="window.pwned = 2"> <iframe src="https://example.com"></iframe>\n\n[click](javascript:window.pwned=3) <https://example.com> ![x](https://example.com/x.png)'
    + ' [github.com](https://docs.example.test/p) [d](data:text/html,hi) [f](file:///etc/passwd) [r](/chat) [u](https://u:p@a.example.test/)';
  await call(instance, `/chat/${md}/prompt`, 'POST', { text: hostile });
  await page.locator(`#nav .row[data-chat="${md}"]`).click();
  const reply = page.locator(`#chats .pane[data-id="${md}"] .msg.agent`).last();
  await reply.locator('table').waitFor({ timeout: 15000 });
  assert.deepEqual(await reply.evaluate((m) => [...m.querySelectorAll('a')].map((a) => [a.getAttribute('href'), a.target, a.rel, a.textContent, a.nextElementSibling?.matches('.link-host') ? a.nextElementSibling.textContent : null])),
    [['https://example.com/', '_blank', 'noopener noreferrer', 'https://example.com', null], ['https://docs.example.test/p', '_blank', 'noopener noreferrer', 'github.com', '(docs.example.test)']]);
  // A click opens it through main, in the browser and not in a P9 window; main checks the address again and refuses
  // anything else the page could send.
  await app.evaluate(({ shell }) => { globalThis.linkSeen = []; shell.openExternal = async (url) => { globalThis.linkSeen.push(url); }; });
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  // First a question naming the whole address (the chat link confirm); Cancel opens nothing.
  const linkAsk = async (answer) => {
    await reply.locator('a[href="https://docs.example.test/p"]').click();
    await page.locator('#linkDlg[open] #linkU', { hasText: 'https://docs.example.test/p' }).waitFor({ timeout: 5000 });
    await page.click(`#linkDlg button[value="${answer}"]`);
  };
  await linkAsk('no');
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(await app.evaluate(() => globalThis.linkSeen), [], 'Cancel: not opened');
  await linkAsk('yes');
  for (let i = 0; i < 50 && !(await app.evaluate(() => globalThis.linkSeen.length)); i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(await app.evaluate(() => globalThis.linkSeen), ['https://docs.example.test/p']);
  // "Open, don't ask again": opened, and the next click opens with no question.
  await linkAsk('never');
  await reply.locator('a[href="https://docs.example.test/p"]').click();
  for (let i = 0; i < 50 && (await app.evaluate(() => globalThis.linkSeen.length)) < 3; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(await page.evaluate(() => document.querySelector('#linkDlg').open), false, 'no question after don\'t ask again');
  assert.deepEqual(await app.evaluate(() => globalThis.linkSeen), Array(3).fill('https://docs.example.test/p'));
  // Review 3 L5: "don't ask again" shows in Security settings as the switch off, and turning it on asks again; the question
  // opens with Cancel focused, so a stray Enter opens nothing.
  await page.click('#setBtn'); await page.locator('#setDlg[open]').waitFor();
  await page.click('[data-set-page="General"]');
  assert.equal(await page.locator('#setLinks').isChecked(), false, 'the switch shows don\'t ask again');
  await page.click('#setLinks'); await page.locator('#setLinks:checked').waitFor({ timeout: 5000 });
  assert.equal(await page.evaluate(() => localStorage.getItem('p9-link-ok')), null);
  await page.keyboard.press('Escape'); await page.locator('#setDlg').waitFor({ state: 'hidden', timeout: 5000 });
  await reply.locator('a[href="https://docs.example.test/p"]').click();
  await page.locator('#linkDlg[open]').waitFor({ timeout: 5000 });
  assert.equal(await page.evaluate(() => document.activeElement?.value), 'no', 'Cancel is focused');
  await page.keyboard.press('Enter'); await page.locator('#linkDlg:not([open])').waitFor({ state: 'attached', timeout: 5000 });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal((await app.evaluate(() => globalThis.linkSeen)).length, 3, 'Enter on the question opens nothing');
  await app.evaluate(() => { globalThis.linkSeen = ['https://docs.example.test/p']; });
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), windows);
  assert.deepEqual(await app.evaluate(async ({ ipcMain, BrowserWindow }) => {
    const sender = BrowserWindow.getAllWindows()[0].webContents, run = (...args) => ipcMain._invokeHandlers.get('p9:open-link')({ sender, senderFrame: sender.mainFrame }, ...args).then(() => 'accepted', (e) => e.message);
    return [await run('javascript:alert(1)'), await run('https://u:p@a.test/'), await run('file:///etc/passwd'), await run(42), await run('https://a.test/', 'x'), await run('https://a.test/‮')];
  }), Array(6).fill('ipc-sender-refused'));
  assert.deepEqual(await app.evaluate(() => globalThis.linkSeen), ['https://docs.example.test/p']);
  assert.deepEqual(await reply.evaluate((m) => ({
    shape: ['h1', 'ul li strong', 'pre code', 'table td'].map((q) => !!m.querySelector(q)),
    banned: m.querySelectorAll('script, img, iframe, object, embed, svg').length,
    on: [...m.querySelectorAll('*')].some((el) => [...el.attributes].some((a) => /^on/i.test(a.name))),
    shown: ['<script>', 'onerror', '<iframe'].map((t) => m.textContent.includes(t)), pwned: window.pwned,
  })), { shape: [true, true, true, true], banned: 0, on: false, shown: [true, true, true], pwned: undefined });
  // A live chat has its usage meters above the box, with the working line.
  assert.deepEqual(await page.locator(`#chats .pane[data-id="${md}"] .bottom .meter .l span`).allTextContents(), ['Context', '5 h', '7 d']);
  await shot('markdown-reply.png');

  // Paperclip (threat model row 20): a picked photo shows as a thumbnail, typed text stays, x removes it, the chat still
  // scrolls, and sending delivers it. A photo over 1568 px arrives scaled, as JPEG.
  const pane = page.locator(`#chats .pane[data-id="${md}"]`), box = pane.locator('.composer textarea');
  const big = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 2400; c.height = 1600; const g = c.getContext('2d'); g.fillStyle = '#3a7'; g.fillRect(0, 0, 2400, 1600); return c.toDataURL('image/png').split(',')[1]; });
  await writeFile(path.join(profile, 'big.png'), Buffer.from(big, 'base64'));
  await writeFile(path.join(profile, 'small.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
  await writeFile(path.join(profile, 'note.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>window.pwned = 4</script></svg>');
  await box.fill('describe this'); await shot('attach-before.png');
  const pick = async (...files) => { const chooser = page.waitForEvent('filechooser'); await pane.locator('[data-attach]').click(); await (await chooser).setFiles(files.map((f) => path.join(profile, f))); };
  await pick('small.png', 'big.png', 'note.svg');
  await pane.locator('.attach .att').nth(1).waitFor();
  await page.locator('#toasts .toast', { hasText: 'PNG, JPEG, GIF or WebP only' }).waitFor();
  assert.deepEqual(await pane.evaluate((p) => ({
    chips: [...p.querySelectorAll('.attach img')].map((i) => [i.alt, i.naturalWidth > 0]), text: p.querySelector('.composer textarea').value,
    boxShown: p.querySelector('.composer textarea').getBoundingClientRect().height > 15,
    // The bar grows with the thumbnails instead of squeezing the box (Builder's empty bar); the history keeps its scroller above it.
    fits: (() => { const h = p.querySelector('.hist'), c = p.querySelector('.composer').getBoundingClientRect(), pb = p.getBoundingClientRect();
      return getComputedStyle(h).overflowY === 'auto' && h.clientHeight > 200 && h.getBoundingClientRect().bottom <= c.top + 1 && c.bottom <= pb.bottom + 1
        && ['textarea', '.bar'].every((q) => p.querySelector('.composer ' + q).getBoundingClientRect().bottom <= c.bottom + 1); })(), pwned: window.pwned,
  })), { chips: [['small.png', true], ['big.png', true]], text: 'describe this', boxShown: true, fits: true, pwned: undefined });
  await shot('attach-after.png');
  await pane.locator('.attach [data-unattach="0"]').click();
  assert.deepEqual(await pane.locator('.attach img').evaluateAll((l) => l.map((i) => i.alt)), ['big.png']);
  await box.press('Enter');
  const echoed = await pane.locator('.msg.agent', { hasText: 'echo:describe this[image image/jpeg' }).last().textContent({ timeout: 15000 });
  assert.match(echoed, /\[image image\/jpeg \d+\]/);
  assert.deepEqual([await pane.locator('.attach').count(), await box.inputValue()], [0, '']);
  assert.match(await pane.locator('.msg.user').last().textContent(), /1 image/);
  await shot('attach-sent.png');
  // A pasted screenshot and a file dropped on the chat attach the same way (pasted screenshots did not attach).
  // Synthetic events, so the test never touches the desktop clipboard.
  const small = (await readFile(path.join(profile, 'small.png'))).toString('base64');
  const fire = (sel, kind, name) => pane.locator(sel).evaluate((el, [kind, name, b64]) => {
    const dt = new DataTransfer(); dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name, { type: 'image/png' }));
    el.dispatchEvent(kind === 'paste' ? new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }) : new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, [kind, name, small]);
  await box.fill('pasted');
  await fire('.composer textarea', 'paste', 'image.png');
  await pane.locator('.attach .att').first().waitFor();
  await fire('.hist', 'drop', 'dropped.png');
  await pane.locator('.attach .att').nth(1).waitFor();
  assert.deepEqual([await pane.locator('.attach img').evaluateAll((l) => l.map((i) => i.alt)), await box.inputValue()], [['image.png', 'dropped.png'], 'pasted']);
  await shot('attach-paste-drop.png');
  for (const _ of [0, 1]) await pane.locator('.attach [data-unattach="0"]').click();
  await box.fill('');

  // Sessions on load: a chat stopped before any message is not listed after a restart; a stopped chat that was sent is.
  const stopped = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  await call(instance, `/chat/${stopped}/stop`, 'POST');
  // Opened from its panel row, the chat shows its newest message, not the first.
  const hist = page.locator(`#chats .pane[data-id="${md}"] .hist`);
  for (const time of ['first', 'again']) {
    await page.locator(`#navList .row[data-chat="${id}"]`).click();
    await page.locator(`#chats .pane[data-id="${id}"]`).waitFor({ timeout: 10000 });
    await page.locator(`#navList .row[data-chat="${md}"]`).click();
    await hist.locator('table').waitFor({ timeout: 10000 });
    assert.deepEqual(await hist.evaluate((h) => [h.scrollHeight > h.clientHeight + 100, h.scrollHeight - h.scrollTop - h.clientHeight < 24]), [true, true], 'opens at the bottom: ' + time);
    if (time === 'again') { // a reply arriving while it is open keeps it on the newest message
      await shot('modal-reopen.png');
      await call(instance, `/chat/${md}/prompt`, 'POST', { text: 'pinned' });
      await hist.locator('.msg.agent', { hasText: 'echo:pinned' }).waitFor({ timeout: 15000 });
      await page.waitForTimeout(200);
      assert.equal(await hist.evaluate((h) => h.scrollHeight - h.scrollTop - h.clientHeight < 24), true, 'stays pinned on a new reply');
    }
  }
  // The panel row names a chat by the agent's title, not by its first message (P9 0.1.6).
  await call(instance, `/chat/${md}/prompt`, 'POST', { text: 'title Named by the agent' });
  await page.locator(`#nav .row[data-chat="${md}"]`, { hasText: 'Named by the agent' }).waitFor({ timeout: 15000 });
  // Read before the restart: a restarted chat is a stub with no messages, which hides the difference.
  assert.match(await page.locator(`#navList .row[data-chat="${md}"] .t`).innerText(), /^Named by the agent/, 'row title = the agent\'s title, not the first message');
  // The Stop on its row stops it; a chat that was sent keeps its row.
  await page.locator(`#navList .rstop[data-stop="${md}"]`).click({ timeout: 10000 });
  await page.locator(`#navList .rstop[data-stop="${md}"]`).waitFor({ state: 'detached', timeout: 15000 });
  assert.equal(await page.locator(`#navList .row[data-chat="${md}"]`).count(), 1, 'a stopped chat that was sent stays listed');

  // The chat pet's spot is kept across a restart; the settings file no longer holds one shared spot.
  await app.close();
  ({ app, page } = await launch());
  assert.deepEqual(JSON.parse(await readFile(path.join(profile, 'p9-settings.json'), 'utf8')).pet.chat, look(true, { system: 'dotdot', claude: 'good-pet', codex: 'other-pet' }));
  assert.deepEqual(await petSpots(), { ['mdlBody:' + codex]: dragged });
  await page.locator('#agentInd[data-state="waiting"]').waitFor({ timeout: 15000 });
  assert.equal(await topPets(), 0, 'after the restart: no top-bar pet');
  const rows = () => page.evaluate(() => [...document.querySelectorAll('#navList .row[data-chat]')].map((t) => t.dataset.chat).sort());
  // A chat no message was sent in is not listed once stopped; the stopped chat that was sent is, and opens again.
  await page.locator(`#navList .row[data-chat="${md}"]`).waitFor({ timeout: 15000 });
  assert.deepEqual(await rows(), [id, codex, md].sort(), 'the sent chats are listed, the stopped unsent one is not');
  await page.locator(`#navList .row[data-chat="${md}"]`).click();
  await page.locator(`#chats .pane[data-id="${md}"]`).waitFor({ timeout: 10000 });
  await shot('pets-after-restart.png');
  // Split view: each of the two panes shows its own agent's pet (the Codex chat and the Claude one, opened last).
  await page.locator(`#navList .row[data-chat="${codex}"]`).click();
  await page.locator(`#navList .row[data-chat="${id}"]`).click();
  await page.locator(`#chats .pane[data-id="${id}"]`).waitFor({ timeout: 10000 });
  await page.locator('#chats > .pane').first().locator('[data-tool=split]').click({ timeout: 10000 });
  await page.waitForFunction(() => document.querySelectorAll('#chats .pane canvas.pet').length === 2, null, { timeout: 15000 });
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('#chats .pane')].map((p) => p.getAttribute('aria-label') + ':' + p.querySelector('canvas.pet').dataset.petName).sort().join()), 'Claude chat:good-pet,Codex chat:other-pet');
  await drawn('#chats .pane canvas.pet');
  // Undragged, a chat's pet stands left of its message box, not on it; dragging one leaves the other where it was.
  const placed = () => page.evaluate(() => [...document.querySelectorAll('#chats .pane')].map((p) => {
    const c = p.querySelector('canvas.pet').getBoundingClientRect(), b = p.querySelector('.composer').getBoundingClientRect(), r = p.getBoundingClientRect();
    return { id: p.dataset.id, at: [Math.round(c.x), Math.round(c.y)], onBox: c.right > b.left && c.left < b.right && c.bottom > b.top && c.top < b.bottom, left: c.x + c.width / 2 < b.x + b.width / 2, inPane: c.left >= r.left && c.right <= r.right && c.top >= r.top && c.bottom <= r.bottom };
  }));
  const petsAt = await placed();
  assert.deepEqual(petsAt.map((x) => [x.onBox, x.left, x.inPane]), [[false, true, true], [false, true, true]], JSON.stringify(petsAt));
  await shot('pets-split.png');
  const first = page.locator('#chats .pane').first(), fb = await first.boundingBox(), fc = await first.locator('canvas.pet').boundingBox();
  await page.mouse.move(fc.x + fc.width / 2, fc.y + fc.height / 2); await page.mouse.down();
  await page.mouse.move(fb.x + fb.width * 0.3, fb.y + fb.height * 0.3, { steps: 5 }); await page.mouse.up();
  await page.waitForFunction((k) => JSON.parse(localStorage.getItem('p9-pet-spots') || '{}')[k], 'chats:' + petsAt[0].id);
  const petsMoved = await placed();
  assert.notDeepEqual(petsMoved[0].at, petsAt[0].at, 'the dragged pet moved');
  assert.deepEqual(petsMoved[1].at, petsAt[1].at, 'the other chat pet stayed put');
  await shot('pets-split-dragged.png');
  await page.locator('#chats > .pane').first().locator('[data-tool=split]').click({ timeout: 10000 });
  // Dev (pets off by default) and Chat with pets turned off: the spinner, no chat pets, and no top-bar pet in either.
  await page.keyboard.press('Control+2');
  await spinnerShows('2 agents wait on you', 'Dev');
  await page.keyboard.press('Control+1');
  await page.click('#setBtn'); await page.uncheck('#setPetOn'); await page.click('#setClose');
  await page.waitForFunction(() => !document.querySelector('#chats .pane canvas.pet'));
  await spinnerShows('2 agents wait on you', 'Chat with pets off');
  // No agent active: the top bar shows nothing (the idle top-bar system pet is gone with the rest).
  await setPet('system', 'other-pet');
  for (const chat of [id, codex]) await call(instance, `/chat/${chat}/cancel`, 'POST', {});
  await page.locator('#agentInd').waitFor({ state: 'hidden', timeout: 15000 });
  assert.equal(await topPets(), 0, 'idle: no top-bar pet');

  // Add pets: the folder picker (stubbed here) offers five folders; only the good one is copied, and only its two files.
  await app.evaluate(({ dialog }, filePaths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths }); },
    ['new-pet', 'Bad_Name', 'good-pet', 'link-sheet', 'no-sheet'].map((name) => path.join(src, name)));
  await page.click('#setBtn'); await page.click('#petAdd');
  const toastText = await page.locator('#toasts', { hasText: 'Added new-pet.' }).innerText({ timeout: 10000 });
  for (const part of ['Bad_Name not added: its folder name', 'good-pet not added: a pet with that name is already in P9', 'link-sheet not added: it is not a petdex pet', 'no-sheet not added']) assert.ok(toastText.includes(part), part);
  assert.deepEqual((await readdir(path.join(pets, 'new-pet'))).sort(), ['pet.json', 'spritesheet.png']);
  assert.deepEqual(JSON.parse(await readFile(path.join(pets, 'new-pet', 'pet.json'), 'utf8')), { id: 'new-pet', displayName: 'New', description: 'x', spritesheetPath: 'spritesheet.png' });
  await page.locator('.pet-lib canvas[data-thumb="new-pet"]').waitFor();
  await drawn('.pet-lib canvas[data-thumb]');
  await page.click('[data-pet-mode="mission"]'); await page.selectOption('#setPet-system', 'new-pet');
  await shot('settings-pets.png');
  // Remove: a cancel keeps it; a yes removes the folder and clears it from Mission's pets. The IPC refuses links and bad names.
  page.once('dialog', (d) => d.dismiss()); await page.click('[data-pet-remove="new-pet"]');
  assert.deepEqual((await readdir(path.join(pets, 'new-pet'))).sort(), ['pet.json', 'spritesheet.png']);
  page.once('dialog', (d) => { assert.equal(d.message(), 'Remove New from P9? Any copy in ~/.codex/pets stays.'); d.accept(); }); await page.click('[data-pet-remove="new-pet"]');
  await page.locator('[data-pet-remove="new-pet"]').waitFor({ state: 'detached' });
  await assert.rejects(readdir(path.join(pets, 'new-pet')), { code: 'ENOENT' });
  assert.equal((await settingsNow()).pet.mission.system, null);
  // "Use these pets in all focus modes" copies Chat's three picks; show, size and spots stay per focus.
  await page.click('[data-pet-mode="chat"]');
  const before = (await settingsNow()).pet, picks = (o) => ({ system: o.system, claude: o.claude, codex: o.codex });
  await page.click('#petAll');
  await page.locator('#petAll[disabled]').waitFor({ timeout: 5000 });
  const after = (await settingsNow()).pet;
  for (const m of ['dev', 'mission']) assert.deepEqual(after[m], { ...before[m], ...picks(before.chat) }, m);
  assert.deepEqual(after.chat, before.chat);
  assert.notDeepEqual(picks(before.dev), picks(before.chat), 'the copy changed something');
  const ipc = await app.evaluate(async ({ ipcMain, BrowserWindow }) => {
    const sender = BrowserWindow.getAllWindows()[0].webContents, event = { sender, senderFrame: sender.mainFrame };
    const run = (channel, ...args) => ipcMain._invokeHandlers.get(channel)(event, ...args).then(() => 'accepted', (e) => e.message);
    return [await run('p9:pet-remove', 'link-folder'), await run('p9:pet-remove', '../good-pet'), await run('p9:pet-remove', 'Bad_Name'), await run('p9:pet-remove'), await run('p9:pet-add', '/tmp')];
  });
  assert.deepEqual(ipc, ['pet-refused', 'ipc-sender-refused', 'ipc-sender-refused', 'ipc-sender-refused', 'ipc-sender-refused']);
  assert.equal((await readdir(path.join(pets, 'good-pet'))).length, 2, 'the link target is untouched');
  // Import (option 1 for now): only names in ~/.codex/pets that P9 lacks are offered, and each goes through Add's checks.
  const petdex = path.join(home, 'fake-home', '.codex', 'pets');
  await pet(petdex, 'imp-pet', { displayName: 'Imp', extra: 'not copied' }, { 'spritesheet.png': png, 'run.sh': '#!/bin/sh\n' });
  await pet(petdex, 'good-pet', {}, { 'spritesheet.png': png });
  await pet(petdex, 'Bad_Name', {}, { 'spritesheet.png': png });
  await pet(petdex, 'imp-link', {}); await symlink(path.join(petdex, 'imp-pet', 'spritesheet.png'), path.join(petdex, 'imp-link', 'spritesheet.png'));
  await page.click('#setClose');
  await app.evaluate(({ app }, dir) => app.setPath('home', dir), path.join(home, 'fake-home'));
  await page.click('#setBtn');
  assert.equal(await page.locator('#petImport').textContent(), 'Import 2 new petdex pets');
  await page.click('#petImport');
  const imported = await page.locator('#toasts', { hasText: 'Added imp-pet.' }).innerText({ timeout: 10000 });
  assert.ok(imported.includes('imp-link not added: it is not a petdex pet'), imported);
  assert.deepEqual((await readdir(path.join(pets, 'imp-pet'))).sort(), ['pet.json', 'spritesheet.png']);
  assert.equal((await readdir(path.join(pets, 'good-pet'))).length, 2, 'an existing pet is not replaced');
  await page.locator('.pet-lib canvas[data-thumb="imp-pet"]').waitFor();
  assert.equal(await page.locator('#petImport').textContent(), 'Import 1 new petdex pet', 'the refused one is still offered');
  await page.locator('#petImport').scrollIntoViewIfNeeded(); await shot('settings-pets-import.png');
  assert.equal(await app.evaluate(async ({ ipcMain, BrowserWindow }) => {
    const sender = BrowserWindow.getAllWindows()[0].webContents;
    return ipcMain._invokeHandlers.get('p9:pet-import')({ sender, senderFrame: sender.mainFrame }, '/tmp').then(() => 'accepted', (e) => e.message);
  }), 'ipc-sender-refused');
  // CODEX_HOME: Codex's own pets folder is offered too (petdex itself still writes ~/.codex/pets, so that one stays).
  await pet(path.join(home, 'codex-home', 'pets'), 'ch-pet', {}, { 'spritesheet.png': png });
  await app.evaluate(({}, dir) => { process.env.CODEX_HOME = dir; }, path.join(home, 'codex-home'));
  await page.click('#setClose'); await page.click('#setBtn');
  // The row redraws once main answers; until then it still reads the old count.
  await page.waitForFunction(() => document.querySelector('#petImport')?.textContent === 'Import 2 new petdex pets', null, { timeout: 5000 })
    .catch(async () => assert.equal(await page.locator('#petImport').textContent(), 'Import 2 new petdex pets', 'the CODEX_HOME pet is offered'));
  await page.click('#petImport');
  await page.locator('#toasts', { hasText: 'Added ch-pet.' }).waitFor({ timeout: 10000 });
  assert.deepEqual((await readdir(path.join(pets, 'ch-pet'))).sort(), ['pet.json', 'spritesheet.png']);
  await app.evaluate(() => { delete process.env.CODEX_HOME; });
  // Install (paste the npm command petdex.dev shows): main fetches only petdex.dev's manifest and the pet's two
  // files from assets.petdex.dev (a stand-in fetch here), never runs npx, and each pet goes through Add's checks.
  await app.evaluate(({}, b64) => {
    const files = { 'https://petdex.dev/api/manifest/v2': JSON.stringify({ v: 2, assetBase: 'https://assets.petdex.dev', fields: [], pets: [
      ['dex-pet', 'Dex', 'creature', null, 'pets/dex/sprite.png', 'pets/dex/petjson.json', null, 1],
      ['far-pet', 'Far', 'creature', null, 'https://evil.example/sprite.png', 'https://evil.example/pet.json', null, 1]] }),
      'https://assets.petdex.dev/pets/dex/petjson.json': JSON.stringify({ id: 'dex', displayName: 'Dex', description: 'x', spritesheetPath: '../../evil.png' }),
      'https://assets.petdex.dev/pets/dex/sprite.png': Buffer.from(b64, 'base64') };
    globalThis.petdexSeen = [];
    globalThis.fetch = async (url) => { globalThis.petdexSeen.push(String(url)); return files[url] ? new Response(files[url]) : new Response('no', { status: 404 }); };
  }, png.toString('base64'));
  await page.click('#setClose'); await page.click('#setBtn');
  await page.fill('#petInstall', 'npx petdex@latest install dex-pet far-pet nope-pet');
  await page.click('#petInstallGo');
  const installed = await page.locator('#toasts', { hasText: 'Added dex-pet.' }).innerText({ timeout: 10000 });
  assert.ok(installed.includes('far-pet not added: it is not a petdex pet') && installed.includes('nope-pet not added: petdex.dev has no pet by that name'), installed);
  assert.deepEqual((await readdir(path.join(pets, 'dex-pet'))).sort(), ['pet.json', 'spritesheet.png']);
  assert.ok(!(await app.evaluate(() => globalThis.petdexSeen)).some(u => !u.startsWith('https://petdex.dev/') && !u.startsWith('https://assets.petdex.dev/')), 'only petdex hosts fetched');
  await page.locator('.pet-lib canvas[data-thumb="dex-pet"]').waitFor();
  await page.fill('#petInstall', 'rm -rf ~'); await page.click('#petInstallGo');
  await page.locator('#toasts', { hasText: 'not added: paste the install command from petdex.dev' }).waitFor({ timeout: 10000 });
  await page.locator('#petInstall').scrollIntoViewIfNeeded(); await page.fill('#petInstall', 'npx petdex@latest install boba'); await shot('settings-pets-install.png');
  assert.equal(await app.evaluate(async ({ ipcMain, BrowserWindow }) => {
    const sender = BrowserWindow.getAllWindows()[0].webContents;
    return ipcMain._invokeHandlers.get('p9:pet-install')({ sender, senderFrame: sender.mainFrame }, 42).then(() => 'accepted', (e) => e.message);
  }), 'ipc-sender-refused');
  // A long typo is refused at once (the old one-regex parse took hours on this: catastrophic backtracking in main).
  const typo = await app.evaluate(async ({ ipcMain, BrowserWindow }) => {
    const sender = BrowserWindow.getAllWindows()[0].webContents, started = performance.now();
    const result = await ipcMain._invokeHandlers.get('p9:pet-install')({ sender, senderFrame: sender.mainFrame }, 'install ' + 'a'.repeat(290) + '!');
    return { why: result.refused[0]?.why, ms: performance.now() - started };
  });
  assert.equal(typo.why, 'command'); assert.ok(typo.ms < 500, typo.ms + ' ms');
  // Walkthrough (Ctrl K; it also starts once on the first start, see start-chat.test.mjs): each bubble fits the window, carries Chat's system pet and
  // outlines its step's element (unless that element is hidden); Back goes back; Done and Escape end it in the focus it began in.
  const { WALKTHROUGH } = await import('../apps/web/src/walkthrough.mjs');
  await page.click('#setClose');
  await page.click('#setBtn'); await page.click('[data-pet-mode="chat"]'); await page.selectOption('#setPet-system', 'other-pet'); await page.click('#setClose');
  await page.click('[data-focus-btn="mission"]');
  // Mission #3: Usage keeps its full height beside the Apps list.
  assert.ok(await page.locator('#fMission [data-panel="musage"] .pscroll').evaluate((p) => p.scrollHeight <= p.clientHeight + 1), 'Usage squeezed by Apps');
  const walkStart = async () => { await page.keyboard.press('Control+k'); await page.locator('#palette li', { hasText: 'Walkthrough' }).click(); await page.locator('#walk').waitFor({ timeout: 5000 }); }; // O203: its steps load with the first one
  const walkNow = () => page.evaluate((steps) => {
    const w = document.querySelector('#walk'), r = w.getBoundingClientRect(), n = +w.querySelector('.eyebrow').textContent.split(' ')[0], sel = steps[n - 1].at;
    const el = sel && document.querySelector(sel), shown = el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
    return { n, fits: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, pet: w.querySelector('canvas.pet')?.dataset.petName,
      petSize: w.querySelector('canvas.pet')?.style.height, shown: !!shown, rect: [r.left, r.top, r.right, r.bottom],
      outlined: shown ? document.querySelector('.walk-at') === el : !document.querySelector('.walk-at'), focus: document.querySelector('.shell').dataset.focus };
  }, WALKTHROUGH);
  await walkStart();
  const seenSteps = [];
  for (let n = 1; n <= WALKTHROUGH.length; n++) {
    const now = await walkNow(); seenSteps.push(now);
    assert.deepEqual([now.n, now.fits, now.pet, now.outlined], [n, true, 'other-pet', true], 'step ' + n);
    if (WALKTHROUGH[n - 1].focus) assert.equal(now.focus, WALKTHROUGH[n - 1].focus, 'step ' + n + ' focus');
    // The guide pet at Settings' largest size; the running-chats step points at the robot-head row even
    // while it is empty; in Dev the editor (a view drawn over the page) steps aside so the card stays visible.
    assert.equal(now.petSize, '128px', 'step ' + n + ' pet size');
    if (WALKTHROUGH[n - 1].at === '#rBots') { // with no chat running the row is empty: the step still points at it (Back, Next with it emptied)
      assert.ok(now.shown, 'the running-chats step outlines the robot-head row');
      const empty = await page.evaluate((n) => { document.querySelector('#rBots').replaceChildren(); document.querySelector(`#walk [data-walk="${n - 2}"]`).click(); document.querySelector(`#walk [data-walk="${n - 1}"]`).click();
        const b = document.querySelector('#rBots').getBoundingClientRect(), w = document.querySelector('#walk').getBoundingClientRect();
        return [document.querySelector('.walk-at')?.id, b.width > 0 && b.height > 0, w.left > b.right]; }, n);
      assert.deepEqual(empty, ['rBots', true, true], 'the running-chats step with no chat running');
      await shot('walkthrough-9-empty.png');
    }
    if (now.focus === 'dev') {
      const views = () => app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0], z = w.webContents.getZoomFactor(); return w.contentView.children.filter((v) => v.getVisible() && !v.webContents.getURL().startsWith('p9://cards')).map((v) => { const b = v.getBounds(); return [b.x / z, b.y / z, (b.x + b.width) / z, (b.y + b.height) / z]; }); });
      // The card as it is now, read with each look at the views: the running-chats step above clicks Back and Next, which places
      // the card again from the emptied row, so the card read at the top of this step can be a few pixels off (10 in CI run 42652069714).
      let card = (await walkNow()).rect, shownViews = await views();
      const over = (v) => v[0] < card[2] && v[2] > card[0] && v[1] < card[3] && v[3] > card[1];
      for (let i = 0; i < 30 && (!shownViews.length || shownViews.some(over)); i++) { await page.waitForTimeout(100); card = (await walkNow()).rect; shownViews = await views(); }
      assert.ok(shownViews.length && !shownViews.some(over), 'step ' + n + ': the Dev editor covers the card ' + JSON.stringify([card, shownViews]));
    }
    if ([1, 2, 7, 9, 10, 11, 13, 14, 16].includes(n)) await shot(`walkthrough-${n}.png`);
    if (n === 3) { await page.click('#walk [data-walk="1"]'); assert.equal((await walkNow()).n, 2, 'Back'); await page.click('#walk [data-walk="2"]'); }
    await page.click(`#walk [data-walk="${n}"]`);
  }
  await page.locator('#walk').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => [document.querySelector('.shell').dataset.focus, document.querySelectorAll('.walk-at').length].join()), 'mission,0', 'Done');
  await walkStart(); await page.click('#walk [data-walk="1"]'); await page.keyboard.press('Escape');
  await page.locator('#walk').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.querySelector('.shell').dataset.focus), 'mission', 'Escape');
  console.log('PASS pets: 8 crafted folders refused, markup name kept as text, old file read into every focus, spinner for an agent without a pet, each active agent its own 52 px pet in the top bar (waving while it waits, running while it works, not draggable), each chat its own agent\'s pet, its dragged spot kept across a restart, a hostile Markdown reply with no script/img/iframe/a, meters in a live chat, stopped and closed chats off the tabs after a restart and back from History, Dev off by default and Chat off shows the spinner, Add copied 1 of 5 folders (2 files only), Remove asks, clears the pet and refuses links and bad names');
});

test('Cards: no rebuild per event, old _tyler/ items wait in the bell, a chat-made one gets one notice and a bell row (no card), Skip moves it to the waiting row, running chats are robot heads', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async (paths) => {
    const w = paths.workspace;
    await mkdir(path.join(w, '_tyler'), { recursive: true }); await mkdir(path.join(w, 'hub'), { recursive: true });
    await writeFile(path.join(w, 'hub/registry.json'), JSON.stringify({ scripts: [], apps: [], pages: [] }));
    await writeFile(path.join(w, 'AGENTS.md'), '# Projects\n');
    await writeFile(path.join(w, '_tyler/old-question.md'), '# Old question\n\nA.\n\n**Project:** Example Project\n');
    await writeFile(path.join(paths.directory, 'settings.json'), JSON.stringify({ waiting: '_tyler', registry: 'hub/registry.json', primary: 'AGENTS.md' }));
    return { args: ['--acp-override', fake, '--settings', path.join(paths.directory, 'settings.json')] };
  });
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-cards-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow(), started = Date.now();
  const shot = async (name) => { if (process.env.P9_EVIDENCE) { await page.waitForTimeout(400); await page.screenshot({ path: path.join(process.env.P9_EVIDENCE, name) }); } };
  const center = async () => { await page.click('#rBell'); const text = await page.locator('#mdlBody').innerText(); await page.keyboard.press('Escape'); return text; };
  await page.locator('#rBell b', { hasText: '1' }).waitFor({ timeout: 15000 });
  // An item already waiting at start goes to the bell, not the stack.
  assert.equal(await page.locator('#cards [data-key^="reviews:"]').count(), 0);
  assert.match(await center(), /1 item in _tyler\/\nwaiting/);
  // A turn's end is read from the panel's strip: it is drawn in every focus, the list only while the panel is open.
  const turn = async (id, text) => { await call(instance, `/chat/${id}/prompt`, 'POST', { text }); await page.locator(`#rBots .bot[data-chat="${id}"]:not([data-busy])`).waitFor({ state: 'attached', timeout: 15000 }); };
  const id = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  // A chat that writes a _tyler/ item: the item gets a notice when the turn ends. Notices stay until this test clears them.
  await page.evaluate(() => document.documentElement.style.setProperty('--toast-life', '600s'));
  await writeFile(path.join(instance.workspace, '_tyler/new-question.md'), '# Made by the chat\n\nA.\n');
  await turn(id, 'make one');
  // 733: the item shows once as a notice at the bottom right and is a row in the bell, not a staying card.
  const notice = page.locator('#toasts .toast', { hasText: '1 item needs you' });
  await notice.waitFor({ timeout: 10000 });
  assert.equal(await page.locator(`#navList .rowwrap[data-live] .row[data-chat="${id}"] .dot`).getAttribute('data-agent'), 'claude', 'the running chat is a live row in the panel');
  // Replied: nothing stays on the stack for the chat or the item.
  assert.equal(await page.locator('#cards .card:not([data-key="welcome"])').count(), 0, 'a new item made a staying card');
  await shot('cards-new-item.png');
  assert.match(await center(), /1 item needs you\n_tyler\/\n/, 'the new item is a bell row, its sub the folder alone (no project line in the file, so no " · " and no slug)');
  // Another turn redraws everything; the item is not new again, so no second notice.
  await turn(id, 'again');
  assert.equal(await notice.count(), 1, 'one notice per new item, not one per redraw');
  await page.evaluate(() => { document.documentElement.style.removeProperty('--toast-life'); document.querySelectorAll('#toasts .toast').forEach((el) => el.remove()); });
  // Skip from its bell row: it waits in the bell with the old one.
  await page.click('#rBell');
  await page.locator('#mdlBody .mlist [data-i]', { hasText: '1 item needs you' }).click();
  // O181: the review modal's title carries the project only when the file says one; this one does not, so no trailing ' · '.
  assert.match(await page.locator('#mdlT').innerText(), /^\d+ of \d+$/, 'the empty-project review modal title has no dangling separator');
  await page.locator('#mdlFoot [data-skip]').click();
  if (await page.locator('#mdl[open]').count()) await page.keyboard.press('Escape');
  // No sample notices in the bell on a live daemon (they were sample data); they toasted 2.5 s and 5.5 s after load.
  await page.waitForTimeout(Math.max(0, started + 6500 - Date.now()));
  const bell = await center();
  assert.match(bell, /2 items in _tyler\/\nwaiting/);
  assert.doesNotMatch(bell, /needs you/, 'the skipped item still has its own row');
  assert.doesNotMatch(bell, /rss-report|restic snapshot/, 'sample notices in the live bell');
  await shot('cards-skipped.png');
  // O181 (coordinator's call): an item whose file names a project keeps "project · age" in its row and the
  // project in its modal title; the one with no project line shows the age alone and "N of M" alone.
  await page.click('#rBell');
  await page.locator('#mdlBody .mlist [data-i]', { hasText: '2 items in _tyler/' }).click();
  assert.match(await page.locator('#mdlBody .mlist [data-i]', { hasText: 'Old question' }).innerText(), /Example Project · /, 'a projected item\'s row shows "project · age"');
  assert.doesNotMatch(await page.locator('#mdlBody .mlist [data-i]', { hasText: 'Made by the chat' }).innerText(), / · /, 'the empty-project item\'s row shows the age alone');
  await page.locator('#mdlBody .mlist [data-i]', { hasText: 'Old question' }).click();
  assert.match(await page.locator('#mdlT').innerText(), /^\d+ of \d+ · Example Project$/, 'a projected item\'s modal title ends with its project');
  await page.keyboard.press('Escape');
  if (await page.locator('#mdl[open]').count()) await page.keyboard.press('Escape');
  // Sort Waiting on you by newest or by project, the file name's <project>- prefix (an optional sorter
  // for the items, by project or date updated). old-question.md is touched last, so the two orders differ.
  await utimes(path.join(instance.workspace, '_tyler/old-question.md'), new Date(), new Date(Date.now() + 60000));
  await turn(id, 'touch');
  await page.click('#rMission');
  const needs = page.locator('#fMission .needs [data-list] li .txt'), sort = page.locator('#fMission .needs [data-sort]');
  await page.waitForFunction(() => document.querySelector('#fMission .needs [data-list] li .txt')?.textContent === 'Old question', null, { timeout: 10000 });
  assert.deepEqual([await sort.inputValue(), ...await needs.allInnerTexts()], ['updated', 'Old question', 'Made by the chat'], 'newest first by default');
  await sort.selectOption('project');
  assert.deepEqual(await needs.allInnerTexts(), ['Made by the chat', 'Old question'], 'by project: new-question.md before old-question.md');
  if (process.env.P9_EVIDENCE) { await page.waitForTimeout(400); await page.locator('#fMission .needs').screenshot({ path: path.join(process.env.P9_EVIDENCE, 'sort-project.png') }); }
  await page.reload(); await page.click('#rMission');
  await page.waitForFunction(() => document.querySelector('#fMission .needs [data-list] li .txt')?.textContent === 'Made by the chat', null, { timeout: 10000 });
  assert.equal(await sort.inputValue(), 'project', 'the choice survives a reload');
  // An item with no A. line (Q1:/Q2: lines, "changed on disk" for days): Save says why, nothing written.
  const noLine = '# No answer line\n\nQ1:\nQ2:\n';
  await writeFile(path.join(instance.workspace, '_tyler/qa-lines.md'), noLine);
  await turn(id, 'qa');
  await page.locator('#fMission .needs [data-list] li button', { hasText: 'No answer line' }).click();
  await page.locator('#mdlBody textarea').fill('Q1 yes, Q2 yes');
  await page.click('#mdlFoot [data-save]');
  await page.locator('#toasts', { hasText: 'qa-lines.md has no empty A. line' }).waitFor({ timeout: 10000 });
  assert.equal(await readFile(path.join(instance.workspace, '_tyler/qa-lines.md'), 'utf8'), noLine);
  await page.keyboard.press('Escape');
  await page.click('#rChat');
  // The Stop on the chat's panel row stops it (the tab's x is gone); the row loses its Stop.
  await page.locator('#navList .rstop[data-stop="' + id + '"]').click({ timeout: 10000 });
  await page.locator('#navList .rstop[data-stop="' + id + '"]').waitFor({ state: 'detached', timeout: 15000 });
  let state; for (let i = 0; i < 50 && state !== 'stopped'; i++, await new Promise((r) => setTimeout(r, 200))) state = (await call(instance, '/chat')).conversations.find((c) => c.id === id)?.state;
  assert.equal(state, 'stopped', 'the row Stop left the chat running');
  console.log('PASS cards: old item quiet in the bell, chat-made item carded at turn end, card kept across events, Skip clears it, chat is a live row, its row Stop stops it');
});

test('Models and slash commands: the Model pill lists the agent\'s own models, typing / lists its commands, a picked model reaches the agent', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-models-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#rChat').waitFor();
  const id = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'hello' });
  await page.locator('#navList .rowwrap[data-live]:not(:has([data-busy])) .row[data-chat="' + id + '"]').waitFor({ timeout: 15000 });
  await page.locator('#nav .row[data-chat="' + id + '"]').click();
  const pane = page.locator('.pane[data-id="' + id + '"]');
  // 0.1.8: the Model pill in the message bar lists the agent's models under its name, then Fast mode under its own (no submenus).
  await pane.locator('[data-pill="Model"][aria-label="Model: Default (recommended)"]').waitFor({ timeout: 10000 });
  assert.deepEqual(await pillItems(page, pane, 'Model'), ['Default (recommended) ✓', 'Opus', 'Haiku', 'On', 'Off ✓']);
  assert.deepEqual(await page.locator('#pillMenu .hd').evaluateAll((l) => l.map((h) => h.textContent)), ['Claude', 'Fast mode']);
  const ta = pane.locator('.composer textarea'), menu = pane.locator('[data-slash]');
  await ta.click(); await page.keyboard.type('/');
  assert.deepEqual(await menu.locator('[data-cmd]').evaluateAll((b) => b.map((x) => x.dataset.cmd)), ['compact', 'context', 'review']);
  // A real agent sends dozens of commands: rows keep their height and the menu scrolls (rows were squashed to slivers).
  await menu.evaluate((m) => { for (let i = 0; i < 40; i++) m.append(m.firstElementChild.cloneNode(true)); });
  if (process.env.P9_EVIDENCE) await page.screenshot({ path: path.join(process.env.P9_EVIDENCE, 'slash-menu-long.png') });
  const rows = await menu.evaluate((m) => { const out = { min: Math.min(...[...m.children].map((b) => b.offsetHeight)), scrolls: m.scrollHeight > m.clientHeight, menu: m.clientHeight }; [...m.children].slice(3).forEach((b) => b.remove()); return out; });
  assert.ok(rows.min >= 20 && rows.scrolls, '43 commands: shortest row ' + rows.min + 'px, ' + JSON.stringify(rows));
  await page.keyboard.type('co');
  assert.deepEqual(await menu.locator('[data-cmd]').evaluateAll((b) => b.map((x) => x.dataset.cmd)), ['compact', 'context']);
  if (process.env.P9_EVIDENCE) await page.screenshot({ path: path.join(process.env.P9_EVIDENCE, 'slash-menu.png') });
  await ta.fill('/pact'); await ta.dispatchEvent('input');
  assert.deepEqual(await menu.locator('[data-cmd]').evaluateAll((b) => b.map((x) => x.dataset.cmd)), ['compact'], 'a word inside a name finds it');
  await ta.fill('/co'); await ta.dispatchEvent('input');
  await page.keyboard.press('Tab');
  assert.equal(await ta.inputValue(), '/compact ');
  assert.equal(await menu.isHidden(), true, 'menu closes once a space follows the name');
  await ta.fill('');
  // Flashing: a turn updates the pane and its panel row in place; rebuilt ones restart every animation.
  await pane.evaluate((el) => { el.kept = 'yes'; }); await page.locator('#nav .row[data-chat="' + id + '"]').evaluate((el) => { el.kept = 'yes'; });
  await choose(page, pane, 'Model', 'Opus');
  assert.equal(await pillValue(pane, 'Model'), 'Default (recommended), Opus pending', 'O133: the pill names the running model, the pick pending');
  await ta.click(); await page.keyboard.type('model'); await page.keyboard.press('Enter');
  await pane.getByText('model:opus').waitFor({ timeout: 15000 });
  await page.locator('#navList .rowwrap[data-live]:not(:has([data-busy])) .row[data-chat="' + id + '"]').waitFor({ timeout: 15000 });
  assert.equal(await pillValue(pane, 'Model'), 'Opus', 'the pill shows the model now in use');
  assert.deepEqual([await pane.evaluate((el) => el.kept), await page.locator('#nav .row[data-chat="' + id + '"]').evaluate((el) => el.kept)], ['yes', 'yes'], 'pane or row rebuilt by the turn');
  // Effort and the other agent settings (all of them wired; threat model row 22): the agent's own lists, picked values reach it.
  // The default mark needs the daemon's own read of the agent's lists, which may land after the chat's first turn: wait for it.
  await pane.locator('[data-pill="Effort"][aria-label="Effort: Medium (Default)"]').waitFor({ timeout: 20000 });
  assert.deepEqual(await pillItems(page, pane, 'Effort'), ['Low', 'Medium (Default) ✓', 'High']);
  assert.deepEqual(await pillItems(page, pane, 'Model'), ['Default (recommended)', 'Opus ✓', 'Haiku', 'On', 'Off ✓']);
  // O71: the Effort default can show while the daemon's one fresh read of the lists still says loading (its agent is being
  // stopped). When the read ends, the open Model menu drops its "Reading…" note and morph, which matches rows by position,
  // relabels the row a click had found as On to Off: the pick sent was Off. Pick only once the read is over.
  await pillOf(pane, 'Model').click();
  await page.locator('#pillMenu [data-list-note]').waitFor({ state: 'detached', timeout: 20000 }).catch(async () => {
    throw new Error('the lists read never ended: Model menu ' + (await page.locator('#pillMenu').innerText()).replace(/\s+/g, ' ')); });
  await page.keyboard.press('Escape');
  await choose(page, pane, 'Effort', 'High'); await choose(page, pane, 'Model', 'On');
  await ta.click(); await page.keyboard.type('config'); await page.keyboard.press('Enter');
  // A failed wait says what the agent did answer and what the pills showed, so a red run names the lost pick.
  await pane.getByText('config:model=opus,effort=high,fast=on,sandbox=on').waitFor({ timeout: 15000 }).catch(async () => {
    throw new Error('the picks did not reach the agent: Effort pill ' + await pillValue(pane, 'Effort') + ', chat ends: ' + (await pane.innerText()).slice(-300).replace(/\s+/g, ' ')); });
  await page.locator('#navList .rowwrap[data-live]:not(:has([data-busy])) .row[data-chat="' + id + '"]').waitFor({ timeout: 15000 });
  assert.equal(await pillValue(pane, 'Effort'), 'High', 'the pill shows the effort now in use');
  assert.deepEqual(await pillItems(page, pane, 'Model'), ['Default (recommended)', 'Opus ✓', 'Haiku', 'On ✓', 'Off'], 'the menu shows the fast mode now in use');
  if (process.env.P9_EVIDENCE) await pane.locator('.composer .bar').screenshot({ path: path.join(process.env.P9_EVIDENCE, 'pickers.png') });
  // Split shows the last two chats opened (one chat open, then a new one, and Split showed one pane).
  await page.locator('#chats > .pane').first().locator('[data-tool=split]').click({ timeout: 10000 });
  const second = (await call(instance, '/chat', 'POST', { provider: 'codex' })).conversation;
  await page.waitForFunction(([a, b]) => document.querySelector('#chats').dataset.split === 'true' && [...document.querySelectorAll('#chats .pane')].map((p) => p.dataset.id).join() === b + ',' + a, [id, second], { timeout: 15000 });
  // The new chat's title is painted as a gradient clipped to its text, so the paint stops at the heading's box: the text's
  // glyph area must sit inside it (the bottom of the g in "What are we working on" was cut off).
  const title = pane.page().locator('.pane[data-id="' + second + '"] .welcome h2');
  const fit = await title.evaluate((h) => { const r = document.createRange(); r.selectNodeContents(h); const t = r.getBoundingClientRect(), b = h.getBoundingClientRect();
    return { clip: getComputedStyle(h).backgroundClip, below: Math.round(t.bottom - b.bottom), above: Math.round(b.top - t.top), right: Math.round(t.right - b.right) }; });
  if (process.env.P9_EVIDENCE) { const b = await title.boundingBox(); await page.screenshot({ path: path.join(process.env.P9_EVIDENCE, 'welcome-title.png'), clip: { x: b.x - 12, y: b.y - 12, width: b.width + 24, height: b.height + 24 } }); }
  // Not the top: the font's ascent there is empty space above its tallest letters (welcome-title.png, W h k whole either way).
  assert.deepEqual([fit.clip, fit.below <= 0, fit.right <= 0], ['text', true, true], 'the title text fits its box: ' + JSON.stringify(fit));
  // A live chat starts on its first message, so the welcome says so instead of a Start button that did nothing (Windows smoke, 2026-10-17).
  const welcome = pane.page().locator('.pane[data-id="' + second + '"] .welcome');
  assert.deepEqual([await welcome.locator('[data-start]').count(), await welcome.locator('[data-start-hint]').innerText()], [0, 'Type your first message below to start.']);
  console.log('PASS models: 3 agent models listed, / lists 3 commands and filters to 2, Tab fills /compact, Opus picked and used, Effort High + Fast On used; Split shows the new chat beside the last one');
});

// A new chat picks the folder it opens in from a dropdown.
// Threat model row 24: Choose folder... is the system dialog in main (stubbed here); only a folder inside the workspace comes back.
test('Chat rows: each chat\'s panel row shows the name the agent gave the chat, its dot in the agent\'s colour (Claude orange, Codex blue)', { timeout: 120000 }, async (t) => {
  // Each chat's tab at the top shows the chat's name; its dot is the agent's colour (Claude orange, Codex blue).
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-tabs-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#rChat').waitFor();
  const claude = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  const codex = (await call(instance, '/chat', 'POST', { provider: 'codex' })).conversation;
  await call(instance, '/chat/' + claude + '/prompt', 'POST', { text: 'title Fix the login bug' });
  await call(instance, '/chat/' + codex + '/prompt', 'POST', { text: 'hello' });
  const tab = (id) => page.locator('#navList .row[data-chat="' + id + '"]');
  await tab(claude).getByText('Fix the login bug').waitFor({ timeout: 15000 });
  await tab(codex).waitFor({ timeout: 15000 });
  assert.equal(await tab(codex).locator('.t').innerText(), 'Codex', 'no name sent yet: the agent\'s name');
  const dot = (id) => tab(id).locator('.dot').evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.deepEqual([await dot(claude), await dot(codex)], ['rgb(217, 119, 87)', 'rgb(59, 130, 246)']);
  if (process.env.P9_EVIDENCE) await page.locator('#nav').screenshot({ path: path.join(process.env.P9_EVIDENCE, 'chat-rows.png') });
  console.log('PASS chat rows: "Fix the login bug" on the Claude row, Codex unnamed, dots orange and blue');
});

test('Agent images: a generated image and a reply\'s image show at their real size; an image known only by its address is never loaded (threat model row 26)', { timeout: 120000 }, async (t) => {
  // Images an agent makes show in the chat feed.
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-imgs-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  const asked = []; page.on('request', (request) => { if (!/^(data|p9):/.test(request.url())) asked.push(request.url()); });
  await page.locator('#rChat').waitFor();
  const codex = (await call(instance, '/chat', 'POST', { provider: 'codex' })).conversation;
  await call(instance, '/chat/' + codex + '/prompt', 'POST', { text: 'images' });
  await page.locator('#nav .row[data-chat="' + codex + '"]').click();
  const pane = page.locator('#chats .pane[data-id="' + codex + '"]');
  await pane.locator('.msg.agent .agent-imgs img').waitFor({ timeout: 15000 });
  await page.waitForFunction((id) => [...document.querySelectorAll(`#chats .pane[data-id="${id}"] .agent-imgs img`)].every((i) => i.complete && i.naturalWidth), codex);
  assert.deepEqual(await pane.evaluate((p) => ({
    images: [...p.querySelectorAll('.agent-imgs img')].map((i) => [i.alt, i.naturalWidth, i.naturalHeight, i.src.slice(0, 22), !!i.closest('details')]),
    reply: p.querySelector('.msg.agent').textContent.includes('[image not shown'),
    sources: [...p.querySelectorAll('img')].filter((i) => !i.src.startsWith('data:')).length,
  })), { images: [['Image from Codex', 320, 200, 'data:image/png;base64,', false], ['Image from Codex', 120, 90, 'data:image/png;base64,', false]], reply: true, sources: 0 });
  assert.deepEqual(asked.filter((url) => /example\.com|never-read/.test(url)), [], 'nothing fetched for an image');
  if (process.env.P9_EVIDENCE) await pane.screenshot({ path: path.join(process.env.P9_EVIDENCE, 'agent-images.png') });
  // Codex's view_image names only the file's path; the daemon reads the file (threat model row 27).
  await call(instance, '/chat/' + codex + '/prompt', 'POST', { text: 'images from disk' });
  await page.waitForFunction((id) => { const all = [...document.querySelectorAll(`#chats .pane[data-id="${id}"] .agent-imgs img`)]; return all.length >= 5 && all.every((i) => i.complete && i.naturalWidth); }, codex, { timeout: 15000 });
  assert.deepEqual(await pane.evaluate((p) => [...p.querySelectorAll('.agent-imgs img')].slice(2).map((i) => [i.naturalWidth, i.naturalHeight, !!i.closest('details')])),
    [[64, 48, false], [64, 48, false], [64, 48, false]], 'the opened file, its file:// twin and the reply link, outside the collapsed step');
  if (process.env.P9_EVIDENCE) await pane.screenshot({ path: path.join(process.env.P9_EVIDENCE, 'agent-images-disk.png') });
  // The window lagged and froze on a 25,000-event chat; a chat draws only its latest 200 steps.
  await call(instance, '/chat/' + codex + '/prompt', 'POST', { text: 'many steps' });
  await pane.locator('.msg.agent', { hasText: 'All steps done.' }).waitFor({ timeout: 15000 });
  const steps = () => pane.evaluate((p) => ({ tools: p.querySelectorAll('details.tool').length, first: p.querySelector('details.tool .ttl')?.textContent, more: p.querySelector('[data-earlier]')?.textContent ?? null }));
  const tail = await steps();
  assert.deepEqual([tail.tools, tail.first], [199, 'Step 52'], 'only the latest 200 steps drawn'); assert.match(tail.more, /^Show earlier \(\d+ more\)$/);
  if (process.env.P9_EVIDENCE) await pane.screenshot({ path: path.join(process.env.P9_EVIDENCE, 'show-earlier.png') });
  await pane.locator('[data-earlier]').click();
  assert.deepEqual(await steps(), { tools: 252, first: 'Image generation', more: null }, 'Show earlier draws the rest');
  console.log('PASS agent images: the 320x200 generated image (tool collapsed) and the 120x90 reply image show from data:, the address-only image is a note, no request for either; a view_image path shows the file');
});

test('Chat folder: a new chat shows its folder and replaces only an unsent chat', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  await mkdir(path.join(instance.workspace, 'proj/sub'), { recursive: true });
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-folder-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow(); await page.locator('#rChat').waitFor();
  await page.click('#newBtn');
  const folder = page.locator('.pane [data-chat-folder]');
  await folder.filter({ hasText: instance.workspace }).waitFor({ timeout: 15000 });
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT new-folder-welcome ' + (await page.screenshot()).toString('base64'));
  const before = (await call(instance, '/chat')).conversations[0].id;
  await app.evaluate(({ dialog }, filePaths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths }); }, [path.join(instance.workspace, 'proj/sub')]);
  await folder.click();
  await page.locator('.pane [data-chat-folder]').filter({ hasText: path.join(instance.workspace, 'proj/sub') }).waitFor({ timeout: 15000 });
  let chats = (await call(instance, '/chat')).conversations;
  assert.equal(chats.length, 1); assert.notEqual(chats[0].id, before); assert.equal(chats[0].folder, 'proj/sub');
  const pane = page.locator('.pane[data-id="' + chats[0].id + '"]');
  await pane.locator('.composer textarea').fill('cwd'); await pane.locator('.composer textarea').press('Enter');
  await pane.locator('.hist', { hasText: 'cwd:new:' + path.join(instance.workspace, 'proj/sub') }).waitFor({ timeout: 20000 });
  for (const text of ['hello', 'again']) { await pane.locator('.composer textarea').fill(text); await pane.locator('.composer textarea').press('Enter'); await pane.locator('.hist', { hasText: 'echo:' + text }).waitFor({ timeout: 20000 }); }
  assert.equal(await pane.locator('[data-chat-folder]').count(), 0, 'folder cannot change after sending');
  assert.equal(await pane.locator('.chat-folder-readonly').innerText(), path.join(instance.workspace, 'proj/sub'));
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT desktop-folder-readonly ' + (await page.screenshot()).toString('base64'));
  await page.click('#newBtn');
  await page.waitForFunction(async () => (await window.p9.chat('list')).body.conversations.length === 2, null, { timeout: 10000 });
  chats = (await call(instance, '/chat')).conversations;
  assert.equal(chats[0].folder, '', 'a later chat starts in the workspace');
  await page.locator('.pane [data-chat-folder]').filter({ hasText: instance.workspace }).waitFor();
  const outside = path.join(instance.directory, 'outside-workspace'); await mkdir(outside);
  await app.evaluate(({ dialog }, filePaths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths }); }, [outside]);
  await page.locator('.pane [data-chat-folder]').click();
  await page.locator('#toasts', { hasText: 'inside the workspace' }).waitFor({ timeout: 10000 });
  await call(instance, '/file-protection', 'POST', { on: false });
  await page.locator('.pane [data-chat-folder]').click();
  await page.locator('.pane [data-chat-folder]').filter({ hasText: outside }).waitFor({ timeout: 15000 });
  await call(instance, '/agent-lock', 'POST', { on: true });
  assert.equal(await page.evaluate(() => window.p9.pickFolder()), null, 'agent lock refuses outside');
  console.log('PASS chat folder: path shown, chosen folder reaches the agent, empty old chat removed, next chat starts in workspace, outside needs unrestricted');
});

test('Chat folder: sending while the picker is open keeps the original chat', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  await mkdir(path.join(instance.workspace, 'proj'), { recursive: true });
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-folder-race-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process(); t.after(async () => { await Promise.race([app.close(), new Promise(resolve => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow(); await page.locator('#rChat').waitFor(); await page.click('#newBtn');
  const folder = page.locator('.pane [data-chat-folder]'); await folder.filter({ hasText: instance.workspace }).waitFor();
  const original = (await call(instance, '/chat')).conversations[0].id;
  await app.evaluate(({ dialog }) => { dialog.showOpenDialog = () => new Promise(resolve => { globalThis.finishFolderPick = resolve; }); });
  await folder.click();
  const pane = page.locator('.pane[data-id="' + original + '"]');
  await pane.locator('.composer textarea').fill('hello'); await pane.locator('.composer textarea').press('Enter');
  await pane.locator('.hist', { hasText: 'echo:hello' }).waitFor({ timeout: 20000 });
  await app.evaluate((_, selected) => globalThis.finishFolderPick({ canceled: false, filePaths: [selected] }), path.join(instance.workspace, 'proj'));
  await page.locator('#toasts', { hasText: 'This chat has a message now' }).waitFor({ timeout: 15000 });
  await page.waitForFunction(async id => { const c = (await window.p9.chat('list')).body.conversations; return c.length === 1 && c[0].id === id; }, original, { timeout: 10000 });
});

test('Chat file browser: each scope lists its real folder, a file opens in the editor with its text, ../, links and locked names are refused (threat model row 23)', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async (paths) => {
    const w = paths.workspace;
    for (const dir of ['_tyler', '_ideas', '_private', 'hub', 'proj/sub']) await mkdir(path.join(w, dir), { recursive: true });
    await writeFile(path.join(w, 'hub/registry.json'), JSON.stringify({ scripts: [], apps: [], pages: [] }));
    await writeFile(path.join(w, 'AGENTS.md'), '# Projects\n\n**Main project: Proj** (`proj/`)\n');
    await writeFile(path.join(w, 'proj/notes.md'), 'project notes\nline two\n');
    await writeFile(path.join(w, 'proj/sub/deep.md'), 'deep\n');
    await writeFile(path.join(w, '_tyler/question.md'), '# Question\n\nA.\n');
    await writeFile(path.join(w, '_ideas/idea.md'), 'an idea\n');
    await writeFile(path.join(w, '_' + 'private/secret.md'), 'secret\n');
    await symlink(paths.directory, path.join(w, 'out'));
    await writeFile(path.join(paths.directory, 'settings.json'), JSON.stringify({ waiting: '_tyler', registry: 'hub/registry.json', primary: 'AGENTS.md' }));
    return { args: ['--acp-override', fake, '--settings', path.join(paths.directory, 'settings.json')] };
  });
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-files-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#rBell b', { hasText: '1' }).waitFor({ timeout: 15000 }); // Mission answered: the browser is live
  const listed = async (where) => { await page.locator('#tree .where', { hasText: where }).waitFor({ timeout: 5000 });
    await page.waitForFunction(() => !document.querySelector('#tree').textContent.includes('Loading'), null, { timeout: 5000 });
    return page.locator('#tree button').allInnerTexts(); };
  const scope = async (label, where) => { await page.locator('#fileScope').selectOption({ label }); return listed(where); };
  // Files is a chat pane's tool: a new chat starts in the main project, so Current project lists it; folders come first and open in place.
  await openFiles(page);
  const names = () => page.locator('#tree button span.truncate').allInnerTexts();
  await listed('proj'); assert.deepEqual(await names(), ['sub', 'notes.md'], 'main project');
  await page.locator('#tree [data-ldir="proj/sub"]').click();
  await page.locator('#tree [data-lfile="proj/sub/deep.md"]').waitFor({ timeout: 5000 });
  // A file opens with its text in the editor (Save is tested in file-edit.test.mjs); no Make Primary.
  await page.locator('#tree [data-lfile="proj/notes.md"]').click();
  await page.waitForFunction(() => document.querySelector('#mdlBody textarea')?.value.includes('line two'), null, { timeout: 5000 });
  if (process.env.P9_EVIDENCE) { await page.waitForTimeout(400); await page.screenshot({ path: path.join(process.env.P9_EVIDENCE, 'chat-files-view.png') }); }
  assert.equal(await page.locator('#mdlT').innerText(), 'proj/notes.md');
  assert.equal(await page.locator('#mdlBody textarea').count(), 1);
  assert.equal(await page.locator('#mdlPrimary').isHidden(), true);
  await page.keyboard.press('Escape');
  await scope('Workspace', 'Workspace');
  if (process.env.P9_EVIDENCE) await page.screenshot({ path: path.join(process.env.P9_EVIDENCE, 'chat-files-workspace.png') });
  assert.deepEqual(await names(), ['_ideas', '_tyler', 'hub', 'proj', 'AGENTS.md', 'note.txt'], 'no _private, no link');
  await scope('Needs you', '_tyler'); assert.deepEqual(await names(), ['question.md']);
  await scope('Ideas', '_ideas'); assert.deepEqual(await names(), ['idea.md']);
  // Current project follows the chat shown: a chat started in proj/sub.
  await scope('Current project', 'proj');
  await app.evaluate(({ dialog }, filePaths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths }); }, [path.join(instance.workspace, 'proj/sub')]);
  await page.click('#newBtn');
  await page.locator('.pane [data-chat-folder]').click();
  await page.locator('.pane [data-chat-folder]').filter({ hasText: path.join(instance.workspace, 'proj/sub') }).waitFor({ timeout: 10000 });
  await listed('proj/sub'); assert.deepEqual(await names(), ['deep.md']);
  // List and read take one string path each (save is tested in file-edit.test.mjs); the daemon refuses ../, links and locked names as on every file route.
  const ask = (action, payload) => page.evaluate(([a, p]) => window.p9.mission(a, p), [action, payload]);
  const refused = { status: 400, body: { error: 'request-refused' } };
  for (const [action, payload] of [['list', { path: 7 }], ['read', {}], ['read', { path: ['proj/notes.md'] }], ['list', { path: '../' }], ['list', { path: 'out' }],
    ['read', { path: 'out/settings.json' }], ['list', { path: '_' + 'private' }], ['read', { path: '_' + 'private/secret.md' }], ['read', { path: 'proj/../_' + 'private/secret.md' }]]) {
    assert.deepEqual(await ask(action, payload), refused, action + ' ' + JSON.stringify(payload));
  }
  assert.equal((await ask('read', { path: 'proj/notes.md' })).body.content, 'project notes\nline two\n');
  await assert.rejects(ask('write', { path: 'proj/notes.md', content: 'x' }), /ipc-sender-refused/);
  console.log('PASS chat file browser: four scopes list their folders, Current project follows the chat shown, files open in the editor, bad paths refused');
});

test('Turn finished: a live turn-end nobody watches makes one notice (P9 words only) and a bell row, no card; opening the chat clears it; replay makes none (threat model row 21)', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-done-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#rChat').waitFor();
  // The window is in the background; the OS notice is recorded instead of shown.
  const background = () => { window.__notes = []; document.hasFocus = () => false; window.Notification = class { constructor(title, o) { window.__notes.push([title, o.body]); } }; };
  await page.evaluate(background);
  const id = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  // The chat's row means the window is past its first read (the replay): a turn that ends inside the replay is old news
  // and rightly makes no card, so prompting before it raced the window's start.
  await page.locator('#nav .row[data-chat="' + id + '"]').waitFor({ timeout: 15000 });
  await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'hello' });
  // 733: the finish shows once as a notice at the bottom right and is a row in the bell, not a staying card.
  const notice = page.locator('#toasts .toast', { hasText: 'Claude finished' });
  const bell = async () => { await page.click('#rBell'); const text = await page.locator('#mdlBody').innerText(); await page.keyboard.press('Escape'); return text; };
  await notice.waitFor({ timeout: 15000 });
  assert.deepEqual(await page.evaluate(() => window.__notes), [['Claude finished', 'Claude']], 'one notice, agent and tab title only');
  assert.match(await notice.innerText(), /Claude finished\s*Claude/);
  assert.equal(await page.locator('#cards [data-key^="done:"]').count(), 0, 'a finish made a staying card');
  assert.match(await bell(), /Claude finished\nClaude/, 'the finish is a bell row');
  // Back at the window: opening the chat from the notice clears it.
  await page.evaluate(() => { document.hasFocus = () => true; });
  await notice.click();
  await page.locator('#mdl[open] #mdlBody .hist').waitFor({ timeout: 5000 });
  // Opened is seen at once, in the marks kept over a restart too (not only once the chat list next redraws).
  assert.equal(await page.evaluate((id) => JSON.parse(localStorage.getItem('p9-unseen') || '{}')[id], id), undefined, 'opened from its notice, still kept as unseen');
  await page.keyboard.press('Escape');
  assert.doesNotMatch(await bell(), /Claude finished/, 'opening the chat left its bell row');
  // A reload replays the turn-end: no notice, no OS notice, no bell row.
  // Still in the background from the first script on, so only the replay guard stops it.
  await page.addInitScript(background);
  await page.reload(); await page.locator('#nav .row[data-chat="' + id + '"]').waitFor({ timeout: 15000 });
  await page.waitForTimeout(1500);
  assert.deepEqual([await page.locator('#toasts .toast').count(), await page.evaluate(() => window.__notes)], [0, []], 'replayed turn-end made a notice');
  assert.doesNotMatch(await bell(), /Claude finished/, 'replayed turn-end made a bell row');
  console.log('PASS turn finished: 1 notice with P9 words only, 1 bell row and no card, opening clears it, replay makes none');
});

test('Interrupt and send: a queued message sent with the bolt, or Ctrl+Enter, reaches the agent after the cancel; a refused one goes back in the box', { timeout: 120000 }, async (t) => {
  // A queued message, then Interrupt and send now: it cancelled the turn and did not send the message.
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  // An adapter without steering, so a message sent mid-turn waits queued (with steering it goes into the turn).
  await writeFile(path.join(instance.workspace, 'no-steering'), '');
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-interrupt-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#rChat').waitFor();
  const id = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'hello' });
  await page.locator('#nav .row[data-chat="' + id + '"]').click();
  const pane = page.locator('#chats .pane[data-id="' + id + '"]'), box = pane.locator('.composer textarea');
  const agentSaid = (text) => pane.locator('.msg.agent', { hasText: text }).last().waitFor({ timeout: 15000 });
  await agentSaid('echo:hello');
  const slowTurn = async (n) => { await box.fill('slow'); await box.press('Enter'); await page.waitForFunction((k) => document.querySelectorAll('#chats .pane .msg.agent').length && [...document.querySelectorAll('#chats .pane .msg.agent')].filter((m) => m.textContent.includes('working')).length === k, n); };
  // The bolt on a queued message.
  await slowTurn(1);
  await box.fill('queued one'); await box.press('Enter');
  await pane.locator('.queue .q', { hasText: 'queued one' }).waitFor();
  await pane.locator('.queue [data-qnow="0"]').click();
  await agentSaid('echo:queued one');
  // Ctrl+Enter on a new message while the agent works.
  await slowTurn(2);
  await box.fill('right now'); await box.press('Control+Enter');
  await agentSaid('echo:right now');
  assert.deepEqual(await pane.evaluate((p) => ({ users: [...p.querySelectorAll('.msg.user')].map((m) => m.lastChild.textContent), queue: p.querySelectorAll('.queue .q').length })),
    { users: ['hello', 'slow', 'queued one', 'slow', 'right now'], queue: 0 });
  // A prompt the daemon refuses (over 100,000 characters) comes back to the box instead of vanishing.
  const long = 'x'.repeat(100001);
  await box.fill(long); await box.press('Enter');
  await page.waitForFunction((n) => document.querySelector('#chats .pane .composer textarea')?.value.length === n, long.length, { timeout: 10000 });
  console.log('PASS interrupt and send: bolt and Ctrl+Enter both reach the agent after the cancel, queue empty, refused text back in the box');
});

test('Terminal dock: a real shell, one of P9\'s own tmux sessions, through the desktop\'s relay; the page never holds the socket (threat model row 13)', { timeout: 120000 }, async (t) => {
  const tmux = 'p9t-' + randomUUID().slice(0, 8);
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--tmux-socket', tmux] }));
  t.after(() => call(instance, '/stop-all', 'POST').catch(() => {}));
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-dock-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#rChat').waitFor();
  const rows = () => page.locator('#termView .xterm-rows').innerText();
  const shows = (text) => page.waitForFunction((want) => document.querySelector('#termView .xterm-rows')?.textContent.includes(want), text, { timeout: 10000 });
  const type = async (line) => { await page.click('#termView'); await page.keyboard.type(line); await page.keyboard.press('Enter'); };
  // Opening the dock starts a shell; typed keys run there (the echo, not the typed line, holds the joined marker).
  await page.click('#rTerm');
  await page.locator('#dState', { hasText: /^Connected$/ }).waitFor({ timeout: 15000 });
  assert.deepEqual((await call(instance, '/terminals')).terminals.map((x) => x.state), ['running'], 'opening the dock started one shell');
  assert.equal(await page.locator('#dRefresh').isVisible(), false, 'Refresh hides while connected');
  await type('echo P9-DOCK-4""2');
  await shows('P9-DOCK-42');
  // The resize frame goes through too: docked as a full-width drawer, the shell sees the wider dock.
  const cols = async (n) => { await type('echo COLS' + n + '-$(tput cols)-E""ND' + n); await shows('-END' + n); return Number(new RegExp('COLS' + n + '-(\\d+)-END' + n).exec(await rows())?.[1]); };
  const floating = await cols(1);
  await page.click('#dFloat'); await page.waitForTimeout(500);
  const drawer = await cols(2);
  assert.ok(floating > 20 && drawer > floating + 20, 'dock columns ' + floating + ' then ' + drawer);
  if (process.env.P9_EVIDENCE) await page.locator('#dock').screenshot({ path: path.join(process.env.P9_EVIDENCE, 'dock-shell.png') });
  // Hide and show again: the same shell, still attached, no second one.
  await page.click('#dHide'); await page.click('#rTerm');
  await type('echo P9-AGAIN-4""2');
  await shows('P9-AGAIN-42');
  assert.equal((await call(instance, '/terminals')).terminals.length, 1, 'reopening the dock kept the one shell');
  // The bridge takes only a terminal ID; the page never sees the socket or the desktop's credentials.
  await assert.rejects(page.evaluate(() => window.p9.terminalOpen('../../devices/reset')), /ipc-sender-refused/);
  assert.equal(await page.evaluate(() => window.p9.terminal('stop', { id: 'x' })).then((r) => r.status), 400);
  // exit ends the shell; the dock says so and Refresh starts a new one.
  await type('exit');
  await page.locator('#dRefresh').waitFor({ state: 'visible', timeout: 10000 });
  await page.click('#dRefresh');
  await page.locator('#dState', { hasText: /^Connected$/ }).waitFor({ timeout: 15000 });
  assert.deepEqual((await call(instance, '/terminals')).terminals.map((x) => x.state).sort(), ['running', 'stopped'], 'Refresh started a second shell after exit');
  console.log('PASS dock: shell started on open, keys run, width ' + floating + ' then ' + drawer + ' cols, reopen keeps it, bad ID refused, exit then Refresh starts another');
});

// Issue #11: Dev Focus's drawer is this same dock in drawer mode, so one test covers both.
test('Terminal dock with no terminal backend: says so with the reason, badge unavailable, never Not connected or closed', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--terminal-platform', 'darwin'] }));
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-dock-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#rChat').waitFor();
  await page.click('#rTerm');
  await page.locator('#dBadge', { hasText: /^unavailable$/ }).waitFor({ timeout: 15000 });
  const seen = async () => page.evaluate(() => ({ state: document.querySelector('#dState').textContent,
    badge: document.querySelector('#dBadge').textContent, body: document.querySelector('#termView').textContent }));
  const want = { state: "Terminal isn't available on this computer yet.", badge: 'unavailable',
    body: "Terminal isn't available on this computer yet: P9 has no terminal for macOS yet." };
  assert.deepEqual(await seen(), want);
  await page.click('#dFloat'); await page.waitForTimeout(300);
  await page.click('#dRefresh'); await page.waitForTimeout(500);
  assert.deepEqual(await seen(), want, 'drawer mode and Refresh say the same');
  assert.deepEqual((await call(instance, '/terminals', 'POST', {})), { error: 'terminal-unavailable', reason: 'P9 has no terminal for macOS yet.' });
  if (process.env.P9_EVIDENCE) await page.locator('#dock').screenshot({ path: path.join(process.env.P9_EVIDENCE, 'dock-unavailable.png') });
  console.log('PASS dock, no backend: ' + JSON.stringify(want));
});

test('Speed (E2): a reply in one chat rebuilds only its own pane; launch replays only the chats that are not stopped', { timeout: 300000 }, async (t) => {
  // Brief E2: "every chat update redraws all panes (about 25 ms), and launch replays stopped chats from a 110 MB ledger".
  // The same input before and after the fix: 24 stopped chats of 500 steps each, then a 250-step reply streaming in split
  // view beside a quiet 500-step chat. The numbers print before the checks, so the A/B run reports the old ones too.
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const marks = {}, sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const turn = async (id, text) => {
    await call(instance, '/chat/' + id + '/prompt', 'POST', { text });
    for (;;) {
      const r = await call(instance, '/chat/events?after=' + (marks[id] ?? 0) + '&only=' + id);
      marks[id] = r.cursor;
      if (r.events.some((ev) => ev.type === 'turn-end')) return;
      await sleep(200);
    }
  };
  const make = async (title) => { const id = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation; for (const text of ['title ' + title, 'many steps', 'many steps']) await turn(id, text); return id; };
  const stopped = [];
  for (let i = 0; i < 24; i += 6) stopped.push(...await Promise.all([0, 1, 2, 3, 4, 5].map((j) => make('Old ' + (i + j)))));
  for (const id of stopped) await call(instance, '/chat/' + id + '/stop', 'POST');
  const a = await make('Quiet');
  const events = (await call(instance, '/chat/events?after=0&only=' + a)).cursor;
  for (const q of ['only=x', 'only=' + a + '&until=-1', 'after=5&only=' + a + '&until=4', 'only=' + Array(101).fill(a).join(',')])
    assert.equal((await call(instance, '/chat/events?' + q)).error, 'request-refused', q);

  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-speed-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const t0 = Date.now();
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#nav .row[data-chat="' + a + '"]').waitFor({ timeout: 60000 });
  await page.locator('#dataNote', { hasText: 'Chat live' }).waitFor();
  const launch = Date.now() - t0;
  // A stopped chat is not replayed at launch: opened later, its pane first says it is loading (watched from now on).
  await page.evaluate((id) => { window.__stub = false; new MutationObserver(() => { if (document.querySelector(`#chats .pane[data-id="${id}"] .welcome`)?.textContent.includes('Loading this chat')) window.__stub = true; })
    .observe(document.querySelector('#chats'), { childList: true, subtree: true, characterData: true }); }, stopped[0]);

  const b = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  await page.locator('#nav .row[data-chat="' + b + '"]').click();
  await page.locator('#chats > .pane').first().locator('[data-tool=split]').click({ timeout: 10000 });
  await page.waitForFunction((ids) => [...document.querySelectorAll('#chats > .pane')].map((p) => p.dataset.id).sort().join() === ids, [a, b].sort().join(), { timeout: 15000 });
  // O47: the window redraws once when the daemon's first read of the agents' model lists ends (asked again every 1.5 s
  // while it reads). That redraw is not the reply's, so the count starts after it.
  for (let i = 0; i < 40 && Object.values((await call(instance, '/chat')).lists ?? {}).some((l) => l?.state === 'loading'); i++) await page.waitForTimeout(250);
  await page.waitForTimeout(2000);
  // Every pane build goes through a template's innerHTML (morph, and paint's per-pane path): count whose pane it holds.
  await page.evaluate(([a, b]) => {
    const d = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML'), m = window.e2 = { bytes: 0, a: 0, b: 0 };
    const of = (id) => new RegExp('class="pane[^"]*" data-id="' + id + '"');
    Object.defineProperty(Element.prototype, 'innerHTML', { ...d, set(html) { if (this instanceof HTMLTemplateElement) { m.bytes += html.length; m.a += of(a).test(html); m.b += of(b).test(html); } d.set.call(this, html); } });
  }, [a, b]);
  const cdp = await app.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const busy = async () => (await cdp.send('Performance.getMetrics')).metrics.find((x) => x.name === 'TaskDuration').value * 1000;
  const before = await busy();
  await call(instance, '/chat/' + b + '/prompt', 'POST', { text: 'many steps' });
  await page.locator('#chats .pane[data-id="' + b + '"]').getByText('All steps done.').waitFor({ timeout: 30000 });
  await page.waitForTimeout(500);
  const work = await busy() - before, m = await page.evaluate(() => window.e2);
  const full = await page.evaluate(() => { const t = performance.now(); for (let i = 0; i < 20; i++) dispatchEvent(new Event('focus')); return (performance.now() - t) / 20; });
  console.log('E2 numbers: launch to "Chat live" ' + launch + ' ms (' + events + ' events in the ledger, 24 of 25 chats stopped); during the 250-step reply '
    + m.b + ' updates, the quiet chat rebuilt ' + m.a + ' times, ' + Math.round(m.bytes / 1024) + ' KB of HTML built, main thread ' + Math.round(work) + ' ms in all = '
    + (work / m.b).toFixed(1) + ' ms per update; one full redraw of both panes ' + full.toFixed(1) + ' ms');
  assert.ok(m.b > 0, 'the streaming chat was drawn');
  assert.equal(m.a, 0, 'a reply in one chat rebuilt the other pane');
  // Opening it from its panel row loads it.
  await page.locator('#navList .row[data-chat="' + stopped[0] + '"]').click({ timeout: 10000 });
  await page.locator('#chats .pane[data-id="' + stopped[0] + '"]').getByText('All steps done.').first().waitFor({ timeout: 15000 });
  assert.equal(await page.evaluate(() => window.__stub), true, 'a stopped chat was replayed at launch');
  console.log('PASS E2: only the changed pane is rebuilt; 24 stopped chats not replayed at launch, one loads when opened from its panel row');
});

test('Speed (E2): a listed chat the bridge will not narrow to still goes live, by replaying everything', { timeout: 120000 }, async (t) => {
  // GitHub run 39724310852: test/phone.test.mjs seeds idle chats whose IDs are not UUIDs, the bridge refused only= for
  // them on every try, and the desktop never went live (no Fix with Claude). A refused narrowed replay replays everything.
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const real = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(instance.directory, '.local', 'state', 'p9-foundation', 'p9.db'), { timeout: 5000 });
  db.prepare("INSERT INTO conversations (id, provider, title, state, created) VALUES ('fixture-claude', 'claude', 'claude', 'idle', ?)").run(Date.now());
  db.close();
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-fallback-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#dataNote', { hasText: 'Chat live' }).waitFor({ timeout: 30000 });
  await page.locator('#nav .row[data-chat="' + real + '"]').waitFor();
  console.log('PASS E2 fallback: a chat ID the bridge refuses for only= falls back to the full replay; the desktop went live');
});


test('Settings > Notices (O197): one Note or Message row per kind of worker notice, read from P9 and each save kept by it', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-notices-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#rChat').waitFor();
  const rows = () => page.locator('#setNotices select:not([disabled])').evaluateAll((l) => l.map((s) => [s.dataset.notice, s.closest('.set-row').querySelector('strong').textContent, s.value]));
  const open = async () => {
    await page.click('#setBtn'); await page.locator('#setDlg[open]').waitFor();
    await page.click('[data-set-page="Chat Focus"]');
    await page.locator('#setBody > [data-page="Chat Focus"] #setNotices select:not([disabled])').first().waitFor({ timeout: 10000 });
  };
  await open();
  // The daemon's defaults: approvals and questions start the chat's turn, the rest are notes.
  assert.deepEqual(await rows(), [['ready', 'Ready report', 'note'], ['approval', 'Approval', 'message'], ['question', 'Question', 'message'],
    ['compacting', 'Compacting', 'note'], ['ended', 'Turn ended', 'note'], ['sprint', 'Sprint paused or resumed', 'note']]);
  await page.locator('#setNotices [data-notice="ended"]').selectOption('message');
  await page.waitForFunction(() => document.querySelector('#setNotices [data-notice="ended"]')?.value === 'message' && !document.querySelector('#setNotices [data-notice="ended"]').disabled);
  await page.locator('#setNotices [data-notice="approval"]').selectOption('note');
  await page.waitForFunction(() => document.querySelector('#setNotices [data-notice="approval"]')?.value === 'note');
  // Each save named one kind, and P9 kept both.
  assert.deepEqual(await call(instance, '/notices'), { ready: 'note', approval: 'note', question: 'message', compacting: 'note', ended: 'message', sprint: 'note' });
  await page.keyboard.press('Escape'); await page.locator('#setDlg').waitFor({ state: 'hidden', timeout: 5000 });
  await page.reload(); await page.locator('#rChat').waitFor();
  await open();
  assert.deepEqual((await rows()).map(([k, , v]) => k + ':' + v), ['ready:note', 'approval:note', 'question:message', 'compacting:note', 'ended:message', 'sprint:note'], 'read again after a reload');
  // FIX1: overlapping saves. Main holds back the answer to a save of Ready report until released, so a later save could answer
  // first; Compacting's save is refused. Shown values must end as P9 keeps them, and a pick still saving is never undone.
  await app.evaluate(({ ipcMain }) => { const real = ipcMain._invokeHandlers.get('p9:chat'); ipcMain.removeHandler('p9:chat');
    globalThis.gates = [];
    ipcMain.handle('p9:chat', async (event, action, payload) => {
      if (action === 'notices' && payload?.set?.compacting) return { status: 500, body: { error: 'test-refused' } };
      const answer = await real(event, action, payload);
      if (action === 'notices' && payload?.set?.ready) await new Promise((resolve) => globalThis.gates.push(resolve));
      return answer;
    }); });
  const shown = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#setNotices [data-notice]')].map((s) => [s.dataset.notice, s.value])));
  const pick = (k, v) => page.locator(`#setNotices [data-notice="${k}"]`).selectOption(v);
  // Lets the oldest held answer of a Ready report save through, once that save has reached main.
  const release = () => app.evaluate(async () => { for (let i = 0; i < 200 && !globalThis.gates.length; i++) await new Promise((r) => setTimeout(r, 50)); globalThis.gates.shift()(); });
  const settled = () => page.waitForFunction(() => !document.querySelector('#setNotices [data-notice-saving]'), null, { timeout: 10000 });
  await pick('ready', 'message'); await page.waitForTimeout(300);
  await pick('question', 'note'); await page.waitForTimeout(500);
  assert.deepEqual([(await shown()).ready, (await shown()).question], ['message', 'note'], 'both picks shown while the first save waits');
  await release();
  await settled(); await page.waitForTimeout(300);
  const kept1 = await call(instance, '/notices');
  assert.deepEqual([kept1.ready, kept1.question], ['message', 'note'], 'P9 kept both');
  assert.deepEqual(await shown(), kept1, 'the rows show what P9 keeps after an answer came back late');
  // A refused save overlapping one still waiting: the waiting pick stays shown, the refused one goes back and says so.
  await pick('ready', 'note'); await page.waitForTimeout(300);
  await pick('compacting', 'message'); await page.waitForTimeout(500);
  assert.equal((await shown()).ready, 'note', 'a refused save did not undo a pick still saving');
  await release();
  await settled(); await page.waitForTimeout(300);
  const kept2 = await call(instance, '/notices');
  assert.deepEqual([kept2.ready, kept2.compacting], ['note', 'note']);
  assert.deepEqual(await shown(), kept2, 'the rows show what P9 keeps after a refused save');
  assert.match(await page.locator('#setNotices [data-notice-note]').innerText(), /^Not saved/);
  // FIX2: three saves of one row, A Message, B Note, C Message, each answer held and let through in order. A's answer must not
  // count as C's (same value), so B's answer, P9's map with Note, may not show while C still saves.
  await pick('ready', 'message'); await pick('ready', 'note'); await pick('ready', 'message'); await page.waitForTimeout(300);
  await release(); await page.waitForTimeout(500);
  assert.equal((await shown()).ready, 'message', 'after A answered, C still shown'); assert.equal(await page.locator('#setNotices[data-notice-saving]').count(), 1, 'still saving after A');
  await release(); await page.waitForTimeout(500);
  assert.equal((await shown()).ready, 'message', 'after B answered (Note), C still shown while it saves'); assert.equal(await page.locator('#setNotices[data-notice-saving]').count(), 1, 'still saving after B');
  await release(); await settled(); await page.waitForTimeout(300);
  const kept3 = await call(instance, '/notices');
  assert.equal(kept3.ready, 'message'); assert.deepEqual(await shown(), kept3, 'the rows show what P9 keeps after three saves of one row');
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT notices ' + (await page.locator('#setNotices').screenshot({ type: 'png' })).toString('base64'));
  console.log('PASS Settings > Notices');
});

test('Settings > Notices (O197 gaps): a failed or hung first read says so and offers Try again', { timeout: 150000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-notices-gaps-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#rChat').waitFor();
  // Main answers each read of the notices as the test says: 'refuse' (500), 'throw' (the call rejects), 'hang' (held until
  // released) or 'real'; every save's answer is held until released, in the order the saves reached main.
  await app.evaluate(({ ipcMain }) => { const real = ipcMain._invokeHandlers.get('p9:chat'); ipcMain.removeHandler('p9:chat');
    globalThis.reads = []; globalThis.gates = []; globalThis.readHolds = [];
    ipcMain.handle('p9:chat', async (event, action, payload) => {
      if (action === 'notices' && !payload?.set) {
        const how = globalThis.reads.shift() || 'real';
        if (how === 'refuse') return { status: 500, body: { error: 'test-refused' } };
        if (how === 'throw') throw new Error('test-thrown');
        const answer = await real(event, action, payload); // a hung read is read now and answered late, so it is old by then
        if (how === 'hang') await new Promise((resolve) => globalThis.readHolds.push(resolve));
        if (how === 'hang-refuse') { await new Promise((resolve) => globalThis.readHolds.push(resolve)); return { status: 500, body: { error: 'test-refused' } }; }
        return answer;
      }
      return real(event, action, payload);
    }); });
  const reads = (list) => app.evaluate((_, l) => { globalThis.reads = l; }, list);
  const open = async () => {
    await page.click('#setBtn'); await page.locator('#setDlg[open]').waitFor();
    await page.click('[data-set-page="Chat Focus"]');
    await page.locator('#setBody > [data-page="Chat Focus"] #setNotices').waitFor({ timeout: 10000 });
  };
  const close = async () => { await page.keyboard.press('Escape'); await page.locator('#setDlg').waitFor({ state: 'hidden', timeout: 5000 }); };
  const failed = async (why) => {
    await page.locator('#setNotices [data-notice-failed]').waitFor({ timeout: 15000 }).catch(() => {});
    const text = await page.locator('#setNotices').innerText();
    assert.doesNotMatch(text, /Reading from P9/, why + ': still says Reading from P9: ' + text);
    assert.match(text, /Could not read/, why + ': does not say the read failed: ' + text);
    assert.equal(await page.locator('#setNotices [data-notice-retry]').count(), 1, why + ': no Try again');
    assert.equal(await page.locator('#setNotices select:not([disabled])').count(), 0, why + ': rows usable without a read');
  };
  const usable = () => page.locator('#setNotices select:not([disabled])').first().waitFor({ timeout: 10000 });
  // Refused, then Try again refused once more (still says so), then Try again reads.
  await reads(['refuse', 'refuse']); await open();
  await failed('refused read');
  await page.click('#setNotices [data-notice-retry]');
  await failed('second refused read');
  await page.click('#setNotices [data-notice-retry]');
  await usable();
  assert.equal(await page.locator('#setNotices [data-notice-failed], #setNotices [data-notice-wait]').count(), 0, 'the failure line stayed after a good read');
  console.log('PASS O197 gap a: refused');
  await close(); await page.reload(); await page.locator('#rChat').waitFor();
  await app.evaluate(({ ipcMain }) => { globalThis.gates = []; }); // reload keeps main's handler
  // A read that throws.
  await reads(['throw']); await open();
  await failed('thrown read');
  await page.click('#setNotices [data-notice-retry]'); await usable();
  console.log('PASS O197 gap a: thrown');
  await close(); await page.reload(); await page.locator('#rChat').waitFor();
  // O197 gap c: a failed read, Settings closed and opened again, reads again: no failure line and no Try again press.
  await reads(['refuse']); await open();
  await failed('refused read before a reopen');
  await close(); await open(); await usable();
  assert.equal(await page.locator('#setNotices [data-notice-failed], #setNotices [data-notice-retry]').count(), 0, 'a reopened Settings kept the old failure');
  console.log('PASS O197 gap c: reopen reads again');
  // A read that fails after Settings closed (here: no answer within 10 s) does not leave the next open saying it failed.
  await close(); await page.reload(); await page.locator('#rChat').waitFor();
  await reads(['hang']); await open(); await close();
  await page.waitForTimeout(11000);
  await open(); await usable();
  assert.equal(await page.locator('#setNotices [data-notice-failed], #setNotices [data-notice-retry]').count(), 0, 'a read that failed while Settings was closed showed at the next open');
  await app.evaluate(() => { globalThis.readHolds.forEach((r) => r()); globalThis.readHolds = []; });
  console.log('PASS O197 gap c: failed while closed');
  // An older read failing late does not mark a newer open failed: read A held, close, reopen as B (held too),
  // A answers refused while B is out: B still says Reading from P9, then fills the rows when it answers.
  await close(); await page.reload(); await page.locator('#rChat').waitFor();
  await app.evaluate(() => { globalThis.readHolds = []; });
  await reads(['hang-refuse', 'hang']); await open(); await close(); await open();
  for (let i = 0; i < 50 && await app.evaluate(() => globalThis.readHolds.length) < 2; i++) await page.waitForTimeout(100);
  assert.equal(await app.evaluate(() => globalThis.readHolds.length), 2, 'both reads should be held');
  await app.evaluate(() => { globalThis.readHolds.shift()(); }); await page.waitForTimeout(500);
  assert.equal(await page.locator('#setNotices [data-notice-failed]').count(), 0, 'an older read failing marked the newer open failed');
  assert.equal(await page.locator('#setNotices [data-notice-wait]').count(), 1, 'the newer open stopped saying Reading from P9');
  await app.evaluate(() => { globalThis.readHolds.shift()(); }); await usable();
  console.log('PASS O197 gap c: older read fails late');
  await close(); await page.reload(); await page.locator('#rChat').waitFor();
  // A read that never answers says it failed after a while; Try again works; the late answer of the first read changes nothing.
  await reads(['hang']); await open();
  await failed('hung read');
  await page.click('#setNotices [data-notice-retry]'); await usable();
  // A save lands, then the hung read answers with the map from before it: the rows keep what P9 keeps now.
  const before = (await call(instance, '/notices')).ended, after = before === 'note' ? 'message' : 'note';
  await page.locator('#setNotices [data-notice="ended"]').selectOption(after);
  await page.waitForFunction(() => !document.querySelector('#setNotices[data-notice-saving]'), null, { timeout: 10000 }); await page.waitForTimeout(300);
  assert.equal((await call(instance, '/notices')).ended, after);
  await app.evaluate(() => { globalThis.readHolds.forEach((r) => r()); }); await page.waitForTimeout(500);
  assert.equal(await page.locator('#setNotices select:not([disabled])').count(), 6, 'the late answer broke the rows');
  assert.equal(await page.locator('#setNotices [data-notice="ended"]').inputValue(), after, 'a late first read put back a value from before a save');
  console.log('PASS O197 gap a: hung');
});

test('Settings > Notices (O197 gap b): three or more held saves across different rows end as P9 keeps them', { timeout: 150000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-notices-rows-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#rChat').waitFor();
  // Main answers each read of the notices as the test says: 'refuse' (500), 'throw' (the call rejects), 'hang' (held until
  // released) or 'real'; every save's answer is held until released, in the order the saves reached main.
  await app.evaluate(({ ipcMain }) => { const real = ipcMain._invokeHandlers.get('p9:chat'); ipcMain.removeHandler('p9:chat');
    globalThis.reads = []; globalThis.gates = []; globalThis.readHolds = [];
    ipcMain.handle('p9:chat', async (event, action, payload) => {
      if (action === 'notices' && !payload?.set) {
        const how = globalThis.reads.shift() || 'real';
        if (how === 'refuse') return { status: 500, body: { error: 'test-refused' } };
        if (how === 'throw') throw new Error('test-thrown');
        if (how === 'hang') await new Promise((resolve) => globalThis.readHolds.push(resolve));
        return real(event, action, payload);
      }
      const answer = await real(event, action, payload);
      if (action === 'notices') await new Promise((resolve) => globalThis.gates.push(resolve));
      return answer;
    }); });
  const open = async () => {
    await page.click('#setBtn'); await page.locator('#setDlg[open]').waitFor();
    await page.click('[data-set-page="Chat Focus"]');
    await page.locator('#setBody > [data-page="Chat Focus"] #setNotices select:not([disabled])').first().waitFor({ timeout: 10000 });
  };
  await open();
  // Gap b: three saves of three different rows, each answer held and let through in turn. While any saves, every pick stays
  // shown; at the end the rows show what P9 keeps. Then the same with the middle one refused by P9.
  const shown = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#setNotices [data-notice]')].map((s) => [s.dataset.notice, s.value])));
  const pick = (k, v) => page.locator(`#setNotices [data-notice="${k}"]`).selectOption(v);
  const release = () => app.evaluate(async () => { for (let i = 0; i < 200 && !globalThis.gates.length; i++) await new Promise((r) => setTimeout(r, 50)); globalThis.gates.shift()(); });
  const settled = () => page.waitForFunction(() => !document.querySelector('#setNotices[data-notice-saving]'), null, { timeout: 10000 });
  const want = { ready: 'message', question: 'note', compacting: 'message' };
  for (const [k, v] of Object.entries(want)) await pick(k, v);
  await page.waitForTimeout(300);
  for (let i = 0; i < 3; i++) {
    const now = await shown();
    assert.deepEqual([now.ready, now.question, now.compacting], ['message', 'note', 'message'], 'a pick went back while saves waited (after ' + i + ' answers)');
    await release(); await page.waitForTimeout(400);
  }
  await settled(); await page.waitForTimeout(300);
  const kept = await call(instance, '/notices');
  assert.deepEqual([kept.ready, kept.question, kept.compacting], ['message', 'note', 'message'], 'P9 did not keep all three');
  assert.deepEqual(await shown(), kept, 'the rows do not show what P9 keeps after three saves across rows');
  console.log('PASS O197 gap b: three rows');
  // Four saves across rows, the third refused by main: the others stay, the refused row goes back and says so.
  await app.evaluate(({ ipcMain }) => { const held = ipcMain._invokeHandlers.get('p9:chat'); ipcMain.removeHandler('p9:chat');
    ipcMain.handle('p9:chat', async (event, action, payload) => {
      if (action === 'notices' && payload?.set?.ended) { await new Promise((resolve) => globalThis.gates.push(resolve)); return { status: 500, body: { error: 'test-refused' } }; }
      return held(event, action, payload);
    }); });
  await pick('ready', 'note'); await pick('question', 'message'); await pick('ended', 'message'); await pick('sprint', 'message');
  await page.waitForTimeout(300);
  for (let i = 0; i < 4; i++) { await release(); await page.waitForTimeout(400); }
  await settled(); await page.waitForTimeout(300);
  const kept2 = await call(instance, '/notices');
  assert.deepEqual([kept2.ready, kept2.question, kept2.ended, kept2.sprint], ['note', 'message', 'note', 'message']);
  assert.deepEqual(await shown(), kept2, 'the rows do not show what P9 keeps after a refused save among four');
  assert.match(await page.locator('#setNotices [data-notice-note]').innerText(), /^Not saved/);
  console.log('PASS O197 gap b: four rows, one refused');
  // One row picked twice around another row's save, each answer held: the second pick of ready stays shown throughout.
  await pick('ready', 'message'); await pick('question', 'note'); await pick('ready', 'note');
  await page.waitForTimeout(300);
  for (let i = 0; i < 3; i++) {
    const now = await shown();
    assert.deepEqual([now.ready, now.question], ['note', 'note'], 'a pick went back while saves waited (after ' + i + ' answers)');
    await release(); await page.waitForTimeout(400);
  }
  await settled(); await page.waitForTimeout(300);
  const kept3 = await call(instance, '/notices');
  assert.deepEqual([kept3.ready, kept3.question], ['note', 'note']);
  assert.deepEqual(await shown(), kept3, 'the rows do not show what P9 keeps after a row saved twice around another');
  console.log('PASS O197 gap b: one row twice around another');
});
