// A sprint from a folder with no remote (SECURITY.md § Sprint from a folder with no remote; sprint spec daemon-3).
// copyTracked: git's index, as on disk now, into a new repository with one commit and no origin.
// applyCopy: the change from the copy's baseline to its pinned main line onto the owner's folder, only on the owner's yes,
// through packages/files (the only module that writes workspace files): check, backup, stage, temp, rename, guarded
// rollback, three lists. The bytes applied are the commit's blobs, staged in P9's record folder before the first write.
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { hash, isGuarded, openSafe, protection, replaceFile, removeFile } from '../../packages/files/index.mjs';
import { git } from './worker-folders.mjs';

const AUTHOR = ['-c', 'user.name=P9', '-c', 'user.email=p9@localhost'];
const MODE_FILE = new Set(['100644', '100755']);
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

// Regular file bytes at rel, opened through held directory handles (packages/files openSafe): no link on the way or at the
// name is followed, and a path that changes during the open is refused. before(rel) runs just before the open (a test seam).
// kind: 'file' | 'absent' | 'link' (a link on the way or at the name) | 'not-regular' | 'unreadable'.
async function readAt(root, rel, before) {
  await before?.(rel);
  let opened;
  try { opened = await openSafe(root, rel); } catch (error) {
    if (error.code === 'ENOENT') return { kind: 'absent' };
    if (error.code === 'ELOOP' || error.code === 'ENOTDIR' || error.message === 'path-changed') return { kind: 'link' };
    if (error.message === 'unsafe-file') return { kind: 'not-regular' };
    return { kind: 'unreadable' };
  }
  try { return { kind: 'file', bytes: await opened.file.readFile() }; }
  catch { return { kind: 'unreadable' }; }
  finally { await opened.close(); }
}

// The owner's folder state at one path: null when absent, a hash when a plain file, 'link' for anything else on the way.
async function stateOf(folder, rel) {
  const r = await readAt(folder, rel);
  if (r.kind === 'absent') return null;
  return r.kind === 'file' ? hash(r.bytes) : 'link';
}

// A new file with the given bytes, never over an existing one or through a link.
async function writeNew(to, bytes, mode = 0o600) {
  await mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
  const file = await open(to, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, mode);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}

// One blob's bytes from the copy's object store. The commit fixes the blob id, so no worktree file is read to apply.
const blobOf = (copy, id) => new Promise((resolve, reject) => execFile('git', ['-C', copy, 'cat-file', 'blob', id],
  { encoding: 'buffer', maxBuffer: Infinity, timeout: 60_000, windowsHide: true },
  (error, out) => (error ? reject(error) : resolve(out))));

// Git's index for folder: regular files are copied. Links, submodules, deleted files, and untracked or ignored files are
// named with their reason, never read; the names only, as SECURITY.md says. beforeRead(rel) is a test seam.
export async function copyTracked(folder, dest, { beforeRead } = {}) {
  const listed = await git(folder, ['ls-files', '-s', '-z']);
  if (listed.code !== 0) return { error: 'not-a-repository' };
  const untracked = await git(folder, ['ls-files', '-o', '-z', '--exclude-standard']);
  const ignored = await git(folder, ['ls-files', '-o', '-i', '-z', '--exclude-standard']);
  if (untracked.code !== 0 || ignored.code !== 0) return { error: 'unreadable-index' };
  await mkdir(dest, { mode: 0o700 });
  const paths = {}, left = [];
  for (const name of untracked.out.split('\0').filter(Boolean)) left.push({ path: name, reason: 'untracked' });
  for (const name of ignored.out.split('\0').filter(Boolean)) left.push({ path: name, reason: 'ignored-untracked' });
  for (const record of listed.out.split('\0').filter(Boolean)) {
    const m = /^(\d+) [0-9a-f]+ \d+\t([\s\S]*)$/.exec(record);
    if (!m) return { error: 'unreadable-index' };
    const [, mode, rel] = m;
    if (mode === '120000') { left.push({ path: rel, reason: 'link' }); continue; }
    if (mode === '160000') { left.push({ path: rel, reason: 'submodule' }); continue; }
    if (!MODE_FILE.has(mode)) { left.push({ path: rel, reason: 'not-regular' }); continue; }
    const r = await readAt(folder, rel, beforeRead);
    if (r.kind === 'absent') { left.push({ path: rel, reason: 'deleted' }); continue; }
    if (r.kind === 'link') { left.push({ path: rel, reason: 'link-on-path' }); continue; }
    if (r.kind !== 'file') { left.push({ path: rel, reason: r.kind === 'unreadable' ? 'unreadable' : 'not-regular' }); continue; }
    await writeNew(path.join(dest, rel), r.bytes, mode === '100755' ? 0o700 : 0o600);
    paths[rel] = hash(r.bytes);
  }
  if ((await git(dest, ['init', '-q', '-b', 'main'])).code !== 0) return { error: 'init-failed' };
  if ((await git(dest, ['add', '--force', '--', '.'])).code !== 0) return { error: 'add-failed' };
  if ((await git(dest, [...AUTHOR, 'commit', '-q', '--allow-empty', '-m', 'P9 copy of the sprint folder'])).code !== 0) return { error: 'commit-failed' };
  const commit = (await git(dest, ['rev-parse', 'HEAD'])).out.trim();
  return { baseline: { commit, paths }, left };
}

