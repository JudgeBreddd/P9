import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, root } from './helpers.mjs';
import { PARTS, partOrder } from '../packages/protocol/index.mjs';

// Mission M2 on the desktop: an owner's Mission rebuilt as a space (folder lists and references) beside the built-in tiles.
const shot = (name, png) => { if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png.toString('base64')); };
const SETTINGS = { primary: 'projects/AGENTS.md', registry: 'hub/registry.json', waiting: '_waiting', space: 'hub/space.json' };
const SPACE = { sections: [
  { title: 'Needs you', text: 'Questions waiting on you, newest first.', folders: [{ id: 'needs-you', title: 'Waiting on you', path: '_waiting', pattern: '*-*.md' }] },
  { title: 'Ideas', folders: [{ id: 'needs-done', title: 'Needs done', path: '_ideas/needs-done', pattern: '*.md' }, { id: 'ideas', title: 'Ideas', path: '_ideas', pattern: '*-*.md' }] },
  { title: 'Handoffs', folders: [{ id: 'handoffs', title: 'Open handoffs', path: 'projects', pattern: 'HANDOFF.md', recursive: true, match: 'Status: open' }] },
  { title: 'Daily', refs: ['continuity', 'doctor', 'heartbeats', 'weekly-usage'] },
  { title: 'Launch', refs: ['claude-code', 'obsidian', 'dashboard', 'retired-tool'] }] };
const script = (id, title) => ({ id, title, group: 'Workspace', cmd: ['true'] });

async function seed({ directory, workspace }, space = SPACE) {
  for (const folder of ['projects/alpha', 'projects/beta', 'projects/gamma', 'hub', '_waiting', '_ideas/needs-done']) await mkdir(path.join(workspace, folder), { recursive: true });
  await writeFile(path.join(workspace, 'projects/AGENTS.md'), '# Projects\n\n**Main project: Alpha** (`alpha/`)\n');
  await writeFile(path.join(workspace, SETTINGS.registry), JSON.stringify({
    scripts: [script('continuity', 'Continuity'), script('doctor', 'Doctor'), script('heartbeats', 'Heartbeats'), script('weekly-usage', 'Weekly usage')],
    apps: [{ id: 'claude-code', title: 'Claude Code', cmd: ['true'] }, { id: 'obsidian', title: 'Obsidian', cmd: ['true'] }],
    pages: [{ id: 'dashboard', title: 'Dashboard', url: 'https://example.com' }] }));
  await writeFile(path.join(workspace, SETTINGS.space), JSON.stringify(space, null, 2) + '\n');
  const files = { '_waiting/pick-a-host.md': '# Pick a host\n\nA.\n', '_waiting/review-plan.md': '# Review the plan\n\nA.\n', '_waiting/AGENTS.md': '# Rules\n',
    '_ideas/needs-done/live-usage.md': '# Live usage\n', '_ideas/memory-idea.md': '# Memory\n', '_ideas/AGENTS.md': '# Rules\n',
    'projects/alpha/HANDOFF.md': '# Alpha\nStatus: open\n\nThe next step is the folder tile.\n', 'projects/beta/HANDOFF.md': '# Beta\nStatus: open\n', 'projects/gamma/HANDOFF.md': '# Gamma\nStatus: done\n' };
  let minute = 0;
  for (const [name, text] of Object.entries(files)) {
    await writeFile(path.join(workspace, name), text);
    const when = new Date(Date.now() - (60 - (minute += 5)) * 60000);
    await utimes(path.join(workspace, name), when, when);
  }
  await writeFile(path.join(directory, 'settings.json'), JSON.stringify(SETTINGS));
  return { args: ['--settings', path.join(directory, 'settings.json')] };
}

