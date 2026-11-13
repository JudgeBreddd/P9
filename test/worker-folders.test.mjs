// Worker folders (sprint spec A1, A2, A4, A6, A7; SECURITY.md § Worker folders), against throwaway repositories made here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWorkerFolders, gitFacts, setupShell } from '../apps/server/worker-folders.mjs';
import { daemon, http, authenticated, root } from './helpers.mjs';
import { Client } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const ID = '0123abcd-0000-4000-8000-000000000001';
const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
// A bare "remote" with main, and the owner's clone of it: on a branch of their own, with a commit only they have and an unsaved file.
function repos(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9-wf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const remote = path.join(dir, 'remote.git'), owner = path.join(dir, 'owner'), home = path.join(dir, 'sprints');
  g(dir, 'init', '--bare', '-b', 'main', remote);
  g(dir, 'clone', '-q', remote, owner);
  write(path.join(owner, 'a.txt'), 'one\n'); g(owner, 'add', 'a.txt'); g(owner, 'commit', '-qm', 'first'); g(owner, 'push', '-q', 'origin', 'main');
  g(owner, 'checkout', '-qb', 'mine'); write(path.join(owner, 'mine.txt'), 'x\n'); g(owner, 'add', 'mine.txt'); g(owner, 'commit', '-qm', 'mine');
  write(path.join(owner, 'unsaved.txt'), 'wip\n');
  return { dir, remote, owner, home };
}
const ownerState = (owner) => [g(owner, 'rev-parse', 'HEAD'), g(owner, 'branch', '--show-current'), g(owner, 'status', '--porcelain'), g(owner, 'branch', '--list'), g(owner, 'worktree', 'list', '--porcelain')].join('\n');
// Land a worker's branch on the remote's main the way a squash merge does: one new commit with its files.
function squash(dir, remote, branch, name) {
  const land = path.join(dir, 'land-' + name);
  g(dir, 'clone', '-q', remote, land);
  g(land, 'fetch', '-q', 'origin', branch + ':' + branch);
  g(land, 'merge', '-q', '--squash', branch); g(land, 'commit', '-qm', 'squash ' + name); g(land, 'push', '-q', 'origin', 'main');
}

test('Worker folders A7: gitFacts reads the commit, the files changed against the main line, unsaved changes, and whether a commit is in it (squash merges too)', { timeout: 60000 }, async (t) => {
  const { dir, remote, owner } = repos(t);
  assert.equal(await gitFacts(dir), null, 'not a repository');
  const facts = await gitFacts(owner);
  assert.equal(facts.commit, g(owner, 'rev-parse', 'HEAD'));
  assert.equal(facts.main, 'refs/remotes/origin/main');
  assert.deepEqual(facts.changed, ['mine.txt']);
  assert.equal(facts.dirty, true, 'an untracked file is unsaved work');
  assert.equal(await facts.inMain(g(owner, 'rev-parse', 'origin/main')), true, 'an ancestor of the main line');
  assert.equal(await facts.inMain(facts.commit), false, 'a commit only the owner has');
  assert.equal(await facts.inMain('--upload-pack=x'), false, 'only a commit id is read');
  g(owner, 'push', '-q', 'origin', 'mine');
  squash(dir, remote, 'mine', 'm');
  g(owner, 'fetch', '-q', 'origin');
  const after = await gitFacts(owner);
  assert.throws(() => g(owner, 'merge-base', '--is-ancestor', facts.commit, 'origin/main'), 'a squash merge made a new commit');
  assert.equal(await after.inMain(facts.commit), true, 'after a squash merge every file the commit changed is the same in the main line');
  fs.rmSync(path.join(owner, 'unsaved.txt'));
  assert.equal((await gitFacts(owner)).dirty, false);
  // Odd file names are read as themselves (git quotes a newline, and trimming loses a leading space): a commit whose
  // odd-named file differs in the main line is not in it.
  const odd = [' lead.txt', ...(process.platform === 'win32' ? [] : ['new\nline.txt'])];
  g(owner, 'checkout', '-qb', 'odd', 'origin/main');
  for (const name of odd) write(path.join(owner, name), 'mine\n');
  g(owner, 'add', '--', ...odd); g(owner, 'commit', '-qm', 'odd');
  const oddCommit = g(owner, 'rev-parse', 'HEAD');
  assert.deepEqual([...(await gitFacts(owner)).changed].sort(), [...odd].sort(), 'changed names are exact');
  const land = path.join(dir, 'land-odd'); g(dir, 'clone', '-q', remote, land);
  for (const name of odd) write(path.join(land, name), 'theirs\n');
  g(land, 'add', '--', ...odd); g(land, 'commit', '-qm', 'theirs'); g(land, 'push', '-q', 'origin', 'main');
  g(owner, 'fetch', '-q', 'origin');
  assert.equal(await (await gitFacts(owner)).inMain(oddCommit), false, 'an odd-named file that differs in the main line is not merged');
  // A pure rename is its old name and its new name: unmerged, the main line still has the old one; squash-merged, neither differs.
  g(owner, 'checkout', '-qb', 'ren', 'origin/main'); g(owner, 'mv', 'a.txt', 'renamed.txt'); g(owner, 'commit', '-qm', 'rename');
  const renCommit = g(owner, 'rev-parse', 'HEAD');
  assert.equal(await (await gitFacts(owner)).inMain(renCommit), false, 'an unmerged pure rename is not in the main line');
  g(owner, 'push', '-q', 'origin', 'ren'); squash(dir, remote, 'ren', 'ren'); g(owner, 'fetch', '-q', 'origin');
  assert.equal(await (await gitFacts(owner)).inMain(renCommit), true, 'a squash-merged rename is in the main line');
  console.log('PASS Worker folders A7');
});

