// AU4 (Linux AppImage): teh.mjs stageDaemon copies each daemon version out of the AppImage, and launcher/p9-launch.sh
// starts the one daemon/current names, whatever node and server the unit was installed with. The Windows side
// (install-windows.ps1, p9-launch.ps1) runs in windows-installer.yaml.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { stageDaemon } from '../scripts/teh.mjs';

const launcherSource = fileURLToPath(new URL('../scripts/launcher/p9-launch.sh', import.meta.url));
// A resources/daemon folder whose node prints what it was started with.
async function daemon(version) {
  const source = await mkdtemp(path.join(os.tmpdir(), 'p9-daemon-'));
  await mkdir(path.join(source, 'apps', 'server'), { recursive: true });
  await mkdir(path.join(source, 'scripts', 'launcher'), { recursive: true });
  await writeFile(path.join(source, 'package.json'), JSON.stringify({ version }));
  await writeFile(path.join(source, 'node'), '#!/bin/sh\necho "$0" "$@"\n', { mode: 0o755 });
  await writeFile(path.join(source, 'apps', 'server', 'main.mjs'), '');
  await copyFile(launcherSource, path.join(source, 'scripts', 'launcher', 'p9-launch.sh'));
  return source;
}

test('each version is copied once, current names it, and only it and the one before are kept', { skip: process.platform === 'win32' }, async () => {
  const share = await realpath(await mkdtemp(path.join(os.tmpdir(), 'p9-share-')));
  const daemons = path.join(share, 'daemon');
  assert.deepEqual(await stageDaemon(await daemon('1.0.0'), share), { version: '1.0.0', previous: '' });
  assert.equal(await readFile(path.join(daemons, 'current'), 'utf8'), '1.0.0');
  assert.ok(await stat(path.join(daemons, '1.0.0', '.complete')));
  assert.equal((await stat(path.join(share, 'launcher', 'p9-launch.sh'))).mode & 0o777, 0o755);
  assert.deepEqual(await stageDaemon(await daemon('1.1.0'), share), { version: '1.1.0', previous: '1.0.0' });
  // A copy cut short (no .complete) is made again.
  await mkdir(path.join(daemons, '1.2.0'));
  await stageDaemon(await daemon('1.2.0'), share);
  assert.ok(await stat(path.join(daemons, '1.2.0', 'node')));
  assert.deepEqual((await readdir(daemons)).sort(), ['1.1.0', '1.2.0', 'current']);
  // The same version again keeps the one before it.
  assert.deepEqual(await stageDaemon(await daemon('1.2.0'), share), { version: '1.2.0', previous: '1.2.0' });
  assert.deepEqual((await readdir(daemons)).sort(), ['1.1.0', '1.2.0', 'current']);
  await assert.rejects(stageDaemon(await daemon('1.0.0/../x'), share), /version-unreadable/);
});

test('the launcher starts the version current names, not the one the unit was installed with', { skip: process.platform === 'win32' }, async () => {
  const share = await realpath(await mkdtemp(path.join(os.tmpdir(), 'p9-share-')));
  await stageDaemon(await daemon('2.0.0'), share);
  await stageDaemon(await daemon('2.1.0'), share);
  const launcher = path.join(share, 'launcher', 'p9-launch.sh'), old = path.join(share, 'daemon', '2.0.0');
  const out = execFileSync(launcher, [path.join(old, 'node'), path.join(old, 'apps', 'server', 'main.mjs'), '--workspace', '/w s'], { encoding: 'utf8' });
  const dir = path.join(share, 'daemon', '2.1.0');
  assert.equal(out, `${path.join(dir, 'node')} ${path.join(dir, 'apps', 'server', 'main.mjs')} --workspace /w s\n`);
  // A rollback rewrites current only.
  await writeFile(path.join(share, 'daemon', 'current'), '2.0.0\n');
  assert.match(execFileSync(launcher, ['n', 's'], { encoding: 'utf8' }), /daemon\/2\.0\.0\/node /);
  for (const bad of ['', '../2.1.0', '2.1.0;x', 'latest']) {
    await writeFile(path.join(share, 'daemon', 'current'), bad);
    assert.throws(() => execFileSync(launcher, ['n', 's'], { stdio: 'pipe' }), undefined, JSON.stringify(bad));
  }
});

