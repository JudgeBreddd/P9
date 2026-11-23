// MC-15: edits made through the shell (sed, heredocs, a script) reach no Write or Edit tool call, so the chat's Changes list
// missed them. When the chat's folder is in a git repo, its working tree is written as a git tree at a prompted turn's start
// and again at its end, each through a spare index (the repo's own index and files are not touched; the new blobs are loose
// objects git prunes as unreachable). The files that differ, less those the agent's own finished edit calls named, come back
// as diffs (acp-v2.mjs diffs: hunks, added, deleted, from, binary), for one completed edit call "Shell edits" (chat.mjs).
// A folder outside git, git missing, or a step past its time gives null: nothing is added and the turn ends as before.
// Only the chat's folder is read and listed (add -- ., diff --relative), never the rest of a larger repo it sits in.
// No program the repo configures runs, and nothing the repo's config or files say reaches git's arguments or environment.
// The repo is found on disk, not asked of git: the nearest folder at or above the chat's folder that holds a .git (O241: a file too).
// Every git call (add, write-tree, diff) runs with GIT_DIR set to a private folder made for that snapshot: HEAD, refs and
// a config of our own (constant), with system and global config off. From the repo it gets only paths built here (its
// working tree, .git/objects) and two copied files (.git/index, so add hashes only what changed, and .git/info/exclude,
// as ignore patterns). So no filter, hook, fsmonitor, textconv or diff driver is configured where git reads config,
// whatever the repo's config says, even while a snapshot runs. On top: hooks and fsmonitor off, diffs with no textconv or
// external diff, no missing object fetched. File names git lists reach the diff's pathspec only after "--", literal.
// ponytail: a file another chat or the user changed in the same repo during the turn is counted as this turn's too.
// ponytail: a file the agent's edit call named and the shell then changed again is left to that call's own diff.
// ponytail: .gitignore'd files are not seen (build output, mostly what a user would not want listed either).
// ponytail: files are stored as they are on disk, never through a filter (git-lfs's pointer files show as the real content).
// ponytail: a split index (core.splitIndex) cannot be read from its copy, so such a repo adds nothing.
// O241: a .git that is a file (a linked worktree, a submodule) is followed as one checked path, never as a git argument or
// setting (pointed below): its index is copied from the folder it names, info/exclude and objects come from the common one.
// ponytail: a sha256 repo adds nothing: reading the repo's object format would take a value from the repo.
// ponytail: the repo's own core settings (filemode, ignorecase, autocrlf) and a global core.excludesFile are not used;
// git's defaults are, and its default global ignore file (~/.config/git/ignore).
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { diffs } from './acp-v2.mjs';
import { childEnv } from './child-env.mjs';

const run = promisify(execFile);
// LIMIT_MS: each snapshot's whole run (every git call in it), so a turn waits at most this long at each end.
// FILES: the most files one turn lists. EVENT_BYTES: what the call's content and locations come to in all (each file's
// whole item: its path twice, a move's old path, its hunks), so the event stays under chat.mjs's MAX_EVENT (64 KB); a file
// past it is listed with no line rows if that fits, else left out.
export const LIMIT_MS = 3000, FILES = 40, EVENT_BYTES = 60 * 1024;

// p: the box's paths, built here (the private folder, the repo folder, its objects folder); every name below is fixed.
const git = (cwd, args, deadline, p) => run('git', ['-C', cwd, '-c', 'core.quotePath=false', '-c', 'core.hooksPath=' + os.devNull,
  '-c', 'core.fsmonitor=false', '--literal-pathspecs', ...args], {
  timeout: Math.max(50, deadline - Date.now()), maxBuffer: 8 << 20, windowsHide: true,
  env: { ...childEnv(), GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_DIR: p.dir, GIT_WORK_TREE: p.top, GIT_OBJECT_DIRECTORY: p.objects, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull },
}).then((r) => r.stdout);
const keep = (error) => { if (error.code !== 'ENOENT') throw error; };

// O241: the folders a .git FILE leads to, each checked, or the throw (the repo then adds nothing, as before). The file and
// commondir: a regular file (not a link, read through the handle its checks ran on) of at most 1 KB, one line, no control
// characters. Each folder: real path, a folder owned by this user. A linked worktree: its folder is <common>/worktrees/<name>
// and names this .git file back (its gitdir file, git's own back-link), so a pointer reaches another repo only through that
// repo's own entry for this folder. A submodule: no commondir, and its folder sits in <superproject>/.git/modules/, the
// superproject being the nearest folder above with a .git folder.
// ponytail: Windows has no owner id, so the owner check is skipped there; a submodule of a submodule adds nothing.
const ONE_LINE = /^([^\x00-\x1f\x7f]+)\n?$/;
// A regular file's bytes, read through one handle that refuses a link (O_NOFOLLOW where the system has it), checked on it.
async function bytes(file, max = Infinity) {
  const fh = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { const st = await fh.stat(); if (!st.isFile() || st.size > max) throw new Error('not a small file'); return { st, data: await fh.readFile() }; } finally { await fh.close(); }
}
async function line(file, prefix = '') {
  if (!(await lstat(file)).isFile()) throw new Error('not a file'); // O_NOFOLLOW is 0 on Windows
  const m = ONE_LINE.exec((await bytes(file, 1024)).data.toString('utf8'));
  if (!m || !m[1].startsWith(prefix) || !m[1].slice(prefix.length)) throw new Error('not one line');
  return m[1].slice(prefix.length);
}
async function folder(from, rel) {
  const at = await realpath(path.resolve(from, rel)), st = await stat(at), uid = process.getuid?.();
  if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) throw new Error('not our folder');
  return at;
}
async function pointed(file, top) {
  const dot = await folder(path.dirname(file), await line(file, 'gitdir: '));
  const back = await line(path.join(dot, 'gitdir')).catch(keep), cd = await line(path.join(dot, 'commondir')).catch(keep);
  if (cd !== undefined) {
    const common = await folder(dot, cd);
    if (path.join(common, 'worktrees', path.basename(dot)) !== dot) throw new Error('not its worktree entry');
    if (back === undefined || await realpath(path.resolve(dot, back)).catch(() => null) !== await realpath(file)) throw new Error('no back-link');
    return { dot, common };
  }
  for (let up = path.dirname(top); ; up = path.dirname(up)) {
    const st = await lstat(path.join(up, '.git')).catch(keep);
    if (st) {
      if (!st.isDirectory()) throw new Error('a submodule of a submodule');
      const modules = await realpath(path.join(up, '.git', 'modules'));
      if (!dot.startsWith(modules + path.sep)) throw new Error('not this superproject\'s submodule');
      return { dot, common: dot };
    }
    if (path.dirname(up) === up) throw new Error('no superproject');
  }
}

