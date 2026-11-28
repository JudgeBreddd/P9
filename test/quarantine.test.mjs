// C1 (O286): the quarantine list (test/quarantine.json) cannot become a graveyard. Each entry names a test that exists in its
// file, an open row, and a date at most 14 days back; and the pattern CI builds from it matches each name and nothing else.
// ponytail: the rows live outside this repo, so "open" is checked as an id's shape here; whoever closes the row removes the entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const list = JSON.parse(readFileSync(new URL('quarantine.json', import.meta.url), 'utf8'));
const shard = (mode) => execFileSync(process.execPath, [new URL('shard.mjs', import.meta.url).pathname, mode], { encoding: 'utf8' }).trim();

test('C1: each quarantined test is real, has a row and is at most 14 days old', () => {
  for (const q of list) {
    assert.deepEqual(Object.keys(q).sort(), ['file', 'name', 'row', 'since'], `entry shape: ${JSON.stringify(q)}`);
    assert.match(q.row, /^O\d+[a-z]?$/, `${q.name}: row must be an O-number`);
    assert.ok(readFileSync(new URL('../' + q.file, import.meta.url), 'utf8').includes(q.name), `${q.file} has no test named "${q.name}"`);
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
  const run = (...a) => execFileSync(process.execPath, [new URL('shard.mjs', import.meta.url).pathname, ...a], { encoding: 'utf8' }).trim();
  assert.equal(run('pattern', 'test/shard.test.mjs'), '', 'a file with no entries gets no pattern');
  for (const f of new Set(list.map((q) => q.file))) {
    const re = new RegExp(run('pattern', f));
    for (const q of list) assert.equal(re.test(q.name), q.file === f || list.some((o) => o.file === f && o.name === q.name), `${f}: ${q.name}`);
  }
});
