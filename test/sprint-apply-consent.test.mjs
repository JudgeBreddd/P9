// The owner's consent and apply for a sprint from a folder with no remote (SECURITY.md § Sprint from a folder with no
// remote, "Applying to your folder is a yes"). The yes binds to the change shown; a conflict writes nothing. Throwaway repos.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { applySprint, previewSprint, startCopy } from '../apps/server/folder-copy.mjs';
import { setProtection } from '../packages/files/index.mjs';

const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const read = (file) => fs.readFileSync(file, 'utf8');
function scratch(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p9-apply-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
// File protection is on by default and the desktop turns it off; a real apply runs with it off, restored after.
function unprotected(t) { setProtection(false); t.after(() => setProtection(true)); }
// A folder with no remote, its copy made, and the sprint folder holding it.
async function setup(t) {
  const dir = scratch(t), source = path.join(dir, 'solo'), sprint = path.join(dir, 'state', 'sprints', '0123abcd-0000-4000-8000-000000000003');
  g(dir, 'init', '-q', '-b', 'main', source);
  write(path.join(source, 'a.txt'), 'one\n'); g(source, 'add', 'a.txt'); g(source, 'commit', '-qm', 'first');
  const made = await startCopy(sprint, source);
  assert.equal(made.error, undefined, made.detail);
  return { dir, source, sprint, copy: path.join(sprint, 'copy') };
}

test('Sprint apply: nothing is written without the owner\'s yes, and a yes for a change not shown is refused', { timeout: 60000 }, async (t) => {
  const { source, sprint, copy } = await setup(t);
  write(path.join(copy, 'a.txt'), 'two\n'); g(copy, 'add', 'a.txt'); g(copy, 'commit', '-qm', 'edit');
  const shown = (await previewSprint(sprint)).shown;
  assert.equal((await applySprint(sprint, { yes: false, shown })).refused, 'no-owner-yes');
  assert.equal(read(path.join(source, 'a.txt')), 'one\n', 'a refused yes writes nothing');
  assert.equal((await applySprint(sprint, { yes: true, shown: 'not-the-digest' })).refused, 'changed-since-shown');
  assert.equal(read(path.join(source, 'a.txt')), 'one\n', 'a yes for a change not shown writes nothing');
});

test('Sprint apply: the owner\'s yes applies the change shown, records one apply, and a second apply is refused', { timeout: 60000 }, async (t) => {
  unprotected(t);
  const { source, sprint, copy } = await setup(t);
  write(path.join(copy, 'a.txt'), 'two\n'); g(copy, 'add', 'a.txt'); g(copy, 'commit', '-qm', 'edit');
  const shown = (await previewSprint(sprint)).shown;
  const done = await applySprint(sprint, { yes: true, shown });
  assert.deepEqual(done.written, ['a.txt'], JSON.stringify(done));
  assert.equal(read(path.join(source, 'a.txt')), 'two\n');
  assert.ok(fs.existsSync(path.join(sprint, 'apply-result.json')), 'the apply is recorded');
  assert.equal((await applySprint(sprint, { yes: true, shown })).refused, 'already-applied');
});

test('Sprint apply: a change made to the copy after the owner was shown it is refused, nothing written', { timeout: 60000 }, async (t) => {
  const { source, sprint, copy } = await setup(t);
  write(path.join(copy, 'a.txt'), 'two\n'); g(copy, 'add', 'a.txt'); g(copy, 'commit', '-qm', 'edit');
  const shown = (await previewSprint(sprint)).shown;
  write(path.join(copy, 'b.txt'), 'added later\n'); g(copy, 'add', 'b.txt'); g(copy, 'commit', '-qm', 'more');
  assert.equal((await applySprint(sprint, { yes: true, shown })).refused, 'changed-since-shown');
  assert.equal(read(path.join(source, 'a.txt')), 'one\n');
  assert.equal(fs.existsSync(path.join(source, 'b.txt')), false);
});

test('Sprint apply: a file edited in the folder after the copy is a conflict; the apply writes nothing, not even the other paths', { timeout: 60000 }, async (t) => {
  unprotected(t);
  const { source, sprint, copy } = await setup(t);
  write(path.join(copy, 'a.txt'), 'two\n'); write(path.join(copy, 'b.txt'), 'new\n'); g(copy, 'add', '-A'); g(copy, 'commit', '-qm', 'edit');
  const shown = (await previewSprint(sprint)).shown;
  write(path.join(source, 'a.txt'), 'mine\n'); // the owner edits a.txt after the copy was made
  const done = await applySprint(sprint, { yes: true, shown });
  assert.equal(done.cause, 'conflict', JSON.stringify(done));
  assert.deepEqual(done.written, []);
  assert.equal(read(path.join(source, 'a.txt')), 'mine\n', 'the owner\'s newer edit is kept');
  assert.equal(fs.existsSync(path.join(source, 'b.txt')), false, 'a conflict writes no other path either');
});

test('Sprint apply: with file protection on (the default), a yes for the change shown is refused protected-folder and nothing is written', { timeout: 60000 }, async (t) => {
  const { source, sprint, copy } = await setup(t);
  write(path.join(copy, 'a.txt'), 'two\n'); g(copy, 'add', 'a.txt'); g(copy, 'commit', '-qm', 'edit');
  const shown = (await previewSprint(sprint)).shown;
  assert.equal((await applySprint(sprint, { yes: true, shown })).refused, 'protected-folder');
  assert.equal(read(path.join(source, 'a.txt')), 'one\n');
  assert.equal(fs.existsSync(path.join(sprint, 'apply-result.json')), false, 'nothing is recorded as applied');
});
