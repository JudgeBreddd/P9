// Memory capture (learning layer 2-5, phase 2: _research/p9-learning-layer/plan-layers-2-5.md). One record per prompted
// turn in memory.db beside the ledger: your text, the agent's reply rebuilt from its chunks, tool names, the project the
// turn touched and its private flag. capture() below is the one function, live and on replay: the worker always reads
// the events from the ledger itself (read-only), so a live record and a replayed one come from the same rows and the same
// code. The main thread only wakes the worker at a turn's end; nothing waits on it, so memory never delays a chat.
// Privacy: the SQL in readPage() is the gate. Tool output (tool_call_update content and rawOutput), thought chunks and
// images never leave the ledger file. Text is secret-scanned (secret-rules.mjs: gitleaks' rule list) before it is stored.
// Switch, private toggles, forgets and tombstones are ledger events (conversation MEMORY_CONVERSATION, type 'memory'),
// so a rebuild from the ledger replays them and never brings back what was turned off or forgotten.
// Imports only Node's standard library and secret-rules.mjs: the worker loads this file on its own (bundle-daemon.mjs).
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, renameSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import SECRETS from './secret-rules.mjs';

export const SCHEMA = 2; // PRAGMA user_version of memory.db; another value is set aside and rebuilt
export const CAPTURE = 3; // bump when capture() changes what it writes: the next start rebuilds from the ledger
// 3 (O35): a deleted chat's rows go. The rebuild also clears the rows of chats deleted before, whose events are gone.
export const MEMORY_CONVERSATION = '00000000-0000-4000-8000-000000000000'; // the ledger's conversation for memory's own events
export const RULES = createHash('sha256').update(JSON.stringify(SECRETS)).digest('hex').slice(0, 12); // the scanner rules version
const ENDS = new Set(['turn-end', 'error', 'exited', 'interrupted']);
const TYPES = ['created', 'user', 'update', 'memory', 'project', 'deleted', ...ENDS];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// --- Secret scan: gitleaks' semantics (keywords first, the secret group or first non-empty group, entropy, allowlists) ---
const regex = ([source, flags]) => new RegExp(source, flags);
const SCAN = SECRETS.rules.map((rule) => ({ id: rule.id, re: new RegExp(rule.source, rule.flags + 'g'), keywords: rule.keywords, entropy: rule.entropy,
  group: rule.group, secret: rule.allow.secret.map(regex), match: rule.allow.match.map(regex), line: rule.allow.line.map(regex), stop: rule.allow.stop }));
const ALLOW = SECRETS.allow.map(regex);
const entropy = (text) => {
  const counts = new Map();
  for (const c of text) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / text.length) * Math.log2(n / text.length);
  return bits;
};
// Each secret found becomes [secret:<rule id>]. ponytail: JS regexes backtrack where gitleaks' RE2 does not; the rules are
// bounded, and the worker (never the chat) pays if one is slow. The real-ledger replay times the whole pass.
export function scrub(text) {
  if (!text) return text;
  const lower = text.toLowerCase();
  const spans = [];
  for (const rule of SCAN) {
    if (rule.keywords.length && !rule.keywords.some((word) => lower.includes(word))) continue;
    for (const m of text.matchAll(rule.re)) {
      const secret = rule.group ? m[rule.group] : m.slice(1).find(Boolean) ?? m[0];
      if (!secret) continue;
      if (rule.entropy && entropy(secret) <= rule.entropy) continue;
      const low = secret.toLowerCase();
      const from = text.lastIndexOf('\n', m.index) + 1, to = text.indexOf('\n', m.index + m[0].length);
      const line = text.slice(from, to < 0 ? text.length : to);
      if (ALLOW.some((re) => re.test(secret)) || SECRETS.stop.some((word) => low.includes(word)) || rule.secret.some((re) => re.test(secret))
        || rule.match.some((re) => re.test(m[0])) || rule.line.some((re) => re.test(line)) || rule.stop.some((word) => low.includes(word))) continue;
      const at = m.index + m[0].indexOf(secret);
      spans.push([at, at + secret.length, rule.id]);
    }
  }
  if (!spans.length) return text;
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged = [];
  for (const span of spans) { const last = merged.at(-1); if (last && span[0] < last[1]) last[1] = Math.max(last[1], span[1]); else merged.push([...span]); }
  let out = '', at = 0;
  for (const [start, end, id] of merged) { out += text.slice(at, start) + '[secret:' + id + ']'; at = end; }
  return out + text.slice(at);
}

