// The watcher's resources (telemetry.mjs; _research/p9-learning-layer/plan.md phase 3): CPU and peak memory per live turn
// from the chat's systemd scope, 60 s samples, coverage gaps and self-measure rows in telemetry-samples.db. Every cgroup
// here is a fake directory of counter files (the dev space has no systemd user bus), and every expected value was worked
// out by hand, in the comments beside it, before the first run. The real kernel's per-fd memory.peak reset is checked
// outside the tests (the project's private notes, p9-learning-layer-phase3/memory-peak-check.out.txt).
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openLedger } from '../apps/server/ledger.mjs';
import { startTelemetry, SAMPLES_SCHEMA } from '../apps/server/telemetry.mjs';
import { bundleDaemon } from '../scripts/bundle-daemon.mjs';
import { daemon, http, authenticated, root } from './helpers.mjs';

const T = 1767000000000; // fixture clock
const A = 'aaaaaaaa-0000-4000-8000-000000000001', B = 'bbbbbbbb-0000-4000-8000-000000000002', D = 'dddddddd-0000-4000-8000-000000000004';
const E = 'eeeeeeee-0000-4000-8000-000000000005', F = 'ffffffff-0000-4000-8000-000000000006', G = 'cccccccc-0000-4000-8000-000000000007';

async function scratch(t, name) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-resources-' + name + '-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, ledgerFile: path.join(dir, 'p9.db'), file: path.join(dir, 'telemetry.db'), samplesFile: path.join(dir, 'telemetry-samples.db') };
}
// A fake cgroup tree: self (the daemon), p9.slice, and one directory per chat scope, laid out as under user@1000.service.
async function fakeCgroup(dir) {
  const self = path.join(dir, 'cgroup', 'self'), slice = path.join(dir, 'cgroup', 'p9.slice');
  await mkdir(self, { recursive: true });
  await mkdir(slice, { recursive: true });
  const cpu = (usec) => 'usage_usec ' + usec + '\nuser_usec ' + Math.floor(usec * 0.6) + '\nsystem_usec ' + (usec - Math.floor(usec * 0.6)) + '\n';
  await writeFile(path.join(self, 'cpu.stat'), cpu(5000000));
  await writeFile(path.join(self, 'memory.current'), '104857600\n');
  await writeFile(path.join(slice, 'cpu.stat'), cpu(9000000));
  await writeFile(path.join(slice, 'memory.current'), '2147483648\n');
  const dirOf = (unit) => path.join(slice, unit + '.scope');
  return {
    cgroup: { self, slice }, dirOf, cpu,
    async scope(unit, usec, peak) { await mkdir(dirOf(unit), { recursive: true }); await writeFile(path.join(dirOf(unit), 'cpu.stat'), cpu(usec)); await writeFile(path.join(dirOf(unit), 'memory.peak'), peak + '\n'); },
    setCpu: (unit, usec) => writeFile(path.join(dirOf(unit), 'cpu.stat'), cpu(usec)),
    // Into the same inode (truncate and write), as the kernel's counter changes under an open handle.
    setPeak: (unit, bytes) => writeFile(path.join(dirOf(unit), 'memory.peak'), bytes + '\n'),
  };
}
// A live event: into the ledger (for its cursor and for replay), then pushed as ledger.tap does.
function live(telemetry, ledger, conversation, type, data, at) {
  const cursor = Number(ledger.db.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)').run(conversation, type, JSON.stringify(data), at).lastInsertRowid);
  telemetry.push({ cursor, conversation, type, data, at });
  return cursor;
}
const read = (file, sql) => { const db = new DatabaseSync(file, { readOnly: true }); try { return db.prepare(sql).all().map((row) => ({ ...row })); } finally { db.close(); } };
const resources = (file) => read(file, 'SELECT * FROM resources ORDER BY turn_key');
const turns = (file) => read(file, 'SELECT key, outcome FROM turns ORDER BY key');
const end = { stopReason: 'end_turn' };
const row = (turn_key, start_at, end_at, cpu_usec, mem_peak_bytes, peak_basis, availability, reason, partial = 0) =>
  ({ turn_key, start_at, end_at, cpu_usec, mem_peak_bytes, peak_basis, availability, reason, partial });

