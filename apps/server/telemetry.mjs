// The watcher (learning layer, phase 2: _research/p9-learning-layer/plan.md). One row per agent turn in telemetry.db beside
// the ledger, derived from ledger events by derive() below: the same function live (ledger.tap, main.mjs) and on replay
// at start. telemetry.db holds only what the ledger can rebuild, so a damaged or out-of-date one is renamed aside (kept)
// and rebuilt. Off the chat path: push() only projects an event and queues it; a worker thread writes, so a locked,
// read-only, slow or corrupt file drops rows (counted) and never delays a chat or the ledger.
// Privacy: project() is the gate. Rows hold ids, provider, model alias, stop reason, error code and tool kind; never prompt
// text, file contents, paths or keys. The schema's CHECKs refuse anything else (telemetry.test's privacy check).
// Resources (phase 3): CPU and peak memory per live turn from the chat's cgroup, a 60 s sample of the daemon and p9.slice,
// coverage gaps and the watcher's own cost go to telemetry-samples.db, which nothing can rebuild: it is never rebuilt or
// deleted, and a damaged one is renamed aside (kept) and a new one started. It joins to turns on turn_key = turns.key.
// Replay never fills it: only a turn seen live has resource numbers.
// Imports only Node's standard library: the worker loads this file on its own (bundle-daemon.mjs copies it).
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import { open as openFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

export const SCHEMA = 1; // PRAGMA user_version of telemetry.db; another value is set aside and rebuilt
export const DERIVER = 1; // bump when derive() changes what it writes, so rows say which rules made them
export const SAMPLES_SCHEMA = 1; // PRAGMA user_version of telemetry-samples.db; another value is renamed aside, never rebuilt
const GAP_MS = 180000; // samples further apart than this (sleep, restart, a stalled worker) leave a gap row

const KINDS = ['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'];
const STOPS = ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled', 'other'];
// chat.mjs's own error messages, by their fixed start; anything else from the agent is 'agent-error' (its text is not kept).
const ERRORS = [['Mode ', 'mode-failed'], ['This agent does not offer that model', 'model-unknown'], ['The model could not be set', 'model-failed'],
  ['This agent does not offer that setting', 'config-unknown'], ['This agent does not take images', 'images-unsupported'],
  ['Claude Code is not signed in', 'sign-in'], ['Codex is not signed in', 'sign-in']];
const CODES = ['agent-error', 'exited', 'config-failed', ...new Set(ERRORS.map(([, code]) => code))];
const USAGE = [['inputTokens', 'input_tokens'], ['outputTokens', 'output_tokens'], ['cachedReadTokens', 'cached_read_tokens'],
  ['cachedWriteTokens', 'cached_write_tokens'], ['thoughtTokens', 'thought_tokens'], ['totalTokens', 'total_tokens']];
const ENDS = new Set(['turn-end', 'error', 'exited', 'interrupted']);
const RELEVANT = new Set([...ENDS, 'user', 'update', 'config', 'created', 'approval', 'question', 'answered', 'deleted']);
const UUID = /^[0-9a-f-]{36}$/;
const ALIAS = /^[A-Za-z0-9._:[\]-]{1,64}$/;
const list = (values) => values.map((value) => "'" + value + "'").join(', ');

export const COLUMNS = ['key', 'conversation', 'end_cursor', 'deriver', 'outcome', 'unprompted', 'steers', 'stop_reason', 'error_code',
  'provider', 'model', 'model_source', 'folder_id', 'turn_number', 'start_at', 'end_at', 'first_output_ms', 'total_ms', 'tool_count',
  'tool_ms', 'approval_wait_ms', ...KINDS.map((kind) => 'tools_' + kind), 'usage', ...USAGE.map(([, column]) => column),
  'cache_read_share', 'layers'];

// STRICT plus a CHECK on every TEXT column: no column can hold free text (telemetry.test reads this back).
const TABLES = `
CREATE TABLE IF NOT EXISTS turns (
  key INTEGER PRIMARY KEY,
  conversation TEXT NOT NULL CHECK (length(conversation) = 36 AND conversation NOT GLOB '*[^0-9a-f-]*'),
  end_cursor INTEGER NOT NULL,
  deriver INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('finished', 'failed', 'cut-off')),
  unprompted INTEGER NOT NULL CHECK (unprompted IN (0, 1)),
  steers INTEGER NOT NULL,
  stop_reason TEXT CHECK (stop_reason IN (${list(STOPS)})),
  error_code TEXT CHECK (error_code IN (${list(CODES)})),
  provider TEXT CHECK (provider IN ('claude', 'codex')),
  model TEXT CHECK (length(model) <= 64 AND model NOT GLOB '*[^][A-Za-z0-9._:-]*'),
  model_source TEXT NOT NULL CHECK (model_source IN ('set', 'carried', 'missing')),
  folder_id TEXT CHECK (length(folder_id) = 16 AND folder_id NOT GLOB '*[^0-9a-f]*'),
  turn_number INTEGER NOT NULL,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  first_output_ms INTEGER,
  total_ms INTEGER NOT NULL,
  tool_count INTEGER NOT NULL,
  tool_ms INTEGER NOT NULL,
  approval_wait_ms INTEGER NOT NULL,
  ${KINDS.map((kind) => 'tools_' + kind + ' INTEGER NOT NULL').join(',\n  ')},
  usage INTEGER NOT NULL CHECK (usage IN (0, 1)),
  ${USAGE.map(([, column]) => column + ' INTEGER').join(',\n  ')},
  cache_read_share REAL,
  layers TEXT NOT NULL DEFAULT 'baseline' CHECK (layers IN ('baseline')),
  cpu_ms REAL,
  mem_peak_bytes INTEGER
) STRICT;`;

// The privacy gate: one ledger event (data as the object chat.mjs emitted, or the stored JSON) to the few fields derive()
// reads, or null when the watcher has no use for it.
export function project(event) {
  const { type } = event;
  if (!RELEVANT.has(type) || !UUID.test(String(event.conversation))) return null;
  let data = event.data;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = null; } }
  data ??= {};
  const base = { cursor: Number(event.cursor), conversation: String(event.conversation), type, at: Number(event.at) };
  switch (type) {
    case 'user': return { ...base, steered: Boolean(data.steered) };
    case 'created': return { ...base, provider: ['claude', 'codex'].includes(data.provider) ? data.provider : null,
      // '' is the chat's default workspace: it gets an id of its own, so NULL means only "unknown".
      folder: typeof data.folder === 'string' ? createHash('sha256').update(data.folder).digest('hex').slice(0, 16) : null };
    case 'config': {
      const current = data.model?.current;
      return { ...base, model: typeof current !== 'string' ? null : ALIAS.test(current) ? current : 'other' };
    }
    case 'update': {
      const kind = data.sessionUpdate;
      const done = ['completed', 'failed'].includes(data.status);
      if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') return { ...base, output: true };
      if (kind === 'tool_call') return { ...base, tool: String(data.toolCallId), kind: KINDS.includes(data.kind) ? data.kind : 'other', done };
      if (kind === 'tool_call_update' && done) return { ...base, toolEnd: String(data.toolCallId) };
      return null;
    }
    case 'approval': case 'question': case 'answered': return { ...base, request: String(data.request) };
    case 'turn-end': {
      const usage = data.usage && typeof data.usage === 'object' ? Object.fromEntries(USAGE.map(([field]) =>
        [field, Number.isSafeInteger(data.usage[field]) && data.usage[field] >= 0 ? data.usage[field] : null])) : null;
      return { ...base, stop: data.stopReason == null ? null : STOPS.includes(data.stopReason) ? data.stopReason : 'other',
        unprompted: data.unprompted === true, usage };
    }
    case 'error': {
      const message = String(data.message ?? '');
      const known = ERRORS.find(([start]) => message.startsWith(start));
      return { ...base, code: known ? known[1] : / could not be set; nothing was sent\.$/.test(message) ? 'config-failed' : 'agent-error' };
    }
    default: return base; // exited, interrupted, deleted
  }
}