// The change from the baseline commit to the pinned head: [{ path, status: 'A' | 'M' | 'D', blob }], blob the new blob id
// (null for a delete). Read from git's raw diff, so the ids are the commit's own.
async function changesOf(copy, base, head) {
  const r = await git(copy, ['diff', '--raw', '-z', '--no-renames', base, head]);
  if (r.code !== 0) return null;
  const tokens = r.out.split('\0'), out = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const m = /^:(\d+) (\d+) [0-9a-f]+ ([0-9a-f]+) ([ADM])$/.exec(tokens[i]);
    if (!m) return null;
    const [, , newMode, blob, status] = m;
    if (status !== 'D' && !MODE_FILE.has(newMode)) return null;
    out.push({ path: tokens[i + 1], status, blob: status === 'D' ? null : blob });
  }
  return out;
}

// The sprint's copy, made once: sprint/copy/ (0700) from the folder as it is now, and its record (the baseline commit,
// each path's hash, the names left out, and the folder it came from), in the sprint's folder (0600). Made in a part
// folder and renamed in, so a copy that failed half way is never handed to a worker.
export async function startCopy(sprintDir, source) {
  const copy = path.join(sprintDir, 'copy'), part = path.join(sprintDir, 'copy.part-' + randomBytes(4).toString('hex'));
  await mkdir(sprintDir, { recursive: true, mode: 0o700 });
  const made = await copyTracked(source, part);
  if (made.error) { await rm(part, { recursive: true, force: true }); return made; }
  await rename(part, copy);
  const record = { source: await realpath(source), baseline: made.baseline, left: made.left, made: new Date().toISOString() };
  const recordPart = path.join(sprintDir, 'copy-record.json.part');
  try {
    await writeFile(recordPart, JSON.stringify(record, null, 1), { mode: 0o600 });
    await rename(recordPart, path.join(sprintDir, 'copy-record.json'));
  } catch (error) {
    await rm(copy, { recursive: true, force: true }); await rm(recordPart, { force: true });
    return { error: 'record-failed', detail: error.message };
  }
  return { copy, record };
}

const result = (written = [], rolledBack = [], left = [], cause = null) => ({ written, rolledBack, left, ...(cause && { cause }) });

