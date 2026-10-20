// The plan limits (5 h and 7 d used %) as Claude Code and Codex record them, never estimated. Same sources as the
// workspace's usage script: Claude from the last saved status-line input (if a status-line script saves one) or
// ~/.claude.json cachedUsageUtilization (written when /usage or the usage panel runs), whichever is newer; Codex from
// the newest rate_limits event in its session logs (written every turn).
import { open, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const TAIL = 512 * 1024; // token_count events come every turn, so the last one is near the end of a rollout file
const seconds = (value) => typeof value === 'string' ? Date.parse(value) / 1000 : value > 1e12 ? value / 1000 : value;
function windowOf(used, resets) {
  if (!Number.isFinite(used) || used < 0) return null;
  const at = seconds(resets);
  return { usedPercent: used, resetsAt: Number.isFinite(at) ? Math.round(at * 1000) : null };
}
// { five_hour: {...}, seven_day: {...} } with used_percentage / used_percent / utilization, as usage.py accepts.
function claudeWindows(limits) {
  const one = (w) => w && typeof w === 'object' ? windowOf(w.used_percentage ?? w.used_percent ?? w.utilization, w.resets_at ?? w.resetsAt) : null;
  const fiveHour = one(limits?.five_hour), sevenDay = one(limits?.seven_day);
  return fiveHour || sevenDay ? { fiveHour, sevenDay } : null;
}

async function claude(home, statusLine, live) {
  const found = [];
  // A P9 Claude chat's own reading (utilization is a fraction there); usage.py's sources are only as fresh as /usage or a status line.
  const scaled = (w) => w && typeof w === 'object' && typeof w.utilization === 'number' ? { ...w, utilization: Math.round(w.utilization * 1000) / 10 } : null;
  const windows = live && claudeWindows({ five_hour: scaled(live.windows.five_hour), seven_day: scaled(live.windows.seven_day) });
  if (windows && Number.isFinite(live.at)) found.push({ ...windows, asOf: live.at });
  try {
    const windows = claudeWindows(JSON.parse(await readFile(statusLine, 'utf8')).rate_limits);
    if (windows) found.push({ ...windows, asOf: (await stat(statusLine)).mtimeMs });
  } catch {}
  try {
    const cached = JSON.parse(await readFile(path.join(home, '.claude.json'), 'utf8')).cachedUsageUtilization;
    const windows = claudeWindows(cached?.utilization);
    if (windows && Number.isFinite(cached.fetchedAtMs)) found.push({ ...windows, asOf: cached.fetchedAtMs });
  } catch {}
  return found.sort((a, b) => b.asOf - a.asOf)[0] ?? null;
}

// Newest rollout files first (sessions/YYYY/MM/DD/*.jsonl); the first with a rate_limits event wins.
const tails = new Map(); // ponytail: never evicts (one small entry per rollout file read); cap it if the daemon runs for months
async function lastLimits(file) {
  const info = await stat(file), key = info.size + ':' + info.mtimeMs;
  if (tails.get(file)?.key === key) return tails.get(file).found;
  const handle = await open(file, 'r');
  let text;
  try {
    const length = Math.min(info.size, TAIL), buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    text = buffer.toString('utf8');
  } finally { await handle.close(); }
  let found = null;
  for (const line of text.split('\n').reverse()) {
    if (!line.includes('"rate_limits"')) continue;
    try {
      const event = JSON.parse(line), limits = event.payload?.rate_limits;
      if (!limits) continue;
      const byMinutes = (minutes) => [limits.primary, limits.secondary].find((w) => w?.window_minutes === minutes);
      const five = byMinutes(300), week = byMinutes(10080);
      found = { fiveHour: five ? windowOf(five.used_percent, five.resets_at) : null, sevenDay: week ? windowOf(week.used_percent, week.resets_at) : null, asOf: Date.parse(event.timestamp) || info.mtimeMs };
      if (found.fiveHour || found.sevenDay) break;
      found = null;
    } catch {} // a line cut by the tail window, or malformed
  }
  tails.set(file, { key, found });
  return found;
}
async function codex(codexHome) {
  const names = async (dir) => (await readdir(dir).catch(() => [])).sort().reverse();
  const root = path.join(codexHome, 'sessions');
  let checked = 0;
  for (const year of await names(root)) for (const month of await names(path.join(root, year))) for (const day of await names(path.join(root, year, month))) {
    const dir = path.join(root, year, month, day);
    const files = await Promise.all((await names(dir)).filter((name) => name.endsWith('.jsonl')).map(async (name) => ({ file: path.join(dir, name), at: (await stat(path.join(dir, name)).catch(() => ({ mtimeMs: 0 }))).mtimeMs })));
    for (const { file } of files.sort((a, b) => b.at - a.at)) {
      const found = await lastLimits(file).catch(() => null);
      if (found) return found;
      if (++checked >= 20) return null; // ponytail: gives up after 20 rollouts with no rate_limits event
    }
  }
  return null;
}

export async function planLimits({ home, codexHome = path.join(home, '.codex'), statusLine = path.join(home, '.cache', 'icm-usage', 'last-statusline.json'), claudeLive = null }) {
  const [claudeLimits, codexLimits] = await Promise.all([claude(home, statusLine, claudeLive), codex(codexHome)]);
  return { claude: claudeLimits, codex: codexLimits };
}
