import { constants } from 'node:fs';
import { open, realpath, unlink, rename, link, readdir, lstat, mkdir, copyFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { MAX_BYTES } from '../protocol/index.mjs';

// Windows has no /proc/self/fd or O_NOFOLLOW; win32.mjs gives the same walk on NT handles. Linux never loads it.
// Loading node:ffi warns "FFI is an experimental feature" on every daemon start (W4); only that warning is dropped.
const win = process.platform === 'win32' ? await quietFfi(() => import('./win32.mjs')) : null;

export async function quietFfi(load) {
  const emitWarning = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    if (!/^FFI is an experimental feature/.test(warning?.message ?? warning)) return emitWarning.call(this, warning, ...rest);
  };
  try { return await load(); } finally { process.emitWarning = emitWarning; }
}

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
export const lockedName = (name) => locked(name);

// Folders P9 never crawls (Builder, 2026-10-27: no VS Code-style out-of-memory from walking them): the file tree, Dev
// Focus's tree, search and watcher, and a tunnel send of a folder that is not a git repo.
export const HEAVY = Object.freeze(['node_modules', '.venv', 'venv', '__pycache__', '.cache', 'dist', 'build', '.astro']);

// Walk with O_NOFOLLOW directory handles; subsequent access stays on these inodes.
async function resolveSafe(root, relative, maxBytes = MAX_BYTES) {
  const parts = partsFor(relative);
  if (win) return win.resolveSafe(root, parts, maxBytes);
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
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) throw new Error('unsafe-file');
    const actual = await realpath(anchored);
    if (actual !== path.join(canonicalRoot, ...parts)) throw new Error('path-changed');
    return { file, parent, stat, anchored, close: () => Promise.all(handles.map((handle) => handle.close())) };
  } catch (error) {
    await Promise.all(handles.map((handle) => handle.close()));
    throw error;
  }
}

// A workspace file of any size, opened like readFile (no links, locked names refused): a tunnel send reads it in pieces.
export const openSafe = (root, relative) => resolveSafe(root, relative, Infinity);

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

// The type from a file's first bytes, never its name: PNG, JPEG, GIF or WebP, else null (threat model row 27; chat.mjs uses it too).
export const imageType = (bytes) => {
  const head = bytes.toString('latin1', 0, 12);
  return head.startsWith('\x89PNG\r\n\x1a\n') ? 'image/png' : head.startsWith('\xff\xd8\xff') ? 'image/jpeg'
    : /^GIF8[79]a/.test(head) ? 'image/gif' : head.startsWith('RIFF') && head.endsWith('WEBP') ? 'image/webp' : null;
};

