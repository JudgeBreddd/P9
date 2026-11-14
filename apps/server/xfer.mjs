// Send files over the tunnel (item 23, spec tunnel-file-transfer.md): the same routes on both daemons, so desktop main
// copies a folder either way by GETting pieces from one daemon and POSTing them to the other, as the chat move does.
// manifest lists a folder's files with their sha256; file hands one out in pieces; part stages pieces; commit writes the
// staged files and deletes through packages/files (each against the hash the plan saw, old copies to recovery); abort
// drops the staging. Desktop routes only, never the phone's.
import { execFile } from 'node:child_process';
import { appendFile, lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { HEAVY, listDirectory, lockedName, openSafe, removeFile, replaceFile } from '../../packages/files/index.mjs';
import { appendPiece, checkStaged, readPiece, sha256File, validPiece } from './pieces.mjs';

const run = promisify(execFile);
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, HASH = /^[0-9a-f]{64}$/;
// Ceilings: each the largest value its laptop Setting allows (main.mjs XFER_LIMITS); the Settings refuse below these.
export const MAX_FILE = 64 * 1024 ** 3, MAX_COUNT = 200_000;
const refused = (status, error, extra) => ({ status, error, ...extra });
// move.mjs relative(): workspace-relative, '/'-separated, no '..' or empty part.
const relative = (value) => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0') && !path.isAbsolute(value)
  && value.split('/').every((part) => part && part !== '.' && part !== '..' && !part.includes('\\'));

// git's own list of a repo folder's files (tracked and untracked, ignored left out), no shell; null when not a repo.
async function gitList(cwd, args) {
  try {
    const { stdout } = await run('git', ['-C', cwd, 'ls-files', '-z', ...args], { maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    return stdout.split('\0').filter(Boolean);
  } catch { return null; }
}

// A chat started outside the workspace (v0.1.6 U4) sends its own folder: root names the folder the paths are relative to, an
// absolute one (Unrestricted mode only, as a chat may start there: chat.mjs folderCheck) or a workspace folder ('' the
// workspace). Without root the paths are workspace-relative, as before. The listing rules are the same either way.
const ROOT_LOCKED = 'P9 here has the agent lock or File protection on, so it reaches only folders in its workspace. Turn both off in Settings (Unrestricted mode), or pick a workspace folder.';
export function createXfer({ workspace, ownership, recovery, loose = () => false }) {
  async function baseOf(root) {
    if (root === undefined) return { base: workspace };
    if (typeof root !== 'string' || root.length > 4096 || root.includes('\0')) return refused(400, 'request-refused');
    if (path.isAbsolute(root)) {
      if (!loose()) return refused(403, 'unrestricted-only', { message: ROOT_LOCKED });
      // listDirectory wants a root that is its own realpath, and refuses P9's own folders (U5).
      const real = await realpath(root).catch(() => null);
      return real && await listDirectory(real, '').then(() => true, () => false) ? { base: real } : refused(409, 'folder-missing', { folder: root });
    }
    if (root && !relative(root)) return refused(400, 'request-refused');
    return await listDirectory(workspace, root).then(() => true, () => false) ? { base: root ? path.join(workspace, root) : workspace } : refused(409, 'folder-missing', { folder: root });
  }
  const root = ownership && path.join(ownership, 'xfer');
  // No resume across daemon runs, so staging left by an earlier run is dropped at start.
  const swept = root ? rm(root, { recursive: true, force: true }).catch(() => {}) : Promise.resolve();
  const uploads = new Map(), busy = new Set(), hashes = new Map(), HASH_CACHE = 50_000;
  const staging = (id, n) => path.join(root, 'in-' + id, String(n));
  // A send whose client died mid-send never aborts: after an hour with no piece or commit its list and staging go
  // (finding 20). A send that comes back later starts those files again (upload-mismatch).
  const touched = new Map(), IDLE = 3600 * 1000;
  const touch = (id) => touched.set(id, Date.now());
  setInterval(() => {
    for (const [id, at] of touched) if (Date.now() - at > IDLE) {
      touched.delete(id); uploads.delete(id);
      if (root) rm(path.join(root, 'in-' + id), { recursive: true, force: true }).catch(() => {});
    }
  }, 10 * 60 * 1000).unref();

  // Files under `base` (absolute), relative to it. Git folders: git's list, nested repos by their own list; others: a
  // walk that leaves out HEAVY folders and .git. Locked names and links are counted, never followed.
  async function list(base, prefix, skipped, out) {
    const tracked = await gitList(base, ['--cached', '--others', '--exclude-standard']);
    if (tracked) {
      skipped.ignored += (await gitList(base, ['--others', '--ignored', '--exclude-standard', '--directory', '--no-empty-directory']))?.length ?? 0;
      for (const entry of tracked) {
        const name = entry.replace(/\/$/, ''), full = path.join(base, name);
        // An empty submodule folder (never checked out) lists itself as './': walking it again would never end.
        if (full === base) { skipped.ignored += 1; continue; }
        const stat = await lstat(full).catch(() => null);
        if (stat?.isDirectory()) await list(full, prefix + name + '/', skipped, out); // a nested repo
        else if (stat) out.push(prefix + name);
      }
      return;
    }
    for (const entry of await readdir(base, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) {
        if (HEAVY.includes(entry.name) || entry.name === '.git') skipped.ignored += 1;
        else if (lockedName(entry.name)) skipped.locked += 1;
        else await list(path.join(base, entry.name), prefix + entry.name + '/', skipped, out);
      } else if (entry.isSymbolicLink()) skipped.links += 1;
      else if (entry.isFile()) out.push(prefix + entry.name);
      else skipped.special += 1;
    }
  }

  async function hashOf(full, stat) {
    const key = [stat.size, stat.mtimeMs, stat.ino].join(':'), known = hashes.get(full);
    if (known?.key === key) return known.sha256;
    const sha256 = await sha256File(full);
    // Keyed by absolute path for the daemon's life; a few manifests of large trees would otherwise hold tens of MB (review 2026-11-03).
    if (hashes.size >= HASH_CACHE) hashes.clear();
    hashes.set(full, { key, sha256 });
    return sha256;
  }

  // Syncthing marks each folder it syncs with .stfolder: in the folder, any folder above it, or any folder inside.
  async function syncthing(folder, files, base) {
    const found = new Set(), has = async (dir) => (await lstat(path.join(dir, '.stfolder')).catch(() => null)) !== null;
    for (let dir = path.dirname(base); ; dir = path.dirname(dir)) {
      if (await has(dir)) { found.add('..'); break; }
      if (dir === path.dirname(dir)) break;
    }
    const dirs = new Set(['']);
    for (let part = folder; part; part = part.includes('/') ? part.slice(0, part.lastIndexOf('/')) : '') dirs.add(part);
    for (const file of files) for (let dir = path.posix.dirname(file.path); dir !== '.'; dir = path.posix.dirname(dir)) dirs.add(dir);
    for (const dir of dirs) if (await has(path.join(base, dir))) found.add(dir);
    return [...found].sort();
  }

  return {
    async manifest(body) {
      const folder = body?.folder;
      if (typeof folder !== 'string' || (folder && !relative(folder))) return refused(400, 'request-refused');
      const { base, ...no } = await baseOf(body.root);
      if (!base) return no;
      // Checked as a chat's folder is (threat model row 24): no links, no locked names on the way.
      if (!await listDirectory(base, folder).then(() => true, () => false)) return refused(409, 'folder-missing', { folder });
      const skipped = { ignored: 0, links: 0, large: 0, special: 0, locked: 0 }, names = [], files = [];
      await list(folder ? path.join(base, folder) : base, folder ? folder + '/' : '', skipped, names);
      let truncated = false;
      for (const name of names.sort()) {
        if (name.split('/').some(lockedName)) { skipped.locked += 1; continue; }
        const full = path.join(base, name), stat = await lstat(full).catch(() => null);
        if (!stat) continue;
        if (stat.isSymbolicLink()) { skipped.links += 1; continue; }
        if (!stat.isFile()) { skipped.special += 1; continue; }
        if (stat.nlink !== 1) { skipped.links += 1; continue; }
        if (stat.size > MAX_FILE) { skipped.large += 1; continue; }
        if (files.length >= MAX_COUNT) { truncated = true; break; }
        files.push({ path: name, size: stat.size, sha256: await hashOf(full, stat), mtimeMs: Math.round(stat.mtimeMs) });
      }
      return { status: 200, files, skipped, truncated, syncthing: await syncthing(folder, files, base) };
    },
    // One piece of a workspace file, opened without following links (packages/files openSafe).
    async file(relativePath, offset, folderRoot) {
      if (!relative(relativePath) || !Number.isSafeInteger(offset) || offset < 0) return refused(400, 'request-refused');
      const { base, ...no } = await baseOf(folderRoot);
      if (!base) return no;
      const safe = await openSafe(base, relativePath);
      try { return await readPiece(safe.file, offset); } finally { await safe.close(); }
    },
    async part(id, body) {
      if (!ID.test(id) || !relative(body?.path) || !validPiece(body.offset, body.data)) return refused(400, 'request-refused');
      if (!root) return refused(503, 'xfer-unavailable');
      await swept;
      const paths = uploads.get(id) ?? new Map();
      uploads.set(id, paths); touch(id);
      if (!paths.has(body.path)) {
        if (paths.size >= MAX_COUNT) return refused(413, 'xfer-too-large');
        paths.set(body.path, paths.size);
      }
      await mkdir(path.dirname(staging(id, 0)), { recursive: true, mode: 0o700 });
      const { status, ...rest } = await appendPiece(staging(id, paths.get(body.path)), body.offset, body.data, MAX_FILE, busy, 'xfer-too-large');
      return { status, ...rest };
    },
    // Each staged file is checked whole first; then written one by one, so the answer says what was written if a
    // file changed meanwhile (all-or-nothing across files is not possible on a plain filesystem).
    async commit(id, body) {
      const file = (f) => relative(f?.path) && Number.isSafeInteger(f.size) && f.size >= 0 && f.size <= MAX_FILE && HASH.test(f.sha256) && (f.expect === null || HASH.test(f.expect));
      const gone = (f) => relative(f?.path) && HASH.test(f.expect);
      const files = body?.files ?? [], deletes = body?.deletes ?? [];
      if (!ID.test(id) || !Array.isArray(files) || !Array.isArray(deletes) || files.length + deletes.length > MAX_COUNT
          || !files.every(file) || !deletes.every(gone)) return refused(400, 'request-refused');
      if (!root) return refused(503, 'xfer-unavailable');
      const { base, ...no } = await baseOf(body.root);
      if (!base) return no;
      await swept;
      const paths = uploads.get(id) ?? new Map(), mismatch = [];
      for (const f of files) {
        if (!paths.has(f.path)) paths.set(f.path, paths.size);
        const staged = staging(id, paths.get(f.path));
        if (f.size === 0) { await mkdir(path.dirname(staged), { recursive: true, mode: 0o700 }); await appendFile(staged, '', { mode: 0o600 }); }
        if (!await checkStaged(staged, f.size, f.sha256)) { mismatch.push(f.path); await rm(staged, { force: true }); }
      }
      uploads.set(id, paths); touch(id);
      // A wrong piece cannot be fixed by appending: those files start again.
      if (mismatch.length) { for (const name of mismatch) paths.delete(name); return refused(409, 'upload-mismatch', { files: mismatch }); }
      const tag = new Date().toISOString().replace(/[:.]/g, '-') + '-' + id.slice(0, 8);
      const written = [], replaced = [], removed = [], changed = [];
      for (const f of files) {
        const staged = staging(id, paths.get(f.path)), result = await replaceFile(base, f.path, staged, f.expect, recovery, tag);
        await rm(staged, { force: true });
        if (result.kind === 'written') written.push(f.path); else changed.push(f.path);
        if (result.recovery && result.kind === 'written') replaced.push({ path: f.path, recovery: result.recovery });
      }
      for (const f of deletes) {
        const result = await removeFile(base, f.path, f.expect, recovery, tag);
        if (result.kind === 'changed') changed.push(f.path); else removed.push({ path: f.path, ...(result.recovery && { recovery: result.recovery }) });
      }
      const done = { written, replaced, removed };
      return changed.length ? refused(409, 'changed', { files: changed, ...done }) : { status: 200, ...done };
    },
    async abort(id) {
      if (!ID.test(id)) return refused(400, 'request-refused');
      uploads.delete(id); touched.delete(id);
      if (root) await rm(path.join(root, 'in-' + id), { recursive: true, force: true });
      return { status: 200, ok: true };
    },
  };
}
