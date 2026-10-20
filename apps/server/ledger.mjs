// The daemon's durable record (sqlite, in the 0700 state home): chat events with monotonic cursors, conversations,
// and operation IDs. Every mutation carries an operation ID bound to its login and payload; a retry gets the stored
// reply, an ID whose first attempt never finished gets "outcome unknown", and nothing runs twice.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WEEK = 7 * 24 * 3600 * 1000;
// Rows are kept forever, so a remote device gets a rate: 600 new operation IDs an hour (10 a minute sustained).
// ponytail: an hourly cap per device bounds growth to ~0.8 GB a device a year at worst; add pruning if that ever matters.
const REMOTE_OPS_PER_HOUR = 600;

// Schema versions: MIGRATIONS[n] takes the ledger from version n to n + 1 (version 0 is every pre-release file, which
// has the same tables). Append a step; never edit a shipped one.
export const MIGRATIONS = [`
    CREATE TABLE IF NOT EXISTS events (cursor INTEGER PRIMARY KEY AUTOINCREMENT, conversation TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, provider TEXT NOT NULL, title TEXT NOT NULL, session TEXT, state TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, login TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL, status INTEGER, body TEXT, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS operations_login_at ON operations (login, at);`,
  // 2: a chat's folder, workspace-relative ('' is the workspace; threat model row 24).
  `ALTER TABLE conversations ADD COLUMN folder TEXT NOT NULL DEFAULT '';`];
export const SCHEMA = MIGRATIONS.length;
const backupOf = (file, version) => `${file}.v${version}.bak`;
const replaceWith = (file, copy) => {
  for (const extra of ['-wal', '-shm']) rmSync(file + extra, { force: true });
  copyFileSync(copy, file + '.restoring');
  renameSync(file + '.restoring', file);
};

// Rollback (daemon stopped): the newest <file>.v<N>.bak this build can open (N <= SCHEMA; N names the schema before
// that migration, release r1 R1-8) replaces the ledger; the current file is kept beside it as
// <file>.rolled-back-<time>, so a rollback can itself be undone. Returns the backup used, or null when there is none.
// Release r2: a file this build already opens is not rolled back (state-current; R2-2). The copy is staged and
// lands by one rename, so p9.db is never missing part way (R2-4). Phones revoked in the current file stay revoked
// and every session is dropped (R2-2); a current file that cannot be read revokes every phone in the copy.
export function rollbackLedger(file) {
  const directory = path.dirname(file), base = path.basename(file);
  let current = null;
  try {
    const db = new DatabaseSync(file, { open: existsSync(file) });
    try {
      const version = db.prepare('PRAGMA user_version').get().user_version;
      if (version <= SCHEMA) throw Object.assign(new Error(`state-current: ${file} is schema ${version}; this build opens it, so there is nothing to roll back`), { current: true });
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      current = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'devices'").get().n
        ? db.prepare("SELECT id FROM devices WHERE state = 'revoked'").all().map(({ id }) => id) : [];
    } finally { db.close(); }
  } catch (error) { if (error.current) throw error; }
  const backups = readdirSync(directory).map((name) => name.match(/^(.+)\.v(\d+)\.bak$/)).filter((m) => m && m[1] === base && Number(m[2]) <= SCHEMA)
    .sort((a, b) => Number(b[2]) - Number(a[2]));
  if (!backups.length) return null;
  const backup = path.join(directory, backups[0][0]), kept = file + '.rolled-back-' + Date.now(), staged = file + '.restoring';
  copyFileSync(backup, staged);
  const copy = new DatabaseSync(staged);
  try {
    if (copy.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'devices'").get().n) {
      const revoke = copy.prepare("UPDATE devices SET state = 'revoked' WHERE id = ?");
      if (current) for (const id of current) revoke.run(id); else copy.prepare("UPDATE devices SET state = 'revoked'").run();
      copy.exec('DELETE FROM sessions');
    }
  } finally { copy.close(); }
  if (existsSync(file)) linkSync(file, kept);
  for (const extra of ['-wal', '-shm']) rmSync(file + extra, { force: true });
  rmSync(file + '.migrating', { force: true });  // a rollback replaces whatever a dead migration left
  renameSync(staged, file);
  return backup;
}

