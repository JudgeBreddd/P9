// A3 (2): the desktop Usage window's Tokens and Cost tabs. A ledger written before the daemon starts goes through the real
// watcher into telemetry.db, the desktop reads /usage/turns through p9.usageTurns(days), and the tabs show the hand-worked
// figures below. Logs "P9_SHOT <name> <png base64>" of each tab outside CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { openLedger } from '../apps/server/ledger.mjs';
import { historyHtml } from '../apps/web/src/usage-history.mjs';
import { daemon, root, versionSeen, watchStartup, waitStartup } from './helpers.mjs';

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const shot = async (locator, name) => { if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + (await locator.screenshot({ type: 'png' })).toString('base64')); };
const HOUR = 3600000, DAY = 24 * HOUR;
const id = (n) => n.repeat(8) + '-0000-4000-8000-' + n.repeat(12);
const usage = (inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens) =>
  ({ stopReason: 'end_turn', usage: { inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens, totalTokens: inputTokens + outputTokens + cachedReadTokens + cachedWriteTokens } });
const chat = (conversation, provider, model, at, turns) => [[conversation, 'created', { provider, title: 't', folder: '' }, at],
  [conversation, 'config', { model: { current: model, options: [{ value: model }] }, pickers: [] }, at + 1],
  ...turns.flatMap((end, i) => [[conversation, 'user', { text: 'x' }, at + 10 + i * 100], [conversation, 'turn-end', end, at + 50 + i * 100]])];
// Hand-worked, opus at $4 / $20 / $0.20 / $8 per million (input, output, cache read, cache write), sonnet $2 / $10:
// 7 days: opus 23,500 + 44,500 and the codex provider's 62,000 = 130,000 tokens over 3 turns in 2 chats; cost
// (4,000 + 10,000 + 4,000 + 16,000 + 12,000 + 30,000 + 8,000) / 1e6 = $0.084, the codex turn no price; cache savings
// (62,000 x 4 - 60,000 x 0.2 - 2,000 x 8) / 1e6 = $0.22. 30 days adds sonnet's 3,000 tokens and $0.014: 133,000, $0.098.
const seed = (now) => [
  ...chat(id('a'), 'claude', 'opus', now - 2 * HOUR, [usage(1000, 500, 20000, 2000), usage(3000, 1500, 40000, 0)]),
  ...chat(id('b'), 'codex', 'gpt-6.1-sol', now - 3 * DAY, [usage(10000, 2000, 50000, 0)]),
  ...chat(id('c'), 'claude', 'sonnet', now - 10 * DAY, [usage(2000, 1000, 0, 0)]),
];

