// Send to server (D14, threat model row 51): a Claude or Codex chat moves, between turns, from this computer's P9 to a server's P9.
// The sending daemon: sendAway freezes the chat (state moving; prompts, Stop and Hand off are refused), stages its P9
// history and says what the move needs; part hands the transcript and history out in pieces; moved settles it, moved for
// good or back to stopped. The receiving daemon: take appends the pieces, land checks them and the files the chat
// edited, writes the transcript where Claude Code finds it and adds the chat with the same ID and session.
// Desktop main runs the move over the Server mode tunnel (apps/desktop/move.mjs). Desktop routes only, never the phone's.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, chmod, copyFile, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listDirectory } from '../../packages/files/index.mjs';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, HASH = /^[0-9a-f]{64}$/;
const KINDS = ['transcript', 'events'];
// Raw bytes a piece: as base64 in JSON it stays well under the daemon's 12 MiB body limit.
export const PIECE = 4 * 1024 * 1024;
const MAX_PART = 512 * 1024 * 1024, MAX_FILES = 500;
// An upload nobody finished (app quit, lost link) is swept after this long (Builder, 2026-10-27: 6 h); the sweep runs at
// daemon start and every hour.
export const ABANDONED = 6 * 3600_000;
const SWEEP_EVERY = 3600_000;
// The sender's old folder, as the moved note puts it in the agent's prompt: an absolute path (POSIX or Windows), at most
// 1024 characters, with no control or format character and no ']' (the note's own end), so it cannot add instructions.
const fromOk = (value) => typeof value === 'string' && value.length > 0 && value.length <= 1024 && (path.posix.isAbsolute(value) || path.win32.isAbsolute(value))
  && !/[\p{Cc}\p{Cf}\]]/u.test(value);
// The Hand off host check (remote.mjs HOST), for the host named in a moved event.
const HOST = /^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,252}$/;
const refused = (status, error, extra) => ({ status, error, ...extra });
const BUSY = 'Finish or stop the turn first, then send the chat to the server.';
const sha256 = (file) => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  createReadStream(file).on('error', reject).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
});
const fileHash = async (file) => (await stat(file).catch(() => null))?.isFile() ? sha256(file) : null;
// Claude Code's own folder (claude-agent-acp's claudeConfigDir). Agents get no CLAUDE_CONFIG_DIR (child-env.mjs), so it is HOME's.
// Under the test home (test/helpers.mjs sets P9_TEST_HOME) it is that home's, so a test never writes a real ~/.claude.
const projects = () => path.join(process.env.P9_TEST_HOME || os.homedir(), '.claude', 'projects');
// The folder Claude Code keeps a working directory's sessions in: every non-alphanumeric made '-' (the Agent SDK's rule).
// ponytail: past 200 characters the SDK adds a hash; claude-agent-acp's resume searches every project folder, so it still resumes.
const projectFolder = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200);
// Codex's own folder (item 10): agents get no CODEX_HOME (child-env.mjs), so it is HOME's .codex. Codex keeps a chat as
// sessions/YYYY/MM/DD/rollout-<time>-<session>.jsonl and resumes it by id: its state database first, then by file name
// under sessions/, so a rollout put back at the same place on the server resumes there.
const codexSessions = () => path.join(process.env.P9_TEST_HOME || os.homedir(), '.codex', 'sessions');
const ROLLOUT = /^(\d{4})\/(\d{2})\/(\d{2})\/rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f-]{36})\.jsonl$/;
// A session's transcript: Claude's in any project folder, as claude-agent-acp's findTranscript looks it up; Codex's
// rollout by its name in the day folders, newest first.
// ponytail: walks every day folder Codex has; a few thousand stats on a years-old ~/.codex, once per move.
async function transcriptOf(session, provider = 'claude') {
  if (provider === 'codex') {
    const root = codexSessions(), names = async (dir) => (await readdir(dir).catch(() => [])).filter((n) => /^\d+$/.test(n)).sort().reverse();
    for (const y of await names(root)) for (const m of await names(path.join(root, y))) for (const d of await names(path.join(root, y, m))) {
      const name = (await readdir(path.join(root, y, m, d)).catch(() => [])).find((n) => ROLLOUT.exec(y + '/' + m + '/' + d + '/' + n)?.[4] === session);
      if (name && (await stat(path.join(root, y, m, d, name)).catch(() => null))?.isFile()) return path.join(root, y, m, d, name);
    }
    return null;
  }
  for (const folder of await readdir(projects()).catch(() => [])) {
    const file = path.join(projects(), folder, session + '.jsonl');
    if ((await stat(file).catch(() => null))?.isFile()) return file;
  }
  return null;
}
const AGENT = { claude: 'Claude Code', codex: 'Codex' };
// A workspace-relative path a manifest names: no absolute path, no '..', no empty or '.' part.
const relative = (value) => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !value.includes('\0') && !path.isAbsolute(value)
  && value.split(/[\\/]/).every((part) => part && part !== '.' && part !== '..');

