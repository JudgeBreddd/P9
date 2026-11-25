// O244 (b): P9 keeps its own record of plan use. Every 10 minutes one row per provider and window goes into
// usage-limits.db beside the ledger: used %, when it resets, the projected % at that reset, the pace word and how old
// the reading was. /usage and plan_usage carry the projection. Providers come from the readings, so a catalog-only agent
// gets rows with no source change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { daemon, http, authenticated, root } from './helpers.mjs';

const MIN = 60000, HOUR = 60 * MIN, T0 = Date.UTC(2026, 10, 24, 12);
const load = () => import('../apps/server/usage-history.mjs').catch(() => ({}));
const file = async () => path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-usage-history-')), 'usage-limits.db');

test('O244: stub readings at known times give the projection and pace word, and each tick writes one row per provider and window, a catalog-only one too', async () => {
  const { startUsageHistory, projectAt } = await load();
  assert.equal(typeof startUsageHistory, 'function', 'usage-history.mjs records plan use');
  // Window average: 5 h window, 2 h gone, 40% used -> 20%/h, 3 h left -> 100%.
  const five = (used, at) => ({ usedPercent: used, resetsAt: T0 + 3 * HOUR, windowMins: 300, at });
  assert.equal(projectAt(five(40), T0, null), 100);
  // With a reading 60 min before: 40 -> 46 is 6%/h, 2 h left -> 58%.
  assert.equal(projectAt(five(46), T0 + 60 * MIN, { at: T0, used: 40 }), 58);
  assert.equal(projectAt({ ...five(40), resetsAt: T0 - MIN }, T0, null), null, 'a window already reset has no projection');
  assert.equal(projectAt({ ...five(2), resetsAt: T0 + 299 * MIN }, T0, null), null, 'one minute in, the average says nothing yet');
  assert.equal(projectAt(five(38), T0, { at: T0 - HOUR, used: 40 }), 95, 'a reading revised down: the window average, not a flat or falling rate');
  assert.equal(projectAt(five(46), T0, { at: T0 - HOUR, used: 40 }), 64, 'a reading 60 min before: 6%/h, 3 h left');

  let reading = null;
  const at = { now: T0 }, f = await file();
  const history = startUsageHistory({ file: f, read: async () => reading, everyMs: 0, now: () => at.now });
  const third = (used, asOf) => ({ fiveHour: { usedPercent: used, resetsAt: T0 + 3 * HOUR, windowMins: 300 },
    sevenDay: { usedPercent: 10, resetsAt: T0 + 100 * HOUR, windowMins: 10080 }, models: [{ name: 'x', usedPercent: 1 }], asOf, stale: false, pool: 'third-plan' });
  reading = { third: third(40, T0 - MIN), claude: null, signedOut: ['codex'] };
  assert.equal(await history.tick(), 2, 'one row per window of the one provider with a reading');
  // 60 min later: the first reading is 61 min old, inside 35-90 min, so the rate comes from it.
  at.now = T0 + 60 * MIN; reading = { third: third(46, at.now - MIN) };
  const shown = history.annotate(reading).third;
  assert.equal(shown.fiveHour.projected, 58.1, 'the projection from the rate since the reading 61 min before');
  assert.equal(await history.tick(), 2);
  history.close();
  const db = new DatabaseSync(f, { readOnly: true });
  const rows = db.prepare('SELECT at, provider, win, used_pct, resets_at, window_mins, projected_pct, pace, as_of, age_ms FROM limits ORDER BY at, win').all().map((r) => ({ ...r }));
  assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'limits'").get().sql, /STRICT/);
  db.close();
  assert.deepEqual(rows.map((r) => [r.at - T0, r.provider, r.win, r.used_pct, r.pace, r.age_ms]), [
    [0, 'third', 'fiveHour', 40, 'on', MIN], [0, 'third', 'sevenDay', 10, 'headroom', MIN],
    [60 * MIN, 'third', 'fiveHour', 46, 'headroom', MIN], [60 * MIN, 'third', 'sevenDay', 10, 'headroom', MIN]]);
  assert.equal(rows[2].projected_pct, 58.1);
  assert.equal(rows[0].projected_pct, Math.round((40 + 40 / (2 * HOUR - MIN) * (3 * HOUR + MIN)) * 10) / 10, 'the first one falls back to the window average');
  assert.deepEqual([rows[0].resets_at, rows[0].window_mins, rows[0].as_of], [T0 + 3 * HOUR, 300, T0 - MIN]);
  // A read that throws writes nothing and the next tick still works.
  const failing = startUsageHistory({ file: f, read: async () => { throw new Error('boom'); }, everyMs: 0, log: () => {} });
  assert.equal(await failing.tick(), 0);
  failing.close();
});