export const freshState = () => ({ cursor: 0, conversations: new Map() });

// The one derive function: a projected event in, the turns it closes out. No I/O, so live and replay agree by construction.
// A turn opens at a user event that was not steered and ends at the first turn-end, error, exited or interrupted; steered
// messages fold into the open turn (or open one: Codex's startedNewTurn); an unprompted turn-end with no open turn is a
// row of its own. A new prompt while a turn is open cuts the old one off, as a daemon restart (interrupted) does.
export function derive(state, event) {
  if (!event || event.cursor <= state.cursor) return [];
  state.cursor = event.cursor;
  // O35: the chat was deleted; the worker removes its rows (forget), and derive forgets it.
  if (event.type === 'deleted') { state.conversations.delete(event.conversation); return []; }
  let chat = state.conversations.get(event.conversation);
  if (!chat) state.conversations.set(event.conversation, chat = { provider: null, folder: null, model: null, turns: 0, open: null });
  const turn = chat.open;
  const rows = [];
  const open = (steers) => { chat.open = { key: event.cursor, start: event.at, last: event.at, model: chat.model, set: false, steers,
    output: null, tools: new Map(), waits: new Map() }; };
  if (turn && !ENDS.has(event.type) && !(event.type === 'user' && !event.steered)) turn.last = event.at;
  switch (event.type) {
    case 'created': chat.provider = event.provider; chat.folder = event.folder; break;
    case 'config':
      chat.model = event.model;
      if (turn) { turn.model = event.model; turn.set = true; }
      break;
    case 'user':
      if (event.steered) { if (turn) turn.steers += 1; else open(1); break; }
      if (turn) rows.push(close(chat, turn, event, 'cut-off', turn.last));
      open(0);
      break;
    case 'update':
      if (!turn) break;
      if (turn.output === null) turn.output = event.at;
      if (event.tool !== undefined && !turn.tools.has(event.tool)) turn.tools.set(event.tool, { kind: event.kind, start: event.at, end: event.done ? event.at : null });
      if (event.toolEnd !== undefined) { const tool = turn.tools.get(event.toolEnd); if (tool && tool.end === null) tool.end = event.at; }
      break;
    case 'approval': case 'question': if (turn && !turn.waits.has(event.request)) turn.waits.set(event.request, { start: event.at, end: null }); break;
    case 'answered': { const wait = turn?.waits.get(event.request); if (wait && wait.end === null) wait.end = event.at; break; }
    case 'turn-end':
      if (turn) rows.push(close(chat, turn, event, 'finished', event.at));
      else { open(0); rows.push(close(chat, chat.open, event, 'finished', event.at, true)); }
      break;
    case 'error': case 'exited': if (turn) rows.push(close(chat, turn, event, 'failed', event.at)); break;
    case 'interrupted': if (turn) rows.push(close(chat, turn, event, 'cut-off', turn.last)); break;
  }
  return rows;
}

