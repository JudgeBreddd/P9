// USE-1 web: a plan line takes the daemon's stale mark (each agent's own staleMs, apps/server/agents.mjs) and says when two
// agents in /usage limits count against one plan (the daemon's sharedWith, from the catalog pools), even when one has no
// reading; an older daemon sends neither and keeps the 1 h rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { limitLine, limitLines } from '../apps/web/src/helpers.mjs';
import { CATALOG } from '../apps/server/agents.mjs';
import { planLimits, READERS } from '../apps/server/limits.mjs';
import os from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';

const now = Date.now(), reading = (minsOld, extra) => ({ asOf: now - minsOld * 60000, fiveHour: { usedPercent: 40, resetsAt: null }, sevenDay: null, ...extra });
const names = { claude: 'Claude', codex: 'Codex', kestrel: 'Kestrel' };

test('USE-1 web: a plan line is stale by the daemon mark; an older daemon without one keeps the 1 h rule', () => {
  assert.equal(limitLine('K', reading(20, { stale: true }), now).stale, true, '20 min old, past its agent 15 min: stale');
  assert.equal(limitLine('K', reading(90, { stale: false }), now).stale, false, 'the daemon says fresh: fresh');
  assert.equal(limitLine('K', reading(20), now).stale, false, 'no mark, 20 min: fresh');
  assert.equal(limitLine('K', reading(61), now).stale, true, 'no mark, 61 min: stale');
});

test('USE-1 web: two agents on one plan each say so, named; agents on their own plans do not', () => {
  const lines = limitLines({ claude: reading(0, { pool: 'claude', sharedWith: ['kestrel'] }), codex: reading(0, { pool: 'codex', sharedWith: [] }),
    kestrel: reading(0, { pool: 'claude', sharedWith: ['claude'] }), signedOut: [] }, names);
  assert.deepEqual(lines.map((l) => [l.id, l.shared, l.text]), [
    ['claude', 'Kestrel', '5 h 40% · week n/a · shared plan with Kestrel · just now'],
    ['codex', '', '5 h 40% · week n/a · just now'],
    ['kestrel', 'Claude', '5 h 40% · week n/a · shared plan with Claude · just now']]);
  const old = limitLines({ claude: reading(0), codex: reading(0), signedOut: [] }, names);
  assert.deepEqual(old.map((l) => l.shared), ['', ''], 'an older daemon sends no sharedWith: nothing is shared');
});

test('USE-1 web: a plan partner with no reading (signed out) is still named on the reading that has one', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-use1w-share-'));
  const kestrel = { ...CATALOG[0], id: 'kestrel', usage: { ...CATALOG[0].usage, reader: 'stub-kestrel' } }, at = Date.now();
  const readers = { ...READERS, [CATALOG[0].usage.reader]: () => reading(0), 'stub-kestrel': () => null };
  const limits = await planLimits({ home, catalog: [...CATALOG, kestrel], readers, now: at });
  assert.equal(limits.kestrel, null, 'the partner has no reading');
  assert.deepEqual(limits[CATALOG[0].id].sharedWith, ['kestrel'], 'the daemon names it from the catalog pool');
  const lines = limitLines({ ...limits, signedOut: ['kestrel'] }, names);
  assert.equal(lines.find((l) => l.id === CATALOG[0].id).shared, 'Kestrel');
  assert.equal(lines.find((l) => l.id === 'kestrel').text, 'Kestrel not logged in');
});