test('O244: through the daemon, /usage and plan_usage carry the projection and a tick writes usage-limits.db without starting a usage read', { timeout: 90000 }, async (t) => {
  const fake = path.join(root, 'test/fake-acp-agent.mjs');
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake, '--codex-usage', path.join(root, 'test/fake-codex-app-server.mjs')],
    env: { P9_USAGE_HISTORY_MS: '300' } }));
  await mkdir(path.join(instance.directory, '.codex'), { recursive: true });
  await writeFile(path.join(instance.directory, '.codex', 'auth.json'), '{}');
  const call = (route) => http({ socketPath: instance.credentials.socketPath, route, headers: authenticated(instance.credentials) }).then((r) => JSON.parse(r.text));
  const f = path.join(instance.directory, '.local', 'state', 'p9-foundation', 'usage-limits.db');
  const count = () => { if (!existsSync(f)) return 0; const db = new DatabaseSync(f, { readOnly: true }); try { return db.prepare("SELECT count(*) AS n FROM limits WHERE provider = 'codex'").get().n; } catch { return 0; } finally { db.close(); } };
  // Nobody has looked at usage yet: the ticks start no usage read, so nothing is recorded.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(count(), 0, 'a tick before anyone looks starts no read');
  let page;
  for (let i = 0; i < 40 && !page?.codex; i += 1) { page = (await call('/usage')).limits; if (!page.codex) await new Promise((resolve) => setTimeout(resolve, 250)); }
  assert.ok(Number.isFinite(page.codex.fiveHour.projected), '/usage carries the projection: ' + JSON.stringify(page.codex.fiveHour));
  const plan = await call('/usage/plan');
  assert.equal(typeof plan.providers.codex.fiveHour.projected, 'number', 'plan_usage carries it too');
  for (let i = 0; i < 40 && count() < 1; i += 1) await new Promise((resolve) => setTimeout(resolve, 250));
  assert.ok(count() >= 1, 'a tick after the look wrote codex rows');
});

