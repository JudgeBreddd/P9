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

async function claude(claudeJson, statusLine, live, polled) {
  const found = [];
  // The daemon's own poll (claude-usage.mjs): utilization is already a percent there.
  const asked = polled && claudeWindows(polled.windows);
  if (asked && Number.isFinite(polled.at)) found.push({ ...asked, asOf: polled.at });
  // A P9 Claude chat's own reading (utilization is a fraction there); usage.py's sources are only as fresh as /usage or a status line.
  const scaled = (w) => w && typeof w === 'object' && typeof w.utilization === 'number' ? { ...w, utilization: Math.round(w.utilization * 1000) / 10 } : null;
  const windows = live && claudeWindows({ five_hour: scaled(live.windows.five_hour), seven_day: scaled(live.windows.seven_day) });
  if (windows && Number.isFinite(live.at)) found.push({ ...windows, asOf: live.at });
  try {
    const windows = claudeWindows(JSON.parse(await readFile(statusLine, 'utf8')).rate_limits);
    if (windows) found.push({ ...windows, asOf: (await stat(statusLine)).mtimeMs });
  } catch {}
  try {
    const cached = JSON.parse(await readFile(claudeJson, 'utf8')).cachedUsageUtilization;
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
  // The last 3 day folders by name, then every rollout in them newest-modified first: a session resumed today keeps its
  // old day's folder, so folder names alone would read a stale file.
  const dirs = [];
  walk: for (const year of await names(root)) for (const month of await names(path.join(root, year))) for (const day of await names(path.join(root, year, month))) {
    dirs.push(path.join(root, year, month, day));
    if (dirs.length === 3) break walk;
  }
  const files = [];
  for (const dir of dirs) for (const name of await names(dir)) if (name.endsWith('.jsonl')) files.push({ file: path.join(dir, name), at: (await stat(path.join(dir, name)).catch(() => ({ mtimeMs: 0 }))).mtimeMs });
  for (const { file } of files.sort((a, b) => b.at - a.at).slice(0, 20)) { // ponytail: gives up after 20 rollouts with no rate_limits event
    const found = await lastLimits(file).catch(() => null);
    if (found) return found;
  }
  return null;
}

// Where each agent keeps its files: CLAUDE_CONFIG_DIR and CODEX_HOME when set, else the defaults under home. Claude
// Code keeps .claude.json inside CLAUDE_CONFIG_DIR when that is set, and beside the folder (in home) when it is not.
export const agentDirs = (home, env = process.env) => ({
  claudeDir: env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), claudeJson: path.join(env.CLAUDE_CONFIG_DIR || home, '.claude.json'),
  codexHome: env.CODEX_HOME || path.join(home, '.codex') });

// P5: Claude Code compacts a chat once it holds CLAUDE_CODE_AUTO_COMPACT_WINDOW tokens when that is set (in its own
// environment or its settings.json "env"), so that is the chat's real window; the agent reports the model's full one.
// Only the number leaves this function.
export async function claudeWindow(claudeDir, env = process.env) {
  const tokens = (value) => { const n = Number(value); return Number.isSafeInteger(n) && n > 0 ? n : null; };
  if (tokens(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW)) return tokens(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
  try { return tokens(JSON.parse(await readFile(path.join(claudeDir, 'settings.json'), 'utf8'))?.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW); } catch { return null; }
}

export async function planLimits({ home, codexHome = agentDirs(home).codexHome, claudeJson = agentDirs(home).claudeJson, statusLine = path.join(home, '.cache', 'icm-usage', 'last-statusline.json'), claudeLive = null, claudePolled = null }) {
  const [claudeLimits, codexLimits] = await Promise.all([claude(claudeJson, statusLine, claudeLive, claudePolled), codex(codexHome)]);
  return { claude: claudeLimits, codex: codexLimits };
}
