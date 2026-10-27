// Send files over the tunnel (item 23, spec tunnel-file-transfer.md): the /xfer/* routes on two real daemons, the plan
// and send in desktop main (apps/desktop/xfer.mjs) over the stand-in ssh, and the file tree leaving heavy folders out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { daemon, remoteDaemon, http, authenticated, root, passkeyDevice, enrollDevice } from './helpers.mjs';
import { XFER_LIMITS, describe, overLimit, plan, planFolder, resolve, runPlan } from '../apps/desktop/xfer.mjs';

const skip = process.platform === 'win32' ? 'Unix sockets and sh; the receiver is Linux-only (replaceFile)' : false;
const sum = (data) => createHash('sha256').update(data).digest('hex');
const b64 = (data) => Buffer.from(data).toString('base64');
const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((result) => {
  let parsed = {};
  try { parsed = JSON.parse(result.text); } catch {}
  return { status: result.status, ...parsed };
});
const ROUTES = [['POST', '/xfer/manifest', { folder: '' }], ['GET', '/xfer/file?path=note.txt&offset=0'],
  ['POST', '/xfer/' + randomUUID() + '/part', { path: 'a', offset: 0, data: '' }], ['POST', '/xfer/' + randomUUID() + '/commit', { files: [] }],
  ['POST', '/xfer/' + randomUUID() + '/abort', {}]];

test('xfer check 1: every /xfer route needs the desktop cookie and is not on the phone listener', { skip, timeout: 60000 }, async (t) => {
  const server = await remoteDaemon(t);
  for (const [method, route, body] of ROUTES) {
    const anonymous = await http({ socketPath: path.join(server.state, 'daemon.sock'), route, method,
      headers: body ? { 'content-type': 'application/json' } : {}, body: body && JSON.stringify(body) });
    assert.equal(anonymous.status, 401, method + ' ' + route + ' without the cookie');
  }
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const session = await enrollDevice(server, await passkeyDevice(browser, server, 'phone'));
  for (const [method, route, body] of ROUTES) {
    const phone = await server.remote(route, { method, session, body, headers: { 'x-p9-op': randomUUID() } });
    assert.equal(phone.status, 404, method + ' ' + route + ' on the phone listener');
  }
  assert.equal((await call(server, '/xfer/manifest', 'POST', { folder: '' })).status, 200);
  console.log('PASS xfer check 1: 401 without the cookie, 404 for a logged-in phone, 200 on the desktop socket');
});

