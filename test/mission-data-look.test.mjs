// Mission M3 on screen: each tile shape, a bad shape, one tile still asking, and a link; desktop in a dark and a light
// theme, and the phone at 390x844. The shots are evidence; the asserts check that each tile drew.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, _electron } from '@playwright/test';
import { remoteDaemon, passkeyDevice, enrollDevice, root, versionSeen } from './helpers.mjs';
import { dataShape } from '../apps/server/mission-fields.mjs';

const node = process.execPath;
const print = (value) => [node, '-e', `process.stdout.write(${JSON.stringify(JSON.stringify(value))})`];
const SCRIPTS = [
  { id: 'stat', title: 'Count', cmd: print({ type: 'stat', value: 12, label: 'Inbox', unit: 'notes' }) },
  { id: 'list', title: 'Recent', cmd: print({ type: 'list', rows: [{ title: 'Plan', subtitle: '2 h ago', link: 'https://example.com/plan', badge: 3 }, { title: 'Notes', subtitle: 'yesterday' }] }) },
  { id: 'table', title: 'Services', cmd: print({ type: 'table', columns: ['Name', 'State'], rows: [['web', 'up'], ['db', 'down']] }) },
  { id: 'rings', title: 'Disks', cmd: print({ type: 'rings', rings: [{ label: 'Root', percent: 42 }, { label: 'Data', percent: 87.4 }] }) },
  { id: 'pie', title: 'Pie', cmd: print({ type: 'pie', slices: [1] }) },
  { id: 'ask', title: 'Weather', cmd: print({ type: 'stat', value: 18 }) },
];
const ALLOWED = ['stat', 'list', 'table', 'rings', 'pie'];
const SPACE = { sections: [{ id: 'home', title: 'Home', text: 'Tiles and links.', data: SCRIPTS.map((s) => ({ id: 'tile-' + s.id, title: s.title, script: s.id })),
  links: [{ id: 'docs', title: 'Docs', url: 'https://example.com/docs' }] }] };

async function setup(paths) {
  const w = paths.workspace;
  for (const folder of ['hub', 'projects/event-horizon', '_waiting']) await mkdir(path.join(w, folder), { recursive: true });
  await writeFile(path.join(w, 'hub/registry.json'), JSON.stringify({ scripts: SCRIPTS, apps: [], pages: [] }));
  await writeFile(path.join(w, 'projects/AGENTS.md'), '# Projects\n\n**Main project: P9 — Event Horizon** (`event-horizon/`)\n');
  await writeFile(path.join(w, 'projects/event-horizon/AGENTS.md'), '# P9\n\n**Status:** **Open**\n');
  await writeFile(path.join(w, 'hub/space.json'), JSON.stringify(SPACE));
  const settings = { primary: 'projects/AGENTS.md', registry: 'hub/registry.json', waiting: '_waiting', space: 'hub/space.json' };
  await writeFile(path.join(paths.directory, 'settings.json'), JSON.stringify(settings));
  return { args: ['--settings', path.join(paths.directory, 'settings.json')] };
}
const shot = (name, png) => { if (process.env.CI !== 'true') console.log('P9_SHOT ' + name + ' ' + png.toString('base64')); };
const settled = (page) => page.evaluate(() => Promise.allSettled(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished)));

