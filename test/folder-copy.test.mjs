// Sprint from a folder with no remote (SECURITY.md § Sprint from a folder with no remote): the copy and the apply, with
// every forced case the section lists. `between` (applyCopy's test seam) runs after the preflight, before each write.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { copyTracked, applyCopy } from '../apps/server/folder-copy.mjs';
import { setProtection } from '../packages/files/index.mjs';

setProtection(false);
const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const read = (file) => fs.readFileSync(file, 'utf8');

// The owner's folder: tracked a.txt, b.txt, sub/b.txt and ignored.txt (tracked, then ignored by pattern); x.log and loose.txt
// are not tracked (ignored and not ignored). Returns the folder and a fresh copy of it with its baseline.
async function sprintOf(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9-fc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const folder = path.join(dir, 'owner'), copy = path.join(dir, 'copy'), record = path.join(dir, 'record');
  fs.mkdirSync(folder);
  g(folder, 'init', '-q');
  write(path.join(folder, '.gitignore'), '*.log\nignored.txt\n');
  write(path.join(folder, 'a.txt'), 'a1\n');
  write(path.join(folder, 'b.txt'), 'b1\n');
  write(path.join(folder, 'sub/b.txt'), 'sb1\n');
  write(path.join(folder, 'ignored.txt'), 'tracked but ignored\n');
  g(folder, 'add', '-f', '.gitignore', 'a.txt', 'b.txt', 'sub/b.txt', 'ignored.txt');
  g(folder, 'commit', '-qm', 'init');
  write(path.join(folder, 'x.log'), 'never copied\n');
  write(path.join(folder, 'loose.txt'), 'untracked, never copied\n');
  const made = await copyTracked(folder, copy);
  assert.ok(made.baseline, 'copy made: ' + JSON.stringify(made));
  return { dir, folder, copy, record, baseline: made.baseline, left: made.left };
}
// A change in the copy's own history: edit, add, or delete tracked files, then commit.
const changeCopy = (copy, { edit = {}, add = {}, remove = [] }) => {
  for (const [p, text] of Object.entries(edit)) write(path.join(copy, p), text);
  for (const [p, text] of Object.entries(add)) write(path.join(copy, p), text);
  for (const p of remove) fs.rmSync(path.join(copy, p));
  g(copy, 'add', '-A', '-f');
  g(copy, '-c', 'user.name=P9', '-c', 'user.email=p9@localhost', 'commit', '-qm', 'change');
};
const linkSub = (folder) => { // a sub/ that is a link to a folder elsewhere: any write under sub/ must fail
  fs.renameSync(path.join(folder, 'sub'), path.join(folder, 'sub-moved'));
  fs.symlinkSync('sub-moved', path.join(folder, 'sub'));
};

test('copy takes tracked files (ignored or not) and names links and submodules without following them', async (t) => {
  const s = await sprintOf(t);
  assert.equal(read(path.join(s.copy, 'ignored.txt')), 'tracked but ignored\n', 'a tracked file matched by an ignore pattern is copied');
  assert.equal(read(path.join(s.copy, 'a.txt')), 'a1\n');
  assert.equal(fs.existsSync(path.join(s.copy, 'x.log')), false, 'an ignored untracked file is not copied');
  assert.equal(fs.existsSync(path.join(s.copy, 'loose.txt')), false, 'an untracked file is not copied');
  assert.equal(g(s.copy, 'remote'), '', 'the copy has no origin');
  assert.equal(g(s.copy, 'rev-list', '--count', 'HEAD'), '1', 'one commit');

  fs.symlinkSync('a.txt', path.join(s.folder, 'link'));
  g(s.folder, 'add', 'link');
  g(s.folder, 'update-index', '--add', '--cacheinfo', '160000,' + g(s.folder, 'rev-parse', 'HEAD') + ',vendored');
  g(s.folder, 'commit', '-qm', 'link and submodule');
  const again = await copyTracked(s.folder, path.join(s.dir, 'copy2'));
  assert.deepEqual(again.left.map((l) => l.reason + ':' + l.path).sort(), ['ignored-untracked:x.log', 'link:link', 'submodule:vendored', 'untracked:loose.txt']);
  assert.equal(fs.existsSync(path.join(s.dir, 'copy2', 'link')), false, 'a link is not followed or copied');
});