// --- Project identity: the nearest folder below the workspace root holding .git or plan.md, else one holding AGENTS.md,
// CLAUDE.md or package.json. The root itself, the home folder and / are never a project. Inside the workspace the id is
// the workspace-relative path; outside it (Unrestricted folders) the absolute one. ponytail: read from the disk at capture
// time, so a rebuild after folders move can give an old turn a different project.
const STRONG = ['.git', 'plan.md'], WEAK = ['AGENTS.md', 'CLAUDE.md', 'package.json'];
export function resolverFor(workspace) {
  const root = path.resolve(workspace), home = os.homedir();
  const marks = new Map();
  const markOf = (dir) => {
    if (!marks.has(dir)) marks.set(dir, STRONG.some((name) => existsSync(path.join(dir, name))) ? 'strong' : WEAK.some((name) => existsSync(path.join(dir, name))) ? 'weak' : null);
    return marks.get(dir);
  };
  const ids = new Map();
  return (target) => {
    if (ids.has(target)) return ids.get(target);
    const inside = target === root || target.startsWith(root + path.sep);
    let weak = null, found = null;
    for (let dir = target; ; dir = path.dirname(dir)) {
      if (dir === root || dir === home || dir === path.dirname(dir)) break;
      const mark = markOf(dir);
      if (mark === 'strong') { found = dir; break; }
      if (mark === 'weak') weak ??= dir;
    }
    found ??= weak;
    const id = found === null ? null : inside ? path.relative(root, found) : found;
    if (ids.size > 50000) ids.clear();
    ids.set(target, id);
    return id;
  };
}
// Path-looking tokens in free text: two or more segments, or ~/ ./ ../ / in front. URLs are skipped (// has no segment).
const PATHISH = /(?:^|[\s'"`(=:,;<>[\]{}])((?:~\/|\.{1,2}\/|\/)?[\w.@+-]+(?:\/[\w.@+-]+)+)/g;
const tokens = (text) => typeof text === 'string' ? [...text.matchAll(PATHISH)].map((m) => m[1]) : [];
const absolute = (token, cwd) => token.startsWith('~/') ? path.join(os.homedir(), token.slice(2)) : path.resolve(cwd, token);

// --- The privacy gate in SQL: each row trimmed to the fields capture() reads. ---
const SELECT = `SELECT cursor, conversation, type, at, CASE WHEN NOT json_valid(data) THEN '{}'
  WHEN type = 'update' THEN json_object('u', data ->> '$.sessionUpdate',
    'text', CASE WHEN data ->> '$.sessionUpdate' = 'agent_message_chunk' AND data ->> '$.content.type' = 'text' THEN data ->> '$.content.text' END,
    'messageId', CASE WHEN data ->> '$.sessionUpdate' = 'agent_message_chunk' THEN data ->> '$.messageId' END,
    'toolCallId', data ->> '$.toolCallId', 'name', coalesce(data ->> '$._meta.claudeCode.toolName', data ->> '$.name'), 'kind', data ->> '$.kind',
    'whole', json_array(data ->> '$.rawInput.file_path', data ->> '$.rawInput.path', data ->> '$.rawInput.notebook_path', data ->> '$.rawInput.cwd',
      data ->> '$.rawInput.workdir'),
    'command', data ->> '$.rawInput.command', 'locations', (SELECT json_group_array(value ->> '$.path') FROM json_each(data, '$.locations')))
  WHEN type = 'user' THEN json_object('text', data ->> '$.text', 'steered', data ->> '$.steered')
  WHEN type = 'created' THEN json_object('provider', data ->> '$.provider', 'folder', data ->> '$.folder', 'project', data ->> '$.project')
  WHEN type = 'project' THEN json_object('project', data ->> '$.project')
  WHEN type = 'memory' THEN data
  ELSE json_object('unprompted', data ->> '$.unprompted') END AS data
  FROM events WHERE cursor > ? AND type IN (${TYPES.map((type) => `'${type}'`).join(', ')})
  AND (type <> 'update' OR data ->> '$.sessionUpdate' IN ('agent_message_chunk', 'tool_call', 'tool_call_update')) ORDER BY cursor LIMIT 2000`;

export const freshState = () => ({ cursor: 0, on: false, private: new Set(), conversations: new Map() });

// The one capture function: a ledger row from SELECT in, what it means for memory.db out. ctx: { workspace, resolve, always }
// (always: capture whatever the switch says, for offline evaluation). A turn opens at a prompt (a steer folds into the
// open turn, or opens one) and closes at turn-end, error, exited or interrupted, or is cut off by the next prompt:
// telemetry.mjs derive()'s rules. It is recorded when the switch was on as it opened.
export function capture(state, row, ctx) {
  const cursor = Number(row.cursor);
  if (!(cursor > state.cursor)) return [];
  state.cursor = cursor;
  let data = row.data;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = {}; } }
  data ??= {};
  const at = Number(row.at), out = [];
  if (row.type === 'memory') {
    if (row.conversation !== MEMORY_CONVERSATION) return [];
    if (data.action === 'switch') state.on = data.on === true;
    else if (data.action === 'private' && typeof data.folder === 'string') {
      const folder = path.resolve(ctx.workspace, data.folder);
      if (data.on === true) { state.private.add(folder); out.push({ cursor, private: folder }); } else state.private.delete(folder);
    } else if (data.action === 'forget' && Number.isSafeInteger(data.key)) out.push({ cursor, forget: data.key });
    else if (data.action === 'tombstone' && typeof data.text === 'string' && data.text) out.push({ cursor, tombstone: scrub(data.text.slice(0, 2000)),
      project: typeof data.project === 'string' ? data.project : null, at });
    return out;
  }
  if (!UUID.test(String(row.conversation))) return [];
  // O35: the chat was deleted (its own events are gone from the ledger): what memory.db holds from it goes too.
  if (row.type === 'deleted') { state.conversations.delete(row.conversation); return [{ cursor, deleteChat: row.conversation }]; }
  let chat = state.conversations.get(row.conversation);
  if (!chat) state.conversations.set(row.conversation, chat = { provider: null, cwd: ctx.workspace, project: null, open: null });
  const turn = chat.open;
  const open = (text) => { chat.open = { key: cursor, start: at, last: at, on: state.on || ctx.always, texts: [text], reply: '', messageId: undefined,
    tools: new Map(), touched: new Map(), textPaths: [] }; userPaths(chat.open, text); };
  const userPaths = (t, text) => { for (const token of tokens(text)) t.textPaths.push(absolute(token, chat.cwd)); };
  if (turn && !ENDS.has(row.type) && !(row.type === 'user' && !data.steered)) turn.last = at;
  switch (row.type) {
    case 'created':
      chat.provider = ['claude', 'codex'].includes(data.provider) ? data.provider : null;
      chat.cwd = typeof data.folder === 'string' ? path.resolve(ctx.workspace, data.folder) : ctx.workspace;
      chat.explicit = projectId(data.project);
      break;
    // N1: the chat moved into a project, out of one (null), or between two.
    case 'project': chat.explicit = projectId(data.project); break;
    case 'user': {
      const text = typeof data.text === 'string' ? data.text : '';
      if (data.steered && turn) { turn.texts.push(text); userPaths(turn, text); break; }
      if (turn) out.push(...close(state, chat, turn, row, 'cut-off', turn.last, ctx));
      open(text);
      break;
    }
    case 'update': {
      if (!turn) break;
      if (data.u === 'agent_message_chunk') {
        if (typeof data.text !== 'string') break;
        // A new message id starts a new paragraph; a chunk without one continues the current message (Codex).
        if (data.messageId != null) { if (turn.messageId !== undefined && data.messageId !== turn.messageId && turn.reply) turn.reply += '\n\n'; turn.messageId = data.messageId; }
        turn.reply += data.text;
        break;
      }
      const id = String(data.toolCallId);
      if (data.u === 'tool_call' && !turn.tools.has(id)) turn.tools.set(id, String(data.name ?? data.kind ?? 'other').slice(0, 60));
      if (!turn.tools.has(id)) break; // an update for a tool this turn never opened
      const seen = turn.touched.get(id) ?? new Set();
      let list = data.locations;
      if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = []; } }
      let whole = data.whole;
      if (typeof whole === 'string') { try { whole = JSON.parse(whole); } catch { whole = []; } }
      for (const value of [...(Array.isArray(list) ? list : []), ...(Array.isArray(whole) ? whole : [])]) if (typeof value === 'string' && value.trim()) seen.add(absolute(value.trim(), chat.cwd));
      for (const token of tokens(data.command)) seen.add(absolute(token, chat.cwd));
      turn.touched.set(id, seen);
      break;
    }
    case 'turn-end': if (turn) out.push(...close(state, chat, turn, row, 'finished', at, ctx)); break;
    case 'error': case 'exited': if (turn) out.push(...close(state, chat, turn, row, 'failed', at, ctx)); break;
    case 'interrupted': if (turn) out.push(...close(state, chat, turn, row, 'cut-off', turn.last, ctx)); break;
  }
  return out;
}

