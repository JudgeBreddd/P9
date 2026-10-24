// Phase 13: Anymouse. With a token the daemon files a GitHub issue (stand-in API on loopback), labelled by kind; without
// one it answers with GitHub's prefilled new-issue page. DUWOP's length and rate limits hold, and no page sees the token.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { _electron } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { daemon, http, authenticated, root } from './helpers.mjs';
import { createAnymouse, NEW_ISSUE, REPO } from '../apps/server/anymouse.mjs';

const TOKEN = 'ghp_' + 'x'.repeat(36);
async function fakeGitHub(t, status = 201) {
  const seen = [];
  const server = createServer((req, res) => {
    let text = '';
    req.on('data', (c) => { text += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(text) });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ number: 7, html_url: 'https://github.com/' + REPO + '/issues/7' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { api: 'http://127.0.0.1:' + server.address().port, seen };
}
const call = (instance, body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route: '/anymouse', method: 'POST',
  headers: { ...authenticated(instance.credentials), 'content-type': 'application/json', 'x-p9-op': randomUUID() },
  body: JSON.stringify(body) }).then((r) => ({ status: r.status, body: JSON.parse(r.text) }));

test('Anymouse through the daemon: token files an issue, no token returns the prefilled page', async (t) => {
  const gh = await fakeGitHub(t);
  const withToken = await daemon(t, undefined, false, () => ({ env: { P9_GITHUB_TOKEN: TOKEN, P9_GITHUB_API: gh.api } }));
  const filed = await call(withToken, { kind: 'bug', text: 'Save button @tyler\nsecond line', page: 'chat' });
  assert.deepEqual(filed, { status: 200, body: { ok: true, number: 7, url: 'https://github.com/' + REPO + '/issues/7' } });
  assert.equal(gh.seen.length, 1);
  const [req] = gh.seen;
  assert.equal(req.url, '/repos/' + REPO + '/issues');
  assert.equal(req.auth, 'Bearer ' + TOKEN);
  assert.deepEqual(req.body.labels, ['bug']);
  assert.equal(req.body.title, 'Bug: Save button @​tyler');
  assert.match(req.body.body, /Sent with Anymouse from P9 \(chat\)/);
  assert.equal(JSON.stringify(filed).includes(TOKEN), false);
  assert.equal((await call(withToken, { kind: 'idea', text: '   ' })).status, 400);
  assert.equal((await call(withToken, { kind: 'idea', text: 'x'.repeat(50_001) })).status, 400);
  assert.equal(gh.seen.length, 1, 'refused notes never reach GitHub');

  const noToken = await daemon(t);
  const prefilled = await call(noToken, { kind: 'gripe', text: 'too many clicks' });
  assert.equal(prefilled.status, 200);
  assert.ok(prefilled.body.open.startsWith(NEW_ISSUE));
  const q = new URL(prefilled.body.open).searchParams;
  assert.deepEqual([q.get('title'), q.get('labels')], ['Gripe: too many clicks', 'gripe']);
});

test('Anymouse limits: an unknown kind is an idea, the rate limit holds, a GitHub refusal is reported', async (t) => {
  const gh = await fakeGitHub(t);
  const send = createAnymouse({ token: TOKEN, api: gh.api, limit: 2 });
  assert.equal((await send({ kind: 'exec', text: 'a' })).status, 200);
  assert.deepEqual(gh.seen[0].body.labels, ['idea']);
  assert.equal((await send({ text: 'b' })).status, 200);
  assert.equal((await send({ text: 'c' })).status, 429);
  assert.equal(gh.seen.length, 2);
  const refusing = await fakeGitHub(t, 403);
  assert.deepEqual(await createAnymouse({ token: TOKEN, api: refusing.api })({ text: 'd' }), { status: 502, error: 'GitHub refused it (403)' });
});

test('Anymouse in the desktop: the box sends, and with no token main opens only the prefilled GitHub page', { timeout: 90000 }, async (t) => {
  const instance = await daemon(t);
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-anymouse-')), opened = path.join(home, 'opened.txt'), browser = path.join(home, 'browser');
  await writeFile(browser, '#!/bin/sh\nprintf "%s\\n" "$1" > ' + opened + '\n');
  await chmod(browser, 0o755);
  const env = { ...process.env, P9_OPEN_URL: browser }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + path.join(home, 'profile')], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#amBtn').click();
  await page.locator('[data-kind="bug"]').click();
  assert.equal(await page.locator('#amSend').isDisabled(), true);
  await page.locator('#amText').fill('<img src=x onerror=alert(1)> the save button');
  await page.locator('#amSend').click();
  await page.locator('#amNote', { hasText: 'Opened GitHub' }).waitFor({ timeout: 10000 });
  assert.equal(await page.locator('#amDlg img').count(), 0, 'the note never becomes markup');
  // The repo is private: the page says why GitHub may show 404 and keeps the note to copy (GitHub issue #4 item 6).
  assert.match(await page.locator('#amNote').innerText(), /private, so GitHub shows "404" unless you are signed in/);
  assert.equal(await page.locator('#amText').inputValue(), '<img src=x onerror=alert(1)> the save button');
  let url = '';
  for (let i = 0; i < 50 && !url; i++) { url = await readFile(opened, 'utf8').catch(() => ''); if (!url) await new Promise((r) => setTimeout(r, 100)); }
  assert.ok(url.startsWith(NEW_ISSUE), url);
  const q = new URL(url.trim()).searchParams;
  assert.deepEqual([q.get('title'), q.get('labels')], ['Bug: <img src=x onerror=alert(1)> the save button', 'bug']);
  // Main opens nothing but the P9 new-issue page, whatever the daemon answers.
  const refused = await app.evaluate(async ({ ipcMain, BrowserWindow }) => {
    const sender = BrowserWindow.getAllWindows()[0].webContents, handler = ipcMain._invokeHandlers.get('p9:anymouse'), frame = { sender, senderFrame: sender.mainFrame };
    const results = [];
    for (const args of [[], [{ text: 'a' }, 'extra'], [['a']]]) { try { await handler(frame, ...args); results.push(false); } catch (e) { results.push(e.message === 'ipc-sender-refused'); } }
    return results;
  });
  assert.deepEqual(refused, [true, true, true]);
});