test('xfer checks 2-5: manifest skips, pieces resume at the size, commit refuses a changed file, recovery keeps old bytes', { skip, timeout: 60000 }, async (t) => {
  const box = await daemon(t, undefined, false, async ({ workspace }) => {
    const repo = path.join(workspace, 'proj');
    await mkdir(path.join(repo, 'src'), { recursive: true });
    await writeFile(path.join(repo, '.gitignore'), 'secret.log\n');
    await writeFile(path.join(repo, 'secret.log'), 'ignored');
    await writeFile(path.join(repo, 'src', 'a.txt'), 'alpha');
    await writeFile(path.join(repo, 'big.bin'), Buffer.alloc(5 * 1024 * 1024, 7));
    await symlink('/etc/hostname', path.join(repo, 'link'));
    await writeFile(path.join(repo, 'hard'), 'hard');
    await link(path.join(repo, 'hard'), path.join(repo, 'hard2'));
    execFileSync('git', ['init', '-q', repo]);
    // Not a git folder: node_modules and __pycache__ are left out.
    const plain = path.join(workspace, 'plain');
    await mkdir(path.join(plain, 'node_modules', 'x'), { recursive: true });
    await mkdir(path.join(plain, '__pycache__'));
    await writeFile(path.join(plain, 'node_modules', 'x', 'i.js'), '1');
    await writeFile(path.join(plain, '__pycache__', 'm.pyc'), '1');
    await writeFile(path.join(plain, 'keep.py'), 'print(1)');
    return {};
  });
  const manifest = await call(box, '/xfer/manifest', 'POST', { folder: 'proj' });
  assert.equal(manifest.status, 200, JSON.stringify(manifest));
  assert.deepEqual(manifest.files.map((f) => f.path), ['proj/.gitignore', 'proj/big.bin', 'proj/src/a.txt']);
  assert.equal(manifest.files.find((f) => f.path === 'proj/src/a.txt').sha256, sum('alpha'));
  assert.equal(manifest.skipped.ignored, 1, 'the .gitignored file');
  assert.equal(manifest.skipped.links, 3, 'the symlink and both names of the hardlink');
  const plain = await call(box, '/xfer/manifest', 'POST', { folder: 'plain' });
  assert.deepEqual(plain.files.map((f) => f.path), ['plain/keep.py']);
  assert.equal(plain.skipped.ignored, 2);
  assert.equal((await call(box, '/xfer/manifest', 'POST', { folder: '../x' })).status, 400);
  assert.equal((await call(box, '/xfer/manifest', 'POST', { folder: 'nope' })).status, 409);
  console.log('PASS xfer check 2: a .gitignored file, a symlink and a hardlink are not listed and are counted; node_modules is skipped');

  // Check 3: pieces. A big file in two pieces; the second sent at a wrong offset gets 409 with the size, then completes.
  const id = randomUUID(), big = manifest.files.find((f) => f.path === 'proj/big.bin');
  const first = await call(box, '/xfer/file?path=proj/big.bin&offset=0');
  assert.equal(first.bytes, 4 * 1024 * 1024);
  const part = (offset, data, name = 'copy/big.bin') => call(box, '/xfer/' + id + '/part', 'POST', { path: name, offset, data });
  assert.deepEqual(await part(0, first.data), { status: 200, size: first.bytes });
  const second = await call(box, '/xfer/file?path=proj/big.bin&offset=' + first.bytes);
  assert.deepEqual(await part(7, second.data), { status: 409, error: 'offset', size: first.bytes });
  assert.deepEqual(await part(first.bytes, second.data), { status: 200, size: big.size });
  assert.equal((await call(box, '/xfer/file?path=proj/link&offset=0')).status, 400, 'a symlink is never read');
  assert.equal((await call(box, '/xfer/file?path=proj/.git/config&offset=0')).status, 400, 'a locked name is never read');
  console.log('PASS xfer check 3: a part at the wrong offset got 409 with the size; resending from it completed');

  // Commit: a new file lands; a wrong hash is upload-mismatch and writes nothing.
  assert.equal((await call(box, '/xfer/' + id + '/commit', 'POST', { files: [{ path: 'copy/big.bin', size: big.size, sha256: sum('x'), expect: null }] })).error, 'upload-mismatch');
  await assert.rejects(stat(path.join(box.workspace, 'copy/big.bin')));
  assert.equal((await part(0, first.data)).status, 200);
  assert.equal((await part(first.bytes, second.data)).status, 200);
  const landed = await call(box, '/xfer/' + id + '/commit', 'POST', { files: [{ path: 'copy/big.bin', size: big.size, sha256: big.sha256, expect: null }] });
  assert.deepEqual(landed, { status: 200, written: ['copy/big.bin'], replaced: [], removed: [] });
  assert.equal(sum(await readFile(path.join(box.workspace, 'copy/big.bin'))), big.sha256);

  // Check 4: the receiver's file changed after the plan: listed in changed, its bytes untouched.
  const note = path.join(box.workspace, 'note.txt'), planned = sum('original');
  await writeFile(note, 'edited after the plan');
  assert.equal((await part(0, b64('from the laptop'), 'note.txt')).status, 200);
  const cas = await call(box, '/xfer/' + id + '/commit', 'POST', { files: [{ path: 'note.txt', size: 15, sha256: sum('from the laptop'), expect: planned }] });
  assert.equal(cas.status, 409);
  assert.deepEqual(cas.files, ['note.txt']);
  assert.equal(await readFile(note, 'utf8'), 'edited after the plan');
  console.log('PASS xfer check 4: a file changed after the plan is listed in changed and keeps its bytes');

  // Check 5: replaced and deleted files keep their old bytes in recovery, byte for byte.
  assert.equal((await part(0, b64('from the laptop'), 'note.txt')).status, 200);
  const replaced = await call(box, '/xfer/' + id + '/commit', 'POST', { files: [{ path: 'note.txt', size: 15, sha256: sum('from the laptop'), expect: sum('edited after the plan') }],
    deletes: [{ path: 'proj/src/a.txt', expect: sum('alpha') }] });
  assert.equal(replaced.status, 200, JSON.stringify(replaced));
  assert.equal(await readFile(note, 'utf8'), 'from the laptop');
  await assert.rejects(stat(path.join(box.workspace, 'proj/src/a.txt')));
  assert.equal(await readFile(path.join(box.recovery, replaced.replaced[0].recovery), 'utf8'), 'edited after the plan');
  assert.equal(await readFile(path.join(box.recovery, replaced.removed[0].recovery), 'utf8'), 'alpha');
  assert.match(replaced.replaced[0].recovery, /^replaced\/[^/]+\/note\.txt$/);
  assert.equal(((await stat(path.join(box.recovery, replaced.replaced[0].recovery))).mode & 0o777), 0o600);
  // A delete whose file changed since the plan deletes nothing.
  const kept = await call(box, '/xfer/' + id + '/commit', 'POST', { files: [], deletes: [{ path: 'note.txt', expect: sum('original') }] });
  assert.deepEqual([kept.status, kept.files], [409, ['note.txt']]);
  assert.equal(await readFile(note, 'utf8'), 'from the laptop');
  // Crafted paths are refused; nothing outside the workspace is written.
  for (const name of ['../out', '/abs', 'a//b', '.git/config', 'proj/link/x']) {
    const sent = await part(0, b64('x'), name);
    if (sent.status === 200) {
      const commit = await call(box, '/xfer/' + id + '/commit', 'POST', { files: [{ path: name, size: 1, sha256: sum('x'), expect: null }] });
      assert.notEqual(commit.status, 200, name);
    } else assert.equal(sent.status, 400, name);
  }
  await assert.rejects(stat(path.join(box.directory, 'out')));
  assert.equal((await call(box, '/xfer/' + id + '/abort', 'POST', {})).status, 200);
  assert.deepEqual(await readdir(path.join(box.directory, '.local', 'state', 'p9-foundation', 'xfer')).catch(() => []), []);
  console.log('PASS xfer check 5: replaced and deleted files are byte-identical under recovery/replaced; a changed file is never deleted');

  // The file tree leaves the heavy folders out (Builder's answer 1); the folder itself still lists.
  const tree = await call(box, '/files/list?path=plain');
  assert.deepEqual(tree.entries.map((e) => e.name), ['keep.py']);
  console.log('PASS xfer crawler: the file tree leaves node_modules and __pycache__ out');
});