test('exact values: a turn gets the hand-worked CPU and peak from a fake scope; missing files are NULL with a reason, never 0; replay fills nothing', { timeout: 60000 }, async (t) => {
  const { dir, ledgerFile, file, samplesFile } = await scratch(t, 'exact');
  const fake = await fakeCgroup(dir);
  const ledger = openLedger(ledgerFile);
  const units = { [A]: 'p9-chat-x-a', [D]: 'p9-chat-x-missing', [E]: 'p9-chat-x-denied', [F]: 'p9-chat-x-gone' };
  await fake.scope('p9-chat-x-a', 1000000, 4294967296); // the scope's peak so far is its 4 GiB MemoryMax, as on the server
  await fake.scope('p9-chat-x-denied', 7000000, 1000);
  await fake.scope('p9-chat-x-gone', 2000000, 1000);
  await chmod(path.join(fake.dirOf('p9-chat-x-denied'), 'cpu.stat'), 0o000);
  await chmod(path.join(fake.dirOf('p9-chat-x-denied'), 'memory.peak'), 0o000);
  const telemetry = startTelemetry({ ledgerFile, file, samplesFile, cgroup: fake.cgroup, scopeOf: (c) => units[c] ?? null, sampleMs: 0, clockMs: T });
  t.after(() => telemetry.close());
  // Cursors 1-6: every turn opens; B has no scope; G's scope is launched inside its turn (a conversation's first prompt).
  for (const [i, c] of [A, B, D, E, F, G].entries()) live(telemetry, ledger, c, 'user', { text: 'go' }, T + 1000 + i * 100);
  await telemetry.idle();
  const peakFile = path.join(fake.dirOf('p9-chat-x-a'), 'memory.peak');
  assert.match(await readFile(peakFile, 'utf8'), /^reset\n/, 'turn start wrote the reset through the kept handle');
  // During the turns: A uses 3,500,000 - 1,000,000 = 2,500,000 us and peaks at 700 MiB = 734,003,200 bytes. Then another
  // file (999) is renamed over A's memory.peak path: only a read through the handle kept from the start still sees 734003200.
  await fake.setCpu('p9-chat-x-a', 3500000);
  await fake.setPeak('p9-chat-x-a', 734003200);
  await writeFile(peakFile + '.other', '999\n');
  await rename(peakFile + '.other', peakFile);
  // F peaks at 512 MiB = 536,870,912, then its scope is removed before the turn ends: CPU gone, the peak still read.
  await fake.setPeak('p9-chat-x-gone', 536870912);
  await rm(fake.dirOf('p9-chat-x-gone'), { recursive: true });
  // G is born: 4,200,000 us and a 298 MiB = 312,475,648 byte peak, all inside the turn.
  await fake.scope('p9-chat-x-born', 4200000, 312475648);
  units[G] = 'p9-chat-x-born';
  for (const [i, c] of [A, B, D, E, F, G].entries()) live(telemetry, ledger, c, 'turn-end', end, T + 9000 + i * 100); // cursors 7-12
  await telemetry.idle();
  const denied = process.getuid?.() === 0 ? null : 'permission-denied'; // root reads a 000 file; the dev space runs as node
  const expected = [
    row(1, T + 1000, T + 9000, 2500000, 734003200, 'turn', 'measured', null),
    row(2, T + 1100, T + 9100, null, null, null, 'unavailable', 'no-scope'),
    row(3, T + 1200, T + 9200, null, null, null, 'unavailable', 'scope-missing'),
    row(4, T + 1300, T + 9300, null, null, null, 'unavailable', denied),
    row(5, T + 1400, T + 9400, null, 536870912, 'turn', 'peak-only', 'scope-gone'),
    row(6, T + 1500, T + 9500, 4200000, 312475648, 'turn', 'measured', null),
  ];
  const skip = (list) => (denied ? list : list.filter((_, i) => i !== 3));
  assert.deepEqual(skip(resources(samplesFile)), skip(expected), JSON.stringify(telemetry.stats()));
  assert.equal(telemetry.stats().measuring, 0);
  assert.equal(telemetry.stats().ignoredResources, 0, 'no row refused by the CHECKs');
  await telemetry.close();

  // No cgroup at all (Windows, macOS): every turn is unavailable with that reason.
  const other = await scratch(t, 'exact-none');
  const ledger2 = openLedger(other.ledgerFile);
  const none = startTelemetry({ ...other, cgroup: { reason: 'not-linux' }, scopeOf: () => 'p9-chat-x-a', sampleMs: 0, clockMs: T });
  t.after(() => none.close());
  live(none, ledger2, A, 'user', { text: 'go' }, T + 1000);
  live(none, ledger2, A, 'turn-end', end, T + 2000);
  await none.idle();
  assert.deepEqual(resources(other.samplesFile), [row(1, T + 1000, T + 2000, null, null, null, 'unavailable', 'not-linux')]);
  await none.close();

  // Replay: the same ledger into a new telemetry.db and samples file, fake cgroup and scopes still there: 6 turns, 0 resources.
  const replay = startTelemetry({ ledgerFile, file: path.join(dir, 'replay.db'), samplesFile: path.join(dir, 'replay-samples.db'), cgroup: fake.cgroup,
    scopeOf: (c) => units[c] ?? null, sampleMs: 0, clockMs: T });
  await replay.idle();
  await replay.close();
  assert.equal(turns(path.join(dir, 'replay.db')).length, 6);
  assert.deepEqual(resources(path.join(dir, 'replay-samples.db')), []);
  console.log('PASS exact: A 2500000 us / 734003200 B through the kept handle; no-scope, scope-missing, ' + (denied ?? 'permission (skipped as root)')
    + ', scope-gone (peak-only), born-in-turn 4200000 us / 312475648 B; not-linux unavailable; replay 6 turns, 0 resource rows');
});

