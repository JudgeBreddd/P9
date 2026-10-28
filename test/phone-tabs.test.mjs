import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from '@playwright/test';
import { remoteDaemon, passkeyDevice, enrollDevice, root } from './helpers.mjs';

// The phone's other tabs (v0.1.6 chunk 7: T7 and phone spec section 6). The sandbox has no network, so navigator.onLine
// reads false and the phone disables New terminal and Save; this file says online, as phone-continue does.
// The dev space keeps no files: pictures go out in the log as "P9_SHOT <name> <base64>" (not on GitHub).
const shot = async (page, name) => { const png = await page.screenshot(); if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png.toString('base64')); };
async function setup(paths) {
  const settings = { registry: 'hub/registry.json', primary: 'projects/AGENTS.md', waiting: '_tyler', hub: 'hub', space: 'p9/mission-space.json', server_host: 'test-server' };
  for (const dir of ['hub', 'projects/event-horizon', '_tyler', '_ideas/needs-done', 'p9', 'docs']) await mkdir(path.join(paths.workspace, dir), { recursive: true });
  await writeFile(path.join(paths.workspace, 'hub', 'registry.json'), JSON.stringify({
    scripts: [{ id: 'health', title: 'Health check', group: 'Health', cmd: [process.execPath, '-e', 'console.log("ok")'] }], apps: [], pages: [{ id: 'wiki', title: 'Wiki', url: 'https://wiki.example.test/' }] }));
  await writeFile(path.join(paths.workspace, 'projects', 'AGENTS.md'), '# Projects\n\n**Main project: P9 — Event Horizon** (`event-horizon/`)\n');
  await writeFile(path.join(paths.workspace, 'projects', 'event-horizon', 'AGENTS.md'), '# P9\n\n**Status:** **Open** — phase 11 in work\n');
  await writeFile(path.join(paths.workspace, '_tyler', 'p9-question.md'), '# Pick a color\n\nQ. Which one?\n\nA.\n');
  const home = paths.directory, logs = path.join(home, 'icm-logs'), server = path.join(home, 'server-home', 'icm-logs');
  const batch = path.join(home, 'vault', 'Review', 'Inbox', 'librarian-2026-10-16');
  for (const dir of [logs, path.join(home, '.claude'), path.join(server, 'incidents'), batch, path.join(paths.workspace, '_system', 'scripts'), path.join(home, 'bin')])
    await mkdir(dir, { recursive: true });
  await writeFile(path.join(logs, 'doctor.log'), 'start\nall checks pass\n');
  await writeFile(path.join(server, 'backup.log'), 'backup done\n');
  await writeFile(path.join(server, 'incidents', '2026-10-16-disk_space.md'), '# Incident: disk_space on test-server, 2026-10-16 04:00:00\n\nDisk at 97%.\n');
  await writeFile(path.join(home, '.claude', 'continuity-kit.env'), 'WIKI_PATH="' + path.join(home, 'vault') + '"\n');
  await writeFile(path.join(batch, '_decision.md'), '---\nreview: pending\n---\n# Librarian batch\n');
  await writeFile(path.join(batch, 'a.md'), '# Page A\n');
  await writeFile(path.join(paths.workspace, '_system', 'scripts', 'heartbeats.sh'), '[ "$1" = overdue ] && echo "OVERDUE backup.sh last ran 30 h ago"\nexit 0\n');
  await writeFile(path.join(paths.workspace, '_system', 'scripts', 'doctor.sh'), 'echo "ok   everything"\n');
  await writeFile(path.join(paths.workspace, 'hub', 'mission_control.py'), 'HOSTNAME = "laptop"\n');
  await writeFile(path.join(home, 'bin', 'ssh'), '#!/bin/sh\nfor last; do :; done\nHOME="' + path.join(home, 'server-home') + '" exec sh -c "$last"\n', { mode: 0o755 });
  await writeFile(path.join(paths.workspace, 'projects', 'event-horizon', 'HANDOFF.md'), '# Handoff\n\nPhase 11 phone check.\n');
  await writeFile(path.join(paths.workspace, 'p9', 'backup.log'), 'backup line 1\nbackup line 2\n');
  await writeFile(path.join(paths.workspace, 'p9', 'mission-space.json'), JSON.stringify({ sections: [
    { title: 'Backups', text: 'Nightly backup tools.', buttons: [{ id: 'backup-now', title: 'Backup now', cmd: [process.execPath, '-e', 'console.log("backup-ok")'] }],
      logs: [{ id: 'backup-log', title: 'Backup log', path: 'p9/backup.log' }] },
    { title: 'Notes', text: 'An empty section.' }] }));
  await writeFile(path.join(paths.workspace, 'docs', 'inner.md'), 'inside');
  await writeFile(path.join(paths.directory, 'settings.json'), JSON.stringify(settings));
  return { args: ['--settings', path.join(paths.directory, 'settings.json')], path: path.join(home, 'bin') + path.delimiter + process.env.PATH };
}
async function seedLimits(home) {
  const now = Date.now(), hour = 3600000;
  await writeFile(path.join(home, '.claude.json'), JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: now,
    utilization: { five_hour: { utilization: 42, resets_at: new Date(now + 2 * hour).toISOString() }, seven_day: { utilization: 17, resets_at: new Date(now + 90 * hour).toISOString() } } } }));
  const day = path.join(home, '.codex', 'sessions', '2026', '10', '17');
  await mkdir(day, { recursive: true });
  const event = { timestamp: new Date(now - 3 * hour).toISOString(), type: 'event_msg', payload: { type: 'token_count', rate_limits: {
    primary: { used_percent: 61, window_minutes: 300, resets_at: Math.round((now - hour) / 1000) },
    secondary: { used_percent: 33, window_minutes: 10080, resets_at: Math.round((now + 50 * hour) / 1000) } } } };
  await writeFile(path.join(day, 'rollout-limits.jsonl'), '{"type":"session_meta"}\n' + JSON.stringify(event) + '\n');
}
async function seedUsage(server) {
  const db = new DatabaseSync(path.join(server.directory, '.local', 'state', 'p9-foundation', 'p9.db'));
  const conversation = db.prepare('INSERT OR IGNORE INTO conversations (id, provider, title, state, created) VALUES (?, ?, ?, ?, ?)');
  const event = db.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)');
  for (const row of JSON.parse(await readFile(path.join(root, 'test/fixtures/usage.json'), 'utf8'))) {
    conversation.run(row.conversation, row.provider, row.provider, 'idle', Date.now());
    event.run(row.conversation, row.type, JSON.stringify(row.data), Date.now());
  }
  event.run('fixture-claude', 'update', '{malformed', Date.now());
  db.close();
}
async function signedInPage(browser, server) {
  const device = await passkeyDevice(browser, server, 'phone-tabs');
  const session = await enrollDevice(server, device);
  await device.context.addInitScript(() => Object.defineProperty(navigator, 'onLine', { get: () => true }));
  await device.context.addCookies([{ name: 'p9s', value: session.token, url: server.origin, httpOnly: true, secure: true, sameSite: 'Strict' }]);
  await device.page.goto(server.origin + '/phone/');
  await device.page.evaluate((csrf) => sessionStorage.setItem('p9-csrf', csrf), session.csrf);
  await device.page.reload();
  await device.page.setViewportSize({ width: 390, height: 844 });
  return { ...device, session };
}

