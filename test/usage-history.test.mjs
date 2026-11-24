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
