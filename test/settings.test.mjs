// Phase 18 row 2: the Settings page. Threat model row 15 case 4 (the settings IPC refuses any other shape and leaves the
// file alone) plus each setting surviving an app restart; the agent lock goes through the real daemon.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { deflateSync, crc32 } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { _electron } from '@playwright/test';
import { daemon, http, authenticated, root } from './helpers.mjs';

const look = (on, roles = {}) => ({ on, size: 48, claude: null, codex: null, system: null, top: null, pane: null, ...roles });
const PETS = { chat: look(true), dev: look(false), mission: look(false) };
const SKIPPER = { system: 'skipper' }, DEFAULT_PETS = { chat: look(true, SKIPPER), dev: look(false, SKIPPER), mission: look(false, SKIPPER) };
const DOCS_URL = 'https://github.com/JudgeBreddd/p9#readme'; // main.mjs loads only inside Electron
const RELEASES_URL = 'https://github.com/JudgeBreddd/p9/releases/latest';
const PETDEX_URL = 'https://petdex.dev';
const fake = path.join(root, 'test/fake-acp-agent.mjs');
const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((result) => JSON.parse(result.text));

test('Settings: refused shapes leave the file alone; zoom, close on send, focus modes and the agent lock survive a restart', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-settings-')), profile = path.join(home, 'profile');
  const opened = path.join(home, 'opened.txt'), browser = path.join(home, 'browser'), file = path.join(profile, 'p9-settings.json');
  await writeFile(browser, '#!/bin/sh\nprintf "%s\\n" "$1" > ' + opened + '\n');
  await chmod(browser, 0o755);
  const env = { ...process.env, P9_OPEN_URL: browser }; delete env.ELECTRON_RUN_AS_NODE;
  const launch = async () => {
    const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
    const proc = app.process();
    t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
    const page = await app.firstWindow();
    await page.locator('#rChat').waitFor();
    return { app, page };
  };
  const zoomOf = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor());

  let { app, page } = await launch();
  // A new profile starts with the bundled Skipper as its System pet (Tyler, 2026-10-20); removed, it stays removed (below).
  assert.deepEqual(await page.evaluate(() => window.p9.listPets().then((l) => l.pets)), [{ name: 'skipper', displayName: 'Skipper' }]);
  assert.deepEqual((await page.evaluate(() => window.p9.getSettings())).pet, DEFAULT_PETS);
  await page.evaluate(() => window.p9.removePet('skipper'));
  // Case 4: the handler itself, called as the shell's own frame, refuses every other shape and writes nothing.
  const refused = await app.evaluate(async ({ ipcMain, BrowserWindow }, PETS) => {
    const sender = BrowserWindow.getAllWindows()[0].webContents, handler = ipcMain._invokeHandlers.get('p9:settings');
    const event = { sender, senderFrame: sender.mainFrame }, good = { zoom: 1, closeOnSend: false, focus: { chat: true, dev: true, mission: true }, pet: PETS, name: 'Sam', startLast: false };
    const chat = (change) => ({ ...good, pet: { ...good.pet, chat: { ...good.pet.chat, ...change } } });
    const bad = [{ ...good, extra: 1 }, { ...good, zoom: '2' }, { ...good, zoom: 4 }, { ...good, zoom: 0.1 }, { ...good, zoom: NaN },
      { ...good, closeOnSend: 1 }, { ...good, focus: { chat: true, dev: true } }, { ...good, focus: { chat: false, dev: false, mission: false } },
      { ...good, focus: { chat: true, dev: true, mission: true, x: true } }, [good], null, { ...good, pet: '../x' }, { ...good, pet: 5 },
      { ...good, pet: null }, { ...good, pet: 'good-pet' }, { ...good, pet: { claude: null, codex: null, system: null } }, { ...good, pet: { ...good.pet, x: good.pet.chat } },
      { ...good, pet: { chat: good.pet.chat, dev: good.pet.dev } }, chat({ codex: '../x' }), chat({ x: null }), chat({ size: 23 }), chat({ size: 129 }), chat({ size: 48.5 }),
      chat({ on: 1 }), chat({ top: [0.5] }), chat({ top: [2, 0] }), chat({ pane: 'x' }), chat({ pane: [0.1, NaN] }), chat({ top: { 0: 0.1, 1: 0.1, length: 2 } }),
      { ...good, name: 'x'.repeat(41) }, { ...good, name: 'Sam\u0007' }, { ...good, name: 'Sam\u200b' }, { ...good, name: 7 }, { ...good, startLast: 'yes' }, (({ name, ...rest }) => rest)(good)];
    const out = [];
    for (const value of bad) out.push(await handler(event, value).then(() => 'accepted', (error) => error.message));
    out.push(await handler(event, good, good).then(() => 'accepted', (error) => error.message));
    return out;
  }, PETS);
  assert.deepEqual(refused, [...Array(35).fill('settings-refused'), 'ipc-sender-refused']);
  await assert.rejects(readFile(file), { code: 'ENOENT' });

  // Close on send: a chat opened from its card closes once the message is sent.
  const id = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'permission' });
  await page.locator('#cards [data-key^="asks:"] .open').waitFor({ timeout: 15000 });

  await page.click('#setBtn');
  await page.locator('#setDlg[open]').waitFor();
  assert.equal(await page.locator('#setLock').isChecked(), false);
  await page.click('#zIn'); await page.click('#zIn');
  await page.locator('#zVal', { hasText: '120%' }).waitFor();
  await page.check('#setCloseSend');
  await page.uncheck('#setF-mission');
  await page.check('#setLock');
  await page.locator('#setLock:checked').waitFor();
  assert.deepEqual(await call(instance, '/agent-lock'), { on: true });
  // The last focus mode left on cannot be turned off.
  await page.uncheck('#setF-dev');
  assert.equal(await page.locator('#setF-chat').isDisabled(), true);
  await page.check('#setF-dev');
  if (process.env.P9_EVIDENCE) { await mkdir(process.env.P9_EVIDENCE, { recursive: true }); await page.screenshot({ path: path.join(process.env.P9_EVIDENCE, 'settings.png') }); }
  await page.click('#setDocs');
  let url = '';
  for (let i = 0; i < 50 && !url; i++) { url = await readFile(opened, 'utf8').catch(() => ''); if (!url) await new Promise((r) => setTimeout(r, 100)); }
  assert.equal(url.trim(), DOCS_URL);
  // Check for updates (threat model row 28): shows this build's version and opens only the newest-release page.
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.match(await page.locator('#setVer').innerText(), new RegExp('^You have P9 ' + version.replaceAll('.', '\\.') + '\\. '));
  await page.click('#setUpd');
  for (let i = 0; i < 50 && url.trim() !== RELEASES_URL; i++) { url = await readFile(opened, 'utf8').catch(() => ''); if (url.trim() !== RELEASES_URL) await new Promise((r) => setTimeout(r, 100)); }
  assert.equal(url.trim(), RELEASES_URL);
  // Settings → Pets: petdex.dev is a link and opens only that page (Tyler, 2026-10-20).
  await page.click('#petdexLink');
  for (let i = 0; i < 50 && url.trim() !== PETDEX_URL; i++) { url = await readFile(opened, 'utf8').catch(() => ''); if (url.trim() !== PETDEX_URL) await new Promise((r) => setTimeout(r, 100)); }
  assert.equal(url.trim(), PETDEX_URL);
  await page.click('#setAm');
  await page.locator('#amDlg[open]').waitFor();
  await page.click('#amClose');

  assert.equal(await zoomOf(app), 1.2);
  assert.equal(await page.locator('#rMission').isHidden(), true);
  await page.keyboard.press('Control+3');
  assert.equal(await page.locator('.shell').getAttribute('data-focus'), 'chat');
  // The waiting approval was rejected by the lock; the card is gone. A new one: lock off first.
  await page.click('#setBtn'); await page.uncheck('#setLock'); await page.locator('#setLock:not(:checked)').waitFor(); await page.click('#setClose');
  await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'permission' }).catch(() => {});
  await page.locator('#cards [data-key^="asks:"] .open').click({ timeout: 15000 });
  if (await page.locator('#mdlBody .mlist button').count()) await page.locator('#mdlBody .mlist button').first().click();
  await page.locator('#mdlBody textarea').fill('sent from the card');
  await page.locator('#mdlBody textarea').press('Enter');
  await page.waitForFunction(() => !document.querySelector('#mdl').open);

  await app.close();
  ({ app, page } = await launch());
  assert.equal(await zoomOf(app), 1.2);
  await page.locator('#rMission').waitFor({ state: 'hidden' }); // settings load after the page
  await page.click('#setBtn');
  assert.equal(await page.locator('#setCloseSend').isChecked(), true);
  assert.equal(await page.locator('#setF-mission').isChecked(), false);
  assert.equal(await page.locator('#zVal').innerText(), '120%');
  // The name is the account's (main.mjs accountName), so the test reads it back rather than guessing it.
  const kept = JSON.parse(await readFile(file, 'utf8'));
  assert.match(kept.name, /^[^\p{Cc}\p{Cf}]{0,40}$/u);
  assert.deepEqual(kept, { zoom: 1.2, closeOnSend: true, focus: { chat: true, dev: true, mission: false }, pet: DEFAULT_PETS, name: kept.name, startLast: false });
  assert.deepEqual(await page.evaluate(() => window.p9.listPets().then((l) => l.pets)), [], 'a removed Skipper is not put back');
  // Phase 18 review: saves in flight together (Ctrl = held down) all succeed, and the file ends on the last one.
  const saves = await page.evaluate((pet) => Promise.allSettled(Array.from({ length: 20 }, (_, i) =>
    window.p9.setSettings({ zoom: 1 + (i + 1) / 100, closeOnSend: true, focus: { chat: true, dev: true, mission: false }, pet, name: '', startLast: false }))), PETS);
  assert.deepEqual(saves.map((s) => s.status), Array(20).fill('fulfilled'));
  assert.equal(JSON.parse(await readFile(file, 'utf8')).zoom, 1.2);
  assert.equal(await zoomOf(app), 1.2);
  console.log('PASS settings: 36 bad IPC shapes refused, nothing written; zoom 1.2, close on send, Mission off, agent lock via the daemon, docs and Anymouse; all kept after a restart; 20 saves at once all kept in order');
});

