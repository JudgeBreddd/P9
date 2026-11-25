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
import { daemon, remoteDaemon, root, versionSeen, watchStartup, waitStartup } from './helpers.mjs';
import { phone } from './phone-c16-helpers.mjs';

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
  await page.keyboard.press('Escape');
  await page.locator('#mdl').waitFor({ state: 'hidden' });

  // A3 (3): Settings > General hides the tabs (the ledger's telemetry-tab pref); the window is Limits alone, and back.
  for (const show of [false, true]) {
    await page.click('#setBtn');
    const box = page.locator('#setDlg[open] #setUsageTabs');
    await box.waitFor({ timeout: 5000 });
    assert.equal(await box.isChecked(), !show);
    await box.setChecked(show);
    // The box is off until the daemon's answer lands in the window; then it shows what the daemon kept.
    await page.locator('#setDlg[open] #setUsageTabs:not([disabled])').waitFor({ timeout: 10000 });
    assert.equal(await box.isChecked(), show);
    assert.equal((await page.evaluate(() => window.p9.usage())).body.telemetryTab, show, 'the daemon kept the switch');
    await page.click('#setClose');
    await page.locator('#rUsage').click();
    await body.locator('.stats').waitFor();
    assert.equal(await body.locator('[data-utab]').count(), show ? 3 : 0, show ? 'the tabs are back' : 'no tabs while the switch is off');
    if (!show) await shot(body, 'usage-tabs-off');
    await page.keyboard.press('Escape');
    await page.locator('#mdl').waitFor({ state: 'hidden' });
  }
});

