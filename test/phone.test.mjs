import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { chromium, _electron } from '@playwright/test';
import { remoteDaemon, passkeyDevice, enrollDevice, root, externalEdit } from './helpers.mjs';

const evidence = process.env.P9_SCREENSHOTS || path.join(os.tmpdir(), 'p9-phase11-screenshots');
async function setup(paths) {
  const settings = { registry: 'hub/registry.json', primary: 'projects/AGENTS.md', waiting: '_tyler', hub: 'hub', space: 'p9/mission-space.json', server_host: 'test-server' };
  await mkdir(path.join(paths.workspace, 'hub'), { recursive: true });
  await mkdir(path.join(paths.workspace, 'projects', 'event-horizon'), { recursive: true });
  await mkdir(path.join(paths.workspace, '_tyler'), { recursive: true });
  await mkdir(path.join(paths.workspace, '_ideas', 'needs-done'), { recursive: true });
  await writeFile(path.join(paths.workspace, 'hub', 'registry.json'), JSON.stringify({
    scripts: [{ id: 'health', title: 'Health check', group: 'Health', cmd: [process.execPath, '-e', 'console.log("ok")'] }], apps: [], pages: [{ id: 'wiki', title: 'Wiki', url: 'https://wiki.example.test/' }],
  }));
  await writeFile(path.join(paths.workspace, 'projects', 'AGENTS.md'), '# Projects\n\n**Main project: P9 — Event Horizon** (`event-horizon/`)\n');
  await writeFile(path.join(paths.workspace, 'projects', 'event-horizon', 'AGENTS.md'), '# P9\n\n**Status:** **Open** — phase 11 in work\n');
  await writeFile(path.join(paths.workspace, '_tyler', 'p9-question.md'), '# Pick a color\n\nQ. Which one?\n\nA.\n');
  // The files the hub sections are read from (Phase 16: the daemon reads them itself, no Python): this machine's
  // ~/icm-logs, the Wiki inbox in the vault the kit env names, and the two scripts behind the notices.
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
  // workspace-hub itself still runs this file until it retires, so P9 keeps it read-only (server.mjs).
  await writeFile(path.join(paths.workspace, 'hub', 'mission_control.py'), 'HOSTNAME = "laptop"\n');
  // A stand-in ssh: runs the server one-liner here against a fixture server home, so the test never reaches a real host.
  await writeFile(path.join(home, 'bin', 'ssh'), '#!/bin/sh\nfor last; do :; done\nHOME="' + path.join(home, 'server-home') + '" exec sh -c "$last"\n', { mode: 0o755 });
  await writeFile(path.join(paths.workspace, 'projects', 'event-horizon', 'HANDOFF.md'), '# Handoff\n\nPhase 11 phone check.\n');
  await writeFile(path.join(paths.directory, 'settings.json'), JSON.stringify(settings));
  return { args: ['--settings', path.join(paths.directory, 'settings.json')], path: path.join(home, 'bin') + path.delimiter + process.env.PATH };
}
// Plan limits as Claude Code and Codex record them in the (fixture) home: Claude fresh, Codex 3 h old with its 5 h window
// already reset, so the screens must say "new window" and the age instead of the expired figure.
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
function seedUsage(server) {
  const db = new DatabaseSync(path.join(server.directory, '.local', 'state', 'p9-foundation', 'p9.db'));
  const rows = JSON.parse(requireFixture);
  const conversation = db.prepare('INSERT OR IGNORE INTO conversations (id, provider, title, state, created) VALUES (?, ?, ?, ?, ?)');
  const event = db.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)');
  for (const row of rows) {
    conversation.run(row.conversation, row.provider, row.provider, 'idle', Date.now());
    event.run(row.conversation, row.type, JSON.stringify(row.data), Date.now());
  }
  event.run('fixture-claude', 'update', '{malformed', Date.now());
  db.close();
}
const requireFixture = await readFile(path.join(root, 'test/fixtures/usage.json'), 'utf8');
async function signedInPage(browser, server) {
  const device = await passkeyDevice(browser, server, 'phone-phase11');
  const session = await enrollDevice(server, device);
  await device.context.addCookies([{ name: 'p9s', value: session.token, url: server.origin, httpOnly: true, secure: true, sameSite: 'Strict' }]);
  await device.page.goto(server.origin + '/phone/');
  await device.page.evaluate((csrf) => sessionStorage.setItem('p9-csrf', csrf), session.csrf);
  await device.page.reload();
  await device.page.setViewportSize({ width: 390, height: 844 });
  return { ...device, session };
}

