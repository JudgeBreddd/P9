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
import { jobFiles, namedTests, results, rowOf } from '../scripts/green-check.mjs';
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
else if ((m = /contents\\/(.+)\\?ref=/.exec(route))) name = 'src-' + m[1].replace(/\\//g, '_');
const f = name && path.join(dir, name);
if (!f || !fs.existsSync(f)) { process.stderr.write('gh: Not Found (HTTP 404)\\n'); process.exit(1); }
process.stdout.write(fs.readFileSync(f, 'utf8'));
`;
const PLAN = '# Plan\n\n## Items\n- [ ] O6: done means y; role hand\n- [ ] O7: done means x; role hand; Tests: test/a.test.mjs::alpha works | test/b.test.mjs::beta works\n';
const LOG = [
  '2026-11-20T10:00:00.0000000Z shard 0: test/a.test.mjs, then alone: test/b.test.mjs',
  '2026-11-20T10:00:00.0000000Z ▶ suite',
  '2026-11-20T10:00:00.1000000Z   ✔ alpha works (12.3ms)',
  '2026-11-20T10:00:00.2000000Z   ✔ beta works when idle (4ms)',
  '2026-11-20T10:00:00.3000000Z   ✔ gamma (1.2s)',
].join('\n');
const SOURCES = { 'test/a.test.mjs': "test('alpha works', () => {});", 'test/b.test.mjs': "test('beta works when idle', () => {});" };

function run({ plan = PLAN, runs = [{ id: 1, name: 'test', status: 'completed', conclusion: 'success' }],
  jobs = [{ id: 11, name: 'ubuntu', conclusion: 'success' }, { id: 12, name: 'windows', conclusion: 'skipped' }],
  logs = { 11: LOG }, sources = SOURCES, runsTotal, jobsTotal, fail = null, args, stdin } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'green-check-'));
  try {
    writeFileSync(join(dir, 'gh'), FAKE_GH); chmodSync(join(dir, 'gh'), 0o755);
    writeFileSync(join(dir, 'sprint.md'), plan);
    writeFileSync(join(dir, 'runs.json'), JSON.stringify({ total_count: runsTotal ?? runs.length, workflow_runs: runs }));
    for (const r of runs) writeFileSync(join(dir, `jobs-${r.id}.json`), JSON.stringify({ total_count: jobsTotal ?? jobs.length, jobs }));
    for (const [file, text] of Object.entries(sources)) writeFileSync(join(dir, 'src-' + file.replace(/\//g, '_')), text);
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
  refused(run({ logs: { 11: LOG.replace('alpha works', 'alpha broke') } }), 'test/a.test.mjs::alpha works has no passed line');
  refused(run({ logs: { 11: LOG + '\n2026-11-20T10:00:01.0000000Z   ✖ alpha works (3ms)' } }), 'test/a.test.mjs::alpha works failed in CI (1 ✖ line)');
  refused(run({ logs: { 11: LOG + '\n2026-11-20T10:00:01.0000000Z   ✔ beta works again (3ms)' } }), 'beta works matches 2 passed lines');
});

test('green check refuses a Tests selector that is not a test file and a title', () => {
  const plan = (tests) => PLAN.replace('test/a.test.mjs::alpha works | test/b.test.mjs::beta works', tests);
  refused(run({ plan: plan('test/a.test.mjs::alpha works | beta works') }), 'Tests selector "beta works" is not <test file>::<title words>');
  refused(run({ plan: plan('test/a.test.mjs::alpha works |  | test/b.test.mjs::beta works') }), 'Tests selector "" is not');
  refused(run({ plan: plan('test/a.test.mjs::alpha works | test/b.test.mjs::') }), 'Tests selector "test/b.test.mjs::" is not');
  refused(run({ plan: plan('notes.md::alpha works') }), 'Tests selector "notes.md::alpha works" is not');
  refused(run({ plan: plan('::alpha works') }), 'Tests selector "::alpha works" is not');
});

test('green check refuses a passed line that is not from the named file: a job that did not run it, a title not in it', () => {
  refused(run({ logs: { 11: LOG.replace(', then alone: test/b.test.mjs', '') } }), 'test/b.test.mjs::beta works passed in a CI job that did not run test/b.test.mjs');
  refused(run({ logs: { 11: LOG.replace(/^.*shard 0.*\n/, '') } }), 'test/a.test.mjs::alpha works passed in a CI job that did not run test/a.test.mjs');
  refused(run({ sources: { ...SOURCES, 'test/b.test.mjs': "test('gamma', () => {});" } }), '"beta works" is not in test/b.test.mjs at abcdef12');
  refused(run({ sources: { 'test/a.test.mjs': SOURCES['test/a.test.mjs'] } }), 'gh api repos/o/r/contents/test/b.test.mjs failed');
});

test('green check refuses more CI runs or jobs than one page holds, instead of reading part of CI', () => {
  refused(run({ runsTotal: 101 }), 'repos/o/r/actions/runs has 101 workflow_runs, more than one page of 1');
  refused(run({ jobsTotal: 150 }), 'repos/o/r/actions/runs/1/jobs has 150 jobs, more than one page of 2');
});

test('green check reads the plan line, its Tests clause and the reporter lines', () => {
  assert.equal(rowOf(PLAN, 'O7').startsWith('O7: done means x'), true);
  assert.deepEqual(namedTests(rowOf(PLAN, 'O7')), [{ file: 'test/a.test.mjs', title: 'alpha works' }, { file: 'test/b.test.mjs', title: 'beta works' }]);
  assert.equal(namedTests('O6: done means y'), null);
  assert.deepEqual(results(LOG), [{ ok: true, title: 'alpha works' }, { ok: true, title: 'beta works when idle' }, { ok: true, title: 'gamma' }]);
  assert.deepEqual(results('✖ plain line'), [{ ok: false, title: 'plain line' }]);
  assert.deepEqual(jobFiles(LOG), ['test/a.test.mjs', 'test/b.test.mjs']);
  assert.deepEqual(jobFiles('shard 3: test/x.test.mjs test/y.test.mjs'), ['test/x.test.mjs', 'test/y.test.mjs']);
  assert.deepEqual(jobFiles('echo "shard $SHARD: $TOGETHER"'), []);
  assert.deepEqual(namedTests('O8: x; Tests: test/a.test.mjs::a | b'), [{ file: 'test/a.test.mjs', title: 'a' }, { bad: 'b' }]);
});

test('green check: the plan template written before the Tests clause still reads as P9s own empty plan', () => {
  const before = '# Plan\n\nGoal:\n\n## Items\n<!-- one per line: - [ ] <item>: done means ...; checks ...; role ...; depends on ... -->\n\n## What I will need from you\n<!-- every action only the owner can take, listed before work starts -->\n';
  assert.equal(isPlan(before), true);
  assert.equal(isPlan(before.replace('Goal:', 'Goal: ship')), false);
});
