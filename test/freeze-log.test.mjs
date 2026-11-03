// The desktop's freeze notes (apps/desktop/main.mjs, p9-freeze.log in its profile folder) are trimmed as daemon.log is
// (apps/server/windows.mjs trimLog): over LOG_MAX the file moves to .1 and the next note starts a new one, in order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { root } from './helpers.mjs';
import { LOG_MAX } from '../apps/server/windows.mjs';

const until = async (check, ms = 10000) => { const end = Date.now() + ms; while (!(await check())) { if (Date.now() > end) return false; await new Promise((r) => setTimeout(r, 100)); } return true; };
const read = (file) => readFile(file, 'utf8').catch(() => '');

test('p9-freeze.log over the limit moves to .1 at the next note; the new one keeps the notes in order', { timeout: 60000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'p9-freeze-')), log = path.join(profile, 'p9-freeze.log');
  const old = 'old note\n'.repeat(Math.ceil((LOG_MAX + 1) / 9));
  await writeFile(log, old);
  const env = { ...process.env, P9_SAMPLE_DATA: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--user-data-dir=' + profile], env, timeout: 15000 });
  t.after(() => app.close());
  await app.firstWindow({ timeout: 15000 });
  // A window that was unresponsive answers again: main.mjs notes it.
  const responsive = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.emit('responsive'));
  const notes = async () => (await read(log)).split('\n').filter((line) => /window responsive again after \d+ s$/.test(line));
  await responsive();
  assert.ok(await until(async () => (await notes()).length === 1), 'noted: ' + (await read(log)).slice(0, 200));
  assert.equal(await read(log + '.1'), old, 'the old notes moved to .1, whole');
  assert.ok((await read(log)).length < 4096, 'the new file holds only the new notes');
  await responsive(); await responsive();
  assert.ok(await until(async () => (await notes()).length === 3), 'three notes');
  const times = (await notes()).map((line) => Date.parse(line.split(' ')[0]));
  assert.deepEqual(times, [...times].sort((a, b) => a - b), 'in the order they were made');
  assert.equal(await read(log + '.1'), old, 'under the limit nothing moves again');
});