test('an update\'s launcher waits as .next; a rollback puts the kept AppImage back, sets current and starts it', { skip: process.platform === 'win32', timeout: 30_000 }, async () => {
  const share = await realpath(await mkdtemp(path.join(os.tmpdir(), 'p9-share-')));
  await stageDaemon(await daemon('3.0.0'), share);
  const launcher = path.join(share, 'launcher', 'p9-launch.sh');
  await writeFile(launcher, '#!/bin/sh\necho old\n', { mode: 0o755 });
  await stageDaemon(await daemon('3.1.0'), share);
  assert.equal(await readFile(launcher, 'utf8'), '#!/bin/sh\necho old\n', 'the launcher in use is not replaced');
  assert.equal(await readFile(launcher + '.next', 'utf8'), await readFile(launcherSource, 'utf8'));
  await copyFile(launcherSource, launcher);
  // The AppImage in use is 3.1.0's; the kept 3.0.0 one writes which it is when started.
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-home-')), started = path.join(home, 'started');
  const image = path.join(home, 'P9 Event Horizon.AppImage');
  await writeFile(image, '#!/bin/sh\necho 3.1.0\n', { mode: 0o755 });
  await mkdir(path.join(share, 'appimage'));
  await writeFile(path.join(share, 'appimage', '3.0.0.AppImage'), `#!/bin/sh\necho "3.0.0 \${APPIMAGE:-none}" >'${started}'\n`);
  const env = { PATH: process.env.PATH, HOME: home, APPIMAGE: image, APPDIR: '/tmp/.mount_x' };
  const run = (args) => execFileSync('/bin/sh', [launcher, '--rollback', ...args], { env, stdio: 'pipe' });
  for (const bad of [['3.0.0;x', '3.1.0', image, '1'], ['3.0.0', '3.0.0', image, '1'], ['3.0.0', '3.1.0', 'rel.AppImage', '1'],
    ['3.0.0', '3.1.0', image, '0'], ['3.0.0', '3.1.0', image], ['9.9.9', '3.1.0', image, '1']]) assert.throws(() => run(bad), undefined, JSON.stringify(bad));
  assert.equal(await readFile(image, 'utf8'), '#!/bin/sh\necho 3.1.0\n', 'nothing refused touched the AppImage');
  // Not execFileSync: a blocked event loop never reaps the app below, and kill -0 sees it until the launcher gives up.
  const app = spawn('sleep', ['1']);
  const begun = Date.now();
  await promisify(execFile)('/bin/sh', [launcher, '--rollback', '3.0.0', '3.1.0', image, String(app.pid)], { env });
  assert.ok(Date.now() - begun >= 500, 'it waited for the app to quit');
  assert.match(await readFile(image, 'utf8'), /3\.0\.0/);
  assert.equal((await stat(image)).mode & 0o777, 0o755);
  assert.equal(await readFile(path.join(share, 'daemon', 'current'), 'utf8'), '3.0.0');
  const record = JSON.parse(await readFile(path.join(share, 'rollback.json'), 'utf8'));
  assert.deepEqual([record.from, record.to, record.installer], ['3.1.0', '3.0.0', 'kept']);
  assert.match(await readFile(path.join(share, 'rollback.log'), 'utf8'), /going back to 3\.0\.0[\s\S]*starting it/);
  for (let i = 0; i < 50 && !await stat(started).catch(() => null); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await readFile(started, 'utf8'), '3.0.0 none\n', 'started again without the old mount\'s variables');
});