// The project most touched (first touched wins a tie): tool paths first, then paths in your text, then the chat's last
// project, then the chat's folder.
// N1: the memory project of a chat the user put in a P9 project: 'project:<id>'. ponytail: a path id has that shape only
// if a top workspace folder is itself named project:<uuid>; such a folder's turns would read as that project's.
export const EXPLICIT = /^project:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const projectId = (id) => (typeof id === 'string' && EXPLICIT.test('project:' + id) ? 'project:' + id : null);
function projectOf(paths, resolve) {
  const counts = new Map();
  for (const target of paths) { const id = resolve(target); if (id !== null) counts.set(id, (counts.get(id) ?? 0) + 1); }
  let best = null;
  for (const [id, n] of counts) if (best === null || n > counts.get(best)) best = id;
  return best;
}

function close(state, chat, turn, row, outcome, end, ctx) {
  chat.open = null;
  const toolPaths = [...turn.touched.values()].flatMap((set) => [...set]);
  const root = path.resolve(ctx.workspace);
  const cwdId = ctx.resolve(chat.cwd) ?? (chat.cwd === root || chat.cwd.startsWith(root + path.sep) ? path.relative(root, chat.cwd) : chat.cwd);
  // N1: a chat in a project takes its id; only a chat in none is inferred from paths.
  const project = chat.explicit ?? (chat.project = projectOf(toolPaths, ctx.resolve) ?? projectOf(turn.textPaths, ctx.resolve) ?? chat.project ?? cwdId);
  if (!turn.on) return [];
  const inside = (target) => [...state.private].some((folder) => target === folder || target.startsWith(folder + path.sep));
  const isPrivate = [...toolPaths, ...turn.textPaths, chat.cwd].some(inside);
  return [{ cursor: Number(row.cursor), record: { key: turn.key, conversation: String(row.conversation), end_cursor: Number(row.cursor), capture: CAPTURE,
    rules: RULES, outcome, start_at: turn.start, end_at: end, provider: chat.provider, user_text: scrub(turn.texts.join('\n\n')), reply: scrub(turn.reply),
    tools: JSON.stringify([...turn.tools.values()]), project, private: isPrivate ? 1 : 0 } }];
}

