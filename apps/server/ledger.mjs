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
  `ALTER TABLE conversations ADD COLUMN folder TEXT NOT NULL DEFAULT '';`,
  // 3 (N1): a chat's project, the id the user put it in (NULL is a general chat, as every chat before this step), and
  // its archive flag (archived chats are hidden, not deleted).
  `ALTER TABLE conversations ADD COLUMN project TEXT; ALTER TABLE conversations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;`,
  // 4 (A7 Delegate): the chat that started this one through open_chat (NULL: the user did), and the name that chat
  // gave it, one per parent, so the same open_chat sent twice makes one chat.
  `ALTER TABLE conversations ADD COLUMN parent TEXT; ALTER TABLE conversations ADD COLUMN key TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS conversations_parent_key ON conversations (parent, key) WHERE key IS NOT NULL;`];
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
// The event types the phone draws as a block of their own (P20's tail read counts them).
const BLOCKS = new Set(['user', 'approval', 'answered', 'question', 'error', 'steer-lost', 'interrupted', 'exited', 'stopped']);
const COMMANDS = '"sessionUpdate":"available_commands_update"';
// O249: an update's image blocks in one fixed order (its content, or each content item's content), each given to fn with
// its index; parsed() and chat.shot() walk the same order, so a place names the same picture.
export const eachImage = (update, fn) => {
  let n = 0; const one = (b) => (b?.type === 'image' ? fn(b, n++) : b);
  if (Array.isArray(update?.content)) return { ...update, content: update.content.map((i) => (i?.type === 'content' ? { ...i, content: one(i.content) } : one(i))) };
  return update?.content?.type === 'image' ? { ...update, content: one(update.content) } : update;
};
// An event as a reader that asks for places gets it (chat.events with shots): each image its place (shot: "cursor/n"), not
// its data, fetched when seen (/chat/:id/shots), so a chat of screenshots loads as fast as one without. A reader that does not
// ask (a window older than this) gets the data, as before. The stored row keeps the data.
export const placed = (e) => {
  if (e.type !== 'update') return e;
  let any = false; const data = eachImage(e.data, ({ data: _, ...b }, n) => { any = true; return { ...b, shot: e.cursor + '/' + n }; });
  return any ? { ...e, data } : e;
};
const parsed = (row) => {
  try { return { ...row, data: JSON.parse(row.data) }; }
  catch { return { ...row, type: 'invalid', data: { error: 'malformed-event' } }; }
};

