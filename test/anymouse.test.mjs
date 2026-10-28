// Phase 13: Anymouse. With a token the daemon files a GitHub issue (stand-in API on loopback), labelled by kind; without
// one it answers with GitHub's prefilled new-issue page. DUWOP's length and rate limits hold, and no page sees the token.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import zlib from 'node:zlib';
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
  const filed = await call(withToken, { kind: 'bug', text: 'Save button @sam\nsecond line', page: 'chat' });
  assert.deepEqual(filed, { status: 200, body: { ok: true, number: 7, url: 'https://github.com/' + REPO + '/issues/7' } });
  assert.equal(gh.seen.length, 1);
  const [req] = gh.seen;
  assert.equal(req.url, '/repos/' + REPO + '/issues');
  assert.equal(req.auth, 'Bearer ' + TOKEN);
  assert.deepEqual(req.body.labels, ['bug']);
  assert.equal(req.body.title, 'Bug: Save button @​sam');
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
  const failing = await fakeGitHub(t, 500);
  assert.deepEqual(await createAnymouse({ token: TOKEN, api: failing.api })({ text: 'd' }), { status: 502, error: 'GitHub refused it (500)' });
});

// Correction 13: a refused token (401, 403) says why and what to do, and the same note can go the tokenless way instead.
test('Anymouse on a refused token: the reply says why and the fix, and browser: true returns the prefilled page', async (t) => {
  for (const status of [401, 403]) {
    const gh = await fakeGitHub(t, status);
    const send = createAnymouse({ token: TOKEN, api: gh.api });
    const refused = await send({ kind: 'bug', text: 'the save button' });
    assert.equal(refused.status, 502);
    assert.equal(refused.refused, true);
    assert.match(refused.error, new RegExp('^GitHub refused the token P9 files notes with \\(' + status + ': ' + (status === 401 ? 'wrong or expired' : 'it lacks Issues write on ' + REPO) + '\\)'));
    assert.match(refused.error, /Issues: Read and write/);
    assert.match(refused.error, /Open on GitHub/);
    assert.equal(refused.error.includes(TOKEN), false);
    const web = await send({ kind: 'bug', text: 'the save button', browser: true });
    assert.equal(web.status, 200);
    assert.ok(web.open.startsWith(NEW_ISSUE));
    assert.deepEqual([new URL(web.open).searchParams.get('title'), new URL(web.open).searchParams.get('labels')], ['Bug: the save button', 'bug']);
    assert.equal(gh.seen.length, 1, 'the browser path never calls GitHub with the token');
  }
});