test('a clean apply writes the change: edit, add, delete', async (t) => {
  const s = await sprintOf(t);
  changeCopy(s.copy, { edit: { 'a.txt': 'a2\n' }, add: { 'n.txt': 'new\n' }, remove: ['b.txt'] });
  const before = g(s.folder, 'rev-parse', 'HEAD');
  const r = await applyCopy({ folder: s.folder, copy: s.copy, baseline: s.baseline, record: s.record, tag: 'T1' });
  assert.deepEqual(r.left, []);
  assert.deepEqual(r.rolledBack, []);
  assert.deepEqual(r.written.sort(), ['a.txt', 'b.txt', 'n.txt']);
  assert.equal(read(path.join(s.folder, 'a.txt')), 'a2\n');
  assert.equal(read(path.join(s.folder, 'n.txt')), 'new\n');
  assert.equal(fs.existsSync(path.join(s.folder, 'b.txt')), false);
  assert.equal(g(s.folder, 'rev-parse', 'HEAD'), before, 'the owner\'s git history is not touched');
});

test('an apply with a changed file writes nothing', async (t) => {
  const s = await sprintOf(t);
  changeCopy(s.copy, { edit: { 'a.txt': 'a2\n' }, add: { 'n.txt': 'new\n' } });
  write(path.join(s.folder, 'a.txt'), 'edited by you\n');
  const r = await applyCopy({ folder: s.folder, copy: s.copy, baseline: s.baseline, record: s.record, tag: 'T2' });
  assert.deepEqual(r.written, []);
  assert.deepEqual(r.left, [{ path: 'a.txt', reason: 'conflict' }]);
  assert.equal(read(path.join(s.folder, 'a.txt')), 'edited by you\n');
  assert.equal(fs.existsSync(path.join(s.folder, 'n.txt')), false, 'nothing written, not even the added file');
});

test('an added path that appears in the folder before apply is a conflict', async (t) => {
  const s = await sprintOf(t);
  changeCopy(s.copy, { add: { 'n.txt': 'new\n' } });
  write(path.join(s.folder, 'n.txt'), 'someone else\n');
  const r = await applyCopy({ folder: s.folder, copy: s.copy, baseline: s.baseline, record: s.record, tag: 'T3' });
  assert.deepEqual(r.left, [{ path: 'n.txt', reason: 'conflict' }]);
  assert.equal(read(path.join(s.folder, 'n.txt')), 'someone else\n');
});

test('a baseline-present path deleted in the folder is a conflict', async (t) => {
  const s = await sprintOf(t);
  changeCopy(s.copy, { edit: { 'b.txt': 'b2\n' } });
  fs.rmSync(path.join(s.folder, 'b.txt'));
  const r = await applyCopy({ folder: s.folder, copy: s.copy, baseline: s.baseline, record: s.record, tag: 'T4' });
  assert.deepEqual(r.left, [{ path: 'b.txt', reason: 'conflict' }]);
  assert.equal(fs.existsSync(path.join(s.folder, 'b.txt')), false);
});

test('a backup that cannot be written refuses the apply before any write', async (t) => {
  const s = await sprintOf(t);
  changeCopy(s.copy, { edit: { 'a.txt': 'a2\n' }, add: { 'n.txt': 'new\n' } });
  write(s.record, 'not a folder'); // the apply record cannot be a folder now
  const r = await applyCopy({ folder: s.folder, copy: s.copy, baseline: s.baseline, record: s.record, tag: 'T5' });
  assert.deepEqual(r.written, []);
  assert.ok(r.left.every((l) => l.reason.startsWith('backup-failed')), JSON.stringify(r.left));
  assert.equal(read(path.join(s.folder, 'a.txt')), 'a1\n', 'nothing written');
  assert.equal(fs.existsSync(path.join(s.folder, 'n.txt')), false);
});

test('a file changed between its check and its write is refused; the earlier write is rolled back', async (t) => {
  const s = await sprintOf(t);
  changeCopy(s.copy, { edit: { 'a.txt': 'a2\n', 'sub/b.txt': 'sb2\n' } });
  const r = await applyCopy({ folder: s.folder, copy: s.copy, baseline: s.baseline, record: s.record, tag: 'T6',
    between: (p) => { if (p === 'sub/b.txt') write(path.join(s.folder, p), 'changed by another program\n'); } });
  assert.deepEqual(r.rolledBack, ['a.txt']);
  assert.deepEqual(r.left, [{ path: 'sub/b.txt', reason: 'changed-since-check' }]);
  assert.equal(read(path.join(s.folder, 'a.txt')), 'a1\n', 'the earlier file is back to its backup');
  assert.equal(read(path.join(s.folder, 'sub/b.txt')), 'changed by another program\n', 'the newer edit is kept');
});

