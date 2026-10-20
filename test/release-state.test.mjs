// Phase 13: state backed up before a migration, an interrupted migration recovered from that backup, a newer schema
// refused, rollback restoring the backup, and an uninstall that touches only P9's own unit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { MIGRATIONS, SCHEMA, openLedger } from '../apps/server/ledger.mjs';

const app = fileURLToPath(new URL('..', import.meta.url));
// What a later build would ship: one more step on top of this build's list.
const NEXT = [...MIGRATIONS, 'ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;'];
const read = (file, sql) => { const db = new DatabaseSync(file); try { return db.prepare(sql).get(); } finally { db.close(); } };
const version = (file) => read(file, 'PRAGMA user_version').user_version;
const events = (file) => read(file, 'SELECT COUNT(*) AS n FROM events').n;
const open = (file, options) => openLedger(file, options).db.close();

// A ledger as every pre-release build left it: the same tables, user_version 0, one chat event.
function preRelease() {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'p9-state-')), 'p9.db');
  const db = new DatabaseSync(file);
  db.exec(MIGRATIONS[0]);
  db.prepare("INSERT INTO events (conversation, type, data, at) VALUES ('c1', 'message', '{\"text\":\"hello\"}', 1)").run();
  db.close();
  return file;
}

test('Phase 13: backup before migration, interrupted migration recovered, newer schema refused, rollback', () => {
  const fresh = path.join(mkdtempSync(path.join(os.tmpdir(), 'p9-state-')), 'p9.db');
  open(fresh);
  assert.deepEqual(readdirSync(path.dirname(fresh)).filter((name) => name.includes('.bak')), [], 'a new, empty ledger needs no backup');

  const file = preRelease();
  open(file);
  assert.equal(version(file), SCHEMA);
  assert.equal(version(file + '.v0.bak'), 0);
  assert.equal(events(file + '.v0.bak'), 1);
  assert.ok(!existsSync(file + '.migrating'));
  console.log('PASS pre-release ledger copied to p9.db.v0.bak (schema 0, its chat event) before migrating to schema ' + SCHEMA);

  // A later build dies part way through its migration, after the step and before the commit; the file is then torn.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    'const m = await import(process.env.LEDGER); m.openLedger(process.env.FILE, { steps: JSON.parse(process.env.STEPS), crashAfter: ' + SCHEMA + ' });'],
  { env: { ...process.env, LEDGER: new URL('../apps/server/ledger.mjs', import.meta.url).href, FILE: file, STEPS: JSON.stringify(NEXT) } });
  assert.equal(child.status, 70, String(child.stderr));
  assert.equal(readFileSync(file + '.migrating', 'utf8'), file + '.v' + SCHEMA + '.bak');
  writeFileSync(file, 'torn');
  open(file, { steps: NEXT });
  assert.equal(version(file), SCHEMA + 1);
  assert.equal(events(file), 1, 'the chat event survived');
  assert.equal(read(file, 'SELECT pinned FROM conversations LIMIT 1'), undefined);
  assert.ok(!existsSync(file + '.migrating'));
  console.log(`PASS interrupted migration (exit 70 mid-step, file then torn) restored from p9.db.v${SCHEMA}.bak and re-run: schema ${SCHEMA + 1}, chat event kept`);

  // This build (schema SCHEMA) meets the SCHEMA + 1 file: refused, and the file is not changed.
  const before = readFileSync(file);
  assert.throws(() => open(file), new RegExp(`state-schema-newer: .* is schema ${SCHEMA + 1}; this build reads up to ${SCHEMA}`));
  assert.deepEqual(readFileSync(file), before);
  console.log(`PASS a schema ${SCHEMA + 1} ledger is refused by a schema ${SCHEMA} build, bytes unchanged`);

  // A build two migrations ahead also left a v<SCHEMA + 1> backup; this build cannot open it, so it is passed over (R1-8).
  copyFileSync(file, file + '.v' + (SCHEMA + 1) + '.bak');
  // Release r2 R2-2: a phone revoked after the backup was taken stays revoked, and no session survives the rollback.
  const devices = 'CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, device TEXT NOT NULL);';
  const exec = (target, sql) => { const db = new DatabaseSync(target); try { db.exec(sql); } finally { db.close(); } };
  exec(file + '.v' + SCHEMA + '.bak', devices + " INSERT INTO devices VALUES ('lost', 'active'), ('other', 'active'); INSERT INTO sessions VALUES ('h', 'lost');");
  exec(file, devices + " INSERT INTO devices VALUES ('lost', 'revoked'), ('other', 'active');");
  // R2-4: a marker a dead migration left behind, naming the newer backup, must not undo the rollback at the next start.
  writeFileSync(file + '.migrating', file + '.v' + (SCHEMA + 1) + '.bak');
  // Rollback through the script: the v<SCHEMA> backup comes back, the newer file is kept beside it, this build opens it.
  const out = execFileSync(process.execPath, ['scripts/rollback.mjs', '--state-home', path.dirname(file)], { cwd: app, encoding: 'utf8' });
  assert.match(out, new RegExp(`P9_ROLLED_BACK from .*p9\\.db\\.v${SCHEMA}\\.bak`));
  assert.equal(version(file), SCHEMA);
  assert.equal(events(file), 1);
  const kept = readdirSync(path.dirname(file)).find((name) => name.startsWith('p9.db.rolled-back-') && !/-(wal|shm)$/.test(name));
  assert.equal(version(path.join(path.dirname(file), kept)), SCHEMA + 1);
  open(file);
  console.log(`PASS rollback script restored the schema ${SCHEMA} backup; the schema ${SCHEMA + 1} file kept as ${kept}; this build opens the result`);
  assert.equal(read(file, "SELECT state FROM devices WHERE id = 'lost'").state, 'revoked', 'a revoked phone stays revoked (R2-2)');
  assert.equal(read(file, "SELECT state FROM devices WHERE id = 'other'").state, 'active');
  assert.equal(read(file, 'SELECT COUNT(*) AS n FROM sessions').n, 0, 'no session survives a rollback');
  assert.ok(!existsSync(file + '.migrating') && !existsSync(file + '.restoring'), 'no marker or staged copy left (R2-4)');
  // This build already opens the result: a second rollback is refused and changes nothing (R2-2).
  const bytes = readFileSync(file);
  const again = spawnSync(process.execPath, ['scripts/rollback.mjs', '--state-home', path.dirname(file)], { cwd: app, encoding: 'utf8' });
  assert.equal(again.status, 1, again.stderr);
  assert.match(again.stderr, /state-current: .* is schema \d+; this build opens it/);
  assert.deepEqual(readFileSync(file), bytes);
  console.log('PASS R2-2/R2-4: revoked phone still revoked, sessions dropped, stale marker cleared, second rollback refused state-current');
});

