// O162 (PRs an hour): the status answer's prs_per_hour is the items merged (P9's own merge record) per hour since
// Start, and the Sprint View draws that number. A record closed before the field existed draws no such row.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHooks } from '../apps/server/sprint-hooks.mjs';
import { statusHtml, usedText } from '../apps/web/src/sprint-view.mjs';

const id = '55555555-5555-4555-8555-555555555555', w = '66666666-6666-4666-8666-666666666666';
const plan = '# Plan\n\n- [x] A1: one; role w1\n- [x] A2: two; role w1\n- [x] A3: three; role w1\n- [ ] A4: four; role w1\n';
const merged = (item) => ({ state: 'passed', commit: 'a'.repeat(40), fixes: 0, merged: true, at: 1 });
const esc = (v) => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function hooksAt(startedAt, closed = null) {
  const chat = { lock: () => ({ on: false }), allowScripts: () => true, mergedNow: async () => undefined, gauge: () => null, startFolder: async () => '.',
    info: (c) => (c === id ? { title: 'S', provider: 'fake', project: 'p' } : c === w ? { title: 'w1', provider: 'fake', project: 'p', parent: id } : null),
    family: () => [{ id, project: 'p', title: 'S' }, { id: w, parent: id, key: 'w1' }], list: () => [],
    sprint: (c) => (c === w ? { reviews: { A1: merged(), A2: merged(), A3: merged(), A4: { state: 'passed', commit: 'b'.repeat(40), fixes: 0, at: 1 } } } : {}),
    sprintFiles: { exists: (c) => c === id, read: (_s, f) => (f === 'sprint.md' ? plan : null), folderOf: () => '.', log: () => {} },
    projects: { merge: () => true, started: () => ({ at: startedAt, by: 'owner', plan: null, scripts: [] }), closed: () => closed, prepOf: () => null, record: async () => ({ name: 'P' }) } };
  return createHooks({ chat, usage: () => null, stateOf: () => 'running', rolesOf: () => ({ error: 'none' }), allowed: async () => true });
}

test('Sprint View PRs an hour: merged items over hours since Start, from the status answer to the page; none on an older record', async () => {
  const got = await hooksAt(Date.now() - 2 * 3_600_000).status(id, id);
  assert.equal(got.done.merged, 3, JSON.stringify(got.done));
  assert.equal(got.prs_per_hour, Math.round((got.done.merged * 10) / (got.running_ms / 3_600_000)) / 10);
  assert.equal(got.prs_per_hour, 1.5);
  assert.match(statusHtml(got, esc), /<dt>PRs an hour<\/dt><dd data-sv-fact="rate">1\.5<\/dd>/);
  // Ten minutes in with 3 merged: the count so far (that hour's), not 18 an hour.
  assert.equal((await hooksAt(Date.now() - 600_000).status(id, id)).prs_per_hour, 3);
  // A record closed before O162 has no prs_per_hour: no row, never "undefined".
  const { prs_per_hour: _gone, ...old } = got;
  const html = statusHtml({ ...old, closed: { at: '2026-11-01T10:00:00.000Z', by: 'owner' } }, esc);
  assert.doesNotMatch(html, /PRs an hour|data-sv-fact="rate"|undefined/);
  console.log('PASS O162 PRs an hour: 3 merged in 2 h answers 1.5 and the page draws 1.5; 3 in 10 min answers 3; an older record draws no row');
});

// O162 (usage): the status answer's spent is the sum of every chat's spent (list_chats' fold), and the page draws it.
function hooksWith(spent) {
  const chat = { lock: () => ({ on: false }), allowScripts: () => true, mergedNow: async () => undefined, gauge: (c) => ({ model: null, context: null, spent: spent[c] ?? null }), startFolder: async () => '.',
    info: (c) => (c === id ? { title: 'S', provider: 'fake', project: 'p' } : c === w ? { title: 'w1', provider: 'fake', project: 'p', parent: id } : null),
    family: () => [{ id, project: 'p', title: 'S' }, { id: w, parent: id, key: 'w1' }], list: () => [], sprint: () => ({}),
    sprintFiles: { exists: (c) => c === id, read: (_s, f) => (f === 'sprint.md' ? plan : null), folderOf: () => '.', log: () => {} },
    projects: { merge: () => true, started: () => ({ at: Date.now() - 60_000, by: 'owner', plan: null, scripts: [] }), closed: () => null, prepOf: () => null, record: async () => ({ name: 'P' }) } };
  return createHooks({ chat, usage: () => null, stateOf: () => 'running', rolesOf: () => ({ error: 'none' }), allowed: async () => true });
}

test('Sprint View usage: the sum of the sprint\'s chats\' spent, from the status answer to the page; none reported, no cost, and an older record', async () => {
  const lead = { inputTokens: 1_200_000, outputTokens: 30_000, cachedTokens: 900_000, costUsd: 2.5, turns: 4, tokens: 'x' };
  const one = { inputTokens: 300_000, outputTokens: 15_000, cachedTokens: 100_000, costUsd: 0.75, turns: 2, tokens: 'x' };
  const got = await hooksWith({ [id]: lead, [w]: one }).status(id, id);
  assert.deepEqual(got.spent, { inputTokens: 1_500_000, outputTokens: 45_000, cachedTokens: 1_000_000, costUsd: 3.25, turns: 6 });
  assert.deepEqual(got.workers.map((x) => x.spent), [lead, one], 'each chat keeps its own spent');
  assert.equal(usedText(got.spent), '1.5M in · 45K out · 1M cached · $3.25');
  assert.match(statusHtml(got, esc), /<dt>Used<\/dt><dd data-sv-fact="spent">1\.5M in · 45K out · 1M cached · \$3\.25<\/dd>/);
  // A chat that has reported nothing adds nothing; a field one does not report (or a bad one) counts 0.
  const half = await hooksWith({ [w]: { inputTokens: 10, outputTokens: 5, cachedTokens: NaN, turns: 1 } }).status(id, id);
  assert.deepEqual(half.spent, { inputTokens: 10, outputTokens: 5, cachedTokens: 0, costUsd: 0, turns: 1 });
  assert.equal(usedText(half.spent), '10 in · 5 out · 0 cached', 'no cost reported: no cost shown, never $0.00');
  // No chat has reported any: null, and the page says so.
  const none = await hooksWith({}).status(id, id);
  assert.equal(none.spent, null);
  assert.match(statusHtml(none, esc), /data-sv-fact="spent">Nothing reported yet</);
  // A record closed before the usage total existed has no spent: no row, never "undefined".
  const { spent: _gone, ...old } = got;
  assert.doesNotMatch(statusHtml({ ...old, closed: { at: '2026-11-01T10:00:00.000Z', by: 'owner' } }, esc), /<dt>Used<|data-sv-fact="spent"|undefined/);
  console.log('PASS O162 usage: two chats sum to 1.5M in, 45K out, 1M cached, $3.25 on the page; a silent chat adds nothing; none reported says so; an older record draws no row');
});
