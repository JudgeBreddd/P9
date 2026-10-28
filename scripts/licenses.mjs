import { spawnSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
// A package whose package.json has no license field: the licence its own file states, checked by hand.
const overrides = { 'khroma@2.1.0': { license: 'MIT', file: 'license' } };
export async function licenseInventory() {
  const listing = spawnSync('pnpm', ['list', '--depth', 'Infinity', '--json'], { cwd: root, encoding: 'utf8' });
  if (listing.status !== 0) throw new Error('dependency-list-failed');
  const dependencies = new Map();
  const walked = new Set();
  async function collect(item) {
    const manifest = JSON.parse(await readFile(path.join(item.path, 'package.json'), 'utf8'));
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, dependency] of Object.entries(item[field] ?? {})) {
        const key = name + '@' + dependency.version;
        const optional = field === 'optionalDependencies' || Object.hasOwn(manifest.optionalDependencies ?? {}, name);
        const prior = dependencies.get(key);
        if (!prior) dependencies.set(key, { ...dependency, optional });
        else if (!optional) prior.optional = false;
        // pnpm lists a repeat as a childless deduped stub, which can come before the full entry: walk the full one.
        if (!walked.has(key) && !dependency.deduped) {
          walked.add(key);
          try { await collect(dependency); } catch (error) { if (!(optional && error.code === 'ENOENT')) throw error; }
        }
      }
    }
  }
  for (const item of JSON.parse(listing.stdout)) await collect(item);
  const records = [];
  for (const [name, dependency] of [...dependencies].sort(([a], [b]) => a.localeCompare(b))) {
    let manifest;
    try { manifest = JSON.parse(await readFile(path.join(dependency.path, 'package.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' && dependency.optional) { records.push({ name, installed: false }); continue; } throw error; }
    const files = {};
    for (const file of (await readdir(dependency.path)).filter(f => /^(license|licence|copying|notice|ofl)(\.|$)/i.test(f)).sort()) {
      const data = await readFile(path.join(dependency.path, file));
      files[file] = createHash('sha256').update(data).digest('hex');
    }
    const override = overrides[name];
    if (override && typeof manifest.license === 'string') throw new Error('override-not-needed: ' + name);
    if (override && !files[override.file]) throw new Error('override-file-missing: ' + name);
    const license = override?.license ?? manifest.license;
    if (typeof license !== 'string') throw new Error('missing-license: ' + name);
    records.push({ name, license, files });
  }
  return records;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = JSON.stringify(await licenseInventory(), null, 2) + '\n';
  if (process.argv.includes('--write')) await writeFile(path.join(root, 'dependency-licenses.json'), text);
  else if (text !== await readFile(path.join(root, 'dependency-licenses.json'), 'utf8')) throw new Error('license-inventory-changed');
  console.log('PASS dependency license inventory: complete recursive installed graph and notice hashes');
}
