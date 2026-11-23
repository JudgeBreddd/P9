// MC-15: edits made through the shell (sed, heredocs, a script) reach no Write or Edit tool call, so the chat's Changes list
// missed them. When the chat's folder is in a git repo, its working tree is written as a git tree at a prompted turn's start
// and again at its end, each through a spare index (the repo's own index and files are not touched; the new blobs are loose
// objects git prunes as unreachable). The files that differ, less those the agent's own finished edit calls named, come back
// as diffs (acp-v2.mjs diffs: hunks, added, deleted, from, binary), for one completed edit call "Shell edits" (chat.mjs).
// A folder outside git, git missing, or a step past its time gives null: nothing is added and the turn ends as before.
// Only the chat's folder is read and listed (add -- ., diff --relative), never the rest of a larger repo it sits in.
// No program the repo configures runs, whatever its config says while the snapshot runs: every git call that reads the
// working tree or diffs runs against a private git folder (made per snapshot, with its own config and nothing else), with
// system and global config off, so no filter, hook, fsmonitor, textconv or diff driver is configured there. The repo
// lends only its objects folder (where the trees go), a copy of its index (so add hashes only what changed) and its
// info/exclude. Its own config is read once, as data: the core settings that change how files are read, and the
// excludes file. On top, hooks and fsmonitor are turned off, diffs use no textconv or external diff, and no missing
// object is fetched.
// ponytail: a file another chat or the user changed in the same repo during the turn is counted as this turn's too.
// ponytail: a file the agent's edit call named and the shell then changed again is left to that call's own diff.
// ponytail: .gitignore'd files are not seen (build output, mostly what a user would not want listed either).
// ponytail: files are stored as they are on disk, never through a filter (git-lfs's pointer files show as the real content).
// ponytail: a split index (core.splitIndex) cannot be read from its copy, so such a repo adds nothing.
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
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

// env: the private folder's (box below); without it, a read of the repo itself (rev-parse, config: no program runs).
const git = (cwd, args, deadline, { env, flags = [] } = {}) => run('git', ['-C', cwd, '-c', 'core.quotePath=false', '-c', 'core.hooksPath=' + os.devNull,
  '-c', 'core.fsmonitor=false', ...flags, '--literal-pathspecs', ...args], {
  timeout: Math.max(50, deadline - Date.now()), maxBuffer: 8 << 20, windowsHide: true,
  env: { ...childEnv(), GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', ...env },
}).then((r) => r.stdout);
const none = (error) => { if (error.code === 1) return ''; throw error; }; // git config's exit 1: nothing set

// The private git folder for cwd's repo: HEAD, refs, a config of its own, the repo's index and info/exclude copied in.
// Its git(args) runs there, the repo's working tree and objects folder named by environment. done() removes it.
async function box(cwd, deadline) {
  const [top, index, objects, exclude, format] = (await git(cwd, ['rev-parse', '--show-toplevel', '--git-path', 'index', '--git-path', 'objects',
    '--git-path', 'info/exclude', '--show-object-format'], deadline)).split('\n');
  // How files are read (as data: "key value" lines): -c flags on each call. Nothing here names a program.
  const flags = (await git(cwd, ['config', '--get-regexp', '^core\\.(filemode|symlinks|ignorecase|precomposeunicode|autocrlf|eol|excludesfile)$'], deadline).catch(none))
    .split('\n').filter(Boolean).flatMap((l) => ['-c', l.includes(' ') ? l.replace(' ', '=') : l]);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-shell-'));
  try {
    await mkdir(path.join(dir, 'refs')); await mkdir(path.join(dir, 'info'));
    await writeFile(path.join(dir, 'HEAD'), 'ref: refs/heads/p9\n');
    await writeFile(path.join(dir, 'config'), `[core]\n\trepositoryformatversion = 1\n\tbare = false\n[extensions]\n\tobjectformat = ${format}\n`);
    // From the repo's own index, so add only hashes what changed since (a fresh repo has none yet).
    const keep = (error) => { if (error.code !== 'ENOENT') throw error; };
    await copyFile(path.resolve(cwd, index), path.join(dir, 'index')).catch(keep);
    await copyFile(path.resolve(cwd, exclude), path.join(dir, 'info', 'exclude')).catch(keep);
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
  const env = { GIT_DIR: dir, GIT_WORK_TREE: top, GIT_OBJECT_DIRECTORY: path.resolve(cwd, objects), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull };
  return { git: (args) => git(cwd, args, deadline, { env, flags }), done: () => rm(dir, { recursive: true, force: true }).catch(() => {}) };
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
    const deadline = Date.now() + LIMIT_MS, here = await realpath(cwd);
    b = await box(cwd, deadline);
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
