// O164 FIX1 (legacy record): a sprint closed before done meant merged keeps its record as it was saved — done.passed,
// phases[].passed, reviews with no merged. The route answers it unchanged, and the render shows the old words and
// numbers: never "merged", never "undefined", and no count of it is merge evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHooks } from '../apps/server/sprint-hooks.mjs';
import { statusHtml } from '../apps/web/src/sprint-view.mjs';

// The record's shape as main saved it at Close: no merged anywhere, done counted the Reviewer's passed.
const id = '33333333-3333-4333-8333-333333333333', c1 = '44444444-4444-4444-8444-444444444444';
const record = {
  sprint: { id, title: 'Before the merge rule' },
  done: { passed: 1, ticked: 1, total: 2 },
  running_ms: 3_725_000,
  items: [
    { id: 'A1', text: 'the first thing', role: 'w1', ticked: true, review: { state: 'passed', commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', fixes: 0, at: 1 } },
    { id: 'A2', text: 'the second thing', role: 'w1', ticked: false, review: null }],
  phases: [{ title: 'Phase one', passed: 1, total: 2 }],
  phase_now: 0,
  workers: [{ chat: c1, key: 'w1', title: 'w1', model: 'claude', effort: 'low', state: 'stopped', waiting: false, work: { done: 1, total: 2 } }],
  scripts: { running: 0, additional: 0, waiting: 0 },
};

test('Sprint View legacy: a record saved before done meant merged answers unchanged and renders the old words', async () => {
  // The route: a closed sprint answers with its saved record as it is (sprint-hooks view), never reshaped.
  const chat = { lock: () => ({ on: false }), info: (c) => (c === id ? { title: 'S', provider: 'fake', project: 'p' } : c === c1 ? { title: 'w1', provider: 'fake', project: 'p', parent: id } : null),
    family: () => [{ id }], list: () => [{ id }], gauge: () => null, mergedNow: async () => null,
    sprintFiles: { exists: (c) => c === id, read: () => null, folderOf: () => '.', log: () => {} },
    projects: { merge: () => true, started: () => ({ at: 1, by: 'owner', plan: null, scripts: [] }), closed: () => ({ at: 2, by: 'owner', record }), prepOf: () => null, record: async () => null } };
  const hooks = createHooks({ chat, usage: () => null, stateOf: () => 'stopped', rolesOf: () => ({ error: 'none' }), allowed: async () => true });
  const got = await hooks.status(id, id); // as the sprint_status tool calls it (delegate.mjs: hooks.status(caller, args.sprint))
  assert.equal(got.closed.by, 'owner');
  assert.deepEqual(got.done, { passed: 1, ticked: 1, total: 2 }, 'the route answers the saved done shape as it is');
  assert.equal(got.done.merged, undefined);
  assert.equal(got.phases[0].passed, 1);
  assert.equal(got.items[0].review.merged, undefined);
  assert.equal(got.workers[0].work.done, 1);

  // The render: the old words and numbers, never "merged", never "undefined".
  const esc = (v) => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const html = statusHtml({ ...got, closed: { at: '2026-11-01T10:00:00.000Z', by: 'owner' } }, esc);
  assert.match(html, /1 of 2 items passed review/);
  assert.match(html, /aria-label="1 of 2 items passed review"/);
  assert.match(html, /1 of 2 steps in Phase one/);
  assert.match(html, /This record was saved before done meant merged: these counts are its reviews, not merge evidence\./);
  assert.doesNotMatch(html, /undefined/);
  assert.doesNotMatch(html, /merged(?!:)/); // only the fixed sentence may say the word; no count is called a merge
  assert.equal(html.includes('1 of 2 items merged'), false);
  assert.equal((html.match(/ring/g) || []).length > 0, true);
  console.log('PASS Sprint View legacy: a pre-O164 closed record renders as "1 of 2 items passed review" with its saved numbers, unchanged by the route, never as merge evidence and never "undefined"');
});
