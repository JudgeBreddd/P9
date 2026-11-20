// settings-modes: split from test/settings.test.mjs (O120), by area — the Settings dialog's modes surfaces.
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
// Phase 18 row 2: the Settings page. Threat model row 15 case 4 (the settings IPC refuses any other shape and leaves the
// file alone) plus each setting surviving an app restart; the agent lock goes through the real daemon.

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
  // A new profile starts with the bundled Skipper as its System pet; removed, it stays removed (below).
  assert.deepEqual(await page.evaluate(() => window.p9.listPets().then((l) => l.pets)), [{ name: 'skipper', displayName: 'Skipper' }]);
  assert.deepEqual((await page.evaluate(() => window.p9.getSettings())).pet, DEFAULT_PETS);
  await page.evaluate(() => window.p9.removePet('skipper'));
  // Case 4: the handler itself, called as the shell's own frame, refuses every other shape and writes nothing.
  const refused = await app.evaluate(async ({ ipcMain, BrowserWindow }, PETS) => {
    const sender = BrowserWindow.getAllWindows()[0].webContents, handler = ipcMain._invokeHandlers.get('p9:settings');
    const event = { sender, senderFrame: sender.mainFrame }, good = { zoom: 1, closeOnSend: false, focus: { chat: true, dev: true, mission: true }, pet: PETS, name: 'Sam', xfer: { fileMiB: 512, files: 20000, sendGiB: 4 } };
    const chat = (change) => ({ ...good, pet: { ...good.pet, chat: { ...good.pet.chat, ...change } } });
    const bad = [{ ...good, extra: 1 }, { ...good, zoom: '2' }, { ...good, zoom: 4 }, { ...good, zoom: 0.1 }, { ...good, zoom: NaN },
      { ...good, closeOnSend: 1 }, { ...good, focus: { chat: true, dev: true } }, { ...good, focus: { chat: false, dev: false, mission: false } },
      { ...good, focus: { chat: true, dev: true, mission: true, x: true } }, [good], null, { ...good, pet: '../x' }, { ...good, pet: 5 },
      { ...good, pet: null }, { ...good, pet: 'good-pet' }, { ...good, pet: { claude: null, codex: null, system: null } }, { ...good, pet: { ...good.pet, x: good.pet.chat } },
      { ...good, pet: { chat: good.pet.chat, dev: good.pet.dev } }, chat({ codex: '../x' }), chat({ x: null }), chat({ size: 23 }), chat({ size: 129 }), chat({ size: 48.5 }),
      chat({ on: 1 }), chat({ top: [0.5] }), chat({ top: [2, 0] }), chat({ pane: 'x' }), chat({ pane: [0.1, NaN] }), chat({ top: { 0: 0.1, 1: 0.1, length: 2 } }),
      { ...good, name: 'x'.repeat(41) }, { ...good, name: 'Sam\u0007' }, { ...good, name: 'Sam\u200b' }, { ...good, name: 7 }, { ...good, startLast: false }, (({ name, ...rest }) => rest)(good),
      // Send files' limits (item 23): whole numbers from 1 to each ceiling, all three.
      { ...good, xfer: { ...good.xfer, fileMiB: 0 } }, { ...good, xfer: { ...good.xfer, fileMiB: 65537 } }, { ...good, xfer: { ...good.xfer, files: 1.5 } },
      { ...good, xfer: { fileMiB: 512, files: 20000 } }, (({ xfer, ...rest }) => rest)(good)];
    const out = [];
    for (const value of bad) out.push(await handler(event, value).then(() => 'accepted', (error) => error.message));
    out.push(await handler(event, good, good).then(() => 'accepted', (error) => error.message));
    return out;
  }, PETS);
  assert.deepEqual(refused, [...Array(40).fill('settings-refused'), 'ipc-sender-refused']);
  await assert.rejects(readFile(file), { code: 'ENOENT' });

  // Close on send: a chat opened from the bell closes once the message is sent (733: an ask is a notice and a bell row, no card).
  const id = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'permission' });
  await page.locator('#toasts .toast', { hasText: 'needs you' }).waitFor({ timeout: 15000 });

  await page.click('#setBtn');
  await page.locator('#setDlg[open]').waitFor();
  assert.equal(await page.locator('#setLock').isChecked(), false);
  await page.click('#zIn'); await page.click('#zIn');
  await page.locator('#zVal', { hasText: '120%' }).waitFor();
  await page.click('[data-set-page="Chat Focus"]'); await page.check('#setCloseSend');
  await page.click('[data-set-page="Mission Control"]'); await page.uncheck('#setF-mission');
  await page.click('[data-set-page="General"]'); await page.check('#setLock');
  await page.locator('#setLock:checked').waitFor();
  assert.deepEqual(await call(instance, '/agent-lock'), { on: true });
  // The last focus mode left on cannot be turned off.
  await page.click('[data-set-page="Dev Focus"]'); await page.uncheck('#setF-dev');
  // The box is disabled after the save comes back (main refuses all three off: main.mjs normalizes to null).
  await page.locator('#setF-chat:disabled').waitFor({ timeout: 5000 }).catch(() => {});
  assert.equal(await page.locator('#setF-chat').isDisabled(), true);
  await page.check('#setF-dev'); await page.click('[data-set-page="General"]');
  if (process.env.P9_EVIDENCE) { await mkdir(process.env.P9_EVIDENCE, { recursive: true }); await page.screenshot({ path: path.join(process.env.P9_EVIDENCE, 'settings.png') }); }
  await page.click('#setDocs');
  let url = '';
  for (let i = 0; i < 50 && !url; i++) { url = await readFile(opened, 'utf8').catch(() => ''); if (!url) await new Promise((r) => setTimeout(r, 100)); }
  assert.equal(url.trim(), DOCS_URL);
  // Check for updates (threat model row 28): updates are off in a source checkout, so Maintenance > Updates shows this
  // build's version and its Check now opens only the newest-release page.
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.match(await page.locator('#mtUpdText').innerText(), new RegExp('^You have P9 ' + version.replaceAll('.', '\\.') + '\\. '));
  await page.click('#mtUpdOpen');
  for (let i = 0; i < 50 && url.trim() !== RELEASES_URL; i++) { url = await readFile(opened, 'utf8').catch(() => ''); if (url.trim() !== RELEASES_URL) await new Promise((r) => setTimeout(r, 100)); }
  assert.equal(url.trim(), RELEASES_URL);
  // Settings → Pets: petdex.dev is a link and opens only that page.
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
  // The waiting approval was rejected by the lock; its bell row is gone. A new one: lock off first.
  await page.click('#setBtn'); await page.uncheck('#setLock'); await page.locator('#setLock:not(:checked)').waitFor(); await page.click('#setClose');
  await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'permission' }).catch(() => {});
  await page.click('#rBell'); await page.locator('#mdlBody .mlist [data-i]', { hasText: 'needs you' }).click({ timeout: 15000 });
  if (await page.locator('#mdlBody .mlist button').count()) await page.locator('#mdlBody .mlist button').first().click();
  await page.locator('#mdlBody textarea').fill('sent from the bell');
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
  assert.deepEqual(kept, { zoom: 1.2, closeOnSend: true, focus: { chat: true, dev: true, mission: false }, pet: DEFAULT_PETS, name: kept.name, xfer: { fileMiB: 512, files: 20000, sendGiB: 4 } });
  assert.deepEqual(await page.evaluate(() => window.p9.listPets().then((l) => l.pets)), [], 'a removed Skipper is not put back');
  // Phase 18 review: saves in flight together (Ctrl = held down) all succeed, and the file ends on the last one.
  const saves = await page.evaluate((pet) => Promise.allSettled(Array.from({ length: 20 }, (_, i) =>
    window.p9.setSettings({ zoom: 1 + (i + 1) / 100, closeOnSend: true, focus: { chat: true, dev: true, mission: false }, pet, name: '', xfer: { fileMiB: 512, files: 20000, sendGiB: 4 } }))), PETS);
  assert.deepEqual(saves.map((s) => s.status), Array(20).fill('fulfilled'));
  assert.equal(JSON.parse(await readFile(file, 'utf8')).zoom, 1.2);
  assert.equal(await zoomOf(app), 1.2);
  console.log('PASS settings: 41 bad IPC shapes refused, nothing written; zoom 1.2, close on send, Mission off, agent lock via the daemon, docs and Anymouse; all kept after a restart; 20 saves at once all kept in order');
});

