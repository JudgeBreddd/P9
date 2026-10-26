import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { daemon, fixture, root, http, authenticated } from './helpers.mjs';

// GitHub issue #11: a computer with no terminal backend (macOS here, a Windows one whose ConPTY could not load) still
// has every terminal route, and each says terminal-unavailable with the reason, so no client reads it as a daemon that is down.
test('no terminal backend: every route answers terminal-unavailable with the reason; the socket closes 4503', { timeout: 30000 }, async (t) => {
  const { default: WebSocket } = await import('ws');
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--terminal-platform', 'darwin'] }));
  const headers = authenticated(instance.credentials);
  const call = async (route, method = 'GET', body) => {
    const result = await http({ socketPath: instance.credentials.socketPath, route, method,
      headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: result.status, body: JSON.parse(result.text) };
  };
  const unavailable = { error: 'terminal-unavailable', reason: 'P9 has no terminal for macOS yet.' };
  assert.deepEqual(await call('/terminals'), { status: 503, body: unavailable });
  assert.deepEqual(await call('/terminals', 'POST', {}), { status: 503, body: unavailable });
  assert.deepEqual(await call('/terminals/' + randomUUID() + '/stop', 'POST', {}), { status: 503, body: unavailable });
  const ws = new WebSocket('ws+unix://' + instance.credentials.socketPath + ':/terminals/' + randomUUID() + '/socket', { headers });
  const [code] = await new Promise((resolve, reject) => { ws.once('close', (...args) => resolve(args)); ws.once('error', reject); });
  assert.equal(code, 4503);
  // The setup wizard's tmux step is Linux-only, and Stop All still stops the rest.
  assert.equal((await call('/setup')).body.tmux, null);
  assert.equal((await call('/stop-all', 'POST', {})).status, 200);
  console.log('PASS no backend: list, create and stop 503 terminal-unavailable with the reason; socket closed 4503; setup tmux null; Stop All 200');
});

// BL4 (v0.1.4 review finding 7): --terminal-platform is a test flag; a daemon started outside the test home refuses it.
test('--terminal-platform outside the test home: the daemon refuses to start', { skip: process.platform === 'win32', timeout: 30000 }, async () => {
  const paths = await fixture();
  const run = spawnSync(process.execPath, ['apps/server/main.mjs', '--workspace', paths.workspace, '--state', paths.state,
    '--recovery', paths.recovery, '--terminal-platform', 'darwin'],
  { cwd: root, env: { PATH: process.env.PATH, HOME: paths.directory, XDG_STATE_HOME: paths.directory }, encoding: 'utf8', timeout: 10000 });
  assert.equal(run.status, 1, 'exited, not served: ' + run.stderr);
  assert.match(run.stderr, /invalid-terminal-platform/);
  console.log('PASS BL4: --terminal-platform without P9_TEST_HOME stops the daemon with invalid-terminal-platform');
});