test('Mission space on the desktop: folder lists with counts open files read-only; references draw, a missing one says not found', { timeout: 150000 }, async (t) => {
  const instance = await daemon(t, undefined, false, seed);
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-space-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#dataNote', { hasText: 'Chat live' }).waitFor({ timeout: 20000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 900));
  await page.click('#rMission');
  await page.locator('#fMission [data-group="Launch"]').waitFor({ timeout: 20000 });
  // Backward compatible (W-D): a space naming no built-in tile draws the same top row as before wave 2.
  assert.deepEqual(await page.locator('#fMission .tiles > button b').allInnerTexts(), ['Workspace', 'Needs you', 'Ideas', 'Handoffs', 'Daily', 'Launch', '+ New idea', 'Edit names and icons']);
  const section = async (title) => { await page.click(`#fMission [data-group="${title}"]`); await page.locator('#mdl[open] #mdlBody .mlist').waitFor({ timeout: 10000 }); };
  const close = async () => { await page.keyboard.press('Escape'); await page.locator('#mdl[open]').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {}); };

  for (const theme of ['event-horizon-prime', 'daylight']) {
    await page.click('#themeBtn'); await page.click(`[data-theme-pick="${theme}"]`); await page.keyboard.press('Escape');
    await page.mouse.move(0, 0);
    await page.waitForFunction((dark) => document.documentElement.classList.contains('dark') === dark, theme !== 'daylight', { timeout: 5000 });
    shot('mission-space-' + theme, await page.screenshot({ animations: 'disabled' }));

    // A section of references only is not an empty tile: it counts every row it opens.
    assert.equal(await page.locator('#fMission [data-group="Launch"] .n').innerText(), '4');
    await section('Launch');
    assert.equal(await page.locator('#mdlT').innerText(), 'Launch · 4 items');
    const refs = await page.locator('#mdlBody .mlist li button').evaluateAll((all) => all.map((b) => b.innerText.replace(/\s+/g, ' ').trim()));
    assert.deepEqual(refs, ['APP Claude Code', 'APP Obsidian', 'LINK Dashboard', 'REF retired-tool not found']);
    assert.equal(await page.locator('#mdlBody [data-ref-missing]').isDisabled(), true);
    shot('mission-space-refs-' + theme, await page.screenshot({ animations: 'disabled' }));
    await close();

    await section('Handoffs');
    await page.locator('#mdlBody [data-folder] [data-count]', { hasText: '2' }).waitFor({ timeout: 10000 });
    await page.click('#mdlBody [data-folder]');
    await page.locator('#mdlFoot [data-folder-count]', { hasText: '2 files' }).waitFor({ timeout: 10000 });
    assert.deepEqual(await page.locator('#mdlBody .mlist li button').evaluateAll((all) => all.map((b) => b.querySelector('.truncate').innerText)), ['beta/HANDOFF.md', 'alpha/HANDOFF.md']);
    shot('mission-space-folder-' + theme, await page.screenshot({ animations: 'disabled' }));
    await page.locator('#mdlBody .mlist li button').last().click();
    await page.locator('#mdlBody pre.out', { hasText: 'The next step is the folder tile.' }).waitFor({ timeout: 10000 });
    assert.equal(await page.locator('#mdlBody textarea, #mdlBody [contenteditable="true"]').count(), 0, 'the file view is read-only');
    await close();
  }
  console.log('PASS mission space desktop: refs 3 drawn + not found; Handoffs count 2, list newest first, file opens read-only; both themes');
});

// A section's order field: named parts first, the rest in PARTS order; unknown and repeated names are ignored.
test('partOrder: named parts lead, the rest follow in the default order, unknown and repeated names ignored', () => {
  assert.deepEqual(partOrder(undefined), PARTS);
  assert.deepEqual(partOrder(['cards', 'nope', 'cards', 'folders']), ['cards', 'folders', ...PARTS.filter((part) => part !== 'cards' && part !== 'folders')]);
  assert.deepEqual(partOrder(['links', 'text'], ['text', 'notes', 'links']), ['links', 'text', 'notes']);
  assert.deepEqual(partOrder('cards'), PARTS);
});

// Wave 1 shape fields on the desktop: order moves a section's parts, widgets draws a P9 panel inside a section's window,
// and only frame false drops a tile's own box (a tile titled like its section keeps it now).
const SHAPE = { sections: [
  { title: 'Reviews', place: 'col1', order: ['data', 'folders'], folders: [{ id: 'ideas', title: 'Ideas', path: '_ideas', pattern: '*-*.md' }],
    buttons: [{ id: 'rev-up', title: 'Rev up', cmd: ['true'] }], data: [{ id: 'rev-tile', title: 'Reviews', script: 'doctor', frame: false }] },
  { title: 'Plain', place: 'col2', folders: [{ id: 'plain-ideas', title: 'Ideas', path: '_ideas', pattern: '*-*.md' }], data: [{ id: 'plain-tile', title: 'Plain', script: 'doctor' }] },
  { title: 'Logs and incidents', order: ['widgets'], widgets: ['notifications'], buttons: [{ id: 'logs-up', title: 'Logs up', cmd: ['true'] }],
    data: [{ id: 'logs-tile', title: 'Logs and incidents', script: 'heartbeats' }, { id: 'silent', title: 'Silent jobs', script: 'weekly-usage', frame: false }] }] };

