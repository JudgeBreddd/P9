// The mechanical green check (scripts/green-check.mjs): an item merges only when CI on its commit is complete and green and
// each test its plan line names has exactly one passed line in the CI logs. Anything it cannot read refuses, naming what.
// A fake gh on PATH serves the runs, jobs and logs from a fixture folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { namedTests, results, rowOf } from '../scripts/green-check.mjs';
import { isPlan } from '../apps/server/sprint-files.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/green-check.mjs', import.meta.url));
const SHA = 'abcdef1234567890abcdef1234567890abcdef12';
const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const dir = process.env.FAKE_GH, route = process.argv.at(-1) || '';
if (fs.existsSync(path.join(dir, 'fail'))) { process.stderr.write(fs.readFileSync(path.join(dir, 'fail'), 'utf8')); process.exit(1); }
let m, name;
if (/actions\\/runs\\?head_sha=/.test(route)) name = 'runs.json';
else if ((m = /actions\\/runs\\/(\\d+)\\/jobs/.exec(route))) name = 'jobs-' + m[1] + '.json';
else if ((m = /actions\\/jobs\\/(\\d+)\\/logs/.exec(route))) name = 'log-' + m[1] + '.txt';
const f = name && path.join(dir, name);
if (!f || !fs.existsSync(f)) { process.stderr.write('gh: Not Found (HTTP 404)\\n'); process.exit(1); }
process.stdout.write(fs.readFileSync(f, 'utf8'));
`;
const PLAN = '# Plan\n\n## Items\n- [ ] O6: done means y; role hand\n- [ ] O7: done means x; role hand; Tests: test/a.test.mjs::alpha works | test/b.test.mjs::beta works\n';
// A job log as the CI Tests line writes it: spec's lines on stdout, test/file-limit.mjs's P9_PASS lines on stderr, one log.
const LOG = [
  '2026-11-20T10:00:00.0000000Z shard 0: test/a.test.mjs test/b.test.mjs test/c.test.mjs',
  '2026-11-20T10:00:00.0000000Z ▶ suite',
  '2026-11-20T10:00:00.1000000Z   ✔ alpha works (12.3ms)',
  '2026-11-20T10:00:00.1000000Z P9_PASS test/a.test.mjs :: alpha works',
  '2026-11-20T10:00:00.2000000Z   ✔ beta works when idle (4ms)',
  '2026-11-20T10:00:00.2000000Z P9_PASS test/b.test.mjs :: beta works when idle',
  '2026-11-20T10:00:00.3000000Z   ✔ gamma (1.2s)',
  '2026-11-20T10:00:00.3000000Z P9_PASS test/c.test.mjs :: gamma',
].join('\n');

function run({ plan = PLAN, runs = [{ id: 1, name: 'test', status: 'completed', conclusion: 'success' }],
  jobs = [{ id: 11, name: 'ubuntu', conclusion: 'success' }, { id: 12, name: 'windows', conclusion: 'skipped' }],
  logs = { 11: LOG }, jobsOf = {}, runsTotal, jobsTotal, fail = null, args, stdin } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'green-check-'));
  try {
    writeFileSync(join(dir, 'gh'), FAKE_GH); chmodSync(join(dir, 'gh'), 0o755);
    writeFileSync(join(dir, 'sprint.md'), plan);
    writeFileSync(join(dir, 'runs.json'), JSON.stringify({ total_count: runsTotal ?? runs.length, workflow_runs: runs }));
    for (const r of runs) { const j = jobsOf[r.id] ?? jobs; writeFileSync(join(dir, `jobs-${r.id}.json`), JSON.stringify({ total_count: jobsTotal ?? j.length, jobs: j })); }
    for (const [id, text] of Object.entries(logs)) writeFileSync(join(dir, `log-${id}.txt`), text);
    if (fail) writeFileSync(join(dir, 'fail'), fail);
    const argv = args ?? ['--item', 'O7', '--commit', SHA, '--repo', 'o/r', '--plan', join(dir, 'sprint.md')];
    const input = stdin ? JSON.stringify(stdin(dir)) : '';
    const r = spawnSync(process.execPath, [SCRIPT, ...(stdin ? [] : argv)], { input, encoding: 'utf8', cwd: dir,
      env: { ...process.env, PATH: dir + ':' + process.env.PATH, FAKE_GH: dir } });
    return { status: r.status, out: (r.stdout + r.stderr).trim() };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const refused = (r, words) => { assert.equal(r.status, 1, r.out); assert.match(r.out, /^green check refused: /m); assert.ok(r.out.includes(words), r.out); };

test('green check: every named test passed once in green CI passes, by hand and as a sprint script', () => {
  const byHand = run();
  assert.equal(byHand.status, 0, byHand.out);
  assert.equal(byHand.out, 'green: item O7, 2 named tests passed in CI on abcdef12');
  const asScript = run({ stdin: (dir) => ({ subject: { item: 'O7', by: 'lead' }, items: [{ id: 'O7', review: { commit: SHA } }],
    project: { source: 'https://github.com/o/r.git' }, sprint: { folder: dir } }) });
  assert.equal(asScript.status, 0, asScript.out);
  assert.match(asScript.out, /^green: item O7/);
});

test('green check refuses what it cannot read: no state, no item, not in the plan, no Tests clause', () => {
  refused(run({ args: [], stdin: null }), 'no sprint state on stdin');
  refused(run({ stdin: (dir) => ({ subject: {}, sprint: { folder: dir } }) }), 'no item');
  refused(run({ args: ['--item', 'O9', '--commit', SHA, '--repo', 'o/r', '--plan', 'sprint.md'] }), 'item O9: not in the plan');
  refused(run({ args: ['--item', 'O6', '--commit', SHA, '--repo', 'o/r', '--plan', 'sprint.md'] }), 'item O6: names no agreed tests');
  refused(run({ args: ['--item', 'O7', '--commit', SHA, '--repo', 'o/r', '--plan', 'nowhere.md'] }), 'cannot read the plan (nowhere.md)');
  refused(run({ args: ['--item', 'O7', '--repo', 'o/r', '--plan', 'sprint.md'] }), 'item O7: no commit');
});

test('green check refuses CI that is missing, pending or red, and a gh that fails', () => {
  refused(run({ runs: [] }), 'no CI run on abcdef12');
  refused(run({ runs: [{ id: 1, name: 'test', status: 'in_progress', conclusion: null }] }), 'is not complete (test)');
  refused(run({ runs: [{ id: 1, name: 'test', status: 'completed', conclusion: 'failure' }] }), 'is not green (test failure)');
  refused(run({ fail: 'gh: Server Error (HTTP 500)\n' }), 'gh api repos/o/r/actions/runs failed (gh: Server Error (HTTP 500))');
  refused(run({ logs: {} }), 'gh api repos/o/r/actions/jobs/11/logs failed');
  refused(run({ logs: { 11: '\n' } }), 'the log of CI job "ubuntu" is empty');
});

test('green check refuses a named test that is missing, failed, or matches more than one passed line', () => {
  refused(run({ logs: { 11: LOG.replaceAll('alpha works', 'alpha broke') } }), 'test/a.test.mjs::alpha works has no passed line');
  refused(run({ logs: { 11: LOG + '\n2026-11-20T10:00:01.0000000Z   ✖ alpha works (3ms)' } }), 'test/a.test.mjs::alpha works failed in CI (1 ✖ line)');
  refused(run({ logs: { 11: LOG + '\n2026-11-20T10:00:01.0000000Z P9_PASS test/b.test.mjs :: beta works again' } }), 'beta works matches 2 passed lines in one CI job');
});

test('green check refuses a Tests selector that is not a test file and a title', () => {
  const plan = (tests) => PLAN.replace('test/a.test.mjs::alpha works | test/b.test.mjs::beta works', tests);
  refused(run({ plan: plan('test/a.test.mjs::alpha works | beta works') }), 'Tests selector "beta works" is not <test file>::<title words>');
  refused(run({ plan: plan('test/a.test.mjs::alpha works |  | test/b.test.mjs::beta works') }), 'Tests selector "" is not');
  refused(run({ plan: plan('test/a.test.mjs::alpha works | test/b.test.mjs::') }), 'Tests selector "test/b.test.mjs::" is not');
  refused(run({ plan: plan('notes.md::alpha works') }), 'Tests selector "notes.md::alpha works" is not');
  refused(run({ plan: plan('::alpha works') }), 'Tests selector "::alpha works" is not');
});

// Review fix 2: in one shard, a.test.mjs has the named test skipped (or only a comment with its words) and b.test.mjs runs a
// test of the same title and passes. Spec prints one ✔ alpha works; only b's P9_PASS line exists, so a's test refuses.
const SAME_SHARD = [
  '2026-11-20T10:00:00.0000000Z shard 0: test/a.test.mjs test/b.test.mjs',
  '2026-11-20T10:00:00.1000000Z   ﹣ alpha works (0.2ms) # SKIP',
  '2026-11-20T10:00:00.2000000Z   ✔ alpha works (3ms)',
  '2026-11-20T10:00:00.2000000Z P9_PASS test/b.test.mjs :: alpha works',
  '2026-11-20T10:00:00.3000000Z   ✔ beta works when idle (4ms)',
  '2026-11-20T10:00:00.3000000Z P9_PASS test/b.test.mjs :: beta works when idle',
].join('\n');

test('green check refuses a pass that is not from the named file, and a log with no per-test file lines', () => {
  refused(run({ logs: { 11: SAME_SHARD } }), 'test/a.test.mjs::alpha works has no passed line in CI on abcdef12');
  refused(run({ logs: { 11: LOG.split('\n').filter((l) => !l.includes('P9_PASS')).join('\n') } }), 'the CI logs on abcdef12 have no P9_PASS lines');
});

test('green check refuses more CI runs or jobs than one page holds, instead of reading part of CI', () => {
  refused(run({ runsTotal: 101 }), 'repos/o/r/actions/runs has 101 workflow_runs, more than one page of 1');
  refused(run({ jobsTotal: 150 }), 'repos/o/r/actions/runs/1/jobs has 150 jobs, more than one page of 2');
});

test('green check reads the plan line, its Tests clause and the reporter lines', () => {
  assert.equal(rowOf(PLAN, 'O7').startsWith('O7: done means x'), true);
  assert.deepEqual(namedTests(rowOf(PLAN, 'O7')), [{ file: 'test/a.test.mjs', title: 'alpha works' }, { file: 'test/b.test.mjs', title: 'beta works' }]);
  assert.equal(namedTests('O6: done means y'), null);
  assert.deepEqual(results(LOG), [{ ok: true, file: 'test/a.test.mjs', title: 'alpha works' }, { ok: true, file: 'test/b.test.mjs', title: 'beta works when idle' },
    { ok: true, file: 'test/c.test.mjs', title: 'gamma' }]);
  assert.deepEqual(results(SAME_SHARD), [{ ok: true, file: 'test/b.test.mjs', title: 'alpha works' }, { ok: true, file: 'test/b.test.mjs', title: 'beta works when idle' }]);
  assert.deepEqual(results('✖ plain line'), [{ ok: false, title: 'plain line' }]);
  assert.deepEqual(namedTests('O8: x; Tests: test/a.test.mjs::a | b'), [{ file: 'test/a.test.mjs', title: 'a' }, { bad: 'b' }]);
});

test('green check: the plan template written before the Tests clause still reads as P9s own empty plan', () => {
  const before = '# Plan\n\nGoal:\n\n## Items\n<!-- one per line: - [ ] <item>: done means ...; checks ...; role ...; depends on ... -->\n\n## What I will need from you\n<!-- every action only the owner can take, listed before work starts -->\n';
  assert.equal(isPlan(before), true);
  assert.equal(isPlan(before.replace('Goal:', 'Goal: ship')), false);
});

// C1 (O286), #573 round 1 blocker 1: the `linux (quarantine)` job reruns shell-bundle and the quarantined tests and never
// blocks; its pass or failure is not evidence, so the gate reads it as it reads a skipped job.
test('green check ignores the advisory quarantine job: its pass is not a second pass, its failure is not a red', () => {
  const jobs = [{ id: 11, name: 'linux (0)', conclusion: 'success' }, { id: 13, name: 'linux (quarantine)', conclusion: 'success' }];
  const again = run({ jobs, logs: { 11: LOG, 13: '2026-11-20T10:00:02.0000000Z P9_PASS test/a.test.mjs :: alpha works' } });
  assert.equal(again.status, 0, again.out);
  const red = run({ jobs, logs: { 11: LOG, 13: '2026-11-20T10:00:02.0000000Z   ✖ alpha works (3ms)' } });
  assert.equal(red.status, 0, red.out);
});

// C3 (O288), #574 round 1 blocker 1: marking a draft ready while its run is going cancels that run and starts another on the
// same commit, and reopening a green PR runs it again. The gate reads only each workflow's newest run on the commit.
// #574 r1-r4: every run on the commit must be complete and green, from any PR or event; a cancelled run is not green, and the
// refusal says a re-run clears it. A test passing in two runs counts once; two passed lines in one job are ambiguous.
test('green check: any red or cancelled run on the commit refuses, even a different PR\'s; a test in two green runs counts once', () => {
  const green = { id: 1, name: 'Tests', workflow_id: 7, event: 'pull_request', status: 'completed', conclusion: 'success' };
  const cancelled = { ...green, id: 2, conclusion: 'cancelled' }, red = { ...green, id: 2, conclusion: 'failure' };
  const jobsOf = { 1: [{ id: 11, name: 'linux (0)', conclusion: 'success' }], 2: [{ id: 21, name: 'linux (0)', conclusion: 'success' }] };
  // A cancelled run before or after a green one (a draft made ready mid-run, a cancelled ready run), or another workflow's.
  refused(run({ runs: [cancelled, green], jobsOf, logs: { 11: LOG, 21: LOG } }), 'is not green (Tests cancelled); re-run a cancelled run');
  refused(run({ runs: [green, { ...cancelled, id: 3, name: 'scan', workflow_id: 9 }], jobsOf: { ...jobsOf, 3: [] }, logs: { 11: LOG } }), 'is not green (scan cancelled)');
  // The same head on two PRs: a green run for the other PR does not hide this PR's red run, in either order.
  refused(run({ runs: [red, green], jobsOf, logs: { 11: LOG, 21: LOG } }), 'is not green (Tests failure)');
  refused(run({ runs: [green, { ...red, id: 0 }], jobsOf: { ...jobsOf, 0: [] }, logs: { 11: LOG } }), 'is not green (Tests failure)');
  // A reopened green PR: two green runs with the same lines are still one passed test each.
  const twice = run({ runs: [green, { ...green, id: 2 }], jobsOf, logs: { 11: LOG, 21: LOG } });
  assert.equal(twice.status, 0, twice.out);
  // But two tests one name matches, in one job, are ambiguous even when the other run has one.
  const extra = LOG + '\n2026-11-20T10:00:01.0000000Z P9_PASS test/b.test.mjs :: beta works again';
  refused(run({ runs: [green, { ...green, id: 2 }], jobsOf, logs: { 11: extra, 21: LOG } }), 'beta works matches 2 passed lines in one CI job');
});

// #574 round 2 blocker: a run by hand (workflow_dispatch: named files, bare, evidence) shares the Tests workflow with the PR's
// run. It diagnoses; it is not the PR's CI, so it neither replaces the PR's run nor adds to it.
test('green check ignores runs by hand: a green named run after red PR CI refuses, a bare run after green PR CI passes', () => {
  const pr = { id: 1, name: 'Tests', workflow_id: 7, event: 'pull_request', status: 'completed', conclusion: 'success' };
  const byHand = { id: 2, name: 'Tests', workflow_id: 7, event: 'workflow_dispatch', status: 'completed', conclusion: 'success' };
  const jobsOf = { 1: [{ id: 11, name: 'linux (0)', conclusion: 'failure' }], 2: [{ id: 21, name: 'linux (0)', conclusion: 'success' }] };
  refused(run({ runs: [{ ...pr, conclusion: 'failure' }, byHand], jobsOf, logs: { 11: LOG, 21: LOG } }), 'is not green (Tests failure)');
  const bare = run({ runs: [pr, byHand], jobsOf: { 1: [{ id: 11, name: 'linux (0)', conclusion: 'success' }], 2: [{ id: 21, name: 'bare (x64)', conclusion: 'success' }] }, logs: { 11: LOG, 21: 'bare install ok' } });
  assert.equal(bare.status, 0, bare.out);
  refused(run({ runs: [byHand], jobsOf, logs: { 21: LOG } }), 'no CI run on abcdef12');
});
