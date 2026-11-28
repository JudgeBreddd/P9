// O230: Tests runs on main after every merge without blocking the next one. This reads test.yaml's push trigger and works
// out its concurrency group and cancel-in-progress for a run on main and on a branch, the way GitHub evaluates them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { root } from './helpers.mjs';

const yaml = await readFile(path.join(root, '.github/workflows/test.yaml'), 'utf8');
const lines = yaml.split('\n');
const block = (name, indent) => {
  const at = lines.findIndex((line) => line === `${' '.repeat(indent)}${name}:`);
  assert.ok(at >= 0, `${name}: in test.yaml`);
  const out = [];
  for (const line of lines.slice(at + 1)) { if (line.trim() && !line.startsWith(' '.repeat(indent + 2))) break; out.push(line); }
  return out;
};
const value = (key) => {
  const line = block('concurrency', 0).find((l) => l.trim().startsWith(`${key}:`));
  assert.ok(line, `concurrency.${key}`);
  return line.trim().slice(key.length + 1).trim();
};
// ${{ }} pieces of this file use only ==, !=, &&, || and format('-{0}', x): with these values JS gives GitHub's result.
const evaluate = (text, ctx) => text.replace(/\$\{\{(.*?)\}\}/g, (_, expr) => {
  const js = expr.replace(/!=/g, '!==').replace(/([^!=])==([^=])/g, '$1===$2').replace(/format\('-\{0\}', ([\w.]+)\)/g, "('-' + $1)");
  return String(new Function('github', 'inputs', `return (${js});`)(ctx.github, ctx.inputs ?? {}));
});
const run = (ref, id, inputs) => {
  const ctx = { github: { workflow: 'Tests', ref, run_id: id }, inputs };
  return { group: evaluate(value('group'), ctx), cancel: evaluate(value('cancel-in-progress'), ctx) };
};

test('O230: a merge to main starts Tests, and quick merges each finish with their own result', () => {
  // C3 (O288): pushes run on main only (a branch is tested by its PR), so main must be in the list.
  const push = block('push', 2);
  assert.ok(push.some((line) => line.trim() === 'branches: [main]'), `the push trigger runs on main: ${push.join('\n')}`);

  const [a, b, c] = [run('refs/heads/main', 101), run('refs/heads/main', 102), run('refs/heads/main', 103)];
  assert.equal(a.cancel, 'false', 'a run on main cancels nothing');
  assert.equal(new Set([a.group, b.group, c.group]).size, 3, `each run on main has its own group, so a third merge does not cancel the second's waiting run: ${a.group} ${b.group} ${c.group}`);

  const [x, y] = [run('refs/heads/o-fix', 201), run('refs/heads/o-fix', 202)];
  assert.equal(x.cancel, 'true', 'on a branch a new push still cancels the run it replaces');
  assert.equal(x.group, y.group, 'two pushes to one branch share a group');
  assert.notEqual(x.group, run('refs/heads/o-fix', 203, { bare: true }).group, 'a bare run keeps its own group');
});

test('C3: every PR runs Tests (no paths filter), a draft runs only quick, and marking it ready starts the rest', () => {
  const pr = block('pull_request', 2);
  assert.ok(pr.some((line) => line.trim() === 'types: [opened, synchronize, reopened, ready_for_review]'), pr.join('\n'));
  assert.ok(!pr.some((line) => /^\s*paths(-ignore)?:/.test(line)), 'no paths filter on pull_request: a required check that never reports holds a Markdown-only PR forever');
  for (const job of ['linux', 'windows']) {
    const body = block(job, 2);
    assert.ok(body.some((line) => line.trim() === 'needs: quick'), `${job} waits for quick`);
    const cond = body.find((line) => line.trim().startsWith('if:'));
    assert.match(cond, /needs\.quick\.outputs\.heavy == 'true' && !github\.event\.pull_request\.draft/, `${job}: ${cond}`);
    // #574 r1 blocker 4: a run by hand naming files (Linux) or asking for Windows runs whatever quick says, so a red quick
    // cannot hide the test being diagnosed; every other run needs quick green (!cancelled() lets the condition decide).
    assert.match(cond, /^\s*if: \$\{\{ !cancelled\(\) && /, `${job}: ${cond}`);
    assert.match(cond, job === 'linux' ? /\(inputs\.files != '' && inputs\.files != null \|\| needs\.quick\.result == 'success' && / : /\(inputs\.windows \|\| needs\.quick\.result == 'success' && /, `${job}: ${cond}`);
  }
  // #574 r1 blocker 2: quick's tests write the shards' P9_PASS lines, so a plan row naming one can pass the sprint gate.
  const quick = block('quick', 2).join('\n');
  assert.match(quick, /--test-reporter=\.\/test\/file-limit\.mjs --test-reporter-destination=stderr \$\(node test\/shard\.mjs quick\)/, quick);
  const [x, y] = [run('refs/pull/7/merge', 301), run('refs/pull/7/merge', 302)];
  assert.equal(x.cancel, 'true', 'a new push to a PR cancels the run it replaces');
  assert.equal(x.group, y.group);
});
