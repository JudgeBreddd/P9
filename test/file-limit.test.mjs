import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// The hang row: a file whose test blocks the event loop (a synchronous 60 s child run) or that hangs outside any test
// must name itself in the log and let the files after it report, using the node --test flags exactly as the Linux CI
// Tests line has them. On main's line both were silent (only '✔ ok a' after 30 s).
const ciFlags = async () => {
  const yaml = await readFile(path.join(root, '.github', 'workflows', 'test.yaml'), 'utf8');
  const line = yaml.split('\n').find((text) => text.trim().startsWith('run() {') && text.includes('--test-reporter=./test/file-limit.mjs')); // the shards' run(), not quick's line (#574 r1 gave quick the same reporters)
  assert.ok(line, 'the Linux Tests line in test.yaml');
  // C1 (O286): the flags now sit in the step's run() function, which takes its files as "$@".
  const end = line.includes('"$@"') ? line.indexOf('"$@"') : line.indexOf('$FILES');
  return line.slice(line.indexOf('node --test') + 'node --test'.length, end).trim().split(/\s+/);
};

test('a hung test file names itself in the log and the files after it still report (per-file limit)', { timeout: 60000, skip: process.platform !== 'linux' && 'the per-file limit is on the Linux CI Tests line' }, async (t) => {
  const flags = await ciFlags();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-file-limit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'a-ok.test.mjs'), "import test from 'node:test';\ntest('ok a', () => {});\n");
  await writeFile(path.join(dir, 'b-hung.test.mjs'), "import test from 'node:test';\nimport { spawnSync } from 'node:child_process';\n"
    + "test('blocks the event loop', () => { spawnSync('sleep', ['60']); });\n");
  await writeFile(path.join(dir, 'c-top.test.mjs'), "import test from 'node:test';\nawait new Promise(() => setInterval(() => {}, 1000));\ntest('never registered', () => {});\n");
  await writeFile(path.join(dir, 'z-ok.test.mjs'), "import test from 'node:test';\ntest('ok z', () => {});\n");
  const env = { ...process.env, P9_FILE_LIMIT_S: '3' };
  delete env.NODE_TEST_CONTEXT; // set inside a test file; the child would skip running files
  const child = spawn(process.execPath, ['--test', ...flags, ...['a-ok', 'b-hung', 'c-top', 'z-ok'].map((name) => path.join(dir, `${name}.test.mjs`))], { cwd: root, env });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { out += chunk; });
  // A bound, not a wait: the run ends as soon as the hung file is killed; without the limit it would run the full 60 s.
  const code = await new Promise((resolve) => {
    const stop = setTimeout(() => { child.kill('SIGKILL'); resolve('still running at 30 s'); }, 30000);
    child.on('close', (status) => { clearTimeout(stop); resolve(status); });
  });
  assert.match(out, /✖ \S*b-hung\.test\.mjs still running after 3 s \(per-file limit/, 'the hung file named; exit ' + code + '; output:\n' + out);
  assert.match(out, /✖ \S*c-top\.test\.mjs still running after 3 s \(per-file limit/, 'the file hung outside a test named:\n' + out);
  assert.match(out, /✔ ok z/, 'the file after it reported:\n' + out);
  assert.equal(code, 1, 'the run fails:\n' + out);
});

// Dogfood 3.5 red (CI 43790793989): a shard's runner ended before its summary, so the failed test showed a bare ✖ and its
// assertion was never printed. A failure must reach the log when it happens, not only in the end-of-run summary.
test('a failed test prints its assertion when it fails, even if the runner then dies before its summary', { timeout: 60000, skip: process.platform !== 'linux' && 'the reporter is on the Linux CI Tests line' }, async (t) => {
  const flags = await ciFlags();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-fail-now-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'a-fail.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
    + "test('fails first', () => { assert.equal(1, 2, 'marker-fail-now'); });\n"
    + "test('then the runner dies', () => new Promise(() => setTimeout(() => process.kill(process.ppid, 'SIGKILL'), 1500)));\n");
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['--test', ...flags, path.join(dir, 'a-fail.test.mjs')], { cwd: root, env });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { out += chunk; });
  const code = await new Promise((resolve) => {
    const stop = setTimeout(() => { child.kill('SIGKILL'); resolve('still running at 30 s'); }, 30000);
    child.on('close', (status, signal) => { clearTimeout(stop); resolve(status ?? signal); });
  });
  assert.equal(code, 'SIGKILL', 'the runner died before its summary:\n' + out);
  assert.match(out, /✖ failed now: fails first \(\S*a-fail\.test\.mjs:3\)/, 'the failed test named with its file and line:\n' + out);
  assert.match(out, /marker-fail-now/, 'its assertion message is in the log:\n' + out);
});