test('M4: 50,000 characters go through; one more is refused with its count; a tokenless link keeps to GitHub\'s size and says it cut', async (t) => {
  const gh = await fakeGitHub(t);
  const send = createAnymouse({ token: TOKEN, api: gh.api });
  assert.equal((await send({ text: 'x'.repeat(50_000) })).status, 200);
  const over = await send({ text: 'x'.repeat(50_001) });
  assert.deepEqual(over, { status: 400, error: 'keep it under 50,000 characters (it is 50,001)' });
  assert.equal(gh.seen.length, 1);
  const link = await createAnymouse()({ text: 'y'.repeat(50_000) });
  assert.equal(link.status, 200);
  assert.equal(link.cut, true);
  assert.ok(link.open.length <= 7200, String(link.open.length));
  assert.equal((await createAnymouse()({ text: 'short' })).cut, undefined);
});

// ---- v0.1.5 chunk 3: the screenshots the owner opens. The run's volume is thrown away, so each PNG is also printed to the log as
// "P9_SHOT <name> <base64>" (not on GitHub). Also asserts what the pictures show.
test('v0.1.5 c3 screenshots: counter, dropdown, refused character, restart notice', { timeout: 60000 }, async (t) => {
  const { mkdir } = await import('node:fs/promises');
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-c3shots-'));
  const instance = await daemon(t, undefined, false, async (paths) => {
    const settings = path.join(paths.directory, 'settings.json');
    await writeFile(settings, JSON.stringify({ waiting: '_waiting', registry: 'hub/registry.json', primary: 'projects/AGENTS.md' }));
    const ws = path.join(paths.directory, 'work'); // the default folder the daemon falls back to
    for (const dir of ['_waiting', 'hub', 'projects/event-horizon']) await mkdir(path.join(ws, dir), { recursive: true });
    await writeFile(path.join(ws, 'hub/registry.json'), JSON.stringify({ scripts: [
      { id: 'tag', title: 'Tag release', cmd: ['tag.cmd'], args: ['Tag name'] },
      { id: 'mode', title: 'Pick mode', cmd: ['true'], args: [{ label: 'Mode', choices: ['fast', 'slow'] }] }] }));
    await writeFile(path.join(ws, 'projects/AGENTS.md'), '# Projects\n\n**Main project: P9 — Event Horizon** (`event-horizon/`)\n');
    await writeFile(path.join(ws, 'projects/event-horizon/AGENTS.md'), '# P9\n\n**Status:** **Open**\n');
    await writeFile(path.join(ws, '_waiting/AGENTS.md'), '# How this folder works\n');
    // The later --workspace wins: a saved folder that is not there at start, which is the one restart reason.
    return { args: ['--settings', settings, '--workspace', path.join(home, 'gone')] };
  });
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + path.join(home, 'profile')], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  const shot = async (name, locator) => {
    const png = await locator.screenshot({ type: 'png' });
    // Not on GitHub: gh run view --log drops every line after a 300 KB one, which hid a real failure for three runs.
    if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png.toString('base64'));
    if (process.env.P9_SCREENSHOTS) { await mkdir(process.env.P9_SCREENSHOTS, { recursive: true }); await writeFile(path.join(process.env.P9_SCREENSHOTS, name + '.png'), png); }
  };
  const closeModal = async () => { await page.click('#mdlX'); await page.locator('#mdl[open]').waitFor({ state: 'detached', timeout: 5000 }); };
  const openScript = async (title) => {
    const tiles = page.locator('#fMission [data-group]');
    for (let i = 0; i < await tiles.count(); i++) {
      await tiles.nth(i).click();
      const item = page.locator('#mdlBody li button', { hasText: title });
      if (await item.count()) { await item.first().click(); return; }
      await closeModal();
    }
    throw new Error('no script ' + title);
  };
  await page.click('#rMission');
  const notice = page.locator('#fMission [data-restart]');
  await notice.waitFor({ timeout: 15000 });
  assert.match(await notice.innerText(), /Restart P9 to apply/);
  await shot('restart-notice', page.locator('#fMission'));
  await openScript('Pick mode');
  const select = page.locator('#mdlBody select[data-arg]');
  assert.deepEqual(await select.locator('option').allInnerTexts(), ['(none)', 'fast', 'slow']);
  await select.selectOption('slow');
  await shot('choices-dropdown', page.locator('#mdl'));
  await closeModal();
  await openScript('Tag release');
  await page.locator('#mdlBody input[data-arg]').fill('v1&v2');
  await page.click('#mdlFoot [data-run]');
  await page.locator('#mdlBody .out', { hasText: '&' }).waitFor({ timeout: 10000 });
  await shot('refused-character', page.locator('#mdl'));
  await closeModal();
  await page.click('#amBtn');
  await page.locator('#amText').fill('x'.repeat(50001));
  assert.match(await page.locator('#amCount').innerText(), /50,001 \/ 50,000.*1 too many/);
  assert.equal(await page.locator('#amSend').isDisabled(), true);
  assert.equal((await page.locator('#amText').inputValue()).length, 50001, 'the text is kept');
  await shot('anymouse-counter', page.locator('#amDlg'));
});