test('Loosened modes: Full access and Bypass permissions warn in red first; Cancel keeps the old mode; "don\'t show again" and the last pick survive a restart (threat model row 25)', { timeout: 120000 }, async (t) => {
  // Codex Full access as used daily, Claude's bypass, a red warning with a "don't show again" button; installs start safe.
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
    await page.locator(`#nav .row[data-chat="${id}"]`).click();
    const pane = page.locator(`#chats .pane[data-id="${id}"]`);
    await pane.locator('[data-pill="Mode"]').waitFor();
    return pane;
  };
  let dlg = page.locator('#looseDlg');
  const mode = (pane) => pillOf(pane, 'Mode');
  // The dialog's close event runs a task after open turns false; give the pill up to 3 s to show the mode, then assert.
  const settled = async (pane, want, message) => {
    await mode(pane).evaluate((el, w) => new Promise((ok) => { const end = Date.now() + 3000; (function tick() { if (el.getAttribute('aria-label') === 'Mode: ' + w || Date.now() > end) ok(); else setTimeout(tick, 20); })(); }), want);
    assert.equal(await pillValue(pane, 'Mode'), want, message);
  };
  // After Turn on the picker already reads the new mode (the browser set it); the handler sets s.mode only once the dialog's
  // close task runs. Its localStorage write marks that, so the next prompt carries the new mode (GitHub run 39527149498).
  const applied = (agent, want) => page.waitForFunction(([a, w]) => localStorage.getItem('p9-mode:' + a) === w, [agent, want], { timeout: 5000 });
  // On a timeout the pane's text goes in the error: GitHub's runner missed one reply (2026-10-20) and nothing showed why.
  const said = async (pane, text, want) => { await pane.locator('.composer textarea').fill(text); await pane.locator('.composer textarea').press('Enter');
    try { await pane.locator('.msg.agent', { hasText: want }).waitFor({ timeout: 15000 }); }
    catch (error) { throw new Error(`no reply "${want}"; the pane shows:\n${(await pane.innerText().catch(() => '?')).slice(-1500)}`, { cause: error }); } };
  let codex = await chat('codex');
  assert.equal(await pillValue(codex, 'Mode'), 'Auto review', 'a new install starts Codex in Auto review');
  assert.deepEqual(await pillItems(page, codex, 'Mode'), ['Read-only', 'Workspace access', 'Auto review ✓', 'Full access', 'Plan']);
  await choose(page, codex, 'Mode', 'Full access');
  await dlg.waitFor();
  assert.match(await dlg.innerText(), /Turn on Full access for Codex\?[\s\S]*any file on this computer/);
  const red = await dlg.evaluate((d) => [getComputedStyle(d).borderTopColor, getComputedStyle(d).borderTopWidth]);
  const destructive = await page.evaluate(() => { const b = document.createElement('i'); b.style.color = 'var(--destructive)'; document.body.append(b); const c = getComputedStyle(b).color; b.remove(); return c; });
  assert.deepEqual(red, [destructive, '2px'], 'the warning is bordered in the theme\'s destructive red');
  if (process.env.P9_EVIDENCE) await page.screenshot({ path: path.join(process.env.P9_EVIDENCE, 'loose-warning.png') });
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  await settled(codex, 'Auto review', 'Cancel keeps the old mode');
  await said(codex, 'mode', 'mode:agent');
  await choose(page, codex, 'Mode', 'Full access'); await dlg.waitFor(); await page.keyboard.press('Escape'); await dlg.waitFor({ state: 'hidden' });
  await settled(codex, 'Auto review', 'Escape cancels too');
  await choose(page, codex, 'Mode', 'Full access'); await dlg.getByRole('button', { name: 'Turn on', exact: true }).click();
  await settled(codex, 'Full access', 'Turn on sets the mode');
  await applied('codex', 'Full access');
  await said(codex, 'mode', 'mode:agent-full-access');
  let claude = await chat('claude');
  assert.equal(await pillValue(claude, 'Mode'), 'Auto');
  await choose(page, claude, 'Mode', 'Bypass permissions');
  await dlg.getByRole('button', { name: 'Turn on, don\'t show again' }).click();
  await settled(claude, 'Bypass permissions', 'Turn on sets the mode');
  await applied('claude', 'Bypass permissions');
  await said(claude, 'mode', 'mode:bypassPermissions');
  await app.close();
  ({ app, page } = await launch()); dlg = page.locator('#looseDlg');
  codex = await chat('codex');
  // Review #2: "Turn on" was for that chat; a new one does not start in Full access without "don't show again".
  assert.equal(await pillValue(codex, 'Mode'), 'Auto review', 'a loosened last pick does not carry to a new chat after a plain Turn on');
  claude = await chat('claude');
  await choose(page, claude, 'Mode', 'Manual'); await choose(page, claude, 'Mode', 'Bypass permissions');
  await said(claude, 'mode', 'mode:bypassPermissions');
  assert.equal(await dlg.evaluate((d) => d.open), false, 'don\'t show again: no warning');
  codex = await chat('codex'); await choose(page, codex, 'Mode', 'Read-only'); await choose(page, codex, 'Mode', 'Full access');
  await dlg.waitFor(); await dlg.getByRole('button', { name: 'Cancel' }).click();
  await settled(codex, 'Read-only', 'Full access still warns: its own don\'t show again was never picked');
  console.log('PASS loosened modes: Codex starts in Auto review; Full access warns in red, Cancel and Escape keep Auto review, Turn on reaches the agent but does not carry to the next new chat; Claude bypass with don\'t show again skips the warning after a restart; Full access still warns');
});

