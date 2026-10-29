// Live Claude usage (threat model row 42) on every screen that shows it: the daemon's poll (a stand-in SDK at 37% / 63%)
// reaches the desktop's chat meters in every open Claude chat, Mission Control's usage panel, and the phone's Usage tab,
// with no chat turn reporting limits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
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
const fresh = (text) => text.includes('37%') && text.includes('63%');

test('live Claude usage: every desktop Claude chat and Mission Control show the polled figures', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args }));
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
    await page.locator('#rBots [data-bot="' + id + '"]').waitFor({ timeout: 15000 });
    await page.locator('#tabs .tab[data-id="' + id + '"]').click();
    const meters = page.locator('.pane[data-id="' + id + '"] .meters');
    await until(async () => fresh(await meters.innerText().catch(() => '')), 'chat ' + id + ' meters at 37% / 63%', 90000);
    await shot(meters, 'live-usage-chat-' + chats.indexOf(id));
  }
  // Mission Control covers the tabs, so it comes last.
  const mission = page.locator('#fMission [data-panel="musage"]');
  await page.locator('#rMission').click();
  await until(async () => fresh(await mission.innerText().catch(() => '')), 'Mission Control usage at 37% / 63%', 15000);
  await shot(mission, 'live-usage-mission');
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
