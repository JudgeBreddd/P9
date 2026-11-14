// Pets load time (phase 4, window-4; open items O14 and O16). Measures only: it asserts that each step ran, never a number,
// so the same file runs unchanged before and after a change. Two lines: "P9_PETS_LAND <json>" (12 pets on the landing page
// at startup) and "P9_PETS_SETTINGS <json>" (Settings opened 3 times while connected to a remote over a tunnel with 25 ms
// each way, its 12 pet thumbnails drawn). Pets are copies of the bundled Skipper (a real 3.4 MB sheet).
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, cp, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, root, versionSeen } from './helpers.mjs';

const skip = process.platform === 'win32' ? 'Unix sockets and sh' : false;
const median = (list) => { const s = [...list].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const PETS = 12;
const withPets = async (profile) => {
  for (let i = 0; i < PETS; i++) {
    const folder = path.join(profile, 'pets', 'pet-' + String(i).padStart(2, '0'));
    await cp(path.join(root, 'apps/desktop/pets/skipper'), folder, { recursive: true });
    await writeFile(path.join(folder, 'pet.json'), JSON.stringify({ id: path.basename(folder), displayName: 'Pet ' + i, spritesheetPath: 'spritesheet.png' }));
  }
  await versionSeen(profile);
};
const launch = async (t, state, profile, env) => {
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 30000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  return { app, page: await app.firstWindow({ timeout: 30000 }) };
};
// Every canvas the selector finds has a drawn pixel at the sprite's middle.
const drawn = ([selector, count]) => [...document.querySelectorAll(selector)].filter((cv) => cv.getContext("2d").getImageData(96, 104, 1, 1).data[3] > 0).length >= count;

test('Pets load: 12 pets on the landing page at startup', { skip, timeout: 180000 }, async (t) => {
  const instance = await daemon(t);
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-petsland-')), 'profile');
  await withPets(profile);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.P9_LANDING;
  const t0 = Date.now();
  const { page } = await launch(t, instance.state, profile, env);
  await page.waitForFunction(() => document.querySelector('#land')?.open, null, { timeout: 30000 });
  const openMs = Date.now() - t0, openPage = await page.evaluate(() => performance.now());
  await page.waitForFunction(drawn, ['#landPets canvas.pet', PETS], { timeout: 60000, polling: 20 });
  const petsMs = Date.now() - t0, petsPage = await page.evaluate(() => performance.now());
  assert.equal(await page.locator('#landPets canvas.pet').count(), PETS);
  const result = { fromLaunchMs: petsMs, afterOpenMs: Math.round(petsPage - openPage), landOpenMs: openMs };
  console.log('P9_PETS_LAND ' + JSON.stringify(result));
});

test('Pets load: Settings while connected to a remote, 12 pet thumbnails', { skip, timeout: 240000 }, async (t) => {
  const local = await daemon(t), remote = await daemon(t);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'p9-petsremote-'));
  const server = path.join(directory, 'server'), runtime = path.join(directory, 'local'), log = path.join(directory, 'ssh.log');
  await mkdir(server); await mkdir(runtime, { mode: 0o700 });
  await symlink(remote.state, path.join(server, 'p9-foundation'));
  const ssh = path.join(directory, 'ssh'), q = (s) => "'" + s + "'";
  await writeFile(ssh, '#!/bin/sh\nFAKE_SSH_DELAY_MS=25 FAKE_RUNTIME=' + q(server) + ' FAKE_SSH_LOG=' + q(log) + ' exec ' + q(process.execPath) + ' ' + q(path.join(root, 'test/fake-ssh.mjs')) + ' "$@"\n');
  await chmod(ssh, 0o755);
  const profile = path.join(directory, 'profile'); await mkdir(profile);
  await withPets(profile);
  await writeFile(path.join(profile, 'p9-server.json'), JSON.stringify({ host: 'test-host' }));
  const env = { ...process.env, P9_SSH: ssh, XDG_RUNTIME_DIR: runtime, P9_LANDING: 'off' }; delete env.ELECTRON_RUN_AS_NODE;
  const { page } = await launch(t, local.state, profile, env);
  await page.locator('#serverBadge', { hasText: 'test-host' }).waitFor({ timeout: 30000 });
  await page.locator('#rChat').waitFor({ timeout: 30000 });
  const openMs = [], thumbsMs = [];
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    await page.click('#setBtn');
    await page.locator('#setDlg[open]').waitFor({ timeout: 60000 });
    openMs.push(Date.now() - t0);
    await page.waitForFunction(drawn, ['#setDlg canvas[data-thumb]', PETS], { timeout: 60000, polling: 20 });
    thumbsMs.push(Date.now() - t0);
    await page.evaluate(() => document.querySelector('#setDlg').close());
    await page.waitForFunction(() => !document.querySelector('#setDlg').open);
  }
  const result = { firstOpenMs: openMs[0], firstThumbsMs: thumbsMs[0], againOpenMs: median(openMs.slice(1)), againThumbsMs: median(thumbsMs.slice(1)), allOpen: openMs, allThumbs: thumbsMs, delayMs: 25 };
  console.log('P9_PETS_SETTINGS ' + JSON.stringify(result));
});