const systemd = process.platform === 'linux' && spawnSync('systemctl', ['--user', 'is-system-running']).status !== null;
test('Phase 13: uninstall removes only the named P9 unit; other apps and P9 state stay', { skip: !systemd && 'no user systemd' }, () => {
  const units = path.join(os.homedir(), '.config', 'systemd', 'user'), unit = 'p9-uninstall-test.service';
  const projects = path.resolve(app, '../..');
  const snapshot = () => ['agent-first-workspace', 'workspace-hub'].filter((name) => existsSync(path.join(projects, name)))
    .map((name) => readdirSync(path.join(projects, name)).map((entry) => name + '/' + entry + ' ' + statSync(path.join(projects, name, entry)).mtimeMs).sort().join('\n'));
  const enabled = () => spawnSync('systemctl', ['--user', 'is-enabled', 'p9-foundation.service'], { encoding: 'utf8' }).stdout.trim();
  const hub = () => spawnSync('pgrep', ['-f', 'workspace-hub/mission_control.py']).status === 0;
  writeFileSync(path.join(units, unit), '[Service]\nExecStart=/bin/sleep 300\n');
  mkdirSync(path.join(units, unit + '.d'), { recursive: true });
  writeFileSync(path.join(units, unit + '.d', 'override.conf'), '[Service]\nEnvironment=P9_TEST=1\n');
  execFileSync('systemctl', ['--user', 'daemon-reload']);
  execFileSync('systemctl', ['--user', 'start', unit]);
  const [files, foundation, hubUp] = [snapshot(), enabled(), hub()];

  assert.throws(() => execFileSync(process.execPath, ['scripts/uninstall-service.mjs', '--unit', 'workspace-hub.service'], { cwd: app, stdio: 'pipe' }), /p9-unit-required/);
  // A stop that fails keeps the unit, so what still runs can be stopped (release r1 R1-6): a systemctl whose disable fails.
  const fakeBin = mkdtempSync(path.join(os.tmpdir(), 'p9-systemctl-'));
  writeFileSync(path.join(fakeBin, 'systemctl'), '#!/bin/sh\ncase "$*" in *disable*) exit 1;; esac\nexec /usr/bin/systemctl "$@"\n', { mode: 0o755 });
  const kept = spawnSync(process.execPath, ['scripts/uninstall-service.mjs', '--unit', unit], { cwd: app, encoding: 'utf8',
    env: { ...process.env, PATH: fakeBin + path.delimiter + process.env.PATH } });
  assert.equal(kept.status, 1); assert.match(kept.stdout, /P9_SERVICE_KEPT/);
  assert.ok(existsSync(path.join(units, unit)) && existsSync(path.join(units, unit + '.d')));
  const out = execFileSync(process.execPath, ['scripts/uninstall-service.mjs', '--unit', unit], { cwd: app, encoding: 'utf8' });
  assert.match(out, /P9_SERVICE_REMOVED p9-uninstall-test\.service/);
  assert.doesNotMatch(out, /P9_STOP_ALL/, 'Stop All is only for the real p9-foundation unit, never another daemon');
  assert.ok(!existsSync(path.join(units, unit)) && !existsSync(path.join(units, unit + '.d')));
  assert.notEqual(spawnSync('systemctl', ['--user', 'is-active', unit], { encoding: 'utf8' }).stdout.trim(), 'active');
  assert.deepEqual(snapshot(), files, 'agent-first-workspace and workspace-hub folders untouched');
  assert.equal(enabled(), foundation);
  assert.equal(hub(), hubUp);
  console.log('PASS uninstall refused a non-P9 unit, removed ' + unit + ' and its drop-in, stopped it; agent-first-workspace and workspace-hub untouched'
    + (hubUp ? ', Mission Control still running' : ''));
});

