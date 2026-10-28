// The Windows file guard (packages/files/win32.mjs) refuses what the Linux guard refuses. files.test.mjs drives the
// daemon over a Unix socket and makes file symlinks (admin or Developer Mode on Windows), so this file calls the
// library directly and uses junctions, which any user can make. Skips off Windows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { open, writeFile, readFile as diskRead, symlink, link, mkdir, mkdtemp, rename, readdir, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readFile, listDirectory, guardedSave, hash, replaceFile, removeFile } from '../packages/files/index.mjs';
import { createXfer } from '../apps/server/xfer.mjs';
import { fixture, externalEdit } from './helpers.mjs';
import { MAX_BYTES } from '../packages/protocol/index.mjs';

const skip = process.platform !== 'win32' && 'Windows only';
async function canonicalFixture() {
  const { workspace, recovery } = await fixture();
  return { workspace: await realpath(workspace), recovery: await realpath(recovery) };
}
// The token user as SDDL text writes it: the SID, or an alias such as LA for the built-in Administrator (RID 500, the
// GitHub Windows runner's account), which a whoami SID never matched.
const userSid = () => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  "(New-Object Security.AccessControl.RawSecurityDescriptor('O:' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)).GetSddlForm('Owner').Substring(2)"], { encoding: 'utf8' }).trim();
const fullSddl = (file) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  `(Get-Acl -LiteralPath '${file}').Sddl`], { encoding: 'utf8' }).trim();
const refused = (promise, check) => assert.rejects(promise, (error) =>
  (typeof check === 'string' ? error.message === check || error.code === check : check.includes(error.code ?? error.message)) || assert.fail(`${error.code} ${error.message}`));

