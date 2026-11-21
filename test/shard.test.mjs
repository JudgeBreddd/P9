// O208: CI's Linux Tests step runs shell-bundle (it times the shell's warm usable ms against a fixed budget) alone, after the
// rest of its shard, never in one node --test beside other Electron files. This runs the step's own script from test.yaml with
// a stand-in xvfb-run that logs each call, for every shard and for a dispatched file list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { root } from './helpers.mjs';

const BUNDLE = 'test/shell-bundle.test.mjs';

// The `run: |` block of the Linux job's "Tests" step, unindented.
const testsStep = async () => {
  const lines = (await readFile(path.join(root, '.github/workflows/test.yaml'), 'utf8')).split('\n');
  const at = lines.findIndex((line) => line.trim() === '- name: Tests');
  const run = lines.findIndex((line, i) => i > at && line.trim() === 'run: |');
  assert.ok(at > 0 && run > at, 'the Linux Tests step and its run block in test.yaml');
  const block = [];
  for (const line of lines.slice(run + 1)) { if (line.trim() && !line.startsWith('          ')) break; block.push(line.slice(10)); }
  return block.join('\n');
};

test('CI runs shell-bundle alone after its shard, and a failure in either part fails the job', { timeout: 60000, skip: process.platform !== 'linux' && 'the Linux CI Tests step' }, async (t) => {
  const script = await testsStep();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-shard-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // Stand-ins: xvfb-run logs the test files of each call (the arguments after the last flag) and fails when FAIL is one of them.
  await writeFile(path.join(dir, 'xvfb-run'), '#!/bin/bash\nfiles=(); for a in "$@"; do [[ $a == test/*.test.mjs ]] && files+=("$a"); done\necho "${files[*]}" >> "$CALLS"\nfor f in "${files[@]}"; do [ "$f" = "$FAIL" ] && exit 1; done\nexit 0\n');
  await writeFile(path.join(dir, 'systemctl'), '#!/bin/sh\nexit 0\n');
  await chmod(path.join(dir, 'xvfb-run'), 0o755); await chmod(path.join(dir, 'systemctl'), 0o755);
  let n = 0;
  const step = (env) => {
    const calls = path.join(dir, `calls-${n++}`);
    const r = spawnSync('bash', ['-e', '-c', script], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir, CALLS: calls, FILES: '', FAIL: '', ...env } });
    let list = [];
    try { list = execFileSync('cat', [calls], { encoding: 'utf8' }).trim().split('\n'); } catch {}
    return { code: r.status, calls: list, out: r.stdout + r.stderr };
  };

  const all = (await readdir(path.join(root, 'test'))).filter((name) => name.endsWith('.test.mjs')).map((name) => 'test/' + name).sort();
  const ran = [];
  for (let shard = 0; shard < 7; shard++) {
    const { code, calls, out } = step({ SHARD: String(shard) });
    assert.equal(code, 0, `shard ${shard}: ${out}`);
    const together = calls[0].split(' ');
    assert.ok(!together.includes(BUNDLE), `shard ${shard} ran shell-bundle beside other files: ${calls[0]}`);
    if (calls.length > 1) assert.deepEqual(calls.slice(1), [BUNDLE], `shard ${shard}: after its files, only shell-bundle, alone`);
    ran.push(...calls.flatMap((c) => c.split(' ')));
  }
  assert.deepEqual(ran.sort(), all, 'every test file runs once across the 7 shards');

  // A dispatched list (Run workflow with files): the same split.
  const named = { FILES: `test/shard.test.mjs ${BUNDLE} test/file-limit.test.mjs`, SHARD: '0' };
  assert.deepEqual(step(named).calls, ['test/shard.test.mjs test/file-limit.test.mjs', BUNDLE]);
  assert.deepEqual(step({ ...named, FILES: BUNDLE }).calls, [BUNDLE], 'only shell-bundle named: one call, no empty run');
  // A failure in the files run together, or in the alone run, fails the step; the alone run still runs after a failure.
  const early = step({ ...named, FAIL: 'test/shard.test.mjs' });
  assert.notEqual(early.code, 0, 'a failing file run together fails the step');
  assert.equal(early.calls.length, 2, 'shell-bundle still runs after the others failed');
  assert.notEqual(step({ ...named, FAIL: BUNDLE }).code, 0, 'a failing shell-bundle fails the step');
});