test('B fails after A is written: A is rolled back to its backup, and listed', async (t) => {
  const s = await sprintOf(t);
  changeCopy(s.copy, { edit: { 'a.txt': 'a2\n', 'sub/b.txt': 'sb2\n' } });
  const r = await applyCopy({ folder: s.folder, copy: s.copy, baseline: s.baseline, record: s.record, tag: 'T7',
    between: (p) => { if (p === 'sub/b.txt') linkSub(s.folder); } });
  assert.deepEqual(r.rolledBack, ['a.txt']);
  assert.equal(r.left.length, 1);
  assert.equal(r.left[0].path, 'sub/b.txt');
  assert.match(r.left[0].reason, /^failed:/, 'the rename or write fails');
  assert.equal(read(path.join(s.folder, 'a.txt')), 'a1\n');
});

test('A edited after P9 wrote it, then B fails: A is left as the newer edit, its backup kept', async (t) => {
  const s = await sprintOf(t);
  changeCopy(s.copy, { edit: { 'a.txt': 'a2\n', 'sub/b.txt': 'sb2\n' } });
  const r = await applyCopy({ folder: s.folder, copy: s.copy, baseline: s.baseline, record: s.record, tag: 'T8',
    between: (p) => { if (p === 'sub/b.txt') { write(path.join(s.folder, 'a.txt'), 'a-newer\n'); linkSub(s.folder); } } });
  assert.deepEqual(r.rolledBack, []);
  assert.ok(r.left.some((l) => l.path === 'a.txt' && l.reason === 'newer-than-p9-write'), JSON.stringify(r.left));
  assert.equal(read(path.join(s.folder, 'a.txt')), 'a-newer\n', 'the newer edit survives');
  assert.equal(read(path.join(s.record, 'backup', 'T8', 'a.txt')), 'a1\n', 'the original bytes are recoverable');
});

test('an added path edited after P9 wrote it, then B fails: the added file is kept, not removed', async (t) => {
  const s = await sprintOf(t);
  changeCopy(s.copy, { add: { 'a-new.txt': 'new\n' }, edit: { 'sub/b.txt': 'sb2\n' } });
  const r = await applyCopy({ folder: s.folder, copy: s.copy, baseline: s.baseline, record: s.record, tag: 'T9',
    between: (p) => { if (p === 'sub/b.txt') { write(path.join(s.folder, 'a-new.txt'), 'edited\n'); linkSub(s.folder); } } });
  assert.deepEqual(r.rolledBack, []);
  assert.ok(r.left.some((l) => l.path === 'a-new.txt' && l.reason === 'newer-than-p9-write'), JSON.stringify(r.left));
  assert.equal(read(path.join(s.folder, 'a-new.txt')), 'edited\n');
});

test('a protected folder is refused before anything is read or written', async (t) => {
  const s = await sprintOf(t);
  changeCopy(s.copy, { edit: { 'a.txt': 'a2\n' } });
  setProtection(true);
  t.after(() => setProtection(false));
  const r = await applyCopy({ folder: s.folder, copy: s.copy, baseline: s.baseline, record: s.record, tag: 'T10' });
  assert.equal(r.refused, 'protected-folder');
  assert.equal(read(path.join(s.folder, 'a.txt')), 'a1\n');
});

test('a link on the way to a tracked file is not followed: outside bytes are not copied', async (t) => {
  const s = await sprintOf(t);
  const outside = path.join(s.dir, 'outside');
  write(path.join(outside, 'b.txt'), 'OUTSIDE SECRET\n');
  fs.rmSync(path.join(s.folder, 'sub'), { recursive: true });
  fs.symlinkSync(outside, path.join(s.folder, 'sub'));
  const dest = path.join(s.dir, 'copy-link');
  const made = await copyTracked(s.folder, dest);
  assert.equal(fs.existsSync(path.join(dest, 'sub', 'b.txt')), false, 'nothing under the link is copied');
  assert.deepEqual(made.left.filter((l) => l.path === 'sub/b.txt'), [{ path: 'sub/b.txt', reason: 'link-on-path' }]);
  assert.equal(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'a1\n', 'the rest of the tree still copies');
});

test('left names every excluded path with its reason: untracked, ignored-untracked, link, submodule', async (t) => {
  const s = await sprintOf(t);
  assert.deepEqual(s.left, [
    { path: 'loose.txt', reason: 'untracked' },
    { path: 'x.log', reason: 'ignored-untracked' },
  ]);
});

