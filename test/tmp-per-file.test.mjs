import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// O77: under with-tmp.mjs every test file process has its own temp folder, removed when the file ends, so a full run
// cannot fill a small /tmp. A child process keeps its parent's folder instead of making its own.
test('O77: this test file has its own TMPDIR, and a child process inherits it', () => {
  const dir = os.tmpdir();
  assert.match(path.basename(dir), /^p9-file-/, 'TMPDIR is not a per-file folder: ' + dir);
  assert.equal(process.env.P9_FILE_TMP, dir);
  assert.ok(existsSync(dir));
  const child = execFileSync(process.execPath, ['-e', 'process.stdout.write(require("os").tmpdir())'], { encoding: 'utf8' });
  assert.equal(child, dir);
});
