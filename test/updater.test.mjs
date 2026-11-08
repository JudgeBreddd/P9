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
import { candidateVersion } from '../scripts/candidate-version.mjs';

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
  assert.deepEqual(off.check(), { state: 'off', current: '1.0.0', available: null, reason: 'source checkout', nightly: false });
  assert.equal(loaded, false);
});

test('the page may only read, check or install', () => {
  assert.equal(updateAction([]), 'read');
  assert.equal(updateAction([{ check: true }]), 'check');
  assert.equal(updateAction([{ install: true }]), 'install');
  assert.equal(updateAction([{ nightly: true }]), 'nightly');
  assert.equal(updateAction([{ nightly: false }]), 'nightly');
  for (const args of [[undefined], [null], ['check'], [[]], [{}], [{ check: 'true' }], [{ check: true, install: true }],
    [{ install: true, url: 'https://evil.example/' }], [{ check: true }, {}], [{ nightly: 'true' }], [{ nightly: 1 }], [{ nightly: true, check: true }]]) assert.equal(updateAction(args), null, JSON.stringify(args));
});

test('states follow electron-updater; install runs only once a download is ready; a check never interrupts a download', async () => {
  const fake = new EventEmitter(), calls = [];
  fake.checkForUpdates = async () => { calls.push('check'); };
  fake.quitAndInstall = (...args) => calls.push('install ' + args.join());
  fake.downloadUpdate = async () => { calls.push('download'); };
  const lines = [];
  const updates = await startUpdater({ app: { isPackaged: true }, version: '1.0.0', log: line => lines.push(line),
    resources: await feed(), platform: 'win32', env: {}, load: async () => fake });
  assert.deepEqual([fake.autoDownload, fake.autoInstallOnAppQuit, fake.allowPrerelease, fake.allowDowngrade], [false, false, false, false]);
  assert.equal(updates.read().state, 'idle');
  updates.install();
  await new Promise(setImmediate);
  assert.deepEqual(calls, [], 'install before a download is ready');
  assert.equal(updates.check().state, 'checking');
  fake.emit('update-available', { version: '1.0.1' });
  assert.deepEqual(updates.read(), { state: 'downloading', current: '1.0.0', available: '1.0.1', reason: null, nightly: false });
  updates.check();
  fake.emit('update-downloaded', { version: '1.0.1' });
  updates.check();
  assert.deepEqual(calls, ['check', 'download'], 'a check while downloading or ready');
  assert.equal(updates.install().state, 'ready');
  await new Promise(setImmediate);
  assert.deepEqual(calls, ['check', 'download', 'install true,true']);
  fake.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED\n<html>...'));
  assert.deepEqual(updates.read(), { state: 'error', current: '1.0.0', available: '1.0.1', reason: 'net::ERR_INTERNET_DISCONNECTED', nightly: false });
  assert.ok(lines.includes('state ready 1.0.1'));
});

// O2 (0.1.8): the Nightly switch is read at start, kept through channel.set, and turns electron-updater's pre-releases
// on and off with a new check; a download under way is kept. Downgrades stay off either way.
test('the Nightly switch: read at start, kept, and it turns pre-releases on and off without a downgrade', async () => {
  const fake = new EventEmitter(), calls = [];
  fake.checkForUpdates = async () => { calls.push('check ' + fake.allowPrerelease); };
  fake.downloadUpdate = async () => { calls.push('download'); };
  let saved = true, waiting = null;
  const channel = { get: () => saved, set: on => { saved = on; } }, pending = { get: () => waiting, set: v => { waiting = v; } };
  const updates = await startUpdater({ app: { isPackaged: true }, version: '1.0.0', log() {}, resources: await feed(), platform: 'win32',
    env: {}, load: async () => fake, channel, pending });
  assert.deepEqual([fake.allowPrerelease, fake.allowDowngrade, updates.read().nightly], [true, false, true]);
  assert.equal(updates.nightly({ nightly: false }).state, 'checking');
  assert.deepEqual([fake.allowPrerelease, saved, updates.read().nightly, calls], [false, false, false, ['check false']]);
  updates.nightly({ nightly: true });
  fake.emit('update-available', { version: '1.0.1-nightly.1' });
  fake.emit('update-downloaded', { version: '1.0.1-nightly.1' });
  assert.deepEqual([updates.read().state, waiting], ['ready', '1.0.1-nightly.1']);
  // Review finding 1: off drops the nightly that is ready, so the next open installs nothing (O24: nor does quitting); one
  // still arriving is dropped too.
  updates.nightly({ nightly: false });
  assert.deepEqual([updates.read().state, updates.read().available, waiting, fake.allowDowngrade], ['checking', null, null, false]);
  fake.emit('update-available', { version: '1.0.1-nightly.2' });
  fake.emit('update-downloaded', { version: '1.0.1-nightly.2' });
  assert.deepEqual([updates.read().state, waiting, calls], ['idle', null, ['check false', 'check true', 'download', 'check false']]);
  // A stable release still downloads and waits for the next open with the switch off.
  fake.emit('update-available', { version: '1.0.2' });
  fake.emit('update-downloaded', { version: '1.0.2' });
  assert.deepEqual([updates.read().state, updates.read().available, waiting, fake.autoInstallOnAppQuit], ['ready', '1.0.2', '1.0.2', false]);
  // Off (a source checkout): the switch is still kept for when updates are on, and nothing loads.
  let loaded = false;
  const off = await startUpdater({ app: { isPackaged: false }, version: '1.0.0', log() {}, resources: await feed(), platform: 'win32', env: {},
    load: () => { loaded = true; }, channel });
  assert.deepEqual([off.nightly({ nightly: true }).nightly, saved, loaded], [true, true, false]);
});

