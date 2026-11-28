// C5 (O290): .github/ruleset-main.json is what GitHub enforces on main once the owner runs the command in its PR. This
// holds the file and test.yaml together: every check the ruleset requires is reported on every pull request, so none can
// hold a PR forever, and the `tests` job that stands for the heavy jobs passes and fails when it should.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { root } from './helpers.mjs';

const ruleset = JSON.parse(await readFile(path.join(root, '.github/ruleset-main.json'), 'utf8'));
const lines = (await readFile(path.join(root, '.github/workflows/test.yaml'), 'utf8')).split('\n');
const rule = (type) => ruleset.rules.find((r) => r.type === type);

// The top-level jobs, each with its own lines.
const jobs = {};
let current;
for (const line of lines.slice(lines.indexOf('jobs:') + 1)) {
  const head = /^ {2}([\w-]+):$/.exec(line);
  if (head) jobs[(current = head[1])] = [];
  else if (current && (line.startsWith('    ') || !line.trim())) jobs[current].push(line);
  else if (line.trim() && !line.startsWith('  ')) break;
}
const field = (job, key) => jobs[job].find((l) => l.startsWith(`    ${key}:`))?.slice(`    ${key}:`.length).trim();

test('main: no deletion, no force push, changes only through a squash-merged PR, no bypass', () => {
  assert.equal(ruleset.enforcement, 'active');
  assert.deepEqual(ruleset.conditions.ref_name.include, ['~DEFAULT_BRANCH']);
  assert.deepEqual(ruleset.bypass_actors, []);
  assert.ok(rule('deletion') && rule('non_fast_forward'));
  assert.deepEqual(rule('pull_request').parameters.allowed_merge_methods, ['squash']);
  // Up to date with main is left out on purpose (the spec: every update is a new head and a new full run).
  assert.equal(rule('required_status_checks').parameters.strict_required_status_checks_policy, false);
});

test('each required check from Actions is a job that reports on every pull request', () => {
  const actions = rule('required_status_checks').parameters.required_status_checks.filter((c) => c.integration_id === 15368);
  assert.deepEqual(actions.map((c) => c.context), ['tests'], 'one Actions check: tests (a skipped matrix job loses its shard names)');
  // #577 r1 #2: test.yaml comes from the PR, so the reviewer's pass on the exact head (R5's commit status) is required too.
  assert.ok(rule('required_status_checks').parameters.required_status_checks.some((c) => c.context === 'review' && !c.integration_id));
  assert.equal(field('tests', 'if'), '${{ always() }}', 'tests runs even when the jobs it waits for fail or skip');
  const name = field('tests', 'name').replace(/^\$\{\{(.*)\}\}$/, '$1').replace(/==/g, '===');
  const named = (event) => new Function('github', `return (${name});`)({ event_name: event });
  assert.equal(named('pull_request'), 'tests');
  assert.notEqual(named('workflow_dispatch'), 'tests', 'a run by hand never reports as tests');
  // It waits for every job a pull request runs; the rest run by hand only.
  const onPr = Object.keys(jobs).filter((j) => j !== 'tests' && field(j, 'if') !== '${{ inputs.bare }}');
  assert.deepEqual(field('tests', 'needs').replace(/[[\]\s]/g, '').split(',').sort(), onPr.sort());
});

test("tests passes only when quick passed and each heavy job passed or was skipped", () => {
  const at = jobs.tests.findIndex((l) => l.trim() === 'run: |');
  const body = [];
  for (const l of jobs.tests.slice(at + 1)) { if (l.trim() && !l.startsWith(' '.repeat(10))) break; body.push(l.slice(10)); }
  const passes = (QUICK, LINUX, WINDOWS, { EVENT = 'pull_request', HEAVY = QUICK === 'success' ? 'true' : '', DRAFT = 'false' } = {}) => {
    const env = { PATH: process.env.PATH, EVENT, QUICK, HEAVY, DRAFT, LINUX, WINDOWS };
    try { execFileSync('bash', ['-c', body.join('\n')], { env, stdio: 'pipe' }); return true; } catch { return false; }
  };
  assert.equal(passes('success', 'success', 'success'), true);
  assert.equal(passes('success', 'skipped', 'skipped', { HEAVY: 'false' }), true, 'a Markdown-only PR');
  assert.equal(passes('success', 'skipped', 'skipped', { DRAFT: 'true' }), true, 'a draft');
  assert.equal(passes('success', 'success', 'success', { EVENT: 'push', DRAFT: '' }), true, 'a merge to main');
  // #577 r1 #4: a ready code PR whose heavy jobs were skipped (a broken condition) does not pass.
  assert.equal(passes('success', 'skipped', 'skipped'), false, 'heavy jobs due but skipped');
  assert.equal(passes('success', 'skipped', 'success'), false);
  assert.equal(passes('success', 'failure', 'success'), false);
  assert.equal(passes('success', 'success', 'cancelled'), false);
  assert.equal(passes('failure', 'skipped', 'skipped'), false);
  assert.equal(passes('skipped', 'skipped', 'skipped'), false, 'quick must have run');
  // #577 r1 #1: a run by hand skips quick on purpose; its tests (by hand) job passes (the jobs it ran are its result).
  for (const linux of ['success', 'skipped']) assert.equal(passes('skipped', linux, 'skipped', { EVENT: 'workflow_dispatch' }), true, 'a run by hand');
});