test('T7: a tap on Mission draws the last answer at once and refreshes behind', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, { setup });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const { page } = await signedInPage(browser, server);

  // How long the two routes take (fixture workspace; the numbers are in the log as P9_TIME).
  const timing = await page.evaluate(async () => {
    const out = {};
    for (const route of ['/mission', '/mission/hub']) {
      const took = [];
      for (let i = 0; i < 5; i++) { const start = performance.now(); await (await fetch(route, { cache: 'no-store' })).json(); took.push(Math.round(performance.now() - start)); }
      out[route] = took;
    }
    return out;
  });
  console.log('P9_TIME ' + JSON.stringify(timing));

  // First visit: nothing cached, it waits for the routes as before, then both answers are kept.
  await page.click('[data-nav="mission"]');
  await page.waitForSelector('#hub [data-open="work"]', { timeout: 10000 });
  await page.waitForFunction(() => localStorage.getItem('p9-mission') && localStorage.getItem('p9-mission-hub'), null, { timeout: 10000 });
  assert.equal(await page.locator('#mission .tile:has(span:text-is("Waiting on you")) b').innerText(), '1');

  // The world changes while the page is closed; a reload keeps only the cache. Both routes then hang.
  await unlink(path.join(server.workspace, '_tyler', 'p9-question.md'));
  await page.reload();
  let release; const gate = new Promise((resolve) => { release = resolve; });
  let held = 0;
  await page.route((url) => ['/mission', '/mission/hub'].includes(new URL(url).pathname), async (route) => { held++; await gate; await route.continue().catch(() => {}); });
  await page.click('[data-nav="mission"]');
  // Drawn from the cache while GET /mission has not answered (this is what fails without the cache).
  await page.waitForSelector('#mission .tile', { timeout: 3000 });
  await page.waitForSelector('#hub [data-open="work"]', { timeout: 3000 });
  assert.ok(held >= 1, 'GET /mission was in flight while the tiles showed');
  assert.equal(await page.locator('#mission .tile:has(span:text-is("Waiting on you")) b').innerText(), '1', 'the cached answer, not yet the fresh one');
  // Another tap on Mission leaves what is drawn alone: the hub tiles do not vanish while the routes wait.
  const hubTiles = () => page.locator('#hub [data-open]').count();
  const before = await hubTiles();
  assert.ok(before >= 6, 'hub tiles ' + before);
  await page.click('[data-nav="usage"]'); await page.click('[data-nav="mission"]');
  assert.equal(await hubTiles(), before);

  // The routes answer: the fresh answer replaces the cached one, and the hub is there throughout.
  release();
  await page.waitForFunction(() => document.querySelector('#mission .tile b')?.textContent === '0', null, { timeout: 10000 });
  await page.waitForSelector('#hub [data-open="work"]', { timeout: 10000 });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('p9-mission')).queue.length === 0, null, { timeout: 10000 });
  await page.unroute((url) => ['/mission', '/mission/hub'].includes(new URL(url).pathname));

  // A signed-out answer forgets the cache (the phone stores Mission text only while signed in).
  await page.route((url) => new URL(url).pathname === '/mission', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }));
  await page.click('[data-nav="usage"]'); await page.click('[data-nav="mission"]');
  await page.waitForURL(/\/login/, { timeout: 10000 });
  assert.deepEqual(await page.evaluate(() => [localStorage.getItem('p9-mission'), localStorage.getItem('p9-mission-hub')]), [null, null]);
});