test('Anymouse in the desktop on a refused token: the box explains, keeps the note, and Open on GitHub opens the prefilled page', { timeout: 90000 }, async (t) => {
  const gh = await fakeGitHub(t, 403);
  const instance = await daemon(t, undefined, false, () => ({ env: { P9_GITHUB_TOKEN: TOKEN, P9_GITHUB_API: gh.api } }));
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-anymouse-403-')), opened = path.join(home, 'opened.txt'), browser = path.join(home, 'browser');
  await writeFile(browser, '#!/bin/sh\nprintf "%s\\n" "$1" > ' + opened + '\n');
  await chmod(browser, 0o755);
  const env = { ...process.env, P9_OPEN_URL: browser }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + path.join(home, 'profile')], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#amBtn').click();
  assert.equal(await page.locator('#amWeb').isHidden(), true);
  await page.locator('#amText').fill('the save button eats my edits');
  await page.locator('#amSend').click();
  await page.locator('#amNote', { hasText: 'GitHub refused the token' }).waitFor({ timeout: 10000 });
  assert.match(await page.locator('#amNote').innerText(), /Issues: Read and write/);
  assert.equal(await page.locator('#amText').inputValue(), 'the save button eats my edits');
  await page.locator('#amWeb:visible').waitFor({ timeout: 5000 });
  const png = await page.locator('#amDlg').screenshot();
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT anymouse-refused-token ' + png.toString('base64'));
  await page.locator('#amWeb').click();
  await page.locator('#amNote', { hasText: 'Opened GitHub' }).waitFor({ timeout: 10000 });
  assert.equal(await page.locator('#amText').inputValue(), 'the save button eats my edits');
  assert.equal(await page.locator('#amWeb').isHidden(), true);
  let url = '';
  for (let i = 0; i < 50 && !url; i++) { url = await readFile(opened, 'utf8').catch(() => ''); if (!url) await new Promise((r) => setTimeout(r, 100)); }
  assert.ok(url.startsWith(NEW_ISSUE), url);
  assert.equal(new URL(url.trim()).searchParams.get('title'), 'Idea: the save button eats my edits');
  assert.equal(gh.seen.length, 1, 'only the first Send reached GitHub');
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
  // The note stays to copy (GitHub issue #4 item 6). The repo is public now, so no "private ... 404" warning.
  assert.match(await page.locator('#amNote').innerText(), /^Opened GitHub in your browser: finish the issue there\. Your note is still here to copy\./);
  assert.doesNotMatch(await page.locator('#amNote').innerText(), /private|404/);
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

// D13: no GitHub token ships with P9 (the daemon reads one only from its own environment, which no installer sets), so a
// tester's note goes out as the prefilled link: at most 7,000 characters, and the reply says how much of the note it kept.
test('D13: the tokenless link stays within 7,000 characters, keeps the start of the note, and says how much', { timeout: 60000 }, async () => {
  for (const name of ['scripts/install.sh', 'scripts/install-service.mjs', 'scripts/install-windows.ps1', 'scripts/installer.nsh', 'scripts/package-windows.mjs', 'scripts/package-linux.mjs', 'package.json']) {
    const text = await readFile(path.join(root, name), 'utf8');
    assert.doesNotMatch(text, /GITHUB_TOKEN|ghp_|github_pat_/, name + ' ships no token');
  }
  const note = Array.from({ length: 1500 }, (_, i) => 'line ' + i + ' of a long bug report').join('\n');
  assert.ok(note.length > 30000 && note.length < 50000, String(note.length));
  const r = await createAnymouse()({ kind: 'bug', text: note });
  assert.equal(r.status, 200);
  assert.ok(r.open.startsWith(NEW_ISSUE), r.open.slice(0, 60));
  assert.ok(r.open.length <= 7000, String(r.open.length));
  const body = new URL(r.open).searchParams.get('body');
  const full = note + '\n\n---\nSent with Anymouse from P9.';
  assert.deepEqual([r.cut, r.total], [true, full.length]);
  assert.ok(r.kept > 1000 && r.kept < r.total, String(r.kept));
  assert.equal(body, full.slice(0, r.kept) + '\n\n[cut to fit a link; the full note is in P9]');
  const short = await createAnymouse()({ text: 'short' });
  assert.deepEqual([short.cut, short.kept, short.total], [undefined, undefined, undefined]);
});

test('D13 in the desktop: a long note opens the cut link and the box says how many characters GitHub got', { timeout: 60000 }, async (t) => {
  const instance = await daemon(t);
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-anymouse-cut-')), opened = path.join(home, 'opened.txt'), browser = path.join(home, 'browser');
  await writeFile(browser, '#!/bin/sh\nprintf "%s\\n" "$1" > ' + opened + '\n');
  await chmod(browser, 0o755);
  const env = { ...process.env, P9_OPEN_URL: browser }; delete env.ELECTRON_RUN_AS_NODE; delete env.P9_GITHUB_TOKEN;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + path.join(home, 'profile')], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  const note = Array.from({ length: 1000 }, (_, i) => 'step ' + i + ': the save button eats my edits').join('\n');
  await page.locator('#amBtn').click();
  await page.locator('[data-kind="bug"]').click();
  await page.locator('#amText').fill(note);
  await page.locator('#amSend').click();
  await page.locator('#amNote', { hasText: 'Opened GitHub' }).waitFor({ timeout: 15000 });
  const said = await page.locator('#amNote').innerText();
  const [, kept, total] = said.match(/GitHub got only the start \(the first ([\d,]+) of ([\d,]+) characters\); paste the rest from here\./) ?? [];
  assert.ok(kept, said);
  const all = Number(total.replaceAll(',', '')), footer = '\n\n---\nSent with Anymouse from P9.'.length;
  assert.ok(all >= note.length + footer && all <= note.length + footer + 203, all + ' for a ' + note.length + '-character note');
  assert.ok(Number(kept.replaceAll(',', '')) < all);
  assert.equal(await page.locator('#amText').inputValue(), note, 'the whole note stays in the box');
  let url = '';
  for (const end = Date.now() + 10000; Date.now() < end && !url; await new Promise((r) => setTimeout(r, 100))) url = (await readFile(opened, 'utf8').catch(() => '')).trim();
  assert.ok(url.startsWith(NEW_ISSUE) && url.length <= 7000, url.length + ' ' + url.slice(0, 60));
  assert.ok(new URL(url).searchParams.get('body').startsWith(note.slice(0, Number(kept.replaceAll(',', '')))));
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT d13-anymouse-cut ' + (await page.locator('#amDlg').screenshot({ type: 'png' })).toString('base64'));
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
    if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png.toString('base64')); // BL3: gated as above
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
    if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png.toString('base64')); // BL3: gated as above
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
  await page.locator('#mdlBody [data-row="4"]').waitFor({ timeout: 10000 });
  assert.equal(await page.locator('#mdlBody [data-row]').count(), 5, 'the reload shows the file as it is now');
  // Close the form: the icon is on the tile.
  await page.keyboard.press('Escape');
  await page.locator('#fMission [data-panel="mlaunch"] .ltile', { hasText: '🧪' }).waitFor({ timeout: 10000 });
  await shot('tile-with-icon', page.locator('#fMission [data-panel="mlaunch"]'));
  console.log('PASS mission editor: Save asked first under File protection, the icon shows on the tile, a stale file is refused and reloads');
});

