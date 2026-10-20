import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, copyFile, readdir } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fixture, root } from './helpers.mjs';

test('real pre-commit hook rejects staged fake key and private path, including index-only leak', async () => {
  const { directory } = await fixture();
  const repo = path.join(directory, 'repo');
  const temporary = path.join(directory, 'index-copies');
  await mkdir(temporary);
  await mkdir(path.join(repo, 'scripts'), { recursive: true });
  await mkdir(path.join(repo, '.githooks'));
  await copyFile(path.join(root, 'scripts/scan.mjs'), path.join(repo, 'scripts/scan.mjs'));
  const { chmod } = await import('node:fs/promises');
  await copyFile(path.join(root, '.githooks/pre-commit'), path.join(repo, '.githooks/pre-commit'));
  await chmod(path.join(repo, '.githooks/pre-commit'), 0o755);
  const env = { ...process.env, TMPDIR: temporary };
  const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q'); git('config', 'user.name', 'P9 fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'core.hooksPath', '.githooks');
  await writeFile(path.join(repo, 'README.md'), 'fixture\n');
  git('add', '.'); git('commit', '-qm', 'fixture');
  assert.deepEqual(await readdir(temporary), [], 'successful scanner leaves no index copy');
  for (const value of ['const token = "gh' + 'p_' + randomBytes(20).toString('hex') + '";\n', '/ho' + 'me/private-user/work']) {
    await writeFile(path.join(repo, 'planted.txt'), value);
    git('add', 'planted.txt');
    await writeFile(path.join(repo, 'planted.txt'), 'clean working tree, dirty index');
    const result = spawnSync('git', ['commit', '-qm', 'must refuse'], { cwd: repo, env });
    assert.equal(result.status, 1, 'hook must inspect index rather than clean working copy');
    assert.deepEqual(await readdir(temporary), [], 'refused scanner leaves no secret copy');
  }
  console.log('PASS real pre-commit: fake key and private host path refused from staged index');
});
