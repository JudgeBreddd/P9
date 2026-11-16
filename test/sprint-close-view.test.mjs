// The close view of a sprint's apply (SECURITY.md "The result, always three lists"): written, rolled back, left, and a
// partial result shown as partial. Throwaway repositories made here; the partial result is written by hand, as the apply
// record would be, since forcing a real mid-apply failure needs the apply's own seams.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWorkerFolders } from '../apps/server/worker-folders.mjs';
import { setProtection } from '../packages/files/index.mjs';

const ID = '0123abcd-0000-4000-8000-000000000005';
const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const read = (file) => fs.readFileSync(file, 'utf8');
function unprotected(t) { setProtection(false); t.after(() => setProtection(true)); }

// A folder with no remote, its copy made by the wiring, and the workers API for its sprint.
async function copied(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p9-close-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'solo'), home = path.join(dir, 'state', 'sprints'), sprint = path.join(home, ID);
  g(dir, 'init', '-q', '-b', 'main', source);
  write(path.join(source, 'a.txt'), 'one\n'); g(source, 'add', 'a.txt'); g(source, 'commit', '-qm', 'first');
  const workers = createWorkerFolders({ home });
  assert.equal((await workers.make(ID, 'item-g', source, '')).error, undefined);
  return { source, sprint, copy: path.join(sprint, 'copy'), workers };
}

test('Sprint close view: before any apply the view says not-applied, and nothing is shown as applied', { timeout: 60000 }, async (t) => {
  const { workers } = await copied(t);
  assert.deepEqual(await workers.close(ID), { error: 'not-applied' });
});

test('Sprint close view: a clean apply lists what was written, nothing rolled back or left, and is not partial', { timeout: 60000 }, async (t) => {
  unprotected(t);
  const { source, copy, workers } = await copied(t);
  write(path.join(copy, 'a.txt'), 'two\n'); g(copy, 'add', 'a.txt'); g(copy, 'commit', '-qm', 'edit');
  const shown = (await workers.preview(ID)).shown;
  assert.deepEqual((await workers.apply(ID, { yes: true, shown })).written, ['a.txt']);
  const view = await workers.close(ID);
  assert.deepEqual(view.written, ['a.txt']);
  assert.deepEqual(view.rolledBack, []);
  assert.deepEqual(view.left, []);
  assert.equal(view.partial, false);
  assert.equal(read(path.join(source, 'a.txt')), 'two\n');
});

test('Sprint close view: a conflict writes nothing and shows its cause, not as partial', { timeout: 60000 }, async (t) => {
  unprotected(t);
  const { source, copy, workers } = await copied(t);
  write(path.join(copy, 'a.txt'), 'two\n'); g(copy, 'add', 'a.txt'); g(copy, 'commit', '-qm', 'edit');
  const shown = (await workers.preview(ID)).shown;
  write(path.join(source, 'a.txt'), 'mine\n'); // the owner's newer edit
  await workers.apply(ID, { yes: true, shown });
  const view = await workers.close(ID);
  assert.equal(view.cause, 'conflict');
  assert.deepEqual(view.written, []);
  assert.equal(view.partial, false, 'a conflict wrote nothing, so it is refused, not partial');
  assert.equal(read(path.join(source, 'a.txt')), 'mine\n');
});

test('Sprint close view: a partial apply is shown as partial, with each left path and its reason', { timeout: 60000 }, async (t) => {
  const { sprint, workers } = await copied(t);
  fs.writeFileSync(path.join(sprint, 'apply-result.json'), JSON.stringify({
    source: 'x', at: 'x', written: ['a.txt'], rolledBack: ['c.txt'],
    left: [{ path: 'b.txt', reason: 'rollback-failed: EACCES' }], cause: 'write-failed',
  }));
  const view = await workers.close(ID);
  assert.equal(view.partial, true, 'something left: partial');
  assert.deepEqual(view.written, ['a.txt']);
  assert.deepEqual(view.rolledBack, ['c.txt']);
  assert.deepEqual(view.left, [{ path: 'b.txt', reason: 'rollback-failed: EACCES' }]);
  assert.equal(view.cause, 'write-failed');
});
