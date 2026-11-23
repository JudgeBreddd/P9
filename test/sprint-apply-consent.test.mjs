// The owner's consent and apply for a sprint from a folder with no remote (SECURITY.md § Sprint from a folder with no
// remote, "Applying to your folder is a yes"). The yes binds to the change shown; a conflict writes nothing. Throwaway repos.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { applySprint, closeOf, previewSprint, startCopy } from '../apps/server/folder-copy.mjs';
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

test('Sprint apply: a commit made to the copy after the owner\'s yes is checked is not applied; only the change shown is', { timeout: 60000 }, async (t) => {
  unprotected(t);
  const { source, sprint, copy } = await setup(t);
  write(path.join(copy, 'a.txt'), 'two\n'); g(copy, 'add', 'a.txt'); g(copy, 'commit', '-qm', 'edit');
  const shown = (await previewSprint(sprint)).shown;
  let moved = false;
  const done = await applySprint(sprint, { yes: true, shown, onVerified: () => {
    write(path.join(copy, 'late.txt'), 'late\n'); g(copy, 'add', 'late.txt'); g(copy, 'commit', '-qm', 'late');
    moved = true;
  } });
  assert.equal(moved, true, 'the commit landed between the yes and the apply');
  assert.deepEqual(done.written, ['a.txt'], 'only the change shown is written');
  assert.equal(read(path.join(source, 'a.txt')), 'two\n');
  assert.equal(fs.existsSync(path.join(source, 'late.txt')), false, 'a commit made after the yes is not applied');
});

test('Sprint apply: a result that cannot be recorded after the owner\'s files change reads as unknown, and blocks a second apply', { timeout: 60000 }, async (t) => {
  unprotected(t);
  const { source, sprint, copy } = await setup(t);
  write(path.join(copy, 'a.txt'), 'two\n'); g(copy, 'add', 'a.txt'); g(copy, 'commit', '-qm', 'edit');
  const shown = (await previewSprint(sprint)).shown;
  // A real write failure: the sprint folder goes read-only after the owner's file changed, so the final result cannot be written.
  // Teardown: the test restores the folder only if it still exists (the temp root may already be gone).
  t.after(() => { if (fs.existsSync(sprint)) fs.chmodSync(sprint, 0o700); });
  const done = await applySprint(sprint, { yes: true, shown, beforeFinalize: () => fs.chmodSync(sprint, 0o500) });
  assert.equal(read(path.join(source, 'a.txt')), 'two\n', 'the owner\'s file did change');
  assert.match(done.recordError ?? '', /^result-not-recorded: /);
  const view = await closeOf(sprint);
  assert.equal(view.pending, true, 'the outcome reads as pending, not as not-applied');
  assert.equal(view.partial, false);
  assert.match(view.lines[0], /^Unknown: /);
  assert.equal(view.lines.some((l) => /not applied/i.test(l)), false, 'an unknown apply never says not applied');
  fs.chmodSync(sprint, 0o700);
  assert.equal((await applySprint(sprint, { yes: true, shown })).refused, 'already-applied', 'a pending apply blocks another');
});

// A sprint's copy record or apply result that exists but does not parse (a disk fault, a hand edit). The record reads as no
// copy: preview and apply are refused, not thrown. The result reads as unknown, as one never finalized does: the close view
// says to check the folder, the copy is kept, and a second apply is still refused.
test('Sprint apply: a copy record that does not parse, or is not a record, is no copy: preview and apply are refused no-copy', { timeout: 60000 }, async (t) => {
  const { sprint } = await setup(t);
  for (const text of ['{"source": ', '{}']) {
    fs.writeFileSync(path.join(sprint, 'copy-record.json'), text);
    assert.deepEqual(await previewSprint(sprint), { refused: 'no-copy' }, 'preview with ' + text);
    assert.deepEqual(await applySprint(sprint, { yes: true, shown: 'x' }), { refused: 'no-copy' }, 'apply with ' + text);
  }
});

test('Sprint apply: an apply result that does not parse reads as unknown: the close view says so, the copy is kept, no second apply', { timeout: 60000 }, async (t) => {
  const { sprint } = await setup(t);
  fs.writeFileSync(path.join(sprint, 'apply-result.json'), '{"written": [');
  const close = await closeOf(sprint);
  assert.equal(close?.pending, true, 'unknown, not none');
  assert.match(close.lines[0], /^Unknown: the apply started and its result was not recorded/);
  assert.equal(close.copyKept, 'apply unknown: its result was not recorded', 'the copy is kept');
  assert.deepEqual(await applySprint(sprint, { yes: true, shown: 'x' }), { refused: 'already-applied' });
});