test('Worker folders A1 A2 A4: one clone per sprint in P9\'s folder, a worktree and branch per worker from the main line; the owner\'s folder is untouched; the setup command runs first', { timeout: 60000 }, async (t) => {
  const { remote, owner, home } = repos(t);
  const before = ownerState(owner);
  for (const source of [null, undefined, 'owner']) assert.equal((await createWorkerFolders({ home }).make(ID, 'item-x', source)).error, 'folder-refused', 'no folder is never git\'s own default: ' + source);
  const folders = createWorkerFolders({ home });
  const a = await folders.make(ID, 'item-a', owner, 'echo ready> setup.txt');
  assert.equal(a.error, undefined, a.detail);
  assert.equal(a.folder, path.join(home, ID, 'workers', 'item-a'));
  assert.equal(a.branch, 'sprint/0123abcd/item-a');
  assert.equal(g(a.folder, 'branch', '--show-current'), a.branch);
  assert.equal(g(a.folder, 'rev-parse', 'HEAD'), g(remote, 'rev-parse', 'main'), 'started from the remote\'s main line, not the owner\'s branch');
  assert.equal(g(a.folder, 'remote', 'get-url', 'origin'), remote, 'a push goes where the owner\'s pushes go');
  assert.equal(fs.readFileSync(path.join(a.folder, 'setup.txt'), 'utf8').trim(), 'ready', 'the setup command ran in the new folder');
  assert.equal(ownerState(owner), before, 'the owner\'s branch, commits, unsaved file and worktrees are as they were');
  const b = await folders.make(ID, 'item-b', owner, '');
  assert.notEqual(b.folder, a.folder);
  assert.equal(g(b.folder, 'rev-parse', '--git-common-dir'), g(a.folder, 'rev-parse', '--git-common-dir'), 'one clone for the sprint');
  assert.deepEqual(await folders.make(ID, 'item-a', owner, 'exit 9'), { folder: a.folder, branch: a.branch }, 'the same item returns its folder; setup is not run again');
  assert.equal(await folders.where(ID, 'item-a'), a.folder);
  assert.equal(await folders.where(ID, 'nope'), null);
  // A failing setup: the worker is not started; the folder is kept and the next try runs it again.
  const c = await folders.make(ID, 'item-c', owner, 'echo broke && exit 3');
  assert.equal(c.error, 'setup-failed');
  assert.match(c.detail, /exit code 3[\s\S]*broke/);
  assert.equal((await folders.make(ID, 'item-c', owner, 'exit 0')).folder, path.join(home, ID, 'workers', 'item-c'));
  for (const bad of ['x..y', 'a.lock', '../up', 'Caps']) assert.equal((await folders.make(ID, bad, owner)).error, 'request-refused', bad);
  assert.equal((await folders.make(ID.replace('1', '2'), 'x', path.dirname(owner))).error, 'not-a-repository');
  assert.equal(ownerState(owner), before);
  console.log('PASS Worker folders A1 A2 A4');
});

