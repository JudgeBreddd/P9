// Send to server (D14, threat model row 51): a Claude chat moves, between turns, from this computer's P9 to a server's P9.
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
// The Hand off host check (remote.mjs HOST), for the host named in a moved event.
const HOST = /^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,252}$/;
const refused = (status, error, extra) => ({ status, error, ...extra });
const CODEX = 'Codex chats cannot move to the server yet: their history lives in Codex\'s own files. Claude chats can.';
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
// A session's transcript in any project folder, as claude-agent-acp's findTranscript looks it up.
async function transcriptOf(session) {
  for (const folder of await readdir(projects()).catch(() => [])) {
    const file = path.join(projects(), folder, session + '.jsonl');
    if ((await stat(file).catch(() => null))?.isFile()) return file;
  }
  return null;
}
// A workspace-relative path a manifest names: no absolute path, no '..', no empty or '.' part.
const relative = (value) => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !value.includes('\0') && !path.isAbsolute(value)
  && value.split(/[\\/]/).every((part) => part && part !== '.' && part !== '..');

export function createMove({ db, workspace, ownership, row, emit, stopConversation, recovered }) {
  const moves = ownership && path.join(ownership, 'moves');
  const staged = (name) => path.join(moves, name);
  const cwdOf = (conversation) => conversation.folder ? path.join(workspace, conversation.folder) : workspace;
  const unfreeze = (id) => db.prepare("UPDATE conversations SET state = 'stopped' WHERE id = ? AND state = 'moving'").run(id).changes > 0;
  const appending = new Set();

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
      if (conversation.provider !== 'claude') return refused(409, 'move-unavailable', { message: CODEX });
      if (!ID.test(conversation.session ?? '')) return refused(409, 'move-unavailable', { message: 'This chat has no Claude session yet. Send it a message first.' });
      if (!moves) return refused(503, 'move-unavailable', { message: 'This P9 cannot stage a move.' });
      if (conversation.state === 'turn') return refused(409, 'turn-running', { message: BUSY });
      if (conversation.state === 'moved') return refused(409, 'moved', { message: 'This chat has moved already.' });
      if (!await transcriptOf(conversation.session)) return refused(409, 'transcript-missing', { message: 'Claude Code\'s transcript of this chat is not on this computer, so it cannot move.' });
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
        const transcript = await transcriptOf(conversation.session);
        const part = async (file) => ({ bytes: (await stat(file)).size, sha256: await sha256(file) });
        return { status: 200, session: conversation.session, title: conversation.title, folder: conversation.folder, created: conversation.created, from: cwdOf(conversation),
          parts: { transcript: await part(transcript), events: await part(staged(id + '.events')) }, ...files };
      } catch (error) { console.error(JSON.stringify({ event: 'P9_MOVE_STAGE_FAILED', code: error.code })); return refused(500, 'move-stage-failed'); }
    },
    // One piece of a frozen chat's transcript or history, base64.
    async part(id, kind, offset) {
      const conversation = ID.test(id) && row(id);
      if (!conversation || conversation.state !== 'moving') return refused(409, 'not-moving');
      if (!KINDS.includes(kind) || !Number.isSafeInteger(offset) || offset < 0) return refused(400, 'request-refused');
      const file = kind === 'events' ? staged(id + '.events') : await transcriptOf(conversation.session);
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
      // ponytail: an abandoned upload (moves/in-<id>.*, up to 512 MiB per kind) is removed only by a later land of the
      // same id; there is no sweep. Fine while only the user's own desktop, over ssh, can send one.
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
    async land(id, body) {
      const part = (value) => value && Number.isSafeInteger(value.bytes) && value.bytes >= 0 && value.bytes <= MAX_PART && HASH.test(value.sha256);
      if (!ID.test(id) || !ID.test(body?.session ?? '') || typeof body.title !== 'string' || body.title.length > 120 || typeof body.folder !== 'string'
          || typeof body.from !== 'string' || body.from.length > 4096 || !Number.isSafeInteger(body.created) || !KINDS.every((kind) => part(body.parts?.[kind]))
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
      // The transcript goes where Claude Code keeps this folder's sessions. One already here for this session is never replaced.
      const existing = await transcriptOf(body.session);
      if (existing && await sha256(existing) !== body.parts.transcript.sha256) return refused(409, 'session-here');
      if (!existing) {
        const folder = path.join(projects(), projectFolder(cwd)), target = path.join(folder, body.session + '.jsonl');
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
        db.prepare("INSERT INTO conversations (id, provider, title, session, state, created, folder) VALUES (?, 'claude', ?, ?, 'stopped', ?, ?)")
          .run(id, body.title, body.session, body.created, body.folder);
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
// The old folder is the sender's own word, put in the prompt as-is: trusted only because the sender is the user's own
// desktop over ssh (row 51).
export function movedNote(db, id) {
  const last = db.prepare("SELECT type, data FROM events WHERE conversation = ? AND type IN ('moved-in', 'user') ORDER BY cursor DESC LIMIT 1").get(id);
  if (last?.type !== 'moved-in') return null;
  let data;
  try { data = JSON.parse(last.data); } catch { return null; }
  if (typeof data?.from !== 'string' || typeof data.to !== 'string' || data.from === data.to) return null;
  return `[P9: this chat moved here from another computer. Its working folder there was ${data.from}; here it is ${data.to}. `
    + `A path under ${data.from} is at the same place under ${data.to}.]\n\n`;
}