test('Mission shape fields on the desktop: order moves parts, widgets draws Notifications in a tile section window, frame false alone drops a frame', { timeout: 150000 }, async (t) => {
  const instance = await daemon(t, undefined, false, (dirs) => seed(dirs, SHAPE));
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-shape-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#dataNote', { hasText: 'Chat live' }).waitFor({ timeout: 20000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 900));
  await page.click('#rMission');
  const boxes = (at) => page.locator(at).evaluate((el) => [...el.children].map((child) => child.className));
  await page.locator('#fMission [data-sec="Reviews"] .pscroll .dtiles').waitFor({ timeout: 20000 });
  await page.locator('#fMission [data-sec="Plain"] .pscroll .dtiles').waitFor({ timeout: 20000 });
  shot('mission-shape-page', await page.screenshot({ animations: 'disabled' }));
  assert.deepEqual(await boxes('#fMission [data-sec="Reviews"] .pscroll'), ['dtiles', 'mlist'], 'order data, folders: the tile above the rows');
  assert.deepEqual(await boxes('#fMission [data-sec="Plain"] .pscroll'), ['mlist', 'dtiles'], 'no order: rows, then tiles, as before');
  assert.equal(await page.locator('#fMission [data-tile="rev-tile"][data-noframe]').count(), 1);
  assert.equal(await page.locator('#fMission [data-tile="plain-tile"][data-noframe]').count(), 0, 'a tile titled like its section keeps its frame without frame false');
  assert.equal(await page.locator('#fMission .wdg').count(), 0, 'a widgets panel draws only in its own section');

  await page.click('#fMission [data-group="Logs and incidents"]');
  await page.locator('#mdl[open] #mdlBody .wdg[data-widget="notifications"] .wbody > *').waitFor({ timeout: 10000 });
  shot('mission-shape-window', await page.screenshot({ animations: 'disabled' }));
  assert.deepEqual(await boxes('#mdlBody'), ['wdgs', 'mlist', 'dtiles'], 'order widgets: the panel first, then the rows and tiles');
  assert.equal(await page.locator('#mdlBody .wdg h3').textContent(), 'Notifications');
  assert.deepEqual([await page.locator('#mdlBody [data-tile="logs-tile"][data-noframe]').count(), await page.locator('#mdlBody [data-tile="silent"][data-noframe]').count()], [0, 1]);
  console.log('PASS mission shape desktop: order data,folders drew tiles above rows; default rows then tiles; Notifications inside the tile window first; frame false on 2 tiles only');
});

// Wave 2 on the desktop: two sections titled alike both draw and each opens its own buttons (W-C); a space button with its own group
// stays in its section (W-J); the top row follows the file and the file names the built-in tiles (W-D); the sprint window runs its
// section's buttons and refs (W-M); the fixed layout's boxes follow the file within a column (W-H); and the edit form patches a
// section's fields and moves it (W-N).
const WAVE2 = { sections: [
  { id: 'tools-a', title: 'Tools', buttons: [{ id: 'a-up', title: 'A up', group: 'Custom', cmd: ['true'] }] },
  { id: 'sprints', title: 'Sprints', widget: 'sprint', refs: ['doctor'], buttons: [{ id: 'go-sprint', title: 'Go sprint', cmd: ['true'] }] },
  { id: 'tools-b', title: 'Tools', buttons: [{ id: 'b-up', title: 'B up', cmd: ['true'] }] },
  { id: 'capture', title: 'Capture', widget: 'idea' },
  { id: 'daily', title: 'Daily', refs: ['continuity'], widgets: ['edit'] },
  { id: 'use', title: 'Use', widget: 'usage' },
  { id: 'main', title: 'Main', widget: 'primary' }] };