// ---- v0.1.5 chunk 4: Mission notes on the desktop (threat model row 34), with the screenshots for the report (P9_SHOT, as above).
test('v0.1.5 c4 notes: list, preview, edit, conflict, rename', { timeout: 60000 }, async (t) => {
  const { mkdir } = await import('node:fs/promises');
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-c4notes-'));
  let vault;
  const instance = await daemon(t, undefined, false, async (paths) => {
    const ws = paths.workspace, settings = path.join(paths.directory, 'settings.json');
    vault = path.join(paths.directory, 'Vault');
    for (const dir of ['_waiting', 'hub', 'projects']) await mkdir(path.join(ws, dir), { recursive: true });
    await writeFile(path.join(ws, 'hub/registry.json'), JSON.stringify({ scripts: [] }));
    await writeFile(path.join(ws, 'projects/AGENTS.md'), '# Projects\n');
    await writeFile(path.join(ws, 'space.json'), JSON.stringify({ sections: [{ title: 'Journal', text: 'The notes vault.', notes: 'vault' }] }));
    await writeFile(settings, JSON.stringify({ waiting: '_waiting', registry: 'hub/registry.json', primary: 'projects/AGENTS.md', space: 'space.json', notes_roots: { vault } }));
    for (const dir of ['Daily', 'Projects', '.obsidian']) await mkdir(path.join(vault, dir), { recursive: true });
    const notes = [['Projects/Garden.md', '# Garden\n\n- [ ] order seeds\n- [x] fix the fence\n'],
      ['Daily/2026-10-22.md', '# Thursday\n\nQuiet day.\n'],
      ['Welcome.md', '# Welcome\n\nThis vault lives **outside** the workspace.\n\n## Today\n\n1. Read\n2. Write `notes`\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[a link](https://example.com)\n']];
    for (const [name, text] of notes) { await writeFile(path.join(vault, name), text); await new Promise((r) => setTimeout(r, 20)); }
    await writeFile(path.join(vault, '.obsidian', 'app.md'), 'hidden');
    return { args: ['--settings', settings] };
  });
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + path.join(home, 'profile')], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  const shot = async (name, locator) => {
    const png = await locator.screenshot({ type: 'png' });
    console.log('P9_SHOT ' + name + ' ' + png.toString('base64'));
    if (process.env.P9_SCREENSHOTS) { await mkdir(process.env.P9_SCREENSHOTS, { recursive: true }); await writeFile(path.join(process.env.P9_SCREENSHOTS, name + '.png'), png); }
  };
  await page.click('#rMission');
  await page.locator('#fMission [data-group="Journal"]').click({ timeout: 15000 });
  await page.click('#mdlBody [data-notes="vault"]');
  await page.locator('#mdlBody [data-i]').first().waitFor({ timeout: 10000 });
  assert.deepEqual(await page.locator('#mdlBody [data-i] > .truncate:not(.sub)').allInnerTexts(), ['Welcome.md', 'Daily/2026-10-22.md', 'Projects/Garden.md']);
  assert.match(await page.locator('#mdlFoot [data-notes-count]').innerText(), /^3 notes$/);
  await shot('notes-list', page.locator('#mdl'));
  await page.locator('#mdlBody [data-i]', { hasText: 'Welcome.md' }).click();
  const preview = page.locator('#mdlBody [data-preview]');
  await preview.locator('h1', { hasText: 'Welcome' }).waitFor({ timeout: 10000 });
  assert.equal(await preview.locator('script, img, a, [onerror]').count(), 0, 'note HTML stays text');
  assert.match(await preview.innerText(), /<script>alert\(1\)<\/script>/);
  await shot('notes-preview', page.locator('#mdl'));
  // Edit, then the note changes on disk before Ctrl+S: the banner, not an overwrite
  const file = path.join(vault, 'Welcome.md'), outside = '# Welcome\n\nEdited in the notes app.\n';
  await page.click('#mdlFoot [data-mode]');
  await page.locator('#mdlEd').fill('# Welcome\n\nEdited in P9.\n');
  await writeFile(file, outside);
  await page.locator('#mdlEd').press('Control+s');
  await page.locator('#mdlBody [data-conflict]').waitFor({ timeout: 10000 });
  assert.equal(await readFile(file, 'utf8'), outside);
  assert.equal(await page.locator('#mdlEd').inputValue(), '# Welcome\n\nEdited in P9.\n', 'the draft is kept');
  await shot('notes-conflict', page.locator('#mdl'));
  await page.click('#mdlBody [data-mine]');
  await page.locator('#mdlBody [data-conflict]').waitFor({ state: 'detached', timeout: 10000 });
  assert.equal(await readFile(file, 'utf8'), '# Welcome\n\nEdited in P9.\n');
  // Rename to a free name: the title follows, the old name is gone
  await page.click('#mdlFoot [data-rename-open]');
  await page.locator('#mdlFoot [data-rename]').fill('Start');
  await page.click('#mdlFoot [data-rename-go]');
  await page.locator('#mdlT', { hasText: 'Start.md' }).waitFor({ timeout: 10000 });
  assert.equal(await readFile(path.join(vault, 'Start.md'), 'utf8'), '# Welcome\n\nEdited in P9.\n');
  await assert.rejects(readFile(file, 'utf8'));
  console.log('PASS notes desktop: list newest first without .obsidian; preview keeps note HTML as text; a change on disk is a banner, Save mine over it writes; rename');
});

