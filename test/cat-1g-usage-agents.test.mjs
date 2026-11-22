// CAT-1g: the Usage page draws one plan line per agent in /usage's limits (one key per catalog agent), named from GET
// /agents, with each agent's own signed-out mark; an older daemon's { claude, codex } draws the two it always did.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as helpers from '../apps/web/src/helpers.mjs';

const now = Date.now(), reading = (five) => ({ asOf: now, fiveHour: { usedPercent: five, resetsAt: null }, sevenDay: null });
const names = { claude: 'Claude', codex: 'Codex', kestrel: 'Kestrel' };

test('CAT-1g: a catalog-only agent in /usage limits gets its own plan line, named, and its own signed-out mark', () => {
  const lines = helpers.limitLines?.({ claude: reading(40), codex: null, kestrel: reading(12), signedOut: ['codex'] }, names) ?? [];
  assert.deepEqual(lines.map((l) => l.name), ['Claude', 'Codex', 'Kestrel'], 'one line per agent, in /usage order');
  assert.match(lines[2]?.text ?? '', /^5 h 12% · week n\/a · just now$/);
  assert.equal(lines[1]?.text, 'Codex not logged in');
  const out = helpers.limitLines?.({ claude: null, kestrel: null, signedOut: ['kestrel', 'claude'] }, names) ?? [];
  assert.deepEqual(out.map((l) => l.text), ['Claude not logged in', 'Kestrel not logged in'], 'any agent can be signed out, Claude too');
  assert.equal(helpers.limitLines?.({ ospr: reading(5) }, names)?.[0]?.name, 'ospr', 'an agent GET /agents has not named yet shows its id');
});

test('CAT-1g: an older daemon\'s limits draw Claude and Codex as before', () => {
  const lines = helpers.limitLines?.({ claude: reading(42), codex: null }, names) ?? [];
  assert.deepEqual(lines.map((l) => [l.name, l.text]), [['Claude', '5 h 42% · week n/a · just now'], ['Codex', 'no plan limits recorded yet']]);
  assert.deepEqual(helpers.limitLines?.(undefined, names), [], 'no limits: no lines');
});

test('CAT-1g: the Usage card shows the first agent with a reading, not a signed-out or empty one before it', () => {
  assert.equal(helpers.limitCard?.({ claude: null, codex: null, kestrel: reading(30), signedOut: ['claude'] }, names)?.name, 'Kestrel');
  assert.equal(helpers.limitCard?.({ claude: reading(42), codex: reading(9) }, names)?.name, 'Claude', 'Claude first when it has one');
  assert.equal(helpers.limitCard?.({ claude: null, codex: null }, names)?.text, 'no plan limits recorded yet', 'none read: the first line');
  assert.equal(helpers.limitCard?.({}, names), undefined, 'no agents: no line');
});
