// 733: the notices that stayed in the top right now go to the bell like the other notifications. The three that made a
// staying card: an agent finished, an item that needs you
// (a new file in the waiting folder), an agent asking. Each now shows once as a notice at the bottom right and is listed in
// the bell; none makes a card. An item already waiting when the window opens goes to the bell with no notice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, http, authenticated, root } from './helpers.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((result) => JSON.parse(result.text));

test('733 top-right cards go to the bell: a finish, a new waiting item and a question each show one notice and a bell row, and no card', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async (paths) => {
    const w = paths.workspace; // the same setup as settings.test's "Cards" test, whose live waiting items this reads
    await mkdir(path.join(w, '_tyler'), { recursive: true }); await mkdir(path.join(w, 'hub'), { recursive: true });
    await writeFile(path.join(w, 'hub/registry.json'), JSON.stringify({ scripts: [], apps: [], pages: [] }));
    await writeFile(path.join(w, 'AGENTS.md'), '# Projects\n');
    await writeFile(path.join(w, '_tyler/old-question.md'), '# Old question\n\nA.\n');
    await writeFile(path.join(paths.directory, 'settings.json'), JSON.stringify({ waiting: '_tyler', registry: 'hub/registry.json', primary: 'AGENTS.md' }));
    return { args: ['--acp-override', fake, '--settings', path.join(paths.directory, 'settings.json')] };
  });
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-bell-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 900));
  const shot = async (name) => {
    await page.waitForTimeout(700);
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
    if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png);
  };
  const staying = () => page.locator('#cards .card:not([data-key="welcome"])').count();
  const notice = (txt) => page.locator('#toasts .toast', { hasText: txt });
  const bellRows = async () => { await page.click('#rBell'); const rows = await page.locator('#mdlBody .mlist li').allInnerTexts(); await page.keyboard.press('Escape'); return rows.map((r) => r.replace(/\s+/g, ' ').trim()); };
  // The old item is in the bell at start, quietly: no notice, no card.
  await page.locator('#rBell b', { hasText: '1' }).waitFor({ timeout: 15000 });
  await page.evaluate(() => document.documentElement.style.setProperty('--toast-life', '600s'));
  assert.equal(await page.locator('#toasts .toast').count(), 0, 'no notice for an item already waiting');
  assert.equal(await staying(), 0);
  // Finished: a turn nobody watches (window in the background, as a finish needs).
  await page.evaluate(() => { document.hasFocus = () => false; window.Notification = class {}; });
  const id = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  await page.locator('#nav .row[data-chat="' + id + '"]').waitFor({ timeout: 15000 });
  await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'hello' });
  await notice('Claude finished').waitFor({ timeout: 15000 });
  assert.equal(await staying(), 0, 'a finish makes no staying card');
  // An item that needs you: the chat writes a new file into the waiting folder.
  await writeFile(path.join(instance.workspace, '_tyler/new-question.md'), '# Made by the chat\n\nA.\n');
  await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'make one' });
  await notice('1 item needs you').waitFor({ timeout: 15000 });
  assert.equal(await staying(), 0, 'a new waiting item makes no staying card');
  // Asking: the agent asks a question and waits on you.
  await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'ask' });
  await notice('Claude needs you').waitFor({ timeout: 15000 });
  assert.equal(await staying(), 0, 'a question makes no staying card');
  assert.equal(await notice('Claude finished').count(), 1, 'one notice per finish, not one per redraw');
  assert.equal(await notice('1 item needs you').count(), 1, 'one notice per new item');
  const box = await page.locator('#toasts').evaluate((b) => { const r = b.getBoundingClientRect(); return [r.right > innerWidth / 2, r.bottom > innerHeight / 2]; });
  assert.deepEqual(box, [true, true], 'the notices sit at the bottom right');
  await shot('bell-733-notices');
  // The bell lists all three (and the old item), none marked snoozed.
  await page.click('#rBell'); await page.locator('#mdl[open] #mdlBody .mlist').waitFor({ timeout: 5000 });
  await shot('bell-733-center');
  await page.keyboard.press('Escape');
  const rows = await bellRows();
  for (const want of [/Claude needs you/, /1 item needs you/, /Claude finished/, /1 item in _tyler\//]) assert.ok(rows.some((r) => want.test(r)), want + ' in the bell: ' + JSON.stringify(rows));
  assert.ok(!rows.some((r) => /snoozed/.test(r)), 'nothing reads snoozed: ' + JSON.stringify(rows));
  // Reviewer FIX1: a waiting-file notice opens its file even after rows moved, and the bell (never another file) once it is gone.
  // The earlier row leaves and a newer one comes in that sorts first by name: a row number kept from the notice is another file now.
  // The waiting list reloads when a turn ends (chat-view turn-end, queueSoon); the first chat is waiting on its question, so a
  // second chat's turns do it.
  const id2 = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  await page.locator('#nav .row[data-chat="' + id2 + '"]').waitFor({ timeout: 15000 });
  const waitRows = async (want) => { await call(instance, '/chat/' + id2 + '/prompt', 'POST', { text: 'hello' });
    for (let n = 0; n < 15; n++) { const r = await bellRows(); if (want(r)) return r; await page.waitForTimeout(1000); } return bellRows(); };
  await unlink(path.join(instance.workspace, '_tyler/old-question.md'));
  await writeFile(path.join(instance.workspace, '_tyler/a-later.md'), '# Later one\n\nA.\n');
  const moved = await waitRows((r) => r.some((x) => /2 items need you/.test(x)) && !r.some((x) => /in _tyler\//.test(x)));
  assert.ok(moved.some((x) => /2 items need you/.test(x)) && !moved.some((x) => /in _tyler\//.test(x)), 'the queue moved: ' + JSON.stringify(moved));
  await notice('1 item needs you').click();
  const file = page.locator('#mdl[open] #mdlBody .fileview');
  await file.waitFor({ timeout: 5000 });
  assert.equal(await file.getAttribute('aria-label'), '_tyler/new-question.md', 'the notice opened its own file');
  assert.match(await page.locator('#mdlBody').innerText(), /Made by the chat/);
  await page.keyboard.press('Escape');
  await unlink(path.join(instance.workspace, '_tyler/new-question.md'));
  await waitRows((r) => r.some((x) => /1 item needs you/.test(x)));
  await notice('1 item needs you').click();
  await page.locator('#mdl[open] #mdlBody .mlist').waitFor({ timeout: 5000 });
  assert.equal(await page.locator('#mdlT').innerText(), 'Notification Center', 'a gone file opens the bell');
  assert.equal(await page.locator('#mdl[open] .fileview').count(), 0, 'not another file');
  await page.keyboard.press('Escape');
  console.log('PASS 733 FIX1: a waiting-file notice opens its file after the queue moved, the bell once it is gone');
  // A notice opens its item: the question's notice opens the asking chat.
  await notice('Claude needs you').click();
  await page.locator('#mdl[open] #mdlBody [data-question]').waitFor({ timeout: 5000 });
  console.log('PASS 733 bell: finish, new waiting item and question each one notice bottom right and a bell row, no staying card; old item quiet');
});
