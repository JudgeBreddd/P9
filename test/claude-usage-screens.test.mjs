// Live Claude usage (threat model row 42) on every screen that shows it: the daemon's poll (a stand-in SDK at 37% / 63%)
// reaches the desktop's chat meters in every open Claude chat, Mission Control's usage panel, and the phone's Usage tab,
// with no chat turn reporting limits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, remoteDaemon, http, authenticated, root, versionSeen } from './helpers.mjs';
import { phone } from './phone-c16-helpers.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs'), sdk = path.join(root, 'test/fake-claude-sdk.mjs');
const args = ['--acp-override', fake, '--usage-sdk', sdk];
const shot = async (locator, name) => { if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + (await locator.screenshot({ type: 'png' })).toString('base64')); };
const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((result) => JSON.parse(result.text));
const until = async (check, what, ms) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 500))) if (await check()) return;
  assert.fail('timed out: ' + what);
};
// O191: one provider profile chat as /usage reports it (test/server.test.mjs), and the line every screen draws for it.
const FAR = { id: 'p1', name: 'Far <b>Cloud</b>', inputTokens: 1000, outputTokens: 500, cachedTokens: 200, costUsd: 47.42, turns: 1 };
const PROFILE_LINE = 'Far <b>Cloud</b> (profile): 1,000 input · 500 output tokens · 1 turn · $47.42 estimated at Claude prices, not billed by Claude';
const fresh = (text) => text.includes('37%') && text.includes('63%');
// Mission draws its Usage panel only where a space section names it (faed908), and a profile with no space shows only the
// onboarding card (Mission M4a, 4d468c3): this space is one section holding the Usage widget.
const usageSpace = async (paths) => {
  await mkdir(path.join(paths.workspace, 'hub'), { recursive: true });
  await writeFile(path.join(paths.workspace, 'hub/space.json'), JSON.stringify({ sections: [{ id: 'use', title: 'Use', widgets: ['usage'] }] }));
  await writeFile(path.join(paths.directory, 'settings.json'), JSON.stringify({ space: 'hub/space.json' }));
  return { args: [...args, '--settings', path.join(paths.directory, 'settings.json')] };
};

test('live Claude usage: every desktop Claude chat and Mission Control show the polled figures', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, usageSpace);
  const chats = [];
  for (const text of ['one', 'two']) {
    const id = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
    await call(instance, '/chat/' + id + '/prompt', 'POST', { text });
    chats.push(id);
  }
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-live-usage-')), 'profile');
  await mkdir(profile); await versionSeen(profile);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  // The desktop reads /usage at launch (which starts the poll) and every minute after: the figures arrive within ~60 s.
  for (const id of chats) {
    await page.locator('#navList .rowwrap[data-live] .row[data-chat="' + id + '"]').waitFor({ timeout: 15000 });
    await page.locator('#nav .row[data-chat="' + id + '"]').click();
    const meters = page.locator('.pane[data-id="' + id + '"] .meters');
    await until(async () => fresh(await meters.innerText().catch(() => '')), 'chat ' + id + ' meters at 37% / 63%', 90000);
    await shot(meters, 'live-usage-chat-' + chats.indexOf(id));
  }
  // Mission Control covers the chats, so it comes last.
  const mission = page.locator('#fMission [data-panel="musage"]');
  await page.locator('#rMission').click();
  await until(async () => fresh(await mission.innerText().catch(() => '')), 'Mission Control usage at 37% / 63%', 15000);
  await shot(mission, 'live-usage-mission');
});

