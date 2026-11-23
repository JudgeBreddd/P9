// MC-15: files a turn changed through the shell (no Write or Edit call) come as one finished edit call, "Shell edits", with
// each file's hunks, so the Changes list shows them. A folder outside git adds nothing. The fake agent's prompts that write
// are in fake-acp-agent.mjs ('shell writes', 'shell many', 'shell big').
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { daemon, http, authenticated, root } from './helpers.mjs';
import { shellStart, shellEnd } from '../apps/server/shell-edits.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const sh = (cwd, ...args) => execFileSync(realGit, ['-C', cwd, ...args], { encoding: 'utf8' });

// proj: a repo with a commit, plus predirty.txt and dirty.txt changed before any turn. plain: a folder outside git.
// hooked: a repo whose post-index-change hook, fsmonitor and *.tc textconv run the evil script; filtered: one whose
// filter (clean, smudge) does; late: one whose files ask for that filter (f.txt changed before any turn) with no filter
// configured yet, so a test can set one while a snapshot runs; inject: the same, its core.excludesFile value holding a
// quote and a second line that reads as a filter setting. The evil script notes each run in its marker file.
// outer: the workspace and the folder above it are in one repo (sib.txt in the workspace, outside.txt above it), so plain is
// a subfolder of a larger repo.
// A git on PATH that waits the seconds in its folder's "sleep" file before "add" (the snapshot's slow step).
async function start(t, { outer = false } = {}) {
  let bin, marker, late, inject;
  const instance = await daemon(t, undefined, outer, async ({ workspace }) => {
    const proj = path.join(workspace, 'proj');
    await mkdir(proj); await mkdir(path.join(workspace, 'plain'));
    sh(proj, 'init', '-q'); sh(proj, 'config', 'user.email', 't@example.invalid'); sh(proj, 'config', 'user.name', 't');
    for (const [f, text] of [['a.txt', 'one\ntwo\nthree\n'], ['gone.txt', 'bye\n'], ['old.txt', 'moving\nunchanged\nlines\n'], ['sp ace.txt', 'spaced\n'], ['predirty.txt', 'committed\n'], ['dirty.txt', 'committed\n']]) await writeFile(path.join(proj, f), text);
    sh(proj, 'add', '-A'); sh(proj, 'commit', '-qm', 'start');
    await writeFile(path.join(proj, 'predirty.txt'), 'before turn\n');
    await writeFile(path.join(proj, 'dirty.txt'), 'dirty, not touched in the turn\n');
    const evilDir = path.join(workspace, '..', 'evil');
    marker = path.join(evilDir, 'marker');
    await mkdir(evilDir);
    // One script per program, each writing its own name to the marker (and passing its input through).
    const evil = async (name) => { const f = path.join(evilDir, name); await writeFile(f, `#!/bin/sh\necho ${name} >> '${marker}'\ncat "$@" 2>/dev/null\n`); await chmod(f, 0o755); return f; };
    const hooked = path.join(workspace, 'hooked'), filtered = path.join(workspace, 'filtered');
    late = path.join(workspace, 'late'); inject = path.join(workspace, 'inject');
    for (const [dir, files] of [[hooked, [['a.tc', 'tc\n'], ['.gitattributes', '*.tc diff=evil\n']]], ...[filtered, late, inject].map((d) => [d, [['f.txt', 'f\n'], ['.gitattributes', '* filter=evil\n']]])]) {
      await mkdir(dir); sh(dir, 'init', '-q'); sh(dir, 'config', 'user.email', 't@example.invalid'); sh(dir, 'config', 'user.name', 't');
      for (const [f, text] of files) await writeFile(path.join(dir, f), text);
      sh(dir, 'add', '-A'); sh(dir, 'commit', '-qm', 'start');
    }
    sh(hooked, 'config', 'core.fsmonitor', await evil('fsmonitor')); sh(hooked, 'config', 'diff.evil.textconv', await evil('textconv'));
    await writeFile(path.join(hooked, '.git/hooks/post-index-change'), `#!/bin/sh\nexec '${await evil('hook')}'\n`); await chmod(path.join(hooked, '.git/hooks/post-index-change'), 0o755);
    sh(filtered, 'config', 'filter.evil.clean', await evil('filter-clean')); sh(filtered, 'config', 'filter.evil.smudge', await evil('filter-smudge'));
    await writeFile(path.join(late, 'f.txt'), 'changed before the turn\n'); await evil('late-clean');
    await writeFile(path.join(inject, 'f.txt'), 'changed before the turn\n');
    sh(inject, 'config', 'core.excludesFile', 'ben"ign\nfilter.evil.clean ' + await evil('inject-clean'));
    if (outer) {
      const top = path.join(workspace, '..');
      await writeFile(path.join(top, 'outside.txt'), 'out\n'); await writeFile(path.join(workspace, 'sib.txt'), 'sib\n');
      sh(top, 'init', '-q'); sh(top, 'config', 'user.email', 't@example.invalid'); sh(top, 'config', 'user.name', 't');
      sh(top, 'add', '--', 'outside.txt', path.relative(top, path.join(workspace, 'sib.txt'))); sh(top, 'commit', '-qm', 'start');
    }
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
  return { call, ended, chat, shells, bin, marker, late, inject };
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
  // 40 files 3 folders of 200 characters down: their paths (in content and locations) and hunks come to more than 64 KB.
  await call('/chat/' + id + '/prompt', 'POST', { text: 'shell deep' });
  const deep = shells(await ended(id, 3))[2];
  assert.ok(!('truncated' in deep.data), 'not cut down to a truncated event');
  assert.ok(JSON.stringify(deep.data).length < 64 * 1024, 'paths counted: the event stays under the event limit');
  assert.ok(deep.data.content.length >= 1 && deep.data.content.length < 40, 'the files that fit');
  assert.equal(deep.data.content[0]._meta.hunks.length, 1, 'the first keeps its rows');
  assert.deepEqual(deep.data.locations.map((l) => l.path), deep.data.content.map((c) => c.path));
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

test('MC-15 no program the repo configures runs: hook, fsmonitor, textconv, filter', { timeout: 90000 }, async (t) => {
  const { call, ended, chat, shells, marker } = await start(t);
  const id = await chat('hooked');
  await call('/chat/' + id + '/prompt', 'POST', { text: 'shell tc' });
  const found = shells(await ended(id, 1));
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].data.content.map((c) => path.basename(c.path)).sort(), ['a.tc', 'note.txt']);
  assert.deepEqual(found[0].data.content.find((c) => c.path.endsWith('a.tc'))._meta.hunks[0].rows, [['del', 'tc'], ['add', 'changed tc']], 'the file itself, not its textconv');
  const ran = () => readFile(marker, 'utf8').catch(() => '');
  assert.equal(await ran(), '', 'no hook, fsmonitor or textconv ran');
  const f = await chat('filtered');
  await call('/chat/' + f + '/prompt', 'POST', { text: 'shell many' });
  const out = await ended(f, 1);
  assert.equal(await ran(), '', 'no filter ran');
  assert.equal(shells(out).length, 1, 'a repo with a filter is listed, its files as they are on disk');
  assert.ok(!out.some((e) => e.type === 'error'), 'and no error');
});

// A filter set while a snapshot runs (held before its add by the slow git) still does not run: the snapshot's git never
// reads the repo's config for programs, so there is no check-then-run gap. f.txt, changed before the turn, is hashed by
// the turn start's add, which on the old code ran the clean filter set in the gap.
test('MC-15 a filter set in the repo while a snapshot runs does not run', { timeout: 90000 }, async (t) => {
  const { call, ended, chat, shells, bin, marker, late } = await start(t);
  const id = await chat('late');
  await call('/chat/' + id + '/prompt', 'POST', { text: 'hello' }); await ended(id, 1); // the session is up
  await writeFile(path.join(bin, 'sleep'), '1.5');
  await call('/chat/' + id + '/prompt', 'POST', { text: 'shell many' });
  await new Promise((r) => setTimeout(r, 500)); // the start snapshot is held before its add
  sh(late, 'config', 'filter.evil.clean', path.join(marker, '..', 'late-clean'));
  const all = await ended(id, 2);
  assert.equal(await readFile(marker, 'utf8').catch(() => ''), '', 'the filter set during the snapshot did not run');
  assert.equal(shells(all).length, 1, 'the turn\'s files are listed');
});

// Nothing the repo's config or file names say reaches git's arguments or environment as a setting: a core.excludesFile
// value with a quote and a newline, and a file named with both (whose second line reads as a filter setting), set no
// filter; that file is listed under its own name. Read line by line into -c flags (round 2), the value's second line
// became filter.evil.clean and its clean filter ran on f.txt.
test('MC-15 a quote or newline in a repo setting or a file name sets no filter', { timeout: 90000 }, async (t) => {
  const { call, ended, chat, shells, marker } = await start(t);
  const id = await chat('inject');
  await call('/chat/' + id + '/prompt', 'POST', { text: 'shell odd' });
  const found = shells(await ended(id, 1));
  assert.equal(await readFile(marker, 'utf8').catch(() => ''), '', 'no filter ran');
  assert.equal(found.length, 1, 'the turn\'s files are listed');
  assert.deepEqual(found[0].data.content.map((c) => path.basename(c.path)).sort(), ['f.txt', 'o"dd\nfilter.evil.clean=x.txt', 'plain.txt'],
    'each under its own name, not git\'s quoted form');
});

test('MC-15 a chat folder inside a larger repo: files changed outside the folder are never listed or read', { timeout: 90000 }, async (t) => {
  const { call, ended, chat, shells } = await start(t, { outer: true });
  const id = await chat('plain');
  await call('/chat/' + id + '/prompt', 'POST', { text: 'shell outside' });
  const all = await ended(id, 1), found = shells(all);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].data.content.map((c) => path.basename(c.path)), ['in.txt']);
  assert.ok(!JSON.stringify(all).includes('SECRET'), 'sib.txt (in the workspace) and outside.txt (above it) are not in any event');
});

