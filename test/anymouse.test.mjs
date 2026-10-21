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
import { createAnymouse, NEW_ISSUE } from '../apps/server/anymouse.mjs';

const TOKEN = 'ghp_' + 'x'.repeat(36);
async function fakeGitHub(t, status = 201) {
  const seen = [];
  const server = createServer((req, res) => {
    let text = '';
    req.on('data', (c) => { text += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(text) });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ number: 7, html_url: 'https://github.com/JudgeBreddd/p9/issues/7' }));
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
  assert.deepEqual(filed, { status: 200, body: { ok: true, number: 7, url: 'https://github.com/JudgeBreddd/p9/issues/7' } });
  assert.equal(gh.seen.length, 1);
  const [req] = gh.seen;
  assert.equal(req.url, '/repos/JudgeBreddd/p9/issues');
  assert.equal(req.auth, 'Bearer ' + TOKEN);
  assert.deepEqual(req.body.labels, ['bug']);
  assert.equal(req.body.title, 'Bug: Save button @​tyler');
  assert.match(req.body.body, /Sent with Anymouse from P9 \(chat\)/);
  assert.equal(JSON.stringify(filed).includes(TOKEN), false);
  assert.equal((await call(withToken, { kind: 'idea', text: '   ' })).status, 400);
  assert.equal((await call(withToken, { kind: 'idea', text: 'x'.repeat(2001) })).status, 400);
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
