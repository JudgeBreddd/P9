// N6-1 (a): a daemon that fails to start says why in one short code beside P9_START_FAILED (CI once showed only
// "P9_START_FAILED" at 653 ms, so the cause could not be named). The code is the error's code or name, never its message,
// which can hold a path. Here the remote port is already taken, so the start fails with EADDRINUSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { daemon } from './helpers.mjs';

test('N6-1 (a): a failed start prints P9_START_FAILED and then a short reason code, not the error message', async (t) => {
  const taken = net.createServer().listen(0, '127.0.0.1');
  await once(taken, 'listening');
  t.after(() => taken.close());
  const port = taken.address().port;
  const error = await daemon(t, undefined, false, async () => ({
    args: ['--remote-port', String(port), '--remote-origin', 'http://localhost:' + port] })).then(() => null, (e) => e);
  assert.ok(error, 'the daemon started on a taken port');
  const stderr = error.message.split('\nstderr: ')[1] ?? '';
  assert.match(error.message, /^daemon-exit-1/);
  assert.deepEqual(stderr.trim().split('\n'), ['P9_START_FAILED', 'P9_START_FAILED_CODE EADDRINUSE']);
});