// MC-15: git trusts an index entry whose size and times match the file, unless the entry is no older than the index file
// itself ("racily clean"): then it reads the file. A same-size edit made in the same second as the index was written is
// caught only that way. The snapshot copies the index, so the copy must keep the index's time; a fresh time made such an
// edit read as unchanged (the desktop test missed a.txt once, run 040503). The state is built here without waiting on the
// clock: a.txt holds TWO, its index entry has TWO's size and times but two's object id, and the index is older than it.
test('MC-15 a same-size edit git must re-read because the index is no newer than it is listed', { timeout: 30000 }, async (t) => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'mc15-racy-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const a = path.join(repo, 'a.txt'), ix = path.join(repo, '.git', 'index');
  sh(repo, 'init', '-q'); sh(repo, 'config', 'user.email', 't@example.invalid'); sh(repo, 'config', 'user.name', 't');
  await writeFile(a, 'one\ntwo\n'); sh(repo, 'add', '-A'); sh(repo, 'commit', '-qm', 'start');
  const from = await shellStart(repo);
  assert.ok(from, 'a start snapshot');
  await writeFile(a, 'one\nTWO\n');
  const old = new Date(Date.now() - 10000);
  await utimes(a, old, old); // older than the index git add writes next, so git does not mark the entry racy itself
  sh(repo, 'add', 'a.txt');
  const oid = (text) => Buffer.from(execFileSync(realGit, ['-C', repo, 'hash-object', '--stdin'], { input: text, encoding: 'utf8' }).trim(), 'hex');
  const buf = Buffer.from(await readFile(ix)), was = oid('one\nTWO\n'), at = buf.indexOf(was);
  assert.ok(at > 0 && buf.indexOf(was, at + 1) < 0, 'one entry with TWO');
  oid('one\ntwo\n').copy(buf, at);
  createHash('sha1').update(buf.subarray(0, -20)).digest().copy(buf, buf.length - 20);
  await writeFile(ix, buf);
  const back = new Date((await stat(a)).mtimeMs - 1000);
  await utimes(ix, back, back);
  assert.match(execFileSync(realGit, ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }), /^ M a\.txt$/m, 'git itself calls a.txt changed');
  const out = await shellEnd(from, repo);
  assert.ok(out, 'Shell edits found a change');
  assert.deepEqual(out.map((d) => path.basename(d.path)), ['a.txt']);
  assert.match(JSON.stringify(out[0]), /TWO/);
});