test('A3 (2): the Usage window\'s Tokens and Cost tabs show the turns from telemetry.db, by range', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async (paths) => {
    const dir = path.join(paths.directory, 'ownership');
    await mkdir(dir, { mode: 0o700 });
    const ledger = openLedger(path.join(dir, 'p9.db'));
    const insert = ledger.db.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)');
    for (const [conversation, type, data, at] of seed(Date.now())) insert.run(conversation, type, JSON.stringify(data), at);
    ledger.db.close();
    return { args: ['--acp-override', path.join(root, 'test/fake-acp-agent.mjs'), '--ownership', dir] };
  });
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-usage-tabs-')), 'profile');
  await mkdir(profile); await versionSeen(profile);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow(), watch = watchStartup(page);
  await waitStartup(page, watch, page.locator('#rUsage'), { what: 'usage button' });

  // The bridge passes only days (preload.cjs), one of the route's ranges; anything else is refused before the daemon is asked.
  for (const bad of [[5], ['7'], [null], []]) {
    const refused = await page.evaluate((args) => window.p9.usageTurns(...args).then(() => 'answered', (e) => String(e.message)), bad);
    assert.match(refused, /ipc-sender-refused/, 'refused: ' + JSON.stringify(bad));
  }

  await page.locator('#rUsage').click();
  const body = page.locator('#mdlBody');
  await body.locator('[data-utab="limits"][aria-selected="true"]').waitFor();
  // The tablist's keys: ArrowRight from Limits opens Tokens and keeps the focus on its tab.
  await body.locator('[data-utab="limits"]').focus();
  await page.keyboard.press('ArrowRight');
  await body.locator('[data-utab="tokens"][aria-selected="true"]').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.utab), 'tokens');
  // The first start rebuilds telemetry.db from the ledger; the tab says so and reads again until it is done.
  const total = body.locator('[data-uh-total]');
  await total.filter({ hasText: '130K' }).waitFor({ timeout: 60000 });
  const text = () => body.innerText();
  let shown = await text();
  for (const want of ['130K', '3 turns · 2 chats', 'Cache savings', '$0.22', 'Past 24h', 'opus', 'gpt-6.1-sol']) assert.ok(shown.includes(want), `Tokens tab shows ${want}:\n${shown}`);
  assert.ok(!shown.includes('sonnet'), 'the 10-day-old turn is outside 7 days');
  assert.equal(await body.locator('.uh-table tbody tr').count(), 2, 'one breakdown row per model');
  await shot(body, 'usage-tokens-7d');

  await body.locator('[data-utab="cost"]').click();
  await total.filter({ hasText: '$0.08' }).waitFor();
  shown = await text();
  for (const want of ['API estimate', '2 of 3 turns have a price']) assert.ok(shown.includes(want), `Cost tab shows ${want}:\n${shown}`);
  const codexRow = body.locator('.uh-table tbody tr', { hasText: 'gpt-6.1-sol' });
  assert.match(await codexRow.innerText(), /no price/, 'a turn with no price says so, never $0');
  assert.match(await body.locator('.uh-provs li', { hasText: 'no price' }).innerText(), /–/, 'no share of a cost it has none of');
  assert.doesNotMatch(await codexRow.innerText(), /\$0\.00/);
  await shot(body, 'usage-cost-7d');
  await body.locator('.uh-table').scrollIntoViewIfNeeded();
  await shot(body, 'usage-cost-7d-table');

  await body.locator('[data-uh-days="30"]').click();
  await total.filter({ hasText: '$0.10' }).waitFor();
  assert.ok((await text()).includes('sonnet'), '30 days reaches the 10-day-old turn');
  await body.locator('[data-uh-by="day"]').click();
  assert.equal(await body.locator('.uh-table tbody tr').count(), 3, 'one breakdown row per day with turns');
  await body.locator('[data-utab="tokens"]').click();
  await total.filter({ hasText: '133K' }).waitFor();
  await shot(body, 'usage-tokens-30d-by-day');

  // Limits is the tab it was: the plan windows, unchanged.
  await body.locator('[data-utab="limits"]').click();
  assert.equal(await body.locator('[data-uh-total]').count(), 0);

  // Left on Tokens and closed, the window opens on Limits again (the pace bars); the range picked is kept.
  await body.locator('[data-utab="tokens"]').click();
  await total.filter({ hasText: '133K' }).waitFor();
  await page.keyboard.press('Escape');
  await page.locator('#mdl').waitFor({ state: 'hidden' });
  await page.locator('#rUsage').click();
  await body.locator('[data-utab="limits"][aria-selected="true"]').waitFor();
  assert.equal(await body.locator('[data-uh-total]').count(), 0, 'reopened on Limits');
  await body.locator('[data-utab="tokens"]').click();
  await body.locator('[data-uh-days="30"][aria-pressed="true"]').waitFor();
});

// The figures' edge cases, on the renderer alone: a count no turn reported, a remote daemon a day ahead, a net cache cost.
test('A3 (2): a missing count is a dash, never 0; a remote day ahead stays on the chart; an older daemon says so', () => {
  const day = (n) => new Date(Date.now() + n * DAY).toLocaleDateString('sv');
  const row = (d, input, total, kInput, kTotal) => ({ day: d, provider: 'p', model: 'm', profile: false, turns: 2, measured: 2,
    known: { input: kInput, output: 0, cacheRead: 0, cacheWrite: 0, total: kTotal }, priced: 0, estimated: 0,
    input, output: null, cacheRead: null, cacheWrite: null, total, cost: null, usd: null, saved: -0.001 });
  const page = { state: 'ok', days: 7, since: Date.now() - 7 * DAY, pricesAsOf: '2026-11-03', chats: { p: 1 },
    rows: [row(day(0), 1000000, null, 2, 0), row(day(1), 500, 800, 1, 1)] };
  const html = historyHtml({ tab: 'tokens', days: 7, by: 'model', page }, esc, {});
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/\s+/g, ' ');
  assert.match(text, /Processed tokens 800 1 of 4 turns/, 'the total over the one turn that reported it, marked partial');
  assert.match(text, /Uncached input 1M 3 of 4 turns/);
  assert.match(text, /Output — /, 'no turn reported output: a dash, not 0');
  assert.match(text, /Cache savings −<\$0\.01/, 'a net cache cost reads negative, never $-0.00');
  assert.ok(html.includes(`title="${day(1)}: `), 'the daemon\'s day ahead of this desktop has its column');
  assert.match(text, /1 of 4 turns reported a token total/);
  assert.match(historyHtml({ tab: 'cost', days: 7, page: { state: 'unsupported', days: 7 } }, esc, {}), /older than this app/);
});