test('Worker folders A6: clean-up removes only folders with nothing unsaved whose work is in the main line; it keeps and lists the rest', { timeout: 60000 }, async (t) => {
  const { dir, remote, owner, home } = repos(t);
  const folders = createWorkerFolders({ home });
  const work = async (item, file) => { const { folder } = await folders.make(ID, item, owner); write(path.join(folder, file), item + '\n'); g(folder, 'add', file); g(folder, 'commit', '-qm', item); return folder; };
  const merged = await work('merged', 'm.txt'), open = await work('open', 'o.txt'), dirty = await work('dirty', 'd.txt');
  // A worker that committed on its branch and then switched to a merged branch, and one that detached: both are kept
  // with their branches, whatever their folders now show.
  const moved = await work('moved', 'v.txt'), detached = await work('detached', 't.txt');
  g(moved, 'checkout', '-qb', 'elsewhere', 'origin/main'); g(detached, 'checkout', '-q', '--detach', 'origin/main');
  // A worker whose only change is odd-named files the main line does not have: not merged, kept.
  const oddFolder = (await folders.make(ID, 'odd', owner)).folder;
  const odd = [' lead.txt', ...(process.platform === 'win32' ? [] : ['new\nline.txt'])];
  for (const name of odd) write(path.join(oddFolder, name), 'odd\n');
  g(oddFolder, 'add', '--', ...odd); g(oddFolder, 'commit', '-qm', 'odd');
  // A worker whose only change is a pure rename: kept until the rename is in the main line.
  const renamed = (await folders.make(ID, 'renamed', owner)).folder;
  g(renamed, 'mv', 'a.txt', 'renamed.txt'); g(renamed, 'commit', '-qm', 'rename');
  g(merged, 'push', '-q', 'origin', 'HEAD'); squash(dir, remote, 'sprint/0123abcd/merged', 'merged');
  g(dirty, 'push', '-q', 'origin', 'HEAD'); squash(dir, remote, 'sprint/0123abcd/dirty', 'dirty');
  write(path.join(dirty, 'later.txt'), 'not saved\n');
  const result = await folders.clean(ID);
  assert.deepEqual(result.removed, ['merged']);
  assert.deepEqual(result.kept.map((k) => [k.item, k.why]), [['detached', 'not on its sprint branch'], ['dirty', 'unsaved changes'], ['moved', 'not on its sprint branch'], ['odd', 'not in the main line'], ['open', 'not in the main line'], ['renamed', 'not in the main line']]);
  assert.ok(result.kept.every((k) => k.bytes > 0 && fs.existsSync(k.folder)));
  const clone = path.join(home, ID, 'clone');
  assert.equal(fs.existsSync(merged), false);
  assert.deepEqual(g(clone, 'branch', '--list', 'sprint/*', '--format=%(refname:short)').split('\n'), ['sprint/0123abcd/detached', 'sprint/0123abcd/dirty', 'sprint/0123abcd/moved', 'sprint/0123abcd/odd', 'sprint/0123abcd/open', 'sprint/0123abcd/renamed'], 'an unmerged branch is never deleted');
  for (const item of ['moved', 'detached', 'odd']) { g(clone, 'worktree', 'remove', '--force', path.join(home, ID, 'workers', item)); g(clone, 'branch', '-D', 'sprint/0123abcd/' + item); }
  // Saved and merged at last: everything goes, the clone too.
  fs.rmSync(path.join(dirty, 'later.txt'));
  g(open, 'push', '-q', 'origin', 'HEAD'); squash(dir, remote, 'sprint/0123abcd/open', 'open');
  g(renamed, 'push', '-q', 'origin', 'HEAD'); squash(dir, remote, 'sprint/0123abcd/renamed', 'renamed');
  assert.deepEqual(await folders.clean(ID), { removed: ['dirty', 'open', 'renamed'], kept: [] });
  assert.equal(fs.existsSync(path.join(home, ID)), false);
  console.log('PASS Worker folders A6');
});