function close(chat, turn, event, outcome, end, unprompted = event.unprompted === true) {
  chat.open = null;
  chat.turns += 1;
  const usage = event.type === 'turn-end' ? event.usage : null;
  const tokens = Object.fromEntries(USAGE.map(([field, column]) => [column, usage?.[field] ?? null]));
  const share = tokens.input_tokens === null || tokens.cached_read_tokens === null ? null
    : tokens.cached_read_tokens / (tokens.input_tokens + tokens.cached_read_tokens + (tokens.cached_write_tokens ?? 0));
  const kinds = Object.fromEntries(KINDS.map((kind) => ['tools_' + kind, 0]));
  let toolMs = 0;
  for (const tool of turn.tools.values()) { kinds['tools_' + tool.kind] += 1; toolMs += Math.max(0, (tool.end ?? end) - tool.start); }
  let waitMs = 0;
  for (const wait of turn.waits.values()) waitMs += Math.max(0, (wait.end ?? end) - wait.start);
  return {
    key: turn.key, conversation: event.conversation, end_cursor: event.cursor, deriver: DERIVER, outcome, unprompted: unprompted ? 1 : 0,
    steers: turn.steers, stop_reason: event.type === 'turn-end' ? event.stop : null,
    error_code: event.type === 'error' ? event.code : event.type === 'exited' ? 'exited' : null,
    provider: chat.provider, model: turn.model, model_source: turn.set ? 'set' : turn.model === null ? 'missing' : 'carried',
    folder_id: chat.folder, turn_number: chat.turns, start_at: turn.start, end_at: end,
    first_output_ms: turn.output === null ? null : turn.output - turn.start, total_ms: end - turn.start,
    tool_count: turn.tools.size, tool_ms: toolMs, approval_wait_ms: waitMs, ...kinds,
    usage: usage ? 1 : 0, ...tokens,
    // Rounded to 6 places so a hand-worked fixture can state it exactly.
    cache_read_share: share === null || !Number.isFinite(share) ? null : Math.round(share * 1e6) / 1e6,
    layers: 'baseline',
  };
}

// telemetry-samples.db: what only a live daemon can see, so nothing rebuilds it. resources joins turns on turn_key = key.
// Never 0 for a number P9 could not read: the CHECKs tie NULL numbers to the availability, and a reason to every gap.
const REASONS = ['not-linux', 'no-cgroup-v2', 'no-user-manager', 'no-scope', 'scope-missing', 'scope-gone', 'scope-changed',
  'permission-denied', 'read-failed'];
