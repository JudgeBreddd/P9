// Abandoned move uploads (item 6, threat model row 51, specs/move-progress-events.md check 5): the receiving daemon's sweep.
// The stream's own checks (1-3) and Cancel are in send-to-server.test.mjs, which has the two-daemon stage.
// createMove alone, on a throwaway folder: the sweep reads only the folder and row(), so no daemon is needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants, createReadStream } from 'node:fs';
import { link, mkdir, mkdtemp, open, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { ABANDONED, createMove } from '../apps/server/move.mjs';

const skip = process.platform === 'win32' ? 'mkfifo; the sweep is the same code on Windows' : false;

test('Move sweep: an abandoned upload older than 6 h goes; a young one, one being appended and a landed chat\'s stay', { skip, timeout: 60000 }, async (t) => {
  const ownership = await mkdtemp(path.join(os.tmpdir(), 'p9-sweep-'));
  t.after(() => rm(ownership, { recursive: true, force: true }));
  const moves = path.join(ownership, 'moves'), xfer = path.join(ownership, 'xfer');
  await mkdir(moves); await mkdir(xfer);
  const rows = new Map();
  const move = createMove({ db: null, workspace: ownership, ownership, row: (id) => rows.get(id), emit: () => {}, stopConversation: null, recovered: new Promise(() => {}) });
  const old = (Date.now() - ABANDONED - 60_000) / 1000, young = (Date.now() - ABANDONED + 3600_000) / 1000;
  const put = async (name, when, text = 'x') => { await writeFile(path.join(moves, name), text); await utimes(path.join(moves, name), when, when); };
  const [abandoned, fresh, appending, landed, moving, done, sending] = Array.from({ length: 7 }, () => randomUUID());
  await put('in-' + abandoned + '.transcript', old, 'x'.repeat(5000));
  await put('in-' + abandoned + '.events', old);
  await put('in-' + fresh + '.transcript', young);
  // A chat that landed here keeps its files to the land's own cleanup; the sender's staging of a chat still moving stays.
  rows.set(landed, { state: 'stopped' }); await put('in-' + landed + '.transcript', old);
  rows.set(moving, { state: 'moving' }); await put(moving + '.events', old);
  rows.set(done, { state: 'moved' }); await put(done + '.events', young);
  const staging = async (id, folderWhen, pieceWhen) => {
    const dir = path.join(xfer, 'in-' + id);
    await mkdir(dir); await writeFile(path.join(dir, '0'), 'x'.repeat(700)); await utimes(path.join(dir, '0'), pieceWhen, pieceWhen); await utimes(dir, folderWhen, folderWhen);
  };
  await staging(abandoned, old, old);
  // A file send still appending to its one piece: the folder is old, the piece is not.
  await staging(sending, old, young);
  await mkdir(path.join(xfer, 'in-' + fresh)); await utimes(path.join(xfer, 'in-' + fresh), young, young);
  // An upload being appended: its file is a FIFO, so the append waits until a reader opens it (the hard link lets the test
  // open one even if the sweep wrongly removed the name).
  const pipe = path.join(moves, 'in-' + appending + '.transcript'), spare = path.join(ownership, 'spare-pipe');
  execFileSync('mkfifo', [pipe]); await link(pipe, spare); await utimes(pipe, old, old);
  const taking = move.take(appending, { kind: 'transcript', offset: 0, data: Buffer.from('piece').toString('base64') });
  let left;
  const logged = [], error = console.error;
  try {
    console.error = (line) => logged.push(JSON.parse(line));
    try { await move.sweep(); } finally { console.error = error; }
    left = (await readdir(moves)).sort();
    // The pipe is drained after the check, so the held append ends either way.
    const drained = new Promise((resolve) => createReadStream(spare).on('data', () => {}).on('end', resolve));
    assert.equal((await taking).status, 200);
    await drained;
  } finally {
    // A failure above can leave the append or the drain waiting in open() on the pipe, and the file would never end (the
    // run's whole timeout). Opening it read-write without blocking wakes either side.
    await (await open(spare, constants.O_RDWR | constants.O_NONBLOCK)).close();
    await taking.catch(() => {});
  }
  assert.deepEqual(left, ['in-' + appending + '.transcript', 'in-' + fresh + '.transcript', 'in-' + landed + '.transcript', moving + '.events'].sort());
  assert.deepEqual((await readdir(xfer)).sort(), ['in-' + fresh, 'in-' + sending].sort());
  // Logged without paths: what kind and how many bytes.
  assert.deepEqual(logged.map(({ event, kind }) => [event, kind]).sort(), [['P9_MOVE_SWEPT', 'files'], ['P9_MOVE_SWEPT', 'staged'], ['P9_MOVE_SWEPT', 'upload'], ['P9_MOVE_SWEPT', 'upload']]);
  assert.ok(logged.some((l) => l.bytes === 5000));
  assert.ok(logged.some((l) => l.kind === 'files' && l.bytes === 700), 'a staging folder logs its pieces\' bytes');
  assert.ok(logged.every((l) => !JSON.stringify(l).includes(ownership)));
});