// Release r2 R2-3: a conversation left cleanup-failed by a startup scope query that failed is in no in-memory map;
// Stop All must still query systemd for it and report cleanup-failed, never stopped.
test('release r2 R2-3: Stop All sweeps a conversation still cleanup-failed from startup', { skip: process.platform !== 'linux' && 'linux only' }, async (t) => {
  const { createChat } = await import('../apps/server/chat.mjs');
  const { createLifecycle } = await import('../apps/server/lifecycle.mjs');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'p9-stopall-')), bin = path.join(dir, 'bin'), runtime = path.join(dir, 'runtime');
  mkdirSync(bin); mkdirSync(runtime, { mode: 0o700 }); writeFileSync(path.join(runtime, 'bus'), '');
  writeFileSync(path.join(bin, 'systemctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });  // a user bus that does not answer
  const saved = { PATH: process.env.PATH, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR };
  process.env.PATH = bin + ':' + process.env.PATH; process.env.XDG_RUNTIME_DIR = runtime;
  t.after(() => { process.env.PATH = saved.PATH; process.env.XDG_RUNTIME_DIR = saved.XDG_RUNTIME_DIR; });
  const ledger = openLedger(path.join(dir, 'p9.db'));
  // What a daemon killed mid-chat leaves: a running row and, maybe, its scope.
  ledger.db.prepare("INSERT INTO conversations (id, provider, title, session, state, created) VALUES ('c1', 'claude', 't', NULL, 'running', 1)").run();
  const chat = createChat({ ledger, workspace: dir, adapterOverride: path.join(import.meta.dirname, 'fake-acp-agent.mjs'), instance: 'r23-' + process.pid, lifecycle: createLifecycle() });
  assert.equal(await chat.stopAll(), 'cleanup-failed');
  assert.equal(await chat.stopAll(), 'cleanup-failed', 'a second Stop All still cannot confirm');
  assert.equal(ledger.db.prepare("SELECT state FROM conversations WHERE id = 'c1'").get().state, 'cleanup-failed');
  console.log('PASS R2-3: with the scope query failing, Stop All answered cleanup-failed twice; the row stays cleanup-failed');
});