const SAMPLE_TABLES = `
CREATE TABLE IF NOT EXISTS resources (
  turn_key INTEGER PRIMARY KEY,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  cpu_usec INTEGER CHECK (cpu_usec >= 0),
  mem_peak_bytes INTEGER CHECK (mem_peak_bytes >= 0),
  peak_basis TEXT CHECK (peak_basis IN ('turn', 'scope-start')),
  availability TEXT NOT NULL CHECK (availability IN ('measured', 'cpu-only', 'peak-only', 'unavailable')),
  reason TEXT CHECK (reason IN (${list(REASONS)})),
  partial INTEGER NOT NULL CHECK (partial IN (0, 1)),
  CHECK ((reason IS NULL) = (availability = 'measured')),
  CHECK ((cpu_usec IS NULL) = (availability IN ('peak-only', 'unavailable'))),
  CHECK ((mem_peak_bytes IS NULL) = (availability IN ('cpu-only', 'unavailable'))),
  CHECK ((peak_basis IS NULL) = (mem_peak_bytes IS NULL))
) STRICT;
CREATE TABLE IF NOT EXISTS samples (
  at INTEGER NOT NULL,
  daemon_cpu_usec INTEGER,
  daemon_mem_bytes INTEGER,
  slice_cpu_usec INTEGER,
  slice_mem_bytes INTEGER,
  ledger_bytes INTEGER,
  telemetry_bytes INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS samples_at ON samples (at);
CREATE TABLE IF NOT EXISTS gaps (start_at INTEGER PRIMARY KEY, end_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS self (start_at INTEGER NOT NULL, end_at INTEGER NOT NULL, worker_cpu_usec INTEGER NOT NULL, main_usec INTEGER NOT NULL) STRICT;`;
const RESOURCE_COLUMNS = ['turn_key', 'start_at', 'end_at', 'cpu_usec', 'mem_peak_bytes', 'peak_basis', 'availability', 'reason'];

// This process's cgroup and p9.slice (cgroup v2 under the systemd user manager, where chat.mjs puts each chat's scope), or
// the reason there are none. root is for tests only; they pass { self, slice } dirs of their own to startTelemetry instead.
export function findCgroup(root = '/sys/fs/cgroup') {
  if (process.platform !== 'linux') return { reason: 'not-linux' };
  try {
    const line = readFileSync('/proc/self/cgroup', 'utf8').split('\n').find((entry) => entry.startsWith('0::'));
    if (!line) return { reason: 'no-cgroup-v2' };
    const own = line.slice(3).trim();
    const self = path.join(root, own);
    const manager = /^(.*\/user@\d+\.service)(\/|$)/.exec(own);
    return manager ? { self, slice: path.join(root, manager[1], 'p9.slice') } : { self, reason: 'no-user-manager' };
  } catch { return { reason: 'no-cgroup-v2' }; }
}

const usageOf = (text) => { const match = /^usage_usec (\d+)$/m.exec(text); if (!match) throw Object.assign(new Error('no usage_usec'), { code: 'EBADMSG' }); return Number(match[1]); };
const numberOf = (text) => { const value = Number(String(text).trim()); if (!Number.isSafeInteger(value) || value < 0) throw Object.assign(new Error('not a count'), { code: 'EBADMSG' }); return value; };
const readCpu = async (dir) => usageOf(await readFile(path.join(dir, 'cpu.stat'), 'utf8'));
// memory.peak through a kept handle: pread at 0, so the value is the one this handle's reset started (kernel 6.12+).
const readPeak = async (handle) => { const buffer = Buffer.alloc(32); const { bytesRead } = await handle.read(buffer, 0, 32, 0); return numberOf(buffer.toString('utf8', 0, bytesRead)); };