test('M3 look: tile shapes, a bad shape, Allow and a link on desktop (dark, light) and phone', { timeout: 150000 }, async (t) => {
  const server = await remoteDaemon(t, { setup });
  for (const id of ALLOWED) assert.equal((await server.desk('/mission/data/allow', 'POST', { id: 'tile-' + id })).status, 200);

  const profile = path.join(server.directory, 'electron-profile');
  await mkdir(profile); await versionSeen(profile);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', server.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.click('#rMission');
  for (const theme of ['event-horizon-prime', 'daylight']) {
    await page.click('#themeBtn'); await page.click('[data-theme-pick="' + theme + '"]'); await page.keyboard.press('Escape');
    await page.click('#fMission [data-group="Home"]');
    await page.locator('#mdlBody .tile-rings figure').first().waitFor({ timeout: 15000 });
    await page.locator('#mdlBody .tile-printed').waitFor({ timeout: 15000 });
    // The title counts tiles and links too (it said "Home · 0 scripts" for a section of only tiles).
    assert.equal(await page.locator('#mdlT').innerText(), 'Home · 7 items');
    const body = await page.locator('#mdlBody').innerText();
    assert.match(body, /12[\s\S]*notes[\s\S]*Plan[\s\S]*web[\s\S]*down[\s\S]*Root[\s\S]*Allow[\s\S]*Docs/);
    await settled(page);
    shot('m3-desktop-' + theme, await page.screenshot());
    await page.locator('#mdlBody .tile-link').scrollIntoViewIfNeeded();
    shot('m3-desktop-' + theme + '-link', await page.screenshot());
    await page.keyboard.press('Escape');
    await page.locator('#mdl[open]').waitFor({ state: 'detached', timeout: 5000 });
  }

  const browser = await chromium.launch();
  t.after(() => browser.close());
  const device = await passkeyDevice(browser, server, 'phone-m3');
  const session = await enrollDevice(server, device);
  await device.context.addCookies([{ name: 'p9s', value: session.token, url: server.origin, httpOnly: true, secure: true, sameSite: 'Strict' }]);
  const phone = device.page;
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(server.origin + '/phone/');
  await phone.evaluate((csrf) => sessionStorage.setItem('p9-csrf', csrf), session.csrf);
  await phone.reload();
  await phone.click('[data-nav="mission"]');
  await phone.click('#mission [data-open]:has-text("Home")', { timeout: 15000 });
  for (const s of SCRIPTS) await phone.click(`#mission dialog[open] summary:has-text("${s.title}")`);
  await phone.locator('#mission dialog[open] .tile-rings figure').first().waitFor({ timeout: 15000 });
  await phone.locator('#mission dialog[open] .tile-printed').waitFor({ timeout: 15000 });
  await settled(phone);
  shot('m3-phone-top', await phone.screenshot());
  // The row list draws again as Mission reloads; wait for each piece rather than count once.
  await phone.locator('#mission dialog[open] [data-tile-allow]').waitFor({ timeout: 15000 });
  await phone.locator('#mission dialog[open] .tile-row .tile-link').waitFor({ timeout: 15000 });
  await phone.locator('#mission dialog[open] .tile-row').scrollIntoViewIfNeeded();
  shot('m3-phone-bottom', await phone.screenshot());
});

// Mission from the space file: sections placed col1 to col3 draw open in those columns, in file order (widgets as P9's own
// panels, any other section with its items in place); a section with no place stays a tile in the top row.
const PLACED = { sections: [
  { title: 'Waiting', widget: 'waiting', place: 'col1' },
  { id: 'ops', title: 'Ops', place: 'col1', buttons: [{ id: 'deploy', title: 'Deploy', cmd: ['true'] }],
    logs: [{ id: 'ops-log', title: 'Ops log', path: 'logs/ops.log' }], data: [{ id: 'tile-stat', title: 'Count', script: 'stat' }] },
  { title: 'Main', widget: 'primary', place: 'col2' },
  { title: 'Usage', widget: 'usage', place: 'col3' },
  { id: 'later', title: 'Later', text: 'Not placed.', buttons: [{ id: 'later-run', title: 'Later run', cmd: ['true'] }] }] };
async function setupPlaced(paths) {
  const configured = await setup(paths), w = paths.workspace;
  await mkdir(path.join(w, 'logs'), { recursive: true });
  await writeFile(path.join(w, 'logs/ops.log'), 'deployed\n');
  await writeFile(path.join(w, '_waiting/pick-a-host.md'), '# Pick a host\n\nA or B.\n');
  await writeFile(path.join(w, 'hub/space.json'), JSON.stringify(PLACED));
  return configured;
}

