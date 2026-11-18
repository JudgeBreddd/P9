// settings-pages: split from test/settings.test.mjs (O120), by area — the Settings dialog's pages surfaces.
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


// MT1, HI1, ST3, ST4: Settings → Maintenance, the "i" on every row and the row order, through the desktop app. Main's
// confirm answers Cancel here, so Restart and Repair show they asked without stopping the test's daemon (the restart
// itself: maintenance.test.mjs).
test('Settings → Maintenance: each button and its Ctrl K entry does its job, every row\'s "i" opens its guide section, Rebuild only in a source checkout', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t);
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-maintenance-'));
  const opened = path.join(home, 'opened.txt'), built = path.join(home, 'built.txt'), browser = path.join(home, 'browser'), build = path.join(home, 'build');
  await writeFile(browser, '#!/bin/sh\nprintf "%s\\n" "$1" >> ' + opened + '\n');
  await writeFile(build, '#!/bin/sh\npwd >> ' + built + '\n');
  await chmod(browser, 0o755); await chmod(build, 0o755);
  const lines = async (file) => (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  const until = async (check, what) => {
    for (const end = Date.now() + 10000; !await check(); await new Promise((resolve) => setTimeout(resolve, 100))) if (Date.now() > end) throw new Error('timed out: ' + what);
  };
  const launch = async (extra = {}) => {
    const env = { ...process.env, P9_OPEN_URL: browser, P9_BUILD: build, ...extra }; delete env.ELECTRON_RUN_AS_NODE;
    const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + path.join(home, 'profile' + Object.keys(extra).length)], env, chromiumSandbox: true, timeout: 20000 });
    const proc = app.process();
    t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
    const page = await app.firstWindow();
    await page.locator('#rChat').waitFor();
    return { app, page };
  };
  const settingsOpen = async (page) => { await page.click('#setBtn'); await page.locator('#setDlg[open]').waitFor(); };
  const palette = async (page, label) => { await page.evaluate(() => document.querySelector('#palette').open && document.querySelector('#palette').close()); await page.keyboard.press('Control+k'); await page.fill('#palIn', label); return page.locator('#palList li[data-i]', { hasText: label }); };
  const ipc = (app, channel, ...args) => app.evaluate(({ ipcMain, BrowserWindow }, [channel, args]) => {
    const sender = BrowserWindow.getAllWindows()[0].webContents;
    return ipcMain._invokeHandlers.get(channel)({ sender, senderFrame: sender.mainFrame }, ...args).then(() => 'accepted', (error) => error.message);
  }, [channel, args]);
  const LABELS = ['Reload window', 'Refresh Mission', 'Restart daemon', 'Repair daemon service', 'Rebuild + reload'];

  const { app, page } = await launch();
  assert.equal(await page.evaluate(() => window.p9.source), true, 'a source checkout');
  await app.evaluate(({ dialog }) => { globalThis.asked = []; dialog.showMessageBox = async (_window, options) => { globalThis.asked.push(options.title); return { response: 0 }; }; });
  await settingsOpen(page);
  // ST3: Docs, Anymouse and Setup come first.
  assert.deepEqual(await page.evaluate(() => [...document.querySelector('#setBody .set-row').querySelectorAll('a,button:not(.info)')].map((b) => b.id)), ['setDocs', 'setAm', 'setWel']);
  // HI1: every top-level row, every group's legend and every Maintenance row has an "i" with a tip, and each opens a guide
  // section main allows and docs/guide.md has.
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#setBody > [data-page="General"] > .set-group:first-child > .set-row, #setBody legend, #setBody > [data-page="General"] > fieldset:last-child .set-row')]
    .filter((row) => !row.querySelector(':scope > .info[title]:not([title=""])')).map((row) => row.textContent.slice(0, 40))), []);
  const sections = await page.evaluate(() => [...new Set([...document.querySelectorAll('#setBody [data-docs]')].map((b) => b.dataset.docs))]);
  const allowed = JSON.parse(/GUIDE_SECTIONS = Object\.freeze\((\[[^\]]*\])\)/.exec(await readFile(path.join(root, 'apps/desktop/main.mjs'), 'utf8'))[1].replaceAll("'", '"'));
  const slugs = (await readFile(path.join(root, 'docs/guide.md'), 'utf8')).match(/^#{2,3} .*$/gm).map((h) => h.replace(/^#+ /, '').toLowerCase().replace(/[^\w\- ]/g, '').replaceAll(' ', '-'));
  assert.deepEqual(sections.filter((s) => !allowed.includes(s)), [], 'every "i" opens a section main allows');
  assert.deepEqual(allowed.filter((s) => !slugs.includes(s)), [], 'every allowed section is a heading in docs/guide.md');
  assert.deepEqual(['settings', 'maintenance', 'agent-lock', 'pets', 'focus-modes'].filter((s) => !sections.includes(s)), []);
  // A click on an "i" opens its section, and the checkbox in the same row stays as it was.
  const locked = await page.locator('#setLock').isChecked();
  await page.locator('#setLock').locator('xpath=..').locator('.info').click();
  await page.locator('#setBody > [data-page="General"] > fieldset:last-child legend .info').click();
  await until(async () => (await lines(opened)).length === 2, 'two guide sections opened');
  assert.deepEqual(await lines(opened), ['https://github.com/' + REPO + '/blob/main/docs/guide.md#agent-lock', 'https://github.com/' + REPO + '/blob/main/docs/guide.md#maintenance']);
  assert.equal(await page.locator('#setLock').isChecked(), locked);
  // ST4: petdex.dev looks like the link it is, as in the setup wizard.
  assert.deepEqual(await page.evaluate(() => {
    const probe = document.body.appendChild(document.createElement('span')), link = getComputedStyle(document.querySelector('#petdexLink'));
    probe.style.color = 'var(--primary)'; const primary = getComputedStyle(probe).color; probe.remove();
    return [link.textDecorationLine, link.color === primary];
  }), ['underline', true]);
  // MT1: the Updates row's Check now (the releases page in a source checkout), then the five buttons (maintenance.test.mjs has the row's states).
  assert.deepEqual(await page.locator('#setBody > [data-page="General"] > fieldset:last-child button:not(.info)').evaluateAll((b) => b.map((x) => x.textContent)), ['Check now', ...LABELS]);
  assert.deepEqual([await page.locator('#mtUpdOpen').isEnabled(), await page.locator('#setBody strong', { hasText: /^Updates$/ }).count()], [true, 1], 'updates off: one Updates row, its Check now opens the releases page');
  await page.locator('#setBody > [data-page="General"] > fieldset:last-child').scrollIntoViewIfNeeded();
  const png = await page.locator('#setDlg').screenshot({ type: 'png' });
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT settings-maintenance ' + png.toString('base64'));
  // The page's own refusals: a section not in the guide's list, a second argument, arguments where none are taken.
  assert.deepEqual([await ipc(app, 'p9:open-docs', 'nope'), await ipc(app, 'p9:open-docs', 'https://evil.example/'), await ipc(app, 'p9:open-docs', 'maintenance', 'x'),
    await ipc(app, 'p9:open-docs', ['maintenance']), await ipc(app, 'p9:rebuild', 1), await ipc(app, 'p9:repair-service', 'x'), await ipc(app, 'p9:restart-service', {})],
  Array(7).fill('ipc-sender-refused'));
  assert.equal((await lines(opened)).length, 2, 'nothing more opened');

  // Restart and Repair ask first (Cancel here), from the button and from Ctrl K.
  await page.click('#mtRestart'); await page.click('#mtRepair');
  await until(() => app.evaluate(() => globalThis.asked.length === 2), 'two confirms');
  await page.click('#setClose');
  await (await palette(page, 'Restart daemon')).click(); await (await palette(page, 'Repair daemon service')).click();
  await until(() => app.evaluate(() => globalThis.asked.length === 4), 'four confirms');
  assert.deepEqual(await app.evaluate(() => globalThis.asked), ['Restart P9?', 'Repair P9?', 'Restart P9?', 'Repair P9?']);
  // Refresh Mission reads Mission Control again and says what it found, from the button and from Ctrl K.
  // Counted as they appear: a notice fades out on its own.
  await page.evaluate(() => { window.refreshed = 0; new MutationObserver((changes) => changes.forEach((c) => c.addedNodes.forEach((n) => { if (n.querySelector?.('.sub')?.textContent === 'mission') window.refreshed++; }))).observe(document.querySelector('#toasts'), { childList: true }); });
  const missionToasts = () => page.evaluate(() => window.refreshed);
  await settingsOpen(page); await page.click('#mtMission');
  await until(async () => await missionToasts() === 1, 'a Refresh Mission notice');
  await page.click('#setClose');
  await (await palette(page, 'Refresh Mission')).click();
  await until(async () => await missionToasts() === 2, 'a second Refresh Mission notice');
  // Reload window loads the page again, from the button and from Ctrl K.
  const reloads = async (go) => { await page.evaluate(() => { window.before = true; }); await Promise.all([page.waitForEvent('load', { timeout: 20000 }), go()]); await page.locator('#rChat').waitFor(); assert.equal(await page.evaluate(() => window.before), undefined); };
  await settingsOpen(page); await reloads(() => page.click('#mtReload'));
  await reloads(async () => (await palette(page, 'Reload window')).click());
  // Rebuild + reload runs the build in this checkout, then loads the window again.
  await settingsOpen(page); await reloads(() => page.click('#mtRebuild'));
  await reloads(async () => (await palette(page, 'Rebuild + reload')).click());
  assert.deepEqual((await lines(built)).map((dir) => path.resolve(dir)), [path.resolve(root), path.resolve(root)]);

  // A packaged build: no Rebuild button, no Ctrl K entry, and main refuses it.
  const packaged = await launch({ P9_PACKAGED: '1' });
  assert.equal(await packaged.page.evaluate(() => window.p9.source), false);
  await settingsOpen(packaged.page);
  assert.deepEqual(await packaged.page.locator('#setBody > [data-page="General"] > fieldset:last-child button:not(.info)').evaluateAll((b) => b.map((x) => x.textContent)), ['Check now', ...LABELS.slice(0, 4)]);
  await packaged.page.click('#setClose');
  assert.equal(await (await palette(packaged.page, 'Rebuild')).count(), 0);
  assert.equal(await (await palette(packaged.page, 'Restart daemon')).count(), 1);
  await packaged.page.keyboard.press('Escape');
  assert.equal(await ipc(packaged.app, 'p9:rebuild'), 'ipc-sender-refused');
  assert.equal((await lines(built)).length, 2, 'nothing built');
});

