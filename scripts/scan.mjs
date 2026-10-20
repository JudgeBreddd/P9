import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readdir, readFile, copyFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function paths(directory, root = directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', '.git', '.build', 'dist'].includes(entry.name) || entry.name === '_' + 'private') continue;
    const name = path.join(directory, entry.name);
    if (['apps/web/dist', 'apps/web/.astro'].includes(path.relative(root, name))) continue;
    if (entry.isDirectory()) files.push(...await paths(name, root));
    else if (entry.isFile()) files.push(name);
    else throw new Error('nonregular-source');
  }
  return files;
}

export async function pathScan(directory) {
  const patterns = ['/ho' + 'me/', 'IC' + 'M/', '_' + 'private/'];
  const bad = [];
  for (const file of await paths(directory)) {
    if (path.basename(file) === '.publishignore' || path.basename(file) === '.gitignore') continue;
    const text = await readFile(file, 'utf8');
    if (patterns.some((pattern) => text.includes(pattern))) bad.push(path.relative(directory, file));
  }
  return bad;
}

export async function scan(directory) {
  const bad = await pathScan(directory);
  if (bad.length) throw new Error('private-path-in-source: ' + bad.join(', '));
  const source = await mkdtemp(path.join(os.tmpdir(), 'p9-source-'));
  try {
    for (const file of await paths(directory)) {
      const target = path.join(source, path.relative(directory, file));
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(file, target);
    }
    const result = spawnSync('gitleaks', ['dir', source, '--redact', '--no-banner'], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error('gitleaks-refused');
  } finally { await rm(source, { recursive: true, force: true }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--staged')) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'p9-index-'));
    try {
      const names = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
      for (const name of names) {
        if (name.split('/').some((part) => part === '..' || part === '_' + 'private')) throw new Error('private-index-path');
        const target = path.join(directory, name);
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, execFileSync('git', ['show', `:${name}`], { maxBuffer: 64 * 1024 * 1024 }), { mode: 0o600 });
      }
      await scan(directory);
    } finally { await rm(directory, { recursive: true, force: true }); }
  } else await scan(root);
  console.log('PASS secret and private-path scan');
}