// A petdex-shaped sheet: 8 x 9 frames of 192 x 208, with `filled[row]` opaque frames in each row.
function sheet(filled) {
  const w = 1536, h = 1872, raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < (filled[Math.floor(y / 208)] ?? 0) * 192; x++) raw.writeUInt32BE(0x3fa0ffff, y * (w * 4 + 1) + 1 + x * 4);
  const chunk = (type, data) => { const len = Buffer.alloc(4), crc = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type), data]); len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body)); return Buffer.concat([len, body, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('Pets: crafted folders refused; each waiting agent and each chat shows its own pet, per focus, dragged spots kept; add and remove (threat model row 16)', { timeout: 240000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
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

  const ev = process.env.P9_EVIDENCE, shot = (name) => ev && page.screenshot({ path: path.join(ev, name) });
  const settingsNow = () => page.evaluate(() => window.p9.getSettings());
  const topPets = () => page.evaluate(() => [...document.querySelectorAll('#indPets canvas')].map((c) => c.dataset.petName + ':' + c.dataset.rows).sort().join());
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
  // After a compaction the agent works on with no prompt open (Builder, 2026-10-20: the spinner and pet went away): the
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
  // Claude waits with only a Codex pet: the spinner. Then with its own pet: that pet, waving and jumping.
  await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'permission' });
  await page.locator('#agentInd[data-state="waiting"]').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('#indGlyph').isVisible(), true, 'Claude waits with only a Codex pet: spinner');
  assert.equal(await topPets(), '');
  await setPet('claude', 'good-pet');
  await page.waitForFunction(() => document.querySelectorAll('#indPets canvas').length === 1);
  assert.equal(await topPets(), 'good-pet:3,4');
  assert.equal(await page.locator('#indText').textContent(), 'An agent waits on you', 'the text stays for screen readers');
  assert.equal(await page.locator('#indGlyph').isHidden(), true);
  await drawn('#indPets canvas');
  // The top pet takes the text's place in the top bar at 52 px, whatever the chat pet's size (Builder, 2026-10-17).
  const bar = await page.locator("#agentInd").boundingBox(), petBox = await page.locator('#indPets canvas').boundingBox();
  assert.ok(petBox.height === 52 && petBox.y < 10 && petBox.x >= bar.x && petBox.x + petBox.width <= bar.x + bar.width, JSON.stringify({ bar, petBox }));
  // Codex works: its pet runs in the top bar beside Claude's.
  const codex = (await call(instance, '/chat', 'POST', { provider: 'codex' })).conversation;
  await call(instance, `/chat/${codex}/prompt`, 'POST', { text: 'slow' });
  // Busy shows as its robot head in the rail or its in-chat pet running (chat open).
  const codexBusy = ([id, want]) => want === !!(document.querySelector(`#rBots [data-bot="${id}"]`)?.hasAttribute('data-busy') || document.querySelector(`.pane[data-id="${id}"] canvas.pet[data-rows="7"]`));
  await page.waitForFunction(codexBusy, [codex, true], { timeout: 15000 });
  assert.equal(await topPets(), 'good-pet:3,4,other-pet:7', 'a working agent runs in the top bar');
  await call(instance, `/chat/${codex}/cancel`, 'POST', {});
  await page.waitForFunction(codexBusy, [codex, false], { timeout: 15000 });
  // Codex waits too: both pets.
  await call(instance, `/chat/${codex}/prompt`, 'POST', { text: 'permission' });
  await page.waitForFunction(() => document.querySelector('#indText').innerText === '2 agents wait on you', null, { timeout: 15000 });
  assert.equal(await topPets(), 'good-pet:3,4,other-pet:3,4');
  assert.equal(await page.locator('#indText').innerText(), '2 agents wait on you');
  await drawn('#indPets canvas');
  await shot('pets-top-two.png');

  // Each chat holds its own agent's pet (the waiting row).
  const inChat = {};
  await page.locator('#cards [data-key^="asks:"] .open').click();
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
  // Each chat keeps its own spot, and a chat window's spot is its own (Builder, 2026-10-19).
  const petSpots = () => page.evaluate(() => JSON.parse(localStorage.getItem('p9-pet-spots') || '{}'));
  assert.deepEqual(Object.keys(await petSpots()), ['mdlBody:' + codex], 'only the dragged chat window kept a spot');
  const dragged = (await petSpots())['mdlBody:' + codex];
  assert.ok(Math.abs(dragged[0] - 0.25) < 0.02 && Math.abs(dragged[1] - 1 / 3) < 0.02, String(dragged));
  // The top pets do not drag (they keep their place in the top bar).
  const top = await page.locator('#indPets canvas').first().boundingBox();
  await page.mouse.move(top.x + top.width / 2, top.y + top.height / 2); await page.mouse.down();
  await page.mouse.move(400, 400, { steps: 5 }); await page.mouse.up();
  assert.deepEqual(await page.locator('#indPets canvas').first().boundingBox(), top);
  assert.equal((await settingsNow()).pet.chat.top, null);

  // An agent's reply shows as Markdown, and markup in it stays text: no script, image, frame or link (threat model row 18).
  const md = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  const hostile = '\n# Plan\n\n- **one**\n- two\n\n```js\nlet a = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<script>window.pwned = 1</script>\n\n<img src=x onerror="window.pwned = 2"> <iframe src="https://example.com"></iframe>\n\n[click](javascript:window.pwned=3) <https://example.com> ![x](https://example.com/x.png)';
  await call(instance, `/chat/${md}/prompt`, 'POST', { text: hostile });
  await page.locator(`#tabs .tab[data-id="${md}"]`).click();
  const reply = page.locator(`#chats .pane[data-id="${md}"] .msg.agent`).last();
  await reply.locator('table').waitFor({ timeout: 15000 });
  assert.deepEqual(await reply.evaluate((m) => ({
    shape: ['h1', 'ul li strong', 'pre code', 'table td'].map((q) => !!m.querySelector(q)),
    banned: m.querySelectorAll('script, img, iframe, a, object, embed, svg').length,
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
  // A pasted screenshot and a file dropped on the chat attach the same way (Builder, 2026-10-18: "not paste the screenshots").
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

  // Sessions on load: a stopped chat and one whose tab was closed stay off the tabs after a restart, in History.
  const stopped = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  await call(instance, `/chat/${stopped}/stop`, 'POST');
  // Its robot head opens the chat modal at the newest message, not the first (Builder, 2026-10-17).
  const hist = page.locator('#mdlBody .pane .hist');
  for (const time of ['first', 'again']) {
    await page.locator(`#rBots [data-bot="${md}"]`).click();
    await hist.locator('table').waitFor();
    assert.deepEqual(await hist.evaluate((h) => [h.scrollHeight > h.clientHeight + 100, h.scrollHeight - h.scrollTop - h.clientHeight < 24]), [true, true], 'opens at the bottom: ' + time);
    if (time === 'again') { // a reply arriving while it is open keeps it on the newest message
      await shot('modal-reopen.png');
      await call(instance, `/chat/${md}/prompt`, 'POST', { text: 'pinned' });
      await hist.locator('.msg.agent', { hasText: 'echo:pinned' }).waitFor({ timeout: 15000 });
      await page.waitForTimeout(200);
      assert.equal(await hist.evaluate((h) => h.scrollHeight - h.scrollTop - h.clientHeight < 24), true, 'stays pinned on a new reply');
    }
    await page.click('#mdlX'); await page.locator('#mdl').waitFor({ state: 'hidden' });
  }
  // Its x stops it (Builder, 2026-10-18: "same as vs code"), so its robot head goes too.
  await page.locator(`#tabs .tab[data-id="${md}"] .close`).click();
  await page.locator(`#tabs .tab[data-id="${md}"]`).waitFor({ state: 'detached' });
  await page.locator(`#rBots [data-bot="${md}"]`).waitFor({ state: 'detached', timeout: 15000 });

  // The chat pet's spot is kept across a restart; the settings file no longer holds one shared spot.
  await app.close();
  ({ app, page } = await launch());
  assert.deepEqual(JSON.parse(await readFile(path.join(profile, 'p9-settings.json'), 'utf8')).pet.chat, look(true, { system: 'dotdot', claude: 'good-pet', codex: 'other-pet' }));
  assert.deepEqual(await petSpots(), { ['mdlBody:' + codex]: dragged });
  await page.waitForFunction(() => document.querySelectorAll('#indPets canvas').length === 2, null, { timeout: 15000 });
  const tabs = () => page.evaluate(() => [...document.querySelectorAll('#tabs .tab')].map((t) => t.dataset.id).sort());
  assert.deepEqual(await tabs(), [id, codex].sort(), 'stopped and closed chats get no tab');
  await page.click('#histBtn');
  assert.equal(await page.locator('#histPop [data-open]').count(), 4);
  await page.locator(`#histPop [data-open="${md}"]`).click();
  assert.deepEqual(await tabs(), [id, codex, md].sort(), 'History opens a closed chat again');
  await page.locator(`#tabs .tab[data-id="${md}"] .close`).click();
  await shot('pets-after-restart.png');
  // Split view: each of the two panes shows its own agent's pet.
  await page.click('#rSplit');
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
  await page.click('#rSplit');
  // Dev's pets here are refused names, so the spinner. Chat with pets turned off loses its chat pets but keeps the top-bar
  // pets (Builder, 2026-10-18: "No. Keep it on. I like it.").
  await page.keyboard.press('Control+2');
  assert.equal(await page.locator('#indGlyph').isVisible(), true, 'Dev: pets off by default');
  assert.equal(await topPets(), '');
  await page.keyboard.press('Control+1');
  await page.waitForFunction(() => document.querySelectorAll('#indPets canvas').length === 2);
  await page.click('#setBtn'); await page.uncheck('#setPetOn'); await page.click('#setClose');
  await page.waitForFunction(() => !document.querySelector('#chats .pane canvas.pet'));
  assert.equal(await topPets(), 'good-pet:3,4,other-pet:3,4', 'Chat with pets off keeps the top-bar pets');
  assert.equal(await page.locator('#indGlyph').isHidden(), true);
  // No agent active: the system pet stands idle in the top bar (Builder, 2026-10-18: "Keep it on. I like it.").
  await setPet('system', 'other-pet');
  for (const chat of [id, codex]) await call(instance, `/chat/${chat}/cancel`, 'POST', {});
  await page.waitForFunction(() => [...document.querySelectorAll('#indPets canvas')].map((c) => c.dataset.petName + ':' + c.dataset.rows).join() === 'other-pet:0', null, { timeout: 15000 });
  assert.equal(await page.locator('#agentInd').isVisible(), true);
  assert.equal(await page.locator('#indText').textContent(), '');
  await drawn('#indPets canvas');
  await shot('pet-top-idle.png');

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
  // "Use these pets in all focus modes" (Builder, 2026-10-19) copies Chat's three picks; show, size and spots stay per focus.
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
  // Import (Builder, 2026-10-18: "1 for now"): only names in ~/.codex/pets that P9 lacks are offered, and each goes through Add's checks.
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
  // Install (Builder, 2026-10-18: paste "the npm command from petdex.dev"): main fetches only petdex.dev's manifest and the pet's two
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
  // Walkthrough (Ctrl K; it also starts once on first login, see Landing page): each bubble fits the window, carries Chat's system pet and
  // outlines its step's element (unless that element is hidden); Back goes back; Done and Escape end it in the focus it began in.
  const { WALKTHROUGH } = await import('../apps/web/src/walkthrough.mjs');
  await page.click('#setClose');
  await page.click('#setBtn'); await page.click('[data-pet-mode="chat"]'); await page.selectOption('#setPet-system', 'other-pet'); await page.click('#setClose');
  await page.click('[data-focus-btn="mission"]');
  // Mission #3 (Builder, 2026-10-18): with the sample's 12 apps, the Apps list scrolls and Usage keeps its full height.
  assert.ok(await page.locator('#fMission [data-panel="musage"] .pscroll').evaluate((p) => p.scrollHeight <= p.clientHeight + 1), 'Usage squeezed by Apps');
  const walkStart = async () => { await page.keyboard.press('Control+k'); await page.locator('#palette li', { hasText: 'Walkthrough' }).click(); };
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
    // Builder, 2026-10-19: the guide pet at Settings' largest size; the running-chats step points at the robot-head row even
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
      const views = () => app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0], z = w.webContents.getZoomFactor(); return w.contentView.children.filter((v) => v.getVisible()).map((v) => { const b = v.getBounds(); return [b.x / z, b.y / z, (b.x + b.width) / z, (b.y + b.height) / z]; }); });
      const over = (v) => v[0] < now.rect[2] && v[2] > now.rect[0] && v[1] < now.rect[3] && v[3] > now.rect[1];
      let shownViews = await views();
      for (let i = 0; i < 30 && (!shownViews.length || shownViews.some(over)); i++) { await page.waitForTimeout(100); shownViews = await views(); }
      assert.ok(shownViews.length && !shownViews.some(over), 'step ' + n + ': the Dev editor covers the card ' + JSON.stringify([now.rect, shownViews]));
    }
    if ([1, 2, 7, 9, 10, 11, 13].includes(n)) await shot(`walkthrough-${n}.png`);
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

test('Theme per focus mode: Chat, Dev and Mission each keep their own look, also after a restart', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t);
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-looks-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const launch = async () => {
    const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
    const proc = app.process();
    t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
    const page = await app.firstWindow();
    await page.locator('#rChat').waitFor();
    return { app, page };
  };
  const theme = (page) => page.evaluate(() => document.documentElement.dataset.theme);
  let { app, page } = await launch();
  const ids = await page.locator('[data-theme-pick]').evaluateAll((buttons) => buttons.map((b) => b.dataset.themePick));
  const before = await theme(page), [chat, dev, mission] = ids.filter((id) => id !== before).slice(0, 3);
  const pick = async (key, id) => {
    await page.keyboard.press(key);
    await page.click('#themeBtn'); await page.click(`[data-theme-pick="${id}"]`); await page.keyboard.press('Escape');
    assert.equal(await theme(page), id);
  };
  await pick('Control+1', chat); await pick('Control+2', dev); await pick('Control+3', mission);
  const tour = async (label) => {
    for (const [key, id] of [['Control+1', chat], ['Control+2', dev], ['Control+3', mission], ['Control+1', chat]]) {
      await page.keyboard.press(key);
      assert.equal(await theme(page), id, `${label} ${key}`);
      assert.equal(await page.locator(`[data-theme-pick="${id}"]`).getAttribute('aria-pressed'), 'true', `${label} picker ${key}`);
      if (process.env.P9_EVIDENCE && label === 'after restart') await page.screenshot({ path: path.join(process.env.P9_EVIDENCE, `look-${key.slice(-1)}.png`) });
    }
  };
  await tour('before restart');
  await app.close();
  ({ app, page } = await launch());
  await page.waitForFunction((id) => document.documentElement.dataset.theme === id, chat);
  await tour('after restart');
  console.log(`PASS looks: Chat ${chat}, Dev ${dev}, Mission ${mission}, each restored on switch and after a restart`);
});