// --- Compile (phase 3): a chat's turns into items with proof. Rules only, no model in the write path; the one
// model-written input is the same agent's end-of-chat handoff, and its items pass the same proof. Design and the
// word lists' reasons: the project's private notes, p9-memory-phase3/design.md.
const DECIDE = /\b(use|don't|do not|never|always|instead|let's|go with|switch to|from now on|stop|keep|prefer)\b/i;
const CORRECT = /^(no|nope|wrong|actually|not that)\b/i;
const CONTRAST = /\b(not|instead|only|must|needs? to|turns out|actually|because|doesn't|won't|can't|never|always|requires?)\b/i;
const NEXT = /\b(next|left off|remaining|still need|not yet|todo|to do|then)\b/i;
const NUMBER = /(?<![\w./:-])\d+(?:[.:]\d+)*(?![\w/-])/g;
const IS_NUMBER = /^\d+(?:[.:]\d+)*$/;
export const TOMBSTONE_MS = 60 * 86400000;

// Lines, then sentence ends before a capital, a backtick, a quote or a bracket. List marks and headings are dropped.
const sentences = (text) => String(text ?? '').split('\n')
  .flatMap((line) => line.replace(/^\s*(?:[-*>]|#+|\d+[.)])\s+/, '').split(/(?<=[.!?])\s+(?=[A-Z`"'(])/)).map((s) => s.trim()).filter(Boolean);
// The anchors of a claim: code spans, paths, numbers of 2+ characters (dates are skipped: their parts touch a '-').
export function literals(text) {
  const out = [];
  let rest = String(text ?? '').replace(/`([^`\n]+)`/g, (m, code) => { out.push(code.trim()); return ' '; });
  for (const token of tokens(rest)) { const clean = token.replace(/[.,:;!?]+$/, ''); out.push(clean); rest = rest.split(token).join(' '); }
  for (const m of rest.matchAll(NUMBER)) if (m[0].length >= 2) out.push(m[0]);
  return [...new Set(out.filter(Boolean))];
}
// anchor in text, not inside a longer word or number.
const has = (text, anchor) => {
  for (let at = text.indexOf(anchor); at >= 0; at = text.indexOf(anchor, at + 1)) {
    const before = text[at - 1] ?? ' ', after = text[at + anchor.length] ?? ' ';
    if (!(/\w/.test(anchor[0]) && /\w/.test(before)) && !(/\w/.test(anchor.at(-1)) && /\w/.test(after))) return true;
  }
  return false;
};
// Codex sends "/bin/bash -lc '...'"; the command is what is inside.
const unwrap = (command) => { const m = /^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(command.trim()); return m ? m[2] : command.trim(); };

// Each record's own ledger range, read again for what compile needs and capture does not keep: each user text (and
// whether it was a steer), and per tool call its name, command, paths and last status. Never rawOutput or content.
const TURN_SQL = `SELECT type, data ->> '$.text' text, data ->> '$.steered' steered, data ->> '$.toolCallId' id, data ->> '$.status' status,
  coalesce(data ->> '$._meta.claudeCode.toolName', data ->> '$.name', data ->> '$.kind') name, data ->> '$.rawInput.command' command,
  json_array(data ->> '$.rawInput.file_path', data ->> '$.rawInput.path', data ->> '$.rawInput.notebook_path', data ->> '$.rawInput.cwd',
    data ->> '$.rawInput.workdir') whole, (SELECT json_group_array(value ->> '$.path') FROM json_each(data, '$.locations')) locations
  FROM events WHERE conversation = ? AND cursor BETWEEN ? AND ? AND json_valid(data)
  AND (type = 'user' OR (type = 'update' AND data ->> '$.sessionUpdate' IN ('tool_call', 'tool_call_update'))) ORDER BY cursor`;
export function turnsOf(ledger, records, workspace) {
  if (!records.length) return [];
  const folder = ledger.prepare("SELECT data ->> '$.folder' folder FROM events WHERE conversation = ? AND type = 'created' AND json_valid(data) ORDER BY cursor LIMIT 1")
    .get(records[0].conversation)?.folder;
  const cwd = path.resolve(workspace, typeof folder === 'string' ? folder : '');
  const read = ledger.prepare(TURN_SQL);
  return records.map((record) => {
    const parts = [], tools = new Map();
    for (const row of read.all(record.conversation, record.key, record.end_cursor)) {
      if (row.type === 'user') { parts.push({ text: scrub(row.text ?? ''), steered: Boolean(row.steered) }); continue; }
      const tool = tools.get(String(row.id)) ?? { name: null, command: null, paths: new Set(), status: null };
      tool.name ??= row.name;
      if (typeof row.command === 'string' && row.command.trim()) tool.command = scrub(unwrap(row.command));
      if (row.status) tool.status = row.status;
      let list = [];
      try { list = [...JSON.parse(row.locations ?? '[]'), ...JSON.parse(row.whole ?? '[]')]; } catch {}
      for (const value of list) if (typeof value === 'string' && value.trim()) tool.paths.add(absolute(value.trim(), cwd));
      for (const token of tokens(tool.command)) tool.paths.add(absolute(token, cwd));
      tools.set(String(row.id), tool);
    }
    return { key: record.key, end: record.end_cursor, at: record.end_at, project: record.project, private: record.private, cwd, reply: record.reply ?? '',
      parts, tools: [...tools.values()].map((tool) => ({ ...tool, paths: [...tool.paths] })) };
  });
}

// The one compile function: a chat's turns (turnsOf) and its handoff ({ cursor, text }: lines "decision: ...", "fact: ...",
// "next: ...", "decision (all projects): ..." for cross-project), out { items, dropped }. Every item needs an anchor proven inside its own cursor range; a command that only
// failed there is not an anchor. Tombstones and fact updates need every chat, so blocked() and closures() do those.
export function compile({ turns, handoff = null, resolve, workspace }) {
  const items = [], dropped = [], seen = new Set(), root = path.resolve(workspace);
  const corpus = turns.map((turn) => [turn.reply, ...turn.parts.map((part) => part.text), ...turn.tools.flatMap((tool) => [tool.command ?? '', ...tool.paths])].join('\n'));
  const proven = (anchor, i) => has(corpus[i], anchor) || [root, turns[i].cwd].some((dir) => turns[i].tools.some((tool) => tool.paths.includes(absolute(anchor, dir))));
  const flags = turns.map((turn) => ({ steer: turn.parts.some((part) => part.steered), failed: turn.tools.some((tool) => tool.status === 'failed'),
    correct: turn.parts.some((part) => sentences(part.text).some((s) => CORRECT.test(s))) }));
  const add = (kind, claim, lo, hi, source, everywhere = false) => {
    claim = claim.slice(0, 300);
    const drop = (reason) => dropped.push({ kind, claim, reason, cursor: turns[hi]?.end ?? handoff?.cursor ?? 0, source });
    const all = literals(claim);
    if (!all.length) { if (source === 'handoff') drop('no anchor'); return; } // a rule sentence without one is simply not a candidate
    if (hi < lo) return drop('no turn before the handoff');
    const missing = all.find((anchor) => !turns.slice(lo, hi + 1).some((turn, j) => proven(anchor, lo + j)));
    if (missing) return drop('unproven: ' + missing);
    if (source === 'handoff') { // a handoff's range is the turns that hold its anchors
      const hits = turns.map((turn, i) => i >= lo && i <= hi && all.some((anchor) => proven(anchor, i)));
      lo = hits.indexOf(true); hi = hits.lastIndexOf(true);
    }
    const range = turns.slice(lo, hi + 1);
    const ran = (failed) => new Set(range.flatMap((turn) => turn.tools.filter((tool) => tool.command && (tool.status === 'failed') === failed).map((tool) => tool.command)));
    const good = ran(false), bad = ran(true);
    const anchors = all.filter((anchor) => !(bad.has(anchor) && !good.has(anchor)));
    if (!anchors.length) return drop('failed command only');
    if (seen.has(kind + '\n' + claim)) return;
    seen.add(kind + '\n' + claim);
    const toolPaths = range.flatMap((turn) => turn.tools.flatMap((tool) => tool.paths));
    const textPaths = range.flatMap((turn) => turn.parts.flatMap((part) => tokens(part.text).map((token) => absolute(token, turn.cwd))));
    const f = flags.slice(lo, hi + 1);
    items.push({ kind, claim, anchors, from_cursor: turns[lo].key, to_cursor: turns[hi].end,
      project: EXPLICIT.test(range.at(-1).project ?? '') ? range.at(-1).project : projectOf(toolPaths, resolve) ?? projectOf(textPaths, resolve) ?? range.at(-1).project,
      cross: everywhere && (toolPaths.length || textPaths.length) ? 1 : 0, // only a handoff line marked so, and never without paths
      private: range.some((turn) => turn.private) ? 1 : 0,
      weight: 1 + 2 * f.some((x) => x.steer) + 2 * f.some((x) => x.correct) + 2 * f.some((x) => x.failed), source, valid_from: turns[hi].at });
  };
  turns.forEach((turn, i) => { // a question is neither a decision nor a fact
    for (const part of turn.parts) for (const s of sentences(part.text)) if (!s.endsWith('?') && (part.steered || CORRECT.test(s) || DECIDE.test(s))) add('decision', s, i, i, 'turns');
    for (const s of sentences(turn.reply)) if (!s.endsWith('?') && CONTRAST.test(s)) add('fact', s, i, i, 'turns');
  });
  // A failed command, then a completed one with the same program: the completed one is the fact.
  const calls = turns.flatMap((turn, i) => turn.tools.filter((tool) => tool.command && !/[\n`]/.test(tool.command) && tool.command.length <= 200).map((tool) => ({ ...tool, i })));
  const program = (command) => command.split(/\s+/)[0];
  calls.forEach((call, n) => {
    if (call.status !== 'failed') return;
    const fix = calls.slice(n + 1).find((other) => other.status === 'completed' && other.command !== call.command && program(other.command) === program(call.command));
    if (fix) add('fact', '`' + fix.command + '` works', call.i, fix.i, 'turns');
  });
  const lines = handoff ? String(handoff.text ?? '').split('\n').map((line) => /^\s*(?:[-*]\s*)?(decision|fact|next)\s*(\(all projects\))?\s*:\s*(.+)$/i.exec(line)).filter(Boolean) : [];
  const before = turns.findLastIndex((turn) => turn.end < handoff?.cursor);
  for (const [, kind, everywhere, claim] of lines) add(kind.toLowerCase() === 'next' ? 'left-off' : kind.toLowerCase(), scrub(claim.trim()), 0, before, 'handoff', Boolean(everywhere));
  if (turns.length && !lines.some(([, kind]) => kind.toLowerCase() === 'next')) {
    const last = turns.length - 1, s = sentences(turns[last].reply).reverse().find((x) => NEXT.test(x) && literals(x).length);
    if (s) add('left-off', s, last, last, 'turns');
  }
  return { items, dropped };
}

