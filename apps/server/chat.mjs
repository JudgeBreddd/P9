// Chat over ACP: one adapter process per running conversation. On Linux each adapter runs in its own systemd user
// scope, so Stop ends everything the session spawned, setsid children included. Adapted from Builder's
// agent-first-workspace (_engine/acp-connection.ts, os-process.ts, provider-service.ts, 2026-10-09); the adapter
// versions and the rules followed here are pinned in contracts.md.
import { execFile } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { childEnv } from './child-env.mjs';
import { stillAuthorized } from './authority.mjs';
import { launchTree, endTree, hasUserBus } from './process-tree.mjs';
import { listDirectory } from '../../packages/files/index.mjs';

const run = promisify(execFile);
const PROVIDERS = new Set(['claude', 'codex']);
const ID = /^[0-9a-f-]{36}$/;
const MAX_TEXT = 100_000, MAX_EVENT = 64 * 1024;
// Photos from the paperclip (Builder, 2026-10-17; threat model row 20): raster types only, base64, 2 MiB each, four a message.
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']), MAX_IMAGES = 4, MAX_IMAGE = 2 * 1024 * 1024;
const imagesOk = (images) => Array.isArray(images) && images.length <= MAX_IMAGES && images.every((image) => image && typeof image === 'object'
  && IMAGE_TYPES.has(image.mimeType) && typeof image.data === 'string' && image.data.length > 0 && image.data.length <= MAX_IMAGE && /^[A-Za-z0-9+/]+={0,2}$/.test(image.data));
// A start holds the Stop All barrier, so an adapter that never answers the handshake must not hold it forever.
const START_MS = 45_000;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// contracts.md rule 1: without elicitation.form both adapters silently skip questions. fs and terminal stay off:
// agents read, write and run under their own permission checks.
const clientCapabilities = { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } };
const adapterEntry = (provider) => fileURLToPath(new URL(`../../node_modules/@agentclientprotocol/${provider === 'claude' ? 'claude-agent-acp' : 'codex-acp'}/dist/index.js`, import.meta.url));
const refused = (status, error) => ({ status, error });
// ACP's authRequired (code -32000) means the agent's own CLI on this computer is not signed in (GitHub issue #4: the
// window showed only "Authentication required"). Say how to sign in; any other error passes through, cut to 500 chars.
const SIGN_IN = { claude: 'Claude Code is not signed in on this computer. Open a terminal, run claude and log in, then start a new chat.',
  codex: 'Codex is not signed in on this computer. Open a terminal, run codex login, then start a new chat.' };
const agentError = (error, provider) => (error?.code === -32000 ? SIGN_IN[provider] : String(error?.message ?? error).slice(0, 500));

// The form P9 can show for an ACP elicitation schema (council 2026-10-16-013039-tier2): flat fields of string, number,
// integer, boolean, string choices (enum, or oneOf/anyOf of { const, title }) and string-choice multi-select, with
// length, range and item-count limits (null means none). P9 checks answers against this form only, the same one the
// UI renders. pattern and format are shown as hints and never run: the agent asked, so the agent validates them (and
// an agent regex run here could stall the daemon). Anything else returns null and the UI offers only Decline.
const FIELD_KEYS = new Set(['type', 'title', 'description', 'default', 'enum', 'oneOf', 'anyOf', 'minLength', 'maxLength',
  'minimum', 'maximum', 'minItems', 'maxItems', 'items', 'pattern', 'format', '_meta']);
