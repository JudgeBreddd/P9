import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, symlink, realpath, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { daemon, http, authenticated, remoteDaemon, passkeyDevice, enrollDevice } from './helpers.mjs';

// Dev Focus's second root (threat model row 41): a folder outside the workspace that only the desktop sets, after the native
// picker and confirm. Saves name it by its path and go through the guarded save; the phone's listener refuses any root.
const win = process.platform === 'win32';
const hash = (text) => createHash('sha256').update(text).digest('hex');
const call = async (instance, route, method = 'GET', body) => {
  const result = await http({ socketPath: instance.credentials.socketPath, route, method,
    headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: result.status, body: JSON.parse(result.text || '{}') };
};
const folderLink = (target, link) => symlink(target, link, win ? 'junction' : undefined);

test('dev root: only the desktop sets it, never on home, a drive root, the workspace or P9\'s own folders', { timeout: 60000 }, async (t) => {
  const instance = await daemon(t), dir = instance.directory; // the daemon's home is this folder (test/home-fixture.mjs)
  const ownership = win ? path.join(dir, 'local-app-data', 'P9') : path.join(dir, '.local', 'state', 'p9-foundation');
  const set = (folder) => call(instance, '/dev/root', 'POST', { path: folder });
  const unset = async (why) => assert.deepEqual(await call(instance, '/files', 'PUT', { path: 'a.txt', hash: hash(''), content: 'x', root: dir }),
    { status: 409, body: { error: 'dev-root-unset' } }, why);
  await unset('nothing set yet');
  for (const inner of [path.join(instance.state, 'inner'), path.join(instance.recovery, 'inner'), path.join(ownership, 'inner'), path.join(instance.workspace, 'sub')]) await mkdir(inner, { recursive: true });
  await writeFile(path.join(dir, 'file.txt'), 'x');
  const refused = { home: dir, 'drive root': path.parse(dir).root, workspace: instance.workspace, state: instance.state, 'inside state': path.join(instance.state, 'inner'),
    recovery: instance.recovery, 'inside recovery': path.join(instance.recovery, 'inner'), ownership, 'inside ownership': path.join(ownership, 'inner'), 'a file': path.join(dir, 'file.txt') };
  for (const [name, folder] of Object.entries(refused)) {
    assert.deepEqual(await set(folder), { status: 403, body: { error: 'root-refused' } }, name);
    await unset(name);
  }
  assert.deepEqual(await set(path.join(instance.workspace, 'sub')), { status: 409, body: { error: 'inside-workspace' } });
  assert.deepEqual(await set(path.join(dir, 'missing')), { status: 404, body: { error: 'root-not-found' } });
  for (const body of [{ path: 'relative' }, { path: dir, extra: 1 }, { path: 1 }, ['x']]) assert.equal((await call(instance, '/dev/root', 'POST', body)).status, 400, JSON.stringify(body));
  await unset('after the bad requests');
  console.log('PASS dev root refused: home, drive root, workspace, state, recovery, ownership (and inside them), a file, inside the workspace, missing, bad shapes');
});

test('dev root: saves stay inside it, through the guarded save, and the workspace keeps its own', { timeout: 60000 }, async (t) => {
  const instance = await daemon(t), dir = instance.directory;
  const outside = path.join(dir, 'outside'), elsewhere = path.join(dir, 'elsewhere');
  await mkdir(outside); await mkdir(elsewhere);
  await writeFile(path.join(elsewhere, 'b.txt'), 'keep\n');
  await folderLink(elsewhere, path.join(outside, 'link'));
  assert.deepEqual(await call(instance, '/dev/root', 'POST', { path: outside }), { status: 200, body: { root: await realpath(outside) } });
  const real = await realpath(outside), dev = (method, body) => call(instance, '/files', method, { ...body, root: real });

  assert.equal((await dev('POST', { path: 'new.txt', content: 'one\n' })).status, 201);
  assert.equal(await readFile(path.join(outside, 'new.txt'), 'utf8'), 'one\n');
  assert.deepEqual((await readdir(instance.workspace)).sort(), ['note.txt']);
  assert.equal((await dev('POST', { path: 'new.txt', content: 'again\n' })).status, 409, 'create never replaces');
  assert.equal((await dev('PUT', { path: 'new.txt', hash: hash('one\n'), content: 'two\n' })).body.kind, 'saved');
  assert.equal(await readFile(path.join(outside, 'new.txt'), 'utf8'), 'two\n');
  // A save on stale bytes is a conflict; the disk keeps the other change and the draft goes to recovery, outside the root.
  const stale = await dev('PUT', { path: 'new.txt', hash: hash('one\n'), content: 'three\n' });
  assert.deepEqual([stale.status, stale.body.kind], [409, 'conflict']);
  assert.equal(await readFile(path.join(outside, 'new.txt'), 'utf8'), 'two\n');
  assert.ok((await readdir(instance.recovery)).some((name) => name.startsWith('.p9-conflict-')));
  // Out of the root: .., an absolute path, a link out, File protection's locked names. The folder the link reaches is unchanged.
  for (const name of ['../escape.txt', path.join(elsewhere, 'b.txt'), 'link/b.txt', 'link/new.txt', 'secrets/k.txt', '.env']) {
    const saved = await dev('PUT', { path: name, hash: hash('keep\n'), content: 'owned\n' }), made = await dev('POST', { path: name, content: 'owned\n' });
    assert.ok(saved.status >= 400 && made.status >= 400, name + ': ' + saved.status + ' ' + made.status);
  }
  assert.equal(await readFile(path.join(elsewhere, 'b.txt'), 'utf8'), 'keep\n');
  assert.deepEqual((await readdir(elsewhere)).sort(), ['b.txt']);
  assert.deepEqual((await readdir(dir)).filter((name) => name === 'escape.txt'), []);
  // A save names the root main set; one naming another folder (a page of a folder Dev Focus has left) is refused.
  for (const root of [elsewhere, 'dev', real + path.sep]) assert.deepEqual((await call(instance, '/files', 'POST', { path: 'x.txt', content: 'x', root })).body, { error: 'dev-root-changed' }, root);
  assert.deepEqual((await call(instance, '/files', 'PUT', { path: 'new.txt', hash: hash('two\n'), content: 'x', root: elsewhere })).body, { error: 'dev-root-changed' });
  // A save without root is still the workspace's.
  assert.equal((await call(instance, '/files', 'PUT', { path: 'note.txt', hash: hash('original'), content: 'changed' })).body.kind, 'saved');
  assert.equal(await readFile(path.join(instance.workspace, 'note.txt'), 'utf8'), 'changed');
  // Back to the workspace: the root is gone.
  assert.deepEqual(await call(instance, '/dev/root', 'POST', { path: null }), { status: 200, body: { root: null } });
  assert.deepEqual((await dev('PUT', { path: 'new.txt', hash: hash('two\n'), content: 'x' })).body, { error: 'dev-root-unset' });
  assert.equal(await readFile(path.join(outside, 'new.txt'), 'utf8'), 'two\n');
  console.log('PASS dev root saves: create and guarded save inside it, conflict kept on disk, .., absolute, link out and locked names refused, unset after Back to workspace');
});

test('dev root on the phone: no route to set it, and root: \'dev\' is refused', { timeout: 60000, skip: win && 'Windows CI has no Playwright Chromium' }, async (t) => {
  const server = await remoteDaemon(t), outside = path.join(server.directory, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'a.txt'), 'one\n');
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const session = await enrollDevice(server, await passkeyDevice(browser, server, 'phone'));
  assert.equal((await server.desk('/dev/root', 'POST', { path: outside })).status, 200);
  assert.equal((await server.remote('/dev/root', { method: 'POST', session, body: { path: server.directory } })).status, 404);
  for (const root of ['dev', 'other']) {
    const result = await server.remote('/files', { method: 'PUT', session, body: { path: 'a.txt', hash: hash('one\n'), content: 'phone\n', root } });
    assert.deepEqual([result.status, result.body], [403, { error: 'request-refused' }], root);
  }
  assert.equal((await server.remote('/files', { method: 'POST', session, body: { path: 'b.txt', content: 'phone\n', root: 'dev' } })).status, 404);
  assert.equal(await readFile(path.join(outside, 'a.txt'), 'utf8'), 'one\n');
  assert.deepEqual(await readdir(outside), ['a.txt']);
  // The phone's own workspace save still works (the control).
  const own = await server.remote('/files', { method: 'PUT', session, body: { path: 'note.txt', hash: hash('original'), content: 'phone\n' } });
  assert.equal(own.body.kind, 'saved', own.text);
  console.log('PASS dev root on the phone: POST /dev/root 404, PUT root dev 403, POST /files 404, the root\'s files unchanged, its own workspace save works');
});

// A workspace change shows the new workspace in Dev Focus, whatever folder was open (the change itself runs the installed
// service scripts, so this reads the wiring; the reset is the same one p9 edit uses, run for real in dev.test.mjs).
test('dev root: a workspace change sends Dev Focus back to the new workspace', async () => {
  const main = await readFile(path.join(import.meta.dirname, '..', 'apps', 'desktop', 'main.mjs'), 'utf8');
  const change = main.slice(main.indexOf("ipcMain.handle('p9:workspace-change'"), main.indexOf("ipcMain.handle('p9:restart-service'"));
  assert.equal(change.match(/\{ devToWorkspace\(\); return \{ workspace: folder \}; \}/g)?.length, 2, 'both the Windows and the Linux success');
  assert.match(main, /const devToWorkspace = \(\) => \{ devFolder = null; reopenDev\(\); \};/);
  assert.match(main, /const reopenDev = \(\) => \{\s*if \(!devView\) return;[^]*?dev = null;\s*openDev\(\)/);
  console.log('PASS dev root: both workspace-change successes reset Dev Focus to the workspace');
});
