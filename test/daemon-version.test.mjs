// O135: an update left the service on an older daemon (a drop-in named a source copy) and the window still said
// Daemon connected. Now the status bar names the daemon's version and where it runs from. A stand-in daemon on the
// socket answers /health only, so its version can differ from this checkout's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { root } from './helpers.mjs';

const own = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;

async function standIn(t, answer) {
  const state = await mkdtemp(path.join(os.tmpdir(), 'p9-o135-'));
  await writeFile(path.join(state, 'desktop.json'), JSON.stringify({ cookie: 'o135' }));
  const server = createServer((req, res) => {
    if (req.url !== '/health') { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok', phase: 11, writes: 'guarded', workspace: state, boot: 'o135', ...answer }));
  });
  await new Promise(resolve => server.listen(path.join(state, 'daemon.sock'), resolve));
  t.after(() => server.close());
  const profile = await mkdtemp(path.join(os.tmpdir(), 'p9-o135-profile-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.P9_SAMPLE_DATA;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise(resolve => setTimeout(resolve, 15000))]); proc.kill(); });
  return app.firstWindow();
}
const label = async (page, text) => {
  const status = page.locator('#daemonStatus', { hasText: text });
  await status.waitFor({ timeout: 15000 });
  return [await status.textContent(), await status.getAttribute('title')];
};

test('O135: a daemon of another version is named in the status bar, with where it runs from', { skip: process.platform === 'win32', timeout: 60000 }, async t => {
  const page = await standIn(t, { version: '0.1.5', from: '/srv/src/p9-old' });
  assert.deepEqual(await label(page, 'Daemon 0.1.5'), ['Daemon 0.1.5, not ' + own + ': /srv/src/p9-old',
    `This window is P9 ${own}, but its background service still runs 0.1.5 from /srv/src/p9-old. Updating P9 did not move it; start the service from the installed P9 to use ${own}.`]);
  console.log('PASS O135: another version and its folder are in the status bar');
});

test('O135: a daemon older than /health from still has its version named', { skip: process.platform === 'win32', timeout: 60000 }, async t => {
  const page = await standIn(t, { version: '0.1.5' });
  assert.deepEqual(await label(page, 'Daemon 0.1.5'), ['Daemon 0.1.5, not ' + own,
    `This window is P9 ${own}, but its background service still runs 0.1.5. Updating P9 did not move it; start the service from the installed P9 to use ${own}.`]);
  console.log('PASS O135: no from, the version alone is named');
});

test('O135: the same version still says Daemon connected', { skip: process.platform === 'win32', timeout: 60000 }, async t => {
  const page = await standIn(t, { version: own, from: '/srv/src/p9' });
  assert.deepEqual(await label(page, 'Daemon connected'), ['Daemon connected', 'Status connected.']);
  console.log('PASS O135: same version, Daemon connected');
});
