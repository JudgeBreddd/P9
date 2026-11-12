// Worker folders (sprint spec A1, A2, A4, A6, A7; SECURITY.md § Worker folders). One clone of the repository per sprint
// in P9's own folder, one git worktree and branch per worker, made by P9 when the worker starts. The owner's folder is
// only read. gitFacts is what P9 reads from git by itself, for the sprint's version stamp.
import { execFile, spawn } from 'node:child_process';
import { lstat, mkdir, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { childEnv } from './child-env.mjs';

const ID = /^[0-9a-f-]{36}$/;
const KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/; // open_chat's key rule
const HEX = /^[0-9a-f]{4,64}$/i;
export const WORKER = ':worker-folder'; // a chat's folder value: found again from its parent and key at every start
const SETUP_MS = 15 * 60_000; // ponytail: one cap for every setup command; a project whose install takes longer needs a setting
const TAIL = 2000;

// Every git P9 runs: allow-listed environment, never a prompt, no hooks, no file-system monitor, no external diff.
// ponytail: a clean or smudge filter in the repository's own config still runs on status (SECURITY.md says so).
export function git(cwd, args, { timeout = 60_000 } = {}) {
  const env = { ...childEnv(), GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0' };
  const safe = ['-c', 'core.hooksPath=' + os.devNull, '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat'];
  return new Promise((resolve) => execFile('git', [...safe, ...args], { cwd, env, timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
    (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, out: String(stdout), err: String(stderr) })));
}
const one = async (cwd, args) => { const r = await git(cwd, args); return r.code === 0 ? r.out.trim() : null; };
const lines = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean);

// The main line of a repository: origin's default branch, else origin/main, else origin/master, else local main/master.
async function mainOf(folder) {
  const head = await one(folder, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']);
  if (head) return head;
  for (const ref of ['refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/main', 'refs/heads/master']) {
    if (await one(folder, ['rev-parse', '-q', '--verify', ref + '^{commit}'])) return ref;
  }
  return null;
}

// A7, the contract chunk 2 calls: null when folder is not a git repository. changed is null and inMain answers null when
// P9 cannot find a main line (unknown is open, never a guess). inMain(commit): the commit is in the main line, or, after a
// squash merge (which makes a new commit), every file it changed against the main line is the same there now.
export async function gitFacts(folder) {
  if (await one(folder, ['rev-parse', '--is-inside-work-tree']) !== 'true') return null;
  const commit = await one(folder, ['rev-parse', '-q', '--verify', 'HEAD^{commit}']);
  const main = await mainOf(folder);
  const status = await git(folder, ['status', '--porcelain=v1', '--untracked-files=normal']);
  const changed = main && commit ? await one(folder, ['diff', '--no-ext-diff', '--name-only', main + '...' + commit, '--']) : null;
  return {
    commit, main, dirty: status.code !== 0 || status.out.trim() !== '', changed: changed === null ? null : lines(changed),
    async inMain(asked) {
      if (!main) return null;
      if (typeof asked !== 'string' || !HEX.test(asked) || !await one(folder, ['rev-parse', '-q', '--verify', asked + '^{commit}'])) return false;
      if ((await git(folder, ['merge-base', '--is-ancestor', asked, main])).code === 0) return true;
      const base = await one(folder, ['merge-base', asked, main]);
      const files = base && lines(await one(folder, ['diff', '--no-ext-diff', '--name-only', base, asked, '--']) ?? '');
      // ponytail: a file the main line changed again after the merge reads as not merged (kept, never lost).
      return Boolean(files?.length) && (await git(folder, ['diff', '--no-ext-diff', '--quiet', asked, main, '--', ...files])).code === 0;
    },
  };
}

// A folder P9 made: it and the folders above it, up to the sprint's own, are real folders and not links.
async function realDir(at, levels = 1) {
  for (let i = 0; i < levels; i += 1, at = path.dirname(at)) if (!(await lstat(at).catch(() => null))?.isDirectory()) return false;
  return true;
}
async function bytes(at) {
  let total = 0;
  for (const entry of await readdir(at, { recursive: true, withFileTypes: true }).catch(() => [])) {
    if (entry.isFile()) total += (await lstat(path.join(entry.parentPath ?? entry.path, entry.name)).catch(() => null))?.size ?? 0;
  }
  return total;
}
// The owner's setup command, in the new folder, through their shell. Resolves to null, or the failure for the agent.
function runSetup(command, cwd) {
  return new Promise((resolve) => {
    let tail = '';
    const keep = (chunk) => { tail = (tail + chunk).slice(-TAIL); };
    const child = spawn(command, { cwd, shell: true, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    const timer = setTimeout(() => { try { process.platform === 'win32' ? child.kill() : process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, SETUP_MS);
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    child.on('error', (error) => { clearTimeout(timer); resolve({ error: 'setup-failed', detail: 'The setup command did not start: ' + error.message }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve(code === 0 ? null : { error: 'setup-failed', detail: 'The setup command (Settings > Delegation) ' + (signal ? 'was stopped after ' + SETUP_MS / 60_000 + ' minutes' : 'ended with exit code ' + code)
        + '. The worker was not started; its folder is kept. End of its output:\n' + tail });
    });
  });
}

// home: <ownership>/sprints. A sprint is the id of the chat that started the workers.
export function createWorkerFolders({ home }) {
  const busy = new Map(); // one make per sprint at a time, so two workers never clone twice or race on the clone
  const dirOf = (sprint) => path.join(home, sprint);
  const branchOf = (sprint, item) => 'sprint/' + sprint.slice(0, 8) + '/' + item;
  const valid = async (sprint, item) => home && ID.test(sprint ?? '') && KEY.test(item ?? '') && (await git(undefined, ['check-ref-format', '--branch', branchOf(sprint, item)])).code === 0;

  // A1: the sprint's clone, made once from the folder the worker would have started in.
  async function cloneFor(sprint, source) {
    const clone = path.join(dirOf(sprint), 'clone');
    if (await realDir(clone, 2)) return { clone };
    const top = await one(source, ['rev-parse', '--show-toplevel']);
    if (!top) return { error: 'not-a-repository', detail: 'A worker folder is made from a git repository; this folder is not one: ' + source };
    await mkdir(dirOf(sprint), { recursive: true, mode: 0o700 });
    const part = path.join(dirOf(sprint), 'clone.part-' + randomBytes(4).toString('hex'));
    const made = await git(dirOf(sprint), ['clone', '--quiet', '--no-checkout', '--', top, part], { timeout: 10 * 60_000 });
    if (made.code !== 0) { await rm(part, { recursive: true, force: true }); return { error: 'clone-failed', detail: made.err.slice(-TAIL) }; }
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
  async function make(sprint, item, source, setup = '') {
    if (!await valid(sprint, item)) return { error: 'request-refused', detail: 'A worker folder needs a key of a-z 0-9 . _ - that is also a git branch name.' };
    const previous = busy.get(sprint) ?? Promise.resolve();
    const run = previous.then(async () => {
      const folder = path.join(dirOf(sprint), 'workers', item), branch = branchOf(sprint, item);
      // ready/<item>: written once the setup command passed, so a folder whose setup failed runs it again next time.
      const ready = path.join(dirOf(sprint), 'ready', item);
      if (await realDir(folder, 3) && await lstat(ready).then((s) => s.isFile(), () => false)) return { folder, branch };
      const { clone, error, detail } = await cloneFor(sprint, source);
      if (error) return { error, detail };
      const main = await mainOf(clone);
      if (!main) return { error: 'no-main-line', detail: 'The repository has no main or master branch, here or on its origin.' };
      if (!await realDir(folder, 3)) {
        await mkdir(path.dirname(folder), { recursive: true, mode: 0o700 });
        const has = (await git(clone, ['rev-parse', '-q', '--verify', 'refs/heads/' + branch])).code === 0;
        const added = await git(clone, ['worktree', 'add', '--quiet', ...(has ? [folder, branch] : ['-b', branch, folder, main])], { timeout: 5 * 60_000 });
        if (added.code !== 0) return { error: 'worktree-failed', detail: added.err.slice(-TAIL) };
      }
      const failed = setup.trim() ? await runSetup(setup, folder) : null;
      if (failed) return failed;
      await mkdir(path.dirname(ready), { recursive: true, mode: 0o700 });
      await writeFile(ready, '');
      return { folder, branch, main };
    });
    busy.set(sprint, run.catch(() => {}));
    return run.catch((error) => ({ error: 'worker-folder-failed', detail: error.message }));
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
    const clone = path.join(dirOf(sprint), 'clone'), root = path.join(dirOf(sprint), 'workers');
    if (!await realDir(clone, 2)) return { removed: [], kept: [] };
    await git(clone, ['fetch', '--quiet', 'origin'], { timeout: 5 * 60_000 }); // best effort: offline, the main line known so far
    const removed = [], kept = [];
    for (const item of (await readdir(root).catch(() => [])).sort()) {
      const folder = path.join(root, item), branch = branchOf(sprint, item);
      const facts = KEY.test(item) && await realDir(folder, 3) ? await gitFacts(folder) : null;
      const why = !facts ? 'not a worker folder' : facts.dirty ? 'unsaved changes' : !facts.commit || await facts.inMain(facts.commit) !== true ? 'not in the main line' : null;
      if (!why && (await git(clone, ['worktree', 'remove', folder])).code === 0) {
        await git(clone, ['branch', '-D', branch]);
        await rm(path.join(dirOf(sprint), 'ready', item), { force: true });
        removed.push(item);
      } else kept.push({ item, folder, branch, bytes: await bytes(folder), why: why ?? 'git would not remove it' });
    }
    // The clone goes only when no worker folder and no sprint branch is left in it: a branch is never lost with it. The
    // sprint's own files (plan, rules, roles, notes: sprint-files.mjs) stay; the folder goes only when nothing else is in it.
    if (!kept.length && !await one(clone, ['for-each-ref', '--count=1', '--format=%(refname)', 'refs/heads/sprint/'])) {
      for (const part of ['workers', 'ready', 'clone']) await rm(path.join(dirOf(sprint), part), { recursive: true, force: true });
      await rmdir(dirOf(sprint)).catch(() => {});
    }
    return { removed, kept };
  }

  return { make, where, clean };
}
