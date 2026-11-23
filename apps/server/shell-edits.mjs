// MC-15: edits made through the shell (sed, heredocs, a script) reach no Write or Edit tool call, so the chat's Changes list
// missed them. When the chat's folder is in a git repo, its working tree is written as a git tree at a prompted turn's start
// and again at its end, each through a spare index (the repo's own index and files are not touched; the new blobs are loose
// objects git prunes as unreachable). The files that differ, less those the agent's own finished edit calls named, come back
// as diffs (acp-v2.mjs diffs: hunks, added, deleted, from, binary), for one completed edit call "Shell edits" (chat.mjs).
// A folder outside git, git missing, or a step past its time gives null: nothing is added and the turn ends as before.
// ponytail: a file another chat or the user changed in the same repo during the turn is counted as this turn's too.
// ponytail: a file the agent's edit call named and the shell then changed again is left to that call's own diff.
// ponytail: .gitignore'd files are not seen (build output, mostly what a user would not want listed either).
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, realpath, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { diffs } from './acp-v2.mjs';
import { childEnv } from './child-env.mjs';

const run = promisify(execFile);
// LIMIT_MS: each snapshot's whole run (every git call in it), so a turn waits at most this long at each end.
// FILES: the most files one turn lists. HUNK_BYTES: the hunks one call carries in all, so its event stays under chat.mjs's
// MAX_EVENT (64 KB); a file past it is still listed (path, created, deleted), with no line rows.
export const LIMIT_MS = 3000, FILES = 40, HUNK_BYTES = 48 * 1024;

const git = (cwd, args, deadline, index) => run('git', ['-C', cwd, '-c', 'core.quotePath=false', '--literal-pathspecs', ...args], {
  timeout: Math.max(50, deadline - Date.now()), maxBuffer: 8 << 20, windowsHide: true,
  env: { ...childEnv(), GIT_OPTIONAL_LOCKS: '0', ...(index && { GIT_INDEX_FILE: index }) },
}).then((r) => r.stdout);

async function snap(cwd, deadline) {
  const [top, index] = (await git(cwd, ['rev-parse', '--show-toplevel', '--git-path', 'index'], deadline)).split('\n');
  const spare = path.join(os.tmpdir(), 'p9-shell-' + randomBytes(8).toString('hex'));
  try {
    // From the repo's own index, so add only hashes what changed since (a fresh repo has none yet).
    await copyFile(path.resolve(cwd, index), spare).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    await git(top, ['add', '-A'], deadline, spare);
    return { top, tree: (await git(top, ['write-tree'], deadline, spare)).trim() };
  } finally { await unlink(spare).catch(() => {}); }
}

// The turn's start: its tree, or null (not a repo, or too slow).
export const shellStart = (cwd) => (cwd ? snap(cwd, Date.now() + LIMIT_MS).catch(() => null) : Promise.resolve(null));

// The turn's end: the diffs of files changed since from, or null. named: paths the agent's finished edit calls gave
// (absolute, or relative to the chat's folder).
export async function shellEnd(from, cwd, named = []) {
  if (!from) return null;
  try {
    const deadline = Date.now() + LIMIT_MS, to = await snap(cwd, deadline);
    if (to.tree === from.tree) return null;
    const own = new Set(await Promise.all([...named].map((p) => { const at = path.resolve(cwd, p); return realpath(at).catch(() => at); })));
    // -z name-status: "M\0path\0", "R100\0old\0new\0". A rename keeps its old path in the pathspec, so the patch still pairs them.
    const parts = (await git(to.top, ['diff', '-M', '--name-status', '-z', from.tree, to.tree], deadline)).split('\0');
    const picked = [];
    for (let i = 0; i < parts.length - 1 && picked.length < FILES;) {
      const two = /^[RC]/.test(parts[i]), files = parts.slice(i + 1, i + (two ? 3 : 2));
      i += two ? 3 : 2;
      if (!own.has(path.join(to.top, files.at(-1)))) picked.push(...files);
    }
    if (!picked.length) return null;
    const patch = await git(to.top, ['diff', '-M', '--no-prefix', '--no-color', '--no-ext-diff', '-U3', from.tree, to.tree, '--', ...picked], deadline);
    let left = HUNK_BYTES;
    return diffs({ patch: { text: patch } }).map((d) => {
      const size = JSON.stringify(d._meta.hunks).length, fits = size <= left;
      if (fits) left -= size;
      return { ...d, path: path.join(to.top, d.path), _meta: { ...d._meta, ...(d._meta.from && { from: path.join(to.top, d._meta.from) }), hunks: fits ? d._meta.hunks : [] } };
    });
  } catch { return null; }
}