// Apply (sprint spec daemon-3; SECURITY.md). record: P9's apply record folder (0700), kept until the sprint closes.
// Seams for tests: between(path) runs after the preflight and staging, before each write; afterWrite(path) runs after each
// write returns, and may throw, which is a failure after the write landed.
export async function applyCopy({ folder, copy, baseline, record, tag = new Date().toISOString().replace(/[:.]/g, '-'), between, afterWrite }) {
  if (protection() || isGuarded(folder)) return { refused: 'protected-folder' };
  // The copy is applied as committed: a worktree that differs from its commit is refused, not silently applied.
  const dirty = await git(copy, ['status', '--porcelain', '-z', '--untracked-files=all']);
  if (dirty.code !== 0 || dirty.out !== '') return { refused: 'copy-dirty' };
  // Pinned: the head is read once here; what is applied is that commit's blobs, whatever the worktree does afterwards.
  const head = (await git(copy, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'])).out.trim();
  if (!/^[0-9a-f]{40,64}$/.test(head)) return { refused: 'copy-unreadable' };
  const changes = await changesOf(copy, baseline.commit, head);
  if (!changes) return { refused: 'copy-unreadable' };

  // 1. Preflight: nothing is written if any path is not in the state the baseline says.
  const expectOf = (c) => (c.status === 'A' ? null : baseline.paths[c.path] ?? null);
  const conflicts = [];
  for (const c of changes) {
    const now = await stateOf(folder, c.path);
    if (now === 'link' || now !== expectOf(c)) conflicts.push({ path: c.path, reason: now === 'link' ? 'link-on-path' : 'conflict' });
  }
  if (conflicts.length) return result([], [], conflicts, 'conflict');

  // 2. Backup of every touched owner file, and the committed bytes of every written path, staged in the record folder,
  // before the first write. If any of it cannot be written in full, nothing is written.
  const backups = new Map(), staged = new Map();
  try {
    await mkdir(record, { recursive: true, mode: 0o700 });
    for (const c of changes) {
      if (c.status !== 'A') {
        const r = await readAt(folder, c.path);
        if (r.kind !== 'file' || hash(r.bytes) !== expectOf(c)) throw new Error('backup-changed');
        const to = path.join(record, 'backup', tag, c.path);
        await writeNew(to, r.bytes);
        backups.set(c.path, to);
      }
      if (c.status !== 'D') {
        const bytes = await blobOf(copy, c.blob);
        const to = path.join(record, 'staged', tag, c.path);
        await writeNew(to, bytes);
        staged.set(c.path, { file: to, wrote: hash(bytes) });
      }
    }
  } catch (error) {
    return result([], [], changes.map((c) => ({ path: c.path, reason: 'backup-failed: ' + error.message })), 'backup-failed');
  }

  // 3. Write in order. Each path's written hash is the staged blob's; a write that landed and then threw is reconciled
  // against the folder, so it is rolled back like any other.
  const done = [];
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    const s = staged.get(c.path) ?? null;
    const wrote = s ? s.wrote : null;
    await between?.(c.path);
    let why = null;
    try {
      const outcome = c.status === 'D'
        ? await removeFile(folder, c.path, expectOf(c), record, tag)
        : await replaceFile(folder, c.path, s.file, expectOf(c), record, tag);
      if (outcome.kind !== (c.status === 'D' ? 'removed' : 'written')) why = outcome.kind === 'changed' ? 'changed-since-check' : outcome.kind;
      else await afterWrite?.(c.path);
    } catch (error) {
      why = 'failed: ' + (error.code ?? error.message);
    }
    if (!why) { done.push({ ...c, wrote }); continue; }
    const now = await stateOf(folder, c.path);
    const landed = c.status === 'D' ? now === null && expectOf(c) !== null : now === wrote;
    if (landed) done.push({ ...c, wrote });
    const failedLeft = landed ? [] : [{ path: c.path, reason: why }];
    return rollback(folder, record, tag, done, backups, expectOf, failedLeft, changes.slice(i + 1), why);
  }
  return result(changes.map((c) => c.path));
}

// Rolls back, newest first. Each path is then reconciled with the folder: restored, still holding what P9 wrote (the
// restore failed; the real error is kept), or changed by someone else after P9's write (kept, backup kept).
async function rollback(folder, record, tag, done, backups, expectOf, failedLeft, notTried, cause) {
  const rolledBack = [], left = [...failedLeft];
  for (const d of [...done].reverse()) {
    const rb = tag + '-rollback';
    let error = null;
    try {
      if (d.status === 'A') await removeFile(folder, d.path, d.wrote, record, rb);
      else await replaceFile(folder, d.path, backups.get(d.path), d.wrote, record, rb);
    } catch (e) { error = e; }
    const now = await stateOf(folder, d.path);
    const restoredTo = d.status === 'A' ? null : expectOf(d);
    if (now === restoredTo) rolledBack.push(d.path);
    else if (now === d.wrote) left.push({ path: d.path, reason: 'rollback-failed: ' + (error?.code ?? error?.message ?? 'not restored') });
    else left.push({ path: d.path, reason: 'newer-than-p9-write' });
  }
  return result([], rolledBack, [...left, ...notTried.map((n) => ({ path: n.path, reason: 'not-applied' }))], cause);
}
