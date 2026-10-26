import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile as diskRead, symlink, link, mkdir, chmod, unlink, readdir, rename, mkdtemp, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { readFile, guardedSave, createFile, hash, quietFfi } from '../packages/files/index.mjs';
import { open } from 'node:fs/promises';
import { fixture, externalEdit, daemon, authenticated, http } from './helpers.mjs';

test('initial unreadable target keeps a durable draft and returns API 403 without disk content', async (t) => {
  const instance = await daemon(t);
  const socketPath = path.join(instance.state, 'daemon.sock');
  const headers = { ...authenticated(instance.credentials), 'content-type': 'application/json' };
  const read = await http({ socketPath, headers, route: '/files?path=note.txt' });
  assert.equal(read.status, 200);
  const file = path.join(instance.workspace, 'note.txt');
  await chmod(file, 0);
  try {
    const response = await http({ socketPath, headers, route: '/files', method: 'PUT',
      body: JSON.stringify({ path: 'note.txt', hash: JSON.parse(read.text).hash, content: 'unreadable draft' }) });
    assert.equal(response.status, 403);
    const result = JSON.parse(response.text);
    assert.equal(result.kind, 'failed');
    assert.equal(result.content, 'unreadable draft');
    assert.equal(result.diskContent, undefined);
    const record = JSON.parse(await diskRead(path.join(instance.recovery, result.conflict), 'utf8'));
    assert.equal(record.content, 'unreadable draft');
    assert.equal(record.reason, 'save-failed');
    assert.equal(record.diskHash, undefined);
  } finally { await chmod(file, 0o600); }
  assert.equal(await diskRead(file, 'utf8'), 'original');
});

test('overlong UTF-8 path components return API 400 without a recovery record', async (t) => {
  const instance = await daemon(t);
  for (const relative of ['a'.repeat(256), 'é'.repeat(128)]) {
    const response = await http({ socketPath: path.join(instance.state, 'daemon.sock'), route: '/files', method: 'PUT',
      headers: { ...authenticated(instance.credentials), 'content-type': 'application/json' },
      body: JSON.stringify({ path: relative, hash: hash('original'), content: 'invalid path draft' }) });
    assert.equal(response.status, 400);
    assert.deepEqual(await readdir(instance.recovery), []);
  }
});

test('ancestor symlink replacement refuses GET and PUT without changing the redirected target', async (t) => {
  const instance = await daemon(t, undefined, true);
  const socketPath = path.join(instance.state, 'daemon.sock');
  const headers = { ...authenticated(instance.credentials), 'content-type': 'application/json' };
  const read = await http({ socketPath, headers, route: '/files?path=note.txt' });
  assert.equal(read.status, 200);
  const ancestor = path.dirname(instance.workspace);
  const outside = instance.directory + '-outside';
  const moved = ancestor + '-moved';
  await mkdir(path.join(outside, 'root'), { recursive: true });
  await writeFile(path.join(outside, 'root/note.txt'), 'original');
  // The API socket remains reachable through the moved directory, not the replacement.
  await rename(ancestor, moved);
  await symlink(outside, ancestor);
  try {
    const target = { socketPath, headers };
    const get = await http({ ...target, route: '/files?path=note.txt' });
    const put = await http({ ...target, route: '/files', method: 'PUT',
      body: JSON.stringify({ path: 'note.txt', hash: JSON.parse(read.text).hash, content: 'redirected draft' }) });
    assert.equal(get.status, 400, get.text);
    assert.equal(put.status, 409, put.text);
    assert.equal(JSON.parse(put.text).diskContent, undefined);
    assert.equal(await diskRead(path.join(outside, 'root/note.txt'), 'utf8'), 'original');
  } finally { await unlink(ancestor); await rename(moved, ancestor); }
});

