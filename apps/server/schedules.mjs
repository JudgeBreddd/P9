// O140: prompts the daemon sends at a time, once or every so many minutes (Tyler, 2026-11-16: "that would make P9 the
// engine and its up as long as the deamon is up"). Kept in the ledger's database, so a restart keeps them; a run missed
// while P9 was down goes once when it is back, not once per missed run. fire(schedule) sends one; what it answered is
// kept as the schedule's last result. A once prompt is gone from the list as it is sent.
import { randomUUID } from 'node:crypto';

export const SCHEDULE_TEXT_MAX = 4000, SCHEDULES_MAX = 20, EVERY_MIN = 1, EVERY_MAX = 7 * 24 * 60; // minutes
const MINUTE = 60_000, CHECK_MS = 60_000; // the timer is armed at most a minute ahead, so a changed clock is caught

export function createSchedules({ db, fire, now = () => Date.now() }) {
  db.exec(`CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, owner TEXT NOT NULL, chat TEXT NOT NULL, text TEXT NOT NULL,
    every INTEGER, next INTEGER NOT NULL, paused INTEGER NOT NULL DEFAULT 0, last TEXT) STRICT`);
  let timer = null, firing = false;
  const shown = (row) => ({ id: row.id, chat: row.chat, text: row.text, ...(row.every ? { everyMinutes: row.every } : { once: true }),
    nextRun: new Date(row.next).toISOString(), paused: Boolean(row.paused), ...(row.last && { last: row.last }) });
  const get = (owner, id) => db.prepare('SELECT * FROM schedules WHERE owner = ? AND id = ?').get(owner, id);

  function arm() {
    clearTimeout(timer);
    const first = db.prepare('SELECT min(next) AS next FROM schedules WHERE paused = 0').get().next;
    if (first === null || first === undefined) return;
    timer = setTimeout(run, Math.max(0, Math.min(first - now(), CHECK_MS)));
    timer.unref?.();
  }
  async function run() {
    if (firing) return;
    firing = true;
    try {
      for (const row of db.prepare('SELECT * FROM schedules WHERE paused = 0 AND next <= ? ORDER BY next').all(now())) {
        // Moved on (or gone) before it is sent, so a send that throws or a crash mid-send never sends it twice.
        if (row.every) {
          const step = row.every * MINUTE, missed = Math.floor((now() - row.next) / step) + 1;
          db.prepare('UPDATE schedules SET next = ? WHERE id = ?').run(row.next + missed * step, row.id);
        } else db.prepare('DELETE FROM schedules WHERE id = ?').run(row.id);
        const sent = await Promise.resolve(fire(row)).catch((error) => ({ error: error?.message ?? 'send-failed' }));
        const last = new Date(now()).toISOString() + ' ' + (sent?.error ? 'not sent: ' + sent.error + (sent.reason ? ' (' + sent.reason + ')' : '') : 'sent');
        db.prepare('UPDATE schedules SET last = ? WHERE id = ?').run(last, row.id);
      }
    } finally { firing = false; arm(); }
  }

  // at: an ISO time; every: whole minutes. A new one needs text and at least one of them; with id, any field changes.
  function save(owner, args, target) {
    const old = args.id === undefined ? null : get(owner, args.id);
    if (args.id !== undefined && !old) return { error: 'schedule-not-found' };
    if (args.text !== undefined && (typeof args.text !== 'string' || !args.text.trim() || args.text.length > SCHEDULE_TEXT_MAX)) return { error: 'request-refused', detail: 'text: 1 to ' + SCHEDULE_TEXT_MAX + ' characters.' };
    if (args.every !== undefined && args.every !== null && (!Number.isInteger(args.every) || args.every < EVERY_MIN || args.every > EVERY_MAX)) return { error: 'request-refused', detail: 'every: whole minutes, ' + EVERY_MIN + ' to ' + EVERY_MAX + ', or null for once.' };
    const at = args.at === undefined ? undefined : Date.parse(args.at);
    if (at !== undefined && (typeof args.at !== 'string' || !Number.isFinite(at) || at > now() + 366 * 24 * 60 * MINUTE)) return { error: 'request-refused', detail: 'at: an ISO time within a year, like 2026-11-17T09:30:00Z.' };
    if (args.paused !== undefined && typeof args.paused !== 'boolean') return { error: 'request-refused', detail: 'paused: true or false.' };
    if (!old) {
      if (args.text === undefined) return { error: 'request-refused', detail: 'text is required.' };
      if (at === undefined && !args.every) return { error: 'request-refused', detail: 'Give at (a time), every (minutes), or both.' };
      if (db.prepare('SELECT count(*) AS n FROM schedules WHERE owner = ?').get(owner).n >= SCHEDULES_MAX) return { error: 'too-many-schedules', detail: 'At most ' + SCHEDULES_MAX + ' per chat: remove_schedule one first.' };
      const id = randomUUID();
      db.prepare('INSERT INTO schedules (id, owner, chat, text, every, next, paused) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, owner, target, args.text, args.every ?? null, at ?? now() + args.every * MINUTE, args.paused ? 1 : 0);
      arm();
      return { action: 'scheduled', ...shown(get(owner, id)) };
    }
    const every = args.every === undefined ? old.every : args.every;
    // Resumed after its time: a recurring one goes on from now, not with every run it missed.
    const next = at ?? (args.paused === false && old.paused && every && old.next < now() ? now() + every * MINUTE : old.next);
    db.prepare('UPDATE schedules SET text = ?, every = ?, next = ?, paused = ? WHERE id = ?')
      .run(args.text ?? old.text, every, next, args.paused === undefined ? old.paused : args.paused ? 1 : 0, old.id);
    arm();
    return { action: 'changed', ...shown(get(owner, old.id)) };
  }

  arm();
  return {
    save,
    list: (owner) => db.prepare('SELECT * FROM schedules WHERE owner = ? ORDER BY next').all(owner).map(shown),
    remove: (owner, id) => {
      if (!get(owner, id)) return { error: 'schedule-not-found' };
      db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
      arm();
      return { action: 'removed', id };
    },
    stop: () => clearTimeout(timer),
  };
}