test('DUWOP themes: every core, Command Center and Gods theme is offered, each repaints the page, its fonts load from P9 itself', { timeout: 120000 }, async (t) => {
  // Builder, 2026-10-19: "add the rest of the duwop themes"
  const instance = await daemon(t);
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-themes-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  const remote = []; page.on('request', (r) => { if (!/^(p9|data|blob):/.test(r.url())) remote.push(r.url()); });
  await page.locator('#rChat').waitFor();
  const ids = await page.locator('[data-theme-pick]').evaluateAll((buttons) => buttons.map((b) => b.dataset.themePick));
  assert.equal(ids.length, 25, ids.join());
  for (const id of ['duskwood', 'outrun', '8bit', 'daylight', 'linen', 'redline', 'olympus', 'hades', 'ra']) assert.ok(ids.includes(id), id);
  const looks = new Map(), missing = [];
  for (const id of ids) {
    await page.click('#themeBtn'); await page.click(`[data-theme-pick="${id}"]`); await page.keyboard.press('Escape');
    const look = await page.evaluate(async () => {
      const css = getComputedStyle(document.documentElement), fonts = [css.getPropertyValue('--app-font'), css.getPropertyValue('--app-display')].map((f) => f.trim()).filter((f) => f && f !== 'system-ui');
      const loaded = await Promise.all(fonts.map(async (f) => [f, (await document.fonts.load('16px ' + f)).length]));
      return { colours: css.getPropertyValue('--background') + ' ' + css.getPropertyValue('--primary'), unloaded: loaded.filter(([, n]) => !n).map(([f]) => f) };
    });
    looks.set(id, look.colours); missing.push(...look.unloaded.map((f) => id + ':' + f));
    if (process.env.P9_EVIDENCE) await page.screenshot({ path: path.join(process.env.P9_EVIDENCE, `theme-${id}.png`) });
  }
  assert.deepEqual(missing, [], 'a theme names a font P9 does not serve');
  assert.equal(new Set(looks.values()).size, ids.length, 'two themes paint the same colours');
  assert.deepEqual(remote, [], 'no request leaves the app (no Google Fonts)');
  console.log(`PASS DUWOP themes: ${ids.length} offered, ${new Set(looks.values()).size} distinct colour sets, every named font loaded locally, 0 remote requests`);
});