// The hang row, second part (CI 43790793989 shard 4: the log stopped after 24 of 27 files, no summary, nothing said which 3
// were left). When the runner ends, every file that never reported is named with how it ended, and a file whose process
// exited before reporting says its exit code when it fails.
test('a runner that ends early names each file that never reported and how it ended', { timeout: 60000, skip: process.platform !== 'linux' && 'the reporter is on the Linux CI Tests line' }, async (t) => {
  const flags = await ciFlags();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-unreported-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'a-ok.test.mjs'), "import test from 'node:test';\ntest('ok a', () => {});\n");
  await writeFile(path.join(dir, 'b-exit.test.mjs'), 'process.exit(3);\n');
  await writeFile(path.join(dir, 'c-hang.test.mjs'), "import test from 'node:test';\n"
    + "test('ends the runner', () => new Promise(() => setTimeout(() => process.kill(process.ppid, 'SIGTERM'), 1500)));\n");
  await writeFile(path.join(dir, 'd-later.test.mjs'), "import test from 'node:test';\ntest('ok d', () => {});\n");
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  // One file at a time, so d is still waiting when c ends the runner.
  const child = spawn(process.execPath, ['--test', ...flags, '--test-concurrency=1', ...['a-ok', 'b-exit', 'c-hang', 'd-later'].map((name) => path.join(dir, `${name}.test.mjs`))], { cwd: root, env });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { out += chunk; });
  const code = await new Promise((resolve) => {
    const stop = setTimeout(() => { child.kill('SIGKILL'); resolve('still running at 30 s'); }, 30000);
    child.on('close', (status, signal) => { clearTimeout(stop); resolve(status ?? signal); });
  });
  assert.notEqual(code, 'still running at 30 s', out);
  assert.match(out, /✖ failed now: \S*b-exit\.test\.mjs .*exited with code 3/, 'the file that exited says its code:\n' + out);
  assert.match(out, /✖ \S*c-hang\.test\.mjs never reported: still running when the runner ended/, 'the running file named:\n' + out);
  assert.match(out, /✖ \S*d-later\.test\.mjs never reported: never started/, 'the waiting file named:\n' + out);
  assert.doesNotMatch(out, /a-ok\.test\.mjs never reported/, 'a file that reported is not listed:\n' + out);
});

// The green check (scripts/green-check.mjs) reads which file each passed test came from off these lines, as spec's ✔ lines
// say no file. Review fix 2: a.test.mjs skips "alpha works" (and has its words in a comment) while b.test.mjs passes a test
// of that title in the same run; only b gets a line, and neither a skipped nor a todo test does.
test('the reporter names each passed test with its file, and no skipped or todo test', { timeout: 60000 }, async (t) => {
  const flags = await ciFlags();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-pass-lines-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'a.test.mjs'), "import test from 'node:test';\n// alpha works\ntest('alpha works', { skip: true }, () => {});\ntest('kept a', () => {});\ntest('later a', { todo: true }, () => {});\n");
  await writeFile(path.join(dir, 'b.test.mjs'), "import test from 'node:test';\ntest('alpha works', () => {});\n");
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['--test', ...flags, path.join(dir, 'a.test.mjs'), path.join(dir, 'b.test.mjs')], { cwd: root, env });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { out += chunk; });
  assert.equal(await new Promise((resolve) => child.on('close', resolve)), 0, out);
  const lines = out.split('\n').filter((l) => l.startsWith('P9_PASS ')).map((l) => l.replace(/ \S*[/\\]([ab]\.test\.mjs) ::/, ' $1 ::')).sort();
  assert.deepEqual(lines, ['P9_PASS a.test.mjs :: kept a', 'P9_PASS b.test.mjs :: alpha works'], out);
});