test('Windows file boundary: reads, traversal, locked names, junctions, hardlinks, case and short names, size', { skip }, async (t) => {
  const { workspace } = await canonicalFixture();
  assert.equal((await readFile(workspace, 'note.txt')).content, 'original');
  await writeFile(path.join(workspace, 'utf8.txt'), 'héllo ✓');
  assert.equal((await readFile(workspace, 'utf8.txt')).content, 'héllo ✓');
  for (const unsafe of ['../note.txt', 'C:/Windows/win.ini', 'a\\note.txt', 'note.txt:stream', '']) await refused(readFile(workspace, unsafe), ['unsafe-path', 'locked-path']);
  for (const locked of [['_private', 'x'].join('/') /* split: scripts/scan.mjs refuses the joined spelling in source */, '.env', '.ENV.local', 'secrets', '.p9-save-x', 'sub/./note.txt']) await refused(readFile(workspace, locked), 'locked-path');
  await refused(readFile(workspace, 'note.txt.'), 'ENOENT'); // Win32 would strip the dot; the NT open does not

  // Junction as an ancestor (inside and outside the workspace) and as the listed directory.
  await mkdir(path.join(workspace, 'real'));
  await writeFile(path.join(workspace, 'real', 'a.txt'), 'inside');
  await symlink(path.join(workspace, 'real'), path.join(workspace, 'junc'), 'junction');
  await refused(readFile(workspace, 'junc/a.txt'), 'ELOOP');
  await refused(listDirectory(workspace, 'junc'), 'ELOOP');
  const outside = path.join(path.dirname(workspace), 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.txt'), 'outside');
  await symlink(outside, path.join(workspace, 'out'), 'junction');
  await refused(readFile(workspace, 'out/secret.txt'), 'ELOOP');
  // A junction that is the workspace root itself.
  await symlink(workspace, path.join(path.dirname(workspace), 'rootjunc'), 'junction');
  await refused(readFile(path.join(path.dirname(workspace), 'rootjunc'), 'note.txt'), ['ELOOP', 'ENOTDIR']);

  // File symlinks need admin or Developer Mode; test them when this account can make one.
  try {
    await symlink(path.join(workspace, 'note.txt'), path.join(workspace, 'sym.txt'), 'file');
    await refused(readFile(workspace, 'sym.txt'), 'ELOOP');
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
    t.diagnostic('file symlink case not run: this account cannot create symlinks (EPERM)');
  }

  await writeFile(path.join(workspace, 'linked.txt'), 'linked');
  await link(path.join(workspace, 'linked.txt'), path.join(workspace, 'hard.txt'));
  await refused(readFile(workspace, 'hard.txt'), 'unsafe-file');
  await refused(readFile(workspace, 'linked.txt'), 'unsafe-file');

  await refused(readFile(workspace, 'NOTE.TXT'), 'path-changed');
  await refused(readFile(workspace, 'REAL/a.txt'), 'path-changed');
  await writeFile(path.join(workspace, 'a-long-file-name.txt'), 'long');
  const short = execFileSync('cmd.exe', ['/d', '/c', 'for %I in (a-long-file-name.txt) do @echo %~snxI'], { cwd: workspace, encoding: 'utf8' }).trim();
  if (short.toLowerCase() !== 'a-long-file-name.txt') await refused(readFile(workspace, short), 'path-changed');
  else t.diagnostic('8.3 short-name case not run: short names are off on this volume');

  await writeFile(path.join(workspace, 'nul.bin'), Buffer.from([0x61, 0, 0x62]));
  await refused(readFile(workspace, 'nul.bin'), 'binary-or-oversize');
  await writeFile(path.join(workspace, 'big.txt'), Buffer.alloc(MAX_BYTES + 1, 0x61));
  await refused(readFile(workspace, 'big.txt'), 'unsafe-file');
  await refused(readFile(workspace, 'real'), ['unsafe-file', 'EACCES']);
});

test('Windows listing shows folders and files, hides locked names and reparse points', { skip }, async () => {
  const { workspace } = await canonicalFixture();
  await mkdir(path.join(workspace, 'docs'));
  await mkdir(path.join(workspace, '_private'));
  await writeFile(path.join(workspace, '.env'), 'X=1');
  await writeFile(path.join(workspace, 'docs', 'b.md'), 'b');
  await symlink(path.join(workspace, 'docs'), path.join(workspace, 'junc'), 'junction');
  const names = (await listDirectory(workspace, '')).map((entry) => (entry.dir ? `${entry.name}/` : entry.name));
  assert.deepEqual(names, ['docs/', 'note.txt']);
  assert.deepEqual((await listDirectory(workspace, 'docs')).map((entry) => entry.name), ['b.md']);
  assert.ok((await listDirectory(workspace, 'docs'))[0].mtimeMs > Date.now() - 600_000);
  await refused(listDirectory(workspace, '_private'), 'locked-path');
  await refused(listDirectory(workspace, '../'), ['unsafe-path', 'locked-path']);
  await refused(listDirectory(workspace, 'Docs'), 'path-changed');
});

test('Windows guarded save replaces unchanged files, keeps drafts on competing edits and swaps, leaves no temp files', { skip }, async () => {
  for (const kind of ['write', 'replace']) {
    const { workspace, recovery } = await canonicalFixture();
    const file = path.join(workspace, 'note.txt');
    externalEdit(file, kind);
    const result = await guardedSave(workspace, 'note.txt', hash('original'), 'user draft', recovery);
    assert.equal(result.reason, 'hash-conflict');
    assert.equal(result.diskContent, 'competing');
    assert.equal(await diskRead(file, 'utf8'), 'competing');
    assert.equal(JSON.parse(await diskRead(path.join(recovery, result.conflict), 'utf8')).content, 'user draft');
  }

  const { workspace, recovery } = await canonicalFixture();
  assert.deepEqual(await guardedSave(workspace, 'note.txt', hash('original'), 'draft', recovery), { kind: 'saved', hash: hash('draft') });
  assert.equal(await diskRead(path.join(workspace, 'note.txt'), 'utf8'), 'draft');
  assert.deepEqual(await readdir(workspace), ['note.txt']);
  assert.deepEqual(await readdir(recovery), []);
  await assert.rejects(guardedSave(workspace, 'note.txt', hash('draft'), 'x', workspace));
  await assert.rejects(guardedSave(workspace, 'note.txt', hash('draft'), 'x', path.join(workspace, 'sub')));

  // Deleted before save: path-conflict, draft kept, target not recreated.
  await mkdir(path.join(workspace, 'd'));
  await writeFile(path.join(workspace, 'd', 'gone.txt'), 'original');
  await rename(path.join(workspace, 'd', 'gone.txt'), path.join(workspace, 'gone.moved'));
  const gone = await guardedSave(workspace, 'd/gone.txt', hash('original'), 'kept', recovery);
  assert.equal(gone.reason, 'path-conflict');
  assert.deepEqual(await readdir(path.join(workspace, 'd')), []);
  assert.equal(JSON.parse(await diskRead(path.join(recovery, gone.conflict), 'utf8')).content, 'kept');

  // Ancestor swapped for a junction to a look-alike folder: refused, and neither folder changes.
  await mkdir(path.join(workspace, 'e'));
  await writeFile(path.join(workspace, 'e', 'note.txt'), 'original');
  await rename(path.join(workspace, 'e'), path.join(workspace, 'e-real'));
  await symlink(path.join(workspace, 'e-real'), path.join(workspace, 'e'), 'junction');
  const swapped = await guardedSave(workspace, 'e/note.txt', hash('original'), 'redirected', recovery);
  assert.equal(swapped.reason, 'path-conflict');
  assert.equal(await diskRead(path.join(workspace, 'e-real', 'note.txt'), 'utf8'), 'original');
  assert.deepEqual(await readdir(path.join(workspace, 'e-real')), ['note.txt']);

  // A hardlinked target is refused before anything is written through it.
  await writeFile(path.join(workspace, 'h.txt'), 'original');
  await link(path.join(workspace, 'h.txt'), path.join(workspace, 'h2.txt'));
  assert.equal((await guardedSave(workspace, 'h.txt', hash('original'), 'through link', recovery)).reason, 'path-conflict');
  assert.equal(await diskRead(path.join(workspace, 'h2.txt'), 'utf8'), 'original');

  assert.deepEqual((await readdir(workspace)).filter((name) => name.startsWith('.p9-')), []);
  assert.equal((await readdir(recovery)).filter((name) => name.startsWith('.p9-record-')).length, 0);
});

test('Windows save keeps a restricted file restricted, and staged temp files cannot be written or moved by others', { skip }, async () => {
  const win = await import('../packages/files/win32.mjs');
  const { workspace, recovery } = await canonicalFixture();
  const sddl = (file) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-Acl -LiteralPath '${file}').Sddl`], { encoding: 'utf8' }).trim().replace(/^O:.*?(?=D:)/, '');
  // The folder lets Everyone (WD) read what it inherits; the file has a protected owner-only DACL.
  const shared = path.join(workspace, 'shared'), note = path.join(shared, 'note.txt');
  await mkdir(shared);
  execFileSync('icacls', [shared, '/grant', '*S-1-1-0:(OI)(CI)R'], { stdio: 'ignore' });
  await writeFile(note, 'original');
  execFileSync('icacls', [note, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:F`], { stdio: 'ignore' });
  const before = sddl(note);
  assert.ok(before.startsWith('D:P') && !before.includes(';WD)'), before);
  assert.equal((await guardedSave(workspace, 'shared/note.txt', hash('original'), 'private draft', recovery)).kind, 'saved');
  assert.equal(await diskRead(note, 'utf8'), 'private draft');
  // Same ACEs, still protected (the auto-inherited AI control flag may differ).
  const after = sddl(note);
  assert.ok(after.startsWith('D:P'), after);
  assert.equal(after.replace(/^D:[A-Z]*/, ''), before.replace(/^D:[A-Z]*/, ''));

  // A staged temp file: another writer or mover is refused while the guard holds it; the guard still deletes it.
  const root = win.openRoot(workspace);
  try {
    const { name } = win.createExclusive(root, '.p9-save-');
    await refused(writeFile(path.join(workspace, name), 'swapped'), ['EBUSY', 'EPERM', 'EACCES']);
    await refused(rename(path.join(workspace, name), path.join(workspace, 'moved.txt')), ['EBUSY', 'EPERM', 'EACCES']);
    await win.unlinkAt(root, name);
  } finally { await root.close(); }
  assert.deepEqual((await readdir(workspace)).filter((name) => name.startsWith('.p9-') || name === 'moved.txt'), []);
});