// The tombstone that blocks an item, or null: same project (a tombstone without one: every project), the item no later
// than 60 days after it, and the same literals (a changed port passes); with no literals on either side, word overlap.
const words = (text) => new Set(String(text).toLowerCase().match(/[a-z0-9]+/g) ?? []);
export function blocked(item, tombstones) {
  const mine = literals(item.claim).sort().join('\n'), myWords = words(item.claim);
  return tombstones.find((tomb) => {
    if ((tomb.project != null && tomb.project !== item.project) || item.valid_from > tomb.at + TOMBSTONE_MS) return false;
    const theirs = literals(tomb.text).sort().join('\n');
    if (mine || theirs) return mine === theirs;
    const other = words(tomb.text), shared = [...other].filter((word) => myWords.has(word)).length;
    return shared / (other.size + myWords.size - shared || 1) >= 0.5;
  }) ?? null;
}

// Fact updates: items of one project and kind with the same non-number anchors and different numbers. Each newer value
// closes the older ones (valid_to = its valid_from). In: [{ id, project, kind, anchors, valid_from }]; out: Map id -> valid_to.
export function closures(items) {
  const groups = new Map(), out = new Map();
  for (const item of [...items].sort((a, b) => a.valid_from - b.valid_from || a.id - b.id)) {
    const numbers = item.anchors.filter((a) => IS_NUMBER.test(a)).sort().join('\n'), rest = item.anchors.filter((a) => !IS_NUMBER.test(a)).sort();
    if (!numbers || !rest.length) continue;
    const key = JSON.stringify([item.project, item.kind, rest]), group = groups.get(key);
    if (!group || group.numbers === numbers) { if (group) group.open.push(item.id); else groups.set(key, { numbers, open: [item.id] }); continue; }
    for (const id of group.open) out.set(id, item.valid_from);
    groups.set(key, { numbers, open: [item.id] });
  }
  return out;
}