export function openLedger(file, { steps = MIGRATIONS, crashAfter } = {}) {
  const marker = file + '.migrating';
  if (file !== ':memory:' && existsSync(marker)) { replaceWith(file, readFileSync(marker, 'utf8')); rmSync(marker); }
  const db = new DatabaseSync(file);
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > steps.length) { db.close(); throw new Error(`state-schema-newer: ${file} is schema ${version}; this build reads up to ${steps.length}. Install the newer P9, or roll back its state (scripts/rollback.mjs).`); }
  // WAL with synchronous = NORMAL: every commit survives a process crash or SIGKILL (the WAL is appended before the commit
  // returns; session-durability.test checks it); only a power cut or OS crash can lose the last transactions, which SECURITY.md
  // puts out of scope. FULL fsynced the WAL on every commit, and chat.mjs commits once per streamed chunk on the event-loop
  // thread, so a streaming reply stalled every request and terminal once per chunk (review 2026-11-03).
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
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
  // Again each day for a daemon that runs for weeks (finding 19); a timer that finds the database closed stops itself.
  const expire = () => db.prepare("UPDATE operations SET state = 'expired', body = NULL WHERE at < ? AND state != 'expired'").run(Date.now() - WEEK);
  expire();
  const daily = setInterval(() => { try { expire(); } catch { clearInterval(daily); } }, 24 * 3600 * 1000).unref();
  // E2: one chat's events (or a few chats') without reading the rest. An index, not a schema change: an older build
  // opens the file unchanged and SQLite keeps the index up to date for it, so it stays outside MIGRATIONS.
  db.exec('CREATE INDEX IF NOT EXISTS events_conversation ON events (conversation, cursor)');
  // A2: the few updates that carry a goal, for chat.mjs goalNow (its WHERE must keep these two terms, word for word, so
  // SQLite uses it). json_valid first: a row that is not JSON (a test inserts one) is left out, not an error on insert or build.
  // Without it the chat list's first read after a start scanned every event, 1.6 to 3.3 s on a 2.1M-event ledger;
  // with it, 2 ms. Built once (1.5 s on that ledger), same as the index above.
  db.exec("CREATE INDEX IF NOT EXISTS events_goal ON events (conversation, cursor) WHERE type = 'update' AND CASE WHEN json_valid(data) THEN json_type(data, '$._meta.jetbrains.air.goal') END IS NOT NULL");
  // O191: the usage read joins a chat's provider profile (prefs profile:<chat>, O48). The same table chat.mjs makes, outside
  // MIGRATIONS as it is there, so a ledger opened without chat.mjs can prepare the read.
  db.exec('CREATE TABLE IF NOT EXISTS prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const statements = {
    append: db.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)'),
    after: db.prepare('SELECT cursor, conversation, type, data, at FROM events WHERE cursor > ? ORDER BY cursor LIMIT ?'),
    top: db.prepare('SELECT COALESCE(MAX(cursor), 0) AS n FROM events'),
    of: db.prepare('SELECT cursor, conversation, type, data, at FROM events WHERE cursor > ? AND cursor <= ? AND conversation IN (SELECT value FROM json_each(?)) ORDER BY cursor LIMIT ?'),
    // E5: only rows after the last fold, and only updates that can be usage (or are malformed: those count as discarded).
    // Agent chunks, images included, are skipped in SQL instead of parsed. JSON.stringify never escapes 'usage_update'.
    // O35: a deleted chat's 'deleted' event carries what it had spent, so the totals keep it once its own rows are gone.
    usage: db.prepare("SELECT e.cursor, e.conversation, e.type, c.provider, p.value AS profile, e.data, e.at FROM events e LEFT JOIN conversations c ON c.id = e.conversation"
      + " LEFT JOIN prefs p ON p.key = 'profile:' || e.conversation"
      + " WHERE e.cursor > ? AND (e.type IN ('turn-end', 'usage', 'deleted') OR e.type = 'update' AND (instr(e.data, 'usage_update') > 0 OR NOT json_valid(e.data))) ORDER BY e.cursor"),
    spent: db.prepare("SELECT cursor, conversation, type, NULL AS provider, data, at FROM events WHERE conversation = ? AND cursor > ?"
      + " AND (type IN ('turn-end', 'usage') OR type = 'update' AND (instr(data, 'usage_update') > 0 OR NOT json_valid(data))) ORDER BY cursor"),
    // O35: the photo hashes a chat's messages name (sent, steered or held), and which of those any other event still names.
    photos: db.prepare("SELECT DISTINCT i.value ->> '$.hash' AS hash FROM events e, json_each(CASE WHEN json_valid(e.data) THEN e.data ELSE '{}' END, '$.images') i"
      + " WHERE e.conversation = ? AND e.type IN ('user', 'held')"),
    named: db.prepare("SELECT DISTINCT i.value ->> '$.hash' AS hash FROM events e, json_each(CASE WHEN json_valid(e.data) THEN e.data ELSE '{}' END, '$.images') i"
      + " WHERE e.type IN ('user', 'held') AND i.value ->> '$.hash' IN (SELECT value FROM json_each(?))"),
    // P20, the tail read: a chat's events newest first, with only what a block count needs (malformed data reads as none).
    back: db.prepare("SELECT cursor, type, CASE WHEN json_valid(data) THEN json_extract(data, '$.sessionUpdate') END AS u,"
      + " CASE WHEN json_valid(data) THEN json_extract(data, '$.stopReason') END AS r FROM events WHERE conversation = ? AND cursor <= ? ORDER BY cursor DESC LIMIT ?"),
    span: db.prepare('SELECT cursor, conversation, type, data, at FROM events WHERE conversation = ? AND cursor >= ? AND cursor <= ? ORDER BY cursor'),
    kept: db.prepare("SELECT cursor, conversation, type, data, at FROM events WHERE conversation = ? AND cursor < ? AND type IN ('card', 'unpin', 'config')"),
    // O251: a message still held at the read's cursor (no user event up to it took it, no unheld named it); the queue is drawn from these,
    // with its newest edit before the cut (held-text, A2 step 3; tail drops it when the span has a newer one), so a reload shows the words it will go with.
    held: db.prepare("SELECT cursor, conversation, type, data, at FROM events h WHERE conversation = ? AND cursor < ? AND type IN ('held', 'held-text') AND NOT (type = 'held-text' AND EXISTS (SELECT 1 FROM events y WHERE y.conversation = h.conversation"
      + " AND y.type = 'held-text' AND y.cursor > h.cursor AND y.cursor < ? AND json_extract(CASE WHEN json_valid(y.data) THEN y.data END, '$.id') = json_extract(CASE WHEN json_valid(h.data) THEN h.data END, '$.id')))"
      + " AND NOT EXISTS ("
      + "SELECT 1 FROM events x WHERE x.conversation = h.conversation AND x.cursor > h.cursor AND x.cursor <= ? AND x.type IN ('user', 'unheld') AND ("
      + "x.type = 'unheld' AND json_extract(CASE WHEN json_valid(x.data) THEN x.data END, '$.id') = json_extract(CASE WHEN json_valid(h.data) THEN h.data END, '$.id') OR "
      + "x.type = 'user' AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(x.data) THEN x.data ELSE '{}' END, '$.held') AS j WHERE j.value = json_extract(CASE WHEN json_valid(h.data) THEN h.data END, '$.id'))))"),
    latest: db.prepare('SELECT cursor, conversation, type, data, at FROM events WHERE conversation = ? AND cursor < ? AND type = ? AND instr(data, ?) > 0 ORDER BY cursor DESC LIMIT 1'),
    // O249: the newest slash-command list before a cursor, by its top-level kind (a tool's output may hold the same words).
    commands: db.prepare(`SELECT cursor, conversation, type, data, at FROM events WHERE conversation = ? AND cursor < ? AND type = 'update' AND instr(data, '${COMMANDS}') > 0 AND CASE WHEN json_valid(data) THEN json_extract(data, '$.sessionUpdate') END = 'available_commands_update' ORDER BY cursor DESC LIMIT 1`),
    operation: db.prepare('SELECT * FROM operations WHERE id = ?'),
    recent: db.prepare('SELECT COUNT(*) AS n FROM operations WHERE login = ? AND at > ?'),
    begin: db.prepare("INSERT INTO operations (id, login, fingerprint, state, at) VALUES (?, ?, ?, 'running', ?)"),
    finish: db.prepare("UPDATE operations SET state = 'done', status = ?, body = ? WHERE id = ?"),
    forget: db.prepare('DELETE FROM operations WHERE id = ?'),
  };
  const fresh = () => ({ cursor: 0, totals: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, contexts: new Map(), costs: new Map(),
    latest: 0, discarded: 0, samples: 0, claudeLive: null, profiles: new Map() });
  // O191: a chat on a provider profile is stored as provider claude but spends neither the Claude plan nor its bill. Its
  // tokens, turns and the cost its adapter estimates at Claude prices go to the profile's own row, never into totals.
  // The profile comes from the usage read's join, or, once the chat is deleted, from its 'deleted' event (remove below).
  const bucket = (into, row, data) => {
    let p = null;
    try { p = row.type === 'deleted' ? data?.usage?.profile : row.profile && JSON.parse(row.profile); } catch {}
    if (!p || typeof p.id !== 'string') return into;
    if (!into.profiles.has(p.id)) into.profiles.set(p.id, { id: p.id, name: String(p.name), totals: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, costs: new Map(), samples: 0 });
    return into.profiles.get(p.id);
  };
  let fold = fresh();
  // O190: token counts come from a prompted turn's reply (turn-end, its counted() figure when it has one) and from a Claude
  // chat's 'usage' events: the result of a run Claude Code started itself (a background task's notification, another
  // agent's message), which claude-agent-acp 0.106.0 leaves out of the turn's usage and sends as a raw SDK result only when
  // asked (chat.mjs OWN_RUNS). A compaction in a prompted turn (P9's /compact, or Claude Code's own mid-turn) counts through
  // counted(). Not counted: a Codex turn P9 never prompted (no usage reaches P9), the adapter's own idle /compact (its reply
  // goes to the adapter), and an own run's result that lands during a prompted turn. The cost (usage_update) counts every run.
  const TOKENS = 'prompted turns and Claude Code\'s own runs';
  const SPENT = ['inputTokens', 'outputTokens', 'cachedTokens', 'costUsd', 'samples', 'discarded', 'latest'];
  // What the adapters send (ACP, checked against claude-agent-acp 0.88.0 and 0.104.1): token counts per turn in the prompt
  // reply's usage (stored on turn-end), and usage_update {used, size, cost: {amount, currency}} where cost is the
  // session's running total, so each conversation counts its latest cost once. add folds one row into a fold.
  const count = (value) => value === undefined || value === null || (Number.isSafeInteger(value) && value >= 0);
  const add = (into, row) => {
    into.cursor = row.cursor;
    let data;
    try { data = JSON.parse(row.data); } catch { into.discarded += 1; return; }
    const to = bucket(into, row, data);
    if (row.type === 'deleted') {
      // O35: spent stays spent. The chat's own fold, taken as it was deleted; its context meter goes with it.
      const spent = data?.usage;
      if (!spent || !SPENT.every((key) => Number.isFinite(spent[key]) && spent[key] >= 0)) return;
      to.totals.inputTokens += spent.inputTokens; to.totals.outputTokens += spent.outputTokens; to.totals.cachedTokens += spent.cachedTokens;
      to.samples += spent.samples; into.discarded += spent.discarded;
      if (spent.costUsd) to.costs.set(row.conversation, spent.costUsd);
      into.latest = Math.max(into.latest, spent.latest);
      return;
    }
    if (row.type === 'turn-end' || row.type === 'usage') {
      const usage = data?.counted ?? data?.usage;
      if (usage === undefined) return;
      if (!usage || !['inputTokens', 'outputTokens', 'cachedReadTokens'].every((key) => count(usage[key]))) { into.discarded += 1; return; }
      to.totals.inputTokens += usage.inputTokens ?? 0; to.totals.outputTokens += usage.outputTokens ?? 0;
      to.totals.cachedTokens += usage.cachedReadTokens ?? 0; to.samples += 1;
    } else {
      if (data?.sessionUpdate !== 'usage_update') return;
      // claude-agent-acp (0.88.0 to 0.106.0, on ACP 1 and 2 alike) attaches the SDK's rate_limit_info to a usage_update each turn: the live 5 h / 7 d use.
      const windows = data._meta?.['_claude/rateLimit']?.unifiedWindows;
      if (windows && typeof windows === 'object') into.claudeLive = { windows, at: row.at };
      const context = Number.isSafeInteger(data.used) && data.used >= 0 && Number.isSafeInteger(data.size) && data.size > 0 && data.used <= data.size;
      const cost = data.cost === undefined || data.cost === null
        || data.cost.currency === 'USD' && Number.isFinite(data.cost.amount) && data.cost.amount >= 0;
      if (!context || !cost) { into.discarded += 1; return; }
      into.contexts.set(row.conversation, { conversation: row.conversation, provider: row.provider ?? 'unknown', used: data.used, size: data.size });
      if (data.cost) to.costs.set(row.conversation, data.cost.amount);
    }
    into.latest = Math.max(into.latest, row.at);
  };
  return {
    db,
    // text: data already serialized by the caller (chat.mjs trim()), else it is serialized here.
    append(conversation, type, data, text) {
      const at = Date.now();
      const cursor = Number(statements.append.run(conversation, type, text ?? JSON.stringify(data), at).lastInsertRowid);
      // The watcher (telemetry.mjs, set by main.mjs) sees each event as written; it never fails or delays the append.
      try { this?.tap?.({ cursor, conversation, type, data, at }); } catch {}
      return cursor;
    },
    after(cursor, limit = 500) {
      return statements.after.all(cursor, limit).map(parsed);
    },
    // The events of the conversations in only, after cursor and up to until (default: the newest). The cursor returned
    // is how far the scan got, matching or not, so a caller can carry on from it.
    of(only, cursor, until = Infinity, limit = 500) {
      const top = Math.min(until, statements.top.get().n), rows = statements.of.all(cursor, top, JSON.stringify(only), limit);
      return { events: rows.map(parsed), cursor: rows.length === limit ? rows.at(-1).cursor : Math.max(cursor, top) };
    },
    // P20: the newest blocks of each chat in only, up to until, counted as the phone draws them (phone.ts build()): a
    // run of streamed chunks is one block, bookkeeping updates are none. Older events the chat screen still needs come
    // along (pinned cards, the agent's picks, the latest mode, plan and slash commands), and the chat's latest message from
    // the user when the kept blocks hold none, so a turn still running reads as running, and every message still held. O251: it used to read back to
    // that message instead, and one long turn (4,500 updates) came whole, a megabyte over a remote. more[id] is the first cursor
    // kept, for a chat with older events left out; the next read asks up to the one before it.
    tail(only, until = Infinity, blocks = 30) {
      const top = Math.min(until, statements.top.get().n), events = [], more = {};
      for (const id of only) {
        let count = 0, run = null, user = false, from = 0, cut = false;
        for (let before = top; !cut;) {
          const rows = statements.back.all(id, before, 500);
          for (const { cursor, type, u, r } of rows) {
            const chunk = type === 'update' && (u === 'agent_message_chunk' || u === 'agent_thought_chunk') ? u : null;
            const starts = chunk ? chunk !== run : BLOCKS.has(type) || (type === 'update' && u === 'tool_call') || (type === 'turn-end' && r !== 'end_turn');
            if (starts) { if (count >= blocks) { cut = true; break; } count++; run = chunk; }
            if (type === 'user') user = true;
            from = cursor;
          }
          if (rows.length < 500) break;
          before = rows.at(-1).cursor - 1;
        }
        // O249: only the newest slash-command list is used (chat-view.mjs, phone.ts), and each is about 70 KB: a busy chat's
        // tail carried ten of them, 0.7 MB of a launch read over a remote. The older ones in the span stay out.
        // The top-level kind only: a tool's input or output may hold the same words (parsed only for a row that does).
        const commands = (e) => { if (e.type !== 'update' || !e.data.includes(COMMANDS)) return false; try { return JSON.parse(e.data)?.sessionUpdate === 'available_commands_update'; } catch { return false; } };
        const span = statements.span.all(id, from, top), last = span.findLastIndex(commands);
        events.push(...span.filter((e, i) => i === last || !commands(e)));
        if (cut) {
          more[id] = from;
          events.push(...statements.kept.all(id, from), ...statements.held.all(id, from, from, top), ...[['mode', ''], ['update', '"sessionUpdate":"plan"'], ...(user ? [] : [['user', '']])]
            .map(([type, text]) => statements.latest.get(id, from, type, text)).filter(Boolean), ...(last < 0 ? [statements.commands.get(id, from)].filter(Boolean) : []));
        }
      }
      // A2 step 3: a held message's newest edit only (each save is one event; a long message saved often would fill a slow read).
      const sorted = events.map(parsed).sort((a, b) => a.cursor - b.cursor), edits = new Map(sorted.filter((e) => e.type === 'held-text').map((e) => [e.data?.id, e]));
      return { events: sorted.filter((e) => e.type !== 'held-text' || edits.get(e.data?.id) === e), cursor: top, more };
    },
    // Events are append-only, so the fold so far is kept and each call reads only the rows after it (E5). A delete
    // starts it again (remove).
    usage() {
      for (const row of statements.usage.all(fold.cursor)) add(fold, row);
      const { totals, contexts, costs, latest, samples, discarded, claudeLive } = fold;
      const sum = (map) => { let n = 0; for (const amount of map.values()) n += amount; return n; };
      const costUsd = sum(costs), any = samples || contexts.size;
      // O191: profiles, one row each: what its chats used, and costUsd, the adapter's estimate at Claude prices (never billed by Claude).
      const profiles = [...fold.profiles.values()].map((p) => ({ id: p.id, name: p.name, ...p.totals, costUsd: sum(p.costs), turns: p.samples }));
      return { state: any ? (Date.now() - latest > 15 * 60 * 1000 ? 'stale' : 'recorded') : 'unavailable',
        updatedAt: latest || null, samples, discarded, tokens: TOKENS, totals: { ...totals, costUsd }, contexts: [...contexts.values()], claudeLive, profiles };
    },
    // Row 716: one chat's own spend (list_chats, sprint_status). into is the fold the caller keeps (chat.mjs gauge), so each
    // call reads only that chat's usage rows after it. usage is null until the chat reports a turn's tokens or a cost.
    spent(id, into = fresh()) {
      for (const row of statements.spent.all(id, into.cursor)) add(into, row);
      let costUsd = 0;
      for (const amount of into.costs.values()) costUsd += amount;
      const { inputTokens, outputTokens, cachedTokens } = into.totals;
      return { into, usage: into.samples || into.costs.size ? { inputTokens, outputTokens, cachedTokens, costUsd, turns: into.samples, tokens: TOKENS } : null };
    },
    // O35: a chat's events and row go in one transaction. Returned: what it had spent (its own fold, for the 'deleted'
    // event the caller appends next) and the photo hashes it named that no other event names now. The fold starts
    // again, so the totals are made from the same rows a restart reads.
    // ponytail: the refold reads every usage row once per delete; an incremental subtraction if deletes ever get frequent.
    remove(id) {
      const own = fresh();
      for (const row of statements.spent.all(id, 0)) add(own, row);
      const { totals, samples, discarded, latest } = own;
      let costUsd = 0;
      for (const amount of own.costs.values()) costUsd += amount;
      const hashes = statements.photos.all(id).map((row) => row.hash).filter((hash) => typeof hash === 'string');
      // O191: the 'deleted' event carries the chat's profile, so its spend stays on the profile's row (chat.mjs drops its prefs next).
      let profile = null;
      try { const p = JSON.parse(db.prepare('SELECT value FROM prefs WHERE key = ?').get('profile:' + id)?.value ?? 'null'); if (typeof p?.id === 'string') profile = { id: p.id, name: String(p.name) }; } catch {}
      let unused;
      db.exec('BEGIN');
      try {
        // Keep anonymous cursor placeholders so readers can distinguish deletion from lost history.
        db.prepare("UPDATE events SET conversation = '', type = 'deleted-cursor', data = '{}', at = 0 WHERE conversation = ?").run(id);
        db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
        const still = new Set(statements.named.all(JSON.stringify(hashes)).map((row) => row.hash));
        unused = hashes.filter((hash) => !still.has(hash));
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      fold = fresh();
      return { usage: { ...totals, costUsd, samples, discarded, latest, ...(profile && { profile }) }, unused };
    },
    operation: (id) => statements.operation.get(id),
    recent: (login, since) => statements.recent.get(login, since).n,
    begin: (id, login, fingerprint) => statements.begin.run(id, login, fingerprint, Date.now()),
    finish: (id, status, body) => statements.finish.run(status, body, id),
    forget: (id) => statements.forget.run(id),
  };
}

