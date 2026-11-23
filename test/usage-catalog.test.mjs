// CAT-1a: plan limits per catalog agent. planLimits loops the catalog and calls each agent's usage reader; a reading carries
// stale (older than the reader's staleMs) and pool. claude and codex give the numbers main gave for the same files.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { CATALOG } from '../apps/server/agents.mjs';
import * as limitsModule from '../apps/server/limits.mjs';
// A namespace import, so the assertions (not a missing export) are what fail on code without READERS.
const { planLimits } = limitsModule, READERS = limitsModule.READERS ?? {};

const HOUR = 3600000, MIN = 60000;
const stub = (usage) => Object.freeze({ id: 'stub', name: 'Stub', usage: Object.freeze({ staleMs: 1000, pool: 'stub-plan', hideSignedOut: false, ...usage }) });
const reading = (asOf) => ({ fiveHour: { usedPercent: 7, resetsAt: asOf + HOUR, windowMins: 300 }, sevenDay: null, asOf });

// Claude 42% / 90% from .claude.json, Codex 61% / 33% from a session file, both written fetchedAgo before now.
async function seed(fetchedAgo) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-usage-cat-')), now = Date.now(), at = now - fetchedAgo;
  const five = Math.round((now + HOUR) / 1000), week = Math.round((now + 42 * HOUR) / 1000);
  await writeFile(path.join(home, '.claude.json'), JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: at,
    utilization: { five_hour: { utilization: 42, resets_at: five }, seven_day: { utilization: 90, resets_at: week } } } }));
  const day = path.join(home, '.codex', 'sessions', '2026', '11', '22');
  await mkdir(day, { recursive: true });
  await writeFile(path.join(day, 'rollout-a.jsonl'), JSON.stringify({ timestamp: new Date(at).toISOString(), payload: { rate_limits: {
    primary: { used_percent: 61, window_minutes: 300, resets_at: five }, secondary: { used_percent: 33, window_minutes: 10080, resets_at: week } } } }) + '\n');
  return { home, now, at, five: five * 1000, week: week * 1000 };
}

test('usage catalog: a made-up agent added as data shows its reader\'s numbers, stale and pool, next to claude and codex', async () => {
  const { home, now } = await seed(MIN);
  const catalog = [...CATALOG, stub({ reader: 'stub' })], readers = { ...READERS, stub: () => reading(now - 2000) };
  const limits = await planLimits({ home, catalog, readers, now });
  assert.deepEqual(Object.keys(limits), ['claude', 'codex', 'stub']);
  assert.deepEqual(limits.stub, { ...reading(now - 2000), stale: true, pool: 'stub-plan', sharedWith: [] }, '2 s old against a 1 s limit');
  assert.equal((await planLimits({ home, catalog, readers: { ...READERS, stub: () => reading(now - 500) }, now })).stub.stale, false, 'inside its limit');
  assert.equal((await planLimits({ home, catalog, readers: { ...READERS, stub: () => ({ ...reading(now), asOf: undefined }) }, now })).stub.stale, true, 'a reading with no time is stale');
  assert.deepEqual([limits.claude.fiveHour.usedPercent, limits.codex.fiveHour.usedPercent], [42, 61]);
  console.log('PASS a stub agent as catalog data: its numbers, stale and pool');
});

test('usage catalog: claude and codex give main\'s numbers for the same files, plus stale and pool', async () => {
  const { home, now, at, five, week } = await seed(MIN);
  const limits = await planLimits({ home, now });
  // main's planLimits for these files (the readers are main's code, moved): the same objects without stale and pool.
  assert.deepEqual(limits, {
    claude: { fiveHour: { usedPercent: 42, resetsAt: five, windowMins: 300 }, sevenDay: { usedPercent: 90, resetsAt: week, windowMins: 10080 }, asOf: at, stale: false, pool: 'claude', sharedWith: [] },
    codex: { fiveHour: { usedPercent: 61, resetsAt: five, windowMins: 300 }, sevenDay: { usedPercent: 33, resetsAt: week, windowMins: 10080 }, asOf: at, stale: false, pool: 'codex', sharedWith: [] } });
  // 15 min is the line for both (the ledger's own).
  const old = await seed(16 * MIN), fresh = await seed(14 * MIN);
  const flags = async (s) => { const l = await planLimits({ home: s.home, now: s.now }); return [l.claude.stale, l.codex.stale]; };
  assert.deepEqual([await flags(old), await flags(fresh)], [[true, true], [false, false]]);
  // Each agent's poll and live reading reach only its own reader.
  const polled = { at: now, windows: { five_hour: { utilization: 5, resets_at: five / 1000 } } };
  const both = await planLimits({ home, now, polled: { claude: polled, codex: { at: now, windows: { primary: { usedPercent: 9, resetsAt: five / 1000, windowDurationMins: 300 } } } } });
  assert.deepEqual([both.claude.fiveHour.usedPercent, both.codex.fiveHour.usedPercent], [5, 9]);
  console.log('PASS claude 42/90 and codex 61/33 as on main; stale at 15 min for both; polls reach their own agent');
});

test('usage catalog: a reader that throws, is missing or names a built-in gives null for its agent only', async () => {
  const { home, now } = await seed(MIN);
  for (const [what, entry, readers] of [
    ['throws', stub({ reader: 'stub' }), { ...READERS, stub: () => { throw new Error('boom'); } }],
    ['rejects', stub({ reader: 'stub' }), { ...READERS, stub: async () => { throw new Error('boom'); } }],
    ['missing', stub({ reader: 'nope' }), READERS],
    ['a built-in name', stub({ reader: 'constructor' }), READERS]]) {
    const limits = await planLimits({ home, catalog: [...CATALOG, entry], readers, now });
    assert.equal(limits.stub, null, what);
    assert.deepEqual([limits.claude.fiveHour.usedPercent, limits.codex.fiveHour.usedPercent], [42, 61], what + ': the others still read');
  }
  console.log('PASS a broken reader nulls only its own agent');
});

test('usage catalog: the catalog says which agents hide their limits when signed out (codex only) and freezes usage', () => {
  assert.deepEqual(CATALOG.map((a) => [a.id, a.usage.reader, a.usage.staleMs, a.usage.pool, a.usage.hideSignedOut]),
    [['claude', 'claude-json', 15 * MIN, 'claude', false], ['codex', 'codex-files', 15 * MIN, 'codex', true]]);
  assert.ok(CATALOG.every((a) => Object.isFrozen(a.usage)));
});
