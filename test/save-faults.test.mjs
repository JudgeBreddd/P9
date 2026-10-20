import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, readdir, writeFile, stat, chmod } from 'node:fs/promises';
import path from 'node:path';
import { guardedSave, hash } from '../packages/files/index.mjs';
import { fixture, root } from './helpers.mjs';

test('initial target I/O and descriptor errors retain recovery with API 500 or 507', async () => {
  // Expected failures keep their own code (busy, read-only disk); anything unlisted becomes INTERNAL_FAILURE.
  for (const [code, status, reported] of [['EIO', 500, 'EIO'], ['EMFILE', 500, 'INTERNAL_FAILURE'], ['ENOSPC', 507, 'ENOSPC'],
    ['EBUSY', 503, 'EBUSY'], ['EROFS', 403, 'EROFS']]) {
    const { workspace, recovery } = await fixture();
    const child = spawnSync(process.execPath, ['test/save-worker.mjs', workspace, recovery, 'initial-' + code],
      { cwd: root, encoding: 'utf8', timeout: 5000 });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.status, status);
    assert.equal(result.body.kind, 'failed');
    assert.equal(result.body.code, reported);
    assert.equal(result.body.content, 'user draft');
    assert.equal(result.body.diskContent, undefined);
    const record = JSON.parse(await readFile(path.join(recovery, result.body.conflict), 'utf8'));
    assert.equal(record.content, 'user draft');
    assert.equal(record.reason, 'save-failed');
    assert.equal(record.diskHash, undefined);
    assert.equal(await readFile(path.join(workspace, 'note.txt'), 'utf8'), 'original');
  }
});

test('simultaneous P9 saves serialize: one succeeds, the other preserves its draft', async () => {
  const { workspace, recovery } = await fixture();
  const file = path.join(workspace, 'note.txt');
  await chmod(file, 0o640);
  const results = await Promise.all(['first', 'second'].map((content) =>
    guardedSave(workspace, 'note.txt', hash('original'), content, recovery)));
  assert.equal(results[0].kind, 'saved');
  assert.equal(results[1].kind, 'conflict');
  assert.equal(await readFile(file, 'utf8'), 'first');
  assert.equal(JSON.parse(await readFile(path.join(recovery, results[1].conflict), 'utf8')).content, 'second');
  assert.equal((await stat(file)).mode & 0o777, 0o640);
  assert.deepEqual(await readdir(workspace), ['note.txt']);
});

test('killed saves are identifiable from recovery metadata alone; completed orphans differ from conflicts', async () => {
  for (const fault of ['death-open', 'death-after-rename', 'cleanup-unlink', 'edit-write']) {
    const { workspace, recovery } = await fixture();
    const child = spawnSync(process.execPath, ['test/save-worker.mjs', workspace, recovery, fault], { cwd: root, encoding: 'utf8', timeout: 5000 });
    assert.equal(child.signal, fault.startsWith('death-') ? 'SIGKILL' : null, child.stderr);
    if (!fault.startsWith('death-')) assert.equal(child.status, 0, child.stderr);
    const names = await readdir(recovery);
    assert.equal(names.length, 1);
    const record = JSON.parse(await readFile(path.join(recovery, names[0]), 'utf8'));
    assert.equal(record.workspace, workspace);
    assert.equal(record.path, 'note.txt');
    assert.equal(record.expectedHash, hash('original'));
    assert.equal(record.draftHash, hash('user draft'));
    assert.equal(record.diskHash, hash(fault === 'edit-write' ? 'competing' : 'original'));
    assert.equal(record.content, 'user draft');
    assert.ok(Number.isFinite(Date.parse(record.createdAt)));
    assert.equal(record.reason, fault === 'edit-write' ? 'hash-conflict' : fault === 'cleanup-unlink' ? 'saved' : 'save-pending');
    if (fault === 'death-after-rename') assert.equal(hash(await readFile(path.join(workspace, record.path))), record.draftHash);
  }
});

test('draft cleanup failure after synced replacement reports saved with retained draft', async () => {
  const { workspace, recovery } = await fixture();
  const child = spawnSync(process.execPath, ['test/save-worker.mjs', workspace, recovery, 'cleanup-unlink'], { cwd: root, encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.deepEqual(child.stderr.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)), [{ event: 'P9_DRAFT_RETAINED' }]);
  assert.equal(result.kind, 'saved');
  assert.equal(result.hash, hash('user draft'));
  assert.equal(result.draftRetained, true);
  assert.equal(result.reason, undefined);
  assert.equal(await readFile(path.join(workspace, 'note.txt'), 'utf8'), 'user draft');
  assert.equal(JSON.parse(await readFile(path.join(recovery, result.conflict), 'utf8')).reason, 'saved');
});

