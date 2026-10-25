// Automatic rollback (AU5, threat model row 40). An installed build's start is healthy when its window is ready to show
// and the daemon's /health answers with the app's own version, both within 180 s. update-state.json in the profile folder
// keeps the versions seen healthy and the failed starts of the others. A version never seen healthy that fails 2 starts
// goes back to the newest healthy one: main starts the launcher outside the install (scripts/launcher/p9-launch.*), which
// puts that version back and starts it, and the restored version shows what happened once, with a prefilled bug report.
// No agent code: it works the same whichever agents are installed.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readFile, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { issueLink } from '../server/anymouse.mjs';

// 180 s, not less: a first daemon start has taken 90 s on CI, and a slow machine must not roll back a working update.
export const START_MS = 180_000, TRIES = 2;
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const isVersion = (value) => typeof value === 'string' && VERSION.test(value);

// P9's folder outside the install: the launcher, daemon copies, kept installers, rollback.json and rollback.log.
export const shareRoot = (platform = process.platform, env = process.env) => platform === 'win32'
  ? path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'P9') : path.join(os.homedir(), '.local', 'share', 'p9');

// { healthy: newest first, at most 5; failed: { version: starts }; pending: the start under way; skip: rolled back from }.
// Anything unreadable starts over empty: the worst case is one more try before a rollback.
export function readState(file) {
  let saved = {};
  try { saved = JSON.parse(readFileSync(file, 'utf8')) ?? {}; } catch {}
  const failed = {};
  for (const [version, count] of Object.entries(saved.failed ?? {})) if (isVersion(version) && Number.isInteger(count) && count > 0) failed[version] = count;
  return { healthy: Array.isArray(saved.healthy) ? saved.healthy.filter(isVersion).slice(0, 5) : [], failed,
    pending: isVersion(saved.pending) ? saved.pending : null, skip: isVersion(saved.skip) ? saved.skip : null };
}
// Sync on purpose: the broken version writes it just before it quits for a rollback.
export function writeState(file, state) {
  writeFileSync(file + '.tmp', JSON.stringify(state));
  renameSync(file + '.tmp', file);
}

// The version to go back to, or null.
export function backTo(state, version) {
  if (state.healthy.includes(version) || (state.failed[version] ?? 0) < TRIES) return null;
  return state.healthy.find((other) => other !== version) ?? null;
}
const count = (state, version) => {
  if (!state.healthy.includes(version)) state.failed[version] = (state.failed[version] ?? 0) + 1;
  state.pending = null;
};
// A start. One still pending was never healthy, never timed out and never quit: it crashed or was killed, which counts as failed.
export function begin(state, version) {
  if (state.pending) count(state, state.pending);
  state.pending = version;
  return backTo(state, version);
}
// START_MS went by without a healthy start (a hang, or the daemon answering another version). Strict: the same run turning healthy later is not counted.
// Not pending any more: the user quit first (the timer ran out while P9 was still stopping), so it is not counted.
export function timedOut(state, version) {
  if (state.pending !== version) return null;
  count(state, version);
  return backTo(state, version);
}
// The user quit, or closed the last window, before the start was healthy: not a failed start, so it is not counted.
export function quit(state, version) {
  if (state.pending !== version) return false;
  state.pending = null;
  return true;
}
export function healthy(state, version) {
  state.pending = null;
  delete state.failed[version];
  state.healthy = [version, ...state.healthy.filter((other) => other !== version)].slice(0, 5);
}
// The next check skips this version; a reinstall of it by hand gets its 2 tries again.
export function rolledBack(state, version) {
  state.pending = null;
  delete state.failed[version];
  state.skip = version;
}

// Resolves true once ready has resolved and health() answered { version }, false after ms.
export function startHealthy({ version, ready, health, ms = START_MS, every = 1000 }) {
  let over = false;
  const daemon = (async () => {
    while (!over) {
      if ((await health().catch(() => null))?.version === version) return;
      await new Promise((resolve) => setTimeout(resolve, every));
    }
  })();
  let timer;
  return Promise.race([Promise.all([ready, daemon]).then(() => true), new Promise((resolve) => { timer = setTimeout(resolve, ms, false); })])
    .finally(() => { over = true; clearTimeout(timer); });
}

// The launcher's rollback run. Windows: wait for this app to quit, run the version's kept installer (or the release's,
// checked against its latest.yml) with /S, set daemon\current back, start the app. Linux: copy the kept AppImage over this
// one, set daemon/current back, restart the daemon, start it. The launcher checks every value again.
export function launcherCommand({ to, from, platform = process.platform, env = process.env, share = shareRoot(platform, env),
  exe = process.execPath, arch = process.arch, pid = process.pid }) {
  if (![to, from].every(isVersion)) throw new Error('version-refused');
  if (platform === 'win32') {
    // conhost --headless, as the P9 Foundation task runs its host: a detached spawn (DETACHED_PROCESS) gives powershell.exe
    // no console, and it then exits 0 without running -File (GitHub run 40170347685, events 4688/4689). Windows 10 1809+.
    const system = path.join(env.SystemRoot || 'C:\\Windows', 'System32');
    return { file: path.join(system, 'conhost.exe'),
      args: ['--headless', path.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), '-NoLogo', '-NoProfile', '-NonInteractive',
        '-ExecutionPolicy', 'Bypass', '-File', path.join(share, 'launcher', 'p9-launch.ps1'),
        '-Rollback', '-To', to, '-From', from, '-App', exe, '-Arch', arch, '-AppPid', String(pid)], env };
  }
  // The AppImage's mount, and its PATH entries, go once it quits (teh.mjs appImageService does the same).
  const { APPDIR, APPIMAGE, ARGV0, OWD, ...rest } = env;
  return { file: '/bin/sh', args: [path.join(share, 'launcher', 'p9-launch.sh'), '--rollback', to, from, APPIMAGE ?? '', String(pid)],
    env: { ...rest, PATH: (env.PATH ?? '').split(':').filter((entry) => !APPDIR || !entry.startsWith(APPDIR)).join(':') } };
}

