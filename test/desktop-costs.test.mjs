// Desktop costs (phase 4, window-3; review list 22 to 28). Measures only: it asserts that each step ran, never a number, so
// the same file runs unchanged before and after a change. Two lines: "P9_COSTS_APP <json>" (the app: Dev Focus opens, pets
// list, quit handlers, editor still) and "P9_COSTS_NODE <json>" (server-update follow, daemon requests, ssh options, slim tar).
// Bytes are the Electron main process's rchar (/proc/<pid>/io: bytes it read, files and sockets), so Linux only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, root } from './helpers.mjs';
import { updateServer } from '../apps/desktop/server-update.mjs';
import { daemonRequest } from '../scripts/teh.mjs';
import { sshOptions } from '../apps/desktop/remote.mjs';
import { slimArchive } from '../apps/desktop/remote-install.mjs';
import { scan } from '../scripts/scan.mjs';
import { mutationInventory } from '../scripts/gate.mjs';

const skip = process.platform !== 'linux' ? 'reads /proc/<pid>/io' : false;
const median = (list) => { const s = [...list].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const rchar = async (pid) => Number(/rchar: (\d+)/.exec(await readFile(`/proc/${pid}/io`, 'utf8'))[1]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('Desktop costs, app: Dev Focus opens with no editor server, the pets list, quit handlers, the editor still', { skip, timeout: 300000 }, async (t) => {
  const instance = await daemon(t);
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-costs-')), 'profile');
  // 10 pets with a sheet just under the 8 MB limit.
  for (let i = 0; i < 10; i++) {
    const folder = path.join(profile, 'pets', 'pet-' + i);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'pet.json'), JSON.stringify({ id: 'pet-' + i, displayName: 'Pet ' + i, spritesheetPath: 'spritesheet.png' }));
    await writeFile(path.join(folder, 'spritesheet.png'), Buffer.concat([PNG, Buffer.alloc((8 << 20) - 1024)]));
  }
  // An editor server that is not there: every Dev Focus open fails to start it, which is the path items 22 and 24 name.
  const env = { ...process.env, P9_EDITOR_HOST: path.join(profile, 'no-editor-server') }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 30000 });
  const proc = app.process(), pid = proc.pid;
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow({ timeout: 30000 });
  await page.waitForURL(/^p9:\/\/app\//, { timeout: 30000 });
  await page.locator('#rChat').waitFor({ timeout: 30000 });

  // Item 23: the pets list (two strings per pet), 5 times.
  const petsMs = [], petsBytes = [];
  for (let i = 0; i < 5; i++) {
    const before = await rchar(pid), t0 = performance.now();
    const count = await page.evaluate(() => window.p9.listPets().then((r) => r.pets.length));
    petsMs.push(Math.round(performance.now() - t0)); petsBytes.push((await rchar(pid)) - before);
    assert.equal(count, 10);
  }

  // Items 22 and 24: Dev Focus shown, hidden and shown again; each show after a failed start opens it again.
  await app.evaluate(({ app }) => { globalThis.p9CostLoads = 0; app.on('web-contents-created', (_event, contents) => contents.on('did-finish-load', () => { globalThis.p9CostLoads++; })); });
  const quitBefore = await app.evaluate(({ app }) => app.listenerCount('will-quit'));
  const bounds = { visible: true, x: 0, y: 44, width: 900, height: 700 }, devMs = [], devBytes = [];
  for (let i = 0; i < 6; i++) {
    const loads = await app.evaluate(() => globalThis.p9CostLoads);
    await page.evaluate(() => window.p9.devView({ visible: false }));
    const before = await rchar(pid), t0 = performance.now();
    await page.evaluate((b) => window.p9.devView(b), bounds);
    for (let w = 0; w < 600 && (await app.evaluate(() => globalThis.p9CostLoads)) === loads; w++) await new Promise((resolve) => setTimeout(resolve, 50));
    devMs.push(Math.round(performance.now() - t0)); devBytes.push((await rchar(pid)) - before);
  }
  const quitAfter = await app.evaluate(({ app }) => app.listenerCount('will-quit'));

  // Item 26: the still of the editor view the shell asks for when a menu opens over it, 5 times.
  const stillMs = [], stillChars = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    stillChars.push(await page.evaluate(() => window.p9.devStill().then((s) => s?.length ?? -1)));
    stillMs.push(Math.round(performance.now() - t0));
  }
  const result = {
    pets: { ms: median(petsMs), mb: +(median(petsBytes) / 1048576).toFixed(1), all: petsMs },
    dev: { firstMs: devMs[0], firstMb: +(devBytes[0] / 1048576).toFixed(1), reopenMs: median(devMs.slice(1)), reopenMb: +(median(devBytes.slice(1)) / 1048576).toFixed(1), all: devMs, allMb: devBytes.map((b) => +(b / 1048576).toFixed(1)) },
    quit: { added: quitAfter - quitBefore, opens: devMs.length },
    still: { ms: median(stillMs), kb: Math.round(median(stillChars) / 1024), all: stillChars },
  };
  console.log('P9_COSTS_APP ' + JSON.stringify(result));
  assert.equal(devMs.length, 6);
  assert.ok(median(stillChars) > 0, 'a still came back');
});