test('Worker folders A4: the setup shell on Windows without ComSpec is System32\\cmd.exe; with ComSpec, that shell; elsewhere /bin/sh', { timeout: 10000 }, () => {
  assert.deepEqual(setupShell('npm ci & echo ok', 'win32', { SystemRoot: 'D:\\Win' }), ['D:\\Win\\System32\\cmd.exe', '/d', '/s', '/c', '"npm ci & echo ok"']);
  assert.deepEqual(setupShell('x', 'win32', {}), ['C:\\Windows\\System32\\cmd.exe', '/d', '/s', '/c', '"x"']);
  assert.deepEqual(setupShell('x', 'win32', { ComSpec: 'E:\\cmd.exe', SystemRoot: 'D:\\Win' })[0], 'E:\\cmd.exe');
  assert.deepEqual(setupShell('x', 'win32', { COMSPEC: 'E:\\cmd.exe' }), ['E:\\cmd.exe', '/d', '/s', '/c', '"x"']);
  assert.deepEqual(setupShell('x', 'linux', {}), ['/bin/sh', '-c', 'x']);
});

test('Worker folders A4: a setup command past its cap is stopped with everything it started, and the answer waits only for that stop', { timeout: 60000 }, async (t) => {
  const { dir, owner, home } = repos(t);
  // The setup starts a child that keeps the output pipes open and outlives it unless the whole tree is stopped: once with
  // the setup still running, once with the setup gone and only its child left.
  for (const [item, parent] of [['live', 'setInterval(() => {}, 1000);'], ['gone', 'process.exit(0);']]) {
    const pidFile = path.join(dir, item + '.pid'), script = path.join(dir, item + '.mjs');
    write(script, `import { spawn } from 'node:child_process'; import fs from 'node:fs';
const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
fs.writeFileSync(${JSON.stringify(pidFile)}, String(kid.pid)); ${parent}\n`);
    const started = Date.now();
    const result = await createWorkerFolders({ home, setupMs: 3000 }).make(ID, item, owner, `node "${script}"`);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    // At the answer the whole tree is already gone: nothing is still writing in the folder.
    let alive = true; try { process.kill(pid, 0); } catch { alive = false; }
    if (alive) process.kill(pid, 'SIGKILL');
    assert.equal(alive, false, item + ': the setup command\'s own child was stopped before the answer');
    assert.ok(Date.now() - started < 20000, item + ': answered at the cap, not when the pipes close');
    // Windows: the Job Object ends what the shell left behind when the shell ends, so the setup that exited 0 has finished.
    if (item === 'gone' && process.platform === 'win32') { assert.equal(result.error, undefined, result.detail); continue; }
    assert.equal(result.error, 'setup-failed');
    assert.match(result.detail, /was stopped after .*, with everything it started/);
  }
  console.log('PASS Worker folders A4 timeout');
});