// A workspace image for the Chat Focus file window (rows 23/26/27 adds): readFile's walk (no links, locked names refused, a
// regular file opened non-blocking), then row 27's checks: 12 bytes to 6 MiB, and the type from the bytes. Read-only.
export const MAX_IMAGE = 6 * 1024 * 1024;
export async function readImage(root, relative) {
  const safe = await resolveSafe(root, relative, MAX_IMAGE);
  try {
    const bytes = Buffer.alloc(safe.stat.size);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await safe.file.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const mimeType = length === bytes.length && length >= 12 && imageType(bytes);
    if (!mimeType) throw new Error('not-an-image');
    return { mimeType, data: bytes.toString('base64') };
  } finally { await safe.close(); }
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

// A new name for a file in the same folder (Mission notes, threat model row 34), never over a name that exists: Linux
// link()s the new name (EEXIST if taken) then unlinks the old one; Windows renames without REPLACE_IF_EXISTS.
export async function renameFile(root, relative, name) {
  const parts = partsFor(relative);
  if (partsFor(name).length !== 1) throw new Error('unsafe-path');
  if (win) return win.renameNamed(root, parts, name);
  const safe = await resolveSafe(root, relative);
  try {
    const target = `/proc/self/fd/${safe.parent.fd}/${name}`;
    // ponytail: a same-user process can swap the old name between these checks and the link or unlink, as it can race
    // guardedSave's final check; no rename-by-handle syscall exists. Each step checks the inode it opened.
    if ((await lstat(safe.anchored)).ino !== safe.stat.ino) throw new Error('path-changed');
    await link(safe.anchored, target);
    if ((await lstat(target)).ino !== safe.stat.ino) throw new Error('path-changed');
    await unlink(safe.anchored);
    await safe.parent.sync();
  } finally { await safe.close(); }
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

// A tunnel send's writes (threat model rows 4 and 7): a whole file from a staged copy, or a delete, never past a change
// made since the plan. The walk is resolveSafe's, creating missing folders on the way; the current file must hash to
// `expect` (null: must not exist). The old copy goes to <recovery>/replaced/<tag>/<path> (0600, fsynced) first.
// Windows (win32.mjs anchored): the same walk on NT handles, the file held without write sharing until the rename or delete.
async function anchored(root, relative, create) {
  const parts = partsFor(relative), canonicalRoot = path.resolve(root), handles = [];
  if (win) return win.anchored(canonicalRoot, parts, create);
  try {
    let parent = await open(canonicalRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    handles.push(parent);
    if (await realpath(`/proc/self/fd/${parent.fd}`) !== canonicalRoot) throw new Error('path-changed');
    for (const part of parts.slice(0, -1)) {
      const next = `/proc/self/fd/${parent.fd}/${part}`;
      if (create) await mkdir(next, 0o755).catch((error) => { if (error.code !== 'EEXIST') throw error; });
      parent = await open(next, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      handles.push(parent);
    }
    const name = `/proc/self/fd/${parent.fd}/${parts.at(-1)}`;
    const file = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (file) handles.push(file);
    const stat = file && await file.stat();
    if (stat && (!stat.isFile() || stat.nlink !== 1)) throw new Error('unsafe-file');
    if (stat && await realpath(name) !== path.join(canonicalRoot, ...parts)) throw new Error('path-changed');
    return { parent, file, stat, name, close: () => Promise.all(handles.map((handle) => handle.close())) };
  } catch (error) {
    await Promise.all(handles.map((handle) => handle.close()));
    throw error;
  }
}
// Every piece read through `file`, a FileHandle or a win32.mjs handle (the same read()), never the name again.
async function* pieces(file) {
  const buffer = Buffer.alloc(1024 * 1024);
  for (let at = 0; ;) {
    const { bytesRead } = await file.read(buffer, 0, buffer.length, at);
    if (!bytesRead) return;
    yield { piece: buffer.subarray(0, bytesRead), at };
    at += bytesRead;
    // win32.mjs's calls are synchronous: give the daemon's other requests a turn between pieces of a big file.
    if (win) await new Promise(setImmediate);
  }
}
const handleHash = async (file) => {
  const digest = createHash('sha256');
  for await (const { piece } of pieces(file)) digest.update(piece);
  return digest.digest('hex');
};
async function copyThrough(from, to) {
  for await (const { piece, at } of pieces(from)) {
    for (let done = 0; done < piece.length;) done += (await to.write(piece, done, piece.length - done, at + done)).bytesWritten;
  }
}
// The old bytes, read through the open handle, into the recovery folder.
async function keepCopy(recovery, tag, relative, file) {
  // ponytail: no uid or mode bits on Windows; the folder's ACL is the installer's there, as for preserveDraft.
  const directory = win ? win.openRecovery(recovery) : await open(recovery, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = await directory.stat();
    if (win ? win.canonical(directory) !== path.resolve(recovery) : stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) {
      throw new Error('unsafe-recovery-directory');
    }
  } finally { await directory.close(); }
  const target = path.join(recovery, 'replaced', tag, ...relative.split('/'));
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const copy = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { await copyThrough(file, copy); await copy.sync(); }
  finally { await copy.close(); }
  return path.join('replaced', tag, relative);
}
// The name still holds the inode the walk opened (or still nothing).
const unchanged = async (safe) => {
  if (win) return win.unchanged(safe);
  const now = await lstat(safe.name).catch(() => null);
  return safe.stat ? now?.ino === safe.stat.ino && now.dev === safe.stat.dev : !now;
};

export async function replaceFile(root, relative, staged, expect, recovery, tag) {
  const safe = await anchored(root, relative, true);
  let temporary;
  try {
    if ((safe.file ? await handleHash(safe.file) : null) !== expect) return { kind: 'changed' };
    const kept = safe.file ? await keepCopy(recovery, tag, relative, safe.file) : null;
    if (win) {
      // A staged temp (createExclusive): over an existing file it starts open only to this user and takes the file's
      // owner and DACL just before the rename, as a save does; metadata the copy would lose (EFS, a label) refuses.
      let copy;
      ({ name: temporary, file: copy } = win.createExclusive(safe.parent, '.p9-xfer-', safe.file ?? undefined));
      const from = await open(staged, 'r');
      try { await copyThrough(from, copy); } finally { await from.close(); }
      await copy.sync();
      if (safe.file && !win.matchSecurity(copy, safe.file)) return { kind: 'changed', ...(kept && { recovery: kept }) };
    } else {
      temporary = `/proc/self/fd/${safe.parent.fd}/.p9-xfer-${randomUUID()}`;
      await copyFile(staged, temporary, constants.COPYFILE_EXCL);
      const file = await open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await file.chmod(safe.stat ? safe.stat.mode & 0o777 : 0o644); await file.sync(); }
      finally { await file.close(); }
    }
    // ponytail: a same-user process can move the file between this check and the rename, as in guardedSave (on Linux
    // also change it; on Windows the held handle shares no writes).
    if (!await unchanged(safe)) return { kind: 'changed', ...(kept && { recovery: kept }) };
    // A new name is link()ed (Linux) or renamed without replace (Windows), so a file created meanwhile fails with
    // EEXIST rather than being replaced.
    if (win) {
      try { await win.renameAt(safe.parent, temporary, safe.name, Boolean(safe.file)); }
      catch (error) { if (!safe.file && error.code === 'EEXIST') return { kind: 'changed' }; throw error; }
    } else if (safe.file) await rename(temporary, safe.name);
    else {
      try { await link(temporary, safe.name); } catch (error) { if (error.code === 'EEXIST') return { kind: 'changed' }; throw error; }
      await unlink(temporary);
    }
    temporary = undefined;
    await safe.parent.sync();
    return { kind: 'written', ...(kept && { recovery: kept }) };
  } finally {
    if (temporary) await (win ? win.unlinkAt(safe.parent, temporary) : unlink(temporary)).catch(() => {});
    await safe.close();
  }
}

export async function removeFile(root, relative, expect, recovery, tag) {
  const safe = await anchored(root, relative, false).catch((error) => {
    if (error.code === 'ENOENT') return null; // a parent folder is gone, so the file is too
    throw error;
  });
  if (!safe?.file) { await safe?.close(); return { kind: 'gone' }; }
  try {
    if (await handleHash(safe.file) !== expect) return { kind: 'changed' };
    const kept = await keepCopy(recovery, tag, relative, safe.file);
    if (!await unchanged(safe)) return { kind: 'changed', recovery: kept };
    if (win) win.deleteHeld(safe.file); else await unlink(safe.name);
    await safe.parent.sync();
    return { kind: 'removed', recovery: kept };
  } finally { await safe.close(); }
}