test('pre-PUT target changes retain path-conflict records without exposing unsafe disk content', async (t) => {
  const instance = await daemon(t);
  const socketPath = path.join(instance.state, 'daemon.sock');
  const headers = { ...authenticated(instance.credentials), 'content-type': 'application/json' };
  for (const kind of ['symlink', 'binary', 'oversize', 'hardlink', 'parent-link', 'moved-root']) {
    const file = path.join(instance.workspace, 'note.txt');
    const read = await http({ socketPath, headers, route: '/files?path=note.txt' });
    assert.equal(read.status, 200);
    const expectedHash = JSON.parse(read.text).hash;
    const outside = path.join(instance.directory, 'outside');
    await writeFile(outside, 'outside sentinel');
    let relative = 'note.txt';
    if (kind === 'symlink') { await unlink(file); await symlink(outside, file); }
    if (kind === 'binary') await writeFile(file, Buffer.from([0, 255]));
    if (kind === 'oversize') await writeFile(file, Buffer.alloc(2 * 1024 * 1024 + 1));
    if (kind === 'hardlink') await link(file, file + '.link');
    if (kind === 'parent-link') { await symlink(instance.directory, path.join(instance.workspace, 'sub')); relative = 'sub/outside'; }
    if (kind === 'moved-root') await rename(instance.workspace, instance.workspace + '-moved');
    const response = await http({ socketPath, headers, route: '/files', method: 'PUT',
      body: JSON.stringify({ path: relative, hash: expectedHash, content: kind + ' draft' }) });
    assert.equal(response.status, 409, kind + ': ' + response.text);
    const result = JSON.parse(response.text);
    assert.equal(result.reason, 'path-conflict');
    assert.equal(result.diskContent, undefined);
    assert.equal(result.diskHash, undefined);
    const record = JSON.parse(await diskRead(path.join(instance.recovery, result.conflict), 'utf8'));
    assert.equal(record.path, relative);
    assert.equal(record.content, kind + ' draft');
    assert.equal(record.expectedHash, expectedHash);
    assert.equal(record.reason, 'path-conflict');
    assert.equal(record.diskHash, undefined);
    assert.equal(await diskRead(outside, 'utf8'), 'outside sentinel');
    if (kind === 'symlink') await unlink(file);
    if (kind === 'hardlink') await unlink(file + '.link');
    if (kind === 'parent-link') await unlink(path.join(instance.workspace, 'sub'));
    if (kind === 'moved-root') await rename(instance.workspace + '-moved', instance.workspace);
    await writeFile(file, 'original');
  }
  const before = await readdir(instance.recovery);
  for (const input of [
    { path: '.env', content: 'draft' }, { path: '../outside', content: 'draft' },
    { path: 'note.txt', content: '\ud800' }, { path: 'note.txt', content: '\0' },
    { path: '\ud800', content: 'draft' },
  ]) {
    const refused = await http({ socketPath, headers, route: '/files', method: 'PUT',
      body: JSON.stringify({ ...input, hash: hash('original') }) });
    assert.equal(refused.status, 400);
  }
  assert.deepEqual(await readdir(instance.recovery), before);
});