test('actual shared full filesystem returns API 507 with original intact and no claimed draft', async () => {
  const { workspace, recovery } = await fixture();
  const child = spawnSync('unshare', ['--user', '--map-root-user', '--mount', '--', process.execPath,
    'test/save-worker.mjs', workspace, recovery, 'real-full-shared'], { cwd: root, encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.sameFilesystem, true);
  assert.equal(result.status, 507);
  assert.deepEqual(result.body, { error: 'storage-unavailable' });
  assert.equal(result.diskContent, 'original');
  assert.deepEqual(result.recoveryFiles, []);
  console.log('PASS actual shared ENOSPC: private 1 MiB tmpfs, API 507, original intact, no recovery draft claimed');
});

test('separate-process races, injected ENOSPC and actual SIGKILL preserve complete files and drafts', async () => {
  const receipts = [];
  for (const fault of ['edit-write', 'edit-replace', 'edit-symlink', 'full-write', 'full-sync', 'full-rename', 'directory-sync',
    'death-open', 'death-synced', 'death-before-rename', 'death-after-rename', 'late-edit']) {
    const { workspace, recovery } = await fixture();
    const file = path.join(workspace, 'note.txt');
    await writeFile(file + '.outside', 'outside');
    const child = spawnSync(process.execPath, ['test/save-worker.mjs', workspace, recovery, fault], { cwd: root, encoding: 'utf8', timeout: 5000 });
    const killed = fault.startsWith('death-');
    assert.equal(child.error, undefined);
    assert.equal(child.signal, killed ? 'SIGKILL' : null, child.stderr);
    if (!killed) assert.equal(child.status, 0, child.stderr);
    const result = killed ? null : JSON.parse(child.stdout);
    const expected = fault === 'edit-symlink' ? 'outside' : fault.startsWith('edit-') ? 'competing'
      : ['death-after-rename', 'late-edit', 'directory-sync'].includes(fault) ? 'user draft' : 'original';
    assert.equal(await readFile(file, 'utf8'), expected, fault);
    assert.equal(await readFile(file + '.outside', 'utf8'), 'outside', fault);
    const drafts = await readdir(recovery);
    if (fault === 'late-edit') {
      assert.equal(result.kind, 'saved');
      assert.deepEqual(drafts, []);
    } else {
      assert.equal(drafts.length, 1, fault);
      assert.equal(JSON.parse(await readFile(path.join(recovery, drafts[0]), 'utf8')).content, 'user draft', fault);
      if (fault.startsWith('edit-')) assert.equal(result.kind, 'conflict');
      if (fault.startsWith('full-')) {
        assert.equal(result.kind, 'failed');
        assert.equal(result.code, 'ENOSPC');
      }
      if (fault === 'directory-sync') {
        assert.equal(result.kind, 'failed');
        assert.equal(result.reason, 'durability-uncertain');
        assert.equal(result.code, 'EIO');
      }
    }
    receipts.push({ fault, signal: child.signal, result: result?.kind, disk: expected, durableDrafts: drafts.length });
  }
  console.log('PASS save fault receipts: ' + JSON.stringify(receipts));
});

test('new hardlinks and deleted targets become path conflicts with recoverable drafts', async () => {
  for (const fault of ['edit-hardlink', 'edit-delete']) {
    const { workspace, recovery } = await fixture();
    const child = spawnSync(process.execPath, ['test/save-worker.mjs', workspace, recovery, fault], { cwd: root, encoding: 'utf8', timeout: 5000 });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.kind, 'conflict');
    assert.equal(result.reason, 'path-conflict');
    assert.equal(JSON.parse(await readFile(path.join(recovery, result.conflict), 'utf8')).content, 'user draft');
    if (fault === 'edit-hardlink') assert.equal(await readFile(path.join(workspace, 'note.txt.link'), 'utf8'), 'original');
    else await assert.rejects(readFile(path.join(workspace, 'note.txt')), { code: 'ENOENT' });
  }
});

test('actual full isolated filesystem refuses replacement and retains draft on separate storage', async () => {
  const { workspace, recovery } = await fixture();
  const child = spawnSync('unshare', ['--user', '--map-root-user', '--mount', '--', process.execPath,
    'test/save-worker.mjs', workspace, recovery, 'real-full'], { cwd: root, encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.kind, 'failed');
  assert.equal(result.code, 'ENOSPC');
  assert.equal(result.diskContent, 'original');
  assert.equal(JSON.parse(await readFile(path.join(recovery, result.conflict), 'utf8')).content, 'x'.repeat(256 * 1024));
  console.log('PASS actual separate-storage ENOSPC: private 1 MiB tmpfs, original intact, complete 256 KiB draft retained; shared-storage case claims no draft');
});

test('moving the parent outside the workspace is detected before replacement', async () => {
  const { workspace, recovery } = await fixture();
  const child = spawnSync(process.execPath, ['test/save-worker.mjs', workspace, recovery, 'move-parent'],
    { cwd: root, encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.kind, 'conflict');
  assert.equal(result.reason, 'path-conflict');
  assert.equal(await readFile(path.join(workspace + '-moved', 'note.txt'), 'utf8'), 'original');
  assert.deepEqual(await readdir(workspace + '-moved'), ['note.txt']);
  assert.equal(JSON.parse(await readFile(path.join(recovery, result.conflict), 'utf8')).content, 'user draft');
});
