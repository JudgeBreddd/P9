// D13: the window says what an update brought: which start is an update (updatedFrom), and the list matches the version.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { updatedFrom } from '../apps/desktop/whats-new.mjs';
import { WHATS_NEW } from '../apps/web/src/whats-new.mjs';
import { root } from './helpers.mjs';

test('D13: an update is a newer version than the profile last ran; a fresh profile, the same version or a rollback is not', { timeout: 10000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'p9-news-'));
  t.after(() => rm(profile, { recursive: true, force: true }));
  assert.equal(updatedFrom(profile, '0.1.6'), null, 'fresh profile');
  assert.equal(await readFile(path.join(profile, 'p9-version.txt'), 'utf8'), '0.1.6');
  assert.equal(updatedFrom(profile, '0.1.6'), null, 'same version');
  assert.equal(updatedFrom(profile, '0.1.7'), '0.1.6', 'update');
  assert.equal(updatedFrom(profile, '0.1.6'), null, 'rollback');
  // Before 0.1.6 nothing wrote p9-version.txt: a profile with a desktop's files and no version file was updated.
  await rm(path.join(profile, 'p9-version.txt'));
  await writeFile(path.join(profile, 'update-state.json'), '{}');
  assert.equal(updatedFrom(profile, '0.1.6'), '');
});

test('D13: the list is for the version in package.json, one short line per change', { timeout: 10000 }, async () => {
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(WHATS_NEW.version, version, 'apps/web/src/whats-new.mjs is for another version: update its list for this release');
  assert.ok(WHATS_NEW.changes.length > 0);
  for (const line of WHATS_NEW.changes) assert.ok(!line.includes('\n') && line.length <= 120, line);
});