export function createMove({ db, workspace, ownership, row, emit, stopConversation, recovered }) {
  const moves = ownership && path.join(ownership, 'moves');
  const staged = (name) => path.join(moves, name);
  const cwdOf = (conversation) => conversation.folder ? path.join(workspace, conversation.folder) : workspace;
  const unfreeze = (id) => db.prepare("UPDATE conversations SET state = 'stopped' WHERE id = ? AND state = 'moving'").run(id).changes > 0;
  const appending = new Set();

  // Abandoned uploads (item 6, row 51): an upload here older than the limit whose chat never landed, the sender's staged
  // history of a chat that is no longer moving, and a file send's staging (item 23) older than the limit. A piece being
  // appended is never touched. Each removal is logged without its path.
  async function sweep(now = Date.now()) {
    if (!moves) return;
    const gone = async (file, kind) => {
      const info = await stat(file).catch(() => null);
      if (!info) return;
      await rm(file, { force: true });
      console.error(JSON.stringify({ event: 'P9_MOVE_SWEPT', kind, bytes: info.size }));
    };
    for (const name of await readdir(moves).catch(() => [])) {
      const file = staged(name), incoming = /^in-([0-9a-f-]{36})\.(transcript|events)$/.exec(name), outgoing = /^([0-9a-f-]{36})\.events$/.exec(name);
      if (incoming && ID.test(incoming[1]) && !appending.has(file) && !row(incoming[1])) {
        const info = await stat(file).catch(() => null);
        if (info && now - info.mtimeMs > ABANDONED && !appending.has(file)) await gone(file, 'upload');
      } else if (outgoing && ID.test(outgoing[1]) && row(outgoing[1])?.state !== 'moving') await gone(file, 'staged');
    }
    // Send files' staging (xfer.mjs, by its own upload id): a piece being appended touches only its own file, not the
    // folder, so the folder goes only when it and every piece in it are older than the limit.
    const xfer = path.join(ownership, 'xfer');
    for (const name of await readdir(xfer).catch(() => [])) {
      if (!/^in-[0-9a-f-]{36}$/.test(name)) continue;
      const dir = path.join(xfer, name), pieces = await readdir(dir).catch(() => null);
      const infos = pieces && await Promise.all([dir, ...pieces.map((piece) => path.join(dir, piece))].map((file) => stat(file).catch(() => null)));
      if (!infos?.[0] || infos.some((info) => info && now - info.mtimeMs <= ABANDONED)) continue;
      await rm(dir, { force: true, recursive: true });
      console.error(JSON.stringify({ event: 'P9_MOVE_SWEPT', kind: 'files', bytes: infos.slice(1).reduce((n, info) => n + (info?.size ?? 0), 0) }));
    }
  }
  if (moves) {
    recovered?.then(() => sweep()).catch(() => {});
    setInterval(() => sweep().catch(() => {}), SWEEP_EVERY).unref();
  }

  // The files the chat changed: its edit, delete and move tool calls' locations (ACP), workspace-relative, each with its
  // sha256 here (null: not a file here now, so it must not be one on the server either). Files outside the workspace
  // are only counted. ponytail: files changed through a shell command are not tool-call locations, so they are not checked.
  async function edited(id) {
    const kinds = new Map(), paths = new Set(), real = await realpath(workspace);
    let outside = 0;
    for (const { data } of db.prepare("SELECT data FROM events WHERE conversation = ? AND type = 'update' AND instr(data, 'tool_call') > 0 ORDER BY cursor").iterate(id)) {
      let update;
      try { update = JSON.parse(data); } catch { continue; }
      if (update?.sessionUpdate !== 'tool_call' && update?.sessionUpdate !== 'tool_call_update') continue;
      if (typeof update.kind === 'string') kinds.set(update.toolCallId, update.kind);
      if (!['edit', 'delete', 'move'].includes(kinds.get(update.toolCallId)) || !Array.isArray(update.locations)) continue;
      for (const location of update.locations) {
        if (typeof location?.path !== 'string' || !path.isAbsolute(location.path)) continue;
        const inside = [workspace, real].map((base) => path.relative(base, location.path)).find((rel) => relative(rel));
        if (inside) paths.add(inside.split(path.sep).join('/')); else outside += 1;
      }
    }
    if (paths.size > MAX_FILES) return null;
    return { files: await Promise.all([...paths].sort().map(async (rel) => ({ path: rel, sha256: await fileHash(path.join(workspace, rel)) }))), outside };
  }

  return {
    async sendAway(id) {
      await recovered;
      const conversation = ID.test(id) && row(id);
      if (!conversation) return refused(404, 'unknown-conversation');
      if (!AGENT[conversation.provider]) return refused(409, 'move-unavailable');
      if (!ID.test(conversation.session ?? '')) return refused(409, 'move-unavailable', { message: 'This chat has no ' + AGENT[conversation.provider] + ' session yet. Send it a message first.' });
      if (!moves) return refused(503, 'move-unavailable', { message: 'This P9 cannot stage a move.' });
      if (conversation.state === 'turn') return refused(409, 'turn-running', { message: BUSY });
      if (conversation.state === 'moved') return refused(409, 'moved', { message: 'This chat has moved already.' });
      if (!await transcriptOf(conversation.session, conversation.provider)) return refused(409, 'transcript-missing', { message: AGENT[conversation.provider] + '\'s history of this chat is not on this computer, so it cannot move.' });
      // moving already: a retry after a lost answer; the chat is frozen and nothing has changed since.
      if (conversation.state !== 'moving') {
        if (!['idle', 'running', 'stopped'].includes(conversation.state)) return refused(409, conversation.state, { message: 'The chat is ' + conversation.state + '. Try again in a moment.' });
        const result = await stopConversation(id);
        if (result !== 'stopped') return { status: 500, result };
        // A prompt that came in once the Stop finished wins: the chat is in a turn again, and stays here.
        if (!db.prepare("UPDATE conversations SET state = 'moving' WHERE id = ? AND state = 'stopped'").run(id).changes) return refused(409, 'turn-running', { message: BUSY });
        emit(id, 'moving');
      }
      try {
        const files = await edited(id);
        if (!files) { unfreeze(id); emit(id, 'move-failed', { message: 'This chat changed more than ' + MAX_FILES + ' files; P9 cannot check them all on the server.' }); return refused(409, 'too-many-files'); }
        await mkdir(moves, { recursive: true, mode: 0o700 });
        // The history the server shows, without this computer's own move events.
        const lines = [];
        for (const event of db.prepare("SELECT type, data, at FROM events WHERE conversation = ? AND type NOT IN ('moving', 'moved', 'move-failed') ORDER BY cursor").iterate(id)) {
          try { lines.push(JSON.stringify({ type: event.type, at: event.at, data: JSON.parse(event.data) })); } catch {}
        }
        await writeFile(staged(id + '.events'), lines.join('\n') + '\n', { mode: 0o600 });
        const transcript = await transcriptOf(conversation.session, conversation.provider);
        const part = async (file) => ({ bytes: (await stat(file)).size, sha256: await sha256(file) });
        // Codex: where the rollout goes on the server, the same day folder and name (no path of this computer's).
        const rollout = conversation.provider === 'codex' ? path.relative(codexSessions(), transcript).split(path.sep).join('/') : undefined;
        return { status: 200, provider: conversation.provider, ...(rollout && { rollout }), session: conversation.session, title: conversation.title, folder: conversation.folder, created: conversation.created, from: cwdOf(conversation),
          parts: { transcript: await part(transcript), events: await part(staged(id + '.events')) }, ...files };
      } catch (error) { console.error(JSON.stringify({ event: 'P9_MOVE_STAGE_FAILED', code: error.code })); return refused(500, 'move-stage-failed'); }
    },
    // One piece of a frozen chat's transcript or history, base64.
    async part(id, kind, offset) {
      const conversation = ID.test(id) && row(id);
      if (!conversation || conversation.state !== 'moving') return refused(409, 'not-moving');
      if (!KINDS.includes(kind) || !Number.isSafeInteger(offset) || offset < 0) return refused(400, 'request-refused');
      const file = kind === 'events' ? staged(id + '.events') : await transcriptOf(conversation.session, conversation.provider);
      const handle = file && await open(file, 'r').catch(() => null);
      if (!handle) return refused(409, 'move-stage-missing');
      try {
        const buffer = Buffer.alloc(PIECE), { bytesRead } = await handle.read(buffer, 0, PIECE, offset);
        return { status: 200, bytes: bytesRead, data: buffer.subarray(0, bytesRead).toString('base64') };
      } finally { await handle.close(); }
    },
    // ok: the server has the chat, so this copy is moved for good. Not ok: the server refused it, so the chat runs here again.
    async moved(id, body) {
      const conversation = ID.test(id) && row(id);
      if (!conversation) return refused(404, 'unknown-conversation');
      if (typeof body?.ok !== 'boolean' || typeof body.host !== 'string' || !HOST.test(body.host)
          || (body.message !== undefined && (typeof body.message !== 'string' || body.message.length > 600))) return refused(400, 'request-refused');
      if (conversation.state === 'moved' && body.ok) return { status: 200, ok: true };
      if (conversation.state !== 'moving') return refused(409, 'not-moving');
      if (body.ok) { db.prepare("UPDATE conversations SET state = 'moved' WHERE id = ?").run(id); emit(id, 'moved', { host: body.host }); }
      else { unfreeze(id); emit(id, 'move-failed', { host: body.host, ...(body.message && { message: body.message }) }); }
      await rm(staged(id + '.events'), { force: true });
      return { status: 200, ok: true };
    },

    // The receiving daemon. A piece is appended only at the exact size so far; 409 with that size lets a lost answer resume.
    async take(id, body) {
      if (!ID.test(id) || !KINDS.includes(body?.kind) || !Number.isSafeInteger(body.offset) || body.offset < 0
          || typeof body.data !== 'string' || body.data.length > Math.ceil(PIECE / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) return refused(400, 'request-refused');
      if (!moves) return refused(503, 'move-unavailable');
      if (row(id)) return refused(409, 'already-here');
      // An abandoned upload (moves/in-<id>.*, up to 512 MiB per kind) goes with Cancel, a later land of the same id, or the sweep.
      const file = staged('in-' + id + '.' + body.kind);
      if (appending.has(file)) return refused(409, 'busy');
      appending.add(file);
      try {
        await mkdir(moves, { recursive: true, mode: 0o700 });
        const size = (await stat(file).catch(() => null))?.size ?? 0, bytes = Buffer.from(body.data, 'base64');
        if (body.offset !== size) return refused(409, 'offset', { size });
        if (size + bytes.length > MAX_PART) return refused(413, 'move-too-large');
        await appendFile(file, bytes, { mode: 0o600 });
        return { status: 200, size: size + bytes.length };
      } finally { appending.delete(file); }
    },
    // Cancel during the upload: what the server has of it goes at once. A chat already here is not touched.
    // Named apart from chat.mjs's cancel (a turn's), which this object is spread beside.
    async cancelUpload(id) {
      if (!ID.test(id)) return refused(400, 'request-refused');
      if (!moves) return refused(503, 'move-unavailable');
      if (row(id)) return refused(409, 'already-here');
      const files = KINDS.map((kind) => staged('in-' + id + '.' + kind));
      if (files.some((file) => appending.has(file))) return refused(409, 'busy');
      await Promise.all(files.map((file) => rm(file, { force: true })));
      return { status: 200, cancelled: true };
    },
    sweep,
    async land(id, body) {
      const part = (value) => value && Number.isSafeInteger(value.bytes) && value.bytes >= 0 && value.bytes <= MAX_PART && HASH.test(value.sha256);
      // Codex (item 10): a provider of the two, and its rollout's day folder and name, which must name this session.
      const provider = body?.provider ?? 'claude';
      if (!AGENT[provider] || (provider === 'codex' ? typeof body.rollout !== 'string' || ROLLOUT.exec(body.rollout)?.[4] !== body.session : body.rollout !== undefined)) return refused(400, 'request-refused');
      if (!ID.test(id) || !ID.test(body?.session ?? '') || typeof body.title !== 'string' || body.title.length > 120 || typeof body.folder !== 'string'
          || !fromOk(body.from) || !Number.isSafeInteger(body.created) || !KINDS.every((kind) => part(body.parts?.[kind]))
          || !Array.isArray(body.files) || body.files.length > MAX_FILES || !body.files.every((f) => relative(f?.path) && (f.sha256 === null || HASH.test(f.sha256)))) return refused(400, 'request-refused');
      if (!moves) return refused(503, 'move-unavailable');
      const here = row(id);
      if (here) return here.session === body.session ? { status: 200, already: true } : refused(409, 'id-taken');
      if (db.prepare('SELECT 1 FROM conversations WHERE session = ?').get(body.session)) return refused(409, 'session-here');
      if (!await listDirectory(workspace, body.folder).then(() => true, () => false)) return refused(409, 'folder-missing', { folder: body.folder });
      const files = Object.fromEntries(KINDS.map((kind) => [kind, staged('in-' + id + '.' + kind)]));
      for (const kind of KINDS) {
        const size = (await stat(files[kind]).catch(() => null))?.size ?? 0;
        if (size !== body.parts[kind].bytes || await sha256(files[kind]).catch(() => null) !== body.parts[kind].sha256) {
          // A wrong piece cannot be fixed by appending: start the upload again.
          await Promise.all(KINDS.map((k) => rm(files[k], { force: true })));
          return refused(409, 'upload-mismatch');
        }
      }
      // Syncthing (or whatever syncs the workspace) may still be on its way: every file the chat changed must be the same here.
      const root = await realpath(workspace), behind = [];
      for (const file of body.files) {
        const full = path.join(workspace, file.path), real = await realpath(full).catch(() => null);
        const same = file.sha256 === null ? !(await stat(full).catch(() => null))
          : !!real && !path.relative(root, real).startsWith('..') && !path.isAbsolute(path.relative(root, real)) && await fileHash(real) === file.sha256;
        if (!same) behind.push(file.path);
      }
      if (behind.length) return refused(409, 'files-not-synced', { files: behind.slice(0, 5), count: behind.length });
      // History lines: a short event type, a time and a JSON object; stored as data, never run.
      const events = [];
      for (const line of (await readFile(files.events, 'utf8')).split('\n')) {
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch { return refused(400, 'events-refused'); }
        if (typeof event?.type !== 'string' || !/^[a-z][a-z-]{0,39}$/.test(event.type) || !Number.isSafeInteger(event.at) || !event.data || typeof event.data !== 'object') return refused(400, 'events-refused');
        events.push(event);
      }
      const cwd = body.folder ? path.join(workspace, body.folder) : workspace;
      // The transcript goes where Claude Code keeps this folder's sessions, a rollout in the same day folder Codex had it in.
      // One already here for this session is never replaced.
      const existing = await transcriptOf(body.session, provider);
      if (existing && await sha256(existing) !== body.parts.transcript.sha256) return refused(409, 'session-here');
      if (!existing) {
        const target = provider === 'codex' ? path.join(codexSessions(), ...body.rollout.split('/')) : path.join(projects(), projectFolder(cwd), body.session + '.jsonl');
        const folder = path.dirname(target);
        await mkdir(folder, { recursive: true, mode: 0o700 });
        await copyFile(files.transcript, target + '.p9-tmp');
        await chmod(target + '.p9-tmp', 0o600);
        await rename(target + '.p9-tmp', target);
      }
      // Synchronous from here: no other request can add this chat in between.
      if (row(id)) return row(id).session === body.session ? { status: 200, already: true } : refused(409, 'id-taken');
      const insert = db.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)');
      db.exec('BEGIN');
      try {
        db.prepare("INSERT INTO conversations (id, provider, title, session, state, created, folder) VALUES (?, ?, ?, ?, 'stopped', ?, ?)")
          .run(id, provider, body.title, body.session, body.created, body.folder);
        for (const event of events) insert.run(id, event.type, JSON.stringify(event.data), event.at);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      emit(id, 'moved-in', { from: body.from, to: cwd });
      await Promise.all(KINDS.map((kind) => rm(files[kind], { force: true })));
      return { status: 200, conversation: id };
    },
  };
}

// The first prompt after a move: the transcript names this chat's old folder, so the agent is told where it is now.
// The old folder is the sender's word, checked by land (fromOk) and again here for a row stored before that check.
// chat.mjs keeps the note in the message's user event, so the history shows what the agent was told.
export function movedNote(db, id) {
  const last = db.prepare("SELECT type, data FROM events WHERE conversation = ? AND type IN ('moved-in', 'user') ORDER BY cursor DESC LIMIT 1").get(id);
  if (last?.type !== 'moved-in') return null;
  let data;
  try { data = JSON.parse(last.data); } catch { return null; }
  if (!fromOk(data?.from) || typeof data.to !== 'string' || data.from === data.to) return null;
  return `[P9: this chat moved here from another computer. Its working folder there was ${data.from}; here it is ${data.to}. `
    + `A path under ${data.from} is at the same place under ${data.to}.]\n\n`;
}