// After a healthy start, the launcher this version brought replaces the one before it.
export async function promoteLauncher(share = shareRoot(), platform = process.platform) {
  const launcher = path.join(share, 'launcher', platform === 'win32' ? 'p9-launch.ps1' : 'p9-launch.sh');
  return rename(launcher + '.next', launcher).then(() => true, () => false);
}

// The launcher's record of the last rollback, or null: { from, to, at, installer, shown }.
export async function readRollback(share = shareRoot()) {
  try {
    const record = JSON.parse(await readFile(path.join(share, 'rollback.json'), 'utf8'));
    return isVersion(record?.from) && isVersion(record?.to) ? record : null;
  } catch { return null; }
}
export const markShown = (share, record) => writeState(path.join(share, 'rollback.json'), { ...record, shown: true });

const tail = (text, lines) => text.split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
// What the dialog shows and the report carries, before sanitize().
export async function rollbackLog({ share = shareRoot(), profile }) {
  const read = (file) => readFile(file, 'utf8').catch(() => '');
  return [`rollback.json: ${(await read(path.join(share, 'rollback.json'))).trim()}`,
    `update-state.json: ${(await read(path.join(profile, 'update-state.json'))).trim()}`,
    'rollback.log:', tail(await read(path.join(share, 'rollback.log')), 30),
    'p9-update.log (end):', tail(await read(path.join(profile, 'p9-update.log')), 40)].join('\n');
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const word = (name, flags) => new RegExp(`(?<![\\w-])${escape(name)}(?![\\w-])`, flags);
// Removes what would name this user or machine, or let someone in, from text bound for a public issue (threat model row 40 (e)).
// home: the home folder; user and host: the account and machine names. Folder and file names under home stay, as "~/...".
export function sanitize(text, { home = os.homedir(), user = os.userInfo().username, host = os.hostname(), platform = process.platform } = {}) {
  const flags = platform === 'win32' ? 'gi' : 'g';
  let out = String(text);
  if (home && home.length > 1) {
    const forms = new Set([home, home.replaceAll('\\', '/'), home.replaceAll('/', '\\'), home.replaceAll('\\', '\\\\'), home.replaceAll('/', '\\\\')]);
    for (const form of [...forms].sort((a, b) => b.length - a.length)) out = out.replace(new RegExp(escape(form), flags), '~');
  }
  out = out
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{8,})/g, '<token>')
    .replace(/\b(bearer)\s+[^\s"',;]+/gi, '$1 <token>')
    .replace(/\b(token|cookie|authorization|password|passwd|secret|api[_-]?key)(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi, '$1$2<token>')
    .replace(/\b(p9=)[^\s"',;&]+/gi, '$1<token>') // the desktop cookie
    .replace(/(?<![\w+=-])(?=[A-Za-z0-9+_=-]*\d)(?=[A-Za-z0-9+_=-]*[A-Za-z])[A-Za-z0-9+_=-]{32,}/g, '<token>')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>')
    .replace(/(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g, '<ip>')
    // IPv6: 2 to 7 colons; "12:34:56" (a time) has no letter, no "::" and too few colons, so it stays.
    .replace(/(?<![\w:])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![\w:])/g, (match) =>
      (match.match(/:/g).length >= 3 || match.includes('::') || /[A-Fa-f]/.test(match)) && /[0-9A-Fa-f]/.test(match) ? '<ip>' : match);
  // Host before user: a machine named after its owner ("sam-laptop") goes whole.
  for (const [name, mark] of [[host, '<host>'], [user, '<user>']]) if (name && name.length > 1) out = out.replace(word(name, 'gi'), mark);
  return out;
}

const INSTALL = { 'win32 x64': 'Windows installer (x64)', 'win32 arm64': 'Windows installer (arm64)', 'linux x64': 'Linux AppImage', 'linux arm64': 'Linux AppImage' };
// GitHub's prefilled bug form (.github/ISSUE_TEMPLATE/bug.yml field ids) with the sanitized log, cut to fit a link.
export function reportLink({ from, to, log, platform = process.platform, arch = process.arch }) {
  return issueLink({ template: 'bug.yml', title: `P9 ${from} did not start, P9 went back to ${to}`,
    what: `P9 updated itself to ${from}, which did not start twice, so P9 went back to ${to} on its own.`,
    version: from, install: INSTALL[`${platform} ${arch}`] ?? 'Other', doctor: log }, 'doctor', '[cut to fit a link]').link;
}
