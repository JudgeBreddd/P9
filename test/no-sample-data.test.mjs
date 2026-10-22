// GitHub issue #4: a fresh Windows install showed the sample data (personal-looking _tyler/ items, chats, files), and so did
// every launch with the daemon down. the owner, 2026-10-20: "sample data should not be in the app at all ... we can keep the sample
// data for our own tests. not the shipped app". The data lives in test/sample-data.mjs; these checks keep it there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { once } from 'node:events';
import { daemon, restart, root } from './helpers.mjs';

// Text only the sample data has: chat titles, a sample file, the personal-looking project rows.
const MARKERS = ['Refactor provider lease', 'Pick a colour', 'LEASE_GRACE_MS', 'DD-214', 'va-claims-assistant', 'agent-first-workspace'];
const files = async dir => (await readdir(dir, { recursive: true, withFileTypes: true })).filter(e => e.isFile()).map(e => path.join(e.parentPath, e.name));

test('the built app carries no sample data', async () => {
  const shipped = [...await files(path.join(root, 'apps/web/dist')), ...await files(path.join(root, 'apps/dev/dist'))];
  assert.ok(shipped.length > 0, 'build apps/web and apps/dev first');
  const found = [];
  for (const file of shipped) { const text = await readFile(file, 'latin1'); for (const m of MARKERS) if (text.includes(m)) found.push(path.relative(root, file) + ': ' + m); }
  assert.deepEqual(found, []);
  const sources = (await files(path.join(root, 'apps'))).filter(f => !f.includes(path.sep + 'node_modules' + path.sep) && !f.includes(path.sep + 'dist' + path.sep) && /\.(mjs|cjs|js|ts|tsx|astro|html)$/.test(f));
  const importers = [];
  for (const file of sources) if ((await readFile(file, 'utf8')).includes('sample-data.mjs')) importers.push(path.relative(root, file));
  assert.deepEqual(importers, ['apps/desktop/main.mjs'.split('/').join(path.sep)], 'only the desktop\'s unpackaged test path loads it');
  console.log('PASS ' + shipped.length + ' built files hold none of ' + MARKERS.length + ' sample markers; only main.mjs names the sample file');
});

async function open(t, state) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'p9-nosample-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.P9_SAMPLE_DATA;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise(resolve => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#rMission').waitFor(); await page.click('#rMission');
  return page;
}
const noSamples = async page => {
  assert.equal(await page.evaluate(() => window.p9.sample), null);
  assert.equal(await page.locator('#tabs .tab').count(), 0, 'no sample chat tabs');
  const text = await page.locator('body').innerText();
  for (const m of MARKERS) assert.ok(!text.includes(m), 'page shows sample text: ' + m);
  assert.equal(await page.locator('#fMission .needs [data-n]').innerText(), '0');
};

test('a daemon with no settings file shows empty lists and says Mission Control is not set up', { timeout: 60000 }, async t => {
  const instance = await daemon(t); // the test home has no settings.json: the fresh Windows install of issue #4
  const page = await open(t, instance.state);
  await page.locator('[data-mission-note]', { hasText: /not set up yet \(settings-missing\)/ }).waitFor({ timeout: 15000 });
  await noSamples(page);
  console.log('PASS settings-missing: no sample tabs, text or waiting items; the note says not set up');
});

test('no daemon at all shows empty lists and says the background service is not answering', { timeout: 60000 }, async t => {
  const page = await open(t, await mkdtemp(path.join(os.tmpdir(), 'p9-nodaemon-')));
  await page.locator('[data-mission-note]', { hasText: /not answering/ }).waitFor({ timeout: 15000 });
  await noSamples(page);
  console.log('PASS no daemon: no sample tabs, text or waiting items; the note says not answering and retries');
});

// GitHub issue #6 B3: the status bar asked once at launch, so a daemon that came up later still read unavailable.
test('the status bar asks again until a daemon that starts after the app answers', { timeout: 60000 }, async t => {
  const instance = await daemon(t);
  instance.child.kill('SIGTERM'); await once(instance.child, 'exit');
  const page = await open(t, instance.state);
  await page.locator('#daemonStatus', { hasText: 'Daemon unavailable' }).waitFor({ timeout: 15000 });
  await restart(t, instance, 'state');
  await page.locator('#daemonStatus', { hasText: 'Daemon connected' }).waitFor({ timeout: 15000 });
  console.log('PASS B3: unavailable at launch, connected once the daemon came up, with no relaunch');
});
