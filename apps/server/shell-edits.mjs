// MC-15: edits made through the shell (sed, heredocs, a script) reach no Write or Edit tool call, so the chat's Changes list
// missed them. When the chat's folder is in a git repo, its working tree is written as a git tree at a prompted turn's start
// and again at its end, each through a spare index (the repo's own index and files are not touched; the new blobs are loose
// objects git prunes as unreachable). The files that differ, less those the agent's own finished edit calls named, come back
// as diffs (acp-v2.mjs diffs: hunks, added, deleted, from, binary), for one completed edit call "Shell edits" (chat.mjs).
// A folder outside git, git missing, or a step past its time gives null: nothing is added and the turn ends as before.
// Only the chat's folder is read and listed (add -- ., diff --relative), never the rest of a larger repo it sits in.
// No program the repo configures runs, and nothing the repo's config or files say reaches git's arguments or environment.
// The repo is found on disk, not asked of git: the nearest folder at or above the chat's folder that holds a .git folder.
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
// ponytail: a .git that is a file (a linked worktree, a submodule) or a sha256 repo adds nothing: following the file, or
// reading the repo's object format, would take a value from the repo.
// ponytail: the repo's own core settings (filemode, ignorecase, autocrlf) and a global core.excludesFile are not used;
// git's defaults are, and its default global ignore file (~/.config/git/ignore).
import { execFile } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
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

const git = (cwd, args, deadline, env) => run('git', ['-C', cwd, '-c', 'core.quotePath=false', '-c', 'core.hooksPath=' + os.devNull,
  '-c', 'core.fsmonitor=false', '--literal-pathspecs', ...args], {
  timeout: Math.max(50, deadline - Date.now()), maxBuffer: 8 << 20, windowsHide: true,
  env: { ...childEnv(), GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', ...env },
}).then((r) => r.stdout);
const keep = (error) => { if (error.code !== 'ENOENT') throw error; };

// The private git folder for the repo the chat's folder is in (the throw: none, or its .git is not a folder). git(args)
// runs there from the chat's folder; here: that folder's real path; done() removes the private folder.
async function box(cwd, deadline) {
  const here = await realpath(cwd);
  let top = here, st;
  while (!(st = await lstat(path.join(top, '.git')).catch(keep))) { if (path.dirname(top) === top) throw new Error('not in git'); top = path.dirname(top); }
  if (!st.isDirectory()) throw new Error('.git is not a folder');
  const dot = path.join(top, '.git'), dir = await mkdtemp(path.join(os.tmpdir(), 'p9-shell-'));
  try {
    await mkdir(path.join(dir, 'refs')); await mkdir(path.join(dir, 'info'));
    await writeFile(path.join(dir, 'HEAD'), 'ref: refs/heads/p9\n');
    await writeFile(path.join(dir, 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = false\n');
    await copyFile(path.join(dot, 'index'), path.join(dir, 'index')).catch(keep); // a fresh repo has none yet
    await copyFile(path.join(dot, 'info', 'exclude'), path.join(dir, 'info', 'exclude')).catch(keep);
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
  const env = { GIT_DIR: dir, GIT_WORK_TREE: top, GIT_OBJECT_DIRECTORY: path.join(dot, 'objects'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull };
  return { here, git: (args) => git(here, args, deadline, env), done: () => rm(dir, { recursive: true, force: true }).catch(() => {}) };
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