// AU5: the version a rollback came back from is never downloaded again; the next different release is, and clears it.
test('a skipped version is not downloaded; a newer one is, and clears the skip', async () => {
  const fake = new EventEmitter(), calls = [];
  fake.checkForUpdates = async () => {};
  fake.downloadUpdate = async () => { calls.push('download'); };
  let skipped = '1.0.1';
  const updates = await startUpdater({ app: { isPackaged: true }, version: '1.0.0', log() {}, resources: await feed(), platform: 'win32',
    env: {}, load: async () => fake, skip: { get: () => skipped, clear: () => { skipped = null; } } });
  updates.check();
  fake.emit('update-available', { version: '1.0.1' });
  assert.deepEqual([updates.read().state, updates.read().available, calls, skipped], ['idle', null, [], '1.0.1']);
  updates.check();
  fake.emit('update-available', { version: '1.0.2' });
  assert.deepEqual([updates.read().state, updates.read().available, calls, skipped], ['downloading', '1.0.2', ['download'], null]);
});

// With no normal release GitHub answers its 404 page, and electron-updater logs the whole page after "Data:"; the log
// keeps only the first line.
test('an electron-updater error with GitHub\'s 404 page logs one line, without the page', async () => {
  const fake = new EventEmitter(), lines = [];
  fake.checkForUpdates = async () => {};
  await startUpdater({ app: { isPackaged: true }, version: '1.0.0', log: (l) => lines.push(l), resources: await feed(), platform: 'linux',
    env: { APPIMAGE: '/x/P9.AppImage' }, load: async () => fake });
  const page = '<!DOCTYPE html>\n<html lang="en">\n' + '<div>x</div>\n'.repeat(2000) + '</html>';
  fake.logger.error('Error: Error: Unable to find latest version on GitHub (https://github.com/o/r/releases/latest), please ensure a production release exists: HttpError: 404 \n"method: GET url: https://github.com/o/r/releases/latest\n\nData:\n ' + page);
  const logged = lines.at(-1);
  assert.match(logged, /^Error: Error: Unable to find latest version on GitHub \(https:\/\/github\.com\/o\/r\/releases\/latest\).*HttpError: 404 +\(\d+ more characters not logged\)$/);
  assert.equal(logged.includes('<'), false, 'no HTML in the log: ' + logged.slice(0, 300));
  fake.logger.info('Checking for update');
  assert.equal(lines.at(-1), 'Checking for update');
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

test('a candidate build takes only <package.json version>-rc.<n>', () => {
  for (const wanted of ['0.1.5-rc.1', '0.1.5-rc.12']) assert.equal(candidateVersion('0.1.5', wanted), wanted);
  for (const wanted of ['', '0.1.5', '0.1.6-rc.1', '0.1.5-rc.0', '0.1.5-rc.01', '0.1.5-rc.1a', '0.1.5-beta.1', '0.1.5-rc.1 ', 'v0.1.5-rc.1', '0.1.5-rc.1\nx']) {
    assert.throws(() => candidateVersion('0.1.5', wanted), /not-a-candidate/, JSON.stringify(wanted));
  }
  assert.throws(() => candidateVersion('0.1.5-rc.1', '0.1.5-rc.1-rc.1'), /not-a-candidate/);
});

// O24 (0.1.9): once an update is downloaded P9 asks, with the release's own list of changes. Update now closes P9, installs
// and reopens it (quitAndInstall silent and force-run: the assisted installer starts P9 again only then); Later installs it
// the next time P9 opens, never when it quits (0.1.8's install-on-quit ran behind a reopened window and never reopened P9).
test('O24: the update-ready popup lists the release\'s changes; Update now installs and reopens, Later waits for the next open', async () => {
  const settle = () => new Promise(done => setTimeout(done, 20));
  const make = () => {
    const fake = new EventEmitter(), calls = [];
    fake.checkForUpdates = async () => { calls.push('check'); };
    fake.downloadUpdate = async () => { calls.push('download'); };
    fake.quitAndInstall = (...args) => calls.push('install ' + args.join());
    return { fake, calls };
  };
  let waiting = null;
  const pending = { get: () => waiting, set: v => { waiting = v; } }, resources = await feed();
  const start = (fake, version, more) => startUpdater({ app: { isPackaged: true }, version, log() {}, resources, platform: 'win32', env: {},
    load: async () => fake, pending, ...more });
  // The release body as GitHub's feed gives it: the list before "## Install", tags and entities gone.
  const html = '<p>What changed (#19):</p>\n<ul>\n<li><strong>Restart</strong> &amp; reopen after an update.</li>\n'
    + '<li>Doctor shows <code>bash</code> output.</li>\n</ul>\n<h2>Install</h2>\n<ul><li>Download the .exe</li></ul>';
  const notes = ['Restart & reopen after an update.', 'Doctor shows bash output.'];

  // Update now.
  let { fake, calls } = make(), asked = [];
  let updates = await start(fake, '1.0.0', { ready: async q => { asked.push(q); return 'now'; } });
  updates.check();
  fake.emit('update-available', { version: '1.0.1' });
  fake.emit('update-downloaded', { version: '1.0.1', releaseNotes: html });
  await settle();
  assert.deepEqual(asked, [{ version: '1.0.1', notes }]);
  assert.deepEqual([calls, fake.autoInstallOnAppQuit], [['check', 'download', 'install true,true'], false]);

  // Later: nothing installs, not even on quit; the version waits for the next open. Notes as an array of { note } with
  // Markdown, and none at all, still give a popup.
  waiting = null;
  ({ fake, calls } = make()); asked = [];
  updates = await start(fake, '1.0.0', { ready: async q => { asked.push(q); return 'later'; } });
  updates.check();
  fake.emit('update-available', { version: '1.0.1' });
  fake.emit('update-downloaded', { version: '1.0.1', releaseNotes: [{ version: '1.0.1', note: 'What changed:\n- **One** fix\n- `Two`\n\n## Install\n- x' }] });
  await settle();
  assert.deepEqual(asked, [{ version: '1.0.1', notes: ['One fix', 'Two'] }]);
  assert.deepEqual([calls, fake.autoInstallOnAppQuit, waiting, updates.read().state], [['check', 'download'], false, '1.0.1', 'ready']);

  // The next open: it looks at once (not after the usual 10 s), says it is installing, never asks again, and installs.
  ({ fake, calls } = make()); asked = [];
  const told = [];
  updates = await start(fake, '1.0.0', { ready: async q => { asked.push(q); return 'later'; }, installing: async v => { told.push(v); } });
  await settle();
  assert.deepEqual(calls, ['check'], 'the open after Later checks at once');
  fake.emit('update-available', { version: '1.0.1' });
  fake.emit('update-downloaded', { version: '1.0.1', releaseNotes: null });
  await settle();
  assert.deepEqual([told, asked, calls], [['1.0.1'], [], ['check', 'download', 'install true,true']]);

  // Opened on that version (or a newer one): the wait is over and nothing is checked early.
  ({ fake, calls } = make());
  updates = await start(fake, '1.0.1', {});
  await settle();
  assert.deepEqual([waiting, calls], [null, []]);
});
