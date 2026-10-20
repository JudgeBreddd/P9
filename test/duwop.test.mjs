import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
test('gate:4 refuses a one-byte change to a pinned DUWOP file', { timeout: 90000 }, async () => {
  const copy = await mkdtemp(path.join(os.tmpdir(), 'p9-pin-'));
  try {
    await cp(root, copy, { recursive: true, filter: source => !['node_modules', 'dist', '.astro', '.git', '_private'].includes(path.basename(source)) });
    await symlink(path.join(root, 'node_modules'), path.join(copy, 'node_modules'), 'dir');
    const file = path.join(copy, 'apps/web/src/lib/duwop.css');
    const bytes = await readFile(file), offset = bytes.indexOf(Buffer.from('DUWOP'));
    assert.ok(offset >= 0); bytes[offset] ^= 1;
    await writeFile(file, bytes);
    const result = spawnSync(process.execPath, ['scripts/gate.mjs', '--phase4'], { cwd: copy, encoding: 'utf8', timeout: 80000 });
    assert.notEqual(result.status, 0, 'the actual Phase 4 gate must refuse a modified vendor file');
    assert.match(result.stdout + result.stderr, /duwop-pin-mismatch: src\/lib\/duwop.css/);
  } finally { await rm(copy, { recursive: true, force: true }); }
});
