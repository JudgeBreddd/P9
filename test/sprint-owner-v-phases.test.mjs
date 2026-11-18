// O164 part (3) FIX1: owner lines (a v id, Role: owner) leave the merge counts the same way everywhere, and only where
// the answer carries the owner projection. (1) A plan whose phases mix worker and owner lines gives each phase its own
// worker items: the phase slices line up with the plan, and an owner line is in no phase's steps. (2) A closed record
// saved before the owner projection existed keeps its Role: owner rows in the Plan list and shows no "Your items".
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHooks } from '../apps/server/sprint-hooks.mjs';
import { statusHtml } from '../apps/web/src/sprint-view.mjs';

const esc = (v) => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const id = '55555555-5555-4555-8555-555555555555', c1 = '66666666-6666-4666-8666-666666666666';

test('sprint-owner-v phases: owner lines in two phases leave each phase its own worker items and counts', async () => {
  // Phase 1: a worker line, then an owner line. Phase 2: a worker line, an owner line, a worker line. a1 has merged.
  const plan = '# Plan\n\n## Phase 1\n- [ ] a1: first. Role: w1.\n- [ ] P1v: the owner checks one.\n'
    + '## Phase 2\n- [ ] b1: second. Role: w1.\n- [ ] P2v: the owner checks two. Role: w1.\n- [ ] b2: third. Role: w1.\n';
  const chat = { lock: () => ({ on: false }), info: (c) => (c === id ? { title: 'S', provider: 'fake' } : c === c1 ? { title: 'w1', provider: 'fake', parent: id } : null),
    family: () => [{ id }, { id: c1, parent: id, key: 'w1' }], list: () => [{ id }, { id: c1 }], gauge: () => null, startFolder: async () => '.',
    sprint: (c) => (c === c1 ? { reviews: { a1: { state: 'passed', commit: 'a'.repeat(40), merged: true, at: 1 } } } : {}),
    scriptLibrary: () => [], allowScripts: () => false, mergedNow: async () => undefined,
    sprintFiles: { exists: (c) => c === id, read: (c, name) => (name === 'sprint.md' ? plan : null), folderOf: () => '.', log: () => {} },
    projects: { started: () => ({ at: 1, by: 'owner', plan: null, scripts: [] }), closed: () => null, prepOf: () => null, record: async () => null } };
  const hooks = createHooks({ chat, usage: () => null, stateOf: () => 'idle', rolesOf: () => ({ error: 'none' }), allowed: async () => true });
  const got = await hooks.status(id, id);
  assert.deepEqual(got.phases, [{ title: 'Phase 1', merged: 1, total: 1 }, { title: 'Phase 2', merged: 0, total: 2 }], 'phases: ' + JSON.stringify(got.phases));
  assert.equal(got.phase_now, 1);
  assert.deepEqual(got.done.total, 3);
  assert.deepEqual([got.owner.total, got.owner.items.map((i) => i.id)], [2, ['P1v', 'P2v']]);
  const html = statusHtml(got, esc);
  assert.match(html, /0 of 2 steps in Phase 2, 1 of 2 phases/);
  assert.match(html, /2 items to go\./, 'the to-go count is the worker lines not merged (b1, b2), not the owner lines');
  const listed = html.split('<h3>Plan items</h3>')[1] ?? '';
  assert.deepEqual([...listed.matchAll(/data-sv-item="([^"]+)"/g)].map((m) => m[1]), ['a1', 'b1', 'b2']);
  console.log('PASS sprint-owner-v phases: Phase 1 is 1/1 (a1), Phase 2 is 0/2 (b1, b2); the owner lines are in no phase, not in "to go", and only in Your items');
});

test('sprint-owner-v legacy: a closed record saved before the owner projection keeps its Role: owner row in the Plan list and has no Your items', () => {
  // main's shape at Close before this change: done counts merged over every item, no owner field.
  const record = { sprint: { id, title: 'Before owner lines' }, done: { merged: 1, ticked: 0, unproven: 0, total: 2 }, running_ms: 60_000,
    items: [{ id: 'A1', text: 'the worker thing', role: 'w1', ticked: true, review: { state: 'passed', commit: 'a'.repeat(40), merged: true, fixes: 0, at: 1 } },
      { id: 'O2', text: 'the owner thing. Role: owner', role: 'owner', ticked: false, review: null }],
    phases: [], phase_now: null, workers: [], scripts: { running: 0, additional: 0, waiting: 0 } };
  const html = statusHtml({ ...record, closed: { at: '2026-11-01T10:00:00.000Z', by: 'owner' } }, esc);
  const listed = html.split('<h3>Plan items</h3>')[1] ?? '';
  assert.deepEqual([...listed.matchAll(/data-sv-item="([^"]+)"/g)].map((m) => m[1]), ['A1', 'O2'], 'the saved owner row is shown as it stood');
  assert.match(listed, /the owner thing\. Role: owner/);
  assert.doesNotMatch(html, /Your items|data-sv-owner/);
  assert.match(html, /1 item to go\./, 'the old record counts as it was saved');
  console.log('PASS sprint-owner-v legacy: the pre-owner closed record lists A1 and O2 as saved, with no Your items block');
});
