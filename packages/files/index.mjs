import { constants } from 'node:fs';
import { open, realpath, unlink, rename, link, readdir, lstat, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { MAX_BYTES } from '../protocol/index.mjs';

// Windows has no /proc/self/fd or O_NOFOLLOW; win32.mjs gives the same walk on NT handles. Linux never loads it.
const win = process.platform === 'win32' ? await import('./win32.mjs') : null;

export const hash = (content) => createHash('sha256').update(content).digest('hex');

function partsFor(relative) {
  if (typeof relative !== 'string' || !relative || !relative.isWellFormed() || relative.length > 4096
      || path.isAbsolute(relative) || /[\\\x00-\x1f:]/.test(relative)) throw new Error('unsafe-path');
  const parts = relative.split('/');
  if (parts.some((part) => !part || Buffer.byteLength(part) > 255 || part === '.' || part === '..' || locked(part))) throw new Error('locked-path');
  return parts;
}
// File protection (threat model row 4): on unless the desktop turned it off (server.mjs keeps the choice in the ledger).
let protect = true;
export const setProtection = (on) => { protect = on !== false; }; // anything but false keeps it on
export const protection = () => protect;
const locked = (name) => protect && (/^(?:_private|\.git|secrets)$/i.test(name) || /^\.env/i.test(name) || /^\.p9-/i.test(name));

// Walk with O_NOFOLLOW directory handles; subsequent access stays on these inodes.
async function resolveSafe(root, relative) {
  const parts = partsFor(relative);
  if (win) return win.resolveSafe(root, parts, MAX_BYTES);
  const handles = [];
  try {
    let parent = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    handles.push(parent);
    const canonicalRoot = await realpath(`/proc/self/fd/${parent.fd}`);
    if (canonicalRoot !== root) throw new Error('path-changed');
    for (const part of parts.slice(0, -1)) {
      parent = await open(`/proc/self/fd/${parent.fd}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      handles.push(parent);
    }
    const anchored = `/proc/self/fd/${parent.fd}/${parts.at(-1)}`;
    const file = await open(anchored, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    handles.push(file);
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new Error('unsafe-file');
    const actual = await realpath(anchored);
    if (actual !== path.join(canonicalRoot, ...parts)) throw new Error('path-changed');
    return { file, parent, stat, anchored, close: () => Promise.all(handles.map((handle) => handle.close())) };
  } catch (error) {
    await Promise.all(handles.map((handle) => handle.close()));
    throw error;
  }
}

function textFrom(buffer) {
  if (buffer.length > MAX_BYTES || buffer.includes(0)) throw new Error('binary-or-oversize');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw new Error('binary-or-oversize'); }
}

async function contents(file) {
  const buffer = Buffer.alloc(MAX_BYTES + 1);
  let length = 0;
  while (length < buffer.length) {
    const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
    if (!bytesRead) break;
    length += bytesRead;
  }
  const value = buffer.subarray(0, length);
  textFrom(value);
  return value;
}

export async function readFile(root, relative) {
  const safe = await resolveSafe(root, relative);
  try {
    const buffer = await contents(safe.file);
    return { content: textFrom(buffer), hash: hash(buffer) };
  } finally { await safe.close(); }
}

// Regular files and subdirectories directly inside one workspace directory ('' is the root), walked like resolveSafe
// (no symlinks; locked names refused in the path and left out of the listing).
export async function listDirectory(root, relative) {
  const parts = relative === '' ? [] : partsFor(relative);
  if (win) return win.listDirectory(root, parts, locked);
  const handles = [];
  try {
    let parent = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    handles.push(parent);
    if (await realpath(`/proc/self/fd/${parent.fd}`) !== root) throw new Error('path-changed');
    for (const part of parts) {
      parent = await open(`/proc/self/fd/${parent.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      handles.push(parent);
    }
    const entries = [];
    for (const name of await readdir(`/proc/self/fd/${parent.fd}`)) {
      const stat = await lstat(`/proc/self/fd/${parent.fd}/${name}`).catch(() => null);
      if (locked(name)) continue;
      if (stat?.isFile()) entries.push({ name, mtimeMs: stat.mtimeMs });
      else if (stat?.isDirectory()) entries.push({ name, mtimeMs: stat.mtimeMs, dir: true });
    }
    return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } finally { await Promise.all(handles.map((handle) => handle.close())); }
}

async function preserveDraft(root, recovery, record) {
  const directory = win ? win.openRecovery(recovery)
    : await open(recovery, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const name = `.p9-conflict-${randomUUID()}`;
  const target = win ? name : `/proc/self/fd/${directory.fd}/${name}`;
  async function update(fields) {
    const next = { ...record, ...fields };
    let temporary, copy;
    try {
      if (win) ({ name: temporary, file: copy } = win.createExclusive(directory, '.p9-record-'));
      else {
        temporary = `/proc/self/fd/${directory.fd}/.p9-record-${randomUUID()}`;
        copy = await open(temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      }
      try { await copy.writeFile(JSON.stringify(next)); await copy.sync(); }
      finally { await copy.close(); }
      await (win ? win.renameAt(directory, temporary, target) : rename(temporary, target));
      temporary = undefined; // the name is vacant now; deleting it could remove someone else's file
      await directory.sync();
      record = next;
    } finally { if (temporary) await (win ? win.unlinkAt(directory, temporary) : unlink(temporary)).catch(() => {}); }
  }
  try {
    const stat = await directory.stat();
    const actual = win ? win.canonical(directory) : await realpath(`/proc/self/fd/${directory.fd}`);
    const relativeRecovery = path.relative(root, actual);
    // ponytail: no uid or mode bits on Windows; main.mjs leaves the private directories' ACLs to the installer there.
    // The daemon passes the recovery folder's realpath from startup; a parent swapped for a link since then lands elsewhere.
    if ((!win && (stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700)) || actual !== path.resolve(recovery) || !relativeRecovery
        || (!relativeRecovery.startsWith('..' + path.sep) && relativeRecovery !== '..' && !path.isAbsolute(relativeRecovery))) {
      throw new Error('unsafe-recovery-directory');
    }
    await update({});
    return { name, update, remove: () => (win ? win.unlinkAt(directory, name) : unlink(target)), close: () => directory.close() };
  } catch (error) {
    await directory.close();
    throw error;
  }
}

// A new file only (Mission's New idea): the name must not exist (O_EXCL / FILE_CREATE), so it never replaces anything,
// and the parent walk is the same no-symlink walk as resolveSafe. A failed write removes the half-written file.
export async function createFile(root, relative, content) {
  if (typeof content !== 'string' || !content.isWellFormed()) throw new Error('invalid-save');
  textFrom(Buffer.from(content));
  const parts = partsFor(relative), canonicalRoot = path.resolve(root);
  if (win) {
    // Windows deletes through the handle it created, so the cleanup can only remove its own file.
    const created = await win.createNamed(canonicalRoot, parts);
    try {
      try { await created.file.writeFile(content); await created.file.sync(); }
      catch (error) {
        await created.file.close().catch(() => {});
        await win.unlinkAt(created.parent, parts.at(-1)).catch(() => {});
        throw error;
      }
      await created.file.close();
      await created.parent.sync();
      return { kind: 'created', hash: hash(content) };
    } finally { await created.close(); }
  }
  // Linux has no delete-by-handle: write a .p9-new- temp, then link() it to the name, which fails with EEXIST rather
  // than replacing. A failed write deletes only the temp, never a name someone else may have filled meanwhile.
  const handles = [];
  let temporary;
  try {
    let parent = await open(canonicalRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    handles.push(parent);
    if (await realpath(`/proc/self/fd/${parent.fd}`) !== canonicalRoot) throw new Error('path-changed');
    for (const part of parts.slice(0, -1)) {
      parent = await open(`/proc/self/fd/${parent.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      handles.push(parent);
    }
    temporary = `/proc/self/fd/${parent.fd}/.p9-new-${randomUUID()}`;
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try { await file.writeFile(content); await file.sync(); }
    finally { await file.close(); }
    await link(temporary, `/proc/self/fd/${parent.fd}/${parts.at(-1)}`);
    await unlink(temporary);
    temporary = undefined;
    await parent.sync();
    return { kind: 'created', hash: hash(content) };
  } finally {
    if (temporary) await unlink(temporary).catch(() => {});
    await Promise.all(handles.map((handle) => handle.close()));
  }
}

// A new folder only (the setup wizard's starter files, threat model row 17): the same no-symlink walk as createFile,
// then mkdir (Linux) or FILE_CREATE (Windows), so an existing name fails with EEXIST and is never replaced or followed.
export async function createDirectory(root, relative) {
  const parts = partsFor(relative), canonicalRoot = path.resolve(root);
  if (win) return win.createDirectory(canonicalRoot, parts);
  const handles = [];
  try {
    let parent = await open(canonicalRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    handles.push(parent);
    if (await realpath(`/proc/self/fd/${parent.fd}`) !== canonicalRoot) throw new Error('path-changed');
    for (const part of parts.slice(0, -1)) {
      parent = await open(`/proc/self/fd/${parent.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      handles.push(parent);
    }
    await mkdir(`/proc/self/fd/${parent.fd}/${parts.at(-1)}`, 0o755);
    await parent.sync();
  } finally { await Promise.all(handles.map((handle) => handle.close())); }
}

const pending = new Map();
export async function drainSaves() {
  await Promise.all(pending.values());
}

function isPathConflict(error) {
  return ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)
    || ['unsafe-file', 'path-changed', 'binary-or-oversize'].includes(error.message);
}

export async function guardedSave(root, relative, expectedHash, content, recovery) {
  if (typeof content !== 'string' || typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error('invalid-save');
  if (!content.isWellFormed()) throw new Error('invalid-save');
  textFrom(Buffer.from(content));
  partsFor(relative);
  // The daemon supplies its canonical startup root; do not follow a later root swap.
  const canonicalRoot = path.resolve(root);
  const key = path.join(canonicalRoot, relative);
  const operation = (pending.get(key) ?? Promise.resolve()).then(() => save(canonicalRoot, relative, expectedHash, content, recovery));
  const settled = operation.catch(() => {});
  pending.set(key, settled);
  try { return await operation; }
  finally { if (pending.get(key) === settled) pending.delete(key); }
}

async function save(root, relative, expectedHash, content, recovery) {
  let safe;
  let temporary;
  let draft;
  let replaced = false;
  let replacing = false;
  let durable = false;
  try {
    draft = await preserveDraft(root, recovery, { workspace: root, path: relative, expectedHash, content, draftHash: hash(content),
      reason: 'save-pending', createdAt: new Date().toISOString() });
    let current;
    try { safe = await resolveSafe(root, relative); current = await contents(safe.file); }
    catch (error) {
      if (!isPathConflict(error)) throw error;
      await safe?.close();
      safe = undefined;
    }
    const conflict = async (reason, current) => {
      await draft.update({ reason, ...(current ? { diskHash: hash(current) } : {}) });
      return { kind: 'conflict', reason, conflict: draft.name, content,
        ...(current ? { diskContent: textFrom(current), diskHash: hash(current) } : {}) };
    };
    if (!safe) return await conflict('path-conflict');
    await draft.update({ diskHash: hash(current) });
    if (hash(current) !== expectedHash) return await conflict('hash-conflict', current);
    let file;
    if (win) ({ name: temporary, file } = win.createExclusive(safe.parent, '.p9-save-', safe.file));
    else {
      temporary = `/proc/self/fd/${safe.parent.fd}/.p9-save-${randomUUID()}`;
      file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    }
    try {
      await file.writeFile(content);
      await file.chmod(safe.stat.mode & 0o777);
      await file.sync();
    } finally { await file.close(); }
    let latest;
    try { latest = await resolveSafe(root, relative); }
    catch (error) {
      if (isPathConflict(error)) return await conflict('path-conflict');
      throw error;
    }
    try {
      const parent = await safe.parent.stat(), latestParent = await latest.parent.stat();
      if (parent.dev !== latestParent.dev || parent.ino !== latestParent.ino) return await conflict('path-conflict');
      let finalContent;
      try { finalContent = await contents(latest.file); }
      catch (error) { if (isPathConflict(error)) return await conflict('path-conflict'); throw error; }
      if (hash(finalContent) !== expectedHash) return await conflict('hash-conflict', finalContent);
      if (win && !win.matchSecurity(file, latest.file)) return await conflict('path-conflict');
      // shortcut: independent same-user writers can race this final check; no hash-CAS syscall exists.
      replacing = true;
      await (win ? win.renameAt(safe.parent, temporary, safe.anchored) : rename(temporary, safe.anchored));
      replaced = true;
      await safe.parent.sync();
      durable = true;
    } finally { await latest.close(); }
    try { await draft.update({ reason: 'saved' }); await draft.remove(); }
    catch { return { kind: 'saved', hash: hash(content), draftRetained: true, conflict: draft.name }; }
    return { kind: 'saved', hash: hash(content) };
  } catch (error) {
    if (durable) return { kind: 'saved', hash: hash(content), draftRetained: true, conflict: draft.name };
    if (draft) {
      const reason = replacing ? 'durability-uncertain' : 'save-failed';
      await draft.update({ reason }).catch(() => {});
      return { kind: 'failed', reason, conflict: draft.name, content,
        code: ['ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EROFS', 'EBUSY', 'EIO'].includes(error.code) ? error.code : 'INTERNAL_FAILURE' };
    }
    throw error;
  } finally {
    if (temporary && !replaced) await (win ? win.unlinkAt(safe.parent, temporary) : unlink(temporary)).catch(() => {});
    await draft?.close();
    await safe?.close();
  }
}