test('live Claude usage: a hidden desktop window stops reading /usage, so the daemon\'s poll can stop; shown again it reads at once', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args }));
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-usage-hidden-')), 'profile');
  await mkdir(profile); await versionSeen(profile);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#navList').waitFor({ state: 'attached', timeout: 15000 });
  // Count the page's usage reads in main: the real handler is swapped for one that counts and answers as it would.
  await app.evaluate(({ ipcMain }) => { globalThis.usageReads = 0; ipcMain.removeHandler('p9:usage');
    ipcMain.handle('p9:usage', () => { globalThis.usageReads++; return { status: 503, body: { state: 'unavailable' } }; }); });
  const reads = () => app.evaluate(() => globalThis.usageReads);
  // The container's window manager never tells a hidden Electron window it is hidden, so the page is told directly: what
  // Chromium reports when the window is minimized or hidden on a real desktop.
  const hidden = (yes) => page.evaluate((h) => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    document.dispatchEvent(new Event('visibilitychange')); }, yes);
  await hidden(true);
  const before = await reads();
  await new Promise((resolve) => setTimeout(resolve, 65000)); // longer than one 60 s poll
  assert.equal(await reads(), before, 'no usage read while the window is hidden');
  await hidden(false);
  await until(async () => await reads() > before, 'a usage read once the window is shown', 5000);
});

test('live Claude usage: the phone\'s Usage tab shows the polled figures', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, { args });
  const { page } = await phone(t, server);
  await page.click('[data-nav="usage"]');
  // The tab reads /usage when opened (which starts the poll) and every 20 s while shown.
  const plans = page.locator('#usage [data-limits]');
  await until(async () => fresh(await plans.innerText().catch(() => '')), 'phone Usage at 37% / 63%', 60000);
  await shot(page, 'live-usage-phone');
});

// O191 (web half): a provider profile's spend is not in the Claude totals (#326, /usage profiles); the Usage window gives it
// its own row, with the adapter's estimate named as such, so a $47 estimate never reads as a Claude bill.
test('O191: the Usage window shows a provider profile as its own row, apart from the Claude totals, also with no Claude records', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, usageSpace);
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-usage-profile-')), 'profile');
  await mkdir(profile); await versionSeen(profile);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  let page = await app.firstWindow();
  await page.locator('#navList').waitFor({ state: 'attached', timeout: 15000 });
  // /usage as the daemon answers it with one profile chat (test/server.test.mjs, O191); the page reads it again after a reload.
  await app.evaluate(({ ipcMain }, FAR) => { ipcMain.removeHandler('p9:usage');
    ipcMain.handle('p9:usage', () => ({ status: 200, body: { state: 'ok', samples: 1, discarded: 0, updatedAt: Date.now(), tokens: 'prompted turns and Claude Code\'s own runs',
      totals: { inputTokens: 10, outputTokens: 5, cachedTokens: 2, costUsd: 0.5 }, contexts: [],
      profiles: [FAR] } })); }, FAR);
  await page.reload();
  await page.locator('#rMission').click();
  // O191 (panel): the Usage panel on the Mission page gives the profile its own line too, outside the Claude figures.
  const panel = page.locator('#fMission [data-panel="musage"]');
  await panel.locator('[data-profile]').waitFor({ timeout: 15000 });
  assert.equal(await panel.locator('[data-profile]').innerText(), PROFILE_LINE);
  assert.match(await panel.innerText(), /\b5 output tokens · \$0\.50 recorded/, 'the panel\'s Claude figures leave the profile out');
  await page.click('#fMission [data-win="musage"]');
  const win = page.locator('#mdl #musage');
  await win.locator('[data-profile]').waitFor({ timeout: 15000 });
  assert.equal(await win.locator('[data-profile]').innerText(), PROFILE_LINE);
  assert.match(await win.locator('.stats').innerText(), /Input tokens\s*10\b[\s\S]*Output tokens\s*5\b[\s\S]*\$0\.5000/, 'the Claude totals leave the profile out');
  // O190 (web half): the totals say what they count, in the daemon's words (/usage tokens, ledger.mjs TOKENS), here and on
  // the Mission page's Usage panel.
  assert.equal(await win.locator('[data-tokens]').innerText(), 'Tokens counted: prompted turns and Claude Code\'s own runs');
  assert.match(await page.locator('#fMission [data-panel="musage"] [data-tokens]').innerText(), /^Tokens counted: prompted turns and Claude Code's own runs$/);
  // FIX1: an answer without tokens (an older daemon after a reconnect) takes the line away again on both, without a reload.
  await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('p9:usage');
    ipcMain.handle('p9:usage', () => ({ status: 200, body: { state: 'ok', samples: 1, discarded: 0, updatedAt: Date.now(),
      totals: { inputTokens: 10, outputTokens: 5, cachedTokens: 2, costUsd: 0.5 }, contexts: [], profiles: [] } })); });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await win.locator('[data-profile]').waitFor({ state: 'detached', timeout: 15000 });
  assert.equal(await win.locator('[data-tokens]').count(), 0, 'no stale label in the Usage window');
  assert.equal(await page.locator('#fMission [data-panel="musage"] [data-tokens]').count(), 0, 'no stale label on the Mission panel');
  await shot(win, 'o191-usage-profile');
  // FIX1: /usage's state counts Claude records only, so a profile's spend alone (its chats deleted, or token-only events)
  // reads 'unavailable'; the profile row still shows, under "No chat token records yet."
  await app.evaluate(({ ipcMain }, FAR) => { ipcMain.removeHandler('p9:usage');
    ipcMain.handle('p9:usage', () => ({ status: 200, body: { state: 'unavailable', samples: 0, discarded: 0, updatedAt: null,
      totals: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 }, contexts: [],
      profiles: [FAR] } })); }, FAR);
  await page.reload();
  await page.locator('#rMission').click();
  await panel.locator('[data-profile]').waitFor({ timeout: 15000 });
  assert.equal(await panel.locator('[data-profile]').count(), 1, 'the panel\'s profile line shows with no Claude records');
  await page.click('#fMission [data-win="musage"]');
  await win.locator('.empty', { hasText: 'No chat token records yet.' }).waitFor({ timeout: 15000 });
  assert.equal(await win.locator('[data-profile]').count(), 1, 'the profile row shows with no Claude records');
  assert.match(await win.locator('[data-profile]').innerText(), /^Far <b>Cloud<\/b> \(profile\): 1,000 input/);
  await shot(win, 'o191-usage-profile-only');
});

