// PD-2 (first half): the transfer list (xfer.mjs gitList) and the sprint copy's apply (folder-copy.mjs blobOf) run git with
// childEnv(), not the daemon's whole environment. A daemon started inside a git hook has GIT_DIR set; passed on, it points
// every git at another repository, so the list falls back to a walk (ignored files sent) and the apply cannot read a blob.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createXfer } from '../apps/server/xfer.mjs';
import { copyTracked, applyCopy } from '../apps/server/folder-copy.mjs';
import { setProtection } from '../packages/files/index.mjs';

setProtection(false);
const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

// A repository with tracked a.txt and .gitignore, and x.log that .gitignore excludes.
function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9-gitenv-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const folder = path.join(dir, 'work', 'owner');
  fs.mkdirSync(folder, { recursive: true });
  g(folder, 'init', '-q');
  write(path.join(folder, '.gitignore'), '*.log\n');
  write(path.join(folder, 'a.txt'), 'a1\n');
  g(folder, 'add', '.gitignore', 'a.txt');
  g(folder, 'commit', '-qm', 'init');
  write(path.join(folder, 'x.log'), 'never sent\n');
  return { dir, workspace: path.join(dir, 'work'), folder };
}

// The daemon's own environment holds GIT_DIR (a folder that is not there) only while call runs.
async function withGitDir(dir, call) {
  process.env.GIT_DIR = path.join(dir, 'no-such-repo');
  try { return await call(); } finally { delete process.env.GIT_DIR; }
}

test('a GIT_DIR in the daemon\'s environment reaches neither the transfer list nor the sprint copy\'s apply', async (t) => {
  const s = repo(t);
  const xfer = createXfer({ workspace: s.workspace, ownership: null, recovery: null });
  const plain = await xfer.manifest({ folder: 'owner' });
  const paths = (answer) => answer.files.map((f) => f.path).sort();
  assert.deepEqual(paths(plain), ['owner/.gitignore', 'owner/a.txt'], 'git lists the folder; x.log is left out');
  const listed = await withGitDir(s.dir, () => xfer.manifest({ folder: 'owner' }));
  assert.equal(listed.status, 200);
  assert.deepEqual(paths(listed), paths(plain), 'the same list with GIT_DIR in the daemon\'s environment');

  const copy = path.join(s.dir, 'copy'), record = path.join(s.dir, 'record');
  const made = await copyTracked(s.folder, copy);
  assert.ok(made.baseline, 'copy made: ' + JSON.stringify(made));
  write(path.join(copy, 'a.txt'), 'a2\n');
  g(copy, 'add', 'a.txt');
  g(copy, '-c', 'user.name=P9', '-c', 'user.email=p9@localhost', 'commit', '-qm', 'change');
  const applied = await withGitDir(s.dir, () => applyCopy({ folder: s.folder, copy, baseline: made.baseline, record, tag: 'E1' }));
  assert.deepEqual(applied.written, ['a.txt'], 'the apply wrote the change: ' + JSON.stringify(applied));
  assert.equal(fs.readFileSync(path.join(s.folder, 'a.txt'), 'utf8'), 'a2\n', 'the blob\'s bytes reached the owner\'s folder');
  console.log('PASS git child env: transfer list ' + paths(listed).length + ' files and apply of a.txt unchanged with GIT_DIR in the daemon\'s environment');
});