test('a copy with an uncommitted edit after its commit is refused, not applied', async (t) => {
  const s = await sprintOf(t);
  changeCopy(s.copy, { edit: { 'a.txt': 'a2\n' } });
  write(path.join(s.copy, 'a.txt'), 'a3 uncommitted\n');
  const r = await applyCopy({ folder: s.folder, copy: s.copy, baseline: s.baseline, record: s.record, tag: 'T11' });
  assert.equal(r.refused, 'copy-dirty');
  assert.equal(read(path.join(s.folder, 'a.txt')), 'a1\n', 'the owner\'s file is untouched');
});

test('a rollback that cannot restore is reported with its error, and the P9 bytes stay listed', async (t) => {
  const s = await sprintOf(t);
  changeCopy(s.copy, { edit: { 'a.txt': 'a2\n', 'sub/b.txt': 'sb2\n' } });
  const r = await applyCopy({ folder: s.folder, copy: s.copy, baseline: s.baseline, record: s.record, tag: 'T12',
    afterWrite: (p) => { if (p === 'a.txt') fs.rmSync(path.join(s.record, 'backup', 'T12', 'a.txt')); },
    between: (p) => { if (p === 'sub/b.txt') linkSub(s.folder); } });
  assert.deepEqual(r.rolledBack, []);
  const a = r.left.find((l) => l.path === 'a.txt');
  assert.ok(a && a.reason.startsWith('rollback-failed'), JSON.stringify(r.left));
  assert.equal(read(path.join(s.folder, 'a.txt')), 'a2\n', 'the P9 bytes are still in place, and the list says so');
});

test('a write that lands and then throws is rolled back, not left behind', async (t) => {
  const s = await sprintOf(t);
  changeCopy(s.copy, { edit: { 'a.txt': 'a2\n' } });
  const r = await applyCopy({ folder: s.folder, copy: s.copy, baseline: s.baseline, record: s.record, tag: 'T13',
    afterWrite: (p) => { if (p === 'a.txt') throw Object.assign(new Error('sync failed'), { code: 'EIO' }); } });
  assert.deepEqual(r.rolledBack, ['a.txt']);
  assert.deepEqual(r.left, []);
  assert.equal(read(path.join(s.folder, 'a.txt')), 'a1\n', 'the landed write is restored from its backup');
});

test('the owner gets the committed bytes even if the copy is edited mid-apply; a later failure rolls back the landed write', async (t) => {
  const s = await sprintOf(t);
  changeCopy(s.copy, { edit: { 'a.txt': 'a2\n', 'sub/b.txt': 'sb2\n' } });
  let landed = null;
  const r = await applyCopy({ folder: s.folder, copy: s.copy, baseline: s.baseline, record: s.record, tag: 'T14',
    between: (p) => {
      if (p === 'a.txt') write(path.join(s.copy, 'a.txt'), 'a3 uncommitted\n'); // after the pin, before its write
      if (p === 'sub/b.txt') linkSub(s.folder); // a later write fails
    },
    afterWrite: (p) => { if (p === 'a.txt') landed = read(path.join(s.folder, 'a.txt')); } });
  assert.equal(landed, 'a2\n', 'the owner receives the committed bytes, not the uncommitted a3');
  assert.deepEqual(r.rolledBack, ['a.txt']);
  assert.equal(r.left.length, 1);
  assert.equal(r.left[0].path, 'sub/b.txt');
  assert.equal(read(path.join(s.folder, 'a.txt')), 'a1\n', 'the landed write is restored from its backup');
  assert.equal(read(path.join(s.record, 'backup', 'T14', 'a.txt')), 'a1\n');
});

test('a link swapped in on the way to a tracked file, after the listing, is refused: outside bytes are not copied', async (t) => {
  const s = await sprintOf(t);
  const outside = path.join(s.dir, 'outside');
  write(path.join(outside, 'b.txt'), 'OUTSIDE SECRET\n');
  const dest = path.join(s.dir, 'copy-swap');
  const made = await copyTracked(s.folder, dest, { beforeRead: (rel) => {
    if (rel !== 'sub/b.txt') return;
    fs.renameSync(path.join(s.folder, 'sub'), path.join(s.folder, 'sub-moved'));
    fs.symlinkSync(outside, path.join(s.folder, 'sub'));
  } });
  assert.equal(fs.existsSync(path.join(dest, 'sub', 'b.txt')), false, 'nothing under the swapped link is copied');
  assert.equal(JSON.stringify(made).includes('OUTSIDE SECRET'), false, 'no outside bytes in the result');
  assert.deepEqual(made.left.filter((l) => l.path === 'sub/b.txt'), [{ path: 'sub/b.txt', reason: 'link-on-path' }]);
  assert.equal(made.baseline.paths['sub/b.txt'], undefined);
  assert.equal(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'a1\n', 'the rest of the tree still copies');
});
