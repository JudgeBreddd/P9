// Clean-up of a sprint's copy (SECURITY.md § Sprint from a folder with no remote): the copy goes only once its work is
// applied cleanly and it holds nothing but the applied commit; a sprint with no apply, a partial apply, a conflict, or any
// file, folder, link or ref the applied commit does not hold keeps the copy. Throwaway repositories made here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWorkerFolders } from '../apps/server/worker-folders.mjs';
import { setProtection } from '../packages/files/index.mjs';

const ID = '0123abcd-0000-4000-8000-000000000004';
const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

// A folder with no remote, its copy made by the wiring (make), and the apply record the test writes by hand.
async function copied(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p9-clean-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'solo'), home = path.join(dir, 'state', 'sprints'), sprint = path.join(home, ID);
  g(dir, 'init', '-q', '-b', 'main', source);
  write(path.join(source, 'a.txt'), 'one\n'); g(source, 'add', 'a.txt'); g(source, 'commit', '-qm', 'first');
  assert.equal((await createWorkerFolders({ home }).make(ID, 'item-f', source, '')).error, undefined);
  return { home, sprint, source, copy: path.join(sprint, 'copy') };
}
// Protection is on by default; a real apply runs with it off, restored after.
function unprotected(t) { setProtection(false); t.after(() => setProtection(true)); }
// A copy applied through the owner's yes (the real apply path, not a written record): one edit, shown, applied, clean.
async function appliedClean(t) {
  unprotected(t);
  const c = await copied(t), workers = createWorkerFolders({ home: c.home });
  write(path.join(c.copy, 'a.txt'), 'two\n'); g(c.copy, 'add', 'a.txt'); g(c.copy, 'commit', '-qm', 'edit');
  const shown = (await workers.preview(ID)).shown;
  assert.deepEqual((await workers.apply(ID, { yes: true, shown })).left, []);
  return { ...c, workers };
}
const record = (sprint, result) => fs.writeFileSync(path.join(sprint, 'apply-result.json'), JSON.stringify({ source: 'x', at: 'x', ...result }));

test('Sprint copy clean-up: a copy whose work is not applied is kept, however clean the sprint looks', { timeout: 60000 }, async (t) => {
  const { home, sprint, copy } = await copied(t);
  await createWorkerFolders({ home }).clean(ID);
  assert.equal(fs.existsSync(copy), true, 'no apply record: the copy stays');
});

test('Sprint copy clean-up: a copy applied cleanly is removed, its apply record kept', { timeout: 60000 }, async (t) => {
  const { sprint, copy, workers } = await appliedClean(t);
  await workers.clean(ID);
  assert.equal(fs.existsSync(copy), false, 'applied cleanly, no edit after: the copy goes');
  assert.equal(fs.existsSync(path.join(sprint, 'apply-result.json')), true, 'the apply record stays');
});

test('Sprint copy clean-up: an edit to the copy after its clean apply is kept, with its bytes', { timeout: 60000 }, async (t) => {
  const { copy, workers } = await appliedClean(t);
  write(path.join(copy, 'a.txt'), 'three\n'); // not committed: the copy is not what was applied
  await workers.clean(ID);
  assert.equal(fs.readFileSync(path.join(copy, 'a.txt'), 'utf8'), 'three\n', 'the newer edit is still there');
});

test('Sprint copy clean-up: a commit made in the copy after its clean apply is kept', { timeout: 60000 }, async (t) => {
  const { copy, workers } = await appliedClean(t);
  write(path.join(copy, 'later.txt'), 'later\n'); g(copy, 'add', 'later.txt'); g(copy, 'commit', '-qm', 'later');
  await workers.clean(ID);
  assert.equal(fs.existsSync(path.join(copy, 'later.txt')), true, 'the commit made after the apply is still there');
});

test('Sprint copy clean-up: a copy with an origin is never fetched, so no remote ref appears', { timeout: 60000 }, async (t) => {
  const { home, copy, source } = await copied(t);
  const bare = path.join(path.dirname(source), 'remote.git'), work = path.join(path.dirname(source), 'work');
  g(path.dirname(source), 'init', '-q', '--bare', bare);
  g(path.dirname(source), 'clone', '-q', bare, work);
  write(path.join(work, 'r.txt'), 'remote\n'); g(work, 'add', 'r.txt'); g(work, 'commit', '-qm', 'remote'); g(work, 'push', '-q', 'origin', 'HEAD:main');
  g(copy, 'remote', 'add', 'origin', bare);
  await createWorkerFolders({ home }).clean(ID);
  assert.throws(() => g(copy, 'rev-parse', '-q', '--verify', 'refs/remotes/origin/main'), 'clean-up fetched the copy\'s origin');
});

