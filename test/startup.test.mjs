import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink, readdir, writeFile, readFile } from 'node:fs/promises';
import { spawnSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fixture, root, daemon, http, authenticated } from './helpers.mjs';
import { once } from 'node:events';
import { hash } from '../packages/files/index.mjs';

test('different XDG state homes cannot bypass the home-directory daemon lock', async (t) => {
  const first = await daemon(t);
  const second = spawnSync(process.execPath, ['--import', './test/home-fixture.mjs', 'apps/server/main.mjs',
    '--workspace', first.workspace, '--state', path.join(first.directory, 'second-state'), '--recovery', first.recovery],
  { cwd: root, env: { PATH: process.env.PATH, P9_TEST_HOME: first.directory,
    XDG_STATE_HOME: path.join(first.directory, 'different-xdg') }, encoding: 'utf8', timeout: 1000 });
  assert.equal(second.status, 1, second.stderr);
  assert.match(second.stderr, /daemon-already-running/);
});

test('one daemon per user state home refuses nested and disjoint workspace roots', async (t) => {
  const first = await daemon(t);
  for (const workspace of [path.join(first.workspace, 'sub'), path.join(first.directory, 'other')]) {
    await mkdir(workspace);
    const second = spawnSync(process.execPath, ['--import', './test/home-fixture.mjs', 'apps/server/main.mjs', '--workspace', workspace,
      '--state', path.join(first.directory, 'second-state'), '--recovery', first.recovery],
    { cwd: root, env: { PATH: process.env.PATH, P9_TEST_HOME: first.directory, XDG_STATE_HOME: first.directory }, encoding: 'utf8', timeout: 1000 });
    assert.equal(second.status, 1, second.stderr);
    assert.match(second.stderr, /daemon-already-running/);
  }
  assert.equal((await http({ socketPath: path.join(first.state, 'daemon.sock'), headers: authenticated(first.credentials) })).status, 200);
});

test('SIGTERM drains an in-flight PUT and completes recovery cleanup before exit', async (t) => {
  const instance = await daemon(t, 'test/shutdown-worker.mjs');
  const paused = once(instance.child, 'message');
  const response = http({ socketPath: path.join(instance.state, 'daemon.sock'), route: '/files', method: 'PUT',
    headers: { ...authenticated(instance.credentials), 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'note.txt', hash: hash('original'), content: 'shutdown draft' }) });
  // Capture connection errors without leaving an unhandled rejection during the barrier.
  const outcome = response.then((value) => value, (error) => ({ error: error.message }));
  assert.equal((await paused)[0], 'save-paused');
  const terminated = once(instance.child, 'message');
  const exited = once(instance.child, 'exit');
  instance.child.kill('SIGTERM');
  assert.equal((await terminated)[0], 'signal-seen');
  instance.child.send('release', () => {});
  const result = await outcome;
  const [code, signal] = await exited;
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(JSON.parse(result.text).kind, 'saved');
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.equal(await readFile(path.join(instance.workspace, 'note.txt'), 'utf8'), 'shutdown draft');
  assert.deepEqual(await readdir(instance.recovery), []);
});

test('startup refuses state within workspace, symlink aliases, shared recovery and nonempty state', async () => {
  for (const kind of ['inside', 'alias', 'workspace-alias', 'shared', 'nonempty', 'ownership-inside']) {
    const item = await fixture();
    let workspace = item.workspace, state = item.state, recovery = item.recovery;
    if (kind === 'inside') state = path.join(workspace, 'runtime');
    if (kind === 'alias') {
      const alias = path.join(item.directory, 'alias');
      await symlink(workspace, alias);
      state = path.join(alias, 'runtime');
    }
    if (kind === 'workspace-alias') {
      workspace = path.join(item.directory, 'alias');
      await symlink(item.workspace, workspace);
      state = path.join(item.workspace, 'runtime');
    }
    if (kind === 'shared') state = recovery;
    if (kind === 'nonempty') {
      await mkdir(state, { mode: 0o700 });
      await writeFile(path.join(state, 'sentinel'), 'keep');
    }
    const result = spawnSync(process.execPath, ['--import', './test/home-fixture.mjs', 'apps/server/main.mjs', '--workspace', workspace,
      '--state', state, '--recovery', recovery], { cwd: root,
      env: { PATH: process.env.PATH, P9_TEST_HOME: kind === 'ownership-inside' ? item.workspace : item.directory, XDG_STATE_HOME: kind === 'ownership-inside' ? item.workspace : item.directory }, timeout: 3000 });
    assert.equal(result.status, 1, kind);
    assert.deepEqual(await readdir(item.workspace), ['note.txt'], 'no credential or state files enter workspace');
    if (kind === 'nonempty') assert.deepEqual(await readdir(state), ['sentinel']);
  }
  console.log('PASS startup boundary: private directories outside canonical workspace; aliases, overlap and nonempty state refused');
});

test('canonical workspace has one live daemon across state directories; SIGKILL releases ownership', async (t) => {
  const first = await daemon(t);
  const alias = path.join(first.directory, 'workspace-alias');
  await symlink(first.workspace, alias);
  const secondState = path.join(first.directory, 'second-state');
  const args = ['--import', './test/home-fixture.mjs', 'apps/server/main.mjs', '--workspace', alias, '--state', secondState, '--recovery', first.recovery];
  const environment = { PATH: process.env.PATH, P9_TEST_HOME: first.directory, XDG_STATE_HOME: first.directory };
  const second = spawnSync(process.execPath, args, { cwd: root, env: environment, encoding: 'utf8', timeout: 3000 });
  assert.equal(second.error, undefined);
  assert.equal(second.status, 1, second.stderr);
  assert.match(second.stderr, /daemon-already-running/);
  assert.equal((await http({ socketPath: path.join(first.state, 'daemon.sock'), headers: authenticated(first.credentials) })).status, 200);
  first.child.kill('SIGKILL');
  await once(first.child, 'exit');
  // A manual restart uses fresh runtime state, as documented; recovery stays durable.
  const restarted = spawn(process.execPath, args, { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (restarted.exitCode === null && restarted.signalCode === null) { restarted.kill('SIGTERM'); await once(restarted, 'exit'); } });
  const [output] = await once(restarted.stdout, 'data', { signal: AbortSignal.timeout(3000) });
  assert.match(String(output), /P9_READY/);
  console.log('PASS workspace ownership: second real daemon with separate state refused; alias covered; SIGKILL permits restart');
});