// A3 (3): the phone's Usage screen has the same tabs over the same /usage/turns, and the switch hides them there too
// while the watcher keeps writing telemetry.db.
test('A3 (3): the phone\'s Usage screen has Tokens and Cost tabs; telemetry-tab off hides them and turns are still recorded', { timeout: 180000 }, async (t) => {
  const server = await remoteDaemon(t, { setup: async (paths) => {
    const dir = path.join(paths.directory, 'ownership');
    await mkdir(dir, { mode: 0o700 });
    const ledger = openLedger(path.join(dir, 'p9.db'));
    const insert = ledger.db.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)');
    for (const [conversation, type, data, at] of seed(Date.now())) insert.run(conversation, type, JSON.stringify(data), at);
    ledger.db.close();
    return { args: ['--acp-override', path.join(root, 'test/fake-acp-agent.mjs'), '--ownership', dir] };
  } });
  const { page } = await phone(t, server);
  await page.waitForSelector('h1:text("Chats")');
  await page.click('[data-nav="usage"]');
  const screen = page.locator('#usage');
  await screen.locator('[data-utab="limits"][aria-selected="true"]').waitFor({ timeout: 15000 });
  await screen.locator('.sum').waitFor();
  await screen.locator('[data-utab="tokens"]').click();
  const total = screen.locator('[data-uh-total]');
  await total.filter({ hasText: '130K' }).waitFor({ timeout: 60000 });
  let shown = await screen.innerText();
  for (const want of ['130K', '3 turns · 2 chats', 'Cache savings', '$0.22', 'opus', 'gpt-6.1-sol']) assert.ok(shown.includes(want), `Tokens shows ${want}:\n${shown}`);
  assert.equal(await screen.locator('.sum').count(), 0, 'Limits\' lines are on the Limits tab only');
  // The 390 px screen: nothing is wider than the page.
  assert.ok(await page.evaluate(() => document.querySelector('#usage').scrollWidth <= document.querySelector('#usage').clientWidth + 1), 'no sideways scroll');
  await shot(page, 'phone-usage-tokens-7d');
  await screen.locator('[data-utab="cost"]').click();
  await total.filter({ hasText: '$0.08' }).waitFor();
  shown = await screen.innerText();
  for (const want of ['API estimate', '2 of 3 turns have a price']) assert.ok(shown.includes(want), `Cost shows ${want}:\n${shown}`);
  await shot(page, 'phone-usage-cost-7d');
  await screen.locator('[data-uh-days="30"]').click();
  await total.filter({ hasText: '$0.10' }).waitFor();
  await screen.locator('[data-uh-by="day"]').click();
  assert.equal(await screen.locator('.uh-table tbody tr').count(), 3);
  await screen.locator('.uh-table').scrollIntoViewIfNeeded();
  await shot(page, 'phone-usage-cost-30d-by-day');
  // Refresh (as the 20 s redraw) keeps the tab and range; it reads Tokens and Cost again too.
  const turnsRead = () => page.waitForResponse((r) => new URL(r.url()).pathname === '/usage/turns');
  const refresh = async () => { const read = turnsRead(); await page.click('#refreshUsage'); await read; };
  await refresh();
  assert.equal(await screen.locator('[data-utab="cost"][aria-selected="true"]').count(), 1);
  await total.filter({ hasText: '$0.10' }).waitFor();

  // The switch is the desktop's (Settings > General); the phone's listener has no route to change it.
  // Sent as the phone sends its own changes (its CSRF token and an operation id), so only the missing route can refuse it.
  const tried = await page.evaluate(() => fetch('/telemetry-tab', { method: 'POST', headers: { 'content-type': 'application/json',
    'x-p9-op': crypto.randomUUID(), 'x-p9-csrf': sessionStorage.getItem('p9-csrf') ?? JSON.parse(localStorage.getItem('p9-csrf') ?? '{}').token }, body: '{"show":false}' }).then((r) => r.status));
  assert.equal(tried, 404, 'the phone cannot turn the tabs off');
  assert.equal((await server.desk('/usage')).body.telemetryTab, true, 'the switch is unchanged');
  // After the refused change the tabs are still there.
  await refresh();
  assert.equal(await screen.locator('[data-utab="cost"][aria-selected="true"]').count(), 1);
  assert.deepEqual((await server.desk('/telemetry-tab', 'POST', { show: false })).body, { show: false });
  assert.equal((await server.desk('/telemetry-tab', 'POST', { show: 'no' })).status, 400);
  await page.click('#refreshUsage');
  await screen.locator('[data-utab]').first().waitFor({ state: 'detached' });
  await screen.locator('.sum').waitFor();
  await shot(page, 'phone-usage-tabs-off');
  // Off hides the view only: a turn that ends now (the fake agent's, through the daemon) still reaches telemetry.db.
  const made = await server.desk('/chat', 'POST', { provider: 'claude' });
  assert.equal((await server.desk('/chat/' + made.body.conversation + '/prompt', 'POST', { text: 'hello' })).status, 202);
  const count = async () => ((await server.desk('/usage/turns?days=1')).body.rows ?? []).reduce((n, r) => n + r.turns, 0);
  for (const end = Date.now() + 30000; await count() !== 3 && Date.now() < end;) await new Promise((r) => setTimeout(r, 500));
  assert.equal(await count(), 3, 'the turn ended while the switch was off is in telemetry.db');
  assert.deepEqual((await server.desk('/telemetry-tab', 'POST', { show: true })).body, { show: true });
  await page.click('#refreshUsage');
  await screen.locator('[data-utab="limits"][aria-selected="true"]').waitFor();

  // Refresh shows a turn that ended after the last read, even within the minute the answer is otherwise kept.
  await screen.locator('[data-utab="tokens"]').click();
  await refresh();
  // The figure the phone must show: the daemon's own count for the range picked.
  const days = await screen.locator('[data-uh-days][aria-pressed="true"]').getAttribute('data-uh-days');
  const inRange = async () => ((await server.desk('/usage/turns?days=' + days)).body.rows ?? []).reduce((n, r) => n + r.turns, 0);
  const shows = (n) => screen.locator('.uh-total span', { hasText: new RegExp(`(^|\\D)${n} turns`) }).waitFor({ timeout: 5000 });
  const before = await inRange();
  await shows(before);
  assert.equal((await server.desk('/chat/' + made.body.conversation + '/prompt', 'POST', { text: 'again' })).status, 202);
  for (const end = Date.now() + 30000; await count() !== 4 && Date.now() < end;) await new Promise((r) => setTimeout(r, 500));
  assert.equal(await count(), 4);
  await refresh();
  assert.equal(await inRange(), before + 1);
  await shows(before + 1);
});

