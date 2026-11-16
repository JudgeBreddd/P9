// A sprint from a folder with no remote (SECURITY.md § Sprint from a folder with no remote; sprint spec daemon-3).
// copyTracked: git's index, as on disk now, into a new repository with one commit and no origin.
// applyCopy: the change from the copy's baseline to its main line onto the owner's folder, only on the owner's yes, through
// packages/files (the only module that writes workspace files): check, backup, temp, rename, guarded rollback, three lists.
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { hash, isGuarded, protection, replaceFile, removeFile } from '../../packages/files/index.mjs';
import { git } from './worker-folders.mjs';

const AUTHOR = ['-c', 'user.name=P9', '-c', 'user.email=p9@localhost'];
const MODE_FILE = new Set(['100644', '100755']);
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

// Walks rel from folder one component at a time, never following a link: { kind: 'absent' | 'link' | 'at', file }.
async function walk(folder, rel) {
  const parts = rel.split('/');
  let at = folder;
  for (const part of parts.slice(0, -1)) {
    at = path.join(at, part);
    const st = await lstat(at).catch(() => null);
    if (!st) return { kind: 'absent' };
    if (!st.isDirectory()) return { kind: 'link' };
  }
  return { kind: 'at', file: path.join(folder, rel) };
}

// Regular file bytes without following a link on the final name, or null when it is not a plain file any more.
async function readRegular(file) {
  const handle = await open(file, constants.O_RDONLY | NO_FOLLOW).catch(() => null);
  if (!handle) return null;
  try { const st = await handle.stat(); return st.isFile() ? await handle.readFile() : null; } finally { await handle.close(); }
}

// The owner's folder state at one path: null when absent, a hash when a plain file, 'link' when a link is on the way.
async function stateOf(folder, rel) {
  const w = await walk(folder, rel);
  if (w.kind !== 'at') return w.kind === 'absent' ? null : 'link';
  const st = await lstat(w.file).catch(() => null);
  if (!st) return null;
  if (!st.isFile()) return 'link';
  const bytes = await readRegular(w.file);
  return bytes ? hash(bytes) : 'link';
}

// Git's index for folder: regular files are copied. Links, submodules, deleted files, and untracked or ignored files are
// named with their reason, never read; the names only, as SECURITY.md says.
export async function copyTracked(folder, dest) {
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
    const w = await walk(folder, rel);
    if (w.kind === 'link') { left.push({ path: rel, reason: 'link-on-path' }); continue; }
    if (w.kind === 'absent') { left.push({ path: rel, reason: 'deleted' }); continue; }
    const st = await lstat(w.file).catch(() => null);
    if (!st) { left.push({ path: rel, reason: 'deleted' }); continue; }
    if (!st.isFile()) { left.push({ path: rel, reason: 'not-regular' }); continue; }
    const bytes = await readRegular(w.file);
    if (!bytes) { left.push({ path: rel, reason: 'not-regular' }); continue; }
    const to = path.join(dest, rel);
    await mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
    const file = await open(to, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode === '100755' ? 0o700 : 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    paths[rel] = hash(bytes);
  }
  if ((await git(dest, ['init', '-q', '-b', 'main'])).code !== 0) return { error: 'init-failed' };
  if ((await git(dest, ['add', '--force', '--', '.'])).code !== 0) return { error: 'add-failed' };
  if ((await git(dest, [...AUTHOR, 'commit', '-q', '--allow-empty', '-m', 'P9 copy of the sprint folder'])).code !== 0) return { error: 'commit-failed' };
  const commit = (await git(dest, ['rev-parse', 'HEAD'])).out.trim();
  return { baseline: { commit, paths }, left };
}

// The change from the baseline commit to the copy's main line: [{ path, status: 'A' | 'M' | 'D' }].
async function changesOf(copy, base) {
  const r = await git(copy, ['diff', '--name-status', '-z', '--no-renames', base, 'HEAD']);
  if (r.code !== 0) return null;
  const tokens = r.out.split('\0'), out = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) if (tokens[i]) out.push({ path: tokens[i + 1], status: tokens[i][0] });
  return out;
}

const result = (written = [], rolledBack = [], left = [], cause = null) => ({ written, rolledBack, left, ...(cause && { cause }) });

// Apply (sprint spec daemon-3; SECURITY.md). record: P9's apply record folder (0700), kept until the sprint closes.
// Seams for tests: between(path) runs after the preflight and before each write; afterWrite(path) runs after each write
// returns, and may throw, which is a failure after the write landed.
export async function applyCopy({ folder, copy, baseline, record, tag = new Date().toISOString().replace(/[:.]/g, '-'), between, afterWrite }) {
  if (protection() || isGuarded(folder)) return { refused: 'protected-folder' };
  // The copy is applied as committed: a worktree that differs from its commit is refused, not silently applied.
  const dirty = await git(copy, ['status', '--porcelain', '-z', '--untracked-files=all']);
  if (dirty.code !== 0 || dirty.out !== '') return { refused: 'copy-dirty' };
  const changes = await changesOf(copy, baseline.commit);
  if (!changes) return { refused: 'copy-unreadable' };

  // 1. Preflight: nothing is written if any path is not in the state the baseline says.
  const expectOf = (c) => (c.status === 'A' ? null : baseline.paths[c.path] ?? null);
  const conflicts = [];
  for (const c of changes) {
    const now = await stateOf(folder, c.path);
    if (now === 'link' || now !== expectOf(c)) conflicts.push({ path: c.path, reason: now === 'link' ? 'link-on-path' : 'conflict' });
  }
  if (conflicts.length) return result([], [], conflicts, 'conflict');

  // 2. Backup of every touched owner file, before the first write. If it cannot be written in full, nothing is written.
  const backups = new Map();
  try {
    await mkdir(record, { recursive: true, mode: 0o700 });
    for (const c of changes) {
      if (c.status === 'A') continue;
      const bytes = await readRegular(path.join(folder, c.path));
      if (!bytes || hash(bytes) !== expectOf(c)) throw new Error('backup-changed');
      const to = path.join(record, 'backup', tag, c.path);
      await mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
      const file = await open(to, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      backups.set(c.path, to);
    }
  } catch (error) {
    return result([], [], changes.map((c) => ({ path: c.path, reason: 'backup-failed: ' + error.message })), 'backup-failed');
  }

  // 3. Write in order. Each path's written hash is taken from the commit before its write; a write that landed and then
  // threw is reconciled against the folder, so it is rolled back like any other.
  const done = [];
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    const bytes = c.status === 'D' ? null : await readRegular(path.join(copy, c.path));
    if (c.status !== 'D' && !bytes) return rollback(folder, record, tag, done, backups, expectOf, [{ path: c.path, reason: 'copy-missing' }], changes.slice(i + 1), 'copy-missing');
    const wrote = bytes ? hash(bytes) : null;
    await between?.(c.path);
    let why = null, outcome = null;
    try {
      outcome = c.status === 'D'
        ? await removeFile(folder, c.path, expectOf(c), record, tag)
        : await replaceFile(folder, c.path, path.join(copy, c.path), expectOf(c), record, tag);
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