test('Look picker: DUWOP Appearance cards, each painted in its own theme, plus AMOLED, the bundled fonts, every effect and Roll again', { timeout: 120000 }, async (t) => {
  // Builder, 2026-10-19: "cards + all" (DUWOP's _engine/registry/appearance/appearance.tsx)
  const instance = await daemon(t);
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-picker-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#rChat').waitFor();
  const html = (name) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
  await page.click('#themeBtn');
  const cards = await page.locator('#themePop [data-theme-pick]').evaluateAll((list) => list.map((c) => {
    const css = getComputedStyle(c), dot = getComputedStyle(c.querySelector('.dots i'));
    return { id: c.dataset.themePick, bg: css.backgroundColor, dot: dot.backgroundColor, primary: css.getPropertyValue('--primary').trim(), name: c.querySelector('b').textContent, note: c.querySelector('small').textContent };
  }));
  assert.equal(cards.length, 25);
  assert.ok(cards.every((c) => c.name && c.note), 'every card has a name and a note');
  assert.equal(new Set(cards.map((c) => c.bg + c.dot)).size, 25, 'every card is painted in its own colours');
  for (const id of ['outrun', 'redline', 'olympus', 'daylight']) {
    await page.click(`[data-theme-pick="${id}"]`);
    assert.equal(await html('--primary'), cards.find((c) => c.id === id).primary, `${id}: the card shows the colour the page gets`);
    assert.equal(await page.locator(`[data-theme-pick="${id}"]`).getAttribute('aria-pressed'), 'true');
  }
  await page.click('[data-theme-pick="duskwood"]');
  const fonts = await page.locator('[data-font-pick]').evaluateAll((list) => list.map((b) => b.dataset.fontPick));
  assert.deepEqual(fonts, ['inter', 'system', 'outfit', 'spacegrotesk', 'jetbrains', 'pixelify', 'chakra'], 'only fonts P9 bundles, plus System');
  await page.click('[data-font-pick="jetbrains"]');
  assert.equal(await html('--app-font'), '"JetBrains Mono"');
  assert.equal(await page.locator('[data-font-note]').textContent(), 'Monospace, for the nerds.');
  const fx = () => page.evaluate(() => document.documentElement.dataset.fx);
  assert.equal(await page.locator('[data-fx-pick]').count(), 6);
  assert.ok(await page.locator('[data-fx-pick="motion"]').isDisabled(), 'Drifting glow waits for Ambient glow or Horizon');
  await page.click('[data-fx-pick="horizon"]');
  assert.match(await fx(), /\bhorizon\b/);
  assert.ok(await page.locator('[data-fx-pick="motion"]').isEnabled());
  await page.click('[data-fx-pick="shine"]');
  assert.doesNotMatch(await fx(), /\bshine\b/);
  const amoled = await page.evaluate(() => document.documentElement.hasAttribute('data-amoled'));
  await page.click('[data-amoled-switch]');
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-amoled')), !amoled);
  assert.equal(await page.locator('[data-theme-pick="ember"]').evaluate((c) => c.hasAttribute('data-amoled')), !amoled, 'the cards follow AMOLED');
  assert.ok(await page.locator('[data-roll]').isHidden());
  await page.click('[data-theme-pick="custom"]');
  const first = await html('--primary');
  await page.click('[data-roll]');
  const rolled = await html('--primary');
  assert.notEqual(rolled, first, 'Roll again changes the palette');
  assert.equal(await page.locator('[data-theme-pick="custom"]').evaluate((c) => getComputedStyle(c).getPropertyValue('--primary').trim()), rolled, 'the dice card shows the rolled palette');
  await page.click('[data-theme-pick="event-horizon-prime"]');
  if (process.env.P9_EVIDENCE) await page.screenshot({ path: path.join(process.env.P9_EVIDENCE, 'look-picker.png') });
  console.log(`PASS look picker: 25 cards in their own colours (4 matched the page), ${fonts.length} fonts, 6 effects, AMOLED, Roll again`);
});

test('Setup wizard UI: every screen in order, sign-in through the fake CLI, starter files, skip into the Notification Center until done (threat model rows 17, 31)', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-welcome-')), profile = path.join(home, 'profile');
  const opened = path.join(home, 'opened.txt'), browser = path.join(home, 'browser');
  await writeFile(browser, '#!/bin/sh\nprintf "%s\\n" "$1" >> ' + opened + '\n');
  await chmod(browser, 0o755);
  const env = { ...process.env, P9_OPEN_URL: browser }; delete env.ELECTRON_RUN_AS_NODE;
  const launch = async () => {
    const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
    const proc = app.process();
    t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
    const page = await app.firstWindow();
    await page.locator('#rChat').waitFor();
    return { app, page };
  };
  const until = async (check, what) => {
    for (let i = 0; i < 100; i++) { const value = await check(); if (value) return value; await new Promise((r) => setTimeout(r, 100)); }
    throw new Error('timed out: ' + what);
  };
  const ev = process.env.P9_EVIDENCE, shot = async (name) => { if (ev) { await page.waitForTimeout(600); await page.screenshot({ path: path.join(ev, name) }); } };
  const credentials = path.join(instance.directory, '.claude', '.credentials.json'), marker = 'P9-CREDENTIAL-MARKER-' + Date.now();
  const setup = () => call(instance, '/setup');
  let s = await setup();
  assert.deepEqual(Object.keys(s).sort(), ['agentsFile', 'claude', 'codex', 'registryFile', 'settings', 'settingsError', 'settingsFile', 'settingsInvalid',
    'settingsPresent', 'tmux', 'workspace', 'workspaceEmpty', 'writable']);
  assert.deepEqual([s.settings, s.settingsPresent, s.claude, s.codex, s.writable], [false, false, false, false, true]);
  // Off Linux there is no Terminal screen and tmux counts as done; tmux missing here leaves that one check open.
  const total = s.tmux === null ? 6 : 7, base = s.tmux === false ? 1 : 2, settingsFile = s.settingsFile;

  let { app, page } = await launch();
  const card = () => page.locator('#cards [data-key="welcome"]'), body = () => page.locator('#welBody').innerText();
  const at = (n, title) => page.waitForFunction(([n, title, total]) => document.querySelector('#welDlg').open
    && document.querySelector('#welStep').textContent === 'Step ' + n + ' of ' + total && document.querySelector('#welT').textContent === title, [n, title, total]);
  const next = () => page.click('#welFoot [data-act="next"]');
  await card().waitFor({ timeout: 10000 });
  assert.match(await card().innerText(), new RegExp('Set up · ' + base + ' of 4 done[\\s\\S]*agent sign-in · Mission Control files'));
  await shot('setup-card.png');
  // The card opens at the first step not done; Back walks to the start.
  await card().locator('.open').click();
  await at(3, 'Sign in to an agent');
  assert.ok(await page.locator('#welFoot [data-act="next"]').isDisabled(), 'no agent signed in: Next waits');
  await page.click('[data-act="back"]'); await at(2, 'Your workspace');
  assert.equal(await page.locator('#welWs').textContent(), s.workspace);
  assert.match(await body(), /P9 can write here/);
  await shot('wizard-1-workspace.png');
  await page.click('[data-act="back"]'); await at(1, 'Welcome to Event Horizon');
  await shot('wizard-0-welcome.png');
  await next(); await at(2, 'Your workspace'); await next(); await at(3, 'Sign in to an agent');

  // Sign-in: the fake CLI prints a claude.com URL and a paste prompt. The page learns only that a URL exists.
  await page.click('[data-act="start:claude"]');
  await page.locator('[data-act="open:claude"]').waitFor({ timeout: 10000 });
  await page.fill('#welCode', 'abc 123');
  await page.waitForTimeout(2500);
  assert.equal(await page.locator('#welCode').inputValue(), 'abc 123', 'a 2 s refresh keeps what is typed');
  await shot('wizard-2-signing-in.png');
  await page.click('[data-act="code:claude"]');
  assert.equal(await until(() => readFile(path.join(instance.workspace, 'fake-login-code'), 'utf8').catch(() => ''), 'the code'), '"abc 123"\n');
  await page.waitForFunction(() => document.querySelector('#welCode')?.value === '', null, { timeout: 5000 }); // sent: the box empties
  await page.click('[data-act="open:claude"]');
  assert.equal((await until(() => readFile(opened, 'utf8').catch(() => ''), 'the open')).trim(), 'https://claude.com/cai/oauth/authorize?fake=1');
  assert.ok(!(await page.content()).includes('oauth'), 'the page never holds the URL');
  // "done" ends the fake CLI without a credentials file: the cause, and Retry in place of Sign in.
  await page.fill('#welCode', 'done'); await page.click('[data-act="code:claude"]');
  await page.locator('[data-act="start:claude"]', { hasText: 'Retry' }).waitFor({ timeout: 10000 });
  assert.match(await body(), /Claude sign-in ended without signing in/);
  await shot('wizard-2-ended.png');
  // The credentials file appears: shown within a refresh, never read.
  await mkdir(path.dirname(credentials), { recursive: true }); await writeFile(credentials, JSON.stringify({ token: marker }));
  await page.locator('#welBody .ok', { hasText: 'Signed in' }).waitFor({ timeout: 5000 });
  assert.ok(!(await page.content()).includes(marker));
  assert.ok(await page.locator('#welFoot [data-act="next"]').isEnabled());
  await shot('wizard-2-agents.png');

  await next(); await at(4, 'Mission Control');
  assert.match(await body(), /Settings file[\s\S]*Not found[\s\S]*Starter files[\s\S]*Missing/);
  assert.equal(await page.locator('#welFile').textContent(), settingsFile);
  await shot('wizard-3-mission.png');
  await page.click('[data-act="starter"]');
  await page.locator('#welBody .ok', { hasText: 'Created:' }).waitFor({ timeout: 10000 });
  await page.locator('#welBody .ok', { hasText: '✓ There' }).waitFor({ timeout: 5000 });
  assert.match(await body(), /✓ Loaded/);
  s = await setup();
  assert.deepEqual([s.settings, s.agentsFile, s.registryFile], [true, true, true]);
  await shot('wizard-3-mission-done.png');
  await next();
  if (s.tmux !== null) {
    await at(5, 'Terminal');
    assert.match(await body(), s.tmux ? /✓ Found/ : /tmux is not installed/);
    await shot('wizard-4-terminal.png');
    await next();
  }
  await at(total - 1, 'You');
  await page.fill('#welName', 'Ada');
  await page.waitForTimeout(2500);
  assert.equal(await page.locator('#welName').inputValue(), 'Ada');
  await page.locator('#welName').press('Tab');
  await until(() => page.evaluate(() => window.p9.getSettings().then((x) => x.name === 'Ada')), 'the name saved');
  // Issue #4 item 4, option C: petdex.dev, opened only through the fixed-address opener.
  await page.click('#welPetdex');
  await until(async () => (await readFile(opened, 'utf8')).includes(PETDEX_URL), 'petdex opened');
  await shot('wizard-5-you.png');
  await next(); await at(total, s.tmux === false ? 'Almost there' : 'You are set');
  await shot('wizard-6-done.png');
  if (s.tmux !== false) await card().waitFor({ state: 'detached', timeout: 5000 }); // every check passes: no card anywhere
  await page.click('[data-act="tour"]');
  await page.locator('#walk').waitFor({ timeout: 5000 });
  assert.equal(await page.locator('#welDlg').evaluate((d) => d.open), false);
  await page.keyboard.press('Escape');

  // Signed out again. The x skips: the card leaves the stack for the Notification Center, and stays there after a restart.
  await rm(credentials);
  await app.close();
  ({ app, page } = await launch());
  await card().waitFor({ timeout: 10000 });
  assert.match(await card().innerText(), new RegExp('Set up · ' + (base + 1) + ' of 4 done'));
  await card().locator('.x').click();
  assert.equal(await card().count(), 0);
  const centerRow = () => page.locator('#mdlBody [data-i]', { hasText: 'Set up ·' });
  await page.keyboard.press('Control+Shift+N');
  await centerRow().waitFor();
  await shot('setup-in-center.png');
  await centerRow().click();
  await at(3, 'Sign in to an agent');
  await page.keyboard.press('Escape');
  await app.close();
  ({ app, page } = await launch());
  await page.keyboard.press('Control+Shift+N');
  await centerRow().waitFor({ timeout: 10000 });
  assert.equal(await card().count(), 0, 'skipped: not on the stack after a restart');
  await page.click('#mdlX');
  // Settings → Setup opens it at the same step; signed in meanwhile, the notification goes.
  await page.click('#setBtn');
  assert.equal(await page.locator('#setWel').innerText(), 'Setup');
  await shot('settings-setup.png');
  await page.click('#setWel');
  await at(3, 'Sign in to an agent');
  await writeFile(credentials, JSON.stringify({ token: marker }));
  await page.locator('#welBody .ok', { hasText: 'Signed in' }).waitFor({ timeout: 5000 });
  await page.keyboard.press('Escape');
  if (s.tmux !== false) {
    await page.keyboard.press('Control+Shift+N');
    await page.locator('#mdlBody').waitFor();
    await page.waitForTimeout(500);
    assert.equal(await centerRow().count(), 0, 'done: gone from the Notification Center');
    await page.click('#mdlX');
  }
  // "Turn Mission off for now" stays on the Mission Control screen.
  await page.click('#setBtn'); await page.click('#setWel');
  await at(s.tmux === false ? 5 : 1, s.tmux === false ? 'Terminal' : 'Welcome to Event Horizon');
  if (s.tmux === false) { await page.click('[data-act="back"]'); } else { await next(); await next(); await next(); }
  await at(4, 'Mission Control');
  await page.click('[data-act="mission-off"]');
  await page.waitForFunction(() => document.querySelector('[data-focus-btn="mission"]').hidden && !document.querySelector('#welDlg').open);
  console.log('PASS setup wizard UI: card count, resume at the first step not done, sign-in code and open, ended shows Retry, starter files, name and petdex, tour, skip to the Notification Center across a restart, gone when done, Mission off');
});

