// A3: the Usage window's Tokens and Cost views read telemetry.db (usage-turns.mjs). The fixture ledger below goes through the
// real watcher (telemetry.mjs) to make telemetry.db; the totals and dollars were worked out by hand from PRICES before the
// first run: opus $4 / $20 / $0.20 / $8, sonnet $2 / $10 / $0.10 / $4 per million input / output / cache read / cache write.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { openLedger } from '../apps/server/ledger.mjs';
import { startTelemetry } from '../apps/server/telemetry.mjs';
import { readTurns } from '../apps/server/usage-turns.mjs';
import { daemon, http, authenticated, root } from './helpers.mjs';

const T = 1767000000000, DAY = 86400000, NOW = T + 2 * DAY, CUT = NOW - DAY; // CUT: where the 24-hour view starts
const id = (n) => n.repeat(8) + '-0000-4000-8000-' + n.repeat(12);
const [A, B, C, D, E, F, G, H, J, K, Q] = ['a', 'b', 'c', 'd', 'e', 'f', '1', '5', '2', '3', '4'].map(id);
const usage = (inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens) =>
  ({ stopReason: 'end_turn', usage: { inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens, totalTokens: inputTokens + outputTokens + cachedReadTokens + cachedWriteTokens } });
// A chat: created, model set, then each turn a prompt at +10 + 100i and its end at +50 + 100i.
const chat = (conversation, provider, model, at, turns, extra = {}) => [[conversation, 'created', { provider, title: 't', folder: '', ...extra }, at],
  [conversation, 'config', { model: { current: model, options: [{ value: model }] }, pickers: [] }, at + 1],
  ...turns.flatMap((end, i) => [[conversation, 'user', { text: 'x' }, at + 10 + i * 100], [conversation, 'turn-end', end, at + 50 + i * 100]])];