test('Phase 11: phone editor, offline cursor replay, operation retry and usage states', async (t) => {
  await mkdir(evidence, { recursive: true });
  const server = await remoteDaemon(t, { setup, args: ['--acp-override', path.join(root, 'test/fake-acp-agent.mjs')] });
  seedUsage(server);
  await seedLimits(server.directory);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const { page, context, session } = await signedInPage(browser, server);

  await page.waitForSelector('h1:text("Chats")');
  const usage = await server.remote('/usage', { session: (await enrollDevice(server, await passkeyDevice(browser, server, 'usage-reader'))) });
  assert.equal(usage.status, 200);
  assert.deepEqual(usage.body.totals, { inputTokens: 27600, outputTokens: 3820, cachedTokens: 19200, costUsd: 0.2768 });
  assert.equal(usage.body.discarded, 1);
  assert.equal(JSON.stringify(usage.body).includes('command'), false);
  // Threat model row 15 case 3: a phone reads the agent lock but has no route that changes it.
  const reader = await enrollDevice(server, await passkeyDevice(browser, server, 'lock-probe'));
  assert.deepEqual((await server.remote('/agent-lock', { session: reader })).body, { on: false });
  assert.equal((await server.remote('/agent-lock', { method: 'POST', session: reader, body: { on: true }, headers: { 'x-p9-op': crypto.randomUUID() } })).status, 404);
  // Threat model row 4: the phone can neither read nor change file protection.
  assert.equal((await server.remote('/file-protection', { session: reader })).status, 404);
  assert.equal((await server.remote('/file-protection', { method: 'POST', session: reader, body: { on: false }, headers: { 'x-p9-op': crypto.randomUUID() } })).status, 404);
  // Threat model row 4: creating files from the editor is desktop-only.
  assert.equal((await server.remote('/files', { method: 'POST', session: reader, body: { path: 'phone-made.txt', content: 'x' }, headers: { 'x-p9-op': crypto.randomUUID() } })).status, 404);
  // Conversations are labelled title · start time · state; New chat creates one and selects it.
  assert.match(await page.locator('#conversation option').first().innerText(), /^(claude|codex) · .+ · idle$/);
  await page.click('#newChat'); await page.click('#sheet [data-new="codex"]');
  await page.waitForFunction(() => document.querySelectorAll('#conversation option').length === 3);
  await page.waitForSelector('#composer', { state: 'visible' }); // the new chat opened (P1: the Chats list, then the chat screen)
  const picked = await page.locator('#conversation').evaluate((select) => select.selectedOptions[0].textContent);
  assert.match(picked, /^Codex · .+ · idle$/);
  await page.screenshot({ path: path.join(evidence, 'phone-chat.png') });
  // Phase 17 row 1 (Builder, 2026-10-17: "agent chat not working"): a reply that lands after the send shows without a
  // refresh, as one readable block, and the chat's history is still there after a reload (it used to read
  // "No new recorded events." once the phone had a saved cursor).
  await page.fill('#prompt', 'late'); await page.click('#composer button');
  await page.waitForSelector('#events article:has-text("late reply")', { timeout: 10000 });
  const labels = () => page.locator('#events > article').evaluateAll((items) => items.map((item) => item.dataset.kind));
  assert.deepEqual(await labels(), ['user', 'agent']);
  await page.reload();
  await page.waitForSelector('#events article:has-text("late reply")');
  assert.deepEqual(await labels(), ['user', 'agent']);
  await page.screenshot({ path: path.join(evidence, 'phone-chat-reply.png') });
  // Phase 17 row 2: the agent asks for approval; the phone shows the agent's options as buttons and the answer reaches it.
  await page.fill('#prompt', 'permission'); await page.click('#composer button');
  await page.waitForSelector('#events button[data-option="allow"]', { timeout: 10000 });
  assert.deepEqual(await page.locator('#events article:last-child button').allInnerTexts(), ['Allow', 'Reject']);
  await page.screenshot({ path: path.join(evidence, 'phone-chat-approval.png') });
  await page.click('#events button[data-option="allow"]');
  await page.waitForSelector('#events article:has-text("permission:allow")', { timeout: 10000 });
  assert.equal(await page.locator('#events button[data-option]').count(), 0);
  assert.deepEqual((await labels()).slice(-4), ['user', 'approval', 'answered', 'agent']);
  // Replies show as Markdown on the phone too, and markup in them stays text (threat model row 18).
  await page.fill('#prompt', 'x\n\n# Plan\n\n- **one**\n\n<img src=x onerror="window.pwned = 1"> <script>window.pwned = 2</script> [x](javascript:window.pwned=3)'); await page.click('#composer button');
  const md = page.locator('#events article:last-child.md');
  await md.locator('h1').waitFor({ timeout: 10000 });
  assert.deepEqual(await md.evaluate((m) => [!!m.querySelector('ul li strong'), m.querySelectorAll('script, img, iframe, a').length, m.textContent.includes('onerror'), window.pwned]), [true, 0, true, undefined]);
  await md.screenshot({ path: path.join(evidence, 'phone-markdown.png') });
  // Mode and Model from the phone (Builder, 2026-10-18): a picked mode reaches the agent, "as set" sends none (so it
  // stays), and the Model list is the agent's own.
  // Waits for this send's own reply (You + Agent added): the same text as the last reply would match at once and the
  // next send would hit the still-running turn (409).
  const reply = async (text, want) => {
    const before = await page.locator('#events article').count();
    await page.fill('#prompt', text); await page.click('#composer button');
    await page.waitForFunction(([n, w]) => { const a = document.querySelectorAll('#events article'); return a.length >= n + 2 && a[a.length - 1].textContent.includes(w); }, [before, want], { timeout: 10000 })
      .catch(async (e) => { throw new Error(`no ${want}; last: ${(await page.locator('#events article').allInnerTexts()).slice(-3).join(' | ')}`, { cause: e }); });
  };
  assert.deepEqual(await page.locator('#mode option').allInnerTexts(), ['Mode: as set', 'Mode: Read-only', 'Mode: Workspace access', 'Mode: Auto review']);
  assert.equal(await page.inputValue('#mode'), '', 'the phone picked a mode by itself');
  await page.selectOption('#mode', 'Read-only'); await reply('mode', 'mode:read-only');
  await page.selectOption('#mode', ''); await reply('mode', 'mode:read-only');
  assert.deepEqual(await page.locator('#model option').evaluateAll((o) => o.map((x) => x.value)), ['default', 'opus', 'haiku']);
  await page.selectOption('#model', 'opus'); await reply('model', 'model:opus');
  await page.screenshot({ path: path.join(evidence, 'phone-mode-model.png') });

  // Phase 16 free-form space: with the daemon already running, one file edit adds a section with a button and a
  // log view, plus an empty section. No code change, no restart; both screens pick it up on their next load.
  await mkdir(path.join(server.workspace, 'p9'));
  await writeFile(path.join(server.workspace, 'p9', 'backup.log'), 'backup line 1\nbackup line 2\n');
  await writeFile(path.join(server.workspace, 'p9', 'mission-space.json'), JSON.stringify({ sections: [
    { title: 'Backups', text: 'Nightly backup tools.', buttons: [{ id: 'backup-now', title: 'Backup now', cmd: [process.execPath, '-e', 'console.log("backup-ok")'] }],
      logs: [{ id: 'backup-log', title: 'Backup log', path: 'p9/backup.log' }] },
    { title: 'Notes', text: 'An empty section.' }] }));

  const electronProfile = path.join(server.directory, 'electron-profile');
  await mkdir(electronProfile);
  const electronEnv = { ...process.env }; delete electronEnv.ELECTRON_RUN_AS_NODE;
  const desktop = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', server.state,
    '--user-data-dir=' + electronProfile], env: electronEnv, chromiumSandbox: true });
  t.after(() => desktop.close());
  const desktopPage = await desktop.firstWindow();
  await desktopPage.click('#rMission');
  // Phase 16 short Mission: every section is a card that opens its window and closes again; the page itself does not scroll.
  await desktopPage.locator('#fMission [data-win="mwork"]').waitFor();
  const desktopWins = await desktopPage.locator('#fMission [data-win]').evaluateAll((cards) => cards.map((card) => [card.dataset.win, card.querySelector('h4').textContent]));
  assert.deepEqual(desktopWins.map(([id]) => id), ['mprimary', 'mlogs', 'musage', 'mlaunch', 'mnotes', 'minbox', 'mwork']);
  for (const [id, title] of desktopWins) {
    await desktopPage.click(`#fMission [data-win="${id}"]`);
    await desktopPage.locator(`#mdl[open] #mdlBody #${id}`).waitFor();
    assert.equal(await desktopPage.locator('#mdlT').innerText(), title);
    await desktopPage.click('#mdlX');
    await desktopPage.locator('#mdl[open]').waitFor({ state: 'detached' });
  }
  assert.ok(await desktopPage.locator('#fMission').evaluate((mission) => mission.scrollHeight <= mission.clientHeight), 'Mission fits without scrolling');
  // Builder, 2026-10-18 #3: three columns reach the bottom of the window, Usage shows its bars on the page, apps launch from tiles.
  const [cols, gap] = await desktopPage.locator('#fMission .mrow').evaluate((r) => [getComputedStyle(r).gridTemplateColumns.split(' ').length, r.parentElement.getBoundingClientRect().bottom - r.getBoundingClientRect().bottom]);
  assert.equal(cols, 3); assert.ok(gap < 30, `Mission leaves ${gap}px empty below its columns`);
  assert.match(await desktopPage.locator('#fMission [data-panel="musage"]').innerText(), /Claude\s+5 h\s+42%/);
  assert.ok(await desktopPage.locator('#fMission [data-panel="mlaunch"] .ltile').count() > 0, 'no launch tiles');
  await desktopPage.screenshot({ path: path.join(evidence, 'desktop-mission-short.png') });
  await desktopPage.click('#fMission [data-win="musage"]');
  await desktopPage.locator('#mdl #musage', { hasText: '27,600' }).waitFor();
  await desktopPage.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity));
  await desktopPage.screenshot({ path: path.join(evidence, 'desktop-mission-window.png') });
  assert.match(await desktopPage.locator('#mdl #musage').innerText(), /3,820[\s\S]*\$0\.2768[\s\S]*3 samples[\s\S]*1 malformed discarded/);
  const desktopLimits = await desktopPage.locator('#mdl #musage [data-limits]').innerText();
  assert.match(desktopLimits, /Claude\s+5 h 42% \(resets [^)]+\) · week 17% \(resets [^)]+\) · just now/);
  assert.match(desktopLimits, /Codex\s+5 h new window · week 33% \(resets [^)]+\) · 3 h old/);
  await desktopPage.click('#mdlX');
  // Desktop: each space section is a tile; Backups lists its button and its log view, and the log opens.
  assert.equal(await desktopPage.locator('#fMission [data-group="Notes"] .n').innerText(), '0');
  await desktopPage.click('#fMission [data-group="Backups"]');
  assert.match(await desktopPage.locator('#mdlBody').innerText(), /Nightly backup tools\.[\s\S]*Backup log[\s\S]*Backup now/);
  await desktopPage.click('#mdlBody [data-slog="backup-log"]');
  await desktopPage.locator('#mdlBody pre', { hasText: 'backup line 2' }).waitFor();
  await desktopPage.screenshot({ path: path.join(evidence, 'desktop-space-log.png') });
  await desktopPage.keyboard.press('Escape');
  // Fix with Claude (Phase 16 row 4): the incident's modal starts a Claude chat whose first message is the incident,
  // read by the daemon (the stand-in ssh serves the server's file), and the chat opens in the modal.
  await desktopPage.click('#fMission [data-win="mlogs"]');
  // The status dot sits on the incident's own line, not on a line above it (Phase 16 review).
  const [dot, line] = await desktopPage.locator('#mdlBody [data-inc]:has-text("disk_space")').evaluate((b) => ['.lvl', '.txt'].map((s) => b.querySelector(s).getBoundingClientRect()));
  assert.ok(dot.top >= line.top && dot.bottom <= line.bottom, `dot ${dot.top}-${dot.bottom} outside its line ${line.top}-${line.bottom}`);
  await desktopPage.click('#mdlBody [data-inc]:has-text("disk_space")');
  await desktopPage.locator('#mdlBody pre', { hasText: 'Disk at 97%' }).waitFor();
  await desktopPage.click('#mdlFoot [data-fix]');
  await desktopPage.locator('#mdlBody', { hasText: 'This is a doctor incident from test-server' }).waitFor();
  assert.match(await desktopPage.locator('#mdlBody').innerText(), /doctor\.sh --fix[\s\S]*ssh test-server[\s\S]*Disk at 97%/);
  const fixChats = (await desktopPage.evaluate(() => window.p9.chat('list'))).body.conversations.filter((c) => c.title.startsWith('Fix: '));
  assert.deepEqual(fixChats.map((c) => [c.provider, c.title]), [['claude', 'Fix: 2026-10-16-disk_space']]);
  await desktopPage.screenshot({ path: path.join(evidence, 'desktop-fix-chat.png') });
  // The daemon reads only incidents the hub lists: a made-up name or a path is refused, and no chat starts.
  const fixRefused = await desktopPage.evaluate(async () => [(await window.p9.mission('fix', { host: 'test-server', name: '../x.md' })).status,
    (await window.p9.mission('fix', { host: 'test-server', name: 'nope.md' })).status]);
  assert.deepEqual(fixRefused, [400, 404]);
  assert.equal((await desktopPage.evaluate(() => window.p9.chat('list'))).body.conversations.filter((c) => c.title.startsWith('Fix: ')).length, 1);
  await desktopPage.keyboard.press('Escape');
  // The hub's New idea box (Builder: "keep the _ideas/ box ... I use that often"): one new file, named as the hub names it.
  await desktopPage.click('#fMission .tiles [data-idea]');
  await desktopPage.fill('#mdlBody [data-idea-name]', 'Garage Shelf Plan');
  await desktopPage.fill('#mdlBody [data-idea-text]', 'Two rows over the bench.\n\n');
  // Builder's #15: the needs-done checkbox sat alone with its words on the next line. Box and words share one row now.
  const needsRow = await desktopPage.evaluate(() => { const box = document.querySelector('#mdlBody [data-idea-needs]'), l = box.closest('label');
    const b = box.getBoundingClientRect(), t = document.createRange(); t.selectNodeContents(l); const r = [...t.getClientRects()].pop();
    return { sameRow: Math.abs((b.top + b.bottom) / 2 - (r.top + r.bottom) / 2) < 6, leftOfText: b.right <= r.left + 1 }; });
  assert.deepEqual(needsRow, { sameRow: true, leftOfText: true });
  await desktopPage.locator('#mdlBody [data-idea-needs]').scrollIntoViewIfNeeded(); await desktopPage.waitForTimeout(400);
  await desktopPage.screenshot({ path: path.join(evidence, 'desktop-new-idea.png') });
  await desktopPage.click('#mdlFoot [data-idea-save]');
  await desktopPage.locator('.toast', { hasText: '_ideas/garage-shelf-plan.md' }).waitFor();
  assert.equal(await readFile(path.join(server.workspace, '_ideas', 'garage-shelf-plan.md'), 'utf8'), 'Two rows over the bench.\n');
  // It never replaces a file, and a name with nothing to keep is refused.
  const ideaRefused = await desktopPage.evaluate(async () => [(await window.p9.mission('idea', { name: 'garage shelf plan', text: 'x', needs_done: false })).status,
    (await window.p9.mission('idea', { name: '../..', text: 'x', needs_done: false })).status]);
  assert.deepEqual(ideaRefused, [409, 400]);
  assert.equal(await readFile(path.join(server.workspace, '_ideas', 'garage-shelf-plan.md'), 'utf8'), 'Two rows over the bench.\n');

  await page.click('[data-back]'); await page.waitForSelector('#chatList', { state: 'visible' });
  await page.click('[data-nav="mission"]');
  await page.waitForSelector('#mission >> text=Main project');
  // Phase 16 short Mission: every section is a tile that opens a full-screen window and closes again.
  await page.waitForSelector('#hub [data-open="work"]');
  const phoneWins = await page.locator('#mission [data-open]').evaluateAll((tiles) => tiles.map((tile) => [tile.dataset.open, tile.querySelector('span').textContent]));
  assert.deepEqual(phoneWins.map(([, title]) => title), ['Waiting on you', 'Main project', 'Notifications', 'Incidents', 'Wiki review inbox', 'Work in flight',
    'Last solo run', 'Workspace', 'Logs', 'Health', 'Backups', 'Notes', 'Pages']);
  for (const [id, title] of phoneWins) {
    await page.click(`#mission [data-open="${id}"]`);
    assert.equal(await page.locator(`#w-${id}[open] > header h2`).innerText(), title);
    await page.click(`#w-${id} [data-close]`);
    await page.waitForSelector(`#w-${id}[open]`, { state: 'detached' });
  }
  await page.screenshot({ path: path.join(evidence, 'phone-mission-tiles.png') });
  // A tap on the tile whose window holds this text; every window has its own Close.
  const openWindowWith = async (text) => page.click(`#mission [data-open="${await page.evaluate((t) => [...document.querySelectorAll('#mission dialog')].find((d) => d.textContent.includes(t)).id.slice(2), text)}"]`);
  const closeWindow = () => page.click('#mission dialog[open] [data-close]');
  // Phone Mission: a script runs and streams its output; a waiting item is answered in place; pages are links.
  await openWindowWith('Health check');
  await page.click('#mission summary:has-text("Health check")');
  await page.click('#mission dialog[open] form[data-run] button');
  await page.waitForFunction(() => document.querySelector('#mission dialog[open] pre[data-output]')?.textContent.includes('ok'));
  // Copy (Builder, 2026-10-18: "Yes" to phone Copy): the tap puts exactly the shown output on the clipboard.
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.origin });
  await page.click('#mission dialog[open] [data-copy]');
  await page.waitForSelector('#mission dialog[open] [data-copy]:has-text("Copied")');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), await page.locator('#mission dialog[open] pre[data-output]').textContent());
  await page.screenshot({ path: path.join(evidence, 'phone-copy.png') });
  await closeWindow();
  await page.click('#mission [data-open="pages"]');
  assert.equal(await page.locator('#mission a.link').getAttribute('href'), 'https://wiki.example.test/');
  await closeWindow();
  await page.click('#mission [data-open="queue"]');
  await page.click('#mission summary:has-text("Pick a color")');
  await page.fill('#mission form[data-answer] textarea', 'Blue');
  await page.screenshot({ path: path.join(evidence, 'phone-mission-open.png') });
  await page.click('#mission form[data-answer] button');
  await page.waitForSelector('#mission [data-note]:text("Answer saved.")');
  assert.match(await readFile(path.join(server.workspace, '_tyler', 'p9-question.md'), 'utf8'), /^A\. Blue$/m);
  // The answer reloads Mission 900 ms later; wait for it, or it lands inside the hub steps below and wipes their notes.
  await page.waitForSelector('#mission [data-note]:text("Answer saved.")', { state: 'detached' });
  await closeWindow();
  await page.screenshot({ path: path.join(evidence, 'phone-mission.png') });
  // The old hub's sections: notices, incidents, Wiki inbox, work in flight, solo run, logs; each row's text loads on open.
  await page.click('#hub [data-open="notes"]');
  await page.waitForSelector('#hub .card.warn:has-text("backup.sh last ran 30 h ago")');
  // The hub's label, on both screens (Phase 16: it said "Overdue job").
  assert.equal(await page.locator('#hub .card.warn h2').innerText(), 'SILENT JOB');
  await closeWindow();
  await desktopPage.click('#fMission [data-win="mnotes"]');
  assert.match(await desktopPage.locator('#mdl #mnotes', { hasText: 'backup.sh last ran 30 h ago' }).innerText(), /SILENT JOB/);
  await desktopPage.click('#mdlX');
  assert.equal(await page.locator('#mission .card:has-text("Registry")').count(), 0); // a clean registry shows no warning
  await page.click('#hub [data-open="incidents"]');
  await page.click('#hub summary:has-text("disk_space")');
  await page.waitForSelector('#hub pre:has-text("Disk at 97%.")');
  await closeWindow();
  await page.click('#hub [data-open="handoffs"]');
  await page.click('#hub summary:has-text("projects/event-horizon")');
  await page.waitForSelector('#hub pre:has-text("Phase 11 phone check.")');
  await closeWindow();
  await page.click('#hub [data-open="inbox"]');
  await page.click('#hub summary:has-text("librarian-2026-10-16")');
  await page.waitForSelector('#hub pre:has-text("## a.md")');
  await page.click('#hub form[data-decide] button[value="merge"]');
  await page.waitForSelector('#hub [data-note]:text("Marked merge.")');
  assert.match(await readFile(path.join(server.directory, 'vault', 'Review', 'Inbox', 'librarian-2026-10-16', '_decision.md'), 'utf8'), /^review: merge$/m);
  // The reload after a decision (it clears the note) reopens the window it was in.
  await page.waitForSelector('#hub [data-note]:text("Marked merge.")', { state: 'detached' });
  await page.waitForSelector('#w-inbox[open]');
  // ...and the row Builder had expanded stays expanded (a 15 s notices reload collapsed it under load).
  await page.waitForSelector('#w-inbox details.row[open] pre:has-text("## a.md")');
  await closeWindow();
  // Phone: the same space; the button runs by its ID (no shell, as registry scripts do) and the log opens in place.
  await openWindowWith('Backup now');
  await page.click('#mission summary:has-text("Backup now")');
  await page.click('#mission details:has(summary:has-text("Backup now")) form[data-run] button');
  await page.waitForSelector('#mission details:has(summary:has-text("Backup now")) pre[data-output]:has-text("backup-ok")');
  await page.click('#mission summary:has-text("Backup log")');
  await page.waitForSelector('#mission pre:has-text("backup line 2")');
  await page.screenshot({ path: path.join(evidence, 'phone-mission-window.png') });
  await closeWindow();
  assert.equal(await page.locator('#mission dialog:has(h2:text-is("Notes")) [data-space-text]').textContent(), 'An empty section.');
  assert.equal(await page.locator('#mission .tile:has(span:text-is("Backups")) b').innerText(), '2'); // a button and a log; the text is not counted
  await page.screenshot({ path: path.join(evidence, 'phone-mission-hub.png'), fullPage: true });
  // Phone: the same New idea box, in the Workspace window; this one is a fix, so it lands in _ideas/needs-done/.
  await page.click('#hub [data-open="work"]');
  await page.click('#hub summary:has-text("+ New idea")');
  await page.fill('#hub form[data-idea] input[name="name"]', 'Phone fix');
  await page.fill('#hub form[data-idea] textarea', 'Send button does nothing.');
  await page.check('#hub form[data-idea] input[name="needs"]');
  await page.screenshot({ path: path.join(evidence, 'phone-new-idea.png') });
  await page.click('#hub form[data-idea] button');
  await page.waitForSelector('#hub form[data-idea] [data-note]:has-text("Saved _ideas/needs-done/phone-fix.md.")');
  assert.equal(await readFile(path.join(server.workspace, '_ideas', 'needs-done', 'phone-fix.md'), 'utf8'), 'Send button does nothing.\n');
  await closeWindow();
  // Bad names never reach the file system, and the old hub's code stays read-only.
  const refused = await page.evaluate(async () => {
    const text = await fetch('/mission/hub/text?kind=log&host=laptop&name=..%2Fsecrets.log').then((r) => r.status);
    const file = await fetch('/files?path=hub%2Fmission_control.py').then((r) => r.json());
    const save = await fetch('/files', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-p9-csrf': sessionStorage.getItem('p9-csrf') ?? '', 'x-p9-op': crypto.randomUUID() },
      body: JSON.stringify({ path: 'hub/mission_control.py', hash: file.hash, content: 'import os\n' }) }).then((r) => r.status);
    // The space holds commands too, so it is read-only; a log view is reached only by its ID.
    const space = await fetch('/files?path=p9%2Fmission-space.json').then((r) => r.json());
    const spaceSave = await fetch('/files', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-p9-csrf': sessionStorage.getItem('p9-csrf') ?? '', 'x-p9-op': crypto.randomUUID() },
      body: JSON.stringify({ path: 'p9/mission-space.json', hash: space.hash, content: '{"sections":[]}' }) }).then((r) => r.status);
    const spaceText = await fetch('/mission/hub/text?kind=space&name=..%2Fbackup.log').then((r) => r.status);
    const spaceUnknown = await fetch('/mission/hub/text?kind=space&name=other-log').then((r) => r.status);
    return { text, save, spaceSave, spaceText, spaceUnknown };
  });
  assert.deepEqual(refused, { text: 400, save: 403, spaceSave: 403, spaceText: 400, spaceUnknown: 404 });
  await page.click('[data-nav="usage"]');
  await page.waitForSelector('#usage >> text=$0.2768');
  assert.match(await page.locator('#usage').innerText(), /context[\s\S]*%[\s\S]*of [\d,]+ tokens/i);
  const phoneLimits = await page.locator('#usage [data-limits]').innerText();
  assert.match(phoneLimits, /Claude plan\s+5 h 42% \(resets [^)]+\) · week 17%[^\n]*just now/);
  assert.match(phoneLimits, /Codex plan\s+5 h new window · week 33%[^\n]*3 h old/);
  await page.screenshot({ path: path.join(evidence, 'phone-usage.png') });

  // The browser lists the workspace (folders first, locked names hidden) and taps through folders; no typed path.
  await mkdir(path.join(server.workspace, 'docs')); await writeFile(path.join(server.workspace, 'docs', 'inner.md'), 'inside');
  await mkdir(path.join(server.workspace, '_private'));
  await page.click('[data-nav="files"]');
  await page.waitForSelector('#fileList button[data-name="note.txt"]');
  const names = await page.locator('#fileList button').evaluateAll((buttons) => buttons.map((button) => button.dataset.name));
  assert.ok(names.indexOf('docs') >= 0 && names.indexOf('docs') < names.indexOf('note.txt')); assert.equal(names.includes('_private'), false);
  await page.screenshot({ path: path.join(evidence, 'phone-files.png') });
  await page.click('#fileList button[data-name="docs"]'); await page.waitForSelector('#dirPath:text("docs")');
  await page.click('#fileList button[data-name="inner.md"]'); await page.waitForSelector('#fileState:text("Loaded")');
  assert.equal(await page.locator('.cm-content').textContent(), 'inside');
  await page.click('#closeFile'); await page.click('#up'); await page.waitForSelector('#dirPath:text("Workspace")');
  await page.click('#fileList button[data-name="note.txt"]');
  await page.waitForSelector('#fileState:text("Loaded")');
  // Phase 15: iOS zooms into any focused field under 16px.
  const small = await page.evaluate(() => [...document.querySelectorAll('input, select, textarea, .cm-content')].map((el) => (el.id || el.name || el.className) + ' ' + getComputedStyle(el).fontSize).filter((entry) => parseFloat(entry.split(' ').pop()) < 16));
  assert.deepEqual(small, []);
  const edit = async (text) => { await page.locator('.cm-content').click(); await page.keyboard.press('Control+A'); await page.keyboard.type(text); };
  await edit('saved from phone'); await page.click('#save'); await page.waitForSelector('#fileState:text("Saved")');
  assert.equal(await readFile(path.join(server.workspace, 'note.txt'), 'utf8'), 'saved from phone');
  await edit('discard me'); await page.click('#moreFile'); await page.click('#sheetBody [data-file="discard"]');
  assert.equal(await page.locator('.cm-content').textContent(), 'saved from phone');
  externalEdit(path.join(server.workspace, 'note.txt'));
  await edit('conflicting phone draft'); await page.click('#save'); await page.waitForSelector('#conflict:not([hidden])');
  assert.equal(await readFile(path.join(server.workspace, 'note.txt'), 'utf8'), 'competing');
  await page.screenshot({ path: path.join(evidence, 'phone-editor.png') });

  await context.setOffline(true); await page.waitForSelector('#stale:not([hidden])');
  assert.equal(await page.locator('#save').isDisabled(), true);
  // Offline the Send button queues the message instead (PH2, phone-continue.test.mjs).
  assert.equal(await page.locator('#composer button').textContent(), 'Queue message');
  await context.setOffline(false); await page.waitForFunction(() => document.getElementById('stale').hidden);

  await edit('retry once');
  const ids = [];
  let aborted = false;
  await page.route('**/files', async (route) => {
    ids.push(route.request().headers()['x-p9-op']);
    if (!aborted) { aborted = true; await route.abort(); } else await route.continue();
  });
  await page.click('#save'); await page.waitForTimeout(100);
  await page.click('#save'); await page.waitForSelector('#fileState:text("Conflict")');
  assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]);
  await page.unroute('**/files');

  // Release r2 R2-5: two lost saves, then a retry of the first, keeps the first one's ID.
  const lost = [];
  await page.route('**/files', async (route) => { lost.push(route.request().headers()['x-p9-op']); await route.abort(); });
  await edit('lost A'); await page.click('#save'); await page.waitForTimeout(100);
  await edit('lost B'); await page.click('#save'); await page.waitForTimeout(100);
  await edit('lost A'); await page.click('#save'); await page.waitForTimeout(100);
  await page.unroute('**/files');
  assert.equal(lost.length, 3); assert.notEqual(lost[0], lost[1]); assert.equal(lost[2], lost[0], 'the retried save kept its ID (R2-5)');

  // A received 503 is the daemon's final answer for that ID, so the retry needs a new one (release r1 R1-7).
  await edit('retry after busy');
  const busy = [];
  await page.route('**/files', async (route) => {
    busy.push(route.request().headers()['x-p9-op']);
    if (busy.length === 1) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'stopping' }) });
    else await route.continue();
  });
  await page.click('#save'); await page.waitForTimeout(100);
  await page.click('#save'); await page.waitForTimeout(300);
  assert.equal(busy.length, 2); assert.notEqual(busy[0], busy[1]);
  await page.unroute('**/files');
  // A reopened app has its cookie but no CSRF token: it sends nothing and goes to log in (R1-4).
  const csrfKept = await page.evaluate(() => sessionStorage.getItem('p9-csrf'));
  await page.evaluate(() => sessionStorage.removeItem('p9-csrf'));
  let sentWithout = 0;
  await page.route('**/files', async (route) => { sentWithout += 1; await route.continue(); });
  await edit('no csrf');
  await page.click('#save'); await page.waitForURL(server.origin + '/login');
  assert.equal(sentWithout, 0);
  await page.unroute('**/files');
  await page.goto(server.origin + '/phone/');
  await page.evaluate((csrf) => sessionStorage.setItem('p9-csrf', csrf), csrfKept);
  await page.click('[data-nav="files"]'); await page.click('#fileList button[data-name="note.txt"]'); await page.waitForSelector('#fileState:text("Loaded")');

  let used401;
  await page.route('**/files', async (route) => {
    used401 = route.request().headers()['x-p9-op'];
    await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'login-required' }) });
  });
  await page.click('#save'); await page.waitForURL(server.origin + '/login');
  assert.equal(Object.values(JSON.parse(await page.evaluate(() => localStorage.getItem('p9-pending')))).find(({ id }) => id === used401).used, true);
  await page.unroute('**/files');
  await page.goto(server.origin + '/phone/');
  await page.evaluate((csrf) => sessionStorage.setItem('p9-csrf', csrf), session.csrf);
  await page.click('[data-nav="files"]'); await page.click('#fileList button[data-name="note.txt"]'); await page.waitForSelector('#fileState:text("Loaded")');
  await edit('after relogin');
  let fresh;
  await page.route('**/files', async (route) => { fresh = route.request().headers()['x-p9-op']; await route.continue(); });
  await page.click('#save'); await page.waitForSelector('#fileState:text("Saved")');
  assert.notEqual(fresh, used401);
  await page.unroute('**/files');

  const db = new DatabaseSync(path.join(server.directory, '.local', 'state', 'p9-foundation', 'p9.db'));
  const cursor = Number(db.prepare('SELECT MAX(cursor) AS cursor FROM events').get().cursor);
  db.prepare('INSERT INTO events (cursor, conversation, type, data, at) VALUES (?, ?, ?, ?, ?)')
    .run(cursor + 2, 'fixture-claude', 'turn-end', JSON.stringify({ stopReason: 'end_turn' }), Date.now());
  db.close();
  await page.evaluate((value) => localStorage.setItem('p9-cursor', String(value)), cursor);
  await page.reload();
  await page.waitForSelector('#gap:not([hidden])');
  await page.click('#gap'); await page.waitForSelector('#gap', { state: 'hidden' });
  console.log('PASS phase11 phone: guarded save/discard/conflict, offline refusal, cursor gap, stable retry ID, fresh ID after 401, recorded usage and four 390x844 screenshots');
});

