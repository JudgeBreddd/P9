import test from 'node:test';
import assert from 'node:assert/strict';
import { daemon, http, authenticated, leased } from './helpers.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// GitHub issue #11: the Windows terminal (ConPTY through node:ffi) through the real routes and the daemon's own pipe,
// the way the desktop dock reaches it: open, run a command, read its output back, stop, and nothing left running.
test('Windows terminal: open, run a command, read its output, stop; the shell is gone', {
  skip: process.platform !== 'win32' && 'requires ConPTY',
  timeout: 90000,
}, async (t) => {
  const { default: WebSocket } = await import('ws');
  const instance = await daemon(t);
  const headers = authenticated(instance.credentials);
  const call = async (route, method = 'GET', body) => {
    const result = await http({ socketPath: instance.credentials.socketPath, route, method,
      headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: result.status, body: JSON.parse(result.text) };
  };
  const made = await call('/terminals', 'POST', {});
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const id = made.body.terminal;
  // The same URL form the desktop's relay uses for the pipe (apps/desktop/main.mjs).
  const ws = new WebSocket('ws+unix:' + instance.credentials.socketPath + ':/terminals/' + id + '/socket', { headers });
  let output = '';
  ws.on('message', (data, binary) => { if (binary) output += data.toString('utf8'); });
  const keys = leased(ws);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  t.after(() => ws.close());
  // The typed line echoes back too, so the marker is joined by PowerShell: only its output holds P9-CONPTY-OK.
  const until = async (pattern) => {
    for (let i = 0; i < 300 && !pattern.test(output); i++) await wait(100);
    const match = pattern.exec(output);
    assert.ok(match, 'no ' + pattern + ' in the output: ' + JSON.stringify(output.slice(-500)));
    return match;
  };
  await keys.keys("Write-Output ('P9-' + 'CONPTY-OK'); Write-Output ('SHELL' + 'PID=' + $PID)\r");
  await until(/P9-CONPTY-OK/);
  const pid = Number((await until(/SHELLPID=(\d+)/))[1]);
  assert.equal(alive(pid), true);
  const stopped = await call('/terminals/' + id + '/stop', 'POST', {});
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
  for (let i = 0; i < 50 && alive(pid); i++) await wait(100);
  assert.equal(alive(pid), false, 'the shell outlived Stop');
  assert.equal((await call('/terminals')).body.terminals.find((row) => row.id === id)?.state, 'stopped');
  console.log('PASS Windows terminal: POST 201, PowerShell answered through the pipe socket, Stop 200, shell pid ' + pid + ' gone, row stopped');
});
