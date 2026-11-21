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
  // O222: the text is in the hunks only; newText stays '' because the SDK's v1 diff schema requires a string.
  assert.deepEqual(out[0], { type: 'diff', path: '/w/a.md', newText: '', _meta: { added: false, hunks: out[0]._meta.hunks } });
  assert.deepEqual(out[1], { type: 'diff', path: '/w/b.md', newText: '', _meta: { added: true, hunks: [{ old: 0, new: 1, rows: [['add', 'hello']] }] } });
  // A deleted file has no new text; an empty context line (an editor stripped its space) is still context.
  const gone = diffs({ patch: { text: 'diff --git /w/e.md /w/e.md\ndeleted file mode 100644\n--- /w/e.md\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\ndiff --git /w/f.md /w/f.md\n--- /w/f.md\n+++ /w/f.md\n@@ -1,3 +1,3 @@\n x\n\n-y\n+z\n' } });
  assert.deepEqual(gone.map(({ path, oldText, newText, _meta }) => [path, oldText, newText, _meta.added]), [['/w/e.md', undefined, '', false], ['/w/f.md', undefined, '', false]]);
  assert.deepEqual(gone[0]._meta.hunks[0].rows, [['del', 'a'], ['del', 'b']]);
  assert.deepEqual(gone[1]._meta.hunks[0].rows, [['ctx', 'x'], ['ctx', ''], ['del', 'y'], ['add', 'z']]);
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
  // Fix 1: _meta takes any agent's extensions, so a row that is not ['ctx'|'add'|'del', text] is dropped before the
  // renderer destructures it (null, a number, an object, a bad tag, a non-string text); good rows and hunks stay.
  const odd = [{ type: 'diff', path: '/w/a.md', _meta: { hunks: [{ old: 1, new: 1, rows: [null, 7, { k: 'add' }, ['add'], ['bad', 'x'], ['add', 5], ['<b>', 'x'], ['del', 'gone']] }, { old: 'x', new: {}, rows: [['ctx', 'kept']] }] } }];
  assert.deepEqual(diffRows(odd, 200), [['hunk', '@@ -1 +1 @@'], ['del', 'gone'], ['hunk', '@@ -0 +0 @@'], ['ctx', 'kept']]);
  assert.deepEqual(diffRows([{ type: 'diff', path: '/w/a.md', _meta: { hunks: [null, { old: 2, new: 2 }, { old: 3, new: 3, rows: [['add', 'x']] }] } }], 200), [['hunk', '@@ -3 +3 @@'], ['add', 'x']], 'a malformed hunk is skipped, never throws');
  // Fix 2: a header or path that JSON can hold but that throws when coerced ({toString:null}), or a line number that is
  // not a whole number from 0 up, shows as 0 (path: empty) instead of breaking the chat's render.
  const bad = { toString: null };
  assert.deepEqual(diffRows([{ type: 'diff', path: '/w/a.md', _meta: { hunks: [{ old: bad, new: bad, rows: [['add', 'x']] }, { old: -2, new: 1.5, rows: [] }, { old: '7', new: Infinity, rows: [] }] } }], 200), [['hunk', '@@ -0 +0 @@'], ['add', 'x'], ['hunk', '@@ -0 +0 @@'], ['hunk', '@@ -0 +0 @@']], 'a header that throws when coerced shows 0');
  assert.deepEqual(diffRows([{ type: 'diff', path: bad, _meta: { hunks: [{ old: 1, new: 1, rows: [] }] } }, { type: 'diff', path: '/w/b.md', _meta: { hunks: [] } }], 200), [['file', ''], ['hunk', '@@ -1 +1 @@'], ['file', '/w/b.md']], 'a path that throws when coerced shows empty');
  console.log('PASS O121 part 2: per file and per hunk for v2, v1 rows unchanged');
});

// O222: a Codex (ACP v2) diff was stored twice, as path/oldText/newText for the v1 readers and as its hunks. Now only the
// hunks; the window's created mark reads _meta.added. A v1 diff (Claude) and a v2 diff stored before this keep main's rule.
test('O222: a v2 diff is stored once, and the window still tells a created file from an edited one', () => {
  const { diffCreated } = composer;
  assert.equal(typeof diffCreated, 'function', 'no diffCreated: the created mark reads oldText, which a v2 diff no longer has');
  const [edited, created] = diffs({ patch: { text: patch } });
  assert.equal(JSON.stringify(edited).includes('forty'), true);
  assert.equal(JSON.stringify(edited).split('forty').length - 1, 1, 'each line of the patch is stored once');
  assert.equal(diffCreated(edited), false);
  assert.equal(diffCreated(created), true);
  // Stored before O222: oldText beside the hunks, no added.
  assert.equal(diffCreated({ type: 'diff', path: '/w/b.md', oldText: null, newText: 'hello', _meta: { hunks: [] } }), true);
  assert.equal(diffCreated({ type: 'diff', path: '/w/a.md', oldText: 'one', newText: 'two', _meta: { hunks: [] } }), false);
  // v1: no hunks, as on main (no old text, or an empty one, is a created file).
  assert.equal(diffCreated({ type: 'diff', path: '/w/a.md', oldText: 'one', newText: 'two' }), false);
  assert.equal(diffCreated({ type: 'diff', path: '/w/a.md', newText: 'two' }), true);
  assert.equal(diffCreated({ type: 'diff', path: '/w/a.md', oldText: '', newText: 'two' }), true);
  // An agent's own _meta.added on a diff that carries its old text does not override it.
  assert.equal(diffCreated({ type: 'diff', path: '/w/a.md', oldText: 'one', newText: 'two', _meta: { added: true, hunks: [] } }), false);
  // The rows still come from the hunks alone.
  assert.deepEqual(composer.diffRows([created], 200), [['hunk', '@@ -0 +1 @@'], ['add', 'hello']]);
});
