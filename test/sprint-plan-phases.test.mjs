// Sprint Setup I1 (server half): the plan view the I1 line opens needs each item's phase and each phase's own text.
// (1) planItems gives each item the index of its phase, null above the first phase heading and after a heading that
// closes the last phase ("## What I will need from you"); a "### Checks" under a phase stays in it. (2) phasesOf gives
// each phase its section as written, capped in code points (no emoji cut in half), a phase and over the whole plan.
// (3) status reads the plan once, so its items and phases cannot come from two versions of the file; a closing heading's
// line is in no phase's total.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHooks } from '../apps/server/sprint-hooks.mjs';
import * as files from '../apps/server/sprint-files.mjs';

// A namespace import, so on a build without the caps each test fails at its own assertion, not at load.
const { phasesOf, planItems } = files, PHASE_TEXT = files.PHASE_TEXT ?? 4000, PLAN_TEXT = files.PLAN_TEXT ?? 32000;

const plan = '# Plan\n\nGoal: ship\n\n- [ ] Z0: above any phase. Role: w1.\n\n## Phase 1: build\n\n- [ ] A1: one. Role: w1.\n### Checks\n- [ ] A2: two. Role: w1.\nEvidence: run 123456\n\n'
  + '## Phase 2 — ship\n- [ ] B1: three. Role: w1.\n\n## What I will need from you\n- [ ] N1: a deploy. Role: w1.\n';

test('Sprint plan phases: each item names its phase, null outside every phase', () => {
  const got = planItems(plan).map((i) => [i.id, i.phase]);
  assert.deepEqual(got, [['Z0', null], ['A1', 0], ['A2', 0], ['B1', 1], ['N1', null]], JSON.stringify(got));
  assert.deepEqual(planItems(null), []);
  assert.deepEqual(planItems('- [ ] A: no phases\n').map((i) => i.phase), [null]);
  console.log('PASS Sprint plan phases: Z0 above, A1/A2 in Phase 1 (### Checks kept), B1 in Phase 2, N1 after "## What I will need" in none');
});

test('Sprint plan phases: each phase carries its own section text, the next heading at its level ends it', () => {
  const got = phasesOf(plan);
  assert.deepEqual(got.map((p) => p.title), ['Phase 1: build', 'Phase 2 — ship']);
  assert.equal(got[0].text, '- [ ] A1: one. Role: w1.\n### Checks\n- [ ] A2: two. Role: w1.\nEvidence: run 123456');
  assert.equal(got[1].text, '- [ ] B1: three. Role: w1.');
  assert.deepEqual(got.map((p) => p.truncated), [false, false]);
  // A deeper phase heading still opens a new phase (as main's phase line counts them).
  assert.deepEqual(phasesOf('## Phase 1\n- [ ] A\n### Phase 2\n- [ ] B\n').map((p) => [p.title, p.text]), [['Phase 1', '- [ ] A'], ['Phase 2', '- [ ] B']]);
  assert.deepEqual(phasesOf('# Plan\n- [ ] A\n'), []);
  console.log('PASS Sprint plan phases: Phase 1 holds its items, ### Checks and Evidence; Phase 2 stops at "## What I will need"');
});

test('Sprint plan phases: the text is capped in code points, a phase and over the plan', () => {
  // A phase one emoji over the cap: cut at PHASE_TEXT code points, no lone surrogate, truncated.
  const [one] = phasesOf('## Phase 1\n' + '😀'.repeat(PHASE_TEXT + 1));
  assert.equal(Array.from(one.text).length, PHASE_TEXT);
  assert.ok(one.truncated);
  assert.doesNotMatch(one.text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, 'no half emoji');
  // The plan's whole budget: a phase past it gets no text and says it was cut; a short phase before it is whole.
  const full = Math.ceil(PLAN_TEXT / PHASE_TEXT);
  const many = phasesOf(Array.from({ length: full + 1 }, (_, n) => `## Phase ${n + 1}\n${'x'.repeat(PHASE_TEXT)}`).join('\n'));
  assert.equal(many.reduce((n, p) => n + p.text.length, 0), PLAN_TEXT);
  assert.deepEqual([many.at(-1).text, many.at(-1).truncated, many[0].truncated], ['', true, false]);
  console.log(`PASS Sprint plan phases: ${PHASE_TEXT} code points a phase, ${PLAN_TEXT} over the plan, the rest marked truncated`);
});

test('Sprint plan phases: status reads the plan once; items, phases and totals agree', async () => {
  const id = '55555555-5555-4555-8555-555555555555', c1 = '66666666-6666-4666-8666-666666666666';
  // The plan changes between two reads: the second read has no phases at all. One read keeps items and phases together.
  let reads = 0;
  const read = (c, name) => (name === 'sprint.md' ? (reads++ === 0 ? plan : '# Plan\n- [ ] A1: one. Role: w1.\n') : null);
  const chat = { lock: () => ({ on: false }), info: (c) => (c === id ? { title: 'S', provider: 'fake' } : c === c1 ? { title: 'w1', provider: 'fake', parent: id } : null),
    family: () => [{ id }, { id: c1, parent: id, key: 'w1' }], list: () => [{ id }, { id: c1 }], gauge: () => null, startFolder: async () => '.',
    sprint: (c) => (c === c1 ? { reviews: { A1: { state: 'passed', commit: 'a'.repeat(40), merged: true, at: 1 } } } : {}),
    scriptLibrary: () => [], allowScripts: () => false, mergedNow: async () => undefined,
    sprintFiles: { exists: (c) => c === id, read, folderOf: () => '.', log: () => {} },
    projects: { merge: () => true, started: () => ({ at: 1, by: 'owner', plan: null, scripts: [] }), closed: () => null, prepOf: () => null, record: async () => null } };
  const hooks = createHooks({ chat, usage: () => null, stateOf: () => 'idle', rolesOf: () => ({ error: 'none' }), allowed: async () => true });
  const got = await hooks.status(id, id);
  assert.equal(reads, 1, 'one read of sprint.md');
  assert.deepEqual(got.items.map((i) => [i.id, i.phase]), [['Z0', null], ['A1', 0], ['A2', 0], ['B1', 1], ['N1', null]]);
  assert.deepEqual(got.phases.map(({ title, merged, total, truncated }) => [title, merged, total, truncated]),
    [['Phase 1: build', 1, 2, false], ['Phase 2 — ship', 0, 1, false]], 'N1, after "## What I will need", is not in Phase 2');
  assert.match(got.phases[0].text, /Evidence: run 123456/);
  assert.equal(got.phase_now, 0);
  console.log('PASS Sprint plan phases: one read; Phase 1 1/2, Phase 2 0/1 (N1 left out), items carry 0/1/null, Phase 1 text has its evidence');
});