test('D2: Settings > New chats start in sets each agent\'s starting mode; the loosened ones warn first; a chat\'s own pick leaves it (threat model row 25a)', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-d2-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#rChat').waitFor();
  const chat = async (provider) => {
    const id = (await call(instance, '/chat', 'POST', { provider })).conversation;
    await page.locator(`#nav .row[data-chat="${id}"]`).click();
    const pane = page.locator(`#chats .pane[data-id="${id}"]`);
    await pane.locator('[data-pill="Mode"]').waitFor();
    return pane;
  };
  const pick = page.locator('[data-default-mode="codex"]'), dlg = page.locator('#looseDlg');
  const settings = async () => { await page.click('#setBtn'); await page.locator('#setDlg[open]').waitFor(); await page.click('[data-set-page="Chat Focus"]'); };
  const closeSettings = async () => { await page.keyboard.press('Escape'); await page.locator('#setDlg').waitFor({ state: 'hidden', timeout: 5000 }); };
  const kept = () => page.evaluate(() => localStorage.getItem('p9-mode-default:codex'));
  await settings();
  assert.equal(await pick.inputValue(), '', 'a fresh install follows the last mode picked');
  assert.deepEqual(await pick.locator('option').allInnerTexts(), ['Last mode picked', 'Read-only', 'Workspace access', 'Auto review', 'Full access']);
  // Full access warns in red over Settings; Cancel puts "Last mode picked" back and keeps nothing.
  await pick.selectOption('Full access');
  await dlg.waitFor();
  assert.match(await dlg.innerText(), /Turn on Full access for Codex\?/);
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  await dlg.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.querySelector('[data-default-mode="codex"]').value === '', null, { timeout: 3000 });
  assert.equal(await kept(), null);
  await closeSettings();
  assert.equal(await pillValue(await chat('codex'), 'Mode'), 'Auto review', 'Cancel: a new chat still starts in Auto review');
  // Turn on: every new Codex chat starts in Full access, and a chat's own pick does not change that.
  await settings();
  await pick.selectOption('Full access');
  await dlg.getByRole('button', { name: 'Turn on', exact: true }).click();
  await page.waitForFunction(() => localStorage.getItem('p9-mode-default:codex') === 'Full access', null, { timeout: 3000 });
  await closeSettings();
  const first = await chat('codex');
  assert.equal(await pillValue(first, 'Mode'), 'Full access');
  await choose(page, first, 'Mode', 'Read-only');
  await page.waitForFunction(() => localStorage.getItem('p9-mode:codex') === 'Read-only', null, { timeout: 3000 });
  assert.equal(await pillValue(await chat('codex'), 'Mode'), 'Full access', 'a chat\'s own pick left the default alone');
  assert.equal(await pillValue(await chat('claude'), 'Mode'), 'Auto', 'Claude has its own default');
  // Back to "Last mode picked": the last pick (Read-only) wins again.
  await settings();
  await pick.selectOption('');
  assert.equal(await kept(), null);
  await closeSettings();
  assert.equal(await pillValue(await chat('codex'), 'Mode'), 'Read-only');
});

