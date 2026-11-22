// USE-1 web: a plan line takes the daemon's stale mark (each agent's own staleMs, apps/server/agents.mjs) and says when two
// agents in /usage limits count against one plan (their pool); an older daemon sends neither and keeps the 1 h rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { limitLine, limitLines } from '../apps/web/src/helpers.mjs';

const now = Date.now(), reading = (minsOld, extra) => ({ asOf: now - minsOld * 60000, fiveHour: { usedPercent: 40, resetsAt: null }, sevenDay: null, ...extra });
const names = { claude: 'Claude', codex: 'Codex', kestrel: 'Kestrel' };

test('USE-1 web: a plan line is stale by the daemon mark; an older daemon without one keeps the 1 h rule', () => {
  assert.equal(limitLine('K', reading(20, { stale: true }), now).stale, true, '20 min old, past its agent 15 min: stale');
  assert.equal(limitLine('K', reading(90, { stale: false }), now).stale, false, 'the daemon says fresh: fresh');
  assert.equal(limitLine('K', reading(20), now).stale, false, 'no mark, 20 min: fresh');
  assert.equal(limitLine('K', reading(61), now).stale, true, 'no mark, 61 min: stale');
});

test('USE-1 web: two agents on one plan each say so, named; agents on their own plans do not', () => {
  const lines = limitLines({ claude: reading(0, { pool: 'claude' }), codex: reading(0, { pool: 'codex' }), kestrel: reading(0, { pool: 'claude' }), signedOut: [] }, names);
  assert.deepEqual(lines.map((l) => [l.id, l.shared, l.text]), [
    ['claude', 'Kestrel', '5 h 40% · week n/a · shared plan with Kestrel · just now'],
    ['codex', '', '5 h 40% · week n/a · just now'],
    ['kestrel', 'Claude', '5 h 40% · week n/a · shared plan with Claude · just now']]);
  const old = limitLines({ claude: reading(0), codex: reading(0), signedOut: [] }, names);
  assert.deepEqual(old.map((l) => l.shared), ['', ''], 'an older daemon sends no pool: nothing is shared');
});
