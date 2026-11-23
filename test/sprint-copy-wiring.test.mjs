// A sprint from a folder with no remote, wired into worker folders (SECURITY.md § Sprint from a folder with no remote):
// the sprint's copy is made from the folder itself, never cloned from a larger repository; the folder that holds P9's state
// is refused before anything is copied. Throwaway repositories made here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWorkerFolders } from '../apps/server/worker-folders.mjs';

const ID = '0123abcd-0000-4000-8000-000000000002';
const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
function scratch(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p9-scw-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('Sprint copy wiring: a folder with no remote starts a sprint from its own copy: tracked edits copied, untracked and ignored files left out and named, no origin', { timeout: 60000 }, async (t) => {
  const dir = scratch(t), source = path.join(dir, 'solo'), home = path.join(dir, 'state', 'sprints');
  g(dir, 'init', '-q', '-b', 'main', source);
  write(path.join(source, '.gitignore'), 'secret.env\n');
  write(path.join(source, 'a.txt'), 'one\n'); write(path.join(source, 'tracked-ignored.env'), 'kept\n');
  g(source, 'add', '-f', '.gitignore', 'a.txt', 'tracked-ignored.env'); g(source, 'commit', '-qm', 'first');
  write(path.join(source, 'a.txt'), 'edited\n'); // an unsaved edit to a tracked file is copied with the edit
  write(path.join(source, 'new.txt'), 'untracked\n'); write(path.join(source, 'secret.env'), 'ignored\n');
  const made = await createWorkerFolders({ home }).make(ID, 'item-a', source, 'echo ready> setup.txt');
  assert.equal(made.error, undefined, made.detail);
  const copy = path.join(home, ID, 'copy');
  assert.equal(g(copy, 'rev-parse', '--show-toplevel'), copy, 'the sprint copy is its own repository');
  assert.equal(g(copy, 'remote'), '', 'the copy has no origin');
  assert.equal(fs.readFileSync(path.join(made.folder, 'a.txt'), 'utf8'), 'edited\n', 'the worker starts from the copy, edit included');
  assert.equal(fs.readFileSync(path.join(made.folder, 'tracked-ignored.env'), 'utf8'), 'kept\n', 'a tracked file an ignore pattern matches is copied');
  assert.equal(fs.existsSync(path.join(made.folder, 'new.txt')), false, 'an untracked file is not copied');
  assert.equal(fs.existsSync(path.join(made.folder, 'secret.env')), false, 'an ignored untracked file is not copied');
  const record = JSON.parse(fs.readFileSync(path.join(home, ID, 'copy-record.json'), 'utf8'));
  assert.equal(record.source, source, 'the record names the folder the copy came from');
  assert.deepEqual(record.left.map((x) => [x.path, x.reason]).sort(), [['new.txt', 'untracked'], ['secret.env', 'ignored-untracked']].sort(), 'the left-out names are recorded with their reasons');
  assert.equal(fs.readFileSync(path.join(source, 'new.txt'), 'utf8'), 'untracked\n', 'the owner\'s folder is untouched');
});

test('Sprint copy wiring: a folder inside a larger repository is copied alone, by its own path; the parent\'s files and history are not in the copy', { timeout: 60000 }, async (t) => {
  const dir = scratch(t), parent = path.join(dir, 'parent'), sub = path.join(parent, 'pkg'), home = path.join(dir, 'state', 'sprints');
  g(dir, 'init', '-q', '-b', 'main', parent);
  write(path.join(parent, 'outside.txt'), 'parent only\n'); g(parent, 'add', 'outside.txt'); g(parent, 'commit', '-qm', 'parent');
  write(path.join(sub, 'inside.txt'), 'pkg\n'); g(parent, 'add', 'pkg/inside.txt'); g(parent, 'commit', '-qm', 'pkg');
  const made = await createWorkerFolders({ home }).make(ID, 'item-b', sub, '');
  assert.equal(made.error, undefined, made.detail);
  assert.equal(fs.readFileSync(path.join(made.folder, 'inside.txt'), 'utf8'), 'pkg\n', 'the folder\'s own file is in the copy');
  assert.equal(fs.existsSync(path.join(made.folder, 'outside.txt')), false, 'a file outside the folder is not in the copy');
  assert.equal(g(path.join(home, ID, 'copy'), 'rev-list', '--count', 'HEAD'), '1', 'the copy has one commit of its own, not the parent\'s history');
  const record = JSON.parse(fs.readFileSync(path.join(home, ID, 'copy-record.json'), 'utf8'));
  assert.equal(record.source, fs.realpathSync(sub));
});

test('Sprint copy wiring: a folder that holds P9\'s own state is refused before anything is copied', { timeout: 60000 }, async (t) => {
  const dir = scratch(t), holder = path.join(dir, 'holder');
  const home = path.join(holder, 'state', 'sprints'); // the holder is a repository whose folder contains P9's state
  g(dir, 'init', '-q', '-b', 'main', holder);
  write(path.join(holder, 'x.txt'), 'x\n'); g(holder, 'add', 'x.txt'); g(holder, 'commit', '-qm', 'x');
  const refused = await createWorkerFolders({ home }).make(ID, 'item-c', holder, '');
  assert.equal(refused.error, 'folder-refused', 'the folder holds P9\'s state');
  assert.equal(fs.existsSync(path.join(home, ID, 'copy')), false, 'nothing was copied');
  // A folder inside P9's own sprints folder is refused the same way.
  const inside = path.join(home, 'stored-repo');
  fs.mkdirSync(inside, { recursive: true }); g(inside, 'init', '-q', '-b', 'main'); write(path.join(inside, 'y.txt'), 'y\n'); g(inside, 'add', 'y.txt'); g(inside, 'commit', '-qm', 'y');
  assert.equal((await createWorkerFolders({ home }).make(ID, 'item-f', inside, '')).error, 'folder-refused', 'a folder inside P9\'s sprints folder');
  assert.equal(fs.existsSync(path.join(home, ID, 'copy')), false, 'nothing was copied from it either');
});

test('Sprint copy wiring: a sprint has one copy; a folder other than the one it was copied from is refused, never given the copy', { timeout: 60000 }, async (t) => {
  const dir = scratch(t), first = path.join(dir, 'first'), second = path.join(dir, 'second'), home = path.join(dir, 'state', 'sprints');
  for (const folder of [first, second]) {
    g(dir, 'init', '-q', '-b', 'main', folder);
    write(path.join(folder, 'f.txt'), folder + '\n'); g(folder, 'add', 'f.txt'); g(folder, 'commit', '-qm', 'f');
  }
  assert.equal((await createWorkerFolders({ home }).make(ID, 'item-d', first, '')).error, undefined);
  const other = await createWorkerFolders({ home }).make(ID, 'item-e', second, '');
  assert.equal(other.error, 'other-repository', 'a different folder is refused for this sprint');
  assert.equal(fs.existsSync(path.join(home, ID, 'workers', 'item-e')), false, 'no worker folder was made from it');
});

test('Sprint copy wiring: a malformed copy record reads as none: the folder is refused with the reason, not a parse error', { timeout: 60000 }, async (t) => {
  const dir = scratch(t), source = path.join(dir, 'solo'), home = path.join(dir, 'state', 'sprints');
  g(dir, 'init', '-q', '-b', 'main', source);
  write(path.join(source, 'f.txt'), 'f\n'); g(source, 'add', 'f.txt'); g(source, 'commit', '-qm', 'f');
  assert.equal((await createWorkerFolders({ home }).make(ID, 'item-f', source, '')).error, undefined);
  fs.writeFileSync(path.join(home, ID, 'copy-record.json'), '{"source": ');
  const again = await createWorkerFolders({ home }).make(ID, 'item-g', source, '');
  assert.equal(again.error, 'other-repository', 'a record that does not parse is no record: ' + again.detail);
  assert.equal(fs.existsSync(path.join(home, ID, 'workers', 'item-g')), false, 'no worker folder was made');
});