// Hono middleware for every route that is not a read.
const tryAgain = (status, body) => { if (status !== 409) return false; try { return JSON.parse(body)?.error === 'turn-running'; } catch { return false; } };
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
    const body = await c.res.clone().text();
    // O267: a turn-running refusal did nothing and says "try again". Kept, it was replayed to every retry under the same ID
    // (a phone's queued message keeps its ID across tries), so the message never went; forgotten, the retry runs.
    if (tryAgain(c.res.status, body)) ledger.forget(id); else ledger.finish(id, c.res.status, body);
  };
}

// O190: what a prompted turn counts. The reply's usage is the main loop only: a /compact turn answers all 0 (claude-agent-acp
// 0.106.0, seen live). Its _meta.quota.model_usage rows (the SDK's modelUsage for this turn, per model) also count internal
// calls such as compaction, subagents and side calls. counted is their sum, never below the reply's usage in any field;
// null when the reply has no model_usage or any row is not plain counts (the reply's usage is counted then, as before).
const ROW = [['inputTokens', 'inputTokens'], ['outputTokens', 'outputTokens'], ['cachedReadTokens', 'cachedInputTokens'], ['cachedWriteTokens', 'cachedWriteTokens']];
export function counted(result) {
  const rows = result?._meta?.quota?.model_usage;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const whole = (n) => Number.isSafeInteger(n) && n >= 0;
  if (!rows.every((row) => row?.token_count && typeof row.token_count === 'object' && ROW.every(([, key]) => whole(row.token_count[key] ?? 0)))) return null;
  // Each row's counters are safe, but their sum may not be (two near MAX_SAFE_INTEGER): then null, so the reply's usage counts.
  const sums = ROW.map(([, key]) => rows.reduce((sum, row) => sum + (row.token_count[key] ?? 0), 0));
  if (!sums.every(whole)) return null;
  const own = result.usage ?? {};
  return Object.fromEntries(ROW.map(([to], i) => [to, Math.max(sums[i], whole(own[to]) ? own[to] : 0)]));
}

