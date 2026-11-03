import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// D18: Dev Focus colours Markdown. The markdown-basics extension is bundled into the editor page, so its grammar is one
// of the built page's assets (the dev space builds apps/dev before the tests run).
test('D18: the Dev Focus build carries the Markdown grammar', { timeout: 30000 }, async () => {
  const files = await readdir(path.join(root, 'apps/dev/dist'), { recursive: true });
  assert.ok(files.length > 0, 'apps/dev/dist is built');
  assert.ok(files.some((f) => /markdown\.tmLanguage/i.test(path.basename(f))), 'a markdown grammar asset in apps/dev/dist');
  assert.ok(files.some((f) => /python\.tmLanguage|MagicPython\.tmLanguage/i.test(path.basename(f))), 'the Python grammar beside it (same bundling)');
});