test('Mission wave 2 on the desktop: repeated titles, file order and named built-in tiles, the sprint section\'s buttons, the Fields editor and moves', { timeout: 150000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async (dirs) => {
    const status = path.join(dirs.directory, '.local', 'state', 'sprint', 'status.json');
    await mkdir(path.dirname(status), { recursive: true });
    await writeFile(status, JSON.stringify({ sprint: 'Test sprint', updatedAt: '2026-10-27T14:30:00-05:00', chunks: [{ id: 'c1', title: 'One', state: 'merged', percent: 100 }] }));
    return seed(dirs, WAVE2);
  });
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-wave2-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#dataNote', { hasText: 'Chat live' }).waitFor({ timeout: 20000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 900));
  await page.click('#rMission');
  await page.locator('#fMission [data-sprint="sprints"]').waitFor({ timeout: 20000 });
  const close = async () => { await page.keyboard.press('Escape'); await page.locator('#mdl[open]').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {}); };
  const rows = () => page.locator('#mdlBody .mlist li button').evaluateAll((all) => all.map((b) => b.innerText.replace(/\s+/g, ' ').trim()));
  shot('mission-wave2-top', await page.screenshot({ animations: 'disabled' }));
  assert.deepEqual(await page.locator('#fMission .tiles > button b').allInnerTexts(), ['Workspace', 'Tools', 'Sprints', 'Tools', 'Capture', 'Daily'],
    'the registry group, then the file order; the named built-ins under their sections\' titles; edit is named only inside Daily, so no edit tile');
  for (const [key, own, other] of [['tools-a', 'A up', 'B up'], ['tools-b', 'B up', 'A up']]) {
    await page.click(`#fMission .tiles [data-key="${key}"]`);
    await page.locator('#mdl[open] #mdlBody .mlist').waitFor({ timeout: 10000 });
    const drawn = await rows();
    assert.ok(drawn.some((row) => row.includes(own)) && !drawn.some((row) => row.includes(other)), key + ': ' + drawn.join(' | '));
    await close();
  }
  assert.equal(await page.locator('#fMission .tiles [data-group="Custom"]').count(), 0, 'a-up keeps group Custom but draws in its section');
  await page.click('#fMission [data-sprint="sprints"]');
  await page.locator('#mdl[open] #mdlFoot [data-sprint-run]').first().waitFor({ timeout: 10000 });
  shot('mission-wave2-sprint', await page.screenshot({ animations: 'disabled' }));
  assert.deepEqual(await page.locator('#mdlFoot [data-sprint-run]').allInnerTexts(), ['Go sprint', 'Doctor'], 'the section\'s button, then its script ref');
  await close();
  const boxes = await page.locator('#fMission .mcol:has([data-panel="musage"])').evaluate((el) => [...el.children].map((c) => c.dataset.panel || c.dataset.card));
  assert.deepEqual(boxes, ['musage', 'mprimary'], 'Use comes before Main in the file');

  // The edit form, opened from Daily's own edit widget: Fields saves a changed field; down moves a section in the file.
  await page.click('#fMission .tiles [data-key="daily"]');
  await page.click('#mdl[open] #mdlBody [data-widget="edit"] [data-wopen]');
  await page.locator('#mdlBody [data-medit] [data-row]').first().waitFor({ timeout: 10000 });
  const row = (title) => page.locator('#mdlBody [data-row]').filter({ has: page.locator(`[data-t][value="${title}"]`) });
  await row('Capture').locator('[data-fields]').click();
  const json = page.locator('#mdlBody [data-fields-row] [data-json]');
  assert.deepEqual(JSON.parse(await json.inputValue()), { id: 'capture', title: 'Capture', widget: 'idea' });
  await json.fill(JSON.stringify({ id: 'capture', title: 'Capture', widget: 'idea', text: 'From the field editor' }));
  shot('mission-wave2-fields', await page.screenshot({ animations: 'disabled' }));
  await page.click('#mdlBody [data-save-fields]'); // File protection is on: the first press arms, the second saves
  await page.locator('#mdlBody [data-save-fields]', { hasText: 'Confirm save' }).click();
  const space = () => readFile(path.join(instance.workspace, SETTINGS.space), 'utf8').then((text) => JSON.parse(text).sections);
  const settle = async (done) => { for (let i = 0; i < 50 && !done(await space()); i += 1) await new Promise((resolve) => setTimeout(resolve, 100)); return space(); };
  assert.equal((await settle((all) => all[3].text)).find((s) => s.id === 'capture').text, 'From the field editor');
  await page.locator('#mdlBody [data-medit] [data-row]').first().waitFor({ timeout: 10000 });
  await row('Tools').first().locator('[data-down]').click();
  await page.locator('#mdlBody [data-row] [data-msg]', { hasText: 'Press Confirm save' }).waitFor({ timeout: 5000 });
  await row('Tools').first().locator('[data-down]').click();
  assert.deepEqual((await settle((all) => all[0].id !== 'tools-a')).map((s) => s.id).slice(0, 3), ['sprints', 'tools-a', 'tools-b']);
  await page.locator('#mdlBody [data-medit] [data-row]').first().waitFor({ timeout: 10000 });
  shot('mission-wave2-editor', await page.screenshot({ animations: 'disabled' }));
  console.log('PASS mission wave 2 desktop: top row in file order with named built-ins, two Tools each with its own button, sprint ran Go sprint + Doctor, Use before Main, Fields saved text, down moved tools-a');
});