// ---- v0.1.5 chunk D part 2: real icons on Mission tiles (a site's own icon, a program's icon, the user's picture) and their order.
const solid = (r, g, b) => {
  const crc = (buf) => { let c = ~0; for (const byte of buf) { c ^= byte; for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length); return out; };
  const head = Buffer.alloc(13); head.writeUInt32BE(32, 0); head.writeUInt32BE(32, 4); head[8] = 8; head[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: 32 }, () => [r, g, b]).flat())]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(32).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
};
test('v0.1.5 cD2 tile icons: picture, then emoji, then the site or program icon, then the letters', { timeout: 120000 }, async (t) => {
  const { mkdir } = await import('node:fs/promises');
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-cdicons-'));
  const requests = [];
  const site = createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><head><link rel="icon" href="/site.png" sizes="32x32"></head></html>'); }
    else if (req.url === '/site.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(solid(200, 30, 60)); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  t.after(() => site.close());
  const url = 'http://127.0.0.1:' + site.address().port + '/';
  const xdg = path.join(home, 'xdg');
  await mkdir(path.join(xdg, 'applications'), { recursive: true });
  await mkdir(path.join(xdg, 'icons/hicolor/64x64/apps'), { recursive: true });
  await writeFile(path.join(xdg, 'applications/zedit.desktop'), '[Desktop Entry]\nName=Zedit\nExec=zedit %F\nIcon=zedit\n');
  await writeFile(path.join(xdg, 'icons/hicolor/64x64/apps/zedit.png'), solid(20, 140, 90));
  const mine = path.join(home, 'mine.png');
  await writeFile(mine, solid(40, 60, 220));
  let registry;
  const instance = await daemon(t, undefined, false, async (paths) => {
    const ws = paths.workspace, settings = path.join(paths.directory, 'settings.json');
    registry = path.join(ws, 'hub/registry.json');
    for (const dir of ['_waiting', 'hub', 'projects']) await mkdir(path.join(ws, dir), { recursive: true });
    await writeFile(registry, JSON.stringify({ scripts: [], apps: [{ id: 'prog', title: 'Zedit', cmd: ['/opt/zedit/zedit'] }, { id: 'pic', title: 'Notes', icon: '🧪', cmd: ['true'] }, { id: 'plain', title: 'Plain', cmd: ['nothing-here'] }],
      pages: [{ id: 'school', title: 'School', url }, { id: 'emoji', title: 'Emoji link', icon: '🎓', url }] }, null, 2) + '\n');
    await writeFile(path.join(ws, 'projects/AGENTS.md'), '# Projects\n');
    await writeFile(path.join(ws, 'space.json'), JSON.stringify({ sections: [] }));
    await writeFile(settings, JSON.stringify({ waiting: '_waiting', registry: 'hub/registry.json', primary: 'projects/AGENTS.md', space: 'space.json' }));
    return { args: ['--settings', settings], env: { XDG_DATA_HOME: xdg, XDG_DATA_DIRS: xdg } };
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
  const tile = (name) => page.locator(`#fMission [data-panel="mlaunch"] .ltile[data-launch="${name}"]`);
  const src = (name) => tile(name).locator('img').getAttribute('src', { timeout: 15000 });
  const png = (r, g, b) => 'data:image/png;base64,' + solid(r, g, b).toString('base64');
  assert.equal(await src('School'), png(200, 30, 60), 'a link tile shows the site\'s own icon');
  assert.equal(await src('Zedit'), png(20, 140, 90), 'an app tile shows the program\'s own icon');
  assert.equal(await tile('Emoji link').locator('img').count(), 0, 'a text icon beats the automatic one');
  assert.match(await tile('Emoji link').innerText(), /🎓/);
  assert.equal(await tile('Plain').locator('img').count(), 0);
  assert.equal(await tile('Plain').locator('.mono-ico').innerText(), 'P', 'nothing found: today\'s letters');
  assert.equal(await tile('Notes').locator('img').count(), 0);
  assert.ok(requests.length > 0 && requests.every((r) => ['/', '/site.png'].includes(r)), 'only the site\'s own page and icon were asked for: ' + requests);
  // A picture from the Picture button (the native picker answered by the test) beats the emoji.
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, mine);
  await page.locator('#fMission [data-medit]').click({ timeout: 15000 });
  const row = page.locator('#mdlBody [data-row="1"]');
  await row.waitFor({ timeout: 10000 });
  const before = await readFile(registry, 'utf8');
  await row.locator('[data-pic]').click();
  await row.locator('[data-pic-img]').waitFor({ timeout: 10000 });
  await row.locator('[data-save]').click();
  assert.equal(await readFile(registry, 'utf8'), before, 'File protection asked first: no picture stored yet');
  await row.locator('[data-save]', { hasText: 'Confirm save' }).click();
  await page.locator('#mdlBody [data-row="1"] [data-msg]', { hasText: 'Saved.' }).waitFor({ timeout: 10000 });
  await shot('picture-form', page.locator('#mdl'));
  const stored = JSON.parse(await readFile(registry, 'utf8')).apps[1];
  assert.match(stored.picture, /^[0-9a-f]{16}\.png$/);
  assert.equal(stored.icon, '🧪', 'the icon field is untouched and still holds no path');
  await page.keyboard.press('Escape');
  await page.waitForFunction((want) => document.querySelector('#fMission .ltile[data-launch="Notes"] img')?.src === want, png(40, 60, 220), { timeout: 15000 });
  assert.equal(await tile('Notes').locator('.mono-ico').count(), 0, 'the picture replaced the emoji');
  await shot('mission-tiles', page.locator('#fMission [data-panel="mlaunch"]'));
  // Remove goes back down the order: the emoji shows again.
  await page.locator('#fMission [data-medit]').click();
  const again = page.locator('#mdlBody [data-row="1"]');
  await again.locator('[data-pic-remove]').click();
  await again.locator('[data-save]').click();
  await again.locator('[data-save]', { hasText: 'Confirm save' }).click();
  await page.locator('#mdlBody [data-row="1"] [data-msg]', { hasText: 'Saved.' }).waitFor({ timeout: 10000 });
  assert.equal('picture' in JSON.parse(await readFile(registry, 'utf8')).apps[1], false);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => /🧪/.test(document.querySelector('#fMission .ltile[data-launch="Notes"]')?.innerText ?? '') && !document.querySelector('#fMission .ltile[data-launch="Notes"] img'), null, { timeout: 15000 });
  console.log('PASS tile icons: site icon, program icon, picture via the form (asked first), Remove, and the order picture > emoji > automatic > letters');
});