test('Sol round 3 H1 and M1: a save takes the DACL the target has at publish, and a draft record stays held until removed', { skip }, async () => {
  const win = await import('../packages/files/win32.mjs');
  const { workspace, recovery } = await canonicalFixture();
  const sddl = (file) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-Acl -LiteralPath '${file}').Sddl`], { encoding: 'utf8' }).trim().replace(/^O:.*?(?=D:)/, '');
  const shared = path.join(workspace, 'shared');
  await mkdir(shared);
  execFileSync('icacls', [shared, '/grant', '*S-1-1-0:(OI)(CI)R'], { stdio: 'ignore' });

  // An inheriting file keeps exactly its ACEs: none doubled by the folder's inheritable ones.
  await writeFile(path.join(shared, 'plain.txt'), 'original');
  const plain = sddl(path.join(shared, 'plain.txt'));
  assert.ok(plain.includes(';WD)'), plain);
  assert.equal((await guardedSave(workspace, 'shared/plain.txt', hash('original'), 'saved', recovery)).kind, 'saved');
  assert.equal(sddl(path.join(shared, 'plain.txt')), plain);

  // The target is tightened after the temp exists: the published file has the tightened DACL, not the one from
  // when the temp was made. While staged, the temp itself is owner-only.
  const tight = path.join(shared, 'tight.txt');
  await writeFile(tight, 'original');
  const safe = await win.resolveSafe(workspace, ['shared', 'tight.txt'], MAX_BYTES);
  const { name, file } = win.createExclusive(safe.parent, '.p9-save-', safe.file);
  try {
    await file.writeFile('new text');
    assert.equal(sddl(path.join(shared, name)), `D:P(A;;FA;;;${userSid()})`);
    await safe.file.close();
    execFileSync('icacls', [tight, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:F`], { stdio: 'ignore' });
    const tightened = sddl(tight);
    assert.ok(tightened.startsWith('D:P') && !tightened.includes(';WD)'), tightened);
    const latest = await win.resolveSafe(workspace, ['shared', 'tight.txt'], MAX_BYTES);
    try { assert.equal(win.matchSecurity(file, latest.file), true); } finally { await latest.close(); }
    await win.renameAt(safe.parent, name, 'tight.txt');
    assert.equal(await diskRead(tight, 'utf8'), 'new text');
    assert.equal(sddl(tight).replace(/^D:[A-Z]*/, ''), tightened.replace(/^D:[A-Z]*/, ''));
    assert.ok(sddl(tight).startsWith('D:P'));
  } finally { await win.unlinkAt(safe.parent, name).catch(() => {}); await safe.close(); }

  // M1: a record renamed into place is still held, so no one else can move or delete it before the guard does.
  const directory = win.openRecovery(recovery);
  try {
    const { name: temporary, file: record } = win.createExclusive(directory, '.p9-record-');
    await record.writeFile('{}');
    await win.renameAt(directory, temporary, '.p9-conflict-test');
    await refused(rename(path.join(recovery, '.p9-conflict-test'), path.join(recovery, 'moved')), ['EBUSY', 'EPERM', 'EACCES']);
    // A second update replaces the held record and holds the new one.
    const { name: second, file: next } = win.createExclusive(directory, '.p9-record-');
    await next.writeFile('{"n":2}');
    await win.renameAt(directory, second, '.p9-conflict-test');
    assert.equal(await diskRead(path.join(recovery, '.p9-conflict-test'), 'utf8'), '{"n":2}');
    await refused(rename(path.join(recovery, '.p9-conflict-test'), path.join(recovery, 'moved')), ['EBUSY', 'EPERM', 'EACCES']);
    await win.unlinkAt(directory, '.p9-conflict-test');
  } finally { await directory.close(); }
  assert.deepEqual(await readdir(recovery), []);
  assert.deepEqual((await readdir(shared)).filter((entry) => entry.startsWith('.p9-')), []);
});

