// O9 and H1 review: a folder under the 200,000-file limit is listed as before and no slower. The manifest of 40,000
// files is timed fresh (every file hashed) and cached (the daemon's hash cache), with the peak memory each call added.
// Prints one PERF line before it checks, so the same file measures main and the fix. Its own file, so its process
// memory is not the big-folder test's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createXfer } from '../apps/server/xfer.mjs';

// 40,000 files of 16 bytes, not a git folder: under the daemon's 50,000-entry hash cache, so the second call is all cached
// (16-byte files take 4 KiB each of the dev space's 1 GiB /tmp: 160 MiB).
const DIRS = 40, PER = 1000;
const MiB = 1024 ** 2;

// Time and peak RSS / heap above the start, sampled every 5 ms while the call runs.
async function measured(call) {
  globalThis.gc?.();
  const start = process.memoryUsage(); let rss = start.rss, heap = start.heapUsed;
  const timer = setInterval(() => { const m = process.memoryUsage(); rss = Math.max(rss, m.rss); heap = Math.max(heap, m.heapUsed); }, 5);
  const t0 = performance.now(), answer = await call(), ms = performance.now() - t0;
  clearInterval(timer);
  const m = process.memoryUsage(); rss = Math.max(rss, m.rss); heap = Math.max(heap, m.heapUsed);
  return { answer, ms, rss: (rss - start.rss) / MiB, heap: (heap - start.heapUsed) / MiB };
}

test('xfer under the limit: 40,000 files listed and hashed as before, timed fresh and cached', { timeout: 600000 }, async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'p9-xfer-under-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  for (let d = 0; d < DIRS; d++) {
    const dir = path.join(workspace, 'mid', 'd' + String(d).padStart(3, '0'));
    await mkdir(dir, { recursive: true });
    await Promise.all(Array.from({ length: PER }, (_, f) => writeFile(path.join(dir, 'f' + f), String(d * PER + f).padStart(16, '0'))));
  }
  const xfer = createXfer({ workspace, ownership: null, recovery: null });
  const fresh = await measured(() => xfer.manifest({ folder: 'mid' }));
  const cached = await measured(() => xfer.manifest({ folder: 'mid' }));
  const f = (n) => n.toFixed(1);
  console.log(`PERF xfer-under files=${DIRS * PER} fresh ms=${fresh.ms.toFixed(0)} rss+=${f(fresh.rss)}MiB heap+=${f(fresh.heap)}MiB`
    + ` cached ms=${cached.ms.toFixed(0)} rss+=${f(cached.rss)}MiB heap+=${f(cached.heap)}MiB listed=${fresh.answer.files.length}`);
  for (const { answer } of [fresh, cached]) {
    assert.equal(answer.status, 200);
    assert.equal(answer.truncated, false);
    assert.equal(answer.files.length, DIRS * PER);
  }
  assert.equal(fresh.answer.files[0].path, 'mid/d000/f0');
  // A boolean, not deepEqual: a failing deepEqual of 40,000 entries builds a huge diff.
  assert.ok(cached.answer.files.every((x, i) => x.sha256 === fresh.answer.files[i].sha256 && x.path === fresh.answer.files[i].path), 'the cached hashes are the fresh ones');
});
