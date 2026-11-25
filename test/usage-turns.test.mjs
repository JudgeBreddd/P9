// A3: the Usage window's Tokens and Cost views read telemetry.db (usage-turns.mjs). The fixture ledger below goes through the
// real watcher (telemetry.mjs) to make telemetry.db; the totals and dollars were worked out by hand from PRICES before the
// first run: opus $4 / $20 / $0.20 / $8, sonnet $2 / $10 / $0.10 / $4 per million input / output / cache read / cache write.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { openLedger } from '../apps/server/ledger.mjs';
import { startTelemetry } from '../apps/server/telemetry.mjs';
import { readTurns } from '../apps/server/usage-turns.mjs';
import { daemon, http, authenticated } from './helpers.mjs';

const T = 1767000000000, DAY = 86400000, NOW = T + 2 * DAY;
const A = 'aaaaaaaa-0000-4000-8000-000000000001', B = 'bbbbbbbb-0000-4000-8000-000000000002', C = 'cccccccc-0000-4000-8000-000000000003';
const D = 'dddddddd-0000-4000-8000-000000000004', E = 'eeeeeeee-0000-4000-8000-000000000005';
const usage = (inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens) =>
  ({ stopReason: 'end_turn', usage: { inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens, totalTokens: inputTokens + outputTokens + cachedReadTokens + cachedWriteTokens } });
const chat = (id, provider, model, at, ...turns) => [[id, 'created', { provider, title: 't', folder: '' }, at],
  [id, 'config', { model: { current: model, options: [{ value: model }] }, pickers: [] }, at + 1],
  ...turns.flatMap((end, i) => [[id, 'user', { text: 'x' }, at + 10 + i * 100], [id, 'turn-end', end, at + 50 + i * 100]])];
const EVENTS = [
  ...chat(E, 'claude', 'opus', NOW - 40 * DAY, usage(1000000, 0, 0, 0)), // 40 days old: only in the 90-day view, $4.00
  ...chat(A, 'claude', 'opus', T, usage(1000, 2000, 100000, 10000), usage(0, 500, 50000, 0)), // $0.144 + $0.020
  ...chat(B, 'claude', 'sonnet', T + 1000, usage(500, 1000, 200000, 0)), // $0.031
  ...chat(C, 'codex', 'gpt-6.1-sol', T + 2000, usage(3000, 400, 50000, 0)), // Codex: no price
  ...chat(D, 'claude', 'glm-5.3:cloud', T + 3000, usage(10, 20, 300, 0)), // a model with no price
];
const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`);
const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);

test('A3: turns from telemetry.db give the hand-worked tokens and dollars; no price is null, never $0', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-usage-turns-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ledgerFile = path.join(dir, 'p9.db'), file = path.join(dir, 'telemetry.db');
  const ledger = openLedger(ledgerFile);
  const insert = ledger.db.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)');
  for (const [conversation, type, data, at] of EVENTS) insert.run(conversation, type, JSON.stringify(data), at);
  const telemetry = startTelemetry({ ledgerFile, file });
  await telemetry.idle();
  await telemetry.close();

  const month = readTurns({ file, days: 30, now: NOW });
  assert.equal(month.state, 'ok');
  assert.equal(month.pricesAsOf, '2026-11-03');
  const day = new Date(T + 50).toLocaleDateString('sv'); // the daemon's local date, as SQLite's 'localtime' gives it
  assert.deepEqual(month.rows.map((row) => [row.day, row.provider, row.model, row.turns]),
    [[day, 'claude', 'glm-5.3:cloud', 1], [day, 'claude', 'opus', 2], [day, 'claude', 'sonnet', 1], [day, 'codex', 'gpt-6.1-sol', 1]]);
  const [glm, opus, sonnet, codex] = month.rows;
  assert.deepEqual([opus.input, opus.output, opus.cacheRead, opus.cacheWrite, opus.total], [1000, 2500, 150000, 10000, 163500]);
  close(opus.usd, 0.164, 'opus dollars');
  close(sonnet.usd, 0.031, 'sonnet dollars');
  close(opus.saved, 0.57, 'opus cache savings: 150000 x ($4 - $0.20) / 1M');
  close(sonnet.saved, 0.38, 'sonnet cache savings: 200000 x ($2 - $0.10) / 1M');
  close(opus.cost.input, 0.004, 'opus input: 1000 x $4 / 1M'); close(opus.cost.output, 0.05, 'opus output: 2500 x $20 / 1M');
  close(opus.cost.cacheRead, 0.03, 'opus cache read: 150000 x $0.20 / 1M'); close(opus.cost.cacheWrite, 0.08, 'opus cache write: 10000 x $8 / 1M');
  assert.equal(codex.usd, null, 'Codex: no price');
  assert.equal(codex.cost, null);
  assert.equal(glm.usd, null, 'unknown model: no price');
  assert.equal(codex.total, 53400, 'Codex still shows its tokens');
  assert.equal(sum(month.rows, 'total'), 418730);
  close(sum(month.rows.filter((row) => row.usd != null), 'usd'), 0.195, '30-day dollars');
  assert.deepEqual(month.chats, { claude: 3, codex: 1 }, 'chats counted once each, not per row');

  const quarter = readTurns({ file, days: 90, now: NOW });
  close(sum(quarter.rows.filter((row) => row.usd != null), 'usd'), 4.195, 'the 40-day-old turn joins the 90-day view');
  assert.deepEqual(quarter.chats, { claude: 4, codex: 1 });
  assert.equal(readTurns({ file, days: 1, now: NOW }).rows.length, 0, 'nothing in the past 24 h');
  assert.equal(readTurns({ file, days: 'all', now: NOW }).days, 7, 'an unknown range is 7 days');
  const fresh = readTurns({ file: path.join(dir, 'missing.db'), days: 7 });
  assert.deepEqual([fresh.state, fresh.rows, fresh.chats], ['ok', [], {}], 'no telemetry.db yet (no turn recorded): empty, not an error');
});

test('A3: the daemon answers /usage/turns from its own telemetry.db', { timeout: 60000 }, async (t) => {
  const instance = await daemon(t);
  const call = (route) => http({ socketPath: instance.credentials.socketPath, route, headers: authenticated(instance.credentials) }).then((r) => JSON.parse(r.text));
  const page = await call('/usage/turns?days=30');
  assert.equal(page.state, 'ok', JSON.stringify(page));
  assert.equal(page.days, 30);
  assert.deepEqual(page.rows, [], 'a new install has no turns yet');
});