// 5000 events that make no row, after the 40-day-old chat: the replay's first page (LIMIT 5000) ends inside them, so
// the rebuild commits that chat's row a page before the rest (the partial-history window the upgrade test watches).
const FILLER = Array.from({ length: 5000 }, (_, i) => [Q, 'answered', { request: 'r' + i }, NOW - 39 * DAY + i]);
const EVENTS = [
  ...chat(E, 'claude', 'opus', NOW - 40 * DAY, [usage(1000000, 0, 0, 0)]), // 40 days old: only in the 90-day view, $4.00
  ...FILLER,
  // Day 1
  ...chat(A, 'claude', 'opus', T, [usage(1000, 2000, 100000, 10000), usage(0, 500, 50000, 0)]), // $0.144 + $0.020
  ...chat(B, 'claude', 'sonnet', T + 1000, [usage(500, 1000, 200000, 0)]), // $0.031
  ...chat(C, 'codex', 'gpt-6.1-sol', T + 2000, [usage(3000, 400, 50000, 0)]), // Codex: no price
  ...chat(D, 'claude', 'glm-5.3:cloud', T + 3000, [usage(10, 20, 300, 0)]), // a model with no price
  // Day 2: chat A again (one chat, two days), a compaction turn whose usage says 0 but counted has the tokens (O190), a
  // turn that reported no counts, a provider profile's chat that calls its model "sonnet", and two Codex turns that end
  // at the 24-hour view's edge (J at CUT, outside; K at CUT + 1, inside).
  [A, 'user', { text: 'x' }, T + DAY], [A, 'turn-end', usage(0, 0, 10000, 0), T + DAY + 50], // $0.002
  ...chat(F, 'claude', 'opus', T + DAY + 1000, [{ ...usage(0, 0, 0, 0), counted: { inputTokens: 100, outputTokens: 1000, cachedReadTokens: 0, cachedWriteTokens: 5000 } },
    { stopReason: 'end_turn' }]), // $0.0004 + $0.02 + $0.04; then a turn with no counts
  ...chat(G, 'claude', 'sonnet', T + DAY + 2000, [usage(1000, 1000, 0, 0)], { profile: 'p1' }),
  // haiku: one whole turn ($0.0001) and one that reported no cache-write count: its tokens show, it is not priced.
  ...chat(H, 'claude', 'haiku', T + DAY + 3000, [usage(1000, 0, 0, 0), { stopReason: 'end_turn', usage: { inputTokens: 1000000, outputTokens: 0, cachedReadTokens: 0 } }]),
  ...chat(J, 'codex', 'gpt-6.1-sol', CUT - 50, [usage(1, 0, 0, 0)]),
  ...chat(K, 'codex', 'gpt-6.1-sol', CUT - 49, [usage(2, 0, 0, 0)]),
];
const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`);
const priced = (rows) => rows.reduce((total, row) => total + (row.usd ?? 0), 0);
const local = (ms) => new Date(ms).toLocaleDateString('sv'); // the daemon's local date, as SQLite's 'localtime' gives it

test('A3: turns from telemetry.db give the hand-worked tokens and dollars; no price is null, never $0', { timeout: 60000 }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-usage-turns-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ledgerFile = path.join(dir, 'p9.db'), file = path.join(dir, 'telemetry.db');
  const ledger = openLedger(ledgerFile);
  const insert = ledger.db.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)');
  for (const [conversation, type, data, at] of EVENTS) insert.run(conversation, type, JSON.stringify(data), at);
  // An upgrade: a schema-1 telemetry.db is there. The watcher sets it aside and rebuilds from the ledger, a page at a
  // time (delayMs holds each write); while it runs the route says unavailable (the old file) or rebuilding, never ok
  // with part of the history.
  const old = new DatabaseSync(file);
  old.exec('CREATE TABLE turns (key INTEGER PRIMARY KEY); PRAGMA user_version = 1');
  old.close();
  const read = (days, at = NOW) => readTurns({ file, exists: true, days, now: at });
  const telemetry = startTelemetry({ ledgerFile, file, delayMs: 1500 });
  const seen = [];
  let done = false;
  const idle = telemetry.idle().then(() => { done = true; });
  while (!done) { seen.push(read(90)); await new Promise((resolve) => setTimeout(resolve, 50)); }
  await idle;
  await telemetry.close();
  assert.ok((await readdir(dir)).some((name) => name.startsWith('telemetry.db.set-aside-')), 'the schema-1 file is kept aside');
  assert.ok(seen.some((page) => page.state === 'rebuilding'), 'rebuilding seen: ' + [...new Set(seen.map((page) => page.state))]);
  const final = JSON.stringify(read(90));
  assert.ok(seen.every((page) => page.state !== 'ok' || JSON.stringify(page) === final), 'no ok answer with part of the history');

  const month = read(30);
  assert.equal(month.state, 'ok');
  assert.equal(month.pricesAsOf, '2026-11-03');
  const one = local(T + 50), two = local(T + DAY + 50);
  assert.notEqual(one, two);
  // [day, provider, model, profile, turns, measured, priced, estimated]
  assert.deepEqual(month.rows.map((row) => [row.day, row.provider, row.model, row.profile, row.turns, row.measured, row.priced, row.estimated]), [
    [one, 'claude', 'glm-5.3:cloud', false, 1, 1, 0, 0], [one, 'claude', 'opus', false, 2, 2, 2, 0], [one, 'claude', 'sonnet', false, 1, 1, 1, 0], [one, 'codex', 'gpt-6.1-sol', false, 1, 1, 0, 0],
    [two, 'claude', 'haiku', false, 2, 2, 1, 0], [two, 'claude', 'opus', false, 3, 2, 2, 1], [two, 'claude', 'sonnet', true, 1, 1, 0, 0], [two, 'codex', 'gpt-6.1-sol', false, 2, 2, 0, 0]]);
  const [glm, opus, sonnet, codex, haiku, opus2, profile] = month.rows;
  assert.deepEqual([haiku.input, haiku.cacheWrite, haiku.total], [1001000, 0, 1000], 'both haiku turns show the counts they reported');
  assert.deepEqual(haiku.known, { input: 2, output: 2, cacheRead: 2, cacheWrite: 1, total: 1 }, 'and say how many turns each sum covers');
  close(haiku.usd, 0.0001, 'only the whole haiku turn is priced: 1000 x $0.10 / 1M');
  assert.deepEqual([opus.input, opus.output, opus.cacheRead, opus.cacheWrite, opus.total], [1000, 2500, 150000, 10000, 163500]);
  close(opus.usd, 0.164, 'opus dollars');
  close(opus.cost.input, 0.004, 'opus input: 1000 x $4 / 1M'); close(opus.cost.output, 0.05, 'opus output: 2500 x $20 / 1M');
  close(opus.cost.cacheRead, 0.03, 'opus cache read: 150000 x $0.20 / 1M'); close(opus.cost.cacheWrite, 0.08, 'opus cache write: 10000 x $8 / 1M');
  close(sonnet.usd, 0.031, 'sonnet dollars');
  close(opus.saved, 0.53, 'opus net cache saving: 160000 x $4 - 150000 x $0.20 - 10000 x $8, per 1M');
  close(sonnet.saved, 0.38, 'sonnet net cache saving: 200000 x $2 - 200000 x $0.10, per 1M');
  assert.deepEqual([opus2.input, opus2.output, opus2.cacheRead, opus2.cacheWrite, opus2.total], [100, 1000, 10000, 5000, 16100], 'the compaction turn counts what counted says');
  close(opus2.usd, 0.0624, 'day 2 opus: $0.002 + $0.0604');
  close(opus2.saved, 0.018, 'day 2 opus net cache saving: 15000 x $4 - 10000 x $0.20 - 5000 x $8, per 1M');
  assert.deepEqual([profile.total, profile.cost, profile.usd, profile.saved], [2000, null, null, null], "a profile's 'sonnet' is another service: no price");
  assert.deepEqual([codex.total, codex.cost, codex.usd], [53400, null, null], 'Codex shows its tokens with no price');
  assert.equal(glm.usd, null, 'unknown model: no price');
  close(priced(month.rows), 0.2575, '30-day dollars');
  assert.deepEqual(month.chats, { claude: 6, codex: 3 }, 'chat A, on two days, counts once');

  const quarter = read(90);
  close(priced(quarter.rows), 4.2575, 'the 40-day-old turn joins the 90-day view');
  assert.deepEqual(quarter.chats, { claude: 7, codex: 3 });
  const day = read(1);
  assert.deepEqual(day.rows.map((row) => [row.provider, row.model, row.turns, row.total]),
    [['claude', 'haiku', 2, 1000], ['claude', 'opus', 3, 16100], ['claude', 'sonnet', 1, 2000], ['codex', 'gpt-6.1-sol', 1, 2]], 'J ends at the cut and is out; K, 1 ms later, is in');
  assert.deepEqual(day.chats, { claude: 4, codex: 1 });
  assert.equal(read('all').days, 7, 'an unknown range is 7 days');
  const plan = new DatabaseSync(file, { readOnly: true });
  const steps = plan.prepare("EXPLAIN QUERY PLAN SELECT count(*) FROM turns WHERE end_at > ? AND end_at <= ?").all(0, NOW).map((row) => row.detail).join('; ');
  plan.close();
  assert.match(steps, /turns_end_at/, 'the window reads through the end_at index: ' + steps);

  // A rebuild cut short: only the first page's row (chat E) is there, user_version still 0. A start whose writes fail
  // (the file held locked) leaves it unmarked, and so does a later catch-up from past the dropped pages (a queue gap);
  // the next clean start backfills the missing turns, once each, and marks it.
  const lock = new DatabaseSync(file);
  lock.prepare('DELETE FROM turns WHERE conversation != ?').run(E);
  lock.exec('PRAGMA user_version = 0; BEGIN IMMEDIATE');
  assert.equal(read(90).state, 'rebuilding');
  const locked = startTelemetry({ ledgerFile, file, cap: 1 });
  await locked.idle();
  assert.ok(locked.stats().droppedRows > 0, 'the replay could not write: ' + JSON.stringify(locked.stats()));
  lock.exec('COMMIT');
  lock.close();
  for (const n of [1, 2]) locked.push({ cursor: 1e9 + n, conversation: Q, type: 'answered', data: { request: 'late' + n }, at: NOW });
  await locked.idle();
  assert.ok(locked.stats().droppedEvents > 0, 'the queue overflowed, so the worker caught up from the ledger');
  await locked.close();
  assert.equal(read(90).state, 'rebuilding', 'a catch-up that did not start at the beginning does not mark the file whole');
  const again = startTelemetry({ ledgerFile, file });
  await again.idle();
  await again.close();
  assert.equal(JSON.stringify(read(90)), final, 'the next start backfills the missing turns, each once');

  const fresh = readTurns({ file: path.join(dir, 'missing.db'), exists: false, days: 7 });
  assert.deepEqual([fresh.state, fresh.rows, fresh.chats], ['ok', [], {}], 'no telemetry.db yet (no turn recorded): empty, not an error');
  const damaged = path.join(dir, 'damaged.db');
  await writeFile(damaged, 'not a database '.repeat(100));
  assert.equal(readTurns({ file: damaged, exists: true, days: 7 }).state, 'unavailable', 'a file that is not a database: unavailable, not empty');
  assert.equal(readTurns({ file: path.join(dir, 'nowhere', 'telemetry.db'), exists: true, days: 7 }).state, 'unavailable', 'there but cannot be opened: unavailable, not empty');
});

test('A3: the daemon answers /usage/turns from its own telemetry.db', { timeout: 90000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', path.join(root, 'test/fake-acp-agent.mjs')] }));
  const call = (route, method = 'GET', body) => http({ socketPath: instance.credentials.socketPath, route, method,
    headers: { ...authenticated(instance.credentials), ...(body && { 'content-type': 'application/json', 'x-p9-op': randomUUID() }) },
    body: body && JSON.stringify(body) }).then((r) => (/json/.test(r.headers['content-type'] ?? '') ? JSON.parse(r.text) : r.text));
  const before = await call('/usage/turns?days=30');
  assert.deepEqual([before.state, before.days, before.rows], ['ok', 30, []], 'a new install: no turns yet');
  const chat = (await call('/chat', 'POST', { provider: 'claude' })).conversation;
  await call(`/chat/${chat}/prompt`, 'POST', { text: 'spend' });
  let page;
  for (let i = 0; i < 80 && !page?.rows?.length; i += 1) { page = await call('/usage/turns?days=1'); if (!page?.rows?.length) await new Promise((resolve) => setTimeout(resolve, 250)); }
  assert.equal(page.state, 'ok', JSON.stringify(page));
  assert.deepEqual([page.rows.length, page.rows[0].provider, page.rows[0].turns, page.chats], [1, 'claude', 1, { claude: 1 }], JSON.stringify(page));
  assert.ok(!JSON.stringify(page).includes(chat), 'no chat id in the answer');
});