// Keys follow the pinned ACP SDK's ElicitationSchema types; _meta and an option's description are metadata, never constraints.
const ROOT_KEYS = new Set(['type', 'properties', 'required', 'title', 'description', '$schema', '_meta']);
// A limit is absent (null), a whole count >= 0 for lengths and item counts, or any finite number for ranges.
const limit = (value, count) => value == null ? null : (count ? Number.isSafeInteger(value) && value >= 0 : Number.isFinite(value)) ? value : undefined;
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
// Choices as [value, label] pairs; null when the schema offers none; undefined (refuse) when they are malformed.
function choiceList(key, list, blank) {
  if (!Array.isArray(list) || !list.length) return undefined;
  // In a single choice an empty string would be indistinguishable from "No answer", so it refuses unless `blank`
  // (multi-select checkboxes are indexed, so '' is unambiguous there).
  const ok = (v) => typeof v === 'string' && (blank || v !== '');
  if (key === 'enum') return list.every(ok) ? list.map((v) => [v, v]) : undefined;
  if (!list.every((o) => isObject(o) && ok(o.const) && Object.keys(o).every((k) => k === '_meta' || (k === 'description' && (o.description == null || typeof o.description === 'string')) || k === 'const' || (k === 'title' && typeof o.title === 'string')))) return undefined;
  return list.map((o) => [o.const, o.title ?? o.const]);
}
function choices(schema, blank = false) {
  // ACP allows enum and oneOf together; a valid answer must be in every list, so only values in all of them are
  // offered, labelled from a titled list. None in common refuses (formSpec checks for an empty list).
  const lists = ['oneOf', 'anyOf', 'enum'].filter((k) => schema[k] != null).map((k) => choiceList(k, schema[k], blank));
  if (!lists.length) return null;
  if (lists.includes(undefined)) return undefined;
  const [first, ...rest] = lists;
  return first.filter(([v]) => rest.every((list) => list.some(([w]) => w === v)));
}
// JSON Schema counts string length in code points, not UTF-16 units.
const length = (text) => [...text].length;
export function formSpec(schema) {
  if (!isObject(schema) || schema.type !== 'object' || !Object.keys(schema).every((k) => ROOT_KEYS.has(k)) || JSON.stringify(schema).length > 65536) return null;
  // ACP's types make null the same as absent for limits, required and metadata.
  const props = schema.properties, required = schema.required ?? [];
  if (!isObject(props) || Object.keys(props).length > 50 || ['title', 'description'].some((k) => schema[k] != null && typeof schema[k] !== 'string')) return null;
  if (!Array.isArray(required) || new Set(required).size !== required.length || !required.every((k) => typeof k === 'string' && Object.hasOwn(props, k))) return null;
  const fields = [];
  for (const [key, p] of Object.entries(props)) {
    if (!isObject(p) || !Object.keys(p).every((k) => FIELD_KEYS.has(k))) return null;
    if (['title', 'description', 'pattern', 'format'].some((k) => p[k] != null && typeof p[k] !== 'string')) return null;
    const field = { key, label: typeof p.title === 'string' ? p.title : key, required: required.includes(key) };
    const hint = [p.description, p.pattern && `pattern ${p.pattern}`, p.format && `format ${p.format}`].filter((s) => typeof s === 'string');
    if (hint.length) field.hint = hint.join(' · ').slice(0, 500);
    const options = choices(p);
    if (options === undefined) return null;
    if (p.type === 'array') {
      const items = isObject(p.items) && Object.keys(p.items).every((k) => k === 'type' || k === 'enum' || k === 'oneOf' || k === 'anyOf' || k === '_meta') ? choices(p.items, true) : undefined;
      if (!items || options || (p.items.type ?? 'string') !== 'string') return null;
      Object.assign(field, { kind: 'multi', options: items, min: limit(p.minItems, true), max: limit(p.maxItems, true) });
    } else if (p.type === 'string' && options) {
      // ACP allows length bounds beside choices; only the choices inside them are offered (none left refuses below).
      const lo = limit(p.minLength, true), hi = limit(p.maxLength, true);
      if (lo === undefined || hi === undefined) return null;
      Object.assign(field, { kind: 'choice', options: options.filter(([v]) => (lo == null || length(v) >= lo) && (hi == null || length(v) <= hi)) });
      if (!field.options.length) return null;
    } else if (p.type === 'string') Object.assign(field, { kind: 'text', min: limit(p.minLength, true), max: limit(p.maxLength, true) });
    else if (p.type === 'boolean' && !options) field.kind = 'boolean';
    else if ((p.type === 'number' || p.type === 'integer') && !options) Object.assign(field, { kind: p.type, min: limit(p.minimum), max: limit(p.maximum) });
    else return null;
    // Limits that belong to another kind (minLength on a number, say) would be dropped silently, so they refuse.
    const own = { multi: ['minItems', 'maxItems'], text: ['minLength', 'maxLength'], choice: ['minLength', 'maxLength'], number: ['minimum', 'maximum'], integer: ['minimum', 'maximum'] }[field.kind] ?? [];
    if (['minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'items'].some((k) => k in p && p[k] != null && !own.includes(k) && !(k === 'items' && field.kind === 'multi'))) return null;
    if (field.min != null && field.max != null && field.min > field.max) return null;
    if (('min' in field && (field.min === undefined || field.max === undefined)) || (field.options && (!field.options.length || field.options.length > 100 || new Set(field.options.map((o) => o[0])).size !== field.options.length))) return null;
    fields.push(field);
  }
  return { fields };
}
function fieldOk(field, item) {
  const within = (value) => (field.min == null || value >= field.min) && (field.max == null || value <= field.max);
  const offered = (value) => field.options.some((o) => o[0] === value);
  switch (field.kind) {
    case 'text': return typeof item === 'string' && within(length(item));
    case 'choice': return offered(item);
    case 'boolean': return typeof item === 'boolean';
    case 'number': return Number.isFinite(item) && within(item);
    case 'integer': return Number.isInteger(item) && within(item);
    case 'multi': return Array.isArray(item) && within(item.length) && new Set(item).size === item.length && item.every(offered);
  }
  return false;
}

// Browser answers are untrusted: rebuild them from the allowed shapes only (agent-first-workspace validAnswer).
function validAnswer(pending, value) {
  if (JSON.stringify(value ?? null).length > 16384) return null;
  if (pending.kind === 'approval') {
    if (value?.outcome === 'cancelled') return { outcome: { outcome: 'cancelled' } };
    return pending.request.options.some((option) => option.optionId === value?.optionId)
      ? { outcome: { outcome: 'selected', optionId: value.optionId } } : null;
  }
  if (value?.action === 'decline' || value?.action === 'cancel') return { action: value.action };
  if (!pending.form || value?.action !== 'accept' || !value.content || typeof value.content !== 'object' || Array.isArray(value.content)) return null;
  const fields = new Map(pending.form.fields.map((field) => [field.key, field]));
  if (pending.form.fields.some((field) => field.required && !Object.hasOwn(value.content, field.key))) return null;
  for (const [key, item] of Object.entries(value.content)) if (!fields.has(key) || !fieldOk(fields.get(key), item)) return null;
  return { action: 'accept', content: value.content };
}

// Images from agents (threat model row 26): an image block keeps only its type and data, and only when the type is
// one of IMAGE_TYPES, the data is base64 within MAX_AGENT_IMAGE and the update has had fewer than MAX_IMAGES; any
// other image block becomes a text note. A uri is never kept, so nothing names an address to load.
const MAX_AGENT_IMAGE = 8 * 1024 * 1024, IMAGE_NOTE = '\n\n[image not shown: only PNG, JPEG, GIF or WebP up to 6 MB, 4 at a time]\n\n';
// An image the agent opened from disk arrives as a resource_link naming only its path (Codex's view_image). The daemon
// reads that file once, here, and keeps it only when it is a regular file of at most 6 MiB whose first bytes say PNG,
// JPEG, GIF or WebP (threat model row 27); anything else stays a plain link and nothing is read.
const imageType = (bytes) => {
  const head = bytes.toString('latin1', 0, 12);
  return head.startsWith('\x89PNG\r\n\x1a\n') ? 'image/png' : head.startsWith('\xff\xd8\xff') ? 'image/jpeg'
    : /^GIF8[79]a/.test(head) ? 'image/gif' : head.startsWith('RIFF') && head.endsWith('WEBP') ? 'image/webp' : null;
};
function fileImage(block) {
  let file = typeof block.uri === 'string' ? block.uri : '', fd;
  try {
    if (file.startsWith('file:')) file = fileURLToPath(file);
    if (!path.isAbsolute(file) || !/\.(png|jpe?g|gif|webp)$/i.test(file)) return block;
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK); // non-blocking: a FIFO named x.png cannot stall the daemon
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 12 || stat.size > MAX_AGENT_IMAGE / 4 * 3) return block;
    const bytes = Buffer.alloc(stat.size);
    const mimeType = readSync(fd, bytes, 0, stat.size, 0) === stat.size && imageType(bytes);
    return mimeType ? { type: 'image', mimeType, data: bytes.toString('base64') } : block;
  } catch { return block; } finally { if (fd !== undefined) closeSync(fd); }
}
function agentImages(update) {
  let kept = 0;
  const check = (block) => {
    if (block?.type === 'resource_link') block = fileImage(block);
    if (block?.type !== 'image') return block;
    if (kept >= MAX_IMAGES || !IMAGE_TYPES.has(block.mimeType) || typeof block.data !== 'string' || !block.data
      || block.data.length > MAX_AGENT_IMAGE || !/^[A-Za-z0-9+/]+={0,2}$/.test(block.data)) return { type: 'text', text: IMAGE_NOTE };
    kept += 1;
    return { type: 'image', mimeType: block.mimeType, data: block.data };
  };
  if (Array.isArray(update?.content)) return { ...update, content: update.content.map((item) => (item?.type === 'content' ? { ...item, content: check(item.content) } : check(item))) };
  if (update?.content?.type === 'image' || update?.content?.type === 'resource_link') return { ...update, content: check(update.content) };
  return update;
}

