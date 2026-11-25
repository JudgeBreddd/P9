// O244 (b): P9's own record of plan use, for SQL and for copying into another database. Every tick writes one row per
// provider and window of /usage's limits into usage-limits.db (STRICT table limits) beside the ledger: used %, when the
// window resets, the projected % at that reset, the pace word, when the reading was taken and how old it was. Providers
// and windows come from the readings themselves, so a catalog-only agent gets rows with no change here. A reading is
// written once (key: provider, window, reading time): a tick that finds the same reading again writes nothing.
import { DatabaseSync } from 'node:sqlite';
import { paceState } from './limits.mjs';

const MIN = 60000;
// A window: a used % and a length; its reset may be unknown (then it has no projection and no pace).
const isWindow = (w) => w && typeof w === 'object' && !Array.isArray(w) && Number.isFinite(w.usedPercent) && Number.isFinite(w.windowMins) && w.windowMins > 0;
// The limits with fn(provider, win, w, asOf) in place of each window: each provider is an object key (null for none,
// signedOut is an array), each window a key of it holding one, or an entry of a list of named ones (a provider's
// per-model list), named <list>.<name>.
const mapWindows = (limits, fn) => (limits && typeof limits === 'object' ? Object.fromEntries(Object.entries(limits).map(([provider, r]) => {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return [provider, r];
  const asOf = Number.isFinite(r.asOf) ? r.asOf : null;
  return [provider, Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Array.isArray(v)
    ? v.map((w) => (isWindow(w) && typeof w.name === 'string' ? fn(provider, k + '.' + w.name, w, asOf) : w))
    : isWindow(v) ? fn(provider, k, v, asOf) : v]))];
})) : limits);

// The % a window will be at its reset, at the rate since base ({ at, used }, an earlier reading of the same window), or
// with none (or a base above today's %: a source revised it down) at the window's average so far. Null once the window has reset, and in its first 35 min (the average of a
// few minutes says 600% after one busy one). Rounded to 0.1; it can pass 100.
// ponytail: one earlier reading sets the rate (the usage pace script's rule); a fit over many is the upgrade if it jumps.
export function projectAt(w, now, base) {
  if (base && base.used > w.usedPercent) base = null;
  const left = (w.resetsAt ?? NaN) - now, gone = base ? now - base.at : w.windowMins * MIN - left;
  if (!(left > 0) || !(gone >= 35 * MIN)) return null;
  return Math.round((w.usedPercent + (w.usedPercent - (base?.used ?? 0)) / gone * left) * 10) / 10;
}

// file: the database; read: async () => /usage's limits; everyMs: the tick (0: none, the caller ticks). The database opens
// at the first use, so a folder it cannot write costs a log line, never the daemon.
export function startUsageHistory({ file, read, everyMs = 10 * MIN, now = Date.now, log = (line) => console.error(line) }) {
  let db = null, base, add, said = '', closed = false;
  const open = () => {
    if (db) return;
    const opened = new DatabaseSync(file);
    try {
      opened.exec(`PRAGMA busy_timeout = 0; PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS limits (at INTEGER NOT NULL,
        provider TEXT NOT NULL, win TEXT NOT NULL, used_pct REAL NOT NULL,
        resets_at INTEGER, window_mins INTEGER NOT NULL, projected_pct REAL, pace TEXT CHECK (pace IN ('ahead', 'on', 'headroom')),
        as_of INTEGER NOT NULL, age_ms INTEGER NOT NULL, PRIMARY KEY (provider, win, as_of)) STRICT`);
      // The base reading: the newest of the same window (the same reset, as the usage pace script matches it) that is
      // 35-90 min older and was fresh (at most 10 min old) when written.
      base = opened.prepare(`SELECT as_of AS at, used_pct AS used FROM limits WHERE provider = ? AND win = ? AND resets_at = ?
        AND as_of BETWEEN ? AND ? AND age_ms <= 600000 ORDER BY as_of DESC LIMIT 1`);
      add = opened.prepare('INSERT INTO limits VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING');
    } catch (error) { opened.close(); throw error; }
    db = opened;
  };
  const logOnce = (error) => { if (said !== error.message) log('usage history: ' + (said = error.message)); };
  const baseOf = (provider, win, w, at) => {
    if (closed || !Number.isFinite(w.resetsAt)) return null;
    try { open(); return base.get(provider, win, Math.round(w.resetsAt), at - 90 * MIN, at - 35 * MIN) ?? null; } catch (error) { logOnce(error); return null; }
  };
  // The limits with each window's projected % (none once its reset has passed, however old the reading).
  const annotate = (limits) => mapWindows(limits, (provider, win, w, asOf) => {
    const at = asOf ?? now();
    return { ...w, projected: w.resetsAt > now() ? projectAt(w, at, baseOf(provider, win, w, at)) : null };
  });
  // One read, one row per window not written yet. Answers how many rows it wrote. The database is never waited on
  // (busy_timeout 0): a writer holding it costs this tick, and the next one tries again.
  const tick = async () => {
    try {
      const limits = await read(), t = now(), rows = [];
      if (closed) return 0;
      open();
      mapWindows(limits, (provider, win, w, asOf) => {
        const at = Math.round(asOf ?? t), resets = Number.isFinite(w.resetsAt) ? Math.round(w.resetsAt) : null;
        rows.push([t, provider, win, w.usedPercent, resets, Math.round(w.windowMins), projectAt(w, at, baseOf(provider, win, w, at)), paceState(w, at), at, Math.max(0, t - at)]);
        return w;
      });
      // One transaction: a tick writes all its rows or none.
      let n = 0;
      db.exec('BEGIN');
      try { for (const row of rows) n += Number(add.run(...row).changes); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
      said = '';
      return n;
    } catch (error) { logOnce(error); return 0; }
  };
  const timer = everyMs > 0 ? setInterval(tick, everyMs) : null;
  timer?.unref?.();
  return { tick, annotate, close() { closed = true; clearInterval(timer); db?.close(); db = null; } };
}
