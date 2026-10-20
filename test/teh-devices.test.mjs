// Phase 13: the desktop side of phone enrollment from a terminal (teh devices), against a real daemon.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { root, remoteDaemon as start, askEnrollment as ask } from './helpers.mjs';

const run = promisify(execFile);
async function teh(server, ...args) {
  try {
    const { stdout } = await run(process.execPath, [path.join(root, 'scripts', 'teh.mjs'), 'devices', ...args, '--state', server.state]);
    return { code: 0, body: JSON.parse(stdout) };
  } catch (error) { return { code: error.code, body: error.stdout ? JSON.parse(error.stdout) : null, stderr: error.stderr }; }
}

test('Phase 13: teh devices lists a phone that asked, approves one and refuses another', async (t) => {
  const server = await start(t);
  const phone = await ask(server, 'phone'), stranger = await ask(server, 'stranger');
  const listed = await teh(server);
  assert.equal(listed.code, 0);
  assert.deepEqual(listed.body.enrollments.map((e) => [e.name, e.state]), [['phone', 'pending'], ['stranger', 'pending']]);
  assert.match(listed.body.enrollments[0].code, /^\d{6}$/, 'the code the phone shows is listed, to compare before approving');

  assert.equal((await teh(server, 'approve', phone)).code, 0);
  assert.equal((await teh(server, 'refuse', stranger)).code, 0);
  assert.deepEqual((await teh(server)).body.enrollments.map((e) => [e.name, e.state]), [['phone', 'approved']]);

  // An unknown id fails with a nonzero exit; a bad action is refused before any request.
  assert.notEqual((await teh(server, 'approve', 'no-such-id')).code, 0);
  const bad = await teh(server, 'approve');
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /use-devices/);
});