// Event payloads are stored as sent by the adapter, minus oversized tool output.
function trim(update) {
  const text = JSON.stringify(update);
  if (text.length <= MAX_EVENT) return update;
  const { _meta, rawOutput, rawInput, ...rest } = update;
  return { ...rest, truncated: text.length };
}

export function createChat({ ledger, workspace, adapterOverride, instance, lifecycle }) {
  const db = ledger.db;
  const live = new Map(); // conversation -> { proc, agent, sessionId, exited, turn, pending: Map }
  const listeners = new Set();
  const stops = new Map(); // conversation -> the Stop in progress
  const failed = new Map(); // conversation -> the adapter whose cleanup could not be confirmed; the next Stop retries it
  let closing = false; // set by shutdown: no adapter may start after its cleanup snapshot
  const emit = (conversation, type, data = {}) => { ledger.append(conversation, type, data); for (const wake of listeners) wake(); };
  const row = (id) => db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  const setState = (id, state) => db.prepare('UPDATE conversations SET state = ? WHERE id = ?').run(state, id);
  // Agent lock (threat model row 15): kept in the ledger so a restart keeps it. While on, sessions run in the provider's
  // no-write mode and the daemon answers every permission request Reject itself.
  db.exec('CREATE TABLE IF NOT EXISTS prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  let locked = db.prepare("SELECT value FROM prefs WHERE key = 'agent-lock'").get()?.value === 'on';
  const modeFor = (provider) => provider === 'claude' ? (locked ? 'plan' : 'default') : (locked ? 'read-only' : 'agent');
  const setMode = (session, provider, value = modeFor(provider)) => session.agent.setSessionConfigOption({ sessionId: session.sessionId, configId: 'mode', value })
    .then((result) => { session.mode = value; return result; });
  // The chat's Mode picker, sent with each desktop prompt (Builder, 2026-10-17: Auto still asked before every command). Codex's
  // four are its own (contracts.md rule 2); Full access and Claude's bypass are threat model row 25. The lock wins over all.
  const MODES = { claude: { Auto: 'auto', Manual: 'default', Plan: 'plan', 'Accept edits': 'acceptEdits', 'Bypass permissions': 'bypassPermissions' },
    codex: { 'Read-only': 'read-only', 'Workspace access': 'workspace-write', 'Auto review': 'agent', 'Full access': 'agent-full-access' } };
  // The agent's own model list (Builder, 2026-10-17: the picker offered two models). The window shows it; a prompt picks only from it.
  // Threat model row 22: beside the model, only effort, fast mode and Codex's plan switch (Builder, 2026-10-18: "wire all of
  // them"). Mode stays P9's own picker with the lock; any other or future category never reaches the window.
  const PICKERS = ['thought_level', 'model_config', 'collaboration_mode'];
  const select = (o) => ({ id: o.id, name: String(o.name ?? o.id).slice(0, 60), current: String(o.currentValue ?? ''),
    options: o.options.flatMap((x) => Array.isArray(x?.options) ? x.options : [x]).filter((x) => typeof x?.value === 'string' && x.value.length <= 200)
      .slice(0, 50).map((x) => ({ value: x.value, name: String(x.name ?? x.value).slice(0, 200) })) });
  const models = (session, id, options) => {
    const all = (Array.isArray(options) ? options : []).filter((x) => x?.type === 'select' && typeof x.id === 'string' && x.id.length <= 60 && Array.isArray(x.options));
    const o = all.find((x) => x.id === 'model');
    if (!o) return false;
    const { current, options: list } = select(o);
    session.models = { current, options: list };
    session.pickers = all.filter((x) => x.id !== 'model' && PICKERS.includes(x.category)).map(select).filter((x) => x.options.length > 1).slice(0, 6);
    emit(id, 'config', { model: session.models, pickers: session.pickers });
    return true;
  };
  const reject = (request) => {
    const option = request.options?.find((o) => o.kind === 'reject_once') ?? request.options?.find((o) => o.kind === 'reject_always');
    return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } };
  };
  const command = (provider) => adapterOverride ? [process.execPath, adapterOverride, provider] : [process.execPath, adapterEntry(provider)];

  // Wizard sign-in (threat model row 31): the login of the CLI each adapter ships, with fixed arguments and no shell. The
  // CLI opens the browser itself; its first https:// URL is kept for main, which opens it only after its origin check.
  // The paste box's code goes to its stdin only. One login per agent; ended after 10 minutes, on Stop or at shutdown.
  // ponytail: Stop ends the CLI's whole process group (Windows: its job), so a browser the CLI started itself, not
  // handed to one already running, closes with it.
  const LOGIN = { claude: ['--cli', 'auth', 'login', '--claudeai'], codex: ['cli', 'login'] };
  const logins = new Map(); // agent -> { tree, url, exit, timer }
  const agentName = (value) => typeof value === 'string' && Object.hasOwn(LOGIN, value); // never ['claude'], which hasOwn reads as 'claude'
  const endLogin = async (agent) => {
    const login = logins.get(agent);
    if (!login || login.exit !== undefined) return 'stopped';
    clearTimeout(login.timer);
    const result = await endTree(login.tree);
    if (result === 'stopped') login.exit ??= -1; // gone before its exit event: a new login may start now
    return result;
  };
  const loginRoutes = {
    state: () => ({ status: 200, ...Object.fromEntries(Object.keys(LOGIN).map((agent) => {
      const login = logins.get(agent);
      return [agent, { running: Boolean(login && login.exit === undefined), url: login?.url ?? null, exit: login?.exit ?? null }];
    })) }),
    async start(body) {
      if (!body || typeof body !== 'object' || Object.keys(body).join() !== 'agent' || !agentName(body.agent)) return refused(400, 'request-refused');
      const { agent } = body;
      if (closing) return refused(503, 'shutting-down');
      if (logins.has(agent) && logins.get(agent).exit === undefined) return refused(409, 'login-running');
      const [program, ...entry] = adapterOverride ? [process.execPath, adapterOverride, agent] : [process.execPath, adapterEntry(agent)];
      const tree = launchTree([program, ...entry, ...LOGIN[agent]], workspace);
      const login = { tree, url: null, exit: undefined, timer: setTimeout(() => endLogin(agent), 10 * 60 * 1000) };
      logins.set(agent, login);
      let seen = '';
      const read = (chunk) => {
        if (login.url || seen.length > 65536) return;
        seen += chunk;
        login.url = /https:\/\/[^\s"'<>\x1b]{1,4096}/.exec(seen)?.[0] ?? null;
      };
      tree.child.stdout.on('data', read);
      tree.child.stderr.on('data', read);
      tree.child.stdin.on('error', () => {});
      tree.child.on('error', () => { login.exit = -1; clearTimeout(login.timer); });
      tree.child.on('exit', (code) => { login.exit = code ?? -1; clearTimeout(login.timer); });
      return { status: 202, started: agent };
    },
    code(body) {
      if (!body || typeof body !== 'object' || Object.keys(body).sort().join() !== 'agent,code' || !agentName(body.agent)
          || typeof body.code !== 'string' || !/^[\x20-\x7e]{1,512}$/.test(body.code)) return refused(400, 'request-refused');
      const login = logins.get(body.agent);
      if (!login || login.exit !== undefined) return refused(409, 'login-not-running');
      login.tree.child.stdin.write(body.code + '\n');
      return { status: 202, sent: true };
    },
    async stop(body) {
      if (!body || typeof body !== 'object' || Object.keys(body).join() !== 'agent' || !agentName(body.agent)) return refused(400, 'request-refused');
      const result = await endLogin(body.agent);
      return result === 'stopped' ? { status: 200, stopped: body.agent } : refused(500, result);
    },
  };

  // Stops every scope of this daemon instance that no live or failed conversation owns, and confirms none is left.
  // ponytail: without a systemd user bus a restarted daemon cannot find old process groups, so it reports stopped.
  async function sweep() {
    if (!hasUserBus()) return 'stopped';
    const owned = new Set([...[...live.values()].map((s) => s.proc), ...failed.values()].map((proc) => proc.unit + '.scope'));
    const orphans = async () => {
      try {
        const { stdout } = await run('systemctl', ['--user', 'list-units', '--plain', '--no-legend', '--state=active,activating,deactivating,reloading',
          `p9-chat-${instance}-*.scope`], { env: childEnv(), timeout: 1000 });
        return stdout.split('\n').map((line) => line.trim().split(/\s+/)[0]).filter((unit) => unit && !owned.has(unit));
      } catch { return null; }
    };
    let left = await orphans();
    if (left?.length) {
      await run('systemctl', ['--user', 'stop', ...left], { env: childEnv(), timeout: 1000 }).catch(() => {});
      for (let i = 0; i < 20 && (left = await orphans())?.length; i++) await wait(50);
    }
    return left?.length === 0 ? 'stopped' : 'cleanup-failed';
  }

  // A daemon restart: turns in flight are interrupted, never retried; pending approvals expire; history stays. A daemon
  // killed outright leaves its scopes behind, so those conversations stay cleanup-failed (prompts refused) until the
  // sweep confirms no scope is left. Prompts and Stops wait for this first.
  const leftover = db.prepare("SELECT id, state FROM conversations WHERE state IN ('running', 'turn', 'stopping', 'cleanup-failed')").all();
  for (const conversation of leftover) {
    if (conversation.state === 'turn') emit(conversation.id, 'interrupted', { reason: 'daemon-restart' });
    setState(conversation.id, 'cleanup-failed');
  }
  const recovered = sweep().then((result) => {
    if (result === 'stopped') for (const { id } of leftover) db.prepare("UPDATE conversations SET state = 'stopped' WHERE id = ? AND state = 'cleanup-failed'").run(id);
  });

  // Records a cleanup outcome. Only a confirmed stop reopens the conversation.
  function settle(id, proc, result) {
    if (result === 'stopped') { failed.delete(id); setState(id, 'stopped'); } else { if (proc) failed.set(id, proc); setState(id, 'cleanup-failed'); }
    return result;
  }

  async function connect(conversation) {
    if (live.has(conversation.id)) return live.get(conversation.id);
    const proc = launchTree(command(conversation.provider), workspace, { instance, scope: true });
    let stderr = '';
    proc.child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4096); });
    const session = { proc, pending: new Map(), turn: null };
    session.exited = new Promise((resolve) => {
      proc.child.once('exit', (code, signal) => {
        resolve();
        if (live.get(conversation.id) !== session) return;
        live.delete(conversation.id);
        for (const pending of session.pending.values()) pending.resolve(null);
        if (session.stopping) return;
        // The adapter died on its own; its scope may still hold children, so end it like a Stop would.
        emit(conversation.id, 'exited', { code, signal });
        session.stopping = true;
        setState(conversation.id, 'stopping');
        stops.set(conversation.id, endTree(proc).then((result) => settle(conversation.id, proc, result)).finally(() => stops.delete(conversation.id)));
      });
      proc.child.once('error', () => { if (!proc.child.pid) resolve(); });
    });
    const ask = (kind) => (request) => new Promise((resolve) => {
      if (kind === 'approval' && locked) { emit(conversation.id, 'lock-rejected', { toolCall: trim(request.toolCall) }); return resolve(reject(request)); }
      const id = randomUUID(), form = kind === 'question' ? formSpec(request.requestedSchema) : undefined;
      session.pending.set(id, { kind, request, form, resolve: (answer) => {
        session.pending.delete(id);
        resolve(answer ?? (kind === 'approval' ? { outcome: { outcome: 'cancelled' } } : { action: 'cancel' }));
      } });
      emit(conversation.id, kind, kind === 'approval'
        ? { request: id, toolCall: trim(request.toolCall), options: request.options }
        : { request: id, message: request.message, schema: request.requestedSchema, form });
    });
    const stream = acp.ndJsonStream(Writable.toWeb(proc.child.stdin), Readable.toWeb(proc.child.stdout));
    session.agent = new acp.ClientSideConnection(() => ({
      sessionUpdate: async ({ update }) => {
        if (update?.sessionUpdate === 'config_option_update') models(session, conversation.id, update.configOptions);
        // Both adapters name the chat after its first turn (session_info_update.title); kept so the tab and list show it.
        if (update?.sessionUpdate === 'session_info_update' && typeof update.title === 'string') {
          const title = update.title.replace(/\s+/g, ' ').trim().slice(0, 120);
          if (title) db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, conversation.id);
        }
        emit(conversation.id, 'update', trim(agentImages(update)));
      },
      requestPermission: ask('approval'),
      createElicitation: ask('question'),
    }), stream);
    live.set(conversation.id, session);
    let timer;
    const limit = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('adapter-start-timeout')), START_MS); });
    limit.catch(() => {});
    const exited = session.exited.then(() => { throw new Error('adapter-exited'); });
    exited.catch(() => {});
    const bounded = (step) => Promise.race([step, exited, limit]);
    try {
      const init = await bounded(session.agent.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities }));
      // The chat's folder, checked again at every start like a file path (threat model row 24): a folder since swapped for a link fails.
      await bounded(listDirectory(workspace, conversation.folder ?? ''));
      const cwd = conversation.folder ? path.join(workspace, conversation.folder) : workspace;
      session.capabilities = init.agentCapabilities ?? {};
      // contracts.md rule 4: the adapter's own sessionId is kept and resumed natively.
      if (conversation.session) {
        const resumed = await bounded(session.agent.resumeSession({ sessionId: conversation.session, cwd, mcpServers: [] }));
        session.sessionId = conversation.session;
        // contracts.md rule 2 holds on resume too: the adapter's own default auto-approves.
        if (conversation.provider === 'codex' || locked) await bounded(setMode(session, conversation.provider));
        emit(conversation.id, 'resumed', { session: conversation.session });
        models(session, conversation.id, resumed?.configOptions);
      } else {
        const created = await bounded(session.agent.newSession({ cwd, mcpServers: [] }));
        session.sessionId = created.sessionId;
        db.prepare('UPDATE conversations SET session = ? WHERE id = ?').run(session.sessionId, conversation.id);
        // contracts.md rule 2: Codex starts in workspace-write, not the adapter's auto-approving default.
        if (conversation.provider === 'codex' || locked) await bounded(setMode(session, conversation.provider));
        emit(conversation.id, 'connected', { session: session.sessionId });
        models(session, conversation.id, created.configOptions);
      }
      if (!session.stopping) setState(conversation.id, 'running');
      return session;
    } catch (error) {
      // Stopped mid-start: Stop owns the cleanup and the row state.
      if (session.stopping) throw Object.assign(new Error('stopping'), { status: 409 });
      session.stopping = true;
      live.delete(conversation.id);
      proc.child.stdin.end();
      await Promise.race([session.exited, wait(1000)]);
      const result = await endTree(proc);
      emit(conversation.id, 'error', { message: agentError(error, conversation.provider), stderr: stderr.slice(-1000) });
      settle(conversation.id, proc, result);
      throw Object.assign(new Error('adapter-start-failed'), { status: 502 });
    } finally {
      clearTimeout(timer);
    }
  }

  // contracts.md rule 3, timed to finish inside 5 s: close the session, close stdin, then end the whole scope.
  async function stopSession(id, session) {
    session.stopping = true;
    live.delete(id);
    for (const pending of session.pending.values()) pending.resolve(null);
    if (session.sessionId && session.capabilities?.sessionCapabilities?.close && session.proc.child.exitCode === null)
      await Promise.race([session.agent.closeSession({ sessionId: session.sessionId }).catch(() => {}), session.exited, wait(800)]);
    session.proc.child.stdin.end();
    await Promise.race([session.exited, wait(1000)]);
    return endTree(session.proc);
  }

  // One Stop per conversation: a second Stop (or shutdown) waits for the same cleanup, and the row stays 'stopping'
  // until it ends. The row then holds the real outcome; cleanup-failed keeps refusing prompts until a later Stop
  // confirms the scope is empty.
  function stopConversation(id) {
    if (stops.has(id)) return stops.get(id);
    const session = live.get(id), proc = session?.proc ?? failed.get(id), wasFailed = row(id)?.state === 'cleanup-failed';
    if (session) session.stopping = true;
    setState(id, 'stopping');
    stops.set(id, (async () => {
      const result = session ? await stopSession(id, session) : proc ? await endTree(proc) : wasFailed ? await sweep() : 'stopped';
      settle(id, proc, result);
      emit(id, 'stopped', { result });
      return result;
    })().finally(() => stops.delete(id)));
    return stops.get(id);
  }

  async function stopAll() {
    await recovered;
    // A row still cleanup-failed from startup (its scope query failed) is in no map, so it is swept here (release r2 R2-3).
    const stale = db.prepare("SELECT id FROM conversations WHERE state = 'cleanup-failed'").all().map(({ id }) => id);
    const results = await Promise.all([...new Set([...live.keys(), ...stops.keys(), ...failed.keys(), ...stale])].map(stopConversation));
    return results.includes('cleanup-failed') ? 'cleanup-failed' : 'stopped';
  }

  return {
    login: loginRoutes,
    lock: () => ({ status: 200, on: locked }),
    // Desktop only (server.mjs). Live sessions switch now; one whose mode change fails is stopped rather than left writable.
    async setLock(body) {
      if (!body || typeof body !== 'object' || Object.keys(body).join() !== 'on' || typeof body.on !== 'boolean') return refused(400, 'request-refused');
      locked = body.on;
      db.prepare("INSERT INTO prefs (key, value) VALUES ('agent-lock', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(locked ? 'on' : 'off');
      await Promise.all([...live].map(async ([id, session]) => {
        if (!session.sessionId || session.stopping) return; // still starting: connect reads the new value itself
        if (locked) for (const [request, pending] of session.pending) if (pending.kind === 'approval') {
          emit(id, 'lock-rejected', { toolCall: trim(pending.request.toolCall) });
          pending.resolve(reject(pending.request));
          emit(id, 'answered', { request, answer: reject(pending.request) });
        }
        try { await Promise.race([setMode(session, row(id).provider), wait(5000).then(() => { throw new Error('timeout'); })]); }
        catch { if (locked) await stopConversation(id); }
      }));
      return { status: 200, on: locked };
    },
    list: () => db.prepare('SELECT id, provider, title, state, created, folder FROM conversations ORDER BY created').all(),
    // folder: where the agent starts, workspace-relative; checked like GET /files/list (threat model row 24).
    async create(body) {
      if (!PROVIDERS.has(body?.provider) || (body.title !== undefined && (typeof body.title !== 'string' || body.title.length > 120))
          || (body.folder !== undefined && (typeof body.folder !== 'string' || !await listDirectory(workspace, body.folder).then(() => true, () => false))))
        return refused(400, 'request-refused');
      const id = randomUUID(), title = body.title?.trim() || (body.provider === 'claude' ? 'Claude' : 'Codex');
      db.prepare("INSERT INTO conversations (id, provider, title, state, created, folder) VALUES (?, ?, ?, 'idle', ?, ?)").run(id, body.provider, title, Date.now(), body.folder ?? '');
      emit(id, 'created', { provider: body.provider, title, folder: body.folder ?? '' });
      return { status: 201, conversation: id };
    },
    async prompt(id, body) {
      await recovered;
      const release = lifecycle.begin();
      if (!release) return refused(503, 'stop-all-running');
      const conversation = ID.test(id) && row(id);
      if (!conversation) { release(); return refused(404, 'unknown-conversation'); }
      const images = body?.images ?? [];
      if (typeof body?.text !== 'string' || !imagesOk(images) || (!body.text.trim() && !images.length) || body.text.length > MAX_TEXT) { release(); return refused(400, 'request-refused'); }
      if (body.mode !== undefined && !Object.hasOwn(MODES[conversation.provider], body.mode)) { release(); return refused(400, 'request-refused'); }
      if (body.model !== undefined && (typeof body.model !== 'string' || !body.model || body.model.length > 200)) { release(); return refused(400, 'request-refused'); }
      const picks = body.config === undefined ? [] : body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? Object.entries(body.config) : null;
      if (!picks || picks.length > 6 || picks.some(([k, v]) => k.length > 60 || typeof v !== 'string' || !v || v.length > 200)) { release(); return refused(400, 'request-refused'); }
      if (conversation.state === 'turn') { release(); return refused(409, 'turn-running'); }
      // A prompt during Stop, or after a cleanup P9 could not confirm, would launch a second adapter beside old work.
      if (!['idle', 'running', 'stopped'].includes(conversation.state)) { release(); return refused(409, conversation.state); }
      if (closing) { release(); return refused(503, 'shutting-down'); }
      setState(id, 'turn');
      emit(id, 'user', images.length ? { text: body.text, images: images.length } : { text: body.text }); // the count only: events stay small
      let session;
      try { session = await connect(conversation); } catch (error) { release(); return refused(error.status ?? 500, error.status === 409 ? 'stopping' : 'adapter-start-failed'); }
      release();
      if (session.stopping) return refused(409, 'stopping');
      try { stillAuthorized(); } catch (error) { setState(id, 'running'); throw error; }
      setState(id, 'turn');
      // A mode that cannot be set stops the turn: running it in another mode could do what Plan or Manual would not.
      const want = locked ? modeFor(conversation.provider) : body.mode && MODES[conversation.provider][body.mode];
      if (want && want !== session.mode) {
        try { await Promise.race([setMode(session, conversation.provider, want), wait(5000).then(() => { throw new Error('timeout'); })]); }
        catch { if (live.get(id) === session) setState(id, 'running'); emit(id, 'error', { message: 'Mode ' + want + ' could not be set; nothing was sent.' }); return refused(500, 'mode-failed'); }
      }
      if (body.model && body.model !== session.models?.current) {
        if (!session.models?.options.some((o) => o.value === body.model)) {
          if (live.get(id) === session) setState(id, 'running'); emit(id, 'error', { message: 'This agent does not offer that model; nothing was sent.' }); return refused(400, 'model-unknown');
        }
        try {
          const result = await Promise.race([session.agent.setSessionConfigOption({ sessionId: session.sessionId, configId: 'model', value: body.model }), wait(5000).then(() => { throw new Error('timeout'); })]);
          if (!models(session, id, result?.configOptions)) { session.models.current = body.model; emit(id, 'config', { model: session.models, pickers: session.pickers }); }
        } catch { if (live.get(id) === session) setState(id, 'running'); emit(id, 'error', { message: 'The model could not be set; nothing was sent.' }); return refused(500, 'model-failed'); }
      }
      // After the model: a model switch can change the effort list. A refused or failed setting stops the turn, like Model.
      for (const [configId, value] of picks) {
        const o = session.pickers?.find((x) => x.id === configId);
        if (value === o?.current) continue;
        if (!o?.options.some((x) => x.value === value)) {
          if (live.get(id) === session) setState(id, 'running'); emit(id, 'error', { message: 'This agent does not offer that setting; nothing was sent.' }); return refused(400, 'config-unknown');
        }
        try {
          const result = await Promise.race([session.agent.setSessionConfigOption({ sessionId: session.sessionId, configId, value }), wait(5000).then(() => { throw new Error('timeout'); })]);
          if (!models(session, id, result?.configOptions)) { o.current = value; emit(id, 'config', { model: session.models, pickers: session.pickers }); }
        } catch { if (live.get(id) === session) setState(id, 'running'); emit(id, 'error', { message: o.name + ' could not be set; nothing was sent.' }); return refused(500, 'config-failed'); }
      }
      if (images.length && !session.capabilities.promptCapabilities?.image) {
        if (live.get(id) === session) setState(id, 'running'); emit(id, 'error', { message: 'This agent does not take images; nothing was sent.' }); return refused(400, 'images-unsupported');
      }
      // Again after the mode, model and effort awaits (up to 5 s each): a device revoked meanwhile sends nothing.
      try { stillAuthorized(); } catch (error) { if (live.get(id) === session) setState(id, 'running'); throw error; }
      const turn = session.turn = randomUUID();
      const prompt = [...(body.text.trim() ? [{ type: 'text', text: body.text }] : []), ...images.map(({ mimeType, data }) => ({ type: 'image', mimeType, data }))];
      session.agent.prompt({ sessionId: session.sessionId, prompt }).then(
        // result.usage is the turn's token counts (ACP PromptResponse); the usage view sums them.
        (result) => { if (session.turn === turn) emit(id, 'turn-end', { stopReason: result.stopReason, ...(result.usage && { usage: result.usage }) }); },
        (error) => { if (session.turn === turn && !session.stopping) emit(id, 'error', { message: agentError(error, conversation.provider) }); },
      ).finally(() => { if (session.turn === turn) { session.turn = null; if (live.get(id) === session) setState(id, 'running'); } });
      return { status: 202, turn };
    },
    answer(id, body) {
      const session = ID.test(id) && live.get(id);
      const pending = session && typeof body?.request === 'string' && session.pending.get(body.request);
      if (!pending) return refused(404, 'no-such-request');
      const answer = validAnswer(pending, body.answer);
      if (!answer) return refused(400, 'request-refused');
      // The route's own check ran before later awaits; a device revoked since then must not approve the agent's action.
      stillAuthorized();
      pending.resolve(answer);
      emit(id, 'answered', { request: body.request, answer });
      return { status: 200, ok: true };
    },
    async cancel(id) {
      const session = ID.test(id) && live.get(id);
      if (!session?.turn) return refused(409, 'no-turn');
      for (const pending of session.pending.values()) pending.resolve(null);
      await session.agent.cancel({ sessionId: session.sessionId });
      return { status: 200, ok: true };
    },
    async stop(id) {
      // Startup recovery settles every row first, so it never overwrites a Stop that began meanwhile.
      await recovered;
      if (!ID.test(id) || !row(id)) return refused(404, 'unknown-conversation');
      const result = await stopConversation(id);
      return { status: result === 'stopped' ? 200 : 500, result };
    },
    stopAll,
    // Events after a cursor; waits up to waitMs for the first new one so a client can long-poll.
    // only (up to 100 conversation IDs) and until: just those chats' events, up to that cursor, never waiting. The
    // desktop replays only the chats that are not stopped, then loads a stopped one's history when it is opened (E2).
    async events(after, waitMs, only, until) {
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(waitMs) || waitMs < 0) return refused(400, 'request-refused');
      if (only !== undefined || until !== undefined) {
        if (!Array.isArray(only) || only.length > 100 || !only.every((id) => ID.test(id)) || (until !== undefined && (!Number.isSafeInteger(until) || until < after))) return refused(400, 'request-refused');
        return { status: 200, ...ledger.of(only, after, until) };
      }
      let events = ledger.after(after);
      if (!events.length && waitMs) {
        await new Promise((resolve) => {
          const done = () => { listeners.delete(done); clearTimeout(timer); resolve(); };
          const timer = setTimeout(done, Math.min(waitMs, 8000));
          listeners.add(done);
        });
        events = ledger.after(after);
      }
      return { status: 200, events, cursor: events.length ? events.at(-1).cursor : after };
    },
    // Daemon shutdown: wake every long poll so the server can close, stop every session, and return 'cleanup-failed'
    // if any scope may still hold work (the next start stops leftover scopes again).
    async shutdown() {
      closing = true;
      for (const wake of listeners) wake();
      await Promise.all(Object.keys(LOGIN).map(endLogin));
      // A startup sweep still stopping a crashed daemon's scopes finishes before exit.
      await recovered;
      // Every conversation that may own work: live, mid-Stop (already out of live), or left by a failed cleanup.
      return stopAll();
    },
  };
}
