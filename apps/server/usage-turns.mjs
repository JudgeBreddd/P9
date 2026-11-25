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

const priceOf = (provider, model) => (provider === 'claude' ? PRICES[model] ?? null : null);
const TYPES = ['input', 'output', 'cacheRead', 'cacheWrite'];

// days: one of RANGES (anything else is 7). Days are the daemon's local dates. The watcher makes telemetry.db at the first
// turn it records, so a file that cannot be opened means no turns yet: empty rows, not an error.
export function readTurns({ file, days, now = Date.now() }) {
  days = RANGES.includes(Number(days)) ? Number(days) : 7;
  const since = now - days * 86400000;
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); } catch { return { state: 'ok', days, since, pricesAsOf: PRICES_AS_OF, rows: [], chats: {} }; }
  try {
    db.exec('PRAGMA busy_timeout = 1000');
    const rows = db.prepare(`SELECT date(end_at / 1000, 'unixepoch', 'localtime') AS day, provider, model, count(*) AS turns,
      sum(input_tokens) AS input, sum(output_tokens) AS output, sum(cached_read_tokens) AS cacheRead,
      sum(cached_write_tokens) AS cacheWrite, sum(total_tokens) AS total
      FROM turns WHERE end_at >= ? GROUP BY day, provider, model ORDER BY day, provider, model`).all(since).map((row) => {
      const tokens = { input: row.input ?? 0, output: row.output ?? 0, cacheRead: row.cacheRead ?? 0, cacheWrite: row.cacheWrite ?? 0, total: row.total };
      // cost: dollars by token type (the Cost view's bar); saved: what the cache reads would have cost as plain input.
      const price = row.total == null ? null : priceOf(row.provider, row.model);
      const cost = price && Object.fromEntries(TYPES.map((type, i) => [type, tokens[type] * price[i] / 1e6]));
      return { day: row.day, provider: row.provider, model: row.model, turns: row.turns, ...tokens, cost,
        usd: cost ? TYPES.reduce((sum, type) => sum + cost[type], 0) : null, saved: price ? tokens.cacheRead * (price[0] - price[2]) / 1e6 : null };
    });
    // Chats are counted apart: one chat runs on several days and models, so the rows' counts would add it twice.
    const chats = Object.fromEntries(db.prepare('SELECT provider, count(DISTINCT conversation) AS n FROM turns WHERE end_at >= ? GROUP BY provider')
      .all(since).map((row) => [row.provider ?? 'unknown', row.n]));
    return { state: 'ok', days, since, pricesAsOf: PRICES_AS_OF, rows, chats };
  } finally { db.close(); }
}