test('Cards: no rebuild per event, old _tyler/ items wait in the bell, a chat-made one gets a card, Skip clears it, running chats are robot heads', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async (paths) => {
    const w = paths.workspace;
    await mkdir(path.join(w, '_tyler'), { recursive: true }); await mkdir(path.join(w, 'hub'), { recursive: true });
    await writeFile(path.join(w, 'hub/registry.json'), JSON.stringify({ scripts: [], apps: [], pages: [] }));
    await writeFile(path.join(w, 'AGENTS.md'), '# Projects\n');
    await writeFile(path.join(w, '_tyler/old-question.md'), '# Old question\n\nA.\n');
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
  const turn = async (id, text) => { await call(instance, `/chat/${id}/prompt`, 'POST', { text }); await page.locator(`#rBots [data-bot="${id}"]:not([data-busy])`).waitFor({ timeout: 15000 }); };
  const id = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  // A chat that writes a _tyler/ item: the item gets a card when the turn ends.
  await writeFile(path.join(instance.workspace, '_tyler/new-question.md'), '# Made by the chat\n\nA.\n');
  await turn(id, 'make one');
  const card = page.locator('#cards [data-key^="reviews:"]');
  await card.waitFor({ timeout: 10000 });
  assert.match(await card.innerText(), /1\s*1 item needs you/);
  assert.equal(await page.locator(`#rBots [data-bot="${id}"]`).getAttribute('data-agent'), 'claude', 'the running chat is a robot head');
  // Replied (Builder: the chat card never went away): no card for the chat itself, only the _tyler/ one.
  assert.equal(await page.locator('#cards .card:not([data-key="welcome"])').count(), 1);
  await shot('cards-new-item.png');
  // Blink (Builder, 2026-10-17): another turn re-renders everything; the card is the same element, so its halo does not restart.
  await card.evaluate((el) => { el.kept = 'yes'; });
  await turn(id, 'again');
  assert.equal(await card.evaluate((el) => el.kept), 'yes', 'card rebuilt by an unrelated event');
  // Skip takes it off the stack; it waits in the bell with the old one.
  await card.locator('.open').click();
  await page.locator('#mdlFoot [data-skip]').click();
  if (await page.locator('#mdl[open]').count()) await page.keyboard.press('Escape');
  await card.waitFor({ state: 'detached' });
  // No sample notices in the bell on a live daemon (Builder, 2026-10-18: "its still test data"); they toasted 2.5 s and 5.5 s after load.
  await page.waitForTimeout(Math.max(0, started + 6500 - Date.now()));
  const bell = await center();
  assert.match(bell, /2 items in _tyler\/\nwaiting/);
  assert.doesNotMatch(bell, /rss-report|restic snapshot/, 'sample notices in the live bell');
  await shot('cards-skipped.png');
  // Sort Waiting on you by newest or by project, the file name's <project>- prefix (Builder, 2026-10-19: "an optional sorter
  // for the _tyler/ items ... by project, date updated"). old-question.md is touched last, so the two orders differ.
  await utimes(path.join(instance.workspace, '_tyler/old-question.md'), new Date(), new Date(Date.now() + 60000));
  await turn(id, 'touch');
  await page.click('#rMission');
  const needs = page.locator('#fMission .needs [data-list] li .txt'), sort = page.locator('#fMission .needs [data-sort]');
  await page.waitForFunction(() => document.querySelector('#fMission .needs [data-list] li .txt')?.textContent === 'Old question', null, { timeout: 10000 });
  assert.deepEqual([await sort.inputValue(), ...await needs.allInnerTexts()], ['updated', 'Old question', 'Made by the chat'], 'newest first by default');
  await sort.selectOption('project');
  assert.deepEqual(await needs.allInnerTexts(), ['Made by the chat', 'Old question'], 'by project: new-question.md before old-question.md');
  if (process.env.P9_EVIDENCE) { await page.waitForTimeout(400); await page.locator('#fMission .needs').screenshot({ path: path.join(process.env.P9_EVIDENCE, 'tyler-sort-project.png') }); }
  await page.reload(); await page.click('#rMission');
  await page.waitForFunction(() => document.querySelector('#fMission .needs [data-list] li .txt')?.textContent === 'Made by the chat', null, { timeout: 10000 });
  assert.equal(await sort.inputValue(), 'project', 'the choice survives a reload');
  // An item with no A. line (Builder, 2026-10-21: Q1:/Q2: lines, "changed on disk" for days): Save says why, nothing written.
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
  // The tab's x stops the chat, like VS Code (Builder, 2026-10-18: two robot heads for one open tab): its robot head goes.
  await page.locator('#tabs .tab[data-id="' + id + '"] .close').click();
  await page.locator('#rBots [data-bot="' + id + '"]').waitFor({ state: 'detached', timeout: 15000 });
  let state; for (let i = 0; i < 50 && state !== 'stopped'; i++, await new Promise((r) => setTimeout(r, 200))) state = (await call(instance, '/chat')).conversations.find((c) => c.id === id)?.state;
  assert.equal(state, 'stopped', 'closing the tab left the chat running');
  console.log('PASS cards: old item quiet in the bell, chat-made item carded at turn end, card kept across events, Skip clears it, chat is a robot head, x stops it');
});

