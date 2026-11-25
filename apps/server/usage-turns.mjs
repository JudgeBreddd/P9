// A3: what the turns used, for the Usage window's Tokens and Cost views. Reads telemetry.db (telemetry.mjs, the watcher)
// read-only: one row per day, provider and model over the last 1, 7, 30 or 90 days, with an API-price estimate in dollars
// for Claude models in PRICES. Any other model, and every Codex turn, gets usd: null ("no price"), never $0.
import { DatabaseSync } from 'node:sqlite';

export const PRICES_AS_OF = '2026-11-03';
// $ per million tokens: input, output, cache read, cache write. Cache writes at the 1-hour rate (2x input), the cache P9's
// Claude chats use. ponytail: an alias is priced as today's model of that name, so turns from before a model change are
// estimated at today's price; Haiku at its rate for prompts up to 100K tokens (a turn's total says nothing of each call's).
const OPUS = [4, 20, 0.2, 8], SONNET = [2, 10, 0.1, 4], HAIKU = [0.1, 0.5, 0.01, 0.2], FABLE = [8, 40, 0.2, 16];
export const PRICES = { opus: OPUS, 'claude-opus-5-5': OPUS, sonnet: SONNET, 'claude-sonnet-5-5': SONNET, haiku: HAIKU,
  'claude-haiku-5-5': HAIKU, fable: FABLE, 'claude-fable-5-2': FABLE, 'claude-fable-5-1': [10, 50, 0.25, 20] };
export const RANGES = [1, 7, 30, 90];

// A provider profile's chat (profile 1) talks to another service under a model name of its own: no price, whatever the name.
const priceOf = (row) => (row.provider === 'claude' && !row.profile && Object.hasOwn(PRICES, row.model) ? PRICES[row.model] : null);
const TYPES = ['input', 'output', 'cacheRead', 'cacheWrite'];
const CANTOPEN = 14; // SQLITE_CANTOPEN

// days: one of RANGES (anything else is 7), the window ending at now. Days are the daemon's local dates. The watcher makes
// telemetry.db at the first turn it records, so a file that cannot be opened means no turns yet (empty rows). Any other
// failure (busy while the watcher rebuilds it, damaged) is { state: 'unavailable' }, at once: the read never waits on a
// lock, as it runs on the daemon's one thread.
export function readTurns({ file, days, now = Date.now() }) {
  days = RANGES.includes(Number(days)) ? Number(days) : 7;
  const since = now - days * 86400000, empty = { state: 'ok', days, since, pricesAsOf: PRICES_AS_OF, rows: [], chats: {} };
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); } catch (error) { return (error?.errcode & 0xff) === CANTOPEN ? empty : { state: 'unavailable', days, since }; }
  try {
    db.exec('PRAGMA busy_timeout = 0; BEGIN'); // one read snapshot for both queries
    // measured: the turns that reported token counts; the sums cover only those, and are null when none did.
    const rows = db.prepare(`SELECT date(end_at / 1000, 'unixepoch', 'localtime') AS day, provider, model, profile, count(*) AS turns,
      sum(usage) AS measured, sum(input_tokens) AS input, sum(output_tokens) AS output, sum(cached_read_tokens) AS cacheRead,
      sum(cached_write_tokens) AS cacheWrite, sum(total_tokens) AS total
      FROM turns WHERE end_at > ? AND end_at <= ? GROUP BY day, provider, model, profile ORDER BY day, provider, model, profile`).all(since, now).map((row) => {
      const price = priceOf(row);
      const known = price && TYPES.every((type) => row[type] != null);
      // cost: dollars by token type (the Cost view's bar). saved: what the cached tokens would have cost as plain input,
      // less what they cost as cache reads and writes; below zero when the writes' premium outran the reads' discount.
      const cost = known ? Object.fromEntries(TYPES.map((type, i) => [type, row[type] * price[i] / 1e6])) : null;
      return { day: row.day, provider: row.provider, model: row.model, profile: row.profile === 1, turns: row.turns,
        measured: row.measured, input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite, total: row.total,
        cost, usd: cost && TYPES.reduce((sum, type) => sum + cost[type], 0),
        saved: cost && ((row.cacheRead + row.cacheWrite) * price[0] - row.cacheRead * price[2] - row.cacheWrite * price[3]) / 1e6 };
    });
    // Chats are counted apart: one chat runs on several days and models, so the rows' counts would add it twice.
    const chats = Object.fromEntries(db.prepare('SELECT provider, count(DISTINCT conversation) AS n FROM turns WHERE end_at > ? AND end_at <= ? GROUP BY provider')
      .all(since, now).map((row) => [row.provider ?? 'unknown', row.n]));
    return { ...empty, rows, chats };
  } catch { return { state: 'unavailable', days, since }; } finally { db.close(); }
}
