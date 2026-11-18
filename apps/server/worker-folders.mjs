// Worker folders (sprint spec A1, A2, A4, A6, A7; SECURITY.md § Worker folders). One clone of the repository per sprint
// in P9's own folder, one git worktree and branch per worker, made by P9 when the worker starts. The owner's folder is
// only read. gitFacts is what P9 reads from git by itself, for the sprint's version stamp.
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { endTree, launchTree, lookup, system32 } from './process-tree.mjs';
import { applySprint, closeOf, copyKeptBecause, git, previewSprint, startCopy } from './folder-copy.mjs';

const ID = /^[0-9a-f-]{36}$/;
const KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/; // open_chat's key rule
const HEX = /^[0-9a-f]{4,64}$/i;
export const WORKER = ':worker-folder'; // a chat's folder value: found again from its parent and key at every start
const SETUP_MS = 15 * 60_000; // ponytail: one cap for every setup command; a project whose install takes longer needs a setting
const ADDRESS_MARK = 'p9-from-address'; // inside an address clone's .git (daemon-4): lives and goes with the clone
const TAIL = 2000;
const SETUP_FROM = 'the project\'s, else Settings > Delegation';

// A1, a sprint's source as an address (SECURITY.md § Worker folders): https://, ssh:// or user@host:path, nothing else.
// The user name, the host and the path after user@host: never start with '-', so no part git or ssh could read as an
// option; no spaces or control characters.
// protocols is the test's door (file, for a clone with no network); the address clone's git gets the same list.
export function remoteOk(address, protocols = ['https', 'ssh']) {
  if (typeof address !== 'string' || !address || address.length > 2000 || /[\s\0-\x1f\x7f]/.test(address) || address.startsWith('-')) return false;
  const url = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(address);
  if (url) return protocols.includes(url[1].toLowerCase()) && (url[1].toLowerCase() === 'file' ? url[2].startsWith('/') : /^([\w.~][\w.~-]*(:[^@/]*)?@)?[a-z0-9][\w.-]*(:\d+)?\//i.test(url[2]) && (url[1].toLowerCase() !== 'https' || !/^[^/]*@/.test(url[2])));
  return protocols.includes('ssh') && !address.includes('::') && /^[\w.][\w.-]*@[a-z0-9][\w.-]*:[^:-]/i.test(address);
}

// git lives in folder-copy.mjs (imported here, not the other way round: a cycle between the two hangs the bundled daemon's start).
export { git };
const one = async (cwd, args) => { const r = await git(cwd, args); return r.code === 0 ? r.out.trim() : null; };
// File names as git wrote them with -z: never trimmed or unquoted, so an odd name stays itself. null when git failed.
const names = async (cwd, args) => { const r = await git(cwd, [...args.slice(0, 1), '-z', ...args.slice(1)]); return r.code === 0 ? r.out.split('\0').filter(Boolean) : null; };

// The main line of a repository: origin's default branch, else origin/main, else origin/master, else local main/master.
async function mainOf(folder) {
  const head = await one(folder, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']);
  if (head) return head;
  for (const ref of ['refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/main', 'refs/heads/master']) {
    if (await one(folder, ['rev-parse', '-q', '--verify', ref + '^{commit}'])) return ref;
  }
  return null;
}

// landed(dir, main, commit): the commit's work is in the main line. The commit is in it, or (daemon-6) after a squash merge, which makes a new commit,
// merging it in changes nothing, also when later PRs changed its files again: git's own three-way merge ends on the
// main line's exact tree. Work the main line later reverted or rewrote merges back in or conflicts, so it is kept. A conflict, an old git without merge-tree
// --write-tree (before 2.38), or any other failure reads as not landed (fail closed: kept, never lost). merge-tree
// writes loose objects where it runs: only Clean up asks, in the sprint's own clone, never the owner's repository.
async function landed(dir, main, commit) {
  if ((await git(dir, ['merge-base', '--is-ancestor', commit, main])).code === 0) return true;
  const merged = await git(dir, ['merge-tree', '--write-tree', '--no-messages', main, commit]);
  return merged.code === 0 && merged.out.trim() === await one(dir, ['rev-parse', '-q', '--verify', main + '^{tree}']);
}

// A7, the contract chunk 2 calls: null when folder is not a git repository. changed is null and inMain answers null when
// P9 cannot find a main line (unknown is open, never a guess). inMain(commit): the commit is in the main line, or, after a
// squash merge (which makes a new commit), merging it into the main line would change nothing there.
// at (O147): the commit a worker named, read instead of HEAD; commit is null when it is not a commit id this repository
// has (only hex is passed to git, so nothing in it reads as an option). head is always HEAD, for the caller's dirty check.
export async function gitFacts(folder, at) {
  if (await one(folder, ['rev-parse', '--is-inside-work-tree']) !== 'true') return null;
  const head = await one(folder, ['rev-parse', '-q', '--verify', 'HEAD^{commit}']);
  const commit = at === undefined ? head : typeof at === 'string' && HEX.test(at) ? await one(folder, ['rev-parse', '-q', '--verify', at + '^{commit}']) : null;
  const main = await mainOf(folder);
  const status = await git(folder, ['status', '--porcelain=v1', '--untracked-files=normal']);
  const changed = main && commit ? await names(folder, ['diff', '--no-ext-diff', '--name-only', main + '...' + commit]) : null;
  return {
    commit, head, main, dirty: status.code !== 0 || status.out.trim() !== '', changed,
    async inMain(asked) {
      if (!main) return null;
      if (typeof asked !== 'string' || !HEX.test(asked) || !await one(folder, ['rev-parse', '-q', '--verify', asked + '^{commit}'])) return false;
      return landed(folder, main, asked);
    },
  };
}

// A folder P9 made: it and the folders above it, up to the sprint's own, are real folders and not links.
async function realDir(at, levels = 1) {
  for (let i = 0; i < levels; i += 1, at = path.dirname(at)) if (!(await lstat(at).catch(() => null))?.isDirectory()) return false;
  return true;
}

// inner is outer, or sits inside it (both real paths).
const inside = (inner, outer) => inner === outer || inner.startsWith(outer.endsWith(path.sep) ? outer : outer + path.sep);
async function bytes(at) {
  let total = 0;
  for (const entry of await readdir(at, { recursive: true, withFileTypes: true }).catch(() => [])) {
    if (entry.isFile()) total += (await lstat(path.join(entry.parentPath ?? entry.path, entry.name)).catch(() => null))?.size ?? 0;
  }
  return total;
}
// The shell Node's shell: true uses, with the command line passed unchanged (launchTree's verbatim).
export const setupShell = (command, platform = process.platform, environment = process.env) => platform === 'win32'
  ? [lookup(environment, 'ComSpec') || system32('cmd.exe', environment), '/d', '/s', '/c', '"' + command + '"'] : ['/bin/sh', '-c', command];

// The owner's setup command, in the new folder, through their shell. Resolves to null, or the failure for the agent.
// It runs as a process tree P9 owns (process-tree.mjs: a kill-on-close Job Object on Windows, a process group elsewhere).
// At the cap the whole tree is stopped and the answer waits for that, bounded; a stop P9 cannot confirm is said.
function runSetup(command, cwd, limit) {
  return new Promise((finish) => {
    let tail = '', done = false, ending = false, timer;
    const resolve = (value) => { if (!done) { done = true; clearTimeout(timer); finish(value); } };
    const keep = (chunk) => { tail = (tail + chunk).slice(-TAIL); };
    const minutes = Math.round(limit / 60_000) + ' minutes';
    const shell = setupShell(command);
    let proc;
    try { proc = launchTree(shell, cwd, { stdio: ['ignore', 'pipe', 'pipe'], verbatim: true }); }
    catch (error) { resolve({ error: 'setup-failed', detail: 'The setup command did not start: ' + error.message }); return; }
    const { child } = proc;
    timer = setTimeout(async () => {
      ending = true;
      const ended = await endTree(proc);
      child.stdout.destroy(); child.stderr.destroy();
      resolve({ error: 'setup-failed', detail: ended === 'stopped'
        ? 'The setup command (' + SETUP_FROM + ') was stopped after ' + minutes + ', with everything it started. The worker was not started; its folder is kept. End of its output:\n' + tail
        : 'The setup command (' + SETUP_FROM + ') passed its ' + minutes + ' and P9 could not confirm that everything it started has stopped: check for it before trying again. The worker was not started; its folder is kept. End of its output:\n' + tail });
    }, limit);
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    child.on('error', (error) => { if (!ending) resolve({ error: 'setup-failed', detail: 'The setup command did not start: ' + error.message }); });
    child.on('close', (code) => {
      if (ending) return; // the cap's own answer, after the tree is confirmed stopped
      resolve(code === 0 ? null : { error: 'setup-failed', detail: 'The setup command (' + SETUP_FROM + ') ended with exit code ' + code
        + '. The worker was not started; its folder is kept. End of its output:\n' + tail });
    });
  });
}

// home: <ownership>/sprints. A sprint is the id of the chat that started the workers.
export function createWorkerFolders({ home, setupMs = SETUP_MS, protocols = ['https', 'ssh'] }) {
  const busy = new Map(); // one make or clean per sprint at a time: two workers never clone twice, clean never races a make
  const queued = (sprint, work) => {
    const run = (busy.get(sprint) ?? Promise.resolve()).then(work);
    busy.set(sprint, run.catch(() => {}));
    return run.catch((error) => ({ error: 'worker-folder-failed', detail: error.message }));
  };
  const dirOf = (sprint) => path.join(home, sprint);
  const branchOf = (sprint, item) => 'sprint/' + sprint.slice(0, 8) + '/' + item;
  const valid = async (sprint, item) => home && ID.test(sprint ?? '') && KEY.test(item ?? '') && (await git(undefined, ['check-ref-format', '--branch', branchOf(sprint, item)])).code === 0;

  // A1: the sprint's clone, made once: from the address the owner set for the project, else from the folder the worker
  // would have started in. With an address the owner's folder is not read at all.
  async function cloneFor(sprint, source, address = '') {
    const clone = path.join(dirOf(sprint), 'clone'), copy = path.join(dirOf(sprint), 'copy');
    // A sprint from a folder with no remote, or a folder inside a larger repository: its copy (folder-copy.mjs), made once.
    if (await realDir(copy, 2)) {
      if (address) return { clone: copy };
      const record = await readFile(path.join(dirOf(sprint), 'copy-record.json'), 'utf8').then(JSON.parse, () => null);
      const real = typeof source === 'string' && path.isAbsolute(source) ? await realpath(source).catch(() => null) : null;
      if (real && record?.source === real) return { clone: copy };
      return { error: 'other-repository', detail: 'This sprint\'s worker folders all come from one copy, made from another folder: a sprint has one repository. Leave folder out, name the folder the sprint started from, or start this work from another chat.' };
    }
    if (await realDir(clone, 2)) {
      // One repository per sprint (dogfood 3.5): a folder of another one is refused, never handed this clone. Its
      // origin is the folder's own origin, else the folder itself, as the clone below was made.
      // daemon-4: a clone made from an address stays this sprint's after the owner clears or respells it (SECURITY.md
      // § A sprint from an address): no folder is read for it, as while the address was set.
      if (address || typeof source !== 'string' || !path.isAbsolute(source)) return { clone };
      if (await lstat(path.join(clone, '.git', ADDRESS_MARK)).then((s) => s.isFile(), () => false)) return { clone };
      const top = await one(source, ['rev-parse', '--show-toplevel']);
      const from = top && ((await one(top, ['remote', 'get-url', 'origin'])) || top);
      if (from && from === await one(clone, ['remote', 'get-url', 'origin'])) return { clone };
      return { error: 'other-repository', detail: 'This sprint\'s worker folders all come from one clone, made from another repository: a sprint has one repository. Leave folder out, name a folder of that repository, or start this work from another chat.' };
    }
    if (address) {
      if (!remoteOk(address, protocols)) return { error: 'source-refused', detail: 'The project\'s sprint source is not an address P9 clones from (https://, ssh:// or user@host:path).' };
      await mkdir(dirOf(sprint), { recursive: true, mode: 0o700 });
      const part = path.join(dirOf(sprint), 'clone.part-' + randomBytes(4).toString('hex'));
      // Only these transports, whatever the address says (ext:: would run a command, file:// would read a local path).
      const only = ['-c', 'protocol.allow=never', ...protocols.flatMap((name) => ['-c', 'protocol.' + name + '.allow=always'])];
      const made = await git(dirOf(sprint), [...only, 'clone', '--quiet', '--no-checkout', '--', address, part], { timeout: 10 * 60_000 });
      if (made.code !== 0) { await rm(part, { recursive: true, force: true }); return { error: 'clone-failed', detail: made.err.slice(-TAIL) }; }
      if ((await git(part, ['remote', 'set-head', 'origin', '--auto'])).code !== 0) await git(part, ['remote', 'set-head', 'origin', '--delete']);
      // The mark lives inside the clone's own .git, written before the rename: it exists exactly when this clone does,
      // so a removed or interrupted clone never leaves it for a later folder clone (Reviewer on #245).
      await writeFile(path.join(part, '.git', ADDRESS_MARK), 'address\n', { mode: 0o600 });
      await rename(part, clone);
      return { clone };
    }
    // Never git's own default: with no folder git would run in the daemon's working directory.
    if (typeof source !== 'string' || !path.isAbsolute(source)) return { error: 'folder-refused', detail: 'The worker\'s folder is not one P9 may use.' };
    const top = await one(source, ['rev-parse', '--show-toplevel']);
    if (!top) return { error: 'not-a-repository', detail: 'A worker folder is made from a git repository; this folder is not one: ' + source };
    // SECURITY.md § Sprint from a folder with no remote: a folder that holds or sits inside P9's state, the home folder or
    // the workspace is refused before anything is copied. A folder inside a larger repository, or with no origin, is copied
    // alone (startCopy), never cloned: the parent's files and history are not read.
    const real = await realpath(source).catch(() => null), realTop = await realpath(top).catch(() => null);
    if (!real || !realTop) return { error: 'folder-refused', detail: 'The worker\'s folder is not one P9 may use.' };
    if ([home, os.homedir(), path.join(os.homedir(), 'workspace')].some((x) => inside(x, real)) || inside(real, home)) {
      return { error: 'folder-refused', detail: 'A sprint cannot start from this folder: it holds, or sits inside, P9\'s own state, the home folder or the workspace. Name another folder.' };
    }
    const origin = real === realTop ? await one(top, ['remote', 'get-url', 'origin']) : null;
    if (real !== realTop || !origin) {
      const made = await startCopy(dirOf(sprint), real);
      if (made.error) return { error: made.error === 'record-failed' ? 'copy-failed' : made.error, detail: made.detail ?? 'The folder could not be copied.' };
      return { clone: made.copy };
    }
    await mkdir(dirOf(sprint), { recursive: true, mode: 0o700 });
    const part = path.join(dirOf(sprint), 'clone.part-' + randomBytes(4).toString('hex'));
    const made = await git(dirOf(sprint), ['clone', '--quiet', '--no-checkout', '--', top, part], { timeout: 10 * 60_000 });
    if (made.code !== 0) { await rm(part, { recursive: true, force: true }); return { error: 'clone-failed', detail: made.err.slice(-TAIL) }; }
    // Which folder the clone came from, inside the clone's own config, for clear(): origin is changed to the real remote below.
    await git(part, ['config', 'p9.from', top]);
    const remote = await one(top, ['remote', 'get-url', 'origin']);
    if (remote) {
      await git(part, ['remote', 'set-url', 'origin', remote]);
      // The real remote's branches, so a worker starts from its main line. Offline: the folder's own branches stand in.
      const fetched = await git(part, ['fetch', '--quiet', 'origin'], { timeout: 5 * 60_000 });
      if (fetched.code !== 0 || (await git(part, ['remote', 'set-head', 'origin', '--auto'])).code !== 0) await git(part, ['remote', 'set-head', 'origin', '--delete']);
    } else await git(part, ['remote', 'set-head', 'origin', '--delete']); // the owner's checked-out branch is not a main line
    await rename(part, clone);
    return { clone };
  }

  // A2 (and A4): the worker's folder and branch. The same sprint and item return the folder made before.
  async function make(sprint, item, source, setup = '', address = '') {
    if (!await valid(sprint, item)) return { error: 'request-refused', detail: 'A worker folder needs a key of a-z 0-9 . _ - that is also a git branch name.' };
    return queued(sprint, async () => {
      const folder = path.join(dirOf(sprint), 'workers', item), branch = branchOf(sprint, item);
      // ready/<item>: written once the setup command passed, so a folder whose setup failed runs it again next time.
      const ready = path.join(dirOf(sprint), 'ready', item);
      if (await realDir(folder, 3) && await lstat(ready).then((s) => s.isFile(), () => false)) return { folder, branch };
      const { clone, error, detail } = await cloneFor(sprint, source, address);
      if (error) return { error, detail };
      const main = await mainOf(clone);
      if (!main) return { error: 'no-main-line', detail: 'The repository has no main or master branch, here or on its origin.' };
      if (!await realDir(folder, 3)) {
        await mkdir(path.dirname(folder), { recursive: true, mode: 0o700 });
        const has = (await git(clone, ['rev-parse', '-q', '--verify', 'refs/heads/' + branch])).code === 0;
        const added = await git(clone, ['worktree', 'add', '--quiet', ...(has ? [folder, branch] : ['-b', branch, folder, main])], { timeout: 5 * 60_000 });
        if (added.code !== 0) return { error: 'worktree-failed', detail: added.err.slice(-TAIL) };
      }
      const failed = setup.trim() ? await runSetup(setup, folder, setupMs) : null;
      if (failed) return failed;
      await mkdir(path.dirname(ready), { recursive: true, mode: 0o700 });
      await writeFile(ready, '');
      return { folder, branch, main };
    });
  }

  // Where a worker chat starts: its folder, only if it is still a real folder made here. Else null.
  async function where(sprint, item) {
    if (!home || !ID.test(sprint ?? '') || !KEY.test(item ?? '')) return null;
    const folder = path.join(dirOf(sprint), 'workers', item);
    return await realDir(folder, 3) ? folder : null;
  }

  // A6: remove only folders with nothing unsaved whose work is in the main line; keep and list the rest.
  async function clean(sprint) {
    if (!home || !ID.test(sprint ?? '')) return { error: 'request-refused' };
    return queued(sprint, () => cleanNow(sprint));
  }
  async function cleanNow(sprint) {
    const copy = path.join(dirOf(sprint), 'copy'), hasCopy = await realDir(copy, 2), root = path.join(dirOf(sprint), 'workers');
    const clone = hasCopy ? copy : path.join(dirOf(sprint), 'clone');
    if (!await realDir(clone, 2)) return { removed: [], kept: [] };
    // Best effort: offline, the main line known so far. A copy has no origin of its own (SECURITY.md): it is never fetched.
    if (!hasCopy) await git(clone, ['fetch', '--quiet', 'origin'], { timeout: 5 * 60_000 });
    const removed = [], kept = [];
    for (const item of (await readdir(root).catch(() => [])).sort()) {
      const folder = path.join(root, item), branch = branchOf(sprint, item);
      const facts = KEY.test(item) && await realDir(folder, 3) ? await gitFacts(folder) : null;
      // The folder must still be on its own sprint branch, and that branch's tip is what is checked: a worker that
      // switched branches (or detached) keeps its folder and branch, whatever the folder now shows.
      const on = facts && await one(folder, ['symbolic-ref', '-q', 'HEAD']);
      const tip = facts && await one(clone, ['rev-parse', '-q', '--verify', 'refs/heads/' + branch + '^{commit}']);
      const why = !facts ? 'not a worker folder' : on !== 'refs/heads/' + branch || !tip || tip !== facts.commit ? 'not on its sprint branch'
        : facts.dirty ? 'unsaved changes' : await facts.inMain(tip) !== true ? 'not in the main line' : null;
      if (!why && (await git(clone, ['worktree', 'remove', folder])).code === 0) {
        // Deleted only if the tip is still the one checked (a commit made meanwhile keeps the branch).
        await git(clone, ['update-ref', '-d', 'refs/heads/' + branch, tip]);
        await rm(path.join(dirOf(sprint), 'ready', item), { force: true });
        removed.push(item);
      } else kept.push({ item, folder, branch, bytes: await bytes(folder), why: why ?? 'git would not remove it' });
    }
    // The clone goes only when no worker folder and no sprint branch is left in it: a branch is never lost with it. The
    // sprint's own files (plan, rules, roles, notes: sprint-files.mjs) stay; the folder goes only when nothing else is in it.
    if (!kept.length && !await one(clone, ['for-each-ref', '--count=1', '--format=%(refname)', 'refs/heads/sprint/']) && await clear(clone)) {
      // The copy (folder-copy.mjs) goes only once its work is provably applied (copyKeptBecause); its apply record stays.
      const parts = ['workers', 'ready', 'clone'];
      if (await copyKeptBecause(dirOf(sprint)) === null) parts.push('copy');
      for (const part of parts) await rm(path.join(dirOf(sprint), part), { recursive: true, force: true });
      await rmdir(dirOf(sprint)).catch(() => {});
    }
    return { removed, kept };
  }

  // daemon-6 (lead): the clone holds every worker's branches and stashes, not only the sprint branches. It goes only when
  // nothing is stashed and every local branch's work is in the main line or held outside the clone: a remote-tracking
  // ref contains its tip (pushed, or, in a folder clone, the owner's own branch as cloned from the owner's folder, which
  // still has it). A git failure keeps it.
  // A local branch may go with the clone only when its tip has landed, or a branch or tag that exists now in the folder the
  // clone was made from (p9.from) or in a remote on this disk holds it. The clone's own remote-tracking refs are not asked:
  // they date from the clone or the last fetch, and the outside branch may since be reset or deleted (Reviewer #246). A
  // remote at an address cannot be asked, and a git that cannot answer (the commit is not there, the folder is gone)
  // leaves the branch unproven: the clone stays.
  async function clear(clone) {
    const main = await mainOf(clone);
    const heads = main && await git(clone, ['for-each-ref', '--format=%(objectname)', 'refs/heads/']);
    if (!heads || heads.code !== 0 || await one(clone, ['rev-parse', '-q', '--verify', 'refs/stash'])) return false;
    const outside = [await one(clone, ['config', '--get', 'p9.from']), await one(clone, ['remote', 'get-url', 'origin'])].filter((d) => d && path.isAbsolute(d));
    next: for (const tip of heads.out.split('\n').filter(Boolean)) {
      for (const dir of outside) if (await one(dir, ['for-each-ref', '--count=1', '--contains', tip, '--format=%(refname)', 'refs/heads/', 'refs/tags/'])) continue next;
      if (!await landed(clone, main, tip)) return false;
    }
    return true;
  }

  // O164 (done means merged): whether P9 holds a repository a merge can be proven in — the sprint's copy (never
  // fetched; its own main line answers), else its clone, else nothing. null is why a count cannot be proven, not 0.
  async function repoOf(sprint) {
    if (!home || !ID.test(sprint ?? '')) return null;
    if (await realDir(path.join(dirOf(sprint), 'copy'), 2)) return 'copy';
    if (await realDir(path.join(dirOf(sprint), 'clone'), 2)) return 'clone';
    return null;
  }

  // O164 (done means merged): P9's own evidence that a reviewed head reached the sprint's main line, for each commit
  // asked about. One fetch first, best effort (as cleanNow: offline, the main line known so far); a copy is never
  // fetched. Then landed: the commit is in the main line, or, after a squash merge, merging it in changes nothing.
  // A commit this repository does not have, a missing clone or any other failure reads as not merged (fail closed):
  // an unproven commit is left for the next look, never recorded as merged.
  async function merged(sprint, commits) {
    const out = new Map();
    if (!home || !ID.test(sprint ?? '') || !Array.isArray(commits)) return out;
    const repo = await repoOf(sprint);
    if (!repo) return out;
    const clone = path.join(dirOf(sprint), repo);
    if (repo === 'clone') await git(clone, ['fetch', '--quiet', 'origin'], { timeout: 15_000 }); // FIX1: a slow remote must not hold an answer for minutes; the record stands until the next look
    const main = await mainOf(clone);
    if (!main) return out;
    for (const commit of commits) if (typeof commit === 'string' && HEX.test(commit)) out.set(commit, await landed(clone, main, commit));
    return out;
  }

  // The owner's consent (folder-copy.mjs): preview is read-only; apply runs in the sprint's queue, so it never races a clean.
  async function preview(sprint) {
    if (!home || !ID.test(sprint ?? '')) return { refused: 'request-refused' };
    return previewSprint(dirOf(sprint));
  }
  async function apply(sprint, consent) {
    if (!home || !ID.test(sprint ?? '')) return { refused: 'request-refused' };
    return queued(sprint, () => applySprint(dirOf(sprint), consent));
  }
  // The close view: read-only, so it runs without the sprint's queue. Null (not-applied) until the owner's apply is recorded.
  async function close(sprint) {
    if (!home || !ID.test(sprint ?? '')) return { error: 'request-refused' };
    return (await closeOf(dirOf(sprint))) ?? { error: 'not-applied' };
  }
  // The copies P9 made, for the desktop's review list: each sprint id, and whether its apply is recorded. Read-only.
  async function copies() {
    const out = [];
    for (const id of home ? (await readdir(home).catch(() => [])).filter((n) => ID.test(n)).sort() : []) {
      const dir = path.join(home, id);
      if (!await lstat(path.join(dir, 'copy-record.json')).then(() => true, () => false)) continue;
      out.push({ id, applied: await lstat(path.join(dir, 'apply-result.json')).then(() => true, () => false) });
    }
    return { copies: out };
  }
  return { make, where, clean, preview, apply, close, copies, merged, repoOf };
}
