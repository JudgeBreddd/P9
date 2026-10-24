import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mutationInventory } from '../scripts/gate.mjs';
import { fixture } from './helpers.mjs';

test('mutation inventory checks every supported source extension and refuses unknown extensions', async (t) => {
  for (const extension of ['.mjs', '.js', '.cjs', '.ts', '.tsx', '.py', '.sh']) {
    await t.test(extension, async () => {
      const { workspace } = await fixture();
      // Remove the data fixture from the inventory by using a fresh subdirectory.
      const { mkdir } = await import('node:fs/promises');
      const directory = path.join(workspace, 'source');
      await mkdir(directory);
      await writeFile(path.join(directory, 'README.md'), 'Allowed documentation');
      await mutationInventory(directory);
      await writeFile(path.join(directory, 'rogue' + extension), "import fs from 'node:fs'; fs.writeFileSync('target', 'changed');");
      await assert.rejects(mutationInventory(directory), /unreviewed-write-module|unsupported-source-extension/);
    });
  }
});

// The gate itself runs by hand only; this keeps P9's own source inside the list on every CI run (v0.1.5: 8 modules had
// slipped out of it unnoticed).
test("P9's own source passes the mutation inventory", async () => {
  await mutationInventory(fileURLToPath(new URL('../', import.meta.url)));
});
