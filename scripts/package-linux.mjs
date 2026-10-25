import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { REPO } from '../apps/server/anymouse.mjs';
import { bundleDaemon } from './bundle-daemon.mjs';

// The Linux AppImage, the same steps as package-windows.mjs: a pinned Node for the daemon, the notices, the daemon bundle,
// then electron-builder. x64 only. ponytail: an arm64 AppImage needs an arm64 runner and Node's linux-arm64 pin.
const root = fileURLToPath(new URL('../', import.meta.url));
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('build-on-linux-x64');
const version = '26.10.0';
const nodeName = `node-v${version}-linux-x64`;
// nodejs.org/dist/v26.10.0/SHASUMS256.txt, the same pin as install.sh.
const archiveHash = 'cb5c9ce9c80d7b8821e3a258543c71b939138cf17c74d5cc44bbe85d6dbc5ad8';
const build = path.join(root, '.build');
const archive = path.join(build, `${nodeName}.tar.gz`);
const runtime = path.join(build, 'node-linux');
const exists = (file) => access(file).then(() => true, () => false);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.status !== 0) throw new Error(`${command}-failed`);
}

await mkdir(runtime, { recursive: true });
if (!(await exists(path.join(runtime, 'bin', 'node'))) || !(await exists(path.join(runtime, 'LICENSE')))) {
  let bytes = await readFile(archive).catch(() => null);
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== archiveHash) {
    const response = await fetch(`https://nodejs.org/dist/v${version}/${nodeName}.tar.gz`);
    if (!response.ok) throw new Error(`node-download-${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== archiveHash) throw new Error('node-download-hash-mismatch');
    await writeFile(archive, bytes);
  }
  run('tar', ['-xzf', archive, '-C', runtime, '--strip-components=1', `${nodeName}/bin/node`, `${nodeName}/LICENSE`]);
}
// nodejs.org's binary carries its debug info: strip takes it from 149.7 MB to 116.4 MB (about 7.5 MB less compressed).
// The dynamic symbols native addons link against stay. Outside the block so an older unstripped copy in .build is stripped too.
run('strip', [path.join(runtime, 'bin', 'node')]);
if (!process.env.npm_execpath) throw new Error('run-with-pnpm-package-linux');
run(process.execPath, [process.env.npm_execpath, 'build']);
// The same notices as the Windows installer, in resources/licenses.
const licenses = path.join(build, 'licenses');
await mkdir(path.join(licenses, 'fonts'), { recursive: true });
for (const file of ['LICENSE', 'LICENSES.md', 'third-party/DUWOP-LICENSE.md']) await copyFile(path.join(root, file), path.join(licenses, path.basename(file)));
await copyFile(path.join(runtime, 'LICENSE'), path.join(licenses, 'node-LICENSE'));
const fonts = Object.keys(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).devDependencies).filter((name) => name.startsWith('@fontsource'));
for (const font of fonts) await copyFile(path.join(root, 'node_modules', font, 'LICENSE'), path.join(licenses, 'fonts', font.slice(1).replace('/', '-') + '-LICENSE'));
const daemonExtra = path.join(build, 'daemon-extra');
await mkdir(path.join(daemonExtra, 'scripts', 'launcher'), { recursive: true });
// AU4: the app copies this folder to ~/.local/share/p9/daemon/<version> (teh.mjs stageDaemon); the unit runs the launcher,
// and install-service.mjs / uninstall-service.mjs are what Setup's Change the folder runs from that copy.
for (const file of ['package.json', 'scripts/teh.mjs', 'scripts/launcher/p9-launch.sh', 'scripts/install-service.mjs', 'scripts/uninstall-service.mjs'])
  await copyFile(path.join(root, file), path.join(daemonExtra, file));
await writeFile(path.join(licenses, 'daemon-NOTICES.md'), await bundleDaemon(root, daemonExtra, 'linux-x64'));
// --publish never as on Windows; the feed goes into resources/app-update.yml and latest-linux.yml beside the AppImage.
run(process.execPath, [process.env.npm_execpath, 'dlx', 'electron-builder@26.15.3', '--linux', 'AppImage', '--x64', '--publish', 'never',
  '-c.directories.output=dist/linux', '-c.publish.provider=github', '-c.publish.owner=' + REPO.split('/')[0], '-c.publish.repo=' + REPO.split('/')[1]]);
// Unsigned like the Windows installers: SHA256SUMS-linux-x64 beside the AppImage is how a download is checked.
const out = path.join(root, 'dist', 'linux');
const images = (await readdir(out)).filter((name) => name.endsWith('.AppImage')).sort();
if (!images.length) throw new Error('no-appimage-built');
await writeFile(path.join(out, 'SHA256SUMS-linux-x64'), (await Promise.all(images.map(async (name) =>
  createHash('sha256').update(await readFile(path.join(out, name))).digest('hex') + '  ' + name))).join('\n') + '\n');
