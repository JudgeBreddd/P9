// MC-15: files a turn changed through the shell (no Write or Edit call) come as one finished edit call, "Shell edits", with
// each file's hunks, so the Changes list shows them. A folder outside git adds nothing. The fake agent's prompts that write
// are in fake-acp-agent.mjs ('shell writes', 'shell many', 'shell big').
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { daemon, http, authenticated, root } from './helpers.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const sh = (cwd, ...args) => execFileSync(realGit, ['-C', cwd, ...args], { encoding: 'utf8' });

// proj: a repo with a commit, plus predirty.txt and dirty.txt changed before any turn. plain: a folder outside git.
// A git on PATH that waits the seconds in its folder's "sleep" file before "add" (the snapshot's slow step).
async function start(t) {
  let bin;
  const instance = await daemon(t, undefined, false, async ({ workspace }) => {
    const proj = path.join(workspace, 'proj');
    await mkdir(proj); await mkdir(path.join(workspace, 'plain'));
    sh(proj, 'init', '-q'); sh(proj, 'config', 'user.email', 't@example.invalid'); sh(proj, 'config', 'user.name', 't');
    for (const [f, text] of [['a.txt', 'one\ntwo\nthree\n'], ['gone.txt', 'bye\n'], ['old.txt', 'moving\nunchanged\nlines\n'], ['sp ace.txt', 'spaced\n'], ['predirty.txt', 'committed\n'], ['dirty.txt', 'committed\n']]) await writeFile(path.join(proj, f), text);
    sh(proj, 'add', '-A'); sh(proj, 'commit', '-qm', 'start');
    await writeFile(path.join(proj, 'predirty.txt'), 'before turn\n');
    await writeFile(path.join(proj, 'dirty.txt'), 'dirty, not touched in the turn\n');
    bin = path.join(workspace, '..', 'gitbin'); await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, 'sleep'), '0');
    await writeFile(path.join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" add -A "*) sleep "$(cat '${bin}/sleep')";; esac\nexec '${realGit}' "$@"\n`);
    await chmod(path.join(bin, 'git'), 0o755);
    return { args: ['--acp-override', fake], env: { PATH: bin + path.delimiter + process.env.PATH } };
  });
  const call = (route, method = 'GET', body) => http({ socketPath: instance.credentials.socketPath, route, method,
    headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => ({ status: r.status, ...JSON.parse(r.text) }));
  const events = async (id) => { const all = []; for (let after = 0, page; (page = await call('/chat/events?after=' + after + '&only=' + id)).events.length; after = page.cursor) all.push(...page.events); return all; };
  const ended = async (id, n) => { for (const end = Date.now() + 30000; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) { const all = await events(id); if (all.filter((e) => e.type === 'turn-end').length >= n) return all; } assert.fail('no turn-end'); };
  const chat = async (folder) => (await call('/chat', 'POST', { provider: 'claude', folder })).conversation;
  const shells = (all) => all.filter((e) => e.type === 'update' && e.data.title === 'Shell edits');
  return { call, ended, chat, shells, bin };
}

test('MC-15 a turn\'s shell edits come as one Shell edits call: changed, new, deleted, moved, binary; not the edit calls\' own files', { timeout: 90000 }, async (t) => {
  const { call, ended, chat, shells } = await start(t);
  const id = await chat('proj');
  await call('/chat/' + id + '/prompt', 'POST', { text: 'shell writes' });
  const all = await ended(id, 1);
  const found = shells(all);
  assert.equal(found.length, 1, 'one Shell edits call');
  const ev = found[0], at = all.indexOf(ev), end = all.findIndex((e) => e.type === 'turn-end');
  assert.ok(at < end, 'it comes before the turn-end');
  assert.equal(ev.data.kind, 'edit'); assert.equal(ev.data.status, 'completed');
  const by = Object.fromEntries(ev.data.content.map((c) => [path.basename(c.path), c]));
  assert.deepEqual(Object.keys(by).sort(), ['a.txt', 'bin.dat', 'failed.md', 'moved.txt', 'gone.txt', 'new.md', 'predirty.txt', 'sp ace.txt'].sort(),
    'tool.md (its finished Edit) and dirty.txt (dirty before, untouched) are left out; failed.md (its Edit failed) is in');
  for (const c of ev.data.content) assert.ok(path.isAbsolute(c.path) && !c.path.endsWith('\t'), c.path);
  assert.deepEqual(by['a.txt']._meta.hunks[0].rows, [['ctx', 'one'], ['del', 'two'], ['add', 'TWO'], ['ctx', 'three']]);
  assert.equal(by['new.md']._meta.added, true);
  assert.equal(by['gone.txt']._meta.deleted, true);
  assert.equal(path.basename(by['moved.txt']._meta.from), 'old.txt');
  assert.equal(by['bin.dat']._meta.binary, true);
  // Changed in the turn from its state at the start, not from the last commit.
  assert.deepEqual(by['predirty.txt']._meta.hunks[0].rows, [['ctx', 'before turn'], ['add', 'in turn']]);
  assert.deepEqual(by['sp ace.txt']._meta.hunks[0].rows, [['del', 'spaced'], ['add', 'spaced again']]);
  assert.deepEqual(ev.data.locations.map((l) => l.path).sort(), ev.data.content.map((c) => c.path).sort());
  // A second turn that changes nothing adds none.
  await call('/chat/' + id + '/prompt', 'POST', { text: 'hello' });
  assert.equal(shells(await ended(id, 2)).length, 1, 'a turn with no change adds no Shell edits');
});

test('MC-15 Shell edits caps the files and the hunks; a folder outside git adds nothing and the turn ends as before', { timeout: 90000 }, async (t) => {
  const { call, ended, chat, shells } = await start(t);
  const id = await chat('proj');
  await call('/chat/' + id + '/prompt', 'POST', { text: 'shell many' });
  const many = shells(await ended(id, 1));
  assert.equal(many.length, 1); assert.equal(many[0].data.content.length, 40, 'at most 40 files');
  await call('/chat/' + id + '/prompt', 'POST', { text: 'shell big' });
  const big = shells(await ended(id, 2))[1];
  assert.equal(big.data.content.length, 1);
  assert.equal(path.basename(big.data.content[0].path), 'big.txt'); assert.equal(big.data.content[0]._meta.added, true);
  assert.deepEqual(big.data.content[0]._meta.hunks, [], 'a file past the hunk budget is listed with no rows');
  assert.ok(JSON.stringify(big.data).length < 64 * 1024, 'the event stays under the event limit');
  const plain = await chat('plain');
  await call('/chat/' + plain + '/prompt', 'POST', { text: 'shell many' }); // writes only: the folder has none of shell writes' files
  const out = await ended(plain, 1);
  assert.equal(shells(out).length, 0, 'outside git: no Shell edits');
  assert.ok(!out.some((e) => e.type === 'error'), 'and no error');
});

test('MC-15 a slow snapshot is given up after its limit, and a Stop while it runs sends no prompt', { timeout: 90000 }, async (t) => {
  const { call, ended, chat, shells, bin } = await start(t);
  const id = await chat('proj');
  await call('/chat/' + id + '/prompt', 'POST', { text: 'hello' }); await ended(id, 1); // the session is up
  await writeFile(path.join(bin, 'sleep'), '6');
  const t0 = Date.now();
  await call('/chat/' + id + '/prompt', 'POST', { text: 'shell writes' });
  const all = await ended(id, 2);
  assert.ok(Date.now() - t0 < 15000, 'each end waits at most its limit');
  assert.equal(shells(all).length, 0, 'no snapshot in time: nothing added');
  assert.ok(!all.some((e) => e.type === 'error'), 'and no error');
  await writeFile(path.join(bin, 'sleep'), '2');
  await call('/chat/' + id + '/prompt', 'POST', { text: 'hello' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await call('/chat/' + id + '/cancel', 'POST', {})).status, 200);
  const after = await ended(id, 3);
  const last = after.slice(after.findLastIndex((e) => e.type === 'user'));
  assert.equal(last.find((e) => e.type === 'turn-end').data.stopReason, 'cancelled');
  assert.ok(!last.some((e) => e.type === 'update' && e.data.sessionUpdate === 'agent_message_chunk'), 'the agent got no prompt');
});