test('file boundary refuses traversal, links, case variants, binary and size; UTF-8 reads work', async () => {
  const { workspace, recovery } = await fixture();
  const original = await readFile(workspace, 'note.txt');
  assert.equal(original.content, 'original');
  assert.equal(original.hash, '0682c5f2076f099c34cfdd15a9e063849ed437a49677e6fcc5b4198c76575be5');
  for (const relative of ['../note.txt', '/etc/passwd', 'a/../note.txt', 'a\\b', 'a//b', 'a:', '.GiT/config',
    'SeCreTs/key', '.ENV.local', '_' + 'PrIvAtE/key', './note.txt', 'note.txt\0']) {
    await assert.rejects(readFile(workspace, relative));
    await assert.rejects(guardedSave(workspace, relative, original.hash, 'draft', recovery));
  }
  await symlink(path.join(workspace, 'note.txt'), path.join(workspace, 'sym.txt'));
  await assert.rejects(readFile(workspace, 'sym.txt'));
  assert.equal((await guardedSave(workspace, 'sym.txt', original.hash, 'draft', recovery)).reason, 'path-conflict');
  await link(path.join(workspace, 'note.txt'), path.join(workspace, 'hard.txt'));
  await assert.rejects(readFile(workspace, 'hard.txt'));
  assert.equal((await guardedSave(workspace, 'hard.txt', original.hash, 'draft', recovery)).reason, 'path-conflict');
  await mkdir(path.join(workspace, 'sub'));
  await symlink(path.join(workspace, 'sub'), path.join(workspace, 'dir-link'));
  await assert.rejects(readFile(workspace, 'dir-link/a'));
  assert.equal((await guardedSave(workspace, 'dir-link/a', original.hash, 'draft', recovery)).reason, 'path-conflict');
  for (const content of [Buffer.from([0, 1, 2]), Buffer.from([255]), Buffer.alloc(2 * 1024 * 1024 + 1, 65)]) {
    await writeFile(path.join(workspace, 'binary'), content);
    await assert.rejects(readFile(workspace, 'binary'));
    assert.equal((await guardedSave(workspace, 'binary', original.hash, 'draft', recovery)).reason, 'path-conflict');
  }
  await writeFile(path.join(workspace, 'unicode'), 'café');
  assert.equal((await readFile(workspace, 'unicode')).content, 'café');
  const before = await readdir(recovery);
  await assert.rejects(guardedSave(workspace, 'unicode', hash('café'), '\0', recovery));
  await assert.rejects(guardedSave(workspace, 'unicode', hash('café'), 'a'.repeat(2 * 1024 * 1024 + 1), recovery));
  for (const content of ['\ud800', '\udfff']) await assert.rejects(
    guardedSave(workspace, 'unicode', hash('café'), content, recovery), { message: 'invalid-save' });
  assert.deepEqual(await readdir(recovery), before, 'invalid content and malformed Unicode create no recovery data');
  console.log('PASS file validation: traversal, symlinks, hardlinks, locked case variants, binary, UTF-8 and 2 MiB limit');
});

test('API deletion before PUT retains a mapped path-conflict draft without recreating the target', async (t) => {
  const instance = await daemon(t);
  const socketPath = path.join(instance.state, 'daemon.sock');
  const headers = { ...authenticated(instance.credentials), 'content-type': 'application/json' };
  const read = await http({ socketPath, headers, route: '/files?path=note.txt' });
  const expectedHash = JSON.parse(read.text).hash;
  await unlink(path.join(instance.workspace, 'note.txt'));
  const response = await http({ socketPath, headers, route: '/files', method: 'PUT',
    body: JSON.stringify({ path: 'note.txt', hash: expectedHash, content: 'deleted target draft' }) });
  assert.equal(response.status, 409);
  const result = JSON.parse(response.text);
  assert.equal(result.reason, 'path-conflict');
  const record = JSON.parse(await diskRead(path.join(instance.recovery, result.conflict), 'utf8'));
  assert.equal(record.content, 'deleted target draft');
  assert.equal(record.path, 'note.txt');
  assert.equal(record.expectedHash, expectedHash);
  assert.equal(record.reason, 'path-conflict');
  assert.equal(record.diskHash, undefined);
  await assert.rejects(diskRead(path.join(instance.workspace, 'note.txt')), { code: 'ENOENT' });
  const before = await readdir(instance.recovery);
  for (const relative of ['.ENV/missing', '../missing', 'unsafe\\missing']) {
    const refused = await http({ socketPath, headers, route: '/files', method: 'PUT',
      body: JSON.stringify({ path: relative, hash: expectedHash, content: 'refused draft' }) });
    assert.equal(refused.status, 400, relative);
  }
  assert.deepEqual(await readdir(instance.recovery), before, 'unsafe paths create no drafts');
});