// O241: a .git that is a file (a linked worktree, a submodule) is followed as one checked path. Each good one lists a shell
// edit; a pointer with a second line, one to a missing folder, one with no back-link add nothing; a filter set in the
// pointed (common) folder's config runs nothing (its marker stays absent) and the file is listed as it is on disk.
test('O241 a linked worktree and a submodule list shell edits; a bad .git file adds nothing and runs nothing', { timeout: 60000 }, async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'o241-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const init = (dir) => { sh(dir, 'init', '-q'); sh(dir, 'config', 'user.email', 't@example.invalid'); sh(dir, 'config', 'user.name', 't'); };
  const main = path.join(base, 'main'); await mkdir(main); init(main);
  await writeFile(path.join(main, 'a.txt'), 'one\n'); await writeFile(path.join(main, '.gitattributes'), '*.f filter=evil\n'); await writeFile(path.join(main, 'x.f'), 'f\n');
  sh(main, 'add', '-A'); sh(main, 'commit', '-qm', 'start');
  const wt = path.join(base, 'wt'); sh(main, 'worktree', 'add', '-q', wt);
  const listed = async (dir, file, text) => {
    const from = await shellStart(dir); if (!from) return null;
    await writeFile(path.join(dir, file), text);
    return (await shellEnd(from, dir))?.map((d) => path.basename(d.path)) ?? null;
  };
  assert.deepEqual(await listed(wt, 'a.txt', 'one\nwt\n'), ['a.txt'], 'a linked worktree lists its shell edit');
  // A submodule: the superproject keeps its git folder under .git/modules/.
  const sup = path.join(base, 'sup'); await mkdir(sup); init(sup);
  await writeFile(path.join(sup, 'r.txt'), 'r\n'); sh(sup, 'add', '-A'); sh(sup, 'commit', '-qm', 'start');
  execFileSync(realGit, ['-C', sup, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', main, 'sub'], { encoding: 'utf8' });
  const sub = path.join(sup, 'sub');
  assert.match(await readFile(path.join(sub, '.git'), 'utf8'), /^gitdir: /, 'the submodule has a .git file');
  assert.deepEqual(await listed(sub, 'a.txt', 'one\nsub\n'), ['a.txt'], 'a submodule lists its shell edit');
  // A filter configured in the common folder never runs; the file is listed as it is on disk.
  const marker = path.join(base, 'marker'), evil = path.join(base, 'evil.sh');
  await writeFile(evil, `#!/bin/sh\necho ran >> '${marker}'\ncat\n`); await chmod(evil, 0o755);
  sh(wt, 'config', 'filter.evil.clean', evil);
  assert.deepEqual(await listed(wt, 'x.f', 'f\nchanged\n'), ['x.f'], 'a filtered file is still listed');
  await assert.rejects(stat(marker), 'the configured filter never ran');
  // Bad pointers: each a copy of the worktree with its .git file rewritten.
  const bad = async (name, text, setup) => {
    const dir = path.join(base, name); await mkdir(dir); await writeFile(path.join(dir, 'a.txt'), 'one\n');
    await writeFile(path.join(dir, '.git'), typeof text === 'function' ? await text(dir) : text); await setup?.(dir);
    assert.equal(await shellStart(dir), null, name + ' adds nothing');
  };
  const wtGit = (await readFile(path.join(wt, '.git'), 'utf8')).trim().slice('gitdir: '.length);
  await bad('newline', `gitdir: ${wtGit}\ngitdir: ${wtGit}\n`);
  await bad('missing', `gitdir: ${path.join(base, 'nowhere')}\n`);
  await bad('no-backlink', `gitdir: ${wtGit}\n`); // the worktree folder's gitdir names wt/.git, not this file
  await bad('not-modules', async (dir) => { await mkdir(path.join(dir, 'g')); await writeFile(path.join(dir, 'g', 'HEAD'), 'ref: refs/heads/x\n'); return 'gitdir: g\n'; });
  // Review round 1: a self-made worktree folder whose commondir names another repo; a submodule pointer into another
  // superproject's modules; a worktree whose index is a link.
  await mkdir(path.join(base, 'fake', 'wt1'), { recursive: true });
  await bad('foreign-common', `gitdir: ${path.join(base, 'fake', 'wt1')}\n`, async (dir) => {
    await writeFile(path.join(base, 'fake', 'wt1', 'gitdir'), path.join(dir, '.git') + '\n');
    await writeFile(path.join(base, 'fake', 'wt1', 'commondir'), path.join(main, '.git') + '\n');
  });
  await mkdir(path.join(main, 'inner'));
  const inner = path.join(main, 'inner'); await writeFile(path.join(inner, '.git'), `gitdir: ${path.join(sup, '.git', 'modules', 'sub')}\n`);
  assert.equal(await shellStart(inner), null, 'a submodule pointer into another superproject adds nothing');
  const wt2 = path.join(base, 'wt2'); sh(main, 'worktree', 'add', '-q', wt2);
  const wt2Index = path.join(main, '.git', 'worktrees', 'wt2', 'index');
  await rm(wt2Index); await symlink(path.join(main, '.git', 'index'), wt2Index);
  assert.equal(await shellStart(wt2), null, 'an index that is a link adds nothing');
  // Review round 2: a superproject whose .git/modules is a link to another superproject's store.
  const sup2 = path.join(base, 'sup2'); await mkdir(sup2); init(sup2); await symlink(path.join(sup, '.git', 'modules'), path.join(sup2, '.git', 'modules'));
  const sub2 = path.join(sup2, 'sub'); await mkdir(sub2); await writeFile(path.join(sub2, '.git'), `gitdir: ${path.join(sup2, '.git', 'modules', 'sub')}\n`);
  assert.equal(await shellStart(sub2), null, 'a modules folder that is a link adds nothing');
  // Review round 3: a link at a two-character folder under the repo's objects would lead git's loose-object write
  // outside. The snapshot writes into its own store and only reads the repo's objects: nothing lands outside, and the
  // repo's own objects gain no file.
  const outside = path.join(base, 'outside'); await mkdir(outside);
  const objs = path.join(main, '.git', 'objects'), hex = [...'0123456789abcdef'];
  for (const a of hex) for (const b of hex) await symlink(outside, path.join(objs, a + b)).catch(() => {}); // the folders not there yet
  const loose = () => execFileSync('find', [objs, '-type', 'f'], { encoding: 'utf8' });
  const before = loose();
  assert.deepEqual(await listed(wt, 'a.txt', 'one\nround3\n'), ['a.txt'], 'a worktree with linked object folders still lists its edit');
  assert.deepEqual(await readdir(outside), [], 'nothing was written through a linked object folder');
  assert.equal(loose(), before, 'the repo\'s objects gained no file');
  await assert.rejects(stat(marker), 'nothing ran for any of them');
});