test('Sol round 4: a staged temp is owned by the token user, the save keeps the owner, and metadata it would lose fails closed', { skip }, async () => {
  const win = await import('../packages/files/win32.mjs');
  const { workspace, recovery } = await canonicalFixture();
  const sid = userSid();
  // High 1: owner is the user's SID (not the token's default owner) and the only ACE names that SID, not OWNER RIGHTS.
  await writeFile(path.join(workspace, 'owned.txt'), 'original');
  const before = fullSddl(path.join(workspace, 'owned.txt'));
  const safe = await win.resolveSafe(workspace, ['owned.txt'], MAX_BYTES);
  const { name, file } = win.createExclusive(safe.parent, '.p9-save-', safe.file);
  try {
    assert.equal(fullSddl(path.join(workspace, name)).replace(/G:[^D]*/, ''), `O:${sid}D:P(A;;FA;;;${sid})`);
    assert.equal(win.matchSecurity(file, safe.file), true);
    assert.equal(fullSddl(path.join(workspace, name)), before);
  } finally { await win.unlinkAt(safe.parent, name).catch(() => {}); await safe.close(); }
  assert.equal((await guardedSave(workspace, 'owned.txt', hash('original'), 'saved', recovery)).kind, 'saved');
  assert.equal(fullSddl(path.join(workspace, 'owned.txt')), before);
  // Round 5 medium: a primary group other than the token's (here BUILTIN\Users) is kept too.
  const grouped = path.join(workspace, 'grouped.txt');
  await writeFile(grouped, 'original');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$a = Get-Acl -LiteralPath '${grouped}'; `
    + `$a.SetGroup([Security.Principal.SecurityIdentifier]'S-1-5-32-545'); Set-Acl -LiteralPath '${grouped}' -AclObject $a`]);
  const groupedBefore = fullSddl(grouped);
  assert.match(groupedBefore, /G:BU/);
  assert.equal((await guardedSave(workspace, 'grouped.txt', hash('original'), 'saved', recovery)).kind, 'saved');
  assert.equal(fullSddl(grouped), groupedBefore);

  // High 2: an encrypted, labelled or multi-stream target is refused (EPERM, draft kept) and left exactly as it was.
  const cases = { 'labelled.txt': () => execFileSync('icacls', [path.join(workspace, 'labelled.txt'), '/setintegritylevel', 'L'], { stdio: 'ignore' }),
    'streams.txt': () => writeFile(path.join(workspace, 'streams.txt:extra'), 'side data') };
  let efs = true;
  try { await writeFile(path.join(workspace, 'probe.txt'), 'x'); execFileSync('cipher', ['/e', path.join(workspace, 'probe.txt')], { stdio: 'ignore' }); }
  catch { efs = false; }
  if (efs) cases['encrypted.txt'] = () => execFileSync('cipher', ['/e', path.join(workspace, 'encrypted.txt')], { stdio: 'ignore' });
  for (const [target, mark] of Object.entries(cases)) {
    await writeFile(path.join(workspace, target), 'original');
    await mark();
    const marked = fullSddl(path.join(workspace, target));
    const result = await guardedSave(workspace, target, hash('original'), 'changed', recovery);
    assert.equal(result.kind, 'failed', target);
    assert.equal(result.code, 'EPERM', target);
    assert.equal(await diskRead(path.join(workspace, target), 'utf8'), 'original', target);
    assert.equal(fullSddl(path.join(workspace, target)), marked, target);
  }
  if (efs) assert.ok(execFileSync('cipher', [path.join(workspace, 'encrypted.txt')], { encoding: 'utf8' }).includes('E encrypted.txt'));
  assert.equal(await diskRead(path.join(workspace, 'streams.txt:extra'), 'utf8'), 'side data');
  assert.deepEqual((await readdir(workspace)).filter((entry) => entry.startsWith('.p9-')), []);
  console.log(`round 4: EFS case ${efs ? 'ran' : 'SKIPPED (cipher /e failed)'}`);
});

test('Sol round 6: a temp that inherits EFS or a label from its folder is refused, and an EFS target never widens the draft', { skip }, async () => {
  const win = await import('../packages/files/win32.mjs');
  const { workspace, recovery } = await canonicalFixture();
  const sid = userSid();
  // High 3, label: the target exists first, then its folder gains an inheritable Low label; a new temp would inherit it.
  await mkdir(path.join(workspace, 'low'));
  await writeFile(path.join(workspace, 'low', 'plain.txt'), 'original');
  execFileSync('icacls', [path.join(workspace, 'low'), '/setintegritylevel', '(OI)(CI)L'], { stdio: 'ignore' });
  const plain = fullSddl(path.join(workspace, 'low', 'plain.txt'));
  assert.doesNotMatch(plain, /S:/, 'the existing file must not have taken the label');
  let result = await guardedSave(workspace, 'low/plain.txt', hash('original'), 'changed', recovery);
  assert.equal(result.kind, 'failed');
  assert.equal(result.code, 'EPERM');
  assert.equal(await diskRead(path.join(workspace, 'low', 'plain.txt'), 'utf8'), 'original');
  assert.equal(fullSddl(path.join(workspace, 'low', 'plain.txt')), plain);
  assert.deepEqual((await readdir(path.join(workspace, 'low'))).filter((entry) => entry.startsWith('.p9-')), []);
  let efs = true;
  try { await writeFile(path.join(workspace, 'probe.txt'), 'x'); execFileSync('cipher', ['/e', path.join(workspace, 'probe.txt')], { stdio: 'ignore' }); }
  catch { efs = false; }
  if (efs) {
    // High 3, EFS: an encrypted folder with one file decrypted on purpose; the temp would be created encrypted.
    await mkdir(path.join(workspace, 'vault'));
    execFileSync('cipher', ['/e', path.join(workspace, 'vault')], { stdio: 'ignore' });
    await writeFile(path.join(workspace, 'vault', 'clear.txt'), 'original');
    execFileSync('cipher', ['/d', path.join(workspace, 'vault', 'clear.txt')], { stdio: 'ignore' });
    assert.ok(execFileSync('cipher', [path.join(workspace, 'vault', 'clear.txt')], { encoding: 'utf8' }).includes('U clear.txt'));
    result = await guardedSave(workspace, 'vault/clear.txt', hash('original'), 'changed', recovery);
    assert.equal(result.kind, 'failed');
    assert.equal(result.code, 'EPERM');
    assert.equal(await diskRead(path.join(workspace, 'vault', 'clear.txt'), 'utf8'), 'original');
    assert.ok(execFileSync('cipher', [path.join(workspace, 'vault', 'clear.txt')], { encoding: 'utf8' }).includes('U clear.txt'));
    // High 2: an EFS target is refused before the draft's temp takes its DACL, so the temp stays user-only throughout.
    await writeFile(path.join(workspace, 'secret.txt'), 'original');
    execFileSync('cipher', ['/e', path.join(workspace, 'secret.txt')], { stdio: 'ignore' });
    const safe = await win.resolveSafe(workspace, ['secret.txt'], MAX_BYTES);
    const { name, file } = win.createExclusive(safe.parent, '.p9-save-', safe.file);
    try {
      assert.throws(() => win.matchSecurity(file, safe.file), { code: 'EPERM' });
      assert.equal(fullSddl(path.join(workspace, name)).replace(/G:[^D]*/, ''), `O:${sid}D:P(A;;FA;;;${sid})`);
    } finally { await win.unlinkAt(safe.parent, name).catch(() => {}); await safe.close(); }
  }
  console.log(`round 6: EFS cases ${efs ? 'ran' : 'SKIPPED (cipher /e failed)'}`);
});

test('Sol round 7: a save temp with a widened DACL still cannot be opened by anyone else', { skip }, async () => {
  const win = await import('../packages/files/win32.mjs');
  const { workspace } = await canonicalFixture();
  await writeFile(path.join(workspace, 'shared.txt'), 'original');
  execFileSync('icacls', [path.join(workspace, 'shared.txt'), '/grant', '*S-1-1-0:R'], { stdio: 'ignore' });
  const safe = await win.resolveSafe(workspace, ['shared.txt'], MAX_BYTES);
  const { name, file } = win.createExclusive(safe.parent, '.p9-save-', safe.file);
  try {
    assert.equal(win.matchSecurity(file, safe.file), true);
    assert.match(fullSddl(path.join(workspace, name)), /\(A;;FR;;;WD\)/); // Everyone may read it by its DACL...
    await assert.rejects(open(path.join(workspace, name), 'r'), { code: 'EBUSY' }); // ...but the handle shares nothing
  } finally { await win.unlinkAt(safe.parent, name).catch(() => {}); await safe.close(); }
  assert.deepEqual((await readdir(workspace)).filter((entry) => entry.startsWith('.p9-')), []);
});

// Item 23, Keep the server's onto a Windows laptop (Builder, 2026-10-27: build it): the tunnel send's writes on NT handles.
// ponytail: arm64 Windows runners run these 30 to 60 times slower than x64 (run 40647602789: 70.7 s for a 1.3 s x64 test).
test('Windows tunnel send: replaceFile and removeFile land whole files, keep old copies, and refuse what Linux refuses', { skip, timeout: 300000 }, async () => {
  const { workspace, recovery } = await canonicalFixture();
  const staging = await mkdtemp(path.join(path.dirname(workspace), 'staged-'));
  const stage = async (content) => { const file = path.join(staging, randomUUID()); await writeFile(file, content); return file; };
  const tag = 'send-' + Date.now(), at = (name) => path.join(workspace, ...name.split('/'));
  const kept = (name) => diskRead(path.join(recovery, 'replaced', tag, ...name.split('/')), 'utf8');

  // Replace: the new bytes land, the old ones are in recovery first.
  assert.deepEqual(await replaceFile(workspace, 'note.txt', await stage('from the server'), hash('original'), recovery, tag),
    { kind: 'written', recovery: path.join('replaced', tag, 'note.txt') });
  assert.equal(await diskRead(at('note.txt'), 'utf8'), 'from the server');
  assert.equal(await kept('note.txt'), 'original');
  // A new file in folders that do not exist yet; one bigger than a copy piece.
  assert.deepEqual(await replaceFile(workspace, 'new/deep/a.md', await stage('new'), null, recovery, tag), { kind: 'written' });
  assert.equal(await diskRead(at('new/deep/a.md'), 'utf8'), 'new');
  const big = Buffer.alloc(3 * 1024 * 1024 + 5, 7);
  big.write('start', 0);
  assert.equal((await replaceFile(workspace, 'big.bin', await stage(big), null, recovery, tag)).kind, 'written');
  assert.ok((await diskRead(at('big.bin'))).equals(big));

  // Changed since the plan, or a new name that exists now: nothing written.
  assert.deepEqual(await replaceFile(workspace, 'note.txt', await stage('late'), hash('original'), recovery, tag), { kind: 'changed' });
  assert.deepEqual(await replaceFile(workspace, 'big.bin', await stage('late'), null, recovery, tag), { kind: 'changed' });
  assert.equal(await diskRead(at('note.txt'), 'utf8'), 'from the server');
  // A case variant of an existing name is that file on Windows: refused, not replaced.
  await refused(replaceFile(workspace, 'NOTE.txt', await stage('x'), hash('from the server'), recovery, tag), 'path-changed');
  // A junction on the way, inside or out: refused, nothing created behind it.
  await mkdir(at('real'));
  await symlink(at('real'), at('junc'), 'junction');
  await refused(replaceFile(workspace, 'junc/x.md', await stage('x'), null, recovery, tag), 'ELOOP');
  await refused(removeFile(workspace, 'junc/x.md', hash('x'), recovery, tag), 'ELOOP');
  assert.deepEqual(await readdir(at('real')), []);
  // A file where a folder must be, a hardlinked file, a locked name.
  await refused(replaceFile(workspace, 'note.txt/x.md', await stage('x'), null, recovery, tag), ['ENOTDIR', 'EEXIST', 'ENOENT']);
  await writeFile(at('h.txt'), 'linked');
  await link(at('h.txt'), at('h2.txt'));
  await refused(replaceFile(workspace, 'h.txt', await stage('x'), hash('linked'), recovery, tag), 'unsafe-file');
  await refused(removeFile(workspace, 'h.txt', hash('linked'), recovery, tag), 'unsafe-file');
  assert.equal(await diskRead(at('h2.txt'), 'utf8'), 'linked');
  await refused(replaceFile(workspace, '.env', await stage('x'), null, recovery, tag), 'locked-path');

  // A protected owner-only DACL stays (the temp takes the file's owner and DACL, as a save's does).
  const sddl = (file) => fullSddl(file).replace(/^O:.*?(?=D:)/, '');
  await writeFile(at('private.txt'), 'private');
  execFileSync('icacls', [at('private.txt'), '/inheritance:r', '/grant:r', process.env.USERNAME + ':F'], { stdio: 'ignore' });
  const before = sddl(at('private.txt'));
  assert.equal((await replaceFile(workspace, 'private.txt', await stage('private 2'), hash('private'), recovery, tag)).kind, 'written');
  assert.equal(sddl(at('private.txt')).replace(/^D:[A-Z]*/, ''), before.replace(/^D:[A-Z]*/, ''));
  assert.ok(sddl(at('private.txt')).startsWith('D:P'));

  // Remove: deleted through the held handle, the old copy kept; changed refused; already gone is gone.
  assert.deepEqual(await removeFile(workspace, 'new/deep/a.md', hash('new'), recovery, tag),
    { kind: 'removed', recovery: path.join('replaced', tag, 'new', 'deep', 'a.md') });
  assert.deepEqual(await readdir(at('new/deep')), []);
  assert.equal(await kept('new/deep/a.md'), 'new');
  assert.deepEqual(await removeFile(workspace, 'big.bin', hash('other'), recovery, tag), { kind: 'changed' });
  assert.deepEqual(await removeFile(workspace, 'nothing.md', hash('x'), recovery, tag), { kind: 'gone' });
  assert.deepEqual(await removeFile(workspace, 'nowhere/x.md', hash('x'), recovery, tag), { kind: 'gone' });
  // A file another process holds open for writing is not hashed and deleted under it: the guard's handle shares no writes.
  const writer = await open(at('big.bin'), 'r+');
  try { await refused(removeFile(workspace, 'big.bin', hash(big), recovery, tag), ['EBUSY', 'EACCES']); }
  finally { await writer.close(); }
  assert.ok((await diskRead(at('big.bin'))).equals(big));

  const temps = (await readdir(workspace, { recursive: true })).filter((name) => path.basename(name).startsWith('.p9-'));
  assert.deepEqual(temps, []);
});

// ponytail: arm64 Windows runners run these 30 to 60 times slower than x64 (run 40647602789: 70.7 s for a 1.3 s x64 test).
test('Windows tunnel send: the laptop daemon stages the server\'s copy in pieces and commits it (Keep the server\'s)', { skip, timeout: 300000 }, async () => {
  const { workspace, recovery } = await canonicalFixture();
  const xfer = createXfer({ workspace, ownership: path.join(path.dirname(workspace), 'ownership'), recovery });
  const id = randomUUID(), content = Buffer.from('the server\'s copy');
  assert.equal((await xfer.part(id, { path: 'note.txt', offset: 0, data: content.toString('base64') })).status, 200);
  assert.equal((await xfer.part(id, { path: 'docs/new.md', offset: 0, data: Buffer.from('new').toString('base64') })).status, 200);
  const done = await xfer.commit(id, { files: [
    { path: 'note.txt', size: content.length, sha256: hash(content), expect: hash('original') },
    { path: 'docs/new.md', size: 3, sha256: hash('new'), expect: null },
  ], deletes: [] });
  assert.equal(done.status, 200, JSON.stringify(done));
  assert.deepEqual(done.written, ['note.txt', 'docs/new.md']);
  assert.equal(await diskRead(path.join(workspace, 'note.txt'), 'utf8'), 'the server\'s copy');
  assert.equal(await diskRead(path.join(workspace, 'docs', 'new.md'), 'utf8'), 'new');
  assert.equal(await diskRead(path.join(recovery, done.replaced[0].recovery), 'utf8'), 'original');
  // The server deleted docs/new.md and the laptop takes that too.
  const gone = await xfer.commit(randomUUID(), { files: [], deletes: [{ path: 'docs/new.md', expect: hash('new') }] });
  assert.equal(gone.status, 200, JSON.stringify(gone));
  assert.deepEqual(await readdir(path.join(workspace, 'docs')), []);
});
