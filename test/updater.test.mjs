// Auto-update (threat model row 39): when apps/desktop/updater.mjs is off, which page calls it takes, and its states,
// with a stand-in for electron-updater. The real download and install run in windows-installer.yaml.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { offReason, updateAction, startUpdater } from '../apps/desktop/updater.mjs';
import { mergeLatest } from '../scripts/merge-latest.mjs';

const feed = async () => {
  const resources = await mkdtemp(path.join(os.tmpdir(), 'p9-updater-'));
  await writeFile(path.join(resources, 'app-update.yml'), 'provider: github\n');
  return resources;
};

test('updates are off for a source checkout, a build with no feed, another system, and Linux outside the AppImage', async () => {
  const resources = await feed(), bare = await mkdtemp(path.join(os.tmpdir(), 'p9-updater-'));
  const on = { packaged: true, resources, platform: 'win32', env: {} };
  assert.equal(offReason(on), null);
  assert.equal(offReason({ ...on, platform: 'linux', env: { APPIMAGE: '/x/P9.AppImage' } }), null);
  assert.equal(offReason({ ...on, packaged: false }), 'source checkout');
  assert.equal(offReason({ ...on, resources: bare }), 'this build has no update feed');
  assert.equal(offReason({ ...on, platform: 'darwin' }), 'not built for this system');
  assert.equal(offReason({ ...on, platform: 'linux' }), 'not the AppImage');
  // Off means electron-updater is never loaded.
  let loaded = false;
  const off = await startUpdater({ app: { isPackaged: false }, version: '1.0.0', log() {}, resources, platform: 'win32', env: {}, load: () => { loaded = true; } });
  assert.deepEqual(off.check(), { state: 'off', current: '1.0.0', available: null, reason: 'source checkout' });
  assert.equal(loaded, false);
});

test('the page may only read, check or install', () => {
  assert.equal(updateAction([]), 'read');
  assert.equal(updateAction([{ check: true }]), 'check');
  assert.equal(updateAction([{ install: true }]), 'install');
  for (const args of [[undefined], [null], ['check'], [[]], [{}], [{ check: 'true' }], [{ check: true, install: true }],
    [{ install: true, url: 'https://evil.example/' }], [{ check: true }, {}]]) assert.equal(updateAction(args), null, JSON.stringify(args));
});

test('states follow electron-updater; install runs only once a download is ready; a check never interrupts a download', async () => {
  const fake = new EventEmitter(), calls = [];
  fake.checkForUpdates = async () => { calls.push('check'); };
  fake.quitAndInstall = (...args) => calls.push('install ' + args.join());
  const lines = [];
  const updates = await startUpdater({ app: { isPackaged: true }, version: '1.0.0', log: line => lines.push(line),
    resources: await feed(), platform: 'win32', env: {}, load: async () => fake });
  assert.deepEqual([fake.autoDownload, fake.autoInstallOnAppQuit, fake.allowPrerelease, fake.allowDowngrade], [true, true, false, false]);
  assert.equal(updates.read().state, 'idle');
  updates.install();
  await new Promise(setImmediate);
  assert.deepEqual(calls, [], 'install before a download is ready');
  assert.equal(updates.check().state, 'checking');
  fake.emit('update-available', { version: '1.0.1' });
  assert.deepEqual(updates.read(), { state: 'downloading', current: '1.0.0', available: '1.0.1', reason: null });
  updates.check();
  fake.emit('update-downloaded', { version: '1.0.1' });
  updates.check();
  assert.deepEqual(calls, ['check'], 'a check while downloading or ready');
  assert.equal(updates.install().state, 'ready');
  await new Promise(setImmediate);
  assert.deepEqual(calls, ['check', 'install true,true']);
  fake.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED\n<html>...'));
  assert.deepEqual(updates.read(), { state: 'error', current: '1.0.0', available: '1.0.1', reason: 'net::ERR_INTERNET_DISCONNECTED' });
  assert.ok(lines.includes('state ready 1.0.1'));
});

// AU3: CI merges the two Windows runners' latest.yml into the release's one. Written and read back with the js-yaml
// electron-builder writes it with and electron-updater reads it with.
test('the merged latest.yml lists both Windows installers and keeps the first one\'s top level', () => {
  const yaml = createRequire(createRequire(import.meta.url).resolve('electron-updater'))('js-yaml');
  const latest = (arch) => yaml.dump({ version: '0.1.6', files: [{ url: `p9-event-horizon-0.1.6-windows-${arch}.exe`, sha512: arch + '-hash', size: 7 }],
    path: `p9-event-horizon-0.1.6-windows-${arch}.exe`, sha512: arch + '-hash', releaseDate: '2026-10-24T00:00:00.000Z' }, { lineWidth: 8000, noRefs: true });
  const merged = yaml.load(mergeLatest([latest('x64'), latest('arm64')]));
  assert.deepEqual(merged.files.map((file) => file.url), ['p9-event-horizon-0.1.6-windows-x64.exe', 'p9-event-horizon-0.1.6-windows-arm64.exe']);
  assert.deepEqual(merged.files.map((file) => file.sha512), ['x64-hash', 'arm64-hash']);
  assert.equal(merged.path, 'p9-event-horizon-0.1.6-windows-x64.exe');
  assert.equal(merged.version, '0.1.6');
  assert.throws(() => mergeLatest([latest('x64'), latest('arm64').replace('0.1.6', '0.1.5')]), /latest-yml-versions-differ/);
  assert.throws(() => mergeLatest([latest('x64'), 'version: 0.1.6\n']), /latest-yml-unreadable/);
});
