// O9 and H1 (OPEN-ITEMS-0.1.9 phase 4): Send to remote into a folder past the 200,000-file limit is refused early. The
// manifest of a 300,000-file folder answers truncated without hashing a file, and the walk stops past the limit.
// Prints one PERF line (time to the answer) before it checks, so the same file measures main and the fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createXfer, MAX_COUNT } from '../apps/server/xfer.mjs';

// 300,000 empty files, not a git folder: the dev space's /tmp is a 1 GiB tmpfs, and hashing still opens and reads each one.
const DIRS = 300, PER = 1000;

test('xfer big folder: a folder past the file limit is refused early, nothing hashed', { timeout: 600000 }, async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'p9-xfer-big-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  for (let d = 0; d < DIRS; d++) {
    const dir = path.join(workspace, 'big', 'd' + String(d).padStart(3, '0'));
    await mkdir(dir, { recursive: true });
    await Promise.all(Array.from({ length: PER }, (_, f) => writeFile(path.join(dir, 'f' + f), '')));
  }
  const xfer = createXfer({ workspace, ownership: null, recovery: null });
  const t0 = performance.now(), answer = await xfer.manifest({ folder: 'big' }), ms = performance.now() - t0;
  console.log(`PERF xfer-big files=${DIRS * PER} limit=${MAX_COUNT} ms=${ms.toFixed(0)} truncated=${answer.truncated} listed=${answer.files?.length}`);
  assert.equal(answer.status, 200);
  assert.equal(answer.truncated, true);
  // The count, not deepEqual: a failing deepEqual of 200,000 entries builds a diff that ran the dev space out of memory.
  assert.equal(answer.files.length, 0, 'a manifest past the limit hashes and lists nothing: the send is refused anyway');
});
