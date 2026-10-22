import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { missingWindowsBinaries } from '../apps/server/windows.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = '26.10.0';
// B9: one installer per architecture, each built on a runner of that architecture (windows-installer.yaml), so pnpm has
// installed that architecture's codex, claude and build binaries. ponytail: cross-building needs pnpm supportedArchitectures.
const arch = process.env.P9_ARCH || process.arch;
const archiveHash = {
  x64: '9fef7eca6743a6b910989cd8e78712376b394fcb9b6e1e9c44a0799a287f90c5',
  arm64: 'b778640d7271566bcaa9679912cdf0684c13e824c114e41a8b696fb14af7a7aa',
}[arch];
if (!archiveHash) throw new Error(`unsupported-windows-arch:${arch}`);
const nodeName = `node-v${version}-win-${arch}`;
const build = path.join(root, '.build');
const archive = path.join(build, `${nodeName}.zip`);
// One folder for either architecture (package.json extraResources names it); the stamp says whose node.exe it holds.
const runtime = path.join(build, 'node-win');
const node = path.join(runtime, 'node.exe');
const nodeLicense = path.join(runtime, 'LICENSE');
const exists = (file) => access(file).then(() => true, () => false);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.status !== 0) throw new Error(`${command}-failed`);
}

await mkdir(runtime, { recursive: true });
const stamp = path.join(runtime, 'ARCH');
if (!(await exists(node)) || !(await exists(nodeLicense)) || (await readFile(stamp, 'utf8').catch(() => '')) !== arch) {
  let bytes = await readFile(archive).catch(() => null);
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== archiveHash) {
    const response = await fetch(`https://nodejs.org/dist/v${version}/${nodeName}.zip`);
    if (!response.ok) throw new Error(`node-download-${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== archiveHash) throw new Error('node-download-hash-mismatch');
    await writeFile(archive, bytes);
  }
  if (process.platform === 'win32') run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(root, 'scripts', 'extract-node-windows.ps1'), '-Archive', archive, '-Build', build, '-Destination', node, '-Version', version, '-Arch', arch]);
  else run('unzip', ['-jo', archive, `${nodeName}/node.exe`, `${nodeName}/LICENSE`, '-d', runtime]);
  await writeFile(stamp, arch);
}
if (!(await readFile(node)).length) throw new Error('empty-node-runtime');
if (!process.env.npm_execpath) throw new Error('run-with-pnpm-package-win');
run(process.execPath, [process.env.npm_execpath, 'build']);
// Every notice the installed app must carry, in one folder beside it (resources/licenses): P9's own licence, the
// dependency list, DUWOP's MIT text, Node's licence (node.exe is bundled) and each bundled font's OFL.
const licenses = path.join(build, 'licenses');
await mkdir(path.join(licenses, 'fonts'), { recursive: true });
for (const file of ['LICENSE', 'LICENSES.md', 'third-party/DUWOP-LICENSE.md']) await copyFile(path.join(root, file), path.join(licenses, path.basename(file)));
await copyFile(nodeLicense, path.join(licenses, 'node-LICENSE'));
const fonts = Object.keys(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).devDependencies).filter((name) => name.startsWith('@fontsource'));
for (const font of fonts) await copyFile(path.join(root, 'node_modules', font, 'LICENSE'), path.join(licenses, 'fonts', font.slice(1).replace('/', '-') + '-LICENSE'));
if (process.env.P9_PREPARE_ONLY === '1') process.exit(0);
const missing = missingWindowsBinaries(await readdir(path.join(root, 'node_modules', '.pnpm')), arch);
if (missing.length) throw new Error(`windows-platform-binaries-not-installed:${missing.join(',')};build-on-windows`);
// The daemon gets its own production-only, hoisted node_modules. Copying the pnpm tree turns its top-level junctions into
// plain folders, so packages then miss their dependencies (installed daemon failed: zod not found, 2026-10-17).
const daemonDeps = path.join(build, 'daemon-deps');
await mkdir(daemonDeps, { recursive: true });
for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) await copyFile(path.join(root, file), path.join(daemonDeps, file));
run(process.execPath, [process.env.npm_execpath, 'install', '--prod', '--frozen-lockfile', '--config.node-linker=hoisted'], { cwd: daemonDeps });
// The daemon's copies of teh.mjs (doctor) and package.json come from .build: electron-builder leaves any file an
// extraResources entry names out of app.asar, and the app needs both (CI 2026-10-22: "package.json" not found in app.asar).
const daemonExtra = path.join(build, 'daemon-extra');
await mkdir(path.join(daemonExtra, 'scripts'), { recursive: true });
for (const file of ['package.json', 'scripts/teh.mjs']) await copyFile(path.join(root, file), path.join(daemonExtra, file));
// E4: the host's C# compiled once here, so an installed host loads it instead of compiling (1-3 s) on every start.
run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'windows-host.ps1'),
  '-Mode', 'Compile', '-Out', path.join(daemonExtra, 'scripts', 'P9WindowsHost.dll')]);
// NSIS 3.0.4 cannot open a path over 260 characters, and pnpm's default dlx cache put electron-builder's StdUtils.nsh at
// 276 (the Windows desktop 2026-10-17, GitHub's Windows runner 2026-10-20), and D:\p9-cache still gave 263. A 2-letter cache
// root on the same drive plus 40-character pnpm package folders (Windows default 60) leave about 20 to spare; a cache folder
// you set yourself wins. --publish never: on a CI machine electron-builder otherwise uploads by itself.
// arm64: 7za packs the 45 ARM64 .exe and .dll files with its ARM64 filter (method 0A); the installer exited 0 with no
// node.exe on disk (job 119734051928), the NSIS 7z plugin skipping it. BCJ2 is the filter x64 installs extract.
const cacheDir = process.env.npm_config_cache_dir || (process.platform === 'win32' ? path.join(path.parse(root).root, 'p9') : undefined);
run(process.execPath, [process.env.npm_execpath, 'dlx', 'electron-builder@26.15.3', '--win', 'nsis', `--${arch}`, '--publish', 'never'],
  { env: { ...process.env, ...(cacheDir ? { npm_config_cache_dir: cacheDir, npm_config_virtual_store_dir_max_length: '40' } : {}),
    ...(arch === 'arm64' ? { ELECTRON_BUILDER_7Z_FILTER: 'BCJ2' } : {}) } });
// v1 installers are unsigned (README): SHA256SUMS beside them is how a download is checked.
const out = path.join(root, 'dist', 'windows');
const installers = (await readdir(out)).filter((name) => name.endsWith(`-${arch}.exe`)).sort();
if (!installers.length) throw new Error('no-installer-built');
await writeFile(path.join(out, `SHA256SUMS-${arch}`), (await Promise.all(installers.map(async (name) =>
  createHash('sha256').update(await readFile(path.join(out, name))).digest('hex') + '  ' + name))).join('\n') + '\n');