// The plan alone (no daemons): what is asked, what each choice does, and the limits.
test('xfer plan: a first send asks, a laptop delete asks, delete against change is a conflict, a limit names its Setting', { timeout: 60000 }, () => {
  const H = (c) => c.repeat(64), f = (name, c, mtimeMs = 1000, size = 10) => ({ path: name, size, sha256: H(c), mtimeMs });
  const side = (...files) => ({ files, skipped: {}, truncated: false, syncthing: [] }), names = (list) => list.map((i) => i.path);
  // No record: a file on both that differs is asked; only on the laptop is sent; only on the server is left alone.
  const first = plan(side(f('a', '1', 2000), f('b', '2')), side(f('a', '3', 1000), f('c', '4')), null, '');
  assert.deepEqual([names(first.first), names(first.send), first.deletes, first.conflicts], [['a'], ['b'], [], []]);
  assert.deepEqual(first.summary, { laptopNewer: 1, serverNewer: 0 });
  assert.equal(resolve(first, null, false), null, 'a first send with a difference waits for a choice');
  assert.equal(resolve(first, 'server', false), null, 'a first send offers laptop or newer');
  assert.deepEqual(names(resolve(first, 'laptop', false).toServer), ['b', 'a']);
  assert.match(describe(first.first[0], null), /different on the two; the laptop's copy is newer/);
  // With a record: a changed here; b changed on the server only (stays); c deleted here; d deleted here and changed there;
  // e changed here and deleted there; g changed on both.
  const record = { a: H('1'), b: H('2'), c: H('3'), d: H('4'), e: H('5'), g: H('6') };
  const p = plan(side(f('a', '7'), f('b', '2'), f('e', '8'), f('g', '9', Date.parse('2026-10-27T11:02:00'))),
    side(f('a', '1'), f('b', 'a'), f('c', '3'), f('d', 'b'), f('g', 'c', Date.parse('2026-10-27T13:40:00'))), record, '');
  assert.deepEqual([names(p.send), names(p.deletes), names(p.conflicts)], [['a'], ['c'], ['d', 'e', 'g']]);
  assert.match(describe(p.conflicts[0], record), /deleted on the laptop; changed on the server since your last send/);
  assert.match(describe(p.conflicts[1], record), /changed on the laptop .*; deleted on the server since your last send/);
  assert.match(describe(p.conflicts[2], record), /changed on both since your last send; the server's copy is newer \(.*1:40.*\) than the laptop's \(.*11:02.*\)/);
  // Delete unticked: the server keeps c and the record forgets it. "Newer" never turns a change into a silent delete.
  const newer = resolve(p, 'newer', false);
  assert.deepEqual([names(newer.toServer), names(newer.toLaptop), names(newer.serverDeletes), names(newer.laptopDeletes), names(newer.forget)],
    [['a', 'e'], ['d', 'g'], [], [], ['c']]);
  const laptop = resolve(p, 'laptop', true);
  assert.deepEqual([names(laptop.toServer), names(laptop.serverDeletes)], [['a', 'e', 'g'], ['d', 'c']]);
  // Limits: each refusal names its Setting by the label Settings shows.
  const work = (...sizes) => ({ toServer: sizes.map((size, i) => ({ laptop: f('f' + i, '1', 0, size) })), toLaptop: [] });
  const MiB = 1024 ** 2, limits = { fileMiB: 512, files: 20000, sendGiB: 4 };
  assert.deepEqual(overLimit(work(600 * MiB), limits, false).setting, 'fileMiB');
  assert.match(overLimit(work(600 * MiB), limits, false).message, /f0 is 600\.0 MiB; the limit is 512 MiB a file\. Change it in Settings, Largest file to send\./);
  assert.equal(overLimit(work(1, 1, 1), { ...limits, files: 2 }, false).setting, 'files');
  assert.match(overLimit(work(1), limits, true).message, /Most files in one send/);
  assert.equal(overLimit(work(500 * MiB, 500 * MiB), { ...limits, sendGiB: 0.5 }, false).setting, 'sendGiB');
  assert.equal(overLimit(work(500 * MiB), limits, false), null);
  assert.deepEqual(Object.keys(XFER_LIMITS).sort(), Object.keys(limits).sort());
  console.log('PASS xfer plan: first send asks; delete asks; delete vs change is a conflict; each limit names its Setting');
});

// Two real daemons and the stand-in ssh between them (send-to-server.test.mjs's pair).
async function pair(t, laptopFiles, serverFiles) {
  const fill = (files) => async ({ workspace }) => { for (const [name, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(workspace, name)), { recursive: true }); await writeFile(path.join(workspace, name), text); } return {}; };
  const laptop = await daemon(t, undefined, false, fill(laptopFiles)), server = await daemon(t, undefined, false, fill(serverFiles));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'p9-xfer-'));
  const runtime = path.join(directory, 'server'), local = path.join(directory, 'local'), userData = path.join(directory, 'profile');
  await mkdir(runtime); await mkdir(local, { mode: 0o700 });
  await symlink(server.state, path.join(runtime, 'p9-foundation'));
  const ssh = path.join(directory, 'ssh'), q = (s) => "'" + s + "'";
  await writeFile(ssh, '#!/bin/sh\nFAKE_RUNTIME=' + q(runtime) + ' FAKE_SSH_LOG=' + q(path.join(directory, 'ssh.log')) + ' exec ' + q(process.execPath) + ' ' + q(path.join(root, 'test/fake-ssh.mjs')) + ' "$@"\n');
  await chmod(ssh, 0o755);
  const at = { local: laptop.state, host: 'test-host', userData, ssh, runtime: local };
  return { laptop, server, planned: async (folder) => { const got = await planFolder({ ...at, folder }); assert.ok(got.plan, JSON.stringify(got)); return got.plan; },
    run: (p, work, onProgress) => runPlan({ ...at, plan: p, work, onProgress }) };
}

