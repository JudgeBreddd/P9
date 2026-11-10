import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan, added } from '../scripts/no-local-paths.mjs';

// The strings are split with | so this file does not commit the places it tests for, nor trip the check it tests.
const h = s => s.replaceAll('|', '');
const cli = fileURLToPath(new URL('../scripts/no-local-paths.mjs', import.meta.url));
const run = (args, cwd, env = {}) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });

test('no-local-paths: flags the paths that reached PRs before', () => {
  for (const s of ['Report: _priv|ate/0.1.8/repo|rts/phase2-o4b-d1.md', '~|/p9-spr|int-v0.1.9-phase-2/engine/apps/server/mcp-relay.mjs',
    'saved in /tmp/cla|ude-1000/engine-check', 'see /ho|me/alice/repos/x', 'by someone@gm|ail.com', 'notes in ~|/scratch/a.md',
    'the hub at ~|/work|space/x', 'dev space: run 2026-11-10-11|3333', 'kept in ~|/.sec|rets/key',
    'a client folder ~|/work|/client-a/notes', 'a look-alike ~|/.cla|ude-notes/a.md', 'a look-alike ~|/.ss|h.old/key',
    'a look-alike ~|/p9-old/x', 'a look-alike ~|/wo|rk-files/x'])
    assert.equal(scan(h(s), 'body').length, 1, s);
});
test('no-local-paths: leaves product strings alone', () => {
  for (const s of ['C:\\\\Users\\\\one\\\\p9', '/p9/apps/server/mcp-relay.mjs', '`event-horizon/`', h('~|/.claude/settings.json'),
    h('bash ~|/p9/scripts/install.sh'), h('P9 workspace is ~|/work'), h('/ho|me/user/project'), 'Report: phase2-o51.md', 'Tests (dev space): 9/9'])
    assert.deepEqual(scan(s, 'body'), [], s);
  // The registry's own token is product code on an added line, never in a description or commit message.
  assert.deepEqual(scan(h("replaceAll('~|/work|space', root)"), 'a.mjs', { code: true }), []);
  assert.equal(scan(h('~|/work|space/IC|M/x'), 'a.mjs', { code: true }).length, 1);
  assert.equal(scan(h("'~|/work|space/a-private-project/notes'"), 'a.mjs', { code: true }).length, 1);
  assert.equal(scan(h("'~|/work|space-old/notes'"), 'a.mjs', { code: true }).length, 1);
  for (const s of ['~|/.local/share/p9', '~|/.ssh/config', '~|/.codex/auth.json', 'run it from ~|/...', '~|/.cla|ude.json', 'P9 workspace is ~|/work.', 'in ~|/.bash|rc, then']) assert.deepEqual(scan(h(s), 'body'), [], s);
});
test('no-local-paths: personal terms come from outside the file, any case', () => {
  assert.equal(scan('ssh to Box-One now', 'body', { terms: ['box-one'] })[0].why, 'a personal name');
});
test('no-local-paths: added lines keep their file and line number', () => {
  const d = '+++ b/a.mjs\n@@ -1,0 +7,2 @@\n+one\n+two\n';
  assert.deepEqual(added(d), [{ file: 'a.mjs', n: 7, text: 'one' }, { file: 'a.mjs', n: 8, text: 'two' }]);
});
test('no-local-paths: a path added in one commit and removed in the next is still found', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nlp-'));
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.org', ...a], { cwd: dir, encoding: 'utf8' });
  git('init', '-q'); writeFileSync(join(dir, 'a.txt'), 'one\n'); git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  writeFileSync(join(dir, 'a.txt'), h('one\nsee ~|/scratch/a.md\n')); git('commit', '-qam', 'add');
  writeFileSync(join(dir, 'a.txt'), 'one\n'); git('commit', '-qam', 'remove');
  const r = run(['--range', `${base}..HEAD`], dir, { NO_LOCAL_PATHS_TERMS: 'zz-none' });
  assert.equal(r.status, 1, r.stdout); assert.match(r.stdout, /a\.txt:2 \(added in \w+\): a home folder/);
});
test('no-local-paths: an empty terms list is said, and fails where the secret must exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nlp-')), body = join(dir, 'body.md');
  writeFileSync(body, 'Fixes the sidebar.\n');
  const quiet = run(['--body', body], dir);
  assert.equal(quiet.status, 0); assert.match(quiet.stdout, /Personal names: not checked/);
  const strict = run(['--body', body, '--require-terms'], dir);
  assert.equal(strict.status, 1); assert.match(strict.stdout, /should be there/);
  assert.equal(run(['--body', body, '--require-terms'], dir, { NO_LOCAL_PATHS_TERMS: 'zz-none' }).status, 0);
});