test('guarded save replaces unchanged files and preserves detected competing edits', async () => {
  for (const kind of ['write', 'replace']) {
    const { workspace, recovery } = await fixture();
    const file = path.join(workspace, 'note.txt');
    externalEdit(file, kind);
    const result = await guardedSave(workspace, 'note.txt', hash('original'), 'user draft', recovery);
    assert.equal(result.reason, 'hash-conflict');
    assert.equal(result.diskContent, 'competing');
    assert.equal(await diskRead(file, 'utf8'), 'competing');
    assert.equal(JSON.parse(await diskRead(path.join(recovery, result.conflict), 'utf8')).content, 'user draft');
  }
  const { workspace, recovery } = await fixture();
  const result = await guardedSave(workspace, 'note.txt', hash('original'), 'draft', recovery);
  assert.deepEqual(result, { kind: 'saved', hash: hash('draft') });
  assert.equal(await diskRead(path.join(workspace, 'note.txt'), 'utf8'), 'draft');
  await assert.rejects(guardedSave(workspace, 'note.txt', hash('draft'), 'draft', workspace));
  const file = path.join(workspace, 'note.txt');
  await writeFile(file + '.outside', 'outside');
  externalEdit(file, 'symlink');
  assert.equal((await guardedSave(workspace, 'note.txt', hash('original'), 'draft', recovery)).reason, 'path-conflict');
  assert.equal(await diskRead(file + '.outside', 'utf8'), 'outside');
  console.log('PASS normal atomic replacement and detected conflicts preserve actual disk/draft contents');
});

test('actual authenticated file API preserves draft on 409 and validates input', async (t) => {
  const instance = await daemon(t);
  const socketPath = path.join(instance.state, 'daemon.sock');
  const headers = { ...authenticated(instance.credentials), 'content-type': 'application/json' };
  await writeFile(path.join(instance.workspace, 'note.txt'), 'agent edit');
  const result = await http({ socketPath, headers, route: '/files', method: 'PUT',
    body: JSON.stringify({ path: 'note.txt', hash: hash('original'), content: 'API draft' }) });
  assert.equal(result.status, 409);
  const receipt = JSON.parse(result.text);
  assert.equal(receipt.reason, 'hash-conflict');
  assert.equal(receipt.diskContent, 'agent edit');
  assert.equal(receipt.content, 'API draft', 'caller can recover draft inline without a locked file route');
  assert.equal(JSON.parse(await diskRead(path.join(instance.recovery, receipt.conflict), 'utf8')).content, 'API draft');
  assert.equal(await diskRead(path.join(instance.workspace, 'note.txt'), 'utf8'), 'agent edit');
  const saved = await http({ socketPath, headers, route: '/files', method: 'PUT',
    body: JSON.stringify({ path: 'note.txt', hash: receipt.diskHash, content: 'resolved draft' }) });
  assert.equal(saved.status, 200);
  assert.equal(JSON.parse(saved.text).kind, 'saved');
  assert.equal(await diskRead(path.join(instance.workspace, 'note.txt'), 'utf8'), 'resolved draft');
  for (const body of ['{', '{}', JSON.stringify({ path: 'note.txt', hash: hash('original'), content: 'x', extra: true }),
    JSON.stringify({ path: 'note.txt', hash: hash('original'), content: '\ud800' })]) {
    assert.equal((await http({ socketPath, headers, route: '/files', method: 'PUT', body })).status, 400);
  }
  assert.equal((await http({ socketPath, headers, route: '/files?path=..%2Fnote.txt' })).status, 400);
  const errorLog = once(instance.child.stderr, 'data');
  assert.equal((await http({ socketPath, headers, route: '/files?path=missing.txt' })).status, 404);
  assert.deepEqual(JSON.parse(String((await errorLog)[0])), { event: 'P9_REQUEST_FAILED', code: 'ENOENT' });
  await chmod(instance.workspace, 0o500);
  try {
    const refused = await http({ socketPath, headers, route: '/files', method: 'PUT',
      body: JSON.stringify({ path: 'note.txt', hash: hash('resolved draft'), content: 'permission draft' }) });
    assert.equal(refused.status, 403);
    const failure = JSON.parse(refused.text);
    assert.equal(failure.kind, 'failed');
    assert.equal(JSON.parse(await diskRead(path.join(instance.recovery, failure.conflict), 'utf8')).content, 'permission draft');
    assert.equal(await diskRead(path.join(instance.workspace, 'note.txt'), 'utf8'), 'resolved draft');
  } finally { await chmod(instance.workspace, 0o700); }
});