test('xfer send: a first send asks; the next carries changes, asks for conflicts and deletes, and keeps every old copy', { skip, timeout: 60000 }, async (t) => {
  const { laptop, server, planned, run } = await pair(t,
    { 'proj/a.txt': 'alpha', 'proj/b.txt': 'beta', 'proj/d.txt': 'delta', 'proj/node_modules/x.js': 'x' }, { 'proj/a.txt': 'server alpha' });
  const read = (box, name) => readFile(path.join(box.workspace, name), 'utf8');
  // First send: no record and a.txt differs, so it is asked; node_modules never goes.
  const one = await planned('proj');
  assert.deepEqual([one.first.map((i) => i.path), one.send.map((i) => i.path)], [['proj/a.txt'], ['proj/b.txt', 'proj/d.txt']]);
  assert.equal(one.skipped.ignored, 1);
  const progress = [], first = await run(one, resolve(one, 'laptop', false), (p) => progress.push(p));
  assert.equal(first.error, undefined, JSON.stringify(first));
  assert.deepEqual(first.sent.sort(), ['proj/a.txt', 'proj/b.txt', 'proj/d.txt']);
  assert.deepEqual(progress.at(-1), { total: 14, sent: 14 });
  assert.equal(await read(server, 'proj/a.txt'), 'alpha');
  assert.equal(await readFile(path.join(server.recovery, first.recovery.server[0].recovery), 'utf8'), 'server alpha');
  await assert.rejects(stat(path.join(server.workspace, 'proj/node_modules')));
  console.log('PASS xfer first send: a file on both that differs was asked; laptop wins kept the server\'s copy in recovery');

  // Since: a changed here; b changed on both; c new here; d deleted here; the server's proj is a Syncthing folder.
  await writeFile(path.join(laptop.workspace, 'proj/a.txt'), 'alpha 2');
  await writeFile(path.join(laptop.workspace, 'proj/b.txt'), 'beta laptop');
  await writeFile(path.join(server.workspace, 'proj/b.txt'), 'beta server');
  await writeFile(path.join(laptop.workspace, 'proj/c.txt'), 'gamma');
  await rm(path.join(laptop.workspace, 'proj/d.txt'));
  await mkdir(path.join(server.workspace, 'proj/.stfolder'));
  const two = await planned('proj');
  assert.deepEqual([two.send.map((i) => i.path), two.conflicts.map((i) => i.path), two.deletes.map((i) => i.path), two.first],
    [['proj/a.txt', 'proj/c.txt'], ['proj/b.txt'], ['proj/d.txt'], []]);
  assert.deepEqual(two.syncthing, { laptop: [], server: ['proj'] });
  console.log('PASS xfer syncthing: a .stfolder in the server\'s folder is found before sending');
  assert.equal(resolve(two, null, true), null, 'a conflict waits for a choice');
  const second = await run(two, resolve(two, 'laptop', true));
  assert.equal(second.error, undefined, JSON.stringify(second));
  assert.deepEqual([await read(server, 'proj/a.txt'), await read(server, 'proj/b.txt'), await read(server, 'proj/c.txt')], ['alpha 2', 'beta laptop', 'gamma']);
  await assert.rejects(stat(path.join(server.workspace, 'proj/d.txt')));
  const kept = Object.fromEntries(await Promise.all(second.recovery.server.map(async (r) => [r.path, await readFile(path.join(server.recovery, r.recovery), 'utf8')])));
  assert.deepEqual(kept, { 'proj/a.txt': 'alpha', 'proj/b.txt': 'beta server', 'proj/d.txt': 'delta' });
  console.log('PASS xfer conflict and delete: laptop wins replaced b, the asked delete removed d; every old copy is in recovery');

  // Everything matches now: the next plan has nothing to send or ask. Keep the server's copy of a conflict brings it here.
  const three = await planned('proj');
  assert.deepEqual([three.send, three.conflicts, three.deletes, three.same.length], [[], [], [], 3]);
  await writeFile(path.join(laptop.workspace, 'proj/c.txt'), 'gamma laptop');
  await writeFile(path.join(server.workspace, 'proj/c.txt'), 'gamma server');
  const four = await planned('proj'), back = await run(four, resolve(four, 'server', false));
  assert.deepEqual(back.received, ['proj/c.txt']);
  assert.equal(await read(laptop, 'proj/c.txt'), 'gamma server');
  assert.equal(await readFile(path.join(laptop.recovery, back.recovery.laptop[0].recovery), 'utf8'), 'gamma laptop');
  assert.deepEqual((await planned('proj')).conflicts, []);
  console.log('PASS xfer keep the server\'s: the server\'s copy came here and the laptop\'s went to recovery');
});