// Main thread: start the writer. ledgerFile is the ledger's path (the worker reads it read-only to replay), file is
// telemetry.db, samplesFile telemetry-samples.db (beside it unless given). cap bounds the queue; delayMs holds every turns
// write (telemetry.test's slow writer only). scopeOf(conversation) names the chat's systemd scope unit, or null.
// Test knobs: cgroup ({ self, slice } fake dirs, or { reason }), sampleMs (0: no timer; tick(at) samples by hand) and
// clockMs (the worker's clock for the sample taken at start).
export function startTelemetry({ ledgerFile, file, samplesFile = path.join(path.dirname(file), 'telemetry-samples.db'), cap = 10000,
  delayMs = 0, scopeOf = () => null, cgroup = findCgroup(), sampleMs = 60000, clockMs = null }) {
  const counts = { droppedEvents: 0, maxQueue: 0, workerStats: {}, workerError: null, readFailures: 0, resourceErrors: 0 };
  let queue = [];
  let gap = false;
  let resources = []; // finished turns' resource rows, sent with the next message
  let ticks = [];
  let mainNs = 0n; // the watcher's own synchronous time on the main thread, sent to the worker's self rows
  let busy = true; // until the worker's first answer: its replay runs first
  let pending = false;
  let worker = null;
  const waiters = [];
  const measuring = new Map(); // conversation -> the open turn's measurement
  // O35: chats deleted while this daemon runs. A turn's resource row is read after its end (the stop before a delete), so
  // one can come in after the chat's rows were removed: it is dropped. ponytail: one id per delete, kept until the daemon stops.
  const gone = new Set();
  const inflight = new Set(); // cgroup reads not finished yet
  const settle = () => { if (!busy && !pending) for (const resolve of waiters.splice(0)) resolve(); };
  const send = () => {
    if (busy || !pending || !worker) return settle();
    busy = true; pending = false;
    worker.postMessage({ events: queue, gap, resources, ticks, mainUs: Number(mainNs / 1000n) });
    queue = []; gap = false; resources = []; ticks = []; mainNs = 0n;
  };
  const dead = (error) => {
    counts.workerError = String(error?.message ?? error);
    console.error(JSON.stringify({ event: 'P9_TELEMETRY_STOPPED', error: counts.workerError }));
    worker = null; busy = false; pending = false; settle();
  };
  const track = (promise) => { inflight.add(promise); promise.finally(() => inflight.delete(promise)); };
  const reasonOf = (error, phase) => {
    counts.readFailures += 1;
    if (error?.code === 'ENOENT' || error?.code === 'ENODEV') return phase === 'start' ? 'scope-missing' : 'scope-gone';
    return error?.code === 'EACCES' || error?.code === 'EPERM' ? 'permission-denied' : 'read-failed';
  };
  const unitOf = (conversation) => { try { const unit = scopeOf(conversation); return typeof unit === 'string' && unit ? unit : null; } catch { return null; } };
  const scopeDir = (unit) => path.join(cgroup.slice, unit + '.scope');

  // Turn start: the CPU counter, and memory.peak opened and reset through a handle kept for the turn. A scope that does
  // not exist yet (chat.mjs launches it after a conversation's first user event) is read whole at the end instead.
  const begin = (event) => {
    const measure = { key: event.cursor, conversation: event.conversation, start: event.at, unit: cgroup.slice ? unitOf(event.conversation) : null,
      cpu: null, cpuReason: null, peak: null, basis: null, peakReason: null };
    measuring.set(event.conversation, measure);
    measure.ready = (async () => {
      if (!measure.unit) return;
      const dir = scopeDir(measure.unit);
      try { measure.cpu = await readCpu(dir); } catch (error) { measure.cpuReason = reasonOf(error, 'start'); }
      try {
        measure.peak = await openFile(path.join(dir, 'memory.peak'), 'r+');
        try { await measure.peak.write('reset\n'); measure.basis = 'turn'; } catch { measure.basis = 'scope-start'; counts.readFailures += 1; }
      } catch {
        // No reset (a kernel before 6.12 refuses the write, or the file is read-only): the peak since the scope began.
        try { measure.peak = await openFile(path.join(dir, 'memory.peak'), 'r'); measure.basis = 'scope-start'; } catch (error) { measure.peakReason = reasonOf(error, 'start'); }
      }
    })().catch(() => { counts.resourceErrors += 1; });
    track(measure.ready);
  };

  // Turn end: read through the same handle, the CPU difference, one row. Errors become a reason, never a 0 and never a throw.
  const finish = (measure, at) => {
    measuring.delete(measure.conversation);
    const endUnit = cgroup.slice ? unitOf(measure.conversation) : null;
    const done = (async () => {
      await measure.ready;
      const row = { turn_key: measure.key, start_at: measure.start, end_at: at, cpu_usec: null, mem_peak_bytes: null, peak_basis: null };
      let cpuReason = null, peakReason = null;
      try {
        if (!cgroup.slice) cpuReason = cgroup.reason ?? 'no-user-manager';
        else if (!measure.unit && !endUnit) cpuReason = 'no-scope';
        else if (measure.unit && endUnit && endUnit !== measure.unit) cpuReason = 'scope-changed';
        else if (!measure.unit) {
          // Born inside the turn: everything it ever used is this turn's, from a fresh handle (its peak since the start).
          const dir = scopeDir(endUnit);
          try { row.cpu_usec = await readCpu(dir); } catch (error) { cpuReason = reasonOf(error, 'end'); }
          let handle = null;
          try { handle = await openFile(path.join(dir, 'memory.peak'), 'r'); row.mem_peak_bytes = await readPeak(handle); row.peak_basis = 'turn'; }
          catch (error) { peakReason = reasonOf(error, 'end'); } finally { await handle?.close().catch(() => {}); }
        } else {
          if (measure.cpuReason) cpuReason = measure.cpuReason;
          else {
            try { const used = await readCpu(scopeDir(measure.unit)) - measure.cpu; if (used >= 0) row.cpu_usec = used; else cpuReason = 'read-failed'; }
            catch (error) { cpuReason = reasonOf(error, 'end'); }
          }
          if (!measure.peak) peakReason = measure.peakReason;
          else { try { row.mem_peak_bytes = await readPeak(measure.peak); row.peak_basis = measure.basis; } catch (error) { peakReason = reasonOf(error, 'end'); } }
        }
        if (cpuReason && peakReason === null && row.mem_peak_bytes === null) peakReason = cpuReason;
      } finally { await measure.peak?.close().catch(() => {}); }
      const cpu = row.cpu_usec !== null, peak = row.mem_peak_bytes !== null;
      row.availability = cpu && peak ? 'measured' : cpu ? 'cpu-only' : peak ? 'peak-only' : 'unavailable';
      row.reason = cpu && peak ? null : (cpu ? peakReason : cpuReason ?? peakReason) ?? 'read-failed';
      if (gone.has(measure.conversation)) return;
      resources.push(row);
      pending = true; send();
    })().catch(() => { counts.resourceErrors += 1; });
    track(done);
  };

  // derive()'s open and close rules for live events only (replay never measures): a prompt opens a measurement (and cuts off
  // an open one), a steer opens one only when none is open, an end closes it. Keyed by the opening event's cursor = turns.key.
  const measure = (event) => {
    const open = measuring.get(event.conversation);
    if (event.type === 'user') {
      if (event.steered && open) return;
      if (open) finish(open, event.at);
      begin(event);
    } else if (ENDS.has(event.type) && open) finish(open, event.at);
  };

  try {
    worker = new Worker(new URL('./telemetry.mjs', import.meta.url), { workerData: { p9Telemetry: true, ledgerFile, file, samplesFile, delayMs,
      cgroup: { self: cgroup.self ?? null, slice: cgroup.slice ?? null }, sampleMs, clockMs } });
    worker.unref();
    worker.on('message', (stats) => { counts.workerStats = stats; busy = false; send(); });
    worker.on('error', dead);
    worker.on('exit', (code) => { if (worker) dead('exit ' + code); });
  } catch (error) { dead(error); }
  return {
    push(event) {
      if (!worker) return;
      const began = process.hrtime.bigint();
      try {
        let projected;
        try { projected = project(event); } catch { return; }
        if (!projected) return;
        if (projected.type === 'deleted') gone.add(projected.conversation);
        try { measure(projected); } catch { counts.resourceErrors += 1; }
        if (queue.length >= cap) { counts.droppedEvents += 1; gap = true; } // the worker catches up from the ledger instead
        else { queue.push(projected); counts.maxQueue = Math.max(counts.maxQueue, queue.length); }
        if (ENDS.has(projected.type) || projected.type === 'deleted') { pending = true; send(); }
      } finally { mainNs += process.hrtime.bigint() - began; }
    },
    stats: () => ({ ...counts.workerStats, droppedEvents: counts.droppedEvents, maxQueue: counts.maxQueue, queued: queue.length, cap,
      workerError: counts.workerError, readFailures: counts.readFailures, resourceErrors: counts.resourceErrors, measuring: measuring.size }),
    // One sample now, at the given worker clock (tests; the timer does this every sampleMs).
    tick(at) { if (!worker) return; ticks.push(at); pending = true; send(); },
    // Resolves once everything pushed so far is read and written (or dropped). Tests and shutdown only.
    async idle() {
      while (inflight.size) await Promise.allSettled([...inflight]);
      pending = true; const done = new Promise((resolve) => waiters.push(resolve)); send(); return done;
    },
    close() {
      for (const open of measuring.values()) open.ready.then(() => open.peak?.close()).catch(() => {});
      measuring.clear();
      const stopping = worker; worker = null; return stopping?.terminate();
    },
  };
}