test('Phone tabs: Terminal, Mission, a Mission window, Usage, Files and the editor, 390 wide (pictures in the log)', { timeout: 180000 }, async (t) => {
  const server = await remoteDaemon(t, { setup });
  await seedUsage(server);
  await seedLimits(server.directory);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const { page } = await signedInPage(browser, server);

  await page.click('[data-nav="terminal"]');
  await page.click('#newTerminal');
  await page.waitForFunction(() => document.querySelector('#termState')?.textContent === 'Connected', null, { timeout: 15000 });
  // The title is the picker: it lists the open terminals in the shared sheet and marks the attached one.
  await page.click('#pickTerminal');
  await page.waitForSelector('#sheetBody [data-term][aria-checked="true"]', { timeout: 5000 });
  await page.keyboard.press('Escape');
  await page.waitForSelector('#sheet:not([open])', { state: 'attached', timeout: 5000 });
  await page.click('#screen'); await page.keyboard.type('echo P9-PHONE-4""2'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#screen .xterm-rows')?.textContent.includes('P9-PHONE-42'), null, { timeout: 10000 });
  // A long session name is cut short before it reaches the bar's buttons, and every key is on the screen (Paste was cut off).
  const edges = await page.evaluate(() => {
    const box = (selector) => document.querySelector(selector).getBoundingClientRect();
    return { title: box('#pickTerminal').right, dot: box('[data-bar="terminal"] .sync').left, paste: box('#keys [data-key="paste"]').right, width: innerWidth };
  });
  assert.ok(edges.title <= edges.dot, `the terminal title ends before the bar's buttons: ${edges.title} > ${edges.dot}`);
  assert.ok(edges.paste <= edges.width, `Paste is on the screen: ${edges.paste} > ${edges.width}`);
  // c7's leftovers (spec §6), finished by c1. Each is noted and the test goes on, so one A/B run shows all five.
  const misses = [], soft = async (name, check) => { try { await check(); } catch (error) { misses.push(name + ': ' + String(error.message).split('\n')[0]); } };
  await soft('Terminal title not cut', async () => {
    const title = await page.evaluate(() => { const span = document.querySelector('#termTitle'); return { text: span.textContent, cut: span.scrollWidth > span.clientWidth }; });
    assert.match(title.text, /^Terminal · \d{1,2}:\d{2}/); assert.equal(title.cut, false, title.text + ' is cut');
  });
  await shot(page, 'tab-terminal');
  await page.setViewportSize({ width: 390, height: 500 });
  await page.waitForTimeout(400);
  await shot(page, 'tab-terminal-keyboard');
  await page.setViewportSize({ width: 390, height: 844 });
  // Paste with a stubbed clipboard is phone-parity.test.mjs's T2 (typed, refused, too late).

  await page.click('[data-nav="mission"]');
  await page.waitForSelector('#hub [data-open="work"]', { timeout: 10000 });
  // Every row shows its detail line, "Everything else" too; a section's line names what is in it.
  await soft('Mission rows show their detail line', async () => {
    const lines = await page.evaluate(() => [...document.querySelectorAll('#mission .tile')].map((tile) => [tile.querySelector('span').textContent, getComputedStyle(tile.querySelector('small')).display, tile.querySelector('small').textContent]));
    assert.deepEqual(lines.filter(([, display]) => display === 'none').map(([name]) => name), []);
    assert.equal(lines.find(([name]) => name === 'Backups')?.[2], 'Backup now · Backup log');
  });
  await shot(page, 'tab-mission');
  await page.click('#mission .tile:has(span:text-is("Backups"))');
  await page.waitForSelector('#mission dialog[open]', { timeout: 5000 });
  // The window's title is the h1 in the bar; phone.test.mjs Phase 11 reads the same selector for every tile.
  assert.equal(await page.locator('#mission dialog[open] > header .title h1').innerText({ timeout: 5000 }), 'Backups');
  // The closed "Backup now" row has a Run pill at its right; a tap runs it and opens the row on its output.
  await soft('Run pill in the closed row', async () => {
    const pill = page.locator('#mission dialog[open] details:not([open]) > summary:has-text("Backup now") > [data-run-now]');
    const edges = await pill.evaluate((button) => ({ right: button.getBoundingClientRect().right, row: button.closest('summary').getBoundingClientRect().right }), null, { timeout: 3000 });
    assert.ok(edges.row - edges.right < 2, `the pill is at the row's right: ${edges.right} < ${edges.row}`);
    await shot(page, 'tab-mission-window-closed');
    await pill.click();
    await page.waitForSelector('#mission dialog[open] details[open] pre[data-output]:has-text("backup-ok")', { timeout: 10000 });
  });
  if (misses.at(-1)?.startsWith('Run pill')) { // the old flow, so the checks below still run
    await page.click('#mission dialog[open] summary:has-text("Backup now")');
    await page.click('#mission dialog[open] form[data-run] button');
  }
  await page.waitForSelector('#mission dialog[open] pre[data-output]:has-text("backup-ok")', { timeout: 10000 });
  // An opened row stacks: its text is under the title, not beside it (the Chats list's .row rule once made these flex rows).
  const stack = await page.evaluate(() => { const row = document.querySelector('#mission dialog[open] details[open]'); return { summary: row.querySelector('summary').getBoundingClientRect().bottom, body: row.querySelector('.body').getBoundingClientRect().top }; });
  assert.ok(stack.body >= stack.summary - 1, 'the opened row text is under its title: ' + stack.body + ' < ' + stack.summary);
  await shot(page, 'tab-mission-window');
  await page.click('#mission dialog[open] [data-close]');

  await page.click('[data-nav="usage"]');
  await page.waitForSelector('#usage .sum', { timeout: 10000 });
  // Spec §6, P5: "27,600 in · 3,820 out · $0.28 at API prices"; the fixture's cost is $0.2768.
  await soft('Cost in cents', async () => assert.match(await page.locator('#usage .sum').innerText(), /^27,600 in · 3,820 out · \$0\.28 at API prices/));
  await soft('Details has a chevron', async () => {
    const chevron = () => page.evaluate(() => { const after = getComputedStyle(document.querySelector('#usage details.more summary'), '::after'); return after.content !== 'none' && after.width === '8px' ? after.transform : 'none'; });
    const closed = await chevron();
    assert.notEqual(closed, 'none');
    await page.click('#usage details.more summary');
    assert.notEqual(await chevron(), closed, 'the chevron turns when Details opens');
    await page.click('#usage details.more summary');
  });
  // P5: each plan window is a ring with its % inside and when it resets under it (phone.test.mjs Phase 11 holds the
  // same check, but stops early with no network).
  const ring = await page.evaluate(() => { const r = document.querySelector('#usage [data-limits] .uring'), b = r.getBoundingClientRect(), pct = r.querySelector('b').getBoundingClientRect(), under = r.parentElement.querySelector('small');
    return { inside: pct.left >= b.left && pct.right <= b.right && pct.top >= b.top && pct.bottom <= b.bottom, below: under.getBoundingClientRect().top >= b.bottom - 1, under: under.textContent, round: getComputedStyle(r, '::before').borderRadius }; });
  assert.match(ring.under, /^resets \w{3} \d{1,2}:\d\d\s?[AP]M$/);
  assert.deepEqual({ ...ring, under: 'resets' }, { inside: true, below: true, under: 'resets', round: '50%' });
  await shot(page, 'tab-usage');

  await page.click('[data-nav="files"]');
  await page.waitForSelector('#fileList button[data-name="note.txt"]', { timeout: 10000 });
  await shot(page, 'tab-files');
  await page.click('#fileList button[data-name="note.txt"]');
  await page.waitForSelector('#fileState:text("Loaded")', { timeout: 10000 });
  // Save is live only while the draft differs from the file; Discard (in the more menu) puts the file back; Preview is for .md only.
  assert.equal(await page.locator('#save').isDisabled(), true);
  await page.locator('.cm-content').click(); await page.keyboard.press('Control+A'); await page.keyboard.type('an edit not saved yet');
  assert.equal(await page.locator('#save').isEnabled(), true);
  await shot(page, 'tab-editor');
  await page.click('#moreFile');
  assert.equal(await page.locator('#sheetBody [data-file="preview"]').count(), 0);
  await page.click('#sheetBody [data-file="discard"]');
  assert.equal(await page.locator('#save').isDisabled(), true);
  await page.click('#closeFile');
  await page.click('#fileList button[data-name="docs"]');
  await page.click('#fileList button[data-name="inner.md"]');
  await page.waitForSelector('#fileState:text("Loaded")', { timeout: 10000 });
  assert.equal(await page.locator('#openPath').innerText(), 'inner.md');
  await page.click('#moreFile'); await page.click('#sheetBody [data-file="preview"]');
  assert.equal(await page.locator('#rendered').isVisible(), true);
  assert.equal(await page.locator('#editor').isHidden(), true);
  // P17: the editor's text is the preview's size (14 px mono beside 15 px text), not 16 px.
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.cm-content')).fontSize), '14px');
  // P10: closed, then up a folder: the title is the folder shown and nothing else.
  await page.click('#closeFile'); await page.click('#up'); await page.waitForSelector('#dirPath:text("Workspace")');
  assert.equal(await page.locator('[data-bar="files"] h1').innerText(), 'Workspace');
  assert.deepEqual(misses, []);
});
