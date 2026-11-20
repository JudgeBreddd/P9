// W2: the daemon's stop ends the processes the live usage polls started. The unit stops with KillMode=process
// (scripts/install-service.mjs), so systemd signals only the daemon: a Claude SDK process or a Codex app server still
// open at stop would be left running after an update's restart. Stand-ins: an SDK whose query starts a long-lived child
// (as the real one starts claude) and a Codex app server that never answers; each writes its process id to a file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { daemon, root, http, authenticated } from './helpers.mjs';

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

test('W2 the daemon stop ends the Claude SDK and Codex usage processes it started', { timeout: 90000 }, async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'p9-usage-stop-')), pids = path.join(folder, 'pids');
  await writeFile(pids, '');
  const sdk = path.join(folder, 'sdk.mjs'), codex = path.join(folder, 'codex.mjs');
  await writeFile(sdk, `import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const later = (hours) => new Date(Date.now() + hours * 3600e3).toISOString();
export const query = () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
  appendFileSync(${JSON.stringify(pids)}, 'claude ' + child.pid + '\\n');
  return { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({ rate_limits_available: true,
    rate_limits: { five_hour: { utilization: 37, resets_at: later(2) }, seven_day: { utilization: 63, resets_at: later(96) } } }),
    close() { child.kill(); } };
};
`);
  await writeFile(codex, `import { appendFileSync } from 'node:fs';
process.env.FAKE_CODEX_USAGE = 'hang';
appendFileSync(${JSON.stringify(pids)}, 'codex ' + process.pid + '\\n');
await import(${JSON.stringify(pathToFileURL(path.join(root, 'test/fake-codex-app-server.mjs')).href)});
`);
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', path.join(root, 'test/fake-acp-agent.mjs'),
    '--usage-sdk', sdk, '--codex-usage', codex] }));
  let started = {};
  t.after(() => { for (const pid of Object.values(started)) if (alive(pid)) process.kill(pid, 'SIGKILL'); });
  // A look at usage starts both polls. The Codex read gives up after 5 s on its own, so the stop comes right after.
  await http({ socketPath: path.join(instance.state, 'daemon.sock'), route: '/usage', headers: authenticated(instance.credentials) });
  for (const end = Date.now() + 20000; !(started.claude && started.codex); await new Promise((resolve) => setTimeout(resolve, 100))) {
    if (Date.now() > end) assert.fail('the polls did not start both processes: ' + JSON.stringify(started));
    started = Object.fromEntries((await readFile(pids, 'utf8')).split('\n').filter(Boolean).map((line) => [line.split(' ')[0], Number(line.split(' ')[1])]));
  }
  assert.ok(alive(started.claude) && alive(started.codex), 'both running before the stop');
  instance.child.kill('SIGTERM');
  const [code] = await once(instance.child, 'exit');
  assert.equal(code, 0, 'a clean stop');
  for (const end = Date.now() + 5000; (alive(started.claude) || alive(started.codex)) && Date.now() < end;) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual({ claude: alive(started.claude), codex: alive(started.codex) }, { claude: false, codex: false }, 'still running after the daemon stopped');
  console.log('PASS W2 stop ends the usage processes');
});

// W2 FIX1: the stop comes while the poll is still loading the SDK (held here until the file `go` exists). The daemon waits
// for that read: the query opens after the stop, its child is closed, and only then does the daemon exit cleanly.
test('W2 FIX1 a stop while the Claude usage query is still opening: the daemon waits, closes its child, then exits cleanly', { timeout: 90000 }, async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'p9-usage-stop-open-')), pids = path.join(folder, 'pids'), go = path.join(folder, 'go');
  await writeFile(pids, '');
  const sdk = path.join(folder, 'sdk.mjs');
  await writeFile(sdk, `import { spawn } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
appendFileSync(${JSON.stringify(pids)}, 'loading 0\\n');
while (!existsSync(${JSON.stringify(go)})) await new Promise((resolve) => setTimeout(resolve, 50));
const later = (hours) => new Date(Date.now() + hours * 3600e3).toISOString();
export const query = () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
  appendFileSync(${JSON.stringify(pids)}, 'claude ' + child.pid + '\\n');
  return { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({ rate_limits_available: true,
    rate_limits: { five_hour: { utilization: 37, resets_at: later(2) }, seven_day: { utilization: 63, resets_at: later(96) } } }),
    close() { child.kill(); } };
};
`);
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', path.join(root, 'test/fake-acp-agent.mjs'), '--usage-sdk', sdk] }));
  const read = async () => Object.fromEntries((await readFile(pids, 'utf8')).split('\n').filter(Boolean).map((line) => [line.split(' ')[0], Number(line.split(' ')[1])]));
  let started = {};
  t.after(() => { if (started.claude && alive(started.claude)) process.kill(started.claude, 'SIGKILL'); });
  await http({ socketPath: path.join(instance.state, 'daemon.sock'), route: '/usage', headers: authenticated(instance.credentials) });
  for (const end = Date.now() + 20000; !('loading' in started); await new Promise((resolve) => setTimeout(resolve, 50))) {
    if (Date.now() > end) assert.fail('the poll did not start loading the SDK');
    started = await read();
  }
  instance.child.kill('SIGTERM');
  const exited = once(instance.child, 'exit');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(instance.child.exitCode, null, 'the daemon waits for the read still opening');
  await writeFile(go, '');
  const [code] = await exited;
  started = await read();
  assert.ok(started.claude, 'the held query opened after the stop');
  assert.equal(code, 0, 'a clean stop');
  for (const end = Date.now() + 3000; alive(started.claude) && Date.now() < end;) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(alive(started.claude), false, 'its child was closed before the exit');
  console.log('PASS W2 FIX1 stop waits for the opening read');
});