const CORRUPT = new Set([11, 26]); // SQLITE_CORRUPT, SQLITE_NOTADB

// One SQLite file the worker writes: WAL, busy_timeout and user_version. An unknown version, a failed quick_check or a
// corrupt error renames it (with its -wal and -shm) aside under a timestamped name, at most 5 times per start, and a new
// one starts; nothing here deletes a file. onOpen prepares the statements.
function sqliteFile(file, version, tables, aside, stats, errorKey, onOpen) {
  const store = { db: null };
  store.corrupt = (error) => CORRUPT.has(error?.errcode & 0xff);
  store.setAside = () => {
    try { store.db?.close(); } catch {}
    store.db = null;
    let name = file + '.set-aside-' + Date.now();
    for (let i = 1; existsSync(name); i++) name = file + '.set-aside-' + Date.now() + '-' + i;
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(file + suffix)) renameSync(file + suffix, name + suffix);
    aside.push(name);
  };
  store.opened = () => {
    if (store.db) return true;
    try {
      store.db = new DatabaseSync(file);
      store.db.exec('PRAGMA busy_timeout = 1000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
      const found = store.db.prepare('PRAGMA user_version').get().user_version;
      const check = store.db.prepare('PRAGMA quick_check').all();
      if (((found !== 0 && found !== version) || check.length !== 1 || check[0].quick_check !== 'ok') && aside.length < 5) { store.setAside(); return store.opened(); }
      store.db.exec(tables + (found === 0 ? ' PRAGMA user_version = ' + version + ';' : '')); // no write on an existing file: a locked one still opens
      onOpen(store.db);
      return true;
    } catch (error) {
      stats[errorKey] = error.errstr ?? error.message;
      if (store.corrupt(error) && aside.length < 5) { store.setAside(); return store.opened(); }
      try { store.db?.close(); } catch {}
      store.db = null;
      return false;
    }
  };
  return store;
}

