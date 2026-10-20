import { spawnSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function licenseInventory() {
  const listing = spawnSync('pnpm', ['list', '--depth', 'Infinity', '--json'], { cwd: root, encoding: 'utf8' });
  if (listing.status !== 0) throw new Error('dependency-list-failed');
  const dependencies = new Map();
  async function collect(item) {
    const manifest = JSON.parse(await readFile(path.join(item.path, 'package.json'), 'utf8'));
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, dependency] of Object.entries(item[field] ?? {})) {
        const key = name + '@' + dependency.version;
        const optional = field === 'optionalDependencies' || Object.hasOwn(manifest.optionalDependencies ?? {}, name);
        const prior = dependencies.get(key);
        if (!prior) {
          dependencies.set(key, { ...dependency, optional });
          try { await collect(dependency); } catch (error) { if (!(optional && error.code === 'ENOENT')) throw error; }
        }
        else if (!optional) prior.optional = false;
      }
    }
  }
  for (const item of JSON.parse(listing.stdout)) await collect(item);
  const records = [];
  for (const [name, dependency] of [...dependencies].sort(([a], [b]) => a.localeCompare(b))) {
    let manifest;
    try { manifest = JSON.parse(await readFile(path.join(dependency.path, 'package.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' && dependency.optional) { records.push({ name, installed: false }); continue; } throw error; }
    if (typeof manifest.license !== 'string') throw new Error('missing-license: ' + name);
    const files = {};
    for (const file of (await readdir(dependency.path)).filter(f => /^(license|licence|copying|notice|ofl)(\.|$)/i.test(f)).sort()) {
      const data = await readFile(path.join(dependency.path, file));
      files[file] = createHash('sha256').update(data).digest('hex');
    }
    records.push({ name, license: manifest.license, files });
  }
  return records;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = JSON.stringify(await licenseInventory(), null, 2) + '\n';
  if (process.argv.includes('--write')) await writeFile(path.join(root, 'dependency-licenses.json'), text);
  else if (text !== await readFile(path.join(root, 'dependency-licenses.json'), 'utf8')) throw new Error('license-inventory-changed');
  console.log('PASS dependency license inventory: complete recursive installed graph and notice hashes');
}