test('coverage: samples more than 3 minutes apart leave a gap row, and turns overlapping it are marked partial', { timeout: 60000 }, async (t) => {
  const { dir, ledgerFile, file, samplesFile } = await scratch(t, 'coverage');
  const fake = await fakeCgroup(dir);
  const ledger = openLedger(ledgerFile);
  const options = { ledgerFile, file, samplesFile, cgroup: fake.cgroup, scopeOf: () => null, sampleMs: 0 };
  const first = startTelemetry({ ...options, clockMs: T }); // sample 1 at T
  t.after(() => first.close());
  live(first, ledger, A, 'user', { text: 'w' }, T + 60000); // W, cursor 1: T+1 min to T+2 min
  live(first, ledger, A, 'turn-end', end, T + 120000);
  live(first, ledger, B, 'user', { text: 'x' }, T + 150000); // X, cursor 3: T+2.5 min to T+4 min
  live(first, ledger, B, 'turn-end', end, T + 240000);
  await first.idle();
  first.tick(T + 180000); // exactly 3 min after T: not more than 3 min, no gap
  first.tick(T + 600000); // 7 min after T+3 min: gap (T+180000, T+600000); X overlaps it (240000 > 180000), W does not (120000)
  await first.idle();
  live(first, ledger, D, 'user', { text: 'y' }, T + 590000); // Y, cursor 5: written after the gap, overlaps it (590000 < 600000)
  live(first, ledger, D, 'turn-end', end, T + 650000);
  await first.idle();
  await first.close();
  // A restart 10 min after the last sample: its start sample finds gap (T+600000, T+1200000). Y ends at T+650000: inside.
  const second = startTelemetry({ ...options, clockMs: T + 1200000 });
  t.after(() => second.close());
  live(second, ledger, E, 'user', { text: 'z' }, T + 1260000); // Z, cursor 7: after both gaps
  live(second, ledger, E, 'turn-end', end, T + 1320000);
  await second.idle(); // the start sample is taken (the worker answers only after it) before the slice file changes
  await writeFile(path.join(fake.cgroup.slice, 'cpu.stat'), fake.cpu(9600000)); // the slice's CPU moves before the last sample: read at the tick
  second.tick(T + 1380000); // 3 min after T+1200000: no gap
  await second.idle();
  const ledgerBytes = statSync(ledgerFile).size + (existsSync(ledgerFile + '-wal') ? statSync(ledgerFile + '-wal').size : 0);
  await second.close();

  assert.deepEqual(read(samplesFile, 'SELECT * FROM gaps ORDER BY start_at'), [{ start_at: T + 180000, end_at: T + 600000 }, { start_at: T + 600000, end_at: T + 1200000 }]);
  assert.deepEqual(resources(samplesFile).map((r) => [r.turn_key, r.partial]), [[1, 0], [3, 1], [5, 1], [7, 0]]);
  const samples = read(samplesFile, 'SELECT * FROM samples ORDER BY at');
  assert.deepEqual(samples.map((s) => s.at), [T, T + 180000, T + 600000, T + 1200000, T + 1380000]);
  for (const [i, s] of samples.entries()) {
    assert.deepEqual([s.daemon_cpu_usec, s.daemon_mem_bytes, s.slice_cpu_usec, s.slice_mem_bytes], [5000000, 104857600, i === 4 ? 9600000 : 9000000, 2147483648], 'sample ' + i);
    // The first sample is taken before the replay creates telemetry.db: no file is NULL, not 0.
    if (i === 0) assert.equal(s.telemetry_bytes, null);
    else assert.ok(Number.isSafeInteger(s.telemetry_bytes) && s.telemetry_bytes > 0, 'telemetry.db size ' + s.telemetry_bytes);
  }
  assert.equal(samples[4].ledger_bytes, ledgerBytes, 'ledger file plus WAL, exact');
  const self = read(samplesFile, 'SELECT * FROM self ORDER BY end_at');
  assert.deepEqual(self.map((s) => [s.start_at, s.end_at]), [[T, T], [T, T + 180000], [T + 180000, T + 600000], [T + 1200000, T + 1200000], [T + 1200000, T + 1380000]]);
  for (const s of self) assert.ok(Number.isSafeInteger(s.worker_cpu_usec) && s.worker_cpu_usec >= 0 && Number.isSafeInteger(s.main_usec) && s.main_usec >= 0, JSON.stringify(s));
  assert.ok(self[1].worker_cpu_usec > 0 && self[1].main_usec > 0, 'the replay and the pushes cost something: ' + JSON.stringify(self[1]));
  console.log('PASS coverage: gaps ' + JSON.stringify(read(samplesFile, 'SELECT start_at - ' + T + ' AS s, end_at - ' + T + ' AS e FROM gaps'))
    + '; partial W 0, X 1 (marked by the gap), Y 1 (written after it), Z 0; 5 samples exact; self rows ' + JSON.stringify(self.map((s) => [s.worker_cpu_usec, s.main_usec])));
});