test('the file listing shows folders and files, hides locked names, and refuses locked or escaping paths', async (t) => {
  const instance = await daemon(t), workspace = instance.workspace;
  const socketPath = path.join(instance.state, 'daemon.sock'), headers = authenticated(instance.credentials);
  await mkdir(path.join(workspace, 'docs')); await mkdir(path.join(workspace, '_private')); await writeFile(path.join(workspace, '.env'), 'x');
  const root = await http({ socketPath, headers, route: '/files/list?path=' });
  assert.equal(root.status, 200);
  const names = JSON.parse(root.text).entries.map((entry) => entry.name + (entry.dir ? '/' : ''));
  assert.ok(names.includes('docs/') && names.includes('note.txt'));
  assert.equal(names.some((name) => name.startsWith('_private') || name.startsWith('.env')), false);
  assert.equal((await http({ socketPath, headers, route: '/files/list?path=_private' })).status, 400);
  assert.equal((await http({ socketPath, headers, route: '/files/list?path=..' })).status, 400);
});

test('a failed new-file write never deletes a file another writer put at that name (Astra #5)', async () => {
  const { workspace } = await fixture();
  const target = path.join(workspace, 'idea.md');
  const handle = await open(path.join(workspace, 'note.txt'));
  const FileHandle = handle.constructor, original = FileHandle.prototype.writeFile;
  await handle.close();
  // Mid-write, another program renames its own file onto the name; then P9's write fails.
  FileHandle.prototype.writeFile = async function () {
    await writeFile(path.join(workspace, 'theirs.tmp'), 'theirs');
    await rename(path.join(workspace, 'theirs.tmp'), target);
    throw Object.assign(new Error('I/O'), { code: 'EIO' });
  };
  try { await assert.rejects(createFile(workspace, 'idea.md', 'mine'), { code: 'EIO' }); }
  finally { FileHandle.prototype.writeFile = original; }
  assert.equal(await diskRead(target, 'utf8'), 'theirs');
  assert.deepEqual((await readdir(workspace)).sort(), ['idea.md', 'note.txt']);
  // The normal path still creates once and refuses a repeat.
  assert.equal((await createFile(workspace, 'new.md', 'mine')).kind, 'created');
  assert.equal(await diskRead(path.join(workspace, 'new.md'), 'utf8'), 'mine');
  await assert.rejects(createFile(workspace, 'new.md', 'again'), { code: 'EEXIST' });
  assert.deepEqual((await readdir(workspace)).sort(), ['idea.md', 'new.md', 'note.txt']);
});

test('a recovery folder whose parent became a link elsewhere is refused, not written (Sol round 3 H2)', async () => {
  const { workspace } = await fixture();
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'p9-rec-')));
  const recovery = path.join(base, 'p9', 'recovery'), elsewhere = path.join(base, 'other', 'recovery');
  for (const folder of [recovery, elsewhere]) { await mkdir(folder, { recursive: true }); await chmod(folder, 0o700); }
  // After startup, another process swaps the recovery folder's parent for a link to another owner-only folder.
  await rename(path.join(base, 'p9'), path.join(base, 'p9-old'));
  await symlink(path.join(base, 'other'), path.join(base, 'p9'));
  await assert.rejects(guardedSave(workspace, 'note.txt', hash('original'), 'draft', recovery), /unsafe-recovery-directory/);
  assert.deepEqual(await readdir(elsewhere), []);
  assert.equal(await diskRead(path.join(workspace, 'note.txt'), 'utf8'), 'original');
});

test('W4: loading the Windows file guard drops only the FFI experimental warning, and only while it loads', async () => {
  const seen = [];
  const listener = (warning) => seen.push(warning.message);
  process.on('warning', listener);
  try {
    assert.equal(await quietFfi(async () => {
      process.emitWarning('FFI is an experimental feature and might change at any time', 'ExperimentalWarning');
      process.emitWarning('another warning', 'ExperimentalWarning');
      return 'loaded';
    }), 'loaded');
    process.emitWarning('FFI is an experimental feature (after loading)', 'ExperimentalWarning');
    await new Promise((resolve) => setImmediate(resolve));
  } finally { process.off('warning', listener); }
  assert.deepEqual(seen, ['another warning', 'FFI is an experimental feature (after loading)']);
});
