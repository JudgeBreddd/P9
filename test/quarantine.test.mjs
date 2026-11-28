// C1 (O286): the quarantine list (test/quarantine.json) cannot become a graveyard. Each entry names a test that exists in its
// file, an open row, and a date at most 14 days back; and the pattern CI builds from it matches each name and nothing else.
// ponytail: the rows live outside this repo, so "open" is checked as an id's shape here; whoever closes the row removes the entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// #573 r1 #6 (O293): a file path, not the URL's pathname, which keeps %20 for a checkout path with a space.
const SHARD = fileURLToPath(new URL('shard.mjs', import.meta.url));
const list = JSON.parse(readFileSync(new URL('quarantine.json', import.meta.url), 'utf8'));
const shard = (mode) => execFileSync(process.execPath, [SHARD, mode], { encoding: 'utf8' }).trim();
// The titles of a file's test() calls whose first argument is a plain string, read by TypeScript's parser (a dev dependency).
const testTitles = (file) => {
  const source = ts.createSourceFile(file, readFileSync(new URL('../' + file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, false, ts.ScriptKind.JS), titles = [];
  const walk = (n) => { if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'test' && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) titles.push(n.arguments[0].text); ts.forEachChild(n, walk); };
  walk(source); return titles;
};

test('C1: the title reader counts test() calls, not a commented-out one', async (t) => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(tmpdir() + '/p9-titles-'); t.after(() => rm(dir, { recursive: true, force: true }));
  const rel = path.relative(fileURLToPath(new URL('..', import.meta.url)), dir + '/t.test.mjs');
  await writeFile(dir + '/t.test.mjs', "// test('commented out', () => {});\n/* test('in a block', () => {}); */\ntest('real one', () => {});\ntest(`template`, () => {});\n");
  assert.deepEqual(testTitles(rel), ['real one', 'template']);
});

test('C1: each quarantined test is real, has a row and is at most 14 days old', () => {
  for (const q of list) {
    assert.deepEqual(Object.keys(q).sort(), ['file', 'name', 'row', 'since'], `entry shape: ${JSON.stringify(q)}`);
    assert.match(q.row, /^O\d+[a-z]?$/, `${q.name}: row must be an O-number`);
    // #573 r1 #5 (O293): a title in a comment is not a test; it must be a test() call's title. The quarantine job's report
    // says "no result" for an entry whose test did not run.
    // #580 r1: parsed, so a commented-out test() is not one.
    assert.ok(testTitles(q.file).includes(q.name), `${q.file} has no test named "${q.name}"`);
    const days = (Date.now() - Date.parse(q.since)) / 864e5;
    assert.ok(days >= 0 && days <= 14, `${q.name} has been quarantined ${Math.floor(days)} days (row ${q.row}): fix it or close the row and drop the entry`);
  }
});

test('C1: the quarantine pattern matches each quarantined name exactly and nothing else', () => {
  const pattern = shard('pattern');
  if (!list.length) return assert.equal(pattern, '');
  const re = new RegExp(pattern);
  for (const q of list) {
    assert.ok(re.test(q.name), `pattern misses "${q.name}"`);
    assert.ok(!re.test(q.name + ' x') && !re.test('x ' + q.name), 'pattern is anchored');
  }
  assert.ok(!re.test('Shell bundle: JS the desktop shell page loads, and its look'));
  assert.deepEqual(shard('quarantine').split(' ').sort(), [...new Set(list.map((q) => q.file))].sort());
});

test('C1: node skips a quarantined name with the shards\' flag and runs it with the quarantine shard\'s flag', { timeout: 60000 }, async (t) => {
  if (!list.length) return;
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(tmpdir() + '/p9-quarantine-'); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = dir + '/q.test.mjs';
  await writeFile(file, `import test from 'node:test';\ntest(${JSON.stringify(list[0].name)}, () => {});\ntest('a test beside it', () => {});\n`);
  // NODE_TEST_CONTEXT cleared: a node --test started inside a test otherwise reports to this runner, not its stdout.
  const childEnv = { ...process.env }; delete childEnv.NODE_TEST_CONTEXT;
  // Node leaves a name-filtered test out of the run (not counted as skipped), so this checks which names ran.
  const ran = (flag) => [...execFileSync(process.execPath, ['--test', '--test-reporter=tap', `${flag}=${shard('pattern')}`, file], { encoding: 'utf8', env: childEnv })
    .matchAll(/^ok \d+ - (.*)$/gm)].map((m) => m[1]);
  assert.deepEqual(ran('--test-skip-pattern'), ['a test beside it'], 'the shards skip the quarantined test and run the one beside it');
  assert.deepEqual(ran('--test-name-pattern'), [list[0].name], 'the quarantine shard runs only the quarantined test');
});

// #573 r1 blocker 3: a file's pattern holds only that file's entries, so a same-title test in another file still blocks.
test('C1: `pattern <file>` names only that file\'s quarantined tests', () => {
  const run = (...a) => execFileSync(process.execPath, [SHARD, ...a], { encoding: 'utf8' }).trim();
  assert.equal(run('pattern', 'test/shard.test.mjs'), '', 'a file with no entries gets no pattern');
  for (const f of new Set(list.map((q) => q.file))) {
    const re = new RegExp(run('pattern', f));
    for (const q of list) assert.equal(re.test(q.name), q.file === f || list.some((o) => o.file === f && o.name === q.name), `${f}: ${q.name}`);
  }
});

// #573 r1 #4-#5 (O293): the quarantine job's report gives each entry passed, failed or no result, from the job's log.
test('C1: `report <log>` says passed, failed or no result for each quarantined test', async (t) => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(tmpdir() + '/p9 quarantine report '); t.after(() => rm(dir, { recursive: true, force: true }));
  const report = async (text) => { await writeFile(dir + '/tests.log', text); return execFileSync(process.execPath, [SHARD, 'report', dir + '/tests.log'], { encoding: 'utf8' }).trim().split('\n'); };
  const q = list[0];
  if (!q) return;
  assert.match((await report(`2026-11-28T10:00:00.0000000Z P9_PASS ${q.file} :: ${q.name}\n`))[0], /^- passed: /);
  assert.match((await report(`2026-11-28T10:00:00.0000000Z ✖ failed now: ${q.name} (${q.file}:12)\n  AssertionError\n`))[0], /^- failed: /);
  // #580 r1: only the exact file and title count: a longer title's pass, another file's failure, spec's fileless ✖ line.
  assert.match((await report(`P9_PASS test/other.test.mjs :: ${q.name}\n# a comment naming ${q.name}\n`))[0], /^- no result /, 'a pass from another file or a mention is no result');
  assert.match((await report(`P9_PASS ${q.file} :: ${q.name} and more\n✖ failed now: ${q.name} (test/other.test.mjs:3)\n  ✖ ${q.name} (3.1s)\n`))[0], /^- no result /, 'a longer title, another file, a fileless line');
  assert.equal((await report('')).length, list.length, 'one line per entry');
});