test('Settings → Mission Control files: rows save to settings.json and survive a restart; refused values stay with the reason (ST1, ST2)', { skip: process.platform === 'win32', timeout: 180000 }, async (t) => {
  const instance = await missionDaemon(t, true);
  const file = path.join(instance.directory, '.config', 'p9', 'settings.json'), notes = path.join(instance.directory, 'notes');
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-mission-files-')), 'profile');
  let { app, page } = await launchOn(t, instance, profile);
  const keys = ['primary', 'registry', 'waiting', 'scripts_root', 'space', 'page_schemes', 'notes_roots'], above = path.dirname(instance.workspace);
  const boxes = () => page.locator('#setMission [data-mission]').evaluateAll((all) => all.map((box) => [box.dataset.mission, box.value]));
  const disk = async () => JSON.parse(await readFile(file, 'utf8'));
  const until = async (check, what) => {
    for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 100)); }
    throw new Error('timed out: ' + what);
  };
  const set = async (key, value) => {
    const box = page.locator('#setMission [data-mission="' + key + '"]');
    await box.fill(value); await box.dispatchEvent('change');
  };
  await page.click('#setBtn'); await page.click('[data-set-page="Mission Control"]');
  await page.locator('#setMission').waitFor({ timeout: 10000 });
  assert.deepEqual(await boxes(), keys.map((key) => [key, MISSION_FILES[key] ?? '']));
  // Each row has the "i" that opens its guide section, and every path row but scripts_root (a full path) has Pick.
  assert.equal(await page.locator('#setMission [data-docs="mission-control-files"]').count(), keys.length + 1);
  assert.deepEqual(await page.locator('#setMission [data-mission-pick]').evaluateAll((all) => all.map((b) => b.dataset.missionPick.split(':')[0])),
    ['primary', 'registry', 'waiting', 'space']);

  // ST1: each row saves on change; the file is what parseSettings accepts.
  await set('scripts_root', above);
  await set('page_schemes', 'obsidian, zotero');
  await set('notes_roots', 'vault = ' + notes);
  const want = { ...MISSION_FILES, scripts_root: above, page_schemes: ['obsidian', 'zotero'], notes_roots: { vault: notes } };
  await until(async () => JSON.stringify(await disk()) === JSON.stringify(want), 'three rows saved');
  // A value the daemon refuses stays in its box with the reason under it, and the file is left alone.
  await set('scripts_root', 'relative/dir');
  const hostErr = page.locator('#setMission [data-mission="scripts_root"] ~ [data-mission-err]');
  await hostErr.filter({ hasText: 'Not saved: scripts_root:' }).waitFor({ timeout: 5000 });
  assert.equal(await page.locator('#setMission [data-mission="scripts_root"]').inputValue(), 'relative/dir');
  assert.equal(await page.locator('#setMission [data-mission="scripts_root"]').getAttribute('aria-invalid'), 'true');
  assert.deepEqual(await disk(), want);
  // ST2: the wizard's paths, by Pick and by typing.
  await pickNext(app, [path.join(instance.workspace, 'inbox')]);
  await page.click('#setMission [data-mission-pick="waiting:setup-folder"]');
  await until(async () => (await disk()).waiting === 'inbox', 'waiting picked');
  assert.equal(await page.locator('#setMission [data-mission="waiting"]').inputValue(), 'inbox');
  await set('primary', 'needs-you/AGENTS.md');
  await until(async () => (await disk()).primary === 'needs-you/AGENTS.md', 'primary typed');
  assert.deepEqual(JSON.parse(await readFile(file + '.bak', 'utf8')), { ...want, waiting: 'inbox' }, 'the file before the last save');
  await page.locator('#setMission').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  // Plain-words tips: the owner's sentence for primary, and a long path shows its end with the whole path on hover.
  const primaryTip = await page.locator('#setMission [data-mission="primary"] ~ .info').getAttribute('title');
  assert.equal(primaryTip, 'Folder of your main project, or a file that names it (for the Mission Control Main Project card and the Chat Focus Files pane)');
  const long = 'personal-projects/workspace-hub/some/long/folder/that/shares/its/start/with/the/rest/registry.json';
  const end = await page.locator('#setMission [data-mission="registry"]').evaluate((box, value) => {
    box.value = value; box.dispatchEvent(new Event('blur'));
    return [box.title, box.scrollLeft > 0, box.scrollLeft + box.clientWidth >= box.scrollWidth - 1];
  }, long);
  assert.deepEqual(end, [long, true, true], 'the box shows the end of the path, the hover shows all of it');
  // A native hover tip is not in a page screenshot: draw the primary tip next to its i for the shot.
  await page.locator('#setMission [data-mission="primary"] ~ .info').evaluate((i) => {
    const t = document.createElement('div'); t.textContent = i.title; const r = i.getBoundingClientRect();
    t.style.cssText = `position:fixed;z-index:99;max-width:260px;padding:6px 8px;background:#222;color:#fff;border:1px solid #888;font:12px sans-serif;left:${Math.max(8, r.left - 270)}px;top:${r.bottom + 4}px`;
    t.dataset.tipShot = ''; i.closest('dialog, #setDlg').append(t);
  });
  const png = await page.locator('#setDlg').screenshot({ type: 'png' });
  await page.locator('[data-tip-shot]').evaluate((t) => t.remove());
  if (process.env.P9_EVIDENCE) { await mkdir(process.env.P9_EVIDENCE, { recursive: true }); await writeFile(path.join(process.env.P9_EVIDENCE, 'settings-mission-files.png'), png); }
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT settings-mission-files ' + png.toString('base64'));
  // One label column and one input column: every box starts at the same x and is as wide as the others.
  const edges = await page.locator('#setMission [data-mission]').evaluateAll((all) => all.map((box) => { const r = box.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.width)]; }));
  assert.deepEqual(edges, edges.map(() => edges[0]), 'aligned boxes');
  // A good value clears the reason.
  await set('scripts_root', above);
  await until(async () => !(await hostErr.count()), 'the reason cleared');
  assert.equal(await page.locator('#setMission [data-mission="scripts_root"]').getAttribute('aria-invalid'), null);
  assert.deepEqual(await disk(), { ...want, waiting: 'inbox', primary: 'needs-you/AGENTS.md' });

  // A restart reads them back from the daemon's file.
  await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]);
  ({ app, page } = await launchOn(t, instance, profile));
  await page.click('#setBtn'); await page.click('[data-set-page="Mission Control"]');
  await page.locator('#setMission').waitFor({ timeout: 10000 });
  const saved = { ...want, waiting: 'inbox', primary: 'needs-you/AGENTS.md' };
  assert.deepEqual(await boxes(), keys.map((key) => [key, { page_schemes: 'obsidian, zotero', notes_roots: 'vault = ' + notes }[key] ?? saved[key] ?? '']));
  // Emptying an optional row removes its key.
  await set('scripts_root', '');
  await until(async () => !('scripts_root' in await disk()), 'scripts_root removed');
  console.log('PASS Settings → Mission Control files: rows save and survive a restart, refused values stay with the reason');
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


