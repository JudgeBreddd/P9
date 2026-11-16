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

// Git's index for folder: regular files are copied; links, submodules and deleted files are named, never followed.
// ponytail: one read per file and one commit; a folder with millions of tracked files would want a streamed copy.
export async function copyTracked(folder, dest) {
  const listed = await git(folder, ['ls-files', '-s', '-z']);
  if (listed.code !== 0) return { error: 'not-a-repository' };
  await mkdir(dest, { mode: 0o700 });
  const paths = {}, left = [];
  for (const record of listed.out.split('\0').filter(Boolean)) {
    const m = /^(\d+) [0-9a-f]+ \d+\t([\s\S]*)$/.exec(record);
    if (!m) return { error: 'unreadable-index' };
    const [, mode, rel] = m;
    if (mode === '120000') { left.push({ path: rel, reason: 'link' }); continue; }
    if (mode === '160000') { left.push({ path: rel, reason: 'submodule' }); continue; }
    if (!MODE_FILE.has(mode)) { left.push({ path: rel, reason: 'not-regular' }); continue; }
    const from = path.join(folder, rel), st = await lstat(from).catch(() => null);
    if (!st) { left.push({ path: rel, reason: 'deleted' }); continue; }
    if (!st.isFile()) { left.push({ path: rel, reason: 'not-regular' }); continue; }
    const bytes = await readRegular(from);
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

// Regular file bytes without following a link (O_NOFOLLOW), or null when the name is not a plain file any more.
async function readRegular(file) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => null);
  if (!handle) return null;
  try { const st = await handle.stat(); return st.isFile() ? await handle.readFile() : null; } finally { await handle.close(); }
}

// The owner's folder state at one path: null when absent, a hash when a plain file, 'link' when a link is on the way.
async function stateOf(folder, rel) {
  const parts = rel.split('/');
  let at = folder;
  for (const part of parts.slice(0, -1)) {
    at = path.join(at, part);
    const st = await lstat(at).catch(() => null);
    if (!st) return null;
    if (!st.isDirectory()) return 'link';
  }
  const file = path.join(folder, rel), st = await lstat(file).catch(() => null);
  if (!st) return null;
  if (!st.isFile()) return 'link';
  const bytes = await readRegular(file);
  return bytes ? hash(bytes) : 'link';
}

// The change from the baseline commit to the copy's main line: [{ path, status: 'A' | 'M' | 'D' }].
async function changesOf(copy, base) {
  const r = await git(copy, ['diff', '--name-status', '-z', '--no-renames', base, 'HEAD']);
  if (r.code !== 0) return null;
  const tokens = r.out.split('\0'), out = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) if (tokens[i]) out.push({ path: tokens[i + 1], status: tokens[i][0] });
  return out;
}

const result = (written = [], rolledBack = [], left = []) => ({ written, rolledBack, left });

// Apply (sprint spec daemon-3; SECURITY.md). record: P9's apply record folder (0700), kept until the sprint closes.
// between(path): test seam, runs after the preflight and before each write.
export async function applyCopy({ folder, copy, baseline, record, tag = new Date().toISOString().replace(/[:.]/g, '-'), between }) {
  if (protection() || isGuarded(folder)) return { refused: 'protected-folder' };
  const changes = await changesOf(copy, baseline.commit);
  if (!changes) return { refused: 'copy-unreadable' };

  // 1. Preflight: nothing is written if any path is not in the state the baseline says.
  const expectOf = (c) => (c.status === 'A' ? null : baseline.paths[c.path] ?? null);
  const conflicts = [];
  for (const c of changes) {
    const now = await stateOf(folder, c.path);
    if (now === 'link' || now !== expectOf(c)) conflicts.push({ path: c.path, reason: now === 'link' ? 'link-on-path' : 'conflict' });
  }
  if (conflicts.length) return result([], [], conflicts);

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
      const file = await open(to, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      backups.set(c.path, to);
    }
  } catch (error) {
    return result([], [], changes.map((c) => ({ path: c.path, reason: 'backup-failed: ' + error.message })));
  }

  // 3. Write in order. A failure rolls back what this apply wrote, and only where the bytes still match what P9 wrote.
  const done = [];
  let failed = null;
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    await between?.(c.path);
    let outcome;
    try {
      if (c.status === 'D') {
        outcome = await removeFile(folder, c.path, expectOf(c), record, tag);
        if (outcome.kind === 'removed') done.push({ ...c, wrote: null });
      } else {
        const staged = path.join(copy, c.path);
        const bytes = await readRegular(staged);
        if (!bytes) throw new Error('copy-missing');
        outcome = await replaceFile(folder, c.path, staged, expectOf(c), record, tag);
        if (outcome.kind === 'written') done.push({ ...c, wrote: hash(bytes) });
      }
      if (outcome.kind !== 'written' && outcome.kind !== 'removed') failed = { path: c.path, reason: outcome.kind === 'changed' ? 'changed-since-check' : outcome.kind };
    } catch (error) {
      failed = { path: c.path, reason: 'failed: ' + (error.code ?? error.message) };
    }
    if (failed) {
      const notTried = changes.slice(i + 1).map((n) => ({ path: n.path, reason: 'not-applied' }));
      return rollback(folder, record, tag, done, backups, failed, notTried);
    }
  }
  return result(changes.map((c) => c.path));
}

// Rolls back, newest first. A path is restored (or removed, if added) only while it still holds what P9 wrote.
async function rollback(folder, record, tag, done, backups, failed, notTried) {
  const rolledBack = [], left = [failed, ...notTried];
  for (const d of [...done].reverse()) {
    const rb = tag + '-rollback';
    let outcome;
    if (d.status === 'A') outcome = await removeFile(folder, d.path, d.wrote, record, rb).catch(() => ({ kind: 'failed' }));
    else if (d.status === 'M') outcome = await replaceFile(folder, d.path, backups.get(d.path), d.wrote, record, rb).catch(() => ({ kind: 'failed' }));
    else outcome = await replaceFile(folder, d.path, backups.get(d.path), null, record, rb).catch(() => ({ kind: 'failed' }));
    if (outcome.kind === 'written' || outcome.kind === 'removed') rolledBack.push(d.path);
    else left.push({ path: d.path, reason: 'newer-than-p9-write' });
  }
  return result([], rolledBack, left);
}
