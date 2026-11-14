// Review item 22 (window-3): Dev Focus keeps its build between opens, but a new build (a hand-run pnpm build:dev rewrites
// dev/dist/index.html) is read on the next open without Rebuild or a restart. Bytes are the main process's rchar, so Linux only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, root } from './helpers.mjs';

const skip = process.platform !== 'linux' ? 'reads /proc/<pid>/io' : false;
const rchar = async (pid) => Number(/rchar: (\d+)/.exec(await readFile(`/proc/${pid}/io`, 'utf8'))[1]);

test('Dev Focus build: kept between opens, read again after a new build', { skip, timeout: 180000 }, async (t) => {
  const index = path.join(root, 'apps/dev/dist/index.html');
  const original = await stat(index);
  t.after(() => utimes(index, original.atime, original.mtime));
  const instance = await daemon(t);
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-devfresh-')), 'profile');
  // No editor server: each show after a failed start opens Dev Focus again, which reads the build.
  const env = { ...process.env, P9_EDITOR_HOST: path.join(profile, 'no-editor-server') }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 30000 });
  const proc = app.process(), pid = proc.pid;
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow({ timeout: 30000 });
  await page.waitForURL(/^p9:\/\/app\//, { timeout: 30000 });
  await page.locator('#rChat').waitFor({ timeout: 30000 });
  await app.evaluate(({ app }) => { globalThis.p9Loads = 0; app.on('web-contents-created', (_event, contents) => contents.on('did-finish-load', () => { globalThis.p9Loads++; })); });
  const open = async () => {
    const loads = await app.evaluate(() => globalThis.p9Loads);
    await page.evaluate(() => window.p9.devView({ visible: false }));
    const before = await rchar(pid);
    await page.evaluate(() => window.p9.devView({ visible: true, x: 0, y: 44, width: 900, height: 700 }));
    for (let w = 0; w < 600 && (await app.evaluate(() => globalThis.p9Loads)) === loads; w++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.notEqual(await app.evaluate(() => globalThis.p9Loads), loads, 'Dev Focus opened');
    return (await rchar(pid)) - before;
  };
  const build = await open();
  const kept = await open();
  const later = new Date(original.mtimeMs + 60000);
  await utimes(index, later, later);
  const rebuilt = await open();
  console.log('P9_DEV_FRESH ' + JSON.stringify({ firstMb: +(build / 1048576).toFixed(1), keptMb: +(kept / 1048576).toFixed(1), newBuildMb: +(rebuilt / 1048576).toFixed(1) }));
  assert.ok(build > 10 * 1048576, 'first open reads the build');
  assert.ok(kept < 5 * 1048576, 'a reopen with the same build does not read it again');
  assert.ok(rebuilt > 10 * 1048576, 'a reopen after a new build reads the new build');
});
