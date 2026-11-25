// A3: what the turns used, for the Usage window's Tokens and Cost views. Reads telemetry.db (telemetry.mjs, the watcher)
// read-only: one row per day, provider and model over the last 1, 7, 30 or 90 days, with an API-price estimate in dollars
// for Claude models in PRICES. Any other model, and every Codex turn, gets usd: null ("no price"), never $0.
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from './telemetry.mjs';

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

// days: one of RANGES (anything else is 7), the window ending at now. Days are the daemon's local dates. Scope: the turns
// the watcher recorded, of chats not deleted (a deleted chat's turns go with it, O35); a run the agent started itself (a
// 'usage' event, no turn) is not here, so these are estimates beside the Usage view's totals, not the same figure.
// exists: whether telemetry.db is there (the caller checks; the watcher makes it at the first turn it records). No file is
// no turns yet (empty rows). A file whose first replay has not finished is { state: 'rebuilding' }. Any other failure
// (busy, damaged, cannot open) is { state: 'unavailable' }, at once: the read never waits on a lock, as it runs on the
// daemon's one thread.
// Per row: turns; measured, the turns that reported any count; priced, the turns with all four counts and a price, the
// only ones in cost, usd and saved; estimated, the priced turns whose counts include calls outside the main loop
// (compactions, subagents), all priced at the chat's model though some may have run on another.
const WHOLE = 'input_tokens IS NOT NULL AND output_tokens IS NOT NULL AND cached_read_tokens IS NOT NULL AND cached_write_tokens IS NOT NULL';
export function readTurns({ file, exists, days, now = Date.now() }) {
  days = RANGES.includes(Number(days)) ? Number(days) : 7;
  const since = now - days * 86400000, empty = { state: 'ok', days, since, pricesAsOf: PRICES_AS_OF, rows: [], chats: {} };
  if (!exists) return empty;
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); } catch { return { state: 'unavailable', days, since }; }
  try {
    db.exec('PRAGMA busy_timeout = 0; BEGIN'); // one read snapshot for all three reads
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version !== SCHEMA) return { state: version === 0 ? 'rebuilding' : 'unavailable', days, since };
    const rows = db.prepare(`SELECT date(end_at / 1000, 'unixepoch', 'localtime') AS day, provider, model, profile, count(*) AS turns,
      sum(usage) AS measured, sum(${WHOLE}) AS whole, sum(${WHOLE} AND side_calls) AS sides,
      sum(input_tokens) AS input, sum(output_tokens) AS output, sum(cached_read_tokens) AS cacheRead,
      sum(cached_write_tokens) AS cacheWrite, sum(total_tokens) AS total,
      total(iif(${WHOLE}, input_tokens, 0)) AS p_input, total(iif(${WHOLE}, output_tokens, 0)) AS p_output,
      total(iif(${WHOLE}, cached_read_tokens, 0)) AS p_cacheRead, total(iif(${WHOLE}, cached_write_tokens, 0)) AS p_cacheWrite
      FROM turns WHERE end_at > ? AND end_at <= ? GROUP BY day, provider, model, profile ORDER BY day, provider, model, profile`).all(since, now).map((row) => {
      const price = priceOf(row), priced = price ? row.whole : 0;
      const p = (type) => row['p_' + type]; // the type's sum over the priced turns
      // cost: dollars by token type (the Cost view's bar). saved: what the cached tokens would have cost as plain input,
      // less what they cost as cache reads and writes; below zero when the writes' premium outran the reads' discount.
      const cost = priced ? Object.fromEntries(TYPES.map((type, i) => [type, p(type) * price[i] / 1e6])) : null;
      return { day: row.day, provider: row.provider, model: row.model, profile: row.profile === 1, turns: row.turns,
        measured: row.measured, priced, estimated: priced ? row.sides : 0,
        input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite, total: row.total,
        cost, usd: cost && TYPES.reduce((sum, type) => sum + cost[type], 0),
        saved: cost && ((p('cacheRead') + p('cacheWrite')) * price[0] - p('cacheRead') * price[2] - p('cacheWrite') * price[3]) / 1e6 };
    });
    // Chats are counted apart: one chat runs on several days and models, so the rows' counts would add it twice.
    const chats = Object.fromEntries(db.prepare('SELECT provider, count(DISTINCT conversation) AS n FROM turns WHERE end_at > ? AND end_at <= ? GROUP BY provider')
      .all(since, now).map((row) => [row.provider ?? 'unknown', row.n]));
    return { ...empty, rows, chats };
  } catch { return { state: 'unavailable', days, since }; } finally { db.close(); }
}
