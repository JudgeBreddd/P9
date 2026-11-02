// U8 (threat model row 50 U8 and U9): the slim Temporary P9 carries the agents' JavaScript only; their binary packages
// (codex, claude) differ per machine, so install.sh --slim runs this there to fetch the ones for this machine's arch.
// Each comes from registry.npmjs.org by exact version and must match the sha512 integrity this app's pnpm-lock.yaml pins
// (bundle-daemon.mjs wrote both into agents.json); a mismatch installs nothing and exits 1.
// P9_AGENTS_FROM=folder: take the .tgz files from that folder instead of the registry (the tests; the same check applies).
// Builder, 2026-11-02 (the install spent 55 of its 70 s here): arguments claude and/or codex fetch only those; --keep FOLDER
// first takes each pinned package the old install there already has (hard links, no download), and alone fetches nothing,
// so install.sh --slim keeps the owner's agents through an update and the desktop fetches the rest once connected. No
// arguments: every agent, as before. A package already here at its pinned version is left as it is.
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
const args = process.argv.slice(2), at = args.indexOf('--keep'), keep = at < 0 ? null : args.splice(at, 2)[1];
if (at >= 0 && !keep || args.some((name) => !['claude', 'codex'].includes(name))) {
  console.error('Usage: agents.mjs [--keep FOLDER] [claude] [codex]');
  process.exit(2);
}
const wanted = args.length || keep ? new Set(args) : new Set(['claude', 'codex']);
const modules = path.join(root, 'node_modules');
// The version a pin names: its tarball is <name>-<version>.tgz under registry.npmjs.org/<scope>/<name>/-/.
const pinned = (url) => { const file = path.basename(new URL(url).pathname, '.tgz'), name = new URL(url).pathname.split('/-/')[0].split('/').pop(); return file.slice(name.length + 1); };
const has = async (dir, url) => JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8').catch(() => '{}')).version === pinned(url);
await mkdir(modules, { recursive: true });
const work = await mkdtemp(path.join(modules, '.agents-'));
try {
  for (const { folder, url, integrity } of pins) {
    const target = path.join(modules, folder), out = path.join(work, 'p');
    if (await has(target, url)) continue;
    const old = keep && path.join(keep, 'node_modules', folder);
    if (old && await has(old, url)) {
      console.log('P9 agents: ' + folder + ' (kept)');
      await rm(out, { recursive: true, force: true });
      // Links, not copies: the old install is replaced whole afterwards, never written into.
      execFileSync('cp', ['-al', old, out]);
      await mkdir(path.dirname(target), { recursive: true });
      await rm(target, { recursive: true, force: true });
      await rename(out, target);
      continue;
    }
    if (!wanted.has(folder.startsWith('@openai/') ? 'codex' : 'claude')) continue;
    console.log('P9 agents: ' + folder);
    let bytes;
    if (from) bytes = await readFile(path.join(from, path.basename(new URL(url).pathname)));
    else {
      // Review 2 L5: a stalled or endless download stops (10 minutes, 1 GB) instead of hanging the install or filling memory.
      const response = await fetch(url, { signal: AbortSignal.timeout(600000) });
      if (!response.ok) throw new Error(`download ${response.status} for ${url}`);
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        if ((size += chunk.length) > 1024 ** 3) throw new Error(`download over 1 GB for ${url}; nothing was installed`);
        chunks.push(chunk);
      }
      bytes = Buffer.concat(chunks);
    }
    const [algorithm, digest] = [integrity.slice(0, integrity.indexOf('-')), integrity.slice(integrity.indexOf('-') + 1)];
    if (algorithm !== 'sha512' || createHash('sha512').update(bytes).digest('base64') !== digest) throw new Error(`${folder} does not match its pinned checksum; nothing was installed`);
    const tgz = path.join(work, 'p.tgz');
    await writeFile(tgz, bytes);
    await mkdir(out);
    // npm's tarballs hold one top folder, package/.
    execFileSync('tar', ['-xzf', tgz, '-C', out, '--strip-components=1', '--no-same-owner']);
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