test('Phase 17: phone terminal (threat model surface 13, phone cases 2-4)', async (t) => {
  await mkdir(evidence, { recursive: true });
  const server = await remoteDaemon(t, { setup });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const { page, context } = await signedInPage(browser, server);
  const screen = () => page.locator('#screen .xterm-rows').innerText();
  const shows = (text) => page.waitForFunction((want) => document.querySelector('#screen .xterm-rows')?.textContent.includes(want), text, { timeout: 10000 });
  const type = async (line) => { await page.click('#screen'); await page.keyboard.type(line); await page.keyboard.press('Enter'); };
  const connected = () => page.waitForFunction(() => document.querySelector('#termState').textContent === 'Connected', null, { timeout: 10000 });

  await page.click('[data-nav="terminal"]');
  await page.click('#newTerminal');
  await connected();
  // Typed on the phone, run by the shell; the echo (not the typed line) holds the joined marker.
  await type('echo P9-PHONE-4""2');
  await shows('P9-PHONE-42');
  await page.screenshot({ path: path.join(evidence, 'phone-terminal.png') });
  // Resize: the shell sees the phone's width, and a wider screen widens it.
  await type('echo COLS-$(tput cols)-END');
  await shows('-END');
  const cols = async () => Number([...(await screen()).matchAll(/COLS-(\d+)-END/g)].at(-1)?.[1]);
  const narrow = await cols();
  assert.ok(narrow >= 20 && narrow < 60, 'phone columns ' + narrow);
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(300);
  await type('clear; echo COLS-$(tput cols)-END');
  await page.waitForFunction((old) => { const m = /COLS-(\d+)-END/.exec(document.querySelector('#screen .xterm-rows').textContent); return m && Number(m[1]) !== old; }, narrow, { timeout: 10000 });
  assert.ok((await cols()) > narrow, 'wider screen gives more columns');
  await page.setViewportSize({ width: 390, height: 844 });
  // Case 4: hostile output is text. No script runs, OSC 52 does not write the clipboard, and the markup shows literally.
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.origin });
  await page.evaluate(() => navigator.clipboard.writeText('clipboard-before'));
  // Every way out is counted: a clipboard write, a confirm prompt, a window.open.
  await page.evaluate(() => {
    const calls = window.p9calls = { clip: 0, confirm: 0, open: 0 };
    const write = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = (text) => { calls.clip++; return write(text); };
    window.confirm = () => { calls.confirm++; return true; };
    window.open = () => { calls.open++; return null; };
  });
  await type("clear; printf '<img src=x onerror=window.p9pwn=1>\\x1b]52;c;cDlwd24=\\x07%s-OK\\n' HOSTILE");
  await shows('HOSTILE-OK');
  assert.ok((await screen()).includes('<img src=x onerror=window.p9pwn=1>'));
  assert.equal(await page.evaluate(() => window.p9pwn), undefined);
  assert.equal(await page.locator('#screen img').count(), 0);
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'clipboard-before');
  // An OSC 8 link, hovered and tapped, opens nothing (xterm's core would confirm and then window.open).
  await type("clear; printf '\\x1b]8;;https://attacker.example/\\x07TAPLINK\\x1b]8;;\\x07 %s\\n' LINK-OK");
  await shows('LINK-OK');
  const link = await page.locator('#screen .xterm-rows span', { hasText: 'TAPLINK' }).first().boundingBox();
  await page.mouse.move(link.x + 5, link.y + link.height / 2);
  await page.mouse.move(link.x + 15, link.y + link.height / 2);
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(300);
  assert.deepEqual(await page.evaluate(() => window.p9calls), { clip: 0, confirm: 0, open: 0 });
  // Case 3: keys typed while offline are dropped, not replayed when the terminal reconnects.
  await context.setOffline(true);
  await page.waitForFunction(() => document.querySelector('#termState').textContent.startsWith('Offline'));
  await type('echo P9-OFF-4""2');
  await context.setOffline(false);
  await page.click('#refreshTerminal');
  await connected();
  await type('echo P9-ON-4""2');
  await shows('P9-ON-42');
  assert.ok(!(await screen()).includes('P9-OFF'), 'an offline key reached the shell');
  // Case 3, stalled page: a paste whose input event is 6.5 s older than the newest lease goes out with the lease the
  // page held when it happened, so the daemon refuses it (4408) rather than running it with a fresh lease.
  await page.evaluate(async () => {
    const data = new DataTransfer(); data.setData('text/plain', 'echo P9-STALL-4""2\r');
    const old = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    await new Promise((resolve) => setTimeout(resolve, 6500));
    document.querySelector('#screen .xterm-helper-textarea').dispatchEvent(old);
  });
  await page.waitForFunction(() => document.querySelector('#termState').textContent.startsWith('Closed'), null, { timeout: 5000 });
  await page.click('#refreshTerminal');
  await connected();
  await type('echo P9-AFTER-4""2');
  await shows('P9-AFTER-42');
  assert.ok(!(await screen()).includes('P9-STALL-42'), 'an input event older than its lease reached the shell');
  // Same for IME text: the composition ended 6.5 s before a keydown forces xterm to send it at once (window.event is
  // then the new keydown). It goes out stamped with the compositionend time, so it never reaches the shell.
  await page.evaluate(async () => {
    const area = document.querySelector('#screen .xterm-helper-textarea'), text = 'echo P9-IME-4""2';
    area.focus();
    area.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
    area.value += text; area.selectionStart = area.selectionEnd = area.value.length;
    area.dispatchEvent(new CompositionEvent('compositionupdate', { data: text, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const ended = new CompositionEvent('compositionend', { data: text, bubbles: true });
    await new Promise((resolve) => setTimeout(resolve, 6500));
    area.dispatchEvent(ended);
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(1500);
  await page.click('#refreshTerminal');
  await connected();
  await type('echo P9-AFTERIME-4""2');
  await shows('P9-AFTERIME-42');
  assert.ok(!(await screen()).includes('P9-IME-42'), 'IME text older than its lease reached the shell');
  // Two stalled events in one burst: a keydown 229 (its reset timer queues first) then compositionend; the IME text
  // that xterm sends on its later timer still carries the old time.
  await page.evaluate(async () => {
    const area = document.querySelector('#screen .xterm-helper-textarea'), text = 'echo P9-TWO-4""2\r';
    area.focus();
    area.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
    area.value += text; area.selectionStart = area.selectionEnd = area.value.length;
    area.dispatchEvent(new CompositionEvent('compositionupdate', { data: text, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const key = new KeyboardEvent('keydown', { key: 'Process', keyCode: 229, bubbles: true, cancelable: true });
    const ended = new CompositionEvent('compositionend', { data: text, bubbles: true });
    await new Promise((resolve) => setTimeout(resolve, 6500));
    area.dispatchEvent(key);
    area.dispatchEvent(ended);
  });
  await page.waitForTimeout(1500);
  await page.click('#refreshTerminal');
  await connected();
  await type('echo P9-AFTERTWO-4""2');
  await shows('P9-AFTERTWO-42');
  assert.ok(!(await screen()).includes('P9-TWO-42'), 'IME text after an earlier reset timer reached the shell');
  // Case 2 (phone half): a locked device's terminal shows closed, with typing and the key row disabled.
  const devices = (await server.desk('/devices')).body.devices;
  assert.equal(devices.length, 1);
  assert.equal((await server.desk('/devices/' + devices[0].id + '/lock', 'POST')).status, 200);
  await page.waitForFunction(() => document.querySelector('#termState').textContent.startsWith('Closed'), null, { timeout: 2000 });
  assert.equal(await page.locator('#keys button:not([disabled])').count(), 0);
  await page.screenshot({ path: path.join(evidence, 'phone-terminal-closed.png') });
});

test('Issue #11: with no terminal backend the phone says so with the reason, never Not connected', async (t) => {
  const server = await remoteDaemon(t, { setup, args: ['--terminal-platform', 'darwin'] });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const { page } = await signedInPage(browser, server);
  const state = () => page.locator('#termState').textContent();
  const want = "Terminal isn't available on this computer yet: P9 has no terminal for macOS yet.";
  await page.click('[data-nav="terminal"]');
  await page.waitForFunction((text) => document.querySelector('#termState').textContent === text, want, { timeout: 10000 });
  // ponytail: the dev space runs tests with no network, so Chromium says navigator.onLine is false and phone.ts keeps
  // New terminal disabled (Phase 11 and 17 time out on that too); say online here rather than change the sandbox.
  await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { get: () => true }); dispatchEvent(new Event('online')); });
  await page.click('#newTerminal');
  await page.waitForTimeout(500);
  assert.equal(await state(), want);
  await page.screenshot({ path: path.join(evidence, 'phone-terminal-unavailable.png') });
  console.log('PASS phone, no backend: Terminal tab and New terminal both say ' + JSON.stringify(want));
});

test('Phase 11: malformed and stale usage are explicit and never stop the daemon', async (t) => {
  const server = await remoteDaemon(t, { setup });
  const authBrowser = await chromium.launch(); t.after(() => authBrowser.close());
  const auth = await enrollDevice(server, await passkeyDevice(authBrowser, server, 'usage-state'));
  const db = new DatabaseSync(path.join(server.directory, '.local', 'state', 'p9-foundation', 'p9.db'));
  db.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)').run('bad', 'update', '{bad', Date.now());
  db.close();
  const unavailable = await server.remote('/usage', { session: auth });
  assert.equal(unavailable.status, 200); assert.equal(unavailable.body.state, 'unavailable'); assert.equal(unavailable.body.discarded, 1);
  assert.equal((await server.remote('/health', { session: auth })).status, 200);
  const old = new DatabaseSync(path.join(server.directory, '.local', 'state', 'p9-foundation', 'p9.db'));
  old.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)').run('old', 'update', JSON.stringify({ sessionUpdate: 'usage_update', used: 1, size: 2, cost: { amount: 0.01, currency: 'USD' } }), Date.now() - 16 * 60 * 1000);
  old.close();
  assert.equal((await server.remote('/usage', { session: auth })).body.state, 'stale');
  console.log('PASS phase11 usage: malformed row discarded, unavailable and stale explicit, health remains 200');
  // F2: the phone never gets the workspace path, from /health, /setup or a failed New idea save.
  const { workspace } = (await server.desk('/health')).body;
  assert.ok(workspace);
  const health = await server.remote('/health', { session: auth });
  assert.equal(health.body.workspace, undefined);
  assert.ok(!health.text.includes(workspace), health.text);
  assert.equal((await server.desk('/setup')).status, 200);
  assert.equal((await server.remote('/setup', { session: auth })).status, 404);
  assert.equal((await server.remote('/setup/settings', { session: auth })).status, 404);
  // The wizard's writes, sign-in and Settings → Mission Control files are desktop-only too (threat model rows 17, 31).
  for (const route of ['/setup/starter', '/setup/settings', '/setup/login', '/setup/login/code', '/setup/login/stop', '/setup/agent-terminal']) assert.equal((await server.remote(route, { method: 'POST', session: auth, body: {} })).status, 404, route);
  await chmod(path.join(server.workspace, '_ideas'), 0o500);
  try {
    const idea = await server.remote('/mission/idea', { method: 'POST', session: auth, body: { name: 'blocked', text: 'x', needs_done: false } });
    assert.deepEqual([idea.status, idea.body], [403, { error: 'storage-unavailable' }]);
    assert.ok(!idea.text.includes(workspace), idea.text);
  } finally { await chmod(path.join(server.workspace, '_ideas'), 0o755); }
  console.log('PASS F2: no workspace path to the phone from /health, /setup or a refused idea');
});