test('Sprint copy clean-up: a partial apply (something left) keeps the copy', { timeout: 60000 }, async (t) => {
  const { home, sprint, copy } = await copied(t);
  record(sprint, { written: [], rolledBack: ['a.txt'], left: [{ path: 'b.txt', reason: 'rollback-failed: EACCES' }], cause: 'write-failed' });
  await createWorkerFolders({ home }).clean(ID);
  assert.equal(fs.existsSync(copy), true, 'a partial apply keeps the copy for the owner');
});

test('Sprint copy clean-up: a conflict (cause set, nothing left) keeps the copy', { timeout: 60000 }, async (t) => {
  const { home, sprint, copy } = await copied(t);
  record(sprint, { written: [], rolledBack: [], left: [{ path: 'a.txt', reason: 'changed-by-owner' }], cause: 'conflict' });
  await createWorkerFolders({ home }).clean(ID);
  assert.equal(fs.existsSync(copy), true, 'a conflict keeps the copy');
});

test('Sprint copy clean-up: a file the copy\'s .gitignore excludes, made after a clean apply, is kept and the close view says why', { timeout: 60000 }, async (t) => {
  unprotected(t);
  const c = await copied(t), workers = createWorkerFolders({ home: c.home });
  write(path.join(c.copy, 'a.txt'), 'two\n'); write(path.join(c.copy, '.gitignore'), 'private.txt\n');
  g(c.copy, 'add', 'a.txt', '.gitignore'); g(c.copy, 'commit', '-qm', 'edit');
  const shown = (await workers.preview(ID)).shown;
  assert.deepEqual((await workers.apply(ID, { yes: true, shown })).left, []);
  write(path.join(c.copy, 'private.txt'), 'only here\n'); // ignored and untracked: git status without --ignored does not list it
  assert.equal(g(c.copy, 'status', '--porcelain', '--untracked-files=all'), '', 'the control: plain status sees nothing');
  await workers.clean(ID);
  assert.equal(fs.readFileSync(path.join(c.copy, 'private.txt'), 'utf8'), 'only here\n', 'the ignored file is still there');
  assert.match((await workers.close(ID)).copyKept ?? '', /not part of the applied commit: .*private\.txt/);
});

test('Sprint copy clean-up: a tracked file changed after a clean apply keeps the copy, and the reason names it', { timeout: 60000 }, async (t) => {
  const { copy, workers } = await appliedClean(t);
  write(path.join(copy, 'a.txt'), 'three\n');
  await workers.clean(ID);
  assert.equal(fs.readFileSync(path.join(copy, 'a.txt'), 'utf8'), 'three\n');
  assert.match((await workers.close(ID)).copyKept ?? '', /not part of the applied commit: a\.txt/);
});

test('Sprint copy clean-up: an empty folder made after a clean apply keeps the copy, and the reason names it', { timeout: 60000 }, async (t) => {
  const { copy, workers } = await appliedClean(t);
  fs.mkdirSync(path.join(copy, 'empty'));
  await workers.clean(ID);
  assert.equal(fs.existsSync(path.join(copy, 'empty')), true, 'the empty folder is still there');
  assert.match((await workers.close(ID)).copyKept ?? '', /not part of the applied commit: empty\//);
});

test('Sprint copy clean-up: a link made after a clean apply keeps the copy, and the reason names it', { timeout: 60000 }, async (t) => {
  const { copy, workers } = await appliedClean(t);
  fs.symlinkSync('a.txt', path.join(copy, 'link'));
  await workers.clean(ID);
  assert.equal(fs.lstatSync(path.join(copy, 'link')).isSymbolicLink(), true);
  assert.match((await workers.close(ID)).copyKept ?? '', /not part of the applied commit: link/);
});

test('Sprint copy clean-up: a stash made after a clean apply keeps the copy', { timeout: 60000 }, async (t) => {
  const { copy, workers } = await appliedClean(t);
  write(path.join(copy, 'a.txt'), 'stashed\n'); g(copy, 'stash', '-q');
  await workers.clean(ID);
  assert.equal(fs.existsSync(copy), true, 'the stash lives only in the copy');
  assert.match((await workers.close(ID)).copyKept ?? '', /stash/);
});
