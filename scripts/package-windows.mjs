import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { missingWindowsBinaries } from '../apps/server/windows.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = '26.10.0';
const archiveHash = '9fef7eca6743a6b910989cd8e78712376b394fcb9b6e1e9c44a0799a287f90c5';
const build = path.join(root, '.build');
const archive = path.join(build, `node-v${version}-win-x64.zip`);
const runtime = path.join(build, 'node-win-x64');
const node = path.join(runtime, 'node.exe');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.status !== 0) throw new Error(`${command}-failed`);
}

await mkdir(runtime, { recursive: true });
if (!(await access(node).then(() => true, () => false))) {
  let bytes = await readFile(archive).catch(() => null);
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== archiveHash) {
    const response = await fetch(`https://nodejs.org/dist/v${version}/node-v${version}-win-x64.zip`);
    if (!response.ok) throw new Error(`node-download-${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== archiveHash) throw new Error('node-download-hash-mismatch');
    await writeFile(archive, bytes);
  }
  if (process.platform === 'win32') run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(root, 'scripts', 'extract-node-windows.ps1'), '-Archive', archive, '-Build', build, '-Destination', node, '-Version', version]);
  else run('unzip', ['-jo', archive, `node-v${version}-win-x64/node.exe`, '-d', runtime]);
}
if (!(await readFile(node)).length) throw new Error('empty-node-runtime');
if (!process.env.npm_execpath) throw new Error('run-with-pnpm-package-win');
run(process.execPath, [process.env.npm_execpath, 'build']);
if (process.env.P9_PREPARE_ONLY === '1') process.exit(0);
const missing = missingWindowsBinaries(await readdir(path.join(root, 'node_modules', '.pnpm')));
if (missing.length) throw new Error(`windows-platform-binaries-not-installed:${missing.join(',')};build-on-windows`);
// The daemon gets its own production-only, hoisted node_modules. Copying the pnpm tree turns its top-level junctions into
// plain folders, so packages then miss their dependencies (installed daemon failed: zod not found, 2026-10-17).
const daemonDeps = path.join(build, 'daemon-deps');
await mkdir(daemonDeps, { recursive: true });
for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) await copyFile(path.join(root, file), path.join(daemonDeps, file));
run(process.execPath, [process.env.npm_execpath, 'install', '--prod', '--frozen-lockfile', '--config.node-linker=hoisted'], { cwd: daemonDeps });
run(process.execPath, [process.env.npm_execpath, 'dlx', 'electron-builder@26.15.3', '--win', 'nsis', '--x64']);
// v1 installers are unsigned (README): SHA256SUMS beside them is how a download is checked.
const out = path.join(root, 'dist', 'windows');
const installers = (await readdir(out)).filter((name) => name.endsWith('.exe')).sort();
if (!installers.length) throw new Error('no-installer-built');
await writeFile(path.join(out, 'SHA256SUMS'), (await Promise.all(installers.map(async (name) =>
  createHash('sha256').update(await readFile(path.join(out, name))).digest('hex') + '  ' + name))).join('\n') + '\n');