test('O244: the base is the same window and was fresh; a reading is written once; null resets and per-model windows are kept; a failed read recovers; peek starts no read', async () => {
  const { startUsageHistory } = await load();
  assert.equal(typeof startUsageHistory, 'function', 'usage-history.mjs records plan use');
  const f = await file(), at = { now: T0 - 60 * MIN };
  let reading, fail = false;
  const history = startUsageHistory({ file: f, read: async () => { if (fail) throw new Error('down'); return reading; }, everyMs: 0, now: () => at.now, log: () => {} });
  // 61 min before T0: the window before this one (it resets 30 min before T0, at 90%), and a week reading already 15 min old.
  reading = { third: { fiveHour: { usedPercent: 90, resetsAt: T0 - 30 * MIN, windowMins: 300 }, asOf: T0 - 61 * MIN },
    late: { sevenDay: { usedPercent: 0, resetsAt: T0 + 100 * HOUR, windowMins: 10080 }, asOf: T0 - 75 * MIN } };
  assert.equal(await history.tick(), 2);
  assert.equal(await history.tick(), 0, 'the same readings again write nothing');
  fail = true;
  assert.equal(await history.tick(), 0, 'a read that throws writes nothing');
  fail = false;
  at.now = T0;
  reading = { third: { fiveHour: { usedPercent: 40, resetsAt: T0 + 3 * HOUR, windowMins: 300 }, sevenDay: { usedPercent: 7, resetsAt: null, windowMins: 10080 },
    models: [{ name: 'big', usedPercent: 5, resetsAt: T0 + 100 * HOUR, windowMins: 10080 }], asOf: T0 },
    late: { sevenDay: { usedPercent: 10, resetsAt: T0 + 100 * HOUR, windowMins: 10080 }, asOf: T0 } };
  const shown = history.annotate(reading), atT0 = reading;
  assert.equal(shown.third.fiveHour.projected, 100, 'the last window\'s 90% is not this window\'s base: the window average');
  assert.equal(shown.late.sevenDay.projected, 24.7, 'a base that was 15 min old when written is not used: the window average');
  assert.equal(shown.third.sevenDay.projected, null, 'no reset, no projection');
  assert.equal(shown.third.models[0].projected, 12.4, 'a per-model window is projected too');
  assert.equal(await history.tick(), 4, 'after the failure the next tick writes again: the null-reset and per-model windows too');
  // The same window by its exact reset: a reading of a window resetting 5 min later is not its base.
  at.now = T0 + 40 * MIN;
  const near = { third: { fiveHour: { usedPercent: 41, resetsAt: T0 + 3 * HOUR + 5 * MIN, windowMins: 300 }, asOf: at.now } };
  assert.equal(history.annotate(near).third.fiveHour.projected, Math.round((41 + 41 / (2 * HOUR - 5 * MIN + 40 * MIN) * (3 * HOUR - 35 * MIN)) * 10) / 10);
  // Another writer holds the database: the tick writes nothing and does not wait; once it lets go, the next writes all.
  reading = { a: { fiveHour: { usedPercent: 1, resetsAt: T0 + 3 * HOUR, windowMins: 300 }, asOf: at.now }, b: { fiveHour: { usedPercent: 1, resetsAt: T0 + 3 * HOUR, windowMins: 300 }, asOf: at.now } };
  const other = new DatabaseSync(f);
  other.exec('BEGIN IMMEDIATE');
  const started = Date.now();
  assert.equal(await history.tick(), 0);
  assert.ok(Date.now() - started < 1000, 'the tick did not wait on the lock');
  assert.equal(other.prepare("SELECT count(*) AS n FROM limits WHERE provider IN ('a', 'b')").get().n, 0, 'nothing partial');
  other.exec('ROLLBACK');
  assert.equal(await history.tick(), 2);
  // A tick whose second row fails writes neither (one transaction); with that fixed, a long provider name is kept.
  const long = 'd'.repeat(70);
  reading = { c: { fiveHour: { usedPercent: 1, resetsAt: T0 + 3 * HOUR, windowMins: 300 }, asOf: at.now }, [long]: { fiveHour: { usedPercent: 1, resetsAt: T0 + 3 * HOUR, windowMins: 300 }, asOf: at.now } };
  other.exec(`CREATE TRIGGER refuse BEFORE INSERT ON limits WHEN NEW.provider = '${long}' BEGIN SELECT RAISE(ABORT, 'refused'); END`);
  assert.equal(await history.tick(), 0);
  assert.equal(other.prepare("SELECT count(*) AS n FROM limits WHERE provider = 'c'").get().n, 0, 'the first row of the failed tick was rolled back');
  other.exec('DROP TRIGGER refuse'); other.close();
  assert.equal(await history.tick(), 2, 'both rows, the 70-character provider name too');
  // A reading taken before its window reset, looked at after: no live projection.
  at.now = T0 + 4 * HOUR;
  assert.equal(history.annotate(atT0).third.fiveHour.projected, null);
  history.close();
  const db = new DatabaseSync(f, { readOnly: true });
  const rows = db.prepare('SELECT provider, win, resets_at, projected_pct, pace FROM limits WHERE as_of = ? ORDER BY provider, win').all(T0).map((r) => ({ ...r }));
  db.close();
  assert.deepEqual(rows.map((r) => [r.provider, r.win, r.resets_at === null, r.projected_pct, r.pace]), [
    ['late', 'sevenDay', false, 24.7, 'headroom'], ['third', 'fiveHour', false, 100, 'on'], ['third', 'models.big', false, 12.4, 'headroom'], ['third', 'sevenDay', true, null, null]]);
  // The tick reads polls with peek(): the last answer, and no read started.
  const { createPoll } = await import('../apps/server/claude-usage.mjs');
  let reads = 0;
  const poll = createPoll({ name: 'test', read: async () => { reads += 1; return {}; }, log: () => {} });
  assert.equal(poll.peek?.(), null, 'peek answers the last reading, none yet');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(reads, 0, 'peek starts no read');
  await poll.close();
});