test('rebuild and damage: rebuilding telemetry.db leaves telemetry-samples.db untouched; a damaged samples file is renamed aside and a new one starts', { timeout: 60000 }, async (t) => {
  const { dir, ledgerFile, file, samplesFile } = await scratch(t, 'rebuild');
  const fake = await fakeCgroup(dir);
  const ledger = openLedger(ledgerFile);
  await fake.scope('p9-chat-x-a', 1000000, 4294967296);
  const options = { ledgerFile, file, samplesFile, cgroup: fake.cgroup, scopeOf: (c) => (c === A ? 'p9-chat-x-a' : null), sampleMs: 0 };
  const first = startTelemetry({ ...options, clockMs: T });
  t.after(() => first.close());
  live(first, ledger, A, 'user', { text: 'go' }, T + 1000); // cursor 1
  await first.idle();
  await fake.setCpu('p9-chat-x-a', 3500000);
  await fake.setPeak('p9-chat-x-a', 734003200);
  live(first, ledger, A, 'turn-end', end, T + 9000);
  await first.idle();
  await first.close();
  const before = { ino: (await stat(samplesFile)).ino, resources: resources(samplesFile) };
  assert.deepEqual(before.resources, [row(1, T + 1000, T + 9000, 2500000, 734003200, 'turn', 'measured', null)]);

  // telemetry.db damaged: set aside and rebuilt from the ledger; the samples file keeps its inode and its rows.
  const garbage = Buffer.from('this is not a database. '.repeat(400));
  for (const suffix of ['-wal', '-shm']) await rm(file + suffix, { force: true }); // a damaged main file alone: a WAL could still hold page 1
  await writeFile(file, garbage);
  const second = startTelemetry({ ...options, clockMs: T + 60000 });
  t.after(() => second.close());
  await second.idle();
  const rebuilt = second.stats();
  await second.close();
  assert.equal(rebuilt.setAside.length, 1, JSON.stringify(rebuilt));
  assert.deepEqual(await readFile(rebuilt.setAside[0]), garbage, 'the damaged telemetry.db is kept as it was');
  assert.deepEqual(rebuilt.samplesSetAside, []);
  assert.deepEqual(turns(file), [{ key: 1, outcome: 'finished' }]);
  assert.equal((await stat(samplesFile)).ino, before.ino, 'same samples file');
  assert.deepEqual(resources(samplesFile), before.resources);
  const joined = new DatabaseSync(file, { readOnly: true });
  joined.exec("ATTACH DATABASE '" + samplesFile.replaceAll("'", "''") + "' AS s");
  assert.deepEqual(joined.prepare('SELECT t.key, t.outcome, r.cpu_usec, r.mem_peak_bytes FROM turns t JOIN s.resources r ON r.turn_key = t.key').all().map((r) => ({ ...r })),
    [{ key: 1, outcome: 'finished', cpu_usec: 2500000, mem_peak_bytes: 734003200 }]);
  joined.close();

  // telemetry-samples.db damaged: renamed aside byte for byte (with any -wal and -shm), a new file at SAMPLES_SCHEMA starts.
  const samplesGarbage = Buffer.from('not samples either. '.repeat(300));
  for (const suffix of ['-wal', '-shm']) await rm(samplesFile + suffix, { force: true });
  await writeFile(samplesFile, samplesGarbage);
  const third = startTelemetry({ ...options, clockMs: T + 120000 });
  t.after(() => third.close());
  await fake.scope('p9-chat-x-a', 5000000, 1000);
  live(third, ledger, A, 'user', { text: 'again' }, T + 130000); // cursor 3
  await third.idle();
  await fake.setCpu('p9-chat-x-a', 5250000); // 250,000 us
  await fake.setPeak('p9-chat-x-a', 104857600); // 100 MiB
  live(third, ledger, A, 'turn-end', end, T + 140000);
  await third.idle();
  const fresh = third.stats();
  await third.close();
  assert.equal(fresh.samplesSetAside.length, 1, JSON.stringify(fresh));
  assert.match(path.basename(fresh.samplesSetAside[0]), /^telemetry-samples\.db\.set-aside-\d{13}(-\d+)?$/);
  assert.deepEqual(await readFile(fresh.samplesSetAside[0]), samplesGarbage, 'the damaged samples file is kept as it was');
  assert.deepEqual(fresh.setAside, [], 'telemetry.db is left alone');
  assert.equal(read(samplesFile, 'PRAGMA user_version')[0].user_version, SAMPLES_SCHEMA);
  assert.deepEqual(read(samplesFile, 'SELECT at FROM samples'), [{ at: T + 120000 }]);
  assert.deepEqual(resources(samplesFile), [row(3, T + 130000, T + 140000, 250000, 104857600, 'turn', 'measured', null)], 'the old turn is not refilled: replay never measures');
  assert.ok((await readdir(dir)).includes(path.basename(fresh.samplesSetAside[0])));
  console.log('PASS rebuild: telemetry.db set aside and rebuilt (1 turn), samples inode ' + before.ino + ' unchanged, join on turn_key works; damaged samples renamed to '
    + path.basename(fresh.samplesSetAside[0]) + ', new file user_version ' + SAMPLES_SCHEMA + ' with 1 sample, 1 resource row');
});