export const COLUMNS = ['key', 'conversation', 'end_cursor', 'capture', 'rules', 'outcome', 'start_at', 'end_at', 'provider', 'user_text', 'reply',
  'tools', 'project', 'private'];
const TABLES = `
CREATE TABLE IF NOT EXISTS records (key INTEGER PRIMARY KEY, conversation TEXT NOT NULL, end_cursor INTEGER NOT NULL, capture INTEGER NOT NULL,
  rules TEXT NOT NULL, outcome TEXT NOT NULL CHECK (outcome IN ('finished', 'failed', 'cut-off')), start_at INTEGER NOT NULL, end_at INTEGER NOT NULL,
  provider TEXT, user_text TEXT NOT NULL, reply TEXT NOT NULL, tools TEXT NOT NULL, project TEXT, private INTEGER NOT NULL CHECK (private IN (0, 1))) STRICT;
CREATE VIRTUAL TABLE IF NOT EXISTS shared USING fts5(key UNINDEXED, project UNINDEXED, user_text, reply);
CREATE TABLE IF NOT EXISTS tombstones (cursor INTEGER PRIMARY KEY, text TEXT NOT NULL, project TEXT, at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, conversation TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('decision', 'fact', 'left-off')),
  claim TEXT NOT NULL, anchors TEXT NOT NULL, from_cursor INTEGER NOT NULL, to_cursor INTEGER NOT NULL, project TEXT, cross INTEGER NOT NULL,
  private INTEGER NOT NULL, weight INTEGER NOT NULL, source TEXT NOT NULL, valid_from INTEGER NOT NULL, valid_to INTEGER) STRICT;
CREATE INDEX IF NOT EXISTS items_conversation ON items (conversation);
CREATE INDEX IF NOT EXISTS items_project ON items (project);
CREATE VIEW IF NOT EXISTS live_items AS SELECT * FROM items WHERE valid_to IS NULL;
CREATE TABLE IF NOT EXISTS dropped (conversation TEXT NOT NULL, kind TEXT NOT NULL, claim TEXT NOT NULL, reason TEXT NOT NULL, cursor INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS stale (conversation TEXT PRIMARY KEY) STRICT;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;`;

// Main thread: start the writer. ledgerFile is the ledger (read-only here), file is memory.db, workspace the daemon's.
// push(event) is ledger.tap's: it only wakes the worker at a turn's end or a memory event.
export function startMemory({ ledgerFile, file, workspace, always = false }) {
  const counts = { workerStats: {}, workerError: null, wakes: 0 };
  let busy = true, pending = false, worker = null; // busy until the worker's first answer: its replay runs first
  const waiters = [];
  const settle = () => { if (!busy && !pending) for (const resolve of waiters.splice(0)) resolve(); };
  const send = () => { if (busy || !pending || !worker) return settle(); busy = true; pending = false; worker.postMessage('wake'); };
  const dead = (error) => {
    counts.workerError = String(error?.message ?? error);
    console.error(JSON.stringify({ event: 'P9_MEMORY_STOPPED', error: counts.workerError }));
    worker = null; busy = false; pending = false; settle();
  };
  try {
    worker = new Worker(new URL('./memory.mjs', import.meta.url), { workerData: { p9Memory: true, ledgerFile, file, workspace, always } });
    worker.unref();
    worker.on('message', (stats) => { counts.workerStats = stats; busy = false; send(); });
    worker.on('error', dead);
    worker.on('exit', (code) => { if (worker) dead('exit ' + code); });
  } catch (error) { dead(error); }
  return {
    push(event) { if (worker && (ENDS.has(event?.type) || event?.type === 'memory' || event?.type === 'deleted')) { counts.wakes += 1; pending = true; send(); } },
    stats: () => ({ ...counts.workerStats, workerError: counts.workerError, wakes: counts.wakes }),
    // Resolves once the worker has read the ledger to its end and written (or dropped) what it found. Tests and shutdown.
    idle() { pending = true; const done = new Promise((resolve) => waiters.push(resolve)); send(); return done; },
    close() { const stopping = worker; worker = null; return stopping?.terminate(); },
  };
}

const CORRUPT = new Set([11, 26]); // SQLITE_CORRUPT, SQLITE_NOTADB

// A copy of telemetry.mjs's sqliteFile (not exported there, and that file belongs to the watcher's own plan): WAL,
// busy_timeout, user_version and quick_check; a bad file is renamed aside (kept) at most 5 times per start.
function sqliteFile(file, version, tables, aside, stats, onOpen) {
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
    // Any connection that opened the file while it was read-only left -wal and -shm with its 0444 mode, and SQLite
    // then stays read-only after the file is made writable again (across restarts too). They take the file's mode.
    try {
      const mode = statSync(file).mode & 0o777;
      if (mode & 0o200) for (const suffix of ['-wal', '-shm']) if (existsSync(file + suffix) && !(statSync(file + suffix).mode & 0o200)) chmodSync(file + suffix, mode);
    } catch {}
    try {
      store.db = new DatabaseSync(file);
      store.db.exec('PRAGMA busy_timeout = 1000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA secure_delete = ON;');
      const found = store.db.prepare('PRAGMA user_version').get().user_version;
      const check = store.db.prepare('PRAGMA quick_check').all();
      if (((found !== 0 && found !== version) || check.length !== 1 || check[0].quick_check !== 'ok') && aside.length < 5) { store.setAside(); return store.opened(); }
      if (found === 0) store.db.exec(tables + ` INSERT INTO shared (shared, rank) VALUES ('secure-delete', 1); PRAGMA user_version = ${version};`);
      onOpen(store.db);
      return true;
    } catch (error) {
      stats.lastError = error.errstr ?? error.message;
      if (store.corrupt(error) && aside.length < 5) { store.setAside(); return store.opened(); }
      try { store.db?.close(); } catch {}
      store.db = null;
      return false;
    }
  };
  return store;
}