test('Mission layout from the space: col1 to col3 draw their sections open, in order; an unplaced section stays a tile', { timeout: 150000 }, async (t) => {
  const server = await remoteDaemon(t, { setup: setupPlaced });
  assert.equal((await server.desk('/mission/data/allow', 'POST', { id: 'tile-stat' })).status, 200);
  const profile = path.join(server.directory, 'electron-profile');
  await mkdir(profile); await versionSeen(profile);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', server.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.click('#rMission');
  await page.locator('#fMission .tiles [data-group="Later"]').waitFor({ timeout: 20000 });
  const row = page.locator('#fMission .mrow[data-placed]');
  await row.waitFor({ timeout: 10000 });
  // Each column holds what the space placed there, in file order.
  const kids = (n) => row.locator(':scope>[data-col="' + n + '"]>*').evaluateAll((all) => all.map((k) => k.dataset.sec || k.dataset.panel || k.dataset.card || k.className));
  assert.deepEqual(await kids(1), ['needs', 'Ops']);
  assert.deepEqual(await kids(2), ['mprimary']);
  assert.deepEqual(await kids(3), ['musage']);
  // The widgets are P9's own panels: Waiting on you with its sort and item, the Main project card, Usage.
  await row.locator('[data-col="1"] .needs [data-sort]').waitFor();
  await row.locator('[data-col="1"] .needs [data-list] button', { hasText: 'Pick a host' }).waitFor({ timeout: 15000 });
  await row.locator('[data-col="2"] [data-card="mprimary"] .win', { hasText: 'P9' }).waitFor({ timeout: 10000 });
  assert.match(await row.locator('[data-col="3"] [data-panel="musage"] .pscroll').innerText(), /\S/);
  // Ops draws open: its button, its log view and its data tile in place, and Open opens its window.
  const ops = row.locator('[data-col="1"] [data-sec="Ops"]');
  await ops.locator('.pscroll .mlist [data-i]', { hasText: 'Deploy' }).waitFor();
  await ops.locator('.pscroll .mlist [data-slog="ops-log"]', { hasText: 'Ops log' }).waitFor();
  await ops.locator('.pscroll [data-tile="tile-stat"]', { hasText: '12' }).waitFor({ timeout: 15000 });
  // The section with no place is only a tile; a placed one is not.
  assert.equal(await page.locator('#fMission [data-sec="Later"]').count(), 0);
  assert.equal(await page.locator('#fMission .tiles [data-group="Ops"]').count(), 0);
  await settled(page);
  shot('mission-placed', await page.screenshot());
  await ops.locator('.phead').click();
  await page.locator('#mdl[open] #mdlT', { hasText: 'Ops · 3 items' }).waitFor({ timeout: 10000 });
  await page.locator('#mdlBody [data-tile="tile-stat"]', { hasText: '12' }).waitFor({ timeout: 15000 });
  await page.keyboard.press('Escape');

  // The phone ignores place: each section is still a row there.
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const device = await passkeyDevice(browser, server, 'phone-placed');
  const session = await enrollDevice(server, device);
  await device.context.addCookies([{ name: 'p9s', value: session.token, url: server.origin, httpOnly: true, secure: true, sameSite: 'Strict' }]);
  const phone = device.page;
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(server.origin + '/phone/');
  await phone.evaluate((csrf) => sessionStorage.setItem('p9-csrf', csrf), session.csrf);
  await phone.reload();
  await phone.click('[data-nav="mission"]');
  await phone.locator('#mission [data-open]:has-text("Later")').waitFor({ timeout: 15000 });
  await phone.click('#mission [data-open]:has-text("Ops")', { timeout: 15000 });
  await phone.locator('#mission dialog[open] summary:has-text("Deploy")').waitFor({ timeout: 15000 });
});

// A data script's level: bad draws its tile and its placed section red; warn draws a top-row section's tile amber once its
// window has drawn the tile. A level that is not ok, warn or bad is a bad shape.
const LEVEL = { sections: [
  { id: 'alerts', title: 'Alerts', place: 'col1', data: [{ id: 'tile-alarm', title: 'Alarm', script: 'alarm' }] },
  { title: 'Main', widget: 'primary', place: 'col2' },
  { id: 'later', title: 'Later', data: [{ id: 'tile-meh', title: 'Meh', script: 'meh' }] }] };
async function setupLevel(paths) {
  const configured = await setup(paths), w = paths.workspace;
  const scripts = [...SCRIPTS, { id: 'alarm', title: 'Alarm', cmd: print({ type: 'stat', value: 2, label: 'open incidents', level: 'bad' }) },
    { id: 'meh', title: 'Meh', cmd: print({ type: 'stat', value: 1, level: 'warn' }) }];
  await writeFile(path.join(w, 'hub/registry.json'), JSON.stringify({ scripts, apps: [], pages: [] }));
  await writeFile(path.join(w, 'hub/space.json'), JSON.stringify(LEVEL));
  return configured;
}

test('Mission level: a script\'s level warn or bad draws its tile, its placed section and its top-row tile amber or red', { timeout: 150000 }, async (t) => {
  assert.equal(dataShape({ type: 'stat', value: 1, level: 'bad' }), null);
  assert.match(dataShape({ type: 'stat', value: 1, level: 'red' }), /level/);
  const server = await remoteDaemon(t, { setup: setupLevel });
  for (const id of ['tile-alarm', 'tile-meh']) assert.equal((await server.desk('/mission/data/allow', 'POST', { id })).status, 200);
  const profile = path.join(server.directory, 'electron-profile');
  await mkdir(profile); await versionSeen(profile);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', server.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.click('#rMission');
  const alerts = page.locator('#fMission [data-sec="Alerts"]');
  await alerts.locator('[data-tile="tile-alarm"][data-l="bad"]', { hasText: '2' }).waitFor({ timeout: 20000 });
  await page.locator('#fMission [data-sec="Alerts"][data-l="bad"]').waitFor({ timeout: 10000 });
  // Later's tile runs only once its window shows it; after that its top-row tile carries the warn.
  await page.click('#fMission .tiles [data-group="Later"]');
  await page.locator('#mdlBody [data-tile="tile-meh"][data-l="warn"]').waitFor({ timeout: 15000 });
  await page.keyboard.press('Escape');
  await page.locator('#fMission .tiles [data-group="Later"] .lvl[data-l="warn"]').waitFor({ timeout: 10000 });
  await settled(page);
  shot('mission-level', await page.screenshot());
});
