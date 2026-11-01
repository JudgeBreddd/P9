// U8 (threat model row 50 U8 and U9): the slim Temporary P9 carries the agents' JavaScript only; their binary packages
// (codex, claude) differ per machine, so install.sh --slim runs this there to fetch the ones for this machine's arch.
// Each comes from registry.npmjs.org by exact version and must match the sha512 integrity this app's pnpm-lock.yaml pins
// (bundle-daemon.mjs wrote both into agents.json); a mismatch installs nothing and exits 1.
// P9_AGENTS_FROM=folder: take the .tgz files from that folder instead of the registry (the tests; the same check applies).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const platform = process.platform + '-' + process.arch;
const pins = JSON.parse(await readFile(path.join(root, 'agents.json'), 'utf8'))[platform];
if (!Array.isArray(pins)) {
  console.error(`P9 has no agents for ${platform}; it runs on Linux x64 and arm64.`);
  process.exit(1);
}
const from = process.env.P9_AGENTS_FROM;
const modules = path.join(root, 'node_modules');
await mkdir(modules, { recursive: true });
const work = await mkdtemp(path.join(modules, '.agents-'));
try {
  for (const { folder, url, integrity } of pins) {
    console.log('P9 agents: ' + folder);
    let bytes;
    if (from) bytes = await readFile(path.join(from, path.basename(new URL(url).pathname)));
    else {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`download ${response.status} for ${url}`);
      bytes = Buffer.from(await response.arrayBuffer());
    }
    const [algorithm, digest] = [integrity.slice(0, integrity.indexOf('-')), integrity.slice(integrity.indexOf('-') + 1)];
    if (algorithm !== 'sha512' || createHash('sha512').update(bytes).digest('base64') !== digest) throw new Error(`${folder} does not match its pinned checksum; nothing was installed`);
    const tgz = path.join(work, 'p.tgz'), out = path.join(work, 'p');
    await writeFile(tgz, bytes);
    await mkdir(out);
    // npm's tarballs hold one top folder, package/.
    execFileSync('tar', ['-xzf', tgz, '-C', out, '--strip-components=1', '--no-same-owner']);
    const target = path.join(modules, folder);
    await mkdir(path.dirname(target), { recursive: true });
    await rm(target, { recursive: true, force: true });
    await rename(out, target);
    await rm(tgz);
  }
} catch (error) {
  console.error('P9 agents: ' + error.message);
  process.exitCode = 1;
} finally {
  await rm(work, { recursive: true, force: true });
}