function runWorker({ ledgerFile, file, samplesFile, delayMs, cgroup, sampleMs, clockMs }) {
  const stats = { rowsWritten: 0, droppedRows: 0, setAside: [], replayedEvents: 0, lastError: null,
    rowsForgotten: 0, resourcesWritten: 0, droppedResources: 0, ignoredResources: 0, samplesWritten: 0, droppedSamples: 0, gaps: 0, samplesSetAside: [], samplesError: null };
  let insert = null;
  let state = freshState();
  let ledger = null;
  const turns = sqliteFile(file, SCHEMA, TABLES, stats.setAside, stats, 'lastError', (db) => {
    insert = db.prepare('INSERT OR IGNORE INTO turns (' + COLUMNS.join(', ') + ') VALUES (' + COLUMNS.map(() => '?').join(', ') + ')');
  });
  // O35: a deleted chat's turns, and their resource rows in the samples file. After the batch's own rows, so none is left
  // behind; on every replay too, so rows a failed write or an older daemon left are removed at the next start.
  const forget = (events) => {
    const ids = events.filter((event) => event?.type === 'deleted').map((event) => event.conversation);
    if (!ids.length || !turns.opened()) return;
    try {
      const list = JSON.stringify(ids), keys = turns.db.prepare('SELECT key FROM turns WHERE conversation IN (SELECT value FROM json_each(?))').all(list).map((row) => row.key);
      // The turns stay until their resource rows are gone: the keys are how the next start finds those.
      if (keys.length && !inSamples(keys.length, 'droppedResources', () => statements.unresource.run(JSON.stringify(keys)))) return;
      stats.rowsForgotten += Number(turns.db.prepare('DELETE FROM turns WHERE conversation IN (SELECT value FROM json_each(?))').run(list).changes);
    } catch (error) { stats.lastError = error.errstr ?? error.message; }
  };
  const write = (rows) => {
    if (!rows.length) return;
    if (!turns.opened()) { stats.droppedRows += rows.length; return; }
    if (delayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    try {
      turns.db.exec('BEGIN IMMEDIATE');
      let written = 0;
      for (const row of rows) written += Number(insert.run(...COLUMNS.map((column) => row[column])).changes);
      turns.db.exec('COMMIT');
      stats.rowsWritten += written;
    } catch (error) {
      stats.lastError = error.errstr ?? error.message;
      try { if (turns.db?.isTransaction) turns.db.exec('ROLLBACK'); } catch {}
      if (turns.corrupt(error) && stats.setAside.length < 5) { turns.setAside(); state = freshState(); catchUp(); return; }
      stats.droppedRows += rows.length; // replay at the next start writes them
    }
  };
  // Replay: every ledger event after state.cursor through derive(). From the start each time the worker starts, so a turn's
  // number and carried model never depend on an earlier run; INSERT OR IGNORE on the start cursor keeps rows single.
  // ponytail: a full pass per start (the server's 204k events, 2026-11-05); keep a progress cursor if starts get slow.
  // The SQL trims update and user events to the fields project() reads, so replay never parses prompt or reply text.
  const catchUp = () => {
    try {
      ledger ??= new DatabaseSync(ledgerFile, { readOnly: true });
      const page = ledger.prepare(`SELECT cursor, conversation, type, at, CASE WHEN NOT json_valid(data) THEN '{}'
        WHEN type = 'update' THEN json_object('sessionUpdate', data ->> '$.sessionUpdate', 'toolCallId', data ->> '$.toolCallId',
          'kind', data ->> '$.kind', 'status', data ->> '$.status')
        WHEN type = 'user' THEN json_object('steered', data ->> '$.steered') ELSE data END AS data
        FROM events WHERE cursor > ? AND type IN (${list([...RELEVANT])}) ORDER BY cursor LIMIT 5000`);
      for (;;) {
        const events = page.all(state.cursor);
        if (!events.length) break;
        const rows = [];
        for (const event of events) { rows.push(...derive(state, project(event))); state.cursor = Math.max(state.cursor, Number(event.cursor)); }
        stats.replayedEvents += events.length;
        write(rows);
        forget(events);
      }
    } catch (error) { stats.lastError = error.errstr ?? error.message; }
  };

  // The samples file. Its failures are counted in stats and never reach the turns file or the chat.
  let statements = null;
  const samples = sqliteFile(samplesFile, SAMPLES_SCHEMA, SAMPLE_TABLES, stats.samplesSetAside, stats, 'samplesError', (db) => {
    statements = {
      resource: db.prepare('INSERT OR IGNORE INTO resources (' + RESOURCE_COLUMNS.join(', ') + ', partial) VALUES (' + RESOURCE_COLUMNS.map(() => '?').join(', ')
        + ', EXISTS (SELECT 1 FROM gaps WHERE start_at < ? AND end_at > ?))'),
      last: db.prepare('SELECT max(at) AS at FROM samples'),
      gap: db.prepare('INSERT OR IGNORE INTO gaps (start_at, end_at) VALUES (?, ?)'),
      partial: db.prepare('UPDATE resources SET partial = 1 WHERE start_at < ? AND end_at > ?'),
      sample: db.prepare('INSERT INTO samples (at, daemon_cpu_usec, daemon_mem_bytes, slice_cpu_usec, slice_mem_bytes, ledger_bytes, telemetry_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      self: db.prepare('INSERT INTO self (start_at, end_at, worker_cpu_usec, main_usec) VALUES (?, ?, ?, ?)'),
      unresource: db.prepare('DELETE FROM resources WHERE turn_key IN (SELECT value FROM json_each(?))'),
    };
  });
  const inSamples = (count, drop, work) => {
    if (!samples.opened()) { stats[drop] += count; return false; }
    try { samples.db.exec('BEGIN IMMEDIATE'); work(); samples.db.exec('COMMIT'); return true; }
    catch (error) {
      stats.samplesError = error.errstr ?? error.message;
      try { if (samples.db?.isTransaction) samples.db.exec('ROLLBACK'); } catch {}
      if (samples.corrupt(error) && stats.samplesSetAside.length < 5) samples.setAside();
      stats[drop] += count;
      return false;
    }
  };
  const writeResources = (rows) => {
    if (!rows?.length) return;
    inSamples(rows.length, 'droppedResources', () => {
      let written = 0;
      for (const row of rows) written += Number(statements.resource.run(...RESOURCE_COLUMNS.map((column) => row[column]), row.end_at, row.start_at).changes);
      stats.resourcesWritten += written;
      stats.ignoredResources += rows.length - written; // OR IGNORE skips a repeated turn_key and a row its CHECKs refuse: counted, not silent
    });
  };
  // Sync reads are fine here: this is the worker. A missing file is NULL, never 0.
  const count = (dir, name) => { if (!dir) return null; try { const text = readFileSync(path.join(dir, name), 'utf8'); return name === 'cpu.stat' ? usageOf(text) : numberOf(text); } catch { return null; } };
  const bytes = (target) => { try { return statSync(target).size + (existsSync(target + '-wal') ? statSync(target + '-wal').size : 0); } catch { return null; } };
  const cpuUs = () => { const used = process.threadCpuUsage(); return used.user + used.system; };
  let since = { start: clockMs ?? Date.now(), cpu: 0, main: 0 }; // the worker's own CPU from its first instruction
  // One sample: the daemon's and p9.slice's counters, the two file sizes, a gap row when the last sample is more than 3
  // minutes old (marking the turns it overlaps partial), and a self row: the worker's CPU and the main thread's time since.
  const tick = (at) => {
    const cpu = cpuUs();
    inSamples(1, 'droppedSamples', () => {
      const last = statements.last.get().at;
      if (last !== null && at - last > GAP_MS) { statements.gap.run(last, at); statements.partial.run(at, last); stats.gaps += 1; }
      statements.sample.run(at, count(cgroup.self, 'cpu.stat'), count(cgroup.self, 'memory.current'), count(cgroup.slice, 'cpu.stat'),
        count(cgroup.slice, 'memory.current'), bytes(ledgerFile), bytes(file));
      statements.self.run(since.start, at, cpu - since.cpu, since.main);
      stats.samplesWritten += 1;
    });
    since = { start: at, cpu, main: 0 };
  };

  tick(clockMs ?? Date.now()); // before the replay: a restart's gap is found from the last sample, and the replay's cost lands in the next self row
  catchUp();
  if (sampleMs > 0) setInterval(() => tick(Date.now()), sampleMs).unref();
  parentPort.postMessage(stats);
  parentPort.on('message', ({ events, gap, resources, ticks, mainUs }) => {
    since.main += mainUs ?? 0;
    writeResources(resources); // first, so a deleted chat's last resource row in this batch goes with its turns below
    if (gap) catchUp(); // events were dropped from the queue: the ledger has them all
    else { const rows = []; for (const event of events) rows.push(...derive(state, event)); write(rows); forget(events); }
    for (const at of ticks ?? []) tick(at);
    parentPort.postMessage(stats);
  });
}

if (!isMainThread && workerData?.p9Telemetry) runWorker(workerData);