test('attribution: two chats at once, each with its own fake scope, get only their own CPU and peak', { timeout: 60000 }, async (t) => {
  const { dir, ledgerFile, file, samplesFile } = await scratch(t, 'attribution');
  const fake = await fakeCgroup(dir);
  const ledger = openLedger(ledgerFile);
  await fake.scope('p9-chat-x-a', 1000000, 4294967296);
  await fake.scope('p9-chat-x-b', 20000000, 1073741824);
  const units = { [A]: 'p9-chat-x-a', [B]: 'p9-chat-x-b' };
  const telemetry = startTelemetry({ ledgerFile, file, samplesFile, cgroup: fake.cgroup, scopeOf: (c) => units[c] ?? null, sampleMs: 0, clockMs: T });
  t.after(() => telemetry.close());
  live(telemetry, ledger, A, 'user', { text: 'build it' }, T + 1000); // cursor 1
  live(telemetry, ledger, B, 'user', { text: 'test it' }, T + 1500); // cursor 2: both turns open at once
  await telemetry.idle();
  // Both work: B to 20,750,000 us (750,000 used) and a 256 MiB = 268,435,456 peak; A to 2,200,000 and 500,000,000 so far.
  await fake.setCpu('p9-chat-x-b', 20750000);
  await fake.setPeak('p9-chat-x-b', 268435456);
  await fake.setCpu('p9-chat-x-a', 2200000);
  await fake.setPeak('p9-chat-x-a', 500000000);
  live(telemetry, ledger, B, 'turn-end', end, T + 5000); // cursor 3: B ends while A still runs
  await telemetry.idle();
  // A's build (a tool inside A's scope) runs on: A to 3,500,000 us (2,500,000 used) and 700 MiB = 734,003,200 peak. B's
  // scope moves too after its turn ended (8,250,000 more us): that belongs to no turn.
  await fake.setCpu('p9-chat-x-a', 3500000);
  await fake.setPeak('p9-chat-x-a', 734003200);
  await fake.setCpu('p9-chat-x-b', 29000000);
  live(telemetry, ledger, A, 'turn-end', end, T + 9000); // cursor 4
  await telemetry.idle();
  assert.deepEqual(resources(samplesFile), [
    row(1, T + 1000, T + 9000, 2500000, 734003200, 'turn', 'measured', null),
    row(2, T + 1500, T + 5000, 750000, 268435456, 'turn', 'measured', null),
  ], JSON.stringify(telemetry.stats()));
  console.log('PASS attribution: A 2500000 us / 734003200 B, B 750000 us / 268435456 B, measured at the same time in their own scopes');
});