// O191 (phone half): the phone's Usage tab gives each provider profile its own line, apart from the Claude totals, also when
// /usage has no Claude records (state 'unavailable': it counts Claude records only); an old daemon with no profiles shows none.
test('O191: the phone Usage tab shows a provider profile as its own line, apart from the Claude totals, also with no Claude records', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, { args });
  const { page } = await phone(t, server);
  let body = { state: 'recorded', samples: 1, discarded: 0, updatedAt: Date.now(), totals: { inputTokens: 10, outputTokens: 5, cachedTokens: 2, costUsd: 0.5 }, contexts: [], profiles: [FAR] };
  await page.route(/\/usage$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }));
  await page.click('[data-nav="usage"]');
  const line = page.locator('#usage [data-profile]');
  await line.waitFor({ timeout: 15000 });
  assert.equal(await line.innerText(), PROFILE_LINE);
  assert.match(await page.locator('#usage .sum').innerText(), /^10 in · 5 out · \$0\.50 at API prices$/, 'the Claude totals leave the profile out');
  await shot(page, 'o191-phone-profile');
  body = { ...body, state: 'unavailable', samples: 0, updatedAt: null, totals: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 } };
  await page.click('#refreshUsage');
  await page.locator('#usage h2', { hasText: 'No chat token records yet' }).waitFor({ timeout: 15000 });
  assert.equal(await line.count(), 1, 'the profile line shows with no Claude records');
  assert.equal(await line.innerText(), PROFILE_LINE);
  await shot(page, 'o191-phone-profile-only');
  const { profiles, ...old } = body; body = { ...old, state: 'recorded', samples: 1 };
  await page.click('#refreshUsage');
  await page.locator('#usage .sum').waitFor({ timeout: 15000 });
  assert.equal(await line.count(), 0, 'an old daemon with no profiles: no profile line');
});
