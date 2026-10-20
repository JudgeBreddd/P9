// The old workspace-hub's Mission sections (notifications, Wiki inbox, weekly audit, logs, incidents, work in flight,
// last solo run), computed here from the same files workspace-hub's mission_control.py reads (ported in Phase 16;
// there is no Python bridge any more). Everything is a read except decide(), which rewrites one review: line in the
// vault's Wiki inbox. Fixed argv, no shell, allowlisted env; the client only ever sends a section name and names
// checked by regex here.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { open, readFile as readText, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { childEnv } from './child-env.mjs';
import { stillAuthorized } from './authority.mjs';
import { readFile } from '../../packages/files/index.mjs';

const HOST = /^[\w.-]{1,64}$/;
const LOG = /^(?:[\w-]+\/)?[\w.-]+\.log$/; // <host>/<job>.log = a log another machine sends here
const SAFE_NAME = /^[\w.-]+\.(?:log|md)$/;
const INCIDENT = /^[\w.-]+\.md$/;
const BRANCH = /^librarian-[\w.-]{1,120}$/;
const PROJECT = /^[\w.-]+(?:\/[\w.-]+){0,6}$/;
const DECISION = /^review:\s*["']?(\w+)["']?/m;
const INC_HEAD = /^# Incident: (\S+) on .*?, (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)/;
const INC_FILE = /^\d{4}-\d\d-\d\d-(.+?)(?:-\d{6})?\.md$/;
const STAMP = /\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/;
const AUDIT_RUN = /^\d{4}-\d{2}-\d{2}$/;
const BREAK = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/; // the line breaks Python's splitlines() knows
// Folders the hub's queue never looks in (mission_control.py SKIP).
const SKIP = new Set(['_archive', '_private', 'node_modules', '.venv', 'recommended-delete', '_intake', '_templates', 'templates']);
// One ssh call each: every server log's name, change time and last line; every server incident's name, first line and
// Resolved line (tabs in a line become spaces).
const SERVER_LS = "cd ~/icm-logs 2>/dev/null && for f in *.log; do [ -f \"$f\" ] && printf '%s\\t%s\\t%s\\n' \"$f\" "
  + "\"$(stat -c %Y \"$f\")\" \"$(tail -n1 \"$f\" | tr '\\t' ' ' | cut -c1-160)\"; done";
const SERVER_INC = "cd ~/icm-logs/incidents 2>/dev/null && for f in *.md; do [ -f \"$f\" ] && printf '%s\\t%s\\t%s\\n' \"$f\" "
  + "\"$(head -n1 \"$f\" | tr '\\t' ' ')\" \"$(grep -m1 -F '**Resolved:**' \"$f\" | tr '\\t' ' ')\"; done";
const FAST_TTL = 60 * 1000;
const NOTICES_TTL = 10 * 60 * 1000;

const lines = (text) => { const out = text.split(BREAK); if (out.at(-1) === '') out.pop(); return out; };
const tail = (text, n) => text.split(/(?<=\r\n|[\n\v\f\x1c-\x1e\x85\u2028\u2029]|\r(?!\n))/).filter(Boolean).slice(-n).join('');
const cut = (text, n) => Array.from(text).slice(0, n).join('');
// "a\tb\tc\td" -> ["a", "b", "c\td"], as Python's split("\t", 2).
const split3 = (line) => { const [a, b, ...rest] = line.split('\t'); return [a, b, rest.join('\t')]; };
const tabs = (line) => line.split('\t').length - 1;
const minutesAgo = (ms) => Math.floor((Date.now() - ms) / 60000);
const missing = () => Object.assign(new Error('hub-failed'), { status: 404 });
const entries = (dir) => readdir(dir, { withFileTypes: true }).catch(() => []);
const statOf = (file) => stat(file).catch(() => null);
const isFile = async (file) => (await statOf(file))?.isFile() ?? false;
// Python sorts paths part by part, so "a/b.md" comes before "a.md".
const byParts = (a, b) => { const x = a.split(path.sep), y = b.split(path.sep);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return x.length - y.length; };

async function walk(dir, match, skip = () => false, found = []) {
  for (const entry of await entries(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (!skip(entry.name)) await walk(full, match, skip, found); } else if (match(entry.name)) found.push(full);
  }
  return found;
}

// One value from this machine's ~/.claude/continuity-kit.env (never synced).
function kitEnv(key) {
  try {
    for (const line of readFileSync(path.join(os.homedir(), '.claude', 'continuity-kit.env'), 'utf8').split('\n')) {
      const at = line.indexOf('=');
      if (at >= 0 && line.slice(0, at).trim() === key) return line.slice(at + 1).trim().replace(/^["']|["']$/g, '');
    }
  } catch {}
  return '';
}

// Runs a fixed command and returns its output whatever its exit code, as subprocess.run does; a timeout fails.
const output = (command, args, { cwd, timeout }) => new Promise((resolve, reject) => {
  execFile(command, args, { cwd, shell: false, env: childEnv(), timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
    if (error && typeof error.code !== 'number') return reject(error);
    resolve({ stdout: String(stdout), ok: !error });
  });
});

export function createHub({ workspace, settings }) {
  const folder = settings?.hub ? path.join(workspace, settings.hub) : null;
  const logsDir = process.env.ICM_LOG_DIR || path.join(os.homedir(), 'icm-logs');
  // No default vault: the Wiki inbox section stays empty until MC_VAULT or the kit's WIKI_PATH names one.
  const vault = process.env.MC_VAULT || kitEnv('WIKI_PATH');
  const inboxDir = vault ? path.join(vault, 'Review', 'Inbox') : null;
  const auditDir = path.join(workspace, 'personal-projects', 'llm-wiki-librarian');
  const scripts = path.join(workspace, '_system', 'scripts');
  const host = os.hostname().split('.')[0];
  // No default: a reader with no second machine sees only this one until settings name one (mission settings "server_host").
  const SERVER = settings?.server_host || '';
  const remote = Boolean(SERVER) && host !== SERVER; // a laptop or desktop also lists the named server's logs and incidents
  const ssh = (command) => output('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', SERVER, command], { cwd: workspace, timeout: 15000 })
    .then(({ stdout, ok }) => ok ? stdout : '', () => '');

  async function lastSolo() {
    const dir = path.join(workspace, '_private', 'solo-runs');
    const reports = [];
    for (const entry of await entries(dir)) if (entry.name.endsWith('.md')) reports.push({ name: entry.name, file: path.join(dir, entry.name), at: (await statOf(path.join(dir, entry.name)))?.mtimeMs ?? 0 });
    reports.sort((a, b) => a.at - b.at);
    const last = reports.at(-1);
    if (!last) return { name: '', path: '', bluf: '' };
    const found = /BLUF:?\**\s*(.+)/.exec(await readText(last.file, 'utf8').catch(() => ''));
    return { name: last.name, path: last.file, bluf: found ? found[1].trim() : '' };
  }
  async function handoffs() {
    const files = await walk(workspace, (name) => name === 'HANDOFF.md', (name) => SKIP.has(name));
    const rows = await Promise.all(files.map(async (file) => {
      const info = await statOf(file);
      return info && { project: path.relative(workspace, path.dirname(file)) || '.', path: file, age_days: Math.round((Date.now() - info.mtimeMs) / 86400000) };
    }));
    return rows.filter(Boolean).sort((a, b) => a.project < b.project ? -1 : a.project > b.project ? 1 : 0);
  }
  const count = async (dir) => (await entries(dir)).filter((entry) => entry.name.endsWith('.md') && entry.name !== 'CLAUDE.md').length;

  async function inbox() {
    const batches = [];
    if (!inboxDir) return batches;
    const names = (await entries(inboxDir)).map((entry) => entry.name).filter((name) => name.startsWith('librarian-')).sort();
    for (const branch of names) {
      const decision = path.join(inboxDir, branch, '_decision.md');
      if (!await statOf(decision)) continue;
      const found = DECISION.exec(await readText(decision, 'utf8').catch(() => ''));
      const pages = await walk(path.join(inboxDir, branch), (name) => name.endsWith('.md') && name !== '_decision.md');
      batches.push({ branch, decision: found ? found[1] : 'pending', path: decision, pages: pages.map((page) => path.basename(page)).sort() });
    }
    return batches;
  }
  async function inboxText(branch) {
    if (!inboxDir) throw missing();
    const dir = path.join(inboxDir, branch);
    if (!(await statOf(dir))?.isDirectory()) throw missing();
    const parts = [await readText(path.join(dir, '_decision.md'), 'utf8').catch(() => { throw missing(); })];
    for (const page of (await walk(dir, (name) => name.endsWith('.md') && name !== '_decision.md')).map((file) => path.relative(dir, file)).sort(byParts))
      parts.push(`\n\n---\n\n## ${page}\n\n` + await readText(path.join(dir, page), 'utf8'));
    return parts.join('');
  }

  // The newest weekly Wiki audit run: its review state and how many changes are ticked.
  async function audit() {
    const runsDir = path.join(auditDir, '_private', 'audit', 'runs');
    const runs = [];
    for (const entry of await entries(runsDir)) if (AUDIT_RUN.test(entry.name) && await isFile(path.join(runsDir, entry.name, '_decision.md'))) runs.push(entry.name);
    const run = runs.sort().at(-1);
    if (!run) return {};
    const decisionFile = path.join(runsDir, run, '_decision.md');
    const decision = await readText(decisionFile, 'utf8');
    const review = /^review:\s*(\w+)/m.exec(decision);
    const contra = path.join(auditDir, '_private', 'audit', 'contradictions', run + '.md');
    const hasContra = await isFile(contra);
    const counted = hasContra ? /(\d+) contradictions/.exec(await readText(contra, 'utf8')) : null;
    return { run, review: review ? review[1] : 'pending', path: decisionFile,
      changes: (decision.match(/^- \[[x ]\] /gm) ?? []).length, ticked: (decision.match(/^- \[x\] /gm) ?? []).length,
      contradictions: hasContra ? contra : '', contradiction_count: counted ? Number(counted[1]) : null,
      contradictions_sent: !!await statOf(path.join(workspace, '_ideas', 'needs-done', `wiki-contradictions-${run}.md`)) };
  }

  async function logs() {
    const names = [];
    for (const entry of await entries(logsDir)) {
      if (entry.name.endsWith('.log') && !entry.isDirectory()) names.push(entry.name);
      if (entry.isDirectory()) for (const sub of await entries(path.join(logsDir, entry.name))) if (sub.name.endsWith('.log')) names.push(entry.name + '/' + sub.name);
    }
    const files = (await Promise.all(names.map(async (name) => ({ name, info: await statOf(path.join(logsDir, name)) }))))
      .filter((file) => file.info?.isFile()).sort((a, b) => b.info.mtimeMs - a.info.mtimeMs).slice(0, 40);
    const out = [];
    for (const { name, info } of files) {
      const handle = await open(path.join(logsDir, name));
      try {
        const length = Math.min(400, info.size), buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, info.size - length);
        out.push({ host, name, age_min: minutesAgo(info.mtimeMs), last: cut(lines(buffer.toString('utf8').trim()).at(-1) ?? '', 160) });
      } finally { await handle.close(); }
    }
    if (remote) {
      for (const [name, time, last] of lines(await ssh(SERVER_LS)).filter((line) => tabs(line) >= 2).map(split3))
        if (LOG.test(name) && /^\d+$/.test(time)) out.push({ host: SERVER, name, age_min: Math.floor((Date.now() / 1000 - Number(time)) / 60), last });
    }
    return out.sort((a, b) => a.age_min - b.age_min); // the page groups them by machine
  }
  async function logTail(name, logHost) {
    if (!LOG.test(name)) throw missing();
    if (logHost === SERVER && remote) return await ssh(`tail -n 200 ~/icm-logs/${name}`) || '(could not read it from the server)';
    if (!await isFile(path.join(logsDir, name))) throw missing();
    return tail(await readText(path.join(logsDir, name), 'utf8'), 200);
  }

  // doctor.sh --fix incidents, one entry per check per machine (Builder, 2026-10-16: "15 business MCP failures" become one):
  // how many, when each failed, and the last time doctor saw it pass. Open first, newest failure first within each.
  async function incidents() {
    const rows = []; // [host, file name, first line, Resolved line]
    for (const entry of await entries(path.join(logsDir, 'incidents'))) {
      if (!entry.name.endsWith('.md')) continue;
      const text = await readText(path.join(logsDir, 'incidents', entry.name), 'utf8');
      rows.push([host, entry.name, text.split('\n')[0], lines(text).find((line) => line.includes('**Resolved:**')) ?? '']);
    }
    if (remote) for (const line of lines(await ssh(SERVER_INC))) if (tabs(line) >= 2 && SAFE_NAME.test(line.split('\t')[0])) rows.push([SERVER, ...split3(line)]);
    const groups = new Map();
    for (const [machine, name, head, done] of rows) {
      const m = INC_HEAD.exec(head), f = INC_FILE.exec(name);
      const check = m ? m[1] : f ? f[1] : name.slice(0, -3);
      const key = machine + '\0' + check;
      if (!groups.has(key)) groups.set(key, { host: machine, check, failed: [], cleans: [], open: 0 });
      const group = groups.get(key);
      group.failed.push([m ? m[2] : name.slice(0, 10), name]);
      if (!done) group.open++;
      const clean = done && STAMP.exec(done);
      if (clean) group.cleans.push(clean[0]);
    }
    const out = [...groups.values()].map((group) => {
      group.failed.sort((a, b) => a[0] !== b[0] ? (a[0] < b[0] ? 1 : -1) : a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0);
      return { host: group.host, check: group.check, name: group.failed[0][1], resolved: !group.open, count: group.failed.length,
        failed: group.failed.map(([time]) => time), last_clean: group.cleans.length ? group.cleans.reduce((a, b) => b > a ? b : a) : null };
    });
    out.sort((a, b) => a.failed[0] < b.failed[0] ? 1 : a.failed[0] > b.failed[0] ? -1 : 0);
    return out.sort((a, b) => a.resolved - b.resolved);
  }
  async function incidentText(machine, name) {
    if (!SAFE_NAME.test(name)) throw missing();
    if (machine === host) {
      const file = path.join(logsDir, 'incidents', name);
      if (!await isFile(file)) throw missing();
      return readText(file, 'utf8');
    }
    if (machine === SERVER && remote) return await ssh(`cat ~/icm-logs/incidents/${name}`) || '(could not read it from the server)';
    throw missing();
  }

  // Lines that need Builder: silent scheduled jobs (here and on the server) and doctor.sh FAIL lines.
  async function notices() {
    const [overdue, server, doctor] = await Promise.all([
      output('bash', [path.join(scripts, 'heartbeats.sh'), 'overdue'], { cwd: workspace, timeout: 20000 }),
      output('bash', [path.join(scripts, 'heartbeats.sh'), 'remote'], { cwd: workspace, timeout: 20000 }),
      output('bash', [path.join(scripts, 'doctor.sh'), '--quiet'], { cwd: workspace, timeout: 120000 })]);
    const jobs = [overdue, server].flatMap(({ stdout }) => lines(stdout).filter((line) => line.startsWith('OVERDUE'))
      .map((line) => ({ kind: 'job', text: line.replaceAll('OVERDUE', '').trim() })));
    const setup = lines(doctor.stdout.split('=== FAILURES ===')[0]).filter((line) => line.startsWith('FAIL')) // the recap repeats them
      .map((line) => ({ kind: 'setup', text: line.replace(/^\S+\s*/, '') || line.trim() }));
    return [...jobs, ...setup];
  }

  async function fastSections() {
    const [flight, solo, ideas, needs, batches, weekly, logRows, incidentRows] = await Promise.all([handoffs(), lastSolo(),
      count(path.join(workspace, '_ideas')), count(path.join(workspace, '_ideas', 'needs-done')), inbox(), audit(), logs(), incidents()]);
    return { handoffs: flight, ideas, needs_done: needs, solo, inbox: batches, audit: weekly, logs: logRows, incidents: incidentRows, host };
  }

  // Each cache keeps the last answer and refreshes in the background once it is old, so Mission never waits on ssh or doctor.
  const cached = (compute, ttl) => {
    const c = { value: null, at: 0, pending: null };
    return () => {
      if (!c.pending && Date.now() - c.at > ttl) {
        c.pending = compute().then((value) => { c.value = value; c.at = Date.now(); })
          .catch(() => { c.at = Date.now(); }).finally(() => { c.pending = null; });
      }
      return c;
    };
  };
  const fast = cached(fastSections, FAST_TTL);
  const noticeCache = cached(notices, NOTICES_TTL);

  async function overview() {
    if (!folder) return { status: 404, error: 'hub-not-set' };
    const f = fast(), n = noticeCache();
    // The first call, or the first after five idle minutes, waits for fresh quick sections; never for doctor.
    if (f.pending && (!f.value || Date.now() - f.at > 5 * FAST_TTL)) await f.pending;
    if (!f.value) return { status: 502, error: 'hub-failed' };
    return { status: 200, ...f.value, notices: n.value, checkedAt: n.at || null };
  }
  async function text({ kind, host: machine, name } = {}) {
    if (!folder) return { status: 404, error: 'hub-not-set' };
    // A handoff is a workspace file: P9's own reader opens it, with its locked-path and symlink rules.
    if (kind === 'handoff' && PROJECT.test(name ?? '')) {
      try { return { status: 200, text: (await readFile(workspace, name + '/HANDOFF.md')).content }; } catch { return { status: 404, error: 'not-found' }; }
    }
    const read = kind === 'log' && HOST.test(machine ?? '') && LOG.test(name ?? '') ? () => logTail(name, machine)
      : kind === 'incident' && HOST.test(machine ?? '') && INCIDENT.test(name ?? '') ? () => incidentText(machine, name)
        : kind === 'inbox' && BRANCH.test(name ?? '') ? () => inboxText(name)
          : kind === 'solo' ? async () => { const { path: file } = await lastSolo(); return file ? readText(file, 'utf8') : ''; } : null;
    if (!read) return { status: 400, error: 'request-refused' };
    try { return { status: 200, text: String(await read()) }; } catch (error) { return { status: error.status ?? 502, error: 'hub-failed' }; }
  }
  async function decide({ name, choice } = {}) {
    if (!folder) return { status: 404, error: 'hub-not-set' };
    if (!BRANCH.test(name ?? '') || !['merge', 'reject', 'pending'].includes(choice)) return { status: 400, error: 'request-refused' };
    if (!inboxDir) return { status: 404, error: 'hub-failed' };
    const file = path.join(inboxDir, name, '_decision.md');
    const before = await readText(file, 'utf8').catch(() => null);
    if (before === null || !DECISION.test(before)) return { status: 404, error: 'hub-failed' };
    // Release r2 R2-7: a phone revoked during the read writes nothing; the line lands by rename, never half written;
    // a file the server's */5 review changed meanwhile is refused (409), not overwritten.
    // ponytail: the recheck-to-rename gap stays (no lock the server's job shares); a change in it is lost.
    stillAuthorized();
    const temp = path.join(path.dirname(file), '.p9-decision-' + process.pid + '-' + Date.now());
    try {
      await writeFile(temp, before.replace(DECISION, `review: ${choice}`));
      if ((await readText(file, 'utf8').catch(() => null)) !== before) return { status: 409, error: 'hub-changed' };
      stillAuthorized();
      await rename(temp, file);
    } finally { await rm(temp, { force: true }); }
    fast().at = 0; // the next overview reads the new decision
    return { status: 200 };
  }
  return { overview, text, decide, folder, sections: fastSections, notices };
}