// Extra (not a plan row): the daemon as bundle-daemon.mjs lays it out for an installer starts the writer, and one turn makes
// rows in both files. The dev space has no user bus, so the resource row is unavailable with the cgroup's reason.
test('bundled daemon: telemetry.db and telemetry-samples.db are created with rows from a fixture turn', { timeout: 180000 }, async (t) => {
  const out = await mkdtemp(path.join(os.tmpdir(), 'p9-resources-bundle-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  await bundleDaemon(root, out, null);
  assert.ok(existsSync(path.join(out, 'apps', 'server', 'telemetry.mjs')), 'telemetry.mjs beside the bundled main.mjs');
  const fake = path.join(root, 'test/fake-acp-agent.mjs');
  const instance = await daemon(t, path.join(out, 'apps', 'server', 'main.mjs'), false, async () => ({ args: ['--acp-override', fake] }));
  const call = (route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
    headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const home = path.join(instance.directory, '.local', 'state', 'p9-foundation');
  const conversation = JSON.parse((await call('/chat', 'POST', { provider: 'claude' })).text).conversation;
  assert.equal((await call('/chat/' + conversation + '/prompt', 'POST', { text: 'hello' })).status, 202);
  const counts = () => {
    const turnsFile = path.join(home, 'telemetry.db'), samplesFile = path.join(home, 'telemetry-samples.db');
    if (!existsSync(turnsFile) || !existsSync(samplesFile)) return null;
    try { return { turns: read(turnsFile, 'SELECT * FROM turns'), resources: resources(samplesFile), samples: read(samplesFile, 'SELECT * FROM samples') }; } catch { return null; }
  };
  let found = null;
  for (let i = 0; i < 150 && !(found?.turns.length && found.resources.length && found.samples.length); i++) { found = counts(); await new Promise((resolve) => setTimeout(resolve, 100)); }
  assert.ok(found, 'both files exist: ' + (existsSync(home) ? (await readdir(home)).join(',') : 'no ' + home));
  assert.equal(found.turns.length, 1, JSON.stringify(found.turns));
  assert.equal(found.resources.length, 1);
  assert.equal(found.resources[0].turn_key, found.turns[0].key);
  assert.ok(found.samples.length >= 1);
  const resource = found.resources[0];
  if (resource.availability !== 'measured') assert.ok(resource.reason, 'a reason with every unavailable row');
  console.log('PASS bundle: bundled main.mjs wrote ' + found.turns.length + ' turn, ' + found.resources.length + ' resource row ('
    + resource.availability + ', ' + resource.reason + '), ' + found.samples.length + ' sample(s); sample 1 ' + JSON.stringify(found.samples[0]));
});