// Before a migration the ledger is copied (VACUUM INTO: a consistent copy even with a live WAL) to <file>.v<old>.bak,
// then a <file>.migrating marker naming that copy is written. A start that finds the marker (the last migration died
// part way) restores the copy first. A file newer than this build is refused, never opened for writing.
// steps: test hook to stand in for a later build's longer migration list.
export function openLedger(file, { steps = MIGRATIONS, crashAfter } = {}) {
  const marker = file + '.migrating';
  if (file !== ':memory:' && existsSync(marker)) { replaceWith(file, readFileSync(marker, 'utf8')); rmSync(marker); }
  const db = new DatabaseSync(file);
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > steps.length) { db.close(); throw new Error(`state-schema-newer: ${file} is schema ${version}; this build reads up to ${steps.length}. Install the newer P9, or roll back its state (scripts/rollback.mjs).`); }
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
  if (version < steps.length) {
    // A new, empty file has nothing to lose; any file that already holds the tables is copied first.
    if (file !== ':memory:' && db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n) {
      rmSync(backupOf(file, version) + '.tmp', { force: true });
      db.exec(`VACUUM INTO '${(backupOf(file, version) + '.tmp').replaceAll("'", "''")}'`);
      renameSync(backupOf(file, version) + '.tmp', backupOf(file, version));
      writeFileSync(marker + '.tmp', backupOf(file, version));
      renameSync(marker + '.tmp', marker);
    }
    db.exec('BEGIN');
    for (let step = version; step < steps.length; step += 1) {
      db.exec(steps[step]);
      if (crashAfter === step) process.exit(70);  // test hook: die mid-migration, after a step, before the commit
    }
    db.exec(`PRAGMA user_version = ${steps.length}; COMMIT`);
    rmSync(marker, { force: true });
  }
  // Operation IDs are never forgotten: after a week only the stored reply is dropped, so a later retry is refused
  // (operation-expired) instead of running again. A row is an ID and a hash, about 150 bytes.
  db.prepare("UPDATE operations SET state = 'expired', body = NULL WHERE at < ? AND state != 'expired'").run(Date.now() - WEEK);
  const statements = {
    append: db.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)'),
    after: db.prepare('SELECT cursor, conversation, type, data, at FROM events WHERE cursor > ? ORDER BY cursor LIMIT ?'),
    usage: db.prepare("SELECT e.conversation, e.type, c.provider, e.data, e.at FROM events e LEFT JOIN conversations c ON c.id = e.conversation WHERE e.type IN ('update', 'turn-end') ORDER BY e.cursor"),
    operation: db.prepare('SELECT * FROM operations WHERE id = ?'),
    recent: db.prepare('SELECT COUNT(*) AS n FROM operations WHERE login = ? AND at > ?'),
    begin: db.prepare("INSERT INTO operations (id, login, fingerprint, state, at) VALUES (?, ?, ?, 'running', ?)"),
    finish: db.prepare("UPDATE operations SET state = 'done', status = ?, body = ? WHERE id = ?"),
  };
  return {
    db,
    append(conversation, type, data) {
      return Number(statements.append.run(conversation, type, JSON.stringify(data), Date.now()).lastInsertRowid);
    },
    after(cursor, limit = 500) {
      return statements.after.all(cursor, limit).map((row) => {
        try { return { ...row, data: JSON.parse(row.data) }; }
        catch { return { ...row, type: 'invalid', data: { error: 'malformed-event' } }; }
      });
    },
    // What the adapters send (ACP, checked against claude-agent-acp 0.88.0): token counts per turn in the prompt
    // reply's usage (stored on turn-end), and usage_update {used, size, cost: {amount, currency}} where cost is the
    // session's running total, so each conversation counts its latest cost once.
    usage() {
      const totals = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 };
      const contexts = new Map(), costs = new Map();
      const count = (value) => value === undefined || value === null || (Number.isSafeInteger(value) && value >= 0);
      let latest = 0, discarded = 0, samples = 0, claudeLive = null;
      for (const row of statements.usage.all()) {
        let data;
        try { data = JSON.parse(row.data); } catch { discarded += 1; continue; }
        if (row.type === 'turn-end') {
          const usage = data?.usage;
          if (usage === undefined) continue;
          if (!usage || !['inputTokens', 'outputTokens', 'cachedReadTokens'].every((key) => count(usage[key]))) { discarded += 1; continue; }
          totals.inputTokens += usage.inputTokens ?? 0; totals.outputTokens += usage.outputTokens ?? 0;
          totals.cachedTokens += usage.cachedReadTokens ?? 0; samples += 1;
        } else {
          if (data?.sessionUpdate !== 'usage_update') continue;
          // claude-agent-acp 0.88.0 attaches the SDK's rate_limit_info to a usage_update each turn: the live 5 h / 7 d use.
          const windows = data._meta?.['_claude/rateLimit']?.unifiedWindows;
          if (windows && typeof windows === 'object') claudeLive = { windows, at: row.at };
          const context = Number.isSafeInteger(data.used) && data.used >= 0 && Number.isSafeInteger(data.size) && data.size > 0 && data.used <= data.size;
          const cost = data.cost === undefined || data.cost === null
            || data.cost.currency === 'USD' && Number.isFinite(data.cost.amount) && data.cost.amount >= 0;
          if (!context || !cost) { discarded += 1; continue; }
          contexts.set(row.conversation, { provider: row.provider ?? 'unknown', used: data.used, size: data.size });
          if (data.cost) costs.set(row.conversation, data.cost.amount);
        }
        latest = Math.max(latest, row.at);
      }
      for (const amount of costs.values()) totals.costUsd += amount;
      const any = samples || contexts.size;
      return { state: any ? (Date.now() - latest > 15 * 60 * 1000 ? 'stale' : 'recorded') : 'unavailable',
        updatedAt: latest || null, samples, discarded, totals, contexts: [...contexts.values()], claudeLive };
    },
    operation: (id) => statements.operation.get(id),
    recent: (login, since) => statements.recent.get(login, since).n,
    begin: (id, login, fingerprint) => statements.begin.run(id, login, fingerprint, Date.now()),
    finish: (id, status, body) => statements.finish.run(status, body, id),
  };
}