test('Desktop costs, node: update follow, daemon requests, ssh options, slim tar, gate walks', { skip, timeout: 300000 }, async (t) => {
  // A fake daemon on a Unix socket, as self-update.test.mjs's: every answer is counted.
  const state = await mkdtemp(path.join(os.tmpdir(), 'p9-costs-d-')), socketPath = path.join(state, 'daemon.sock'), served = {};
  await writeFile(path.join(state, 'desktop.json'), JSON.stringify({ cookie: 'c', csrf: 'x', socketPath }));
  const fake = createServer((req, res) => {
    served[req.url] = (served[req.url] ?? 0) + 1;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/update/status' ? { supported: true, job: { id: 'job-1', phase: 'building' } } : { ok: true }));
  });
  await new Promise((resolve) => fake.listen(socketPath, resolve));
  t.after(() => fake.close());

  // Item 27: 1000 daemon requests one after another (each reads desktop.json), 3 times.
  const requestMs = [];
  for (let r = 0; r < 3; r++) {
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) await daemonRequest(state, 'GET', '/ping');
    requestMs.push(Math.round(performance.now() - t0));
  }
  const sshMs = [];
  for (let r = 0; r < 3; r++) { const t0 = performance.now(); for (let i = 0; i < 10000; i++) sshOptions(); sshMs.push(Math.round(performance.now() - t0)); }

  // Item 25: following a server update that stays in 'building', 10 simulated minutes (mocked clock), checks and status asks counted.
  served['/update/status'] = 0;
  let checks = 0;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const followed = updateServer({ state, check: async () => { checks++; return { version: '0.1.5' }; }, version: '9.0.0', checkout: null, host: 'test', deadline: 10 * 60_000 });
  let ended = null;
  followed.then((value) => { ended = value; });
  const spin = async () => { for (let i = 0; i < 200; i++) await new Promise((resolve) => setImmediate(resolve)); };
  const settle = async () => { for (let i = 0; i < 2000 && served['/update/status'] < checks; i++) await new Promise((resolve) => setImmediate(resolve)); await spin(); };
  await settle();
  for (let s = 0; s < 10 * 60 + 60 && !ended; s++) { t.mock.timers.tick(1000); await settle(); }
  t.mock.timers.reset();
  assert.equal(ended?.phase, 'timed-out', JSON.stringify(ended));

  // Item 28: slimArchive's tar call, with a stand-in tar on PATH that records its arguments and what it got on stdin.
  const bundle = await mkdtemp(path.join(os.tmpdir(), 'p9-costs-slim-')), tool = await mkdtemp(path.join(os.tmpdir(), 'p9-costs-tar-'));
  await writeFile(path.join(bundle, 'agents.json'), '{}');
  await writeFile(path.join(bundle, 'package.json'), '{}');
  for (let d = 0; d < 30; d++) {
    await mkdir(path.join(bundle, 'apps/server/some-package-folder-' + d), { recursive: true });
    for (let f = 0; f < 100; f++) await writeFile(path.join(bundle, 'apps/server/some-package-folder-' + d, 'module-file-' + f + '.js'), '');
  }
  const record = path.join(tool, 'record');
  await writeFile(path.join(tool, 'tar'), '#!/bin/sh\nn=0; b=0; for a in "$@"; do n=$((n+1)); b=$((b+${#a}+1)); done\ns=$(cat | wc -c)\necho "$n $b $s" > ' + JSON.stringify(record) + '\n');
  await chmod(path.join(tool, 'tar'), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = tool + ':' + oldPath;
  try { await new Promise((resolve, reject) => { const out = slimArchive(bundle); out.on('error', reject); out.resume(); out.on('end', resolve); out.on('close', resolve); }); }
  finally { process.env.PATH = oldPath; }
  const [argc, argvBytes, stdinBytes] = (await readFile(record, 'utf8')).trim().split(' ').map(Number);

  // Item 28: the gate's two source-tree passes (secret scan, then mutation inventory), as gate.mjs runs them, 3 times.
  const gateMs = [];
  for (let r = 0; r < 3; r++) { const t0 = performance.now(); await scan(root); await mutationInventory(root); gateMs.push(Math.round(performance.now() - t0)); }

  const result = {
    follow: { checks, status: served['/update/status'], simulatedMin: 10 },
    requests: { ms1000: median(requestMs), all: requestMs },
    ssh: { ms10000: median(sshMs), all: sshMs },
    slimTar: { argc, argvKb: Math.round(argvBytes / 1024), stdinKb: Math.round(stdinBytes / 1024), files: 3002 },
    gate: { ms: median(gateMs), all: gateMs },
  };
  console.log('P9_COSTS_NODE ' + JSON.stringify(result));
  assert.ok(checks > 0 && argc > 0);
});