// The private git folder for the repo the chat's folder is in (the throw: none, or a .git file that fails pointed's checks). git(args)
// runs there from the chat's folder; here: that folder's real path; done() removes the private folder.
async function box(cwd, deadline) {
  const here = await realpath(cwd);
  let top = here, st;
  while (!(st = await lstat(path.join(top, '.git')).catch(keep))) { if (path.dirname(top) === top) throw new Error('not in git'); top = path.dirname(top); }
  const { dot, common } = st.isDirectory() ? { dot: path.join(top, '.git'), common: path.join(top, '.git') } : await pointed(path.join(top, '.git'), top);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-shell-'));
  try {
    await mkdir(path.join(dir, 'refs')); await mkdir(path.join(dir, 'info'));
    await writeFile(path.join(dir, 'HEAD'), 'ref: refs/heads/p9\n');
    await writeFile(path.join(dir, 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = false\n');
    // The copy keeps the index's own time (read first, so a newer index makes entries look racier, never surer): git trusts an
    // entry whose file is older than its index and checks again one that is not, so a file changed in the same second as the
    // index, at the same size, is still read (with the copy's later time it was taken as unchanged).
    // O241 review: both copies are read through a handle that refuses a link, and objects must be a folder, not a link.
    const ix = await bytes(path.join(dot, 'index')).catch(keep); // a fresh repo has none yet
    if (ix) { await writeFile(path.join(dir, 'index'), ix.data); await utimes(path.join(dir, 'index'), ix.st.atime, ix.st.mtime); }
    const ex = await bytes(path.join(common, 'info', 'exclude')).catch(keep);
    if (ex) await writeFile(path.join(dir, 'info', 'exclude'), ex.data);
    if (!(await lstat(path.join(common, 'objects'))).isDirectory()) throw new Error('objects is not a folder');
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
  const p = { dir, top, objects: path.join(common, 'objects') };
  return { here, git: (args) => git(here, args, deadline, p), done: () => rm(dir, { recursive: true, force: true }).catch(() => {}) };
}

// The working tree under cwd as a git tree, through the box's index.
const tree = async (b) => { await b.git(['add', '-A', '--', '.']); return (await b.git(['write-tree'])).trim(); };
async function snap(cwd, deadline) {
  const b = await box(cwd, deadline);
  try { return { tree: await tree(b) }; } finally { await b.done(); }
}

// The turn's start: its tree, or null (not a repo, or too slow).
export const shellStart = (cwd) => (cwd ? snap(cwd, Date.now() + LIMIT_MS).catch(() => null) : Promise.resolve(null));

// The turn's end: the diffs of files changed since from, or null. named: paths the agent's finished edit calls gave
// (absolute, or relative to the chat's folder).
export async function shellEnd(from, cwd, named = []) {
  if (!from) return null;
  let b;
  try {
    b = await box(cwd, Date.now() + LIMIT_MS);
    const { here } = b;
    const to = { tree: await tree(b) };
    if (to.tree === from.tree) return null;
    const own = new Set(await Promise.all([...named].map((p) => { const at = path.resolve(cwd, p); return realpath(at).catch(() => at); })));
    // -z name-status: "M\0path\0", "R100\0old\0new\0". A rename keeps its old path in the pathspec, so the patch still pairs them.
    // --relative: paths under the chat's folder only, relative to it.
    const parts = (await b.git(['diff', '--relative', '-M', '--name-status', '-z', from.tree, to.tree])).split('\0');
    const picked = [];
    for (let i = 0; i < parts.length - 1 && picked.length < FILES;) {
      const two = /^[RC]/.test(parts[i]), files = parts.slice(i + 1, i + (two ? 3 : 2));
      i += two ? 3 : 2;
      if (!own.has(path.join(here, files.at(-1)))) picked.push(...files);
    }
    if (!picked.length) return null;
    const patch = await b.git(['diff', '--relative', '-M', '--no-prefix', '--no-color', '--no-ext-diff', '--no-textconv', '-U3', from.tree, to.tree, '--', ...picked]);
    let left = EVENT_BYTES;
    const out = [];
    for (const d of diffs({ patch: { text: patch } })) {
      const full = { ...d, path: path.join(here, d.path), _meta: { ...d._meta, ...(d._meta.from && { from: path.join(here, d._meta.from) }) } };
      // Its item in content, its location ({"path":...}), and the commas between.
      const size = (c) => JSON.stringify(c).length + JSON.stringify({ path: c.path }).length + 2;
      const item = [full, { ...full, _meta: { ...full._meta, hunks: [] } }].find((c) => size(c) <= left);
      if (!item) break;
      left -= size(item); out.push(item);
    }
    return out.length ? out : null;
  } catch { return null; } finally { await b?.done(); }
}