// The figures' edge cases, on the renderer alone: a count no turn reported, a remote daemon a day ahead, a net cache cost.
test('A3 (2): a missing count is a dash, never 0; a partial one is marked everywhere; the chart keeps the daemon\'s days; an older daemon says so', () => {
  const day = (n) => new Date(Date.now() + n * DAY).toLocaleDateString('sv');
  const row = (d, input, total, kInput, kTotal) => ({ day: d, provider: 'p', model: 'm', profile: false, turns: 2, measured: 2,
    known: { input: kInput, output: 0, cacheRead: 0, cacheWrite: 0, total: kTotal }, priced: 0, estimated: 0,
    input, output: null, cacheRead: null, cacheWrite: null, total, cost: null, usd: null, saved: -0.001 });
  // The daemon is a day ahead of this desktop: its range runs to tomorrow here.
  const page = { state: 'ok', days: 7, since: Date.now() - 7 * DAY, from: day(-6), to: day(1), pricesAsOf: '2026-11-03', chats: { p: 1 },
    rows: [row(day(0), 1000000, null, 2, 0), row(day(1), 500, 800, 1, 1)] };
  const html = historyHtml({ tab: 'tokens', days: 7, by: 'model', page }, esc, {});
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/\s+/g, ' ');
  assert.match(text, /Processed tokens 800 1 of 4 turns/, 'the total over the one turn that reported it, marked partial');
  assert.match(text, /Uncached input 1M 3 of 4 turns/);
  assert.match(text, /Output — /, 'no turn reported output: a dash, not 0');
  assert.match(text, /Cache savings −<\$0\.01/, 'a net cache cost reads negative, never $-0.00');
  assert.ok(html.includes(`title="${day(1)}: `), 'the daemon\'s day ahead of this desktop has its column');
  assert.match(text, /1 of 4 turns reported a token total/);
  assert.ok(html.includes(`<div class="uh-axis"><span>${day(-6)}</span>`), "the axis starts at the daemon's first day");
  // A partial figure is marked wherever it shows, not only in the totals.
  // In text, so a keyboard and a screen reader reach it; a share is of the reported tokens, so it has none.
  assert.match(text, /p 1 chat 100% 800 1\/4 /, 'the provider line marks its total');
  assert.match(text, /1 m no price 100% 800 1\/4 /, 'the breakdown row marks its tokens');
  assert.match(text, /Share of reported tokens/);
  assert.match(text, /Shares are of the reported tokens\./, 'the provider lines\' shares say so too');
  assert.match(text, /Input 1M 3\/4 /, 'the legend marks a partial type');
  assert.ok(html.includes(`title="${day(1)}: 800 (1 of 2 turns)"`), 'the hover says how many turns the day counts');
  assert.match(html, /aria-label="Input 100%, Cache read not reported, Cache write not reported, Output not reported"/);
  // A turn with no provider: its chats are under 'unknown', as the daemon counts them. A sub-cent cost reads <$0.01.
  const priced = { ...row(day(0), 10, 10, 1, 1), provider: null, model: 'opus', priced: 1, usd: 0.006, cost: { input: 0.006, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const cost = historyHtml({ tab: 'cost', days: 7, by: 'model', page: { ...page, chats: { unknown: 1 }, rows: [priced] } }, esc, {})
    .replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/\s+/g, ' ');
  assert.match(cost, /unknown 1 chat 100% <\$0\.01 1\/2 /, 'the unknown provider has its chat; the sub-cent cost is <$0.01, marked 1 of 2 priced');
  assert.match(cost, /Estimated cost <\$0\.01 1 of 2 turns Input <\$0\.01 1 of 2 turns/, 'each dollar total says its priced turns');
  assert.match(cost, /Input <\$0\.01 1\/2 Cache read/, 'and so does the legend');
  // A daemon from before from/to (the route as first merged): the chart runs from this desktop's start to the last row.
  const { from, to, ...older } = page;
  const old = historyHtml({ tab: 'tokens', days: 7, by: 'model', page: older }, esc, {});
  assert.ok(old.includes(`<div class="uh-axis"><span>${day(-7)}</span>`) && old.includes(`title="${day(1)}: `) && !old.includes('Invalid'), 'an older answer still draws its days');
  assert.match(historyHtml({ tab: 'cost', days: 30, page: { state: 'unsupported', days: 7 } }, esc, {}), /older than this app/, 'for any range');
});