test('Models and slash commands: the Model select lists the agent\'s own models, typing / lists its commands, a picked model reaches the agent', { timeout: 120000 }, async (t) => {
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
  await page.locator('#rBots [data-bot="' + id + '"]:not([data-busy])').waitFor({ timeout: 15000 });
  await page.locator('#tabs .tab[data-id="' + id + '"]').click();
  const pane = page.locator('.pane[data-id="' + id + '"]'), select = pane.locator('select[data-model]');
  await select.locator('option[value="haiku"]').waitFor({ state: 'attached', timeout: 10000 });
  assert.deepEqual(await select.locator('option').allInnerTexts(), ['Default (recommended)', 'Opus', 'Haiku']);
  const ta = pane.locator('.composer textarea'), menu = pane.locator('[data-slash]');
  await ta.click(); await page.keyboard.type('/');
  assert.deepEqual(await menu.locator('[data-cmd]').evaluateAll((b) => b.map((x) => x.dataset.cmd)), ['compact', 'context', 'review']);
  // A real agent sends dozens of commands: rows keep their height and the menu scrolls (Builder, 2026-10-19: rows were squashed to slivers).
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
  // Flashing (Builder, 2026-10-18): a turn updates the pane and its tab in place; rebuilt ones restart every animation.
  await pane.evaluate((el) => { el.kept = 'yes'; }); await page.locator('#tabs .tab[data-id="' + id + '"]').evaluate((el) => { el.kept = 'yes'; });
  await select.selectOption('opus');
  await ta.click(); await page.keyboard.type('model'); await page.keyboard.press('Enter');
  await pane.getByText('model:opus').waitFor({ timeout: 15000 });
  await page.locator('#rBots [data-bot="' + id + '"]:not([data-busy])').waitFor({ timeout: 15000 });
  assert.equal(await pane.locator('select[data-model]').inputValue(), 'opus', 'the select shows the model now in use');
  assert.deepEqual([await pane.evaluate((el) => el.kept), await page.locator('#tabs .tab[data-id="' + id + '"]').evaluate((el) => el.kept)], ['yes', 'yes'], 'pane or tab rebuilt by the turn');
  // Effort and the other agent settings (Builder, 2026-10-18: "wire all of them"; threat model row 22): the agent's own lists, picked values reach it.
  assert.deepEqual(await pane.locator('select[data-pick]').evaluateAll((l) => l.map((x) => x.getAttribute('aria-label') + '=' + x.value + ':' + [...x.options].map((o) => o.text).join('|'))),
    ['Effort=medium:Effort: Low|Effort: Medium|Effort: High', 'Fast mode=off:Fast mode: On|Fast mode: Off']);
  await pane.locator('select[data-pick="effort"]').selectOption('high'); await pane.locator('select[data-pick="fast"]').selectOption('on');
  await ta.click(); await page.keyboard.type('config'); await page.keyboard.press('Enter');
  await pane.getByText('config:model=opus,effort=high,fast=on,sandbox=on').waitFor({ timeout: 15000 });
  await page.locator('#rBots [data-bot="' + id + '"]:not([data-busy])').waitFor({ timeout: 15000 });
  assert.deepEqual(await pane.locator('select[data-pick]').evaluateAll((l) => l.map((x) => x.value)), ['high', 'on'], 'the selects show the settings now in use');
  if (process.env.P9_EVIDENCE) await pane.locator('.ptool').screenshot({ path: path.join(process.env.P9_EVIDENCE, 'pickers.png') });
  // Split shows the last two chats opened (Builder, 2026-10-19: one chat open, then a new one, and Split showed one pane).
  await page.click('#rSplit');
  const second = (await call(instance, '/chat', 'POST', { provider: 'codex' })).conversation;
  await page.waitForFunction(([a, b]) => document.querySelector('#chats').dataset.split === 'true' && [...document.querySelectorAll('#chats .pane')].map((p) => p.dataset.id).join() === b + ',' + a, [id, second], { timeout: 15000 });
  // The new chat's title is painted as a gradient clipped to its text, so the paint stops at the heading's box: the text's
  // glyph area must sit inside it (Builder, 2026-10-19: "the bottom of the g in 'what are we working on' is cut off").
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

// Builder, 2026-10-19: "When creating a new chat, a dropdown with what folder i want to open the chat in would be great."
// Threat model row 24: Choose folder... is the system dialog in main (stubbed here); only a folder inside the workspace comes back.
test('Chat tabs: each tab shows the name the agent gave the chat, its dot in the agent\'s colour (Claude orange, Codex blue)', { timeout: 120000 }, async (t) => {
  // Builder, 2026-10-19: "have the tabs at the top for each chat show the chats name. color the dot the color of the agent (claude orange, codex blue)"
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
  const tab = (id) => page.locator('#tabs .tab[data-id="' + id + '"]');
  await tab(claude).getByText('Fix the login bug').waitFor({ timeout: 15000 });
  await tab(codex).waitFor({ timeout: 15000 });
  assert.equal(await tab(codex).innerText(), 'Codex', 'no name sent yet: the agent\'s name');
  const dot = (id) => tab(id).locator('.dot').evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.deepEqual([await dot(claude), await dot(codex)], ['rgb(217, 119, 87)', 'rgb(59, 130, 246)']);
  if (process.env.P9_EVIDENCE) await page.locator('.topbar').screenshot({ path: path.join(process.env.P9_EVIDENCE, 'chat-tabs.png') });
  console.log('PASS chat tabs: "Fix the login bug" on the Claude tab, Codex unnamed, dots orange and blue');
});

test('Agent images: a generated image and a reply\'s image show at their real size; an image known only by its address is never loaded (threat model row 26)', { timeout: 120000 }, async (t) => {
  // Builder, 2026-10-19: "I cannot view images that are generated by an agent in the chat feed."
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
  await page.locator('#tabs .tab[data-id="' + codex + '"]').click();
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
  // Builder, 2026-10-20: the window lagged and froze on a 25,000-event chat; a chat draws only its latest 200 steps.
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

test('Loosened modes: Full access and Bypass permissions warn in red first; Cancel keeps the old mode; "don\'t show again" and the last pick survive a restart (threat model row 25)', { timeout: 120000 }, async (t) => {
  // Builder, 2026-10-19: Codex Full access as used daily, Claude's bypass, a red warning with a "don't show again" button; installs start safe.
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-loose-')), 'profile');
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
  const chat = async (provider) => {
    const id = (await call(instance, '/chat', 'POST', { provider })).conversation;
    await page.locator(`#tabs .tab[data-id="${id}"]`).click();
    const pane = page.locator(`#chats .pane[data-id="${id}"]`);
    await pane.locator('[data-mode]').waitFor();
    return pane;
  };
  let dlg = page.locator('#looseDlg');
  const mode = (pane) => pane.locator('[data-mode]');
  // The dialog's close event runs a task after open turns false; give the picker up to 3 s to show the mode, then assert.
  const settled = async (pane, want, message) => {
    await mode(pane).evaluate((el, w) => new Promise((ok) => { const end = Date.now() + 3000; (function tick() { if (el.value === w || Date.now() > end) ok(); else setTimeout(tick, 20); })(); }), want);
    assert.equal(await mode(pane).inputValue(), want, message);
  };
  // After Turn on the picker already reads the new mode (the browser set it); the handler sets s.mode only once the dialog's
  // close task runs. Its localStorage write marks that, so the next prompt carries the new mode (GitHub run 39527149498).
  const applied = (agent, want) => page.waitForFunction(([a, w]) => localStorage.getItem('p9-mode:' + a) === w, [agent, want], { timeout: 5000 });
  // On a timeout the pane's text goes in the error: GitHub's runner missed one reply (2026-10-20) and nothing showed why.
  const said = async (pane, text, want) => { await pane.locator('.composer textarea').fill(text); await pane.locator('.composer textarea').press('Enter');
    try { await pane.locator('.msg.agent', { hasText: want }).waitFor({ timeout: 15000 }); }
    catch (error) { throw new Error(`no reply "${want}"; the pane shows:\n${(await pane.innerText().catch(() => '?')).slice(-1500)}`, { cause: error }); } };
  let codex = await chat('codex');
  assert.equal(await mode(codex).inputValue(), 'Auto review', 'a new install starts Codex in Auto review');
  assert.deepEqual(await mode(codex).locator('option').allInnerTexts(), ['Read-only', 'Workspace access', 'Auto review', 'Full access']);
  await mode(codex).selectOption('Full access');
  await dlg.waitFor();
  assert.match(await dlg.innerText(), /Turn on Full access for Codex\?[\s\S]*any file on this computer/);
  const red = await dlg.evaluate((d) => [getComputedStyle(d).borderTopColor, getComputedStyle(d).borderTopWidth]);
  const destructive = await page.evaluate(() => { const b = document.createElement('i'); b.style.color = 'var(--destructive)'; document.body.append(b); const c = getComputedStyle(b).color; b.remove(); return c; });
  assert.deepEqual(red, [destructive, '2px'], 'the warning is bordered in the theme\'s destructive red');
  if (process.env.P9_EVIDENCE) await page.screenshot({ path: path.join(process.env.P9_EVIDENCE, 'loose-warning.png') });
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  await settled(codex, 'Auto review', 'Cancel keeps the old mode');
  await said(codex, 'mode', 'mode:agent');
  await mode(codex).selectOption('Full access'); await dlg.waitFor(); await page.keyboard.press('Escape'); await dlg.waitFor({ state: 'hidden' });
  await settled(codex, 'Auto review', 'Escape cancels too');
  await mode(codex).selectOption('Full access'); await dlg.getByRole('button', { name: 'Turn on', exact: true }).click();
  await settled(codex, 'Full access', 'Turn on sets the mode');
  await applied('codex', 'Full access');
  await said(codex, 'mode', 'mode:agent-full-access');
  let claude = await chat('claude');
  assert.equal(await mode(claude).inputValue(), 'Auto');
  await mode(claude).selectOption('Bypass permissions');
  await dlg.getByRole('button', { name: 'Turn on, don\'t show again' }).click();
  await settled(claude, 'Bypass permissions', 'Turn on sets the mode');
  await applied('claude', 'Bypass permissions');
  await said(claude, 'mode', 'mode:bypassPermissions');
  await app.close();
  ({ app, page } = await launch()); dlg = page.locator('#looseDlg');
  codex = await chat('codex');
  assert.equal(await mode(codex).inputValue(), 'Full access', 'a new chat starts in the last mode picked for its agent');
  claude = await chat('claude');
  await mode(claude).selectOption('Manual'); await mode(claude).selectOption('Bypass permissions');
  await said(claude, 'mode', 'mode:bypassPermissions');
  assert.equal(await dlg.evaluate((d) => d.open), false, 'don\'t show again: no warning');
  codex = await chat('codex'); await mode(codex).selectOption('Read-only'); await mode(codex).selectOption('Full access');
  await dlg.waitFor(); await dlg.getByRole('button', { name: 'Cancel' }).click();
  await settled(codex, 'Read-only', 'Full access still warns: its own don\'t show again was never picked');
  console.log('PASS loosened modes: Codex starts in Auto review; Full access warns in red, Cancel and Escape keep Auto review, Turn on reaches the agent; Claude bypass with don\'t show again skips the warning after a restart; Full access still warns');
});

test('Chat folder: Start in offers the workspace, recent folders and Choose folder...; a chosen folder reaches the chat, outside picks are refused (threat model row 24)', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  await mkdir(path.join(instance.workspace, 'proj/sub'), { recursive: true });
  await symlink(instance.directory, path.join(instance.workspace, 'out'));
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-folder-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#rChat').waitFor();
  const pickNext = (filePaths) => app.evaluate(({ dialog }, filePaths) => { dialog.showOpenDialog = async () => ({ canceled: !filePaths.length, filePaths }); }, filePaths);
  const folder = page.locator('#newFolder');
  const labels = () => folder.locator('option').allInnerTexts();
  await page.click('#newBtn'); await folder.waitFor();
  assert.deepEqual(await labels(), ['Workspace', 'Choose folder…']);
  // Main sends back only a folder whose real path is inside the workspace: outside, a link out, and Cancel give nothing.
  for (const [pick, want] of [[[instance.directory], null], [[path.join(instance.workspace, 'out')], null], [[], undefined], [[instance.workspace], '']]) {
    await pickNext(pick);
    assert.equal(await page.evaluate(() => window.p9.pickFolder()), want, JSON.stringify(pick));
  }
  await pickNext([instance.directory]);
  await folder.selectOption({ label: 'Choose folder…' });
  await page.locator('#toasts', { hasText: 'Pick a folder inside the workspace.' }).waitFor({ timeout: 5000 });
  assert.equal(await folder.inputValue(), '');
  await pickNext([path.join(instance.workspace, 'proj/sub')]);
  await folder.selectOption({ label: 'Choose folder…' });
  await page.waitForFunction(() => document.querySelector('#newFolder').value === 'proj/sub', null, { timeout: 5000 });
  if (process.env.P9_EVIDENCE) await page.screenshot({ path: path.join(process.env.P9_EVIDENCE, 'chat-folder-pick.png') });
  await page.locator('#newPop [data-new="claude"]').first().click();
  await page.locator('.pane .welcome', { hasText: 'proj/sub' }).waitFor({ timeout: 10000 });
  if (process.env.P9_EVIDENCE) await page.screenshot({ path: path.join(process.env.P9_EVIDENCE, 'chat-folder-welcome.png') });
  assert.deepEqual((await call(instance, '/chat')).conversations.map((c) => c.folder), ['proj/sub']);
  // The folder is now a recent one, also after a reload; Workspace still makes a chat with no folder.
  await page.reload(); await page.locator('#rChat').waitFor();
  await page.click('#newBtn'); await folder.waitFor();
  assert.deepEqual(await labels(), ['Workspace', 'proj/sub', 'Choose folder…']);
  await folder.selectOption({ label: 'Workspace' });
  await page.locator('#newPop [data-new="claude"]').first().click();
  await page.waitForFunction(async () => (await window.p9.chat('list')).body.conversations.length === 2, null, { timeout: 10000 });
  assert.deepEqual((await call(instance, '/chat')).conversations.map((c) => c.folder), ['proj/sub', '']);
  console.log('PASS chat folder: outside, linked-out and cancelled picks give nothing; a chosen folder reaches the daemon and the welcome; kept as a recent folder after a reload');
});

test('Chat file browser: each scope lists its real folder, a file opens read-only with its text, ../, links and locked names are refused (threat model row 23)', { timeout: 120000 }, async (t) => {
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
  await page.click('#rFiles');
  // Current project with no chat shown is the main project; folders come first and open in place.
  const names = () => page.locator('#tree button span.truncate').allInnerTexts();
  await listed('proj'); assert.deepEqual(await names(), ['sub', 'notes.md'], 'main project');
  await page.locator('#tree [data-ldir="proj/sub"]').click();
  await page.locator('#tree [data-lfile="proj/sub/deep.md"]').waitFor({ timeout: 5000 });
  // A file opens with its text, read-only: no editor and no Make Primary.
  await page.locator('#tree [data-lfile="proj/notes.md"]').click();
  await page.locator('#mdlBody .fileview', { hasText: 'line two' }).waitFor({ timeout: 5000 });
  if (process.env.P9_EVIDENCE) { await page.waitForTimeout(400); await page.screenshot({ path: path.join(process.env.P9_EVIDENCE, 'chat-files-view.png') }); }
  assert.equal(await page.locator('#mdlT').innerText(), 'proj/notes.md');
  assert.equal(await page.locator('#mdlBody textarea').count(), 0);
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
  await page.click('#newBtn'); await page.locator('#newFolder').selectOption({ label: 'Choose folder…' });
  await page.waitForFunction(() => document.querySelector('#newFolder').value === 'proj/sub', null, { timeout: 5000 });
  await page.locator('#newPop [data-new="claude"]').first().click();
  await listed('proj/sub'); assert.deepEqual(await names(), ['deep.md']);
  // Only list and read, one string path each; the daemon refuses ../, links and locked names as on every file route.
  const ask = (action, payload) => page.evaluate(([a, p]) => window.p9.mission(a, p), [action, payload]);
  const refused = { status: 400, body: { error: 'request-refused' } };
  for (const [action, payload] of [['list', { path: 7 }], ['read', {}], ['read', { path: ['proj/notes.md'] }], ['list', { path: '../' }], ['list', { path: 'out' }],
    ['read', { path: 'out/settings.json' }], ['list', { path: '_' + 'private' }], ['read', { path: '_' + 'private/secret.md' }], ['read', { path: 'proj/../_' + 'private/secret.md' }]]) {
    assert.deepEqual(await ask(action, payload), refused, action + ' ' + JSON.stringify(payload));
  }
  assert.equal((await ask('read', { path: 'proj/notes.md' })).body.content, 'project notes\nline two\n');
  await assert.rejects(ask('write', { path: 'proj/notes.md', content: 'x' }), /ipc-sender-refused/);
  console.log('PASS chat file browser: four scopes list their folders, Current project follows the chat shown, files open read-only, bad paths refused');
});

test('Turn finished: a live turn-end nobody watches makes one notice (P9 words only) and a card; opening the chat clears it; replay makes none (threat model row 21)', { timeout: 120000 }, async (t) => {
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
  await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'hello' });
  const card = page.locator('#cards [data-key="done:' + id + '"]');
  await card.waitFor({ timeout: 15000 });
  assert.deepEqual(await page.evaluate(() => window.__notes), [['Claude finished', 'Claude']], 'one notice, agent and tab title only');
  assert.match(await card.innerText(), /Claude finished\s*Claude/);
  // Back at the window: opening the chat from the card clears it.
  await page.evaluate(() => { document.hasFocus = () => true; });
  await card.locator('.open').click();
  await card.waitFor({ state: 'detached', timeout: 5000 });
  await page.keyboard.press('Escape');
  // A reload replays the turn-end: no card, no notice.
  // Still in the background from the first script on, so only the replay guard stops it.
  await page.addInitScript(background);
  await page.reload(); await page.locator('#tabs .tab[data-id="' + id + '"]').waitFor({ timeout: 15000 });
  await page.waitForTimeout(1500);
  assert.deepEqual([await page.locator('#cards [data-key^="done:"]').count(), await page.evaluate(() => window.__notes)], [0, []], 'replayed turn-end made a card or notice');
  console.log('PASS turn finished: 1 notice with P9 words only, 1 card, opening clears it, replay makes none');
});

test('Interrupt and send: a queued message sent with the bolt, or Ctrl+Enter, reaches the agent after the cancel; a refused one goes back in the box', { timeout: 120000 }, async (t) => {
  // Builder, 2026-10-21: "I sent a message. it went to the waiting queue. i hit the button to interupt and send the message now,
  // and it didnt send my message, and it cancelled your turn."
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-interrupt-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#rChat').waitFor();
  const id = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'hello' });
  await page.locator('#tabs .tab[data-id="' + id + '"]').click();
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

test('Landing page: shows on open, only Space skips the intro, a focus pick leaves it, the mark reopens it, startLast and a reload skip it', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-land-')), profile = path.join(home, 'profile');
  await mkdir(path.join(profile, 'pets', 'land-pet'), { recursive: true });
  await writeFile(path.join(profile, 'pets', 'land-pet', 'pet.json'), JSON.stringify({ id: 'land-pet', displayName: 'Lander', description: 'x', spritesheetPath: 'spritesheet.png' }));
  await writeFile(path.join(profile, 'pets', 'land-pet', 'spritesheet.png'), sheet({ 0: 2, 3: 4, 4: 5, 6: 3, 7: 5 }));
  // A file from before the landing page: no name, no startLast. It must load (upgraded), not fall back to the defaults.
  await writeFile(path.join(profile, 'p9-settings.json'), JSON.stringify({ zoom: 1.1, closeOnSend: false, focus: { chat: true, dev: true, mission: true }, pet: PETS }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.P9_LANDING;
  // Evidence: the window's own capture. page.screenshot crops a zoomed (1.1) window to its CSS size and cuts off the bottom right.
  const ev = process.env.P9_EVIDENCE, shot = async (name) => ev && await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 300))))) === undefined && writeFile(path.join(ev, name), Buffer.from(await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64')), 'base64'));
  if (ev) await mkdir(ev, { recursive: true });
  const launch = async () => {
    const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
    const proc = app.process();
    t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
    return { app, page: await app.firstWindow() };
  };
  const state = (page) => page.evaluate(() => ({ open: document.querySelector('#land').open, stage: document.querySelector('#land').dataset.stage, focus: document.querySelector('.shell').dataset.focus }));

  let { app, page } = await launch();
  await page.waitForFunction(() => document.querySelector('#land').open);
  const opened = Date.now();
  const settings = await page.evaluate(() => window.p9.getSettings());
  assert.equal(settings.zoom, 1.1, 'the old file loaded rather than the defaults');
  assert.equal(settings.startLast, false);
  assert.equal(typeof settings.name, 'string');
  assert.equal((await state(page)).stage, 'intro');
  await page.waitForTimeout(1200);
  await shot('landing-intro.png');
  // Clicks and other keys do not skip; Escape does not close it during the intro.
  await page.mouse.click(400, 300); await page.keyboard.press('2'); await page.keyboard.press('Escape');
  assert.deepEqual(await state(page), { open: true, stage: 'intro', focus: 'chat' });
  await page.keyboard.press('Space');
  assert.equal((await state(page)).stage, 'main');
  assert.ok(Date.now() - opened < 2600, 'Space skipped before the intro would have ended');
  await page.waitForFunction(() => document.querySelector('#landPets canvas.pet')?.getContext('2d').getImageData(96, 104, 1, 1).data[3] > 0);
  assert.equal(await page.locator('#landPets canvas.pet').getAttribute('title'), 'Lander');
  await page.waitForTimeout(1000); // the stage move ends (the greeting shows 0.25 s in)
  assert.ok((await page.locator('#landHi').innerText()).length > 3);
  assert.match(await page.locator('#landSub').innerText(), /^(\d+ needs? you|All quiet\. Where to\?)$/); // its own daemon: no chats running
  await shot('landing-main.png');
  // Behind the main page the sky draws at full resolution, not a fraction scaled up (Builder, 2026-10-19: "when it is in the
  // background it looks low quality. as if it lost its quality somehow").
  // Without WebGL (a display with no GPU, such as GitHub's Xvfb) the sky is off by design (landing-sky.mjs), so there is nothing to size.
  if (!await page.evaluate(() => !!document.createElement('canvas').getContext('webgl'))) t.diagnostic('no WebGL on this display: sky resolution check not run');
  else await page.waitForFunction(() => { const c = document.querySelector('#landSky'); return c.width === Math.round(c.clientWidth * Math.min(devicePixelRatio || 1, 2)); }, null, { timeout: 5000 })
    .catch(async () => assert.fail('main-stage sky below full size: ' + await page.evaluate(() => { const c = document.querySelector('#landSky'); return c.width + ' px for ' + c.clientWidth + ' CSS px at ratio ' + devicePixelRatio; })));
  await page.keyboard.press('2');
  await page.waitForFunction(() => !document.querySelector('#land').open);
  // First login: the setup wizard opens itself while a check fails (no settings here), before the walkthrough (v0.1.3 C1).
  await page.locator('#welDlg[open]').waitFor({ timeout: 5000 });
  assert.equal(await page.locator('#welStep').textContent(), 'Step 1 of ' + ((await call(instance, '/setup')).tmux === null ? 6 : 7));
  assert.equal(await page.locator('#walk').count(), 0, 'the walkthrough waits for the wizard');
  await shot('wizard-auto.png');
  await page.click('#welFoot [data-act="skip"]');
  // Then the walkthrough starts in Chat and ends in the focus picked (GitHub issue #4 item 2).
  await page.locator('#walk').waitFor({ timeout: 5000 });
  assert.match(await page.locator('#walk .eyebrow').innerText(), /^1 of \d+$/i); // innerText applies the eyebrow's uppercase
  assert.equal((await state(page)).focus, 'chat');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#walk'));
  assert.deepEqual(await state(page), { open: false, stage: 'main', focus: 'dev' });

  // The mark in the top bar opens it again on the main stage; the name goes in as text; Esc returns to the last focus.
  await page.evaluate(() => window.p9.getSettings().then((s) => window.p9.setSettings({ ...s, name: '<b>Sam</b>' })));
  await page.reload();
  await page.locator('#brandBtn').waitFor();
  assert.equal((await state(page)).open, false, 'a reload of the same window skips the landing');
  assert.equal((await state(page)).focus, 'dev', 'and keeps the last focus');
  // Hovering the mark keeps the name's painted text (Builder, 2026-10-19: "it goes all black"; the theme clips a background to the text).
  await page.hover('#brandBtn');
  assert.deepEqual(await page.locator('#brandBtn').evaluate((b) => { const c = getComputedStyle(b); return [c.backgroundClip, c.backgroundImage !== 'none', c.backgroundColor]; }), ['text', true, 'rgba(0, 0, 0, 0)']);
  await page.click('#brandBtn');
  assert.equal((await state(page)).stage, 'main');
  await page.waitForFunction(() => document.querySelector('#landHi').textContent.length > 3);
  for (let i = 0; i < 20 && !(await page.locator('#landHi em').count()); i++) await page.evaluate(() => { const l = document.querySelector('#land'); l.close(); document.querySelector('#brandBtn').click(); });
  assert.equal(await page.locator('#landHi em').innerText(), '<b>Sam</b>');
  assert.equal(await page.locator('#landHi b').count(), 0);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#land').open);
  assert.equal((await state(page)).focus, 'dev');
  assert.equal(await page.locator('#walk').count(), 0, 'the walkthrough runs once, not on every landing close');

  // Settings: name and "Start in my last focus mode"; with it on, the next start goes straight to the last focus.
  await page.click('#setBtn');
  assert.equal(await page.locator('#setName').inputValue(), '<b>Sam</b>');
  await page.locator('#setName').fill('Tess');
  await page.locator('#setName').press('Tab');
  await page.locator('#setStartLast').check();
  await page.waitForFunction(() => window.p9.getSettings().then((s) => s.startLast && s.name === 'Tess'));
  await page.locator('#setName').evaluate(el => el.scrollIntoView({ block: 'center' }));
  await shot('landing-settings.png');
  await app.close();
  ({ app, page } = await launch());
  await page.waitForFunction(() => !document.querySelector('#land').hasAttribute('data-pending'));
  await page.waitForTimeout(500);
  assert.deepEqual(await state(page), { open: false, stage: 'intro', focus: 'dev' });

  // Off again: the landing shows with the new name; at the smallest window everything still fits.
  await page.evaluate(() => window.p9.getSettings().then((s) => window.p9.setSettings({ ...s, startLast: false })));
  await app.close();
  ({ app, page } = await launch());
  await page.waitForFunction(() => document.querySelector('#land').open);
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.unmaximize(); w.setContentSize(720, 600); });
  await page.waitForFunction(() => innerWidth < 700);
  await page.keyboard.press('Space');
  await page.waitForTimeout(1500);
  const fits = await page.evaluate(() => [...document.querySelectorAll('#landHi, .land-bar, #landPets canvas, .land-mark')].map((e) => { const r = e.getBoundingClientRect(); return [e.id || e.className.baseVal || e.className, r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth]; }));
  assert.ok(fits.every(([, ok]) => ok), JSON.stringify(fits));
  const vp = await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]);
  assert.ok(vp[0] * vp[2] <= 722 && vp[1] * vp[2] <= 640, 'the window is the smallest it can be (720 x 600 plus the frame): ' + vp);
  const bar = await page.locator('.land-bar').boundingBox(), pets = await page.locator('#landPets canvas').boundingBox(), hi = await page.locator('#landHi').boundingBox();
  assert.ok(hi.y + hi.height <= bar.y && bar.y + bar.height <= pets.y, 'greeting, bar and pets do not overlap');
  await shot('landing-720x600.png');
  await page.locator('.land-bar [data-land="chat"]').click();
  await page.waitForFunction(() => !document.querySelector('#land').open);
  assert.equal((await state(page)).focus, 'chat');
  console.log('PASS landing: opens on start (old settings file upgraded), clicks/keys/Esc do not skip the intro, Space does, pets drawn, 2 enters Dev, reload skips it, the mark reopens it with the name as text, Esc to last focus, startLast skips it, fits 720x600');
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
  await page.locator('#tabs .tab[data-id="' + a + '"]').waitFor({ timeout: 60000 });
  await page.locator('#dataNote', { hasText: 'Chat live' }).waitFor();
  const launch = Date.now() - t0;
  // Read before anything opens it: a stopped chat's History row has only its name until its history loads.
  await page.click('#histBtn');
  const row = await page.locator('#histPop .item', { has: page.locator('[data-open="' + stopped[0] + '"]') }).innerText();
  await page.keyboard.press('Escape');

  const b = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  await page.locator('#tabs .tab[data-id="' + b + '"]').click();
  await page.click('#rSplit');
  await page.waitForFunction((ids) => [...document.querySelectorAll('#chats > .pane')].map((p) => p.dataset.id).sort().join() === ids, [a, b].sort().join(), { timeout: 15000 });
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
  assert.doesNotMatch(row, /message/, 'a stopped chat was replayed at launch');
  // Opening it from History loads it.
  await page.click('#histBtn');
  await page.locator('#histPop [data-open="' + stopped[0] + '"]').click();
  await page.locator('#chats .pane[data-id="' + stopped[0] + '"]').getByText('All steps done.').first().waitFor({ timeout: 15000 });
  console.log('PASS E2: only the changed pane is rebuilt; 24 stopped chats not replayed at launch, one loads when opened from History');
});

test('Speed (E2): a listed chat the bridge will not narrow to still goes live, by replaying everything', { timeout: 120000 }, async (t) => {
  // GitHub run 39724310852: test/phone.test.mjs seeds idle chats whose IDs are not UUIDs, the bridge refused only= for
  // them on every try, and the desktop never went live (no Fix with Claude). A refused narrowed replay replays everything.
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const real = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(instance.directory, '.local', 'state', 'p9-foundation', 'p9.db'));
  db.prepare("INSERT INTO conversations (id, provider, title, state, created) VALUES ('fixture-claude', 'claude', 'claude', 'idle', ?)").run(Date.now());
  db.close();
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-fallback-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#dataNote', { hasText: 'Chat live' }).waitFor({ timeout: 30000 });
  await page.locator('#tabs .tab[data-id="' + real + '"]').waitFor();
  console.log('PASS E2 fallback: a chat ID the bridge refuses for only= falls back to the full replay; the desktop went live');
});
