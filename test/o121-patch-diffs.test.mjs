// 0.1.9 O121 part 2: a Codex (ACP v2) edit arrives as a git patch per file. P9 keeps its hunks: each file shows apart,
// each hunk with its line numbers, instead of all files' old and new text run together into one line diff.
// A v1 diff (Claude, or an event recorded before this) has no hunks and shows exactly as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { diffs } from '../apps/server/acp-v2.mjs';
import * as composer from '../apps/web/src/composer.mjs';

// Two hunks in a.md (one removes a line that reads "-- note", one adds "++ x"), then a new file b.md.
const patch = [
  'diff --git /w/a.md /w/a.md', '--- /w/a.md', '+++ /w/a.md',
  '@@ -1,3 +1,2 @@ heading', ' one', '--- note', ' two',
  '@@ -40 +39,2 @@', ' forty', '+++ x',
  '\\ No newline at end of file',
  'diff --git /w/b.md /w/b.md', 'new file mode 100644', '--- /dev/null', '+++ /w/b.md', '@@ -0,0 +1 @@', '+hello', '',
].join('\n');

test('O121 part 2: a v2 git patch keeps each file and each hunk with its line numbers', () => {
  const out = diffs({ patch: { text: patch } });
  assert.deepEqual(out.map((d) => d.path), ['/w/a.md', '/w/b.md'], 'a removed line "-- note" is content, not the file header');
  assert.deepEqual(out[0]._meta.hunks, [
    { old: 1, new: 1, rows: [['ctx', 'one'], ['del', '-- note'], ['ctx', 'two']] },
    { old: 40, new: 39, rows: [['ctx', 'forty'], ['add', '++ x']] },
  ]);
  assert.equal(out[0].oldText, 'one\n-- note\ntwo\nforty');
  assert.equal(out[0].newText, 'one\ntwo\nforty\n++ x');
  assert.deepEqual(out[1], { type: 'diff', path: '/w/b.md', oldText: null, newText: 'hello', _meta: { hunks: [{ old: 0, new: 1, rows: [['add', 'hello']] }] } });
  // A move with no change in it has no ---/+++ lines: it is kept under its new name, not dropped.
  assert.deepEqual(diffs({ patch: { text: 'diff --git /w/c.md /w/d.md\nsimilarity index 100%\nrename from /w/c.md\nrename to /w/d.md\n' } }).map((d) => d.path), ['/w/d.md']);
});

test('O121 part 2: the chat shows a v2 edit per file and per hunk; a v1 diff shows as before', () => {
  const { diffRows, lineDiff } = composer;
  assert.equal(typeof diffRows, 'function', 'no diffRows: every file of an edit runs together into one line diff');
  const v2 = diffs({ patch: { text: patch } });
  assert.deepEqual(diffRows(v2, 200), [
    ['file', '/w/a.md'], ['hunk', '@@ -1 +1 @@'], ['ctx', 'one'], ['del', '-- note'], ['ctx', 'two'],
    ['hunk', '@@ -40 +39 @@'], ['ctx', 'forty'], ['add', '++ x'],
    ['file', '/w/b.md'], ['hunk', '@@ -0 +1 @@'], ['add', 'hello'],
  ]);
  // One file: no file line (the card's title names it), the hunk lines still show.
  assert.deepEqual(diffRows([v2[1]], 200), [['hunk', '@@ -0 +1 @@'], ['add', 'hello']]);
  assert.deepEqual(diffRows(v2, 3), [['file', '/w/a.md'], ['hunk', '@@ -1 +1 @@'], ['ctx', 'one']]);
  // v1 (no hunks), one file or two: exactly main's rows, a line diff of all of it with no file or hunk lines.
  const v1 = [{ type: 'diff', path: '/w/a.md', oldText: 'one\ntwo\n', newText: 'one\nthree\n' }, { type: 'diff', path: '/w/b.md', oldText: null, newText: 'hi' }, { type: 'content' }];
  assert.deepEqual(diffRows(v1, 200), [['ctx', 'one'], ['del', 'two'], ['add', 'three'], ['add', 'hi']]);
  assert.deepEqual(diffRows(v1, 200), [...lineDiff(['one', 'two'], ['one', 'three']), ...lineDiff([], ['hi'])]);
  assert.deepEqual(diffRows(undefined, 200), []);
  assert.deepEqual(diffRows([{ type: 'diff', path: '/w/a.md', _meta: { hunks: [null, { old: 2, new: 2 }, { old: 3, new: 3, rows: [['add', 'x']] }] } }], 200), [['hunk', '@@ -3 +3 @@'], ['add', 'x']], 'a malformed hunk is skipped, never throws');
  console.log('PASS O121 part 2: per file and per hunk for v2, v1 rows unchanged');
});
