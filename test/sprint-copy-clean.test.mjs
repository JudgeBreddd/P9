// Clean-up of a sprint's copy (SECURITY.md § Sprint from a folder with no remote): the copy goes only once its work is
// applied cleanly; a sprint with no apply, a partial apply, or a conflict keeps the copy. Throwaway repositories made here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWorkerFolders } from '../apps/server/worker-folders.mjs';

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
  return { home, sprint, copy: path.join(sprint, 'copy') };
}
const record = (sprint, result) => fs.writeFileSync(path.join(sprint, 'apply-result.json'), JSON.stringify({ source: 'x', at: 'x', ...result }));

test('Sprint copy clean-up: a copy whose work is not applied is kept, however clean the sprint looks', { timeout: 60000 }, async (t) => {
  const { home, sprint, copy } = await copied(t);
  await createWorkerFolders({ home }).clean(ID);
  assert.equal(fs.existsSync(copy), true, 'no apply record: the copy stays');
});

test('Sprint copy clean-up: a copy applied cleanly is removed, its apply record kept', { timeout: 60000 }, async (t) => {
  const { home, sprint, copy } = await copied(t);
  record(sprint, { written: ['a.txt'], rolledBack: [], left: [] });
  await createWorkerFolders({ home }).clean(ID);
  assert.equal(fs.existsSync(copy), false, 'applied cleanly: the copy goes');
  assert.equal(fs.existsSync(path.join(sprint, 'apply-result.json')), true, 'the apply record stays');
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