// ---- v0.1.5 chunk D: the Mission edit form for names and icons, with the screenshots for the report (P9_SHOT, as above).
test('v0.1.5 cD mission editor: File protection asks first, an icon shows on the tile, a stale file is refused', { timeout: 90000 }, async (t) => {
  const { mkdir } = await import('node:fs/promises');
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-cdedit-'));
  let registry;
  const instance = await daemon(t, undefined, false, async (paths) => {
    const ws = paths.workspace, settings = path.join(paths.directory, 'settings.json');
    registry = path.join(ws, 'hub/registry.json');
    for (const dir of ['_waiting', 'hub', 'projects']) await mkdir(path.join(ws, dir), { recursive: true });
    await writeFile(registry, JSON.stringify({ scripts: [], apps: [{ id: 'editor', title: 'Editor', cmd: ['true'] }, { id: 'board', title: 'Board', cmd: ['true'] }], pages: [{ id: 'docs', title: 'Docs', url: 'http://127.0.0.1:9/' }] }, null, 2) + '\n');
    await writeFile(path.join(ws, 'projects/AGENTS.md'), '# Projects\n');
    await writeFile(path.join(ws, 'space.json'), JSON.stringify({ sections: [{ title: 'Journal', text: 'The notes.' }] }));
    await writeFile(settings, JSON.stringify({ waiting: '_waiting', registry: 'hub/registry.json', primary: 'projects/AGENTS.md', space: 'space.json' }));
    return { args: ['--settings', settings] };
  });
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + path.join(home, 'profile')], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  const shot = async (name, locator) => {
    const png = await locator.screenshot({ type: 'png' });
    console.log('P9_SHOT ' + name + ' ' + png.toString('base64'));
    if (process.env.P9_SCREENSHOTS) { await mkdir(process.env.P9_SCREENSHOTS, { recursive: true }); await writeFile(path.join(process.env.P9_SCREENSHOTS, name + '.png'), png); }
  };
  await page.click('#rMission');
  await page.locator('#fMission [data-medit]').click({ timeout: 15000 });
  const row = (i) => page.locator(`#mdlBody [data-row="${i}"]`);
  await row(0).waitFor({ timeout: 10000 });
  assert.equal(await page.locator('#mdlBody [data-row]').count(), 4, 'two apps, one link, one section');
  const before = await readFile(registry, 'utf8');
  // File protection is on: the first Save only arms the button, the file is untouched.
  await row(0).locator('[data-ic]').fill('🧪');
  await row(0).locator('[data-t]').fill('Code editor');
  await row(0).locator('[data-save]').click();
  assert.match(await row(0).locator('[data-save]').innerText(), /Confirm save/);
  assert.equal(await readFile(registry, 'utf8'), before, 'asked first, wrote nothing');
  await shot('editor-confirm', page.locator('#mdl'));
  await row(0).locator('[data-save]').click();
  await page.locator('#mdlBody [data-row="0"] [data-msg]', { hasText: 'Saved.' }).waitFor({ timeout: 10000 });
  const saved = JSON.parse(await readFile(registry, 'utf8')).apps[0];
  assert.deepEqual([saved.title, saved.icon], ['Code editor', '🧪']);
  // The file changes underneath the open form: the next Save is refused with the banner, nothing is overwritten.
  const outside = JSON.stringify({ scripts: [], apps: [{ id: 'editor', title: 'Code editor', icon: '🧪', cmd: ['true'] }, { id: 'board', title: 'Board', cmd: ['true'] }, { id: 'extra', title: 'Extra', cmd: ['true'] }], pages: [{ id: 'docs', title: 'Docs', url: 'http://127.0.0.1:9/' }] }, null, 2) + '\n';
  await writeFile(registry, outside);
  await row(1).locator('[data-ic]').fill('B');
  await row(1).locator('[data-save]').click();
  await row(1).locator('[data-save]', { hasText: 'Confirm save' }).click();
  await page.locator('#mdlBody [data-medit-stale]').waitFor({ timeout: 10000 });
  assert.equal(await readFile(registry, 'utf8'), outside, 'a stale form never overwrites');
  await shot('editor-stale', page.locator('#mdl'));
  await page.click('#mdlBody [data-medit-reload]');
  await page.locator('#mdlBody [data-row="2"]').waitFor({ timeout: 10000 });
  assert.equal(await page.locator('#mdlBody [data-row]').count(), 5, 'the reload shows the file as it is now');
  // Close the form: the icon is on the tile.
  await page.keyboard.press('Escape');
  await page.locator('#fMission [data-panel="mlaunch"] .ltile', { hasText: '🧪' }).waitFor({ timeout: 10000 });
  await shot('tile-with-icon', page.locator('#fMission [data-panel="mlaunch"]'));
  console.log('PASS mission editor: Save asked first under File protection, the icon shows on the tile, a stale file is refused and reloads');
});