// Hono middleware for every route that is not a read.
export function operations(ledger, login) {
  return async (c, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return next();
    const id = c.req.header('x-p9-op') ?? '';
    if (!UUID.test(id)) return c.json({ error: 'operation-id-required' }, 428);
    const fingerprint = createHash('sha256').update(c.req.method + ' ' + c.req.path + '\n' + await c.req.text()).digest('hex');
    // A function names the login per request (one per remote device); a string is the desktop's single login.
    const owner = typeof login === 'function' ? login(c) : login;
    const prior = ledger.operation(id);
    if (prior) {
      if (prior.login !== owner || prior.fingerprint !== fingerprint) return c.json({ error: 'operation-reused' }, 409);
      if (prior.state === 'expired') return c.json({ error: 'operation-expired', operation: id }, 409);
      if (prior.state !== 'done') return c.json({ error: 'outcome-unknown', operation: id }, 409);
      return new Response(prior.body, { status: prior.status,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-p9-replayed': '1' } });
    }
    if (typeof login === 'function' && ledger.recent(owner, Date.now() - 3600 * 1000) >= REMOTE_OPS_PER_HOUR) return c.json({ error: 'operation-quota' }, 429);
    ledger.begin(id, owner, fingerprint);
    await next();
    ledger.finish(id, c.res.status, await c.res.clone().text());
  };
}