// Through the daemon: open_chat with worktree: true starts the worker in its own folder in P9's folder.
const fake = path.join(root, 'test/fake-acp-agent.mjs');
const call = (instance, route, method = 'GET', body) => http({ socketPath: instance.credentials.socketPath, route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  .then((result) => ({ ...result, body: result.text ? JSON.parse(result.text) : null }));
async function agent(t, instance) {
  const { body: { conversation } } = await call(instance, '/chat', 'POST', { provider: 'claude' });
  await call(instance, `/chat/${conversation}/prompt`, 'POST', { text: 'mcp' });
  let after = 0, hit;
  for (let i = 0; i < 40 && !hit; i += 1) {
    const { body } = await call(instance, `/chat/events?after=${after}&wait=2000`);
    after = body.cursor; hit = body.events.find((e) => e.conversation === conversation && e.data?.content?.text?.startsWith('mcp:'));
  }
  assert.ok(hit, 'the chat got its MCP entry');
  const [entry] = JSON.parse(hit.data.content.text.slice(4));
  const client = new Client({ name: 'p9-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env: Object.fromEntries(entry.env.map(({ name, value }) => [name, value])) }));
  t.after(() => client.close());
  const tool = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  return { conversation, tool };
}

test('Worker folders: open_chat with worktree: true starts the worker in a worktree of a sprint clone, after the owner\'s setup command', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const repo = path.join(instance.workspace, 'repo');
  fs.mkdirSync(repo); g(repo, 'init', '-q', '-b', 'main'); write(path.join(repo, 'a.txt'), 'a\n'); g(repo, 'add', 'a.txt'); g(repo, 'commit', '-qm', 'a');
  const delegation = (await call(instance, '/delegation', 'POST', { start: 'agent', max: 5, workers: [], setup: 'echo set> setup.txt' })).body;
  assert.equal(delegation.setup, 'echo set> setup.txt');
  assert.equal((await call(instance, '/delegation', 'POST', { start: 'agent', max: 5, workers: [], setup: 7 })).status, 400);
  await call(instance, '/file-protection', 'POST', { on: false });
  const a = await agent(t, instance);
  assert.equal((await a.tool('open_chat', { text: 'cwd', folder: 'repo', worktree: true })).error, 'request-refused', 'a worker folder needs a key');
  const made = await a.tool('open_chat', { text: 'cwd', folder: 'repo', worktree: true, key: 'item-1' });
  assert.equal(made.error, undefined, JSON.stringify(made));
  assert.match(made.folder, /[\\/]sprints[\\/][0-9a-f-]{36}[\\/]workers[\\/]item-1$/);
  assert.ok(made.folder.includes(a.conversation), 'the sprint is the chat that started the worker');
  assert.equal(g(made.folder, 'branch', '--show-current'), 'sprint/' + a.conversation.slice(0, 8) + '/item-1');
  assert.equal(fs.readFileSync(path.join(made.folder, 'setup.txt'), 'utf8').trim(), 'set');
  assert.equal(g(repo, 'status', '--porcelain'), '', 'nothing was added to the owner\'s folder');
  let last = '';
  for (let i = 0; i < 20 && !last.startsWith('cwd:'); i += 1) last = (await a.tool('wait_chat', { chat: made.chat })).last;
  assert.equal(last, 'cwd:new:' + made.folder, 'the worker works in its own folder');
  const row = (await call(instance, '/chat')).body.conversations.find((c) => c.id === made.chat);
  assert.equal(row.folder, ':worker-folder', 'the record holds a marker, not a path');
  // A client cannot start a chat on the marker: it has no parent and key.
  assert.equal((await call(instance, '/chat', 'POST', { provider: 'claude', folder: ':worker-folder' })).status, 400);
  // A folder P9 cannot use is refused before git runs (the daemon's own folder is never cloned in its place).
  assert.equal((await a.tool('open_chat', { text: 'x', folder: '../outside', worktree: true, key: 'item-2' })).error, 'folder-refused');
  assert.equal((await a.tool('open_chat', { text: 'x', folder: 'missing', worktree: true, key: 'item-2' })).error, 'folder-refused');
  assert.equal(fs.existsSync(path.join(path.dirname(made.folder), 'item-2')), false);
  // Delegation turned off while a slow setup runs: the worker is not started, and its folder is kept.
  const wait = path.join(instance.workspace, 'wait.mjs'), go = path.join(instance.workspace, 'go');
  write(wait, `import fs from 'node:fs'; const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(go)})) clearInterval(t); }, 50);\n`);
  await call(instance, '/delegation', 'POST', { start: 'agent', max: 5, workers: [], setup: `node "${wait}"` });
  const slow = a.tool('open_chat', { text: 'x', folder: 'repo', worktree: true, key: 'item-3' });
  const folder3 = path.join(path.dirname(made.folder), 'item-3');
  for (let i = 0; i < 100 && !fs.existsSync(folder3); i += 1) await new Promise((r) => setTimeout(r, 100));
  await call(instance, '/delegation', 'POST', { start: 'off', max: 5, workers: [], setup: `node "${wait}"` });
  write(go, '');
  const refused = await slow;
  assert.equal(refused.error, 'delegate-off', JSON.stringify(refused));
  assert.match(refused.detail, /was made and is kept/);
  assert.ok(fs.existsSync(folder3), 'the prepared folder is kept');
  assert.equal((await call(instance, '/chat')).body.conversations.filter((c) => c.parent === a.conversation).length, 1, 'no second worker');
  console.log('PASS Worker folders open_chat');
});

// SECURITY.md § Worker folders, "Who cleans up": the desktop's route cleans one sprint with the store's own rules, and
// refuses while a worker of that sprint runs or while its lead is in a turn.
test('Worker folders A6: the desktop\'s clean-up route refuses while the sprint runs, then removes the merged folder and keeps the unmerged one, saying why', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const repo = path.join(instance.workspace, 'repo');
  fs.mkdirSync(repo); g(repo, 'init', '-q', '-b', 'main'); write(path.join(repo, 'a.txt'), 'a\n'); g(repo, 'add', 'a.txt'); g(repo, 'commit', '-qm', 'a');
  await call(instance, '/delegation', 'POST', { start: 'agent', max: 5, workers: [] });
  await call(instance, '/file-protection', 'POST', { on: false });
  const a = await agent(t, instance), clean = () => call(instance, '/sprints/' + a.conversation + '/clean', 'POST', {});
  const done = await a.tool('open_chat', { text: 'cwd', folder: 'repo', worktree: true, key: 'done' });
  const open = await a.tool('open_chat', { text: 'cwd', folder: 'repo', worktree: true, key: 'open' });
  assert.equal(done.error ?? open.error, undefined, JSON.stringify([done, open]));
  write(path.join(open.folder, 'o.txt'), 'o\n'); g(open.folder, 'add', 'o.txt'); g(open.folder, 'commit', '-qm', 'not merged');
  const running = await clean();
  assert.equal(running.status, 409, JSON.stringify(running.body));
  assert.equal(running.body.error, 'sprint-running');
  assert.ok(fs.existsSync(done.folder) && fs.existsSync(open.folder), 'nothing removed while workers run');
  for (const w of [done, open]) assert.equal((await a.tool('stop_chat', { chat: w.chat, close: true })).action, 'stopped');
  // The lead in a turn may be making a worker folder: refused too.
  await call(instance, `/chat/${a.conversation}/prompt`, 'POST', { text: 'slow' });
  const conv = async () => (await call(instance, '/chat')).body.conversations.find((c) => c.id === a.conversation);
  for (let i = 0; i < 100 && (await conv()).state !== 'turn'; i += 1) await new Promise((r) => setTimeout(r, 100));
  assert.equal((await clean()).body.error, 'sprint-running', 'the lead is in a turn');
  await call(instance, `/chat/${a.conversation}/cancel`, 'POST', {});
  for (let i = 0; i < 100 && (await conv()).state === 'turn'; i += 1) await new Promise((r) => setTimeout(r, 100));
  const result = await clean();
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.removed, ['done']);
  assert.deepEqual(result.body.kept.map((k) => [k.item, k.why]), [['open', 'not in the main line']]);
  assert.ok(result.body.kept[0].bytes > 0);
  assert.equal(fs.existsSync(done.folder), false, 'the merged folder is gone');
  assert.ok(fs.existsSync(open.folder), 'the unmerged folder is kept');
  assert.equal((await call(instance, '/sprints/not-a-chat/clean', 'POST', {})).status, 400);
  console.log('PASS Worker folders clean route');
});