// The worker: reads the ledger from its start through capture() at every start (switch, toggles and each chat's folder
// are state), and applies only what comes after meta.done, the last ledger cursor already applied. Each output is applied
// exactly once, so a forget stays forgotten. A failed write keeps meta.done where it was and starts the next pass over.
// ponytail: a full pass per start and after each failed write (the server's 206k events, 2026-11-05).
function runWorker({ ledgerFile, file, workspace, always }) {
  const stats = { recordsWritten: 0, forgotten: 0, compiled: 0, items: 0, droppedOutputs: 0, setAside: [], replayedEvents: 0, rebuilds: 0, lastError: null, passMs: 0 };
  const ctx = { workspace, resolve: resolverFor(workspace), always };
  let state = freshState(), done = 0, sql = null, ledger = null, page = null, forgotten = false;
  const store = sqliteFile(file, SCHEMA, TABLES, stats.setAside, stats, (db) => {
    const meta = Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map((row) => [row.key, row.value]));
    if (meta.capture !== String(CAPTURE) || meta.rules !== RULES) {
      // New capture code or scanner rules: every record is rebuilt with them, so live and replay never mix versions.
      db.exec('BEGIN IMMEDIATE; DELETE FROM records; DELETE FROM shared; DELETE FROM tombstones; DELETE FROM items; DELETE FROM dropped; DELETE FROM stale; DELETE FROM meta;');
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?), (?, ?), (?, ?)').run('capture', String(CAPTURE), 'rules', RULES, 'done', '0');
      db.exec('COMMIT');
      if (meta.capture !== undefined) stats.rebuilds += 1;
      meta.done = '0';
    }
    done = Number(meta.done);
    sql = {
      record: db.prepare('INSERT OR REPLACE INTO records (' + COLUMNS.join(', ') + ') VALUES (' + COLUMNS.map(() => '?').join(', ') + ')'),
      unshare: db.prepare('DELETE FROM shared WHERE key = ?'),
      share: db.prepare('INSERT INTO shared (key, project, user_text, reply) VALUES (?, ?, ?, ?)'),
      forget: db.prepare('DELETE FROM records WHERE key = ?'),
      open: db.prepare('SELECT key, project, conversation FROM records WHERE private = 0'),
      chatOf: db.prepare('SELECT conversation FROM records WHERE key = ?'),
      stale: db.prepare('INSERT OR IGNORE INTO stale (conversation) VALUES (?)'),
      staleAll: db.prepare('SELECT conversation FROM stale'),
      fresh: db.prepare('DELETE FROM stale'),
      chat: db.prepare('SELECT * FROM records WHERE conversation = ? ORDER BY key'),
      chatProjects: db.prepare('SELECT DISTINCT project FROM items WHERE conversation = ?'),
      unitems: db.prepare('DELETE FROM items WHERE conversation = ?'),
      unshareChat: db.prepare('DELETE FROM shared WHERE key IN (SELECT key FROM records WHERE conversation = ?)'),
      unrecord: db.prepare('DELETE FROM records WHERE conversation = ?'),
      unstale: db.prepare('DELETE FROM stale WHERE conversation = ?'),
      undropped: db.prepare('DELETE FROM dropped WHERE conversation = ?'),
      item: db.prepare('INSERT INTO items (conversation, kind, claim, anchors, from_cursor, to_cursor, project, cross, private, weight, source, valid_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      drop: db.prepare('INSERT INTO dropped (conversation, kind, claim, reason, cursor) VALUES (?, ?, ?, ?, ?)'),
      tombs: db.prepare('SELECT text, project, at FROM tombstones'),
      liveItems: db.prepare('SELECT id, conversation, kind, claim, project, valid_from, to_cursor FROM items WHERE valid_to IS NULL'),
      unitem: db.prepare('DELETE FROM items WHERE id = ?'),
      projectItems: db.prepare('SELECT id, project, kind, anchors, valid_from FROM items WHERE project IS ?'),
      reopen: db.prepare('UPDATE items SET valid_to = NULL WHERE project IS ?'),
      close: db.prepare('UPDATE items SET valid_to = ? WHERE id = ?'),
      hide: db.prepare('UPDATE records SET private = 1 WHERE key = ?'),
      tombstone: db.prepare('INSERT OR REPLACE INTO tombstones (cursor, text, project, at) VALUES (?, ?, ?, ?)'),
      done: db.prepare("UPDATE meta SET value = ? WHERE key = 'done'"),
    };
  });
  const reclose = (project) => {
    sql.reopen.run(project);
    for (const [id, to] of closures(sql.projectItems.all(project).map((row) => ({ ...row, anchors: JSON.parse(row.anchors) })))) sql.close.run(to, id);
  };
  const apply = (outputs, through) => {
    let forgot = false;
    for (const output of outputs) {
      if (output.record) {
        const r = output.record;
        sql.record.run(...COLUMNS.map((column) => r[column]));
        sql.unshare.run(r.key);
        if (!r.private) sql.share.run(r.key, r.project, r.user_text, r.reply);
        sql.stale.run(r.conversation);
        stats.recordsWritten += 1;
      } else if (output.forget !== undefined) {
        const chat = sql.chatOf.get(output.forget);
        if (chat) sql.stale.run(chat.conversation);
        stats.forgotten += Number(sql.forget.run(output.forget).changes);
        sql.unshare.run(output.forget);
        forgot = true;
      } else if (output.deleteChat) {
        // O35: every row the chat left, and the closures of the projects its items were in (as compileStale).
        const id = output.deleteChat, projects = sql.chatProjects.all(id).map((row) => row.project);
        sql.unshareChat.run(id); sql.unrecord.run(id); sql.unitems.run(id); sql.undropped.run(id); sql.unstale.run(id);
        for (const project of projects) reclose(project);
        forgot = true;
      } else if (output.private) {
        // A folder turned private: its earlier turns leave the shared index too.
        for (const { key, project, conversation } of sql.open.all()) {
          const target = path.resolve(workspace, project ?? '');
          if (project !== null && project !== '' && (target === output.private || target.startsWith(output.private + path.sep))) { sql.hide.run(key); sql.unshare.run(key); sql.stale.run(conversation); }
        }
      } else if (output.tombstone) {
        sql.tombstone.run(output.cursor, output.tombstone, output.project, output.at);
        // A new tombstone takes out the live items it blocks.
        const tomb = { text: output.tombstone, project: output.project, at: output.at };
        for (const item of sql.liveItems.all()) if (blocked(item, [tomb])) { sql.unitem.run(item.id); sql.drop.run(item.conversation, item.kind, item.claim, 'tombstone', item.to_cursor); }
      }
    }
    sql.done.run(String(through));
    return forgot;
  };
  // Every chat whose records changed since the last compile (the stale table, written with the records) compiles once per
  // pass, in one transaction: a replay that touches a chat on many pages reads its ledger ranges once.
  const compileStale = () => {
    if (!store.db) return;
    try {
      const chats = sql.staleAll.all().map((row) => row.conversation);
      if (!chats.length) return;
      store.db.exec('BEGIN IMMEDIATE');
      const tombs = sql.tombs.all(), projects = new Set();
      for (const conversation of chats) {
        for (const row of sql.chatProjects.all(conversation)) projects.add(row.project);
        sql.unitems.run(conversation); sql.undropped.run(conversation);
        const { items, dropped } = compile({ turns: turnsOf(ledger, sql.chat.all(conversation), workspace), resolve: ctx.resolve, workspace });
        for (const item of items) {
          if (blocked(item, tombs)) { sql.drop.run(conversation, item.kind, item.claim, 'tombstone', item.to_cursor); continue; }
          sql.item.run(conversation, item.kind, item.claim, JSON.stringify(item.anchors), item.from_cursor, item.to_cursor, item.project, item.cross, item.private, item.weight, item.source, item.valid_from);
          projects.add(item.project);
          stats.items += 1;
        }
        for (const d of dropped) sql.drop.run(conversation, d.kind, d.claim, d.reason, d.cursor);
      }
      for (const project of projects) reclose(project);
      sql.fresh.run();
      store.db.exec('COMMIT');
      stats.compiled += chats.length;
    } catch (error) {
      stats.lastError = error.errstr ?? error.message;
      try { if (store.db?.isTransaction) store.db.exec('ROLLBACK'); } catch {}
    }
  };
  const write = (outputs, through) => {
    if (!store.opened()) { stats.droppedOutputs += outputs.length; return false; }
    try {
      store.db.exec('BEGIN IMMEDIATE');
      const forgot = apply(outputs, through);
      store.db.exec('COMMIT');
      done = through;
      forgotten ||= forgot;
      return true;
    } catch (error) {
      stats.lastError = error.errstr ?? error.message;
      try { if (store.db?.isTransaction) store.db.exec('ROLLBACK'); } catch {}
      if (store.corrupt(error) && stats.setAside.length < 5) { store.setAside(); state = freshState(); return pass(); }
      // Closed so the next pass opens it again: a file made writable again (or unlocked) is written from the ledger then.
      try { store.db?.close(); } catch {}
      store.db = null;
      stats.droppedOutputs += outputs.length;
      return false;
    }
  };
  const pass = () => {
    const began = Date.now();
    try {
      ledger ??= new DatabaseSync(ledgerFile, { readOnly: true });
      page ??= ledger.prepare(SELECT);
      for (;;) {
        const rows = page.all(state.cursor);
        if (!rows.length) break;
        const outputs = [];
        // A delete with no memory.db has nothing to remove, and must not create one while capture is off.
        for (const row of rows) for (const output of capture(state, row, ctx)) if (output.cursor > done && !(output.deleteChat && !store.db && !existsSync(file))) outputs.push(output);
        stats.replayedEvents += rows.length;
        if (outputs.length && !write(outputs, state.cursor)) { state = freshState(); break; } // dropped: the next pass starts over
      }
    } catch (error) { stats.lastError = error.errstr ?? error.message; state = freshState(); }
    compileStale();
    if (forgotten && store.db) { try { store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); forgotten = false; } catch {} } // forgotten text leaves the -wal file too
    stats.passMs = Date.now() - began;
    return true;
  };
  pass();
  parentPort.postMessage(stats);
  parentPort.on('message', () => { pass(); parentPort.postMessage(stats); });
}

if (!isMainThread && workerData?.p9Memory) runWorker(workerData);
