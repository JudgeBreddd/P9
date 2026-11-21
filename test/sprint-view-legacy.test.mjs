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
  // I1: a record saved before items carried a phase has no item.phase and no phase text: the plain line and the flat list, no plan view.
  assert.deepEqual([html.includes('data-sv-plan'), html.includes('data-sv-planview'), html.includes('data-sv-flat')], [false, false, true]);
  console.log('PASS Sprint View legacy: a pre-O164 closed record renders as "1 of 2 items passed review" with its saved numbers, unchanged by the route, never as merge evidence and never "undefined"');
});

// I1 plan view (web half): the answer's items[].phase (index into phases[], null outside every phase) and phases[].text.
test('Sprint View plan view: items nest in their phase with their tick, then each phase in full; text is escaped, a cut is said', () => {
  const esc = (v) => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const it = (id, phase, ticked) => ({ id, text: id + ': thing', role: 'w1', ticked, review: null, phase });
  const html = statusHtml({ ...record, done: { merged: 0, ticked: 1, total: 3 },
    items: [it('Z1', null, false), it('A1', 0, true), it('A2', 0, false)],
    phases: [{ title: 'Phase one', merged: 0, total: 2, text: '- [x] A1 <b>x</b>\nCheck: it draws', truncated: true },
      { title: 'Phase two', merged: 0, total: 0, text: '', truncated: false }] }, esc);
  assert.match(html, /<button type="button" class="sv-phase" data-sv-phase data-sv-plan="[^"]+" aria-expanded="false"[^>]*>0 of 2 steps in Phase one, 1 of 2 phases<\/button>/);
  const view = html.slice(html.indexOf('<div data-sv-planview'));
  assert.ok(view.startsWith('<div data-sv-planview hidden>'), 'closed until the line is pressed');
  // Each phase in order with its own items, the phase with none says so, then the items outside every phase.
  const groups = [...view.matchAll(/<h4>([^<]+)<\/h4>(?:<ul class="sv-items">(.*?)<\/ul>|<p class="hint">([^<]+))/gs)].slice(0, 3)
    .map(([, t, ul, none]) => [t, ul ? [...ul.matchAll(/data-sv-pitem="(\w+)"[^>]*><span class="box" aria-hidden="true">(.)/g)].map((m) => m[1] + m[2]) : none]);
  assert.deepEqual(groups, [['Phase one', ['A1☑', 'A2☐']], ['Phase two', 'No items in this phase.'], ['Outside every phase', ['Z1☐']]]);
  assert.equal((view.match(/data-sv-item=/g) || []).length, 0, 'nested rows are not counted as the flat list\'s rows');
  // Then each phase's section in full, escaped, with the cut said where the server cut it.
  assert.equal((view.match(/data-sv-phasetext/g) || []).length, 2);
  assert.ok(view.includes('<pre>- [x] A1 &lt;b&gt;x&lt;/b&gt;\nCheck: it draws</pre><p class="hint">Cut at 4000 characters here; the rest is in sprint.md.</p>'));
  assert.equal((view.match(/Cut at 4000/g) || []).length, 1, 'only the cut phase says it');
  assert.ok(view.includes('<h4>Phase two</h4><p class="hint">Nothing is written under this heading.</p>'), 'a heading with nothing under it says so');
  console.log('PASS Sprint View plan view: Phase one A1☑ A2☐, Phase two none, Outside Z1☐; two phase texts, escaped, one cut');
});