test('Security settings: one switch per restriction; Unrestricted mode asks once through File protection, turns them all off, new chats start loosened; off puts the defaults back (threat model row 66)', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-sec-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#rChat').waitFor();
  // main's native warning, answered by the test (file-protection.test.mjs does the same).
  const answers = (list) => app.evaluate(({ dialog }, list) => {
    globalThis.asked = [];
    dialog.showMessageBox = async (_window, options) => { globalThis.asked.push(options.title); return { response: list.shift() ?? 0 }; };
  }, list);
  const asked = () => app.evaluate(() => globalThis.asked);
  const boxes = () => page.$$eval('#setSecurity input[type=checkbox]:not(#setLinks)', (all) => Object.fromEntries(all.map((b) => [b.id, b.checked])));
  const settled = (want) => page.waitForFunction((want) => JSON.stringify([...document.querySelectorAll('#setSecurity input[type=checkbox]:not(#setLinks)')].map((b) => b.checked)) === want, JSON.stringify(want), { timeout: 5000 });
  const daemonSide = async () => [(await call(instance, '/agent-lock')).on, (await call(instance, '/file-protection')).on];
  const local = () => page.evaluate(() => ['p9-mode-ok:Full access', 'p9-mode-ok:Bypass permissions', 'p9-mode-default:codex', 'p9-mode-default:claude'].map((k) => localStorage.getItem(k)));
  await page.click('#setBtn'); await page.locator('#setDlg[open] #setFree').waitFor();
  assert.match(await page.locator('#setSecurity legend').first().innerText(), /^Security settings/);
  assert.deepEqual(await page.$$eval('#setSecurity strong', (s) => s.map((x) => x.textContent)), ['Agent lock', 'File protection', 'Warn before Full access and Bypass permissions', 'Ask before opening agent links', 'Unrestricted mode']);
  assert.deepEqual(await boxes(), { setLock: false, setProtect: true, setWarn: true, setFree: false }, 'the defaults are unchanged');
  assert.equal(await page.locator('#setLinks').isChecked(), true, 'agent links ask by default');
  // The warnings switch: off sets "don't show again" for both loosened modes on this computer, on clears it.
  await page.click('#setWarn'); await settled([false, true, false, false]);
  assert.deepEqual(await local(), ['1', '1', null, null]);
  await page.click('#setWarn'); await settled([false, true, true, false]);
  assert.deepEqual(await local(), [null, null, null, null]);
  // Unrestricted mode with the lock on: "Keep protection on" changes nothing at all.
  await page.click('#setLock'); await settled([true, true, true, false]);
  await answers([0]);
  await page.click('#setFree'); await settled([true, true, true, false]);
  assert.deepEqual([await asked(), await daemonSide(), await local()], [['Turn off file protection?'], [true, true], [null, null, null, null]]);
  // MC-4: a chat already open before Unrestricted is turned on (sample-free, idle) follows it on and back off.
  const open = (await call(instance, '/chat', 'POST', { provider: 'codex' })).conversation;
  await page.keyboard.press('Escape'); await page.locator('#setDlg').waitFor({ state: 'hidden', timeout: 5000 });
  await page.locator(`#nav .row[data-chat="${open}"]`).click();
  const openMode = page.locator(`#chats .pane[data-id="${open}"] [data-pill="Mode"]`);
  await openMode.waitFor(); assert.equal(await openMode.getAttribute('aria-label'), 'Mode: Auto review', 'the open chat starts in its own mode');
  await page.click('#setBtn'); await page.locator('#setDlg[open] #setFree').waitFor();
  // "Turn off protection": every restriction off, and new chats start in Full access and Bypass permissions.
  await answers([1]);
  await page.click('#setFree'); await settled([false, false, false, true]);
  assert.deepEqual([(await asked()).length, await daemonSide(), await local()], [1, [false, false], ['1', '1', 'Full access', 'Bypass permissions']]);
  assert.equal(await page.locator('[data-default-mode="codex"]').inputValue(), 'Full access', 'New chats start in shows it');
  assert.match(await page.locator('#setFree').evaluate((b) => b.closest('label').textContent), /chats already open switch too/, 'the switch says open chats follow');
  assert.equal(await openMode.getAttribute('aria-label'), 'Mode: Full access', 'MC-4: the chat already open switched too');
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT desktop-security-unrestricted ' + (await page.locator('#setDlg').screenshot()).toString('base64'));
  await page.keyboard.press('Escape'); await page.locator('#setDlg').waitFor({ state: 'hidden', timeout: 5000 });
  const id = (await call(instance, '/chat', 'POST', { provider: 'codex' })).conversation;
  await page.locator(`#nav .row[data-chat="${id}"]`).click();
  const mode = page.locator(`#chats .pane[data-id="${id}"] [data-pill="Mode"]`);
  await mode.waitFor();
  assert.equal(await mode.getAttribute('aria-label'), 'Mode: Full access');
  assert.equal(await page.locator('#looseDlg[open]').count(), 0, 'no red warning in Unrestricted mode');
  // Off: protection back on without asking, the warnings on, new chats in the agents' own modes; the lock stays off.
  await answers([]);
  await page.evaluate(() => localStorage.setItem('p9-link-ok', '1')); // review 3 L5: "don't ask again" was pressed meanwhile
  await page.click('#setBtn'); await page.locator('#setDlg[open] #setFree:checked').waitFor();
  await page.click('#setFree'); await settled([false, true, true, false]);
  assert.deepEqual([await asked(), await daemonSide(), await local()], [[], [false, true], [null, null, null, null]]);
  await page.keyboard.press('Escape'); await page.locator('#setDlg').waitFor({ state: 'hidden', timeout: 5000 });
  await page.locator(`#nav .row[data-chat="${open}"]`).click(); await openMode.waitFor();
  assert.equal(await openMode.getAttribute('aria-label'), 'Mode: Auto review', 'MC-4: off puts the open chat back in its start mode');
  await page.click('#setBtn'); await page.locator('#setDlg[open] #setFree').waitFor();
  assert.deepEqual([await page.evaluate(() => localStorage.getItem('p9-link-ok')), await page.locator('#setLinks').isChecked()], [null, true], 'off asks before agent links again');
  // Protection already off: no native warning comes, so Unrestricted asks once itself; Cancel changes nothing.
  await answers([1]); await page.click('#setProtect'); await settled([false, false, true, false]);
  // The page's confirm() is answered in the page: Playwright's dialog events in this Electron window are not reliable.
  await page.evaluate(() => { window.__confirms = []; window.confirm = (text) => { window.__confirms.push(text); return false; }; });
  await page.click('#setFree'); await settled([false, false, true, false]);
  const confirms = await page.evaluate(() => window.__confirms);
  assert.equal(confirms.length, 1); assert.match(confirms[0], /^Turn on Unrestricted mode\?/);
  assert.deepEqual([(await asked()).length, await daemonSide(), await local()], [1, [false, false], [null, null, null, null]]);
  console.log('PASS Security settings: four switches, defaults unchanged; Unrestricted Keep changes nothing, Turn off frees all and a new Codex chat starts in Full access; off restores; with protection already off it asks itself');
});

