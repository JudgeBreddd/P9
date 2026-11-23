// MC-15: files a turn changed through the shell (no Write or Edit call) come as one finished edit call, "Shell edits", with
// each file's hunks, so the Changes list shows them. A folder outside git adds nothing. The fake agent's prompts that write
// are in fake-acp-agent.mjs ('shell writes', 'shell many', 'shell big').
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { daemon, http, authenticated, root } from './helpers.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const sh = (cwd, ...args) => execFileSync(realGit, ['-C', cwd, ...args], { encoding: 'utf8' });

// proj: a repo with a commit, plus predirty.txt and dirty.txt changed before any turn. plain: a folder outside git.
// hooked: a repo whose post-index-change hook, fsmonitor and *.tc textconv run the evil script; filtered: one whose
// filter (clean, smudge) does. The evil script notes each run in its marker file.
// outer: the workspace and the folder above it are in one repo (sib.txt in the workspace, outside.txt above it), so plain is
// a subfolder of a larger repo.
// A git on PATH that waits the seconds in its folder's "sleep" file before "add" (the snapshot's slow step).
async function start(t, { outer = false } = {}) {
  let bin, marker;
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
    for (const [dir, files] of [[hooked, [['a.tc', 'tc\n'], ['.gitattributes', '*.tc diff=evil\n']]], [filtered, [['f.txt', 'f\n'], ['.gitattributes', '* filter=evil\n']]]]) {
      await mkdir(dir); sh(dir, 'init', '-q'); sh(dir, 'config', 'user.email', 't@example.invalid'); sh(dir, 'config', 'user.name', 't');
      for (const [f, text] of files) await writeFile(path.join(dir, f), text);
      sh(dir, 'add', '-A'); sh(dir, 'commit', '-qm', 'start');
    }
    sh(hooked, 'config', 'core.fsmonitor', await evil('fsmonitor')); sh(hooked, 'config', 'diff.evil.textconv', await evil('textconv'));
    await writeFile(path.join(hooked, '.git/hooks/post-index-change'), `#!/bin/sh\nexec '${await evil('hook')}'\n`); await chmod(path.join(hooked, '.git/hooks/post-index-change'), 0o755);
    sh(filtered, 'config', 'filter.evil.clean', await evil('filter-clean')); sh(filtered, 'config', 'filter.evil.smudge', await evil('filter-smudge'));
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
  return { call, ended, chat, shells, bin, marker };
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

test('MC-15 no program the repo configures runs: hook, fsmonitor, textconv; a repo with a filter is skipped', { timeout: 90000 }, async (t) => {
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
  assert.equal(shells(out).length, 0, 'a filter is configured: no snapshot, nothing added');
  assert.ok(!out.some((e) => e.type === 'error'), 'and no error');
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