test('Pick: the workspace folder itself and a folder outside get their own refusals, in Settings and in the setup wizard (BL6)', { skip: process.platform === 'win32', timeout: 120000 }, async (t) => {
  // Starter settings on a folder with its own layout: Settings shows the files and the wizard offers its paths with Pick.
  const instance = await missionDaemon(t, true);
  await mkdir(path.join(instance.workspace, 'work/workspace-hub'), { recursive: true });
  await writeFile(path.join(instance.workspace, 'work/workspace-hub/registry.json'), '{"scripts":[],"apps":[],"pages":[]}');
  await rm(path.join(instance.workspace, 'mission'), { recursive: true });
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-pick-')), 'profile');
  const { app, page } = await launchOn(t, instance, profile);
  await page.click('#setBtn'); await page.click('[data-set-page="Mission Control"]');
  await page.locator('#setMission').waitFor({ timeout: 10000 });
  for (const [pick, text] of [[instance.workspace, 'That is the workspace folder itself.'], [instance.directory, 'That is outside the workspace.']]) {
    await pickNext(app, [pick]);
    await page.click('#setMission [data-mission-pick="waiting:setup-folder"]');
    await page.locator('#toasts', { hasText: text }).waitFor({ timeout: 5000 });
  }
  assert.equal(await page.locator('#setMission [data-mission="waiting"]').inputValue(), 'needs-you');
  await page.click('#setClose');
  const card = page.locator('#cards [data-key="welcome"]');
  await card.waitFor({ timeout: 10000 });
  await card.locator('.open').click();
  await page.locator('#welBody [data-path]').first().waitFor({ timeout: 10000 });
  for (const [pick, text] of [[instance.workspace, 'That is the workspace folder itself.'], [instance.directory, 'That is outside the workspace.']]) {
    await pickNext(app, [pick]);
    await page.click('#welBody [data-act="pick:waiting:setup-folder"]');
    await page.locator('#welBody .wiz-fail', { hasText: text }).waitFor({ timeout: 5000 });
  }
  console.log('PASS Pick: the root and outside are refused with their own words in Settings and the wizard');
});

const MISSION_FILES = { primary: 'AGENTS.md', registry: 'mission/registry.json', waiting: 'needs-you' };
const missionDaemon = (t, signedIn, args = []) => daemon(t, undefined, false, async ({ directory, workspace }) => {
  const file = path.join(directory, '.config', 'p9', 'settings.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(MISSION_FILES));
  await writeFile(path.join(workspace, 'AGENTS.md'), '# Top\n');
  await mkdir(path.join(workspace, 'mission')); await mkdir(path.join(workspace, 'needs-you')); await mkdir(path.join(workspace, 'inbox'));
  await writeFile(path.join(workspace, 'mission/registry.json'), '{"scripts":[],"apps":[],"pages":[]}');
  if (signedIn) { await mkdir(path.join(directory, '.claude'), { recursive: true }); await writeFile(path.join(directory, '.claude', '.credentials.json'), '{}'); }
  return { args: ['--acp-override', fake, ...args] };
});
const launchOn = async (t, instance, profile) => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#rChat').waitFor();
  return { app, page };
};
const pickNext = (app, filePaths) => app.evaluate(({ dialog }, filePaths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths }); }, filePaths);


