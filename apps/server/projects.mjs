// Projects (N1, threat model row N1, 2026-11-08). A project is an id that never changes plus its record. P9's own
// folder for it, <ownership>/projects/<id>/, holds project.json (name, about, where the work happens), instructions.md,
// files/ (the files added to the project) and state/ (kept for the memory layer's handoffs). The work folder is where
// the project's chats start: In P9, a folder the user already has (linked), or one new folder P9 made for it (new).
// Nothing here writes, moves or deletes anything in a work folder: the only write that names one is createDirectory for
// "new folder somewhere else". A chat's project is the conversations.project column, set only by the user.
import { link, lstat, mkdir, open, readdir, readFile, rename, rm, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { createDirectory, lockedName } from '../../packages/files/index.mjs';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_NAME = 120, MAX_ABOUT = 4000, MAX_INSTRUCTIONS = 32000, MAX_FILE = 4 * 1024 * 1024, MAX_FILES = 200;
const AGENT_FILES = ['AGENTS.md', 'CLAUDE.md'];
const refused = (status, error) => ({ status, error });
const text = (value, max) => typeof value === 'string' && value.length <= max && value.isWellFormed();
// One path part, as packages/files' partsFor checks each part: no separators, control characters or colons, not . or ..,
// at most 255 bytes, not a locked name (File protection's list, .p9-*) while File protection is on.
const partOk = (name) => typeof name === 'string' && name.length > 0 && name.isWellFormed() && Buffer.byteLength(name) <= 255
  && !/[\\/\x00-\x1f:]/.test(name) && name !== '.' && name !== '..' && !/^\.p9-/i.test(name) && !lockedName(name);
// A body with only these keys (an unknown key is refused, not ignored).
const only = (body, keys) => !!body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).every((key) => keys.includes(key));

// The record lands whole: a temp file in the same folder, synced, renamed over the old one.
async function replace(file, content) {
  const temporary = file + '.p9-tmp-' + randomUUID();
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, file); } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}
// An added file never replaces one: a temp file, then link() to the name, which fails with EEXIST (createFile's way).
async function addNew(folder, name, bytes) {
  const temporary = path.join(folder, '.p9-new-' + randomUUID());
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await link(temporary, path.join(folder, name));
  } finally { await unlink(temporary).catch(() => {}); }
}

// home: <ownership>/projects. folderCheck: chat.mjs's "Start in" check (row 24), which resolves to the folder's listing.
// db, row, emit, stop, recovered: chat.mjs's, for the chats in a project. remove: chat.mjs's delete of a chat's ledger rows and
// of its photos no other chat names (O35); it returns what the chat had spent.
// Step 1b (threat model row N1b): the stored folder of a chat that starts in its In P9 project's own files/. Not a path:
// ':' is refused in every workspace-relative folder, and it is never absolute, so no client can send it as one.
export const IN_P9 = ':project-files';
export function createProjects({ home, workspace, folderCheck, db, row, emit, stop, recovered, remove, sprintFiles }) {
  const folderOf = (id) => path.join(home, id);
  const filesOf = (id) => path.join(home, id, 'files');
  async function record(id) {
    if (!home || typeof id !== 'string' || !ID.test(id)) return null;
    try {
      // The project's own folder, not a link someone put in its place.
      if (!(await lstat(folderOf(id))).isDirectory()) return null;
      const value = JSON.parse(await readFile(path.join(folderOf(id), 'project.json'), 'utf8'));
      return value?.id === id && typeof value.name === 'string' && value.work && typeof value.work.kind === 'string' ? value : null;
    } catch { return null; }
  }
  const instructions = (id) => readFile(path.join(folderOf(id), 'instructions.md'), 'utf8').catch(() => '');
  const save = (value) => replace(path.join(folderOf(value.id), 'project.json'), JSON.stringify(value, null, 2) + '\n');
  async function files(id) {
    const names = await readdir(filesOf(id)).catch(() => []);
    const out = [];
    for (const name of names.sort()) {
      if (name.startsWith('.p9-')) continue;
      const info = await lstat(path.join(filesOf(id), name)).catch(() => null);
      if (info?.isFile()) out.push({ name, size: info.size });
    }
    return out;
  }
  // Where a chat in this project starts: its work folder, or for In P9 the marker IN_P9 (step 1b, threat model row N1b).
  const startFolder = (value) => (value.work.kind === 'p9' ? IN_P9 : value.work.folder);
  // An IN_P9 chat's folder, found again from its project id at every start: that project's own files/, a real folder with
  // no link below projects/. null when the chat is no longer in an In P9 project (it then starts in the workspace).
  async function filesStart(id) {
    const value = await record(id); // null for anything but a project's UUID
    return value?.work.kind === 'p9' ? ownFiles(value.id) : null;
  }
  // Any project's own files/ (step 1d, threat model row N1d: its chats' agents read there without being asked), with the
  // same check as filesStart: projects/<id>/ and files/ real folders, no link. null when there is no such project.
  async function ownFiles(id) {
    if (!(await record(id))) return null;
    for (const folder of [folderOf(id), filesOf(id)]) if (!(await lstat(folder)).isDirectory()) throw new Error('unsafe-path');
    return filesOf(id);
  }
  // A gone or refused work folder is reported, never thrown. AGENTS.md and CLAUDE.md are seen in the listing only.
  async function view(value, full = true) {
    let entries = null;
    if (value.work.kind === 'p9') entries = [];
    else try { entries = await folderCheck(value.work.folder); } catch { entries = null; }
    const chats = db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE project = ?').get(value.id).n;
    // D1, D3, D4: each chat in the project that has a sprint folder, with its files' text (SECURITY.md § Sprint files).
    const sprints = full && sprintFiles ? db.prepare('SELECT id, title FROM conversations WHERE project = ? ORDER BY created').all(value.id)
      .filter((c) => sprintFiles.exists(c.id)).map((c) => ({ lead: c.id, title: c.title, files: sprintFiles.list(c.id) })) : [];
    // Two projects may use one work folder (N1 spec, 2026-11-08): the others using it, for the dialog to name.
    const where = value.work.kind === 'p9' ? null : path.resolve(workspace, value.work.folder);
    const sharedWith = [];
    if (full && where) for (const name of await readdir(home).catch(() => [])) {
      const other = name === value.id ? null : await record(name);
      if (other && other.work.kind !== 'p9' && path.resolve(workspace, other.work.folder) === where) sharedWith.push({ id: other.id, name: other.name });
    }
    return { id: value.id, name: value.name, about: value.about, archived: value.archived === true, created: value.created,
      work: { kind: value.work.kind, folder: value.work.kind === 'p9' ? null : value.work.folder }, found: entries !== null,
      agentFiles: (entries ?? []).filter((entry) => !entry.dir && AGENT_FILES.includes(entry.name)).map((entry) => entry.name), chats,
      ...(full && { instructions: await instructions(value.id), files: await files(value.id), sharedWith, sprints }) };
  }

  const store = {
    async list() {
      const names = home ? await readdir(home).catch(() => []) : [];
      const out = [];
      for (const name of names) { const value = await record(name); if (value) out.push(await view(value, false)); }
      return { status: 200, projects: out.sort((a, b) => a.created - b.created) };
    },
    async get(id) {
      const value = await record(id);
      return value ? { status: 200, project: await view(value) } : refused(404, 'unknown-project');
    },
    // work: { kind: 'p9' } | { kind: 'linked', folder } | { kind: 'new', parent, name }.
    async create(body) {
      if (!home) return refused(503, 'projects-unavailable');
      if (!only(body, ['name', 'about', 'instructions', 'work']) || !text(body.name, MAX_NAME) || !body.name.trim()
          || (body.about !== undefined && !text(body.about, MAX_ABOUT)) || (body.instructions !== undefined && !text(body.instructions, MAX_INSTRUCTIONS))
          || !body.work || typeof body.work !== 'object') return refused(400, 'request-refused');
      const work = body.work;
      let folder = null;
      if (work.kind === 'linked' && only(work, ['kind', 'folder']) && typeof work.folder === 'string') {
        try { await folderCheck(work.folder); } catch { return refused(400, 'folder-refused'); }
        folder = work.folder;
      } else if (work.kind === 'new' && only(work, ['kind', 'parent', 'name']) && typeof work.parent === 'string' && partOk(work.name)) {
        try { await folderCheck(work.parent); } catch { return refused(400, 'folder-refused'); }
        folder = path.isAbsolute(work.parent) ? path.join(path.resolve(work.parent), work.name) : (work.parent ? work.parent + '/' + work.name : work.name);
      } else if (!(work.kind === 'p9' && only(work, ['kind']))) return refused(400, 'request-refused');
      const id = randomUUID();
      const value = { id, name: body.name.trim(), about: body.about ?? '', work: { kind: work.kind, folder }, created: Date.now(), archived: false };
      await mkdir(home, { recursive: true, mode: 0o700 });
      await mkdir(folderOf(id), { mode: 0o700 });
      try {
        await mkdir(filesOf(id), { mode: 0o700 });
        await mkdir(path.join(folderOf(id), 'state'), { mode: 0o700 });
        await replace(path.join(folderOf(id), 'instructions.md'), body.instructions ?? '');
        await save(value);
        // The one folder P9 makes outside its own: a single mkdir that fails on a name already there.
        if (work.kind === 'new') {
          try { await (path.isAbsolute(work.parent) ? createDirectory(path.resolve(work.parent), work.name) : createDirectory(workspace, folder)); }
          catch (error) { throw Object.assign(new Error('folder'), { reply: refused(error.code === 'EEXIST' ? 409 : 400, error.code === 'EEXIST' ? 'folder-exists' : 'folder-refused') }); }
        }
      } catch (error) {
        await rm(folderOf(id), { recursive: true, force: true });
        if (error.reply) return error.reply;
        throw error;
      }
      return { status: 201, project: await view(value) };
    },
    // name, about, instructions, archived (archive hides without deleting).
    async update(id, body) {
      const value = await record(id);
      if (!value) return refused(404, 'unknown-project');
      if (!only(body, ['name', 'about', 'instructions', 'archived']) || !Object.keys(body).length
          || (body.name !== undefined && (!text(body.name, MAX_NAME) || !body.name.trim())) || (body.about !== undefined && !text(body.about, MAX_ABOUT))
          || (body.instructions !== undefined && !text(body.instructions, MAX_INSTRUCTIONS)) || (body.archived !== undefined && typeof body.archived !== 'boolean'))
        return refused(400, 'request-refused');
      if (body.instructions !== undefined) await replace(path.join(folderOf(id), 'instructions.md'), body.instructions);
      const next = { ...value, ...(body.name !== undefined && { name: body.name.trim() }), ...(body.about !== undefined && { about: body.about }),
        ...(body.archived !== undefined && { archived: body.archived }) };
      await save(next);
      return { status: 200, project: await view(next) };
    },
    // Locate: a linked or new project's work folder is somewhere else now. Only the record changes, and the project's
    // chats that started in the old folder start in the new one; neither folder is touched.
    async relocate(id, body) {
      const value = await record(id);
      if (!value) return refused(404, 'unknown-project');
      if (value.work.kind === 'p9') return refused(409, 'nothing-to-locate');
      if (!only(body, ['folder']) || typeof body.folder !== 'string') return refused(400, 'request-refused');
      try { await folderCheck(body.folder); } catch { return refused(400, 'folder-refused'); }
      const next = { ...value, work: { ...value.work, folder: body.folder } };
      await save(next);
      db.prepare('UPDATE conversations SET folder = ? WHERE project = ? AND folder = ?').run(body.folder, id, value.work.folder);
      return { status: 200, project: await view(next) };
    },
    // Its chats always move to Chats, never deleted with it (N1 spec, 2026-11-08). Only P9's own folder for the
    // project is removed; the work folder, whatever its kind, is left as it is. The body is empty.
    async remove(id, body) {
      const value = await record(id);
      if (!value) return refused(404, 'unknown-project');
      if (!only(body, [])) return refused(400, 'request-refused');
      const moved = [];
      for (const { id: chat } of db.prepare('SELECT id FROM conversations WHERE project = ?').all(id)) {
        await chats.move(chat, { project: null });
        moved.push(chat);
      }
      await rm(folderOf(id), { recursive: true, force: true });
      return { status: 200, deleted: id, moved };
    },
    // Added files: saved in files/ only, never over a name already there.
    async addFile(id, body) {
      const value = await record(id);
      if (!value) return refused(404, 'unknown-project');
      if (!only(body, ['name', 'data']) || !partOk(body.name) || typeof body.data !== 'string' || body.data.length > Math.ceil(MAX_FILE / 3) * 4 + 4
          || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) return refused(400, 'request-refused');
      if ((await files(id)).length >= MAX_FILES) return refused(409, 'too-many-files');
      const folder = filesOf(id);
      if (!(await lstat(folder).catch(() => null))?.isDirectory()) return refused(409, 'files-unavailable');
      try { await addNew(folder, body.name, Buffer.from(body.data, 'base64')); }
      catch (error) { if (error.code === 'EEXIST') return refused(409, 'file-exists'); throw error; }
      return { status: 201, files: await files(id) };
    },
    async removeFile(id, name) {
      const value = await record(id);
      if (!value) return refused(404, 'unknown-project');
      if (!partOk(name)) return refused(400, 'request-refused');
      const target = path.join(filesOf(id), name);
      if (!(await lstat(target).catch(() => null))?.isFile()) return refused(404, 'unknown-file');
      await unlink(target);
      return { status: 200, files: await files(id) };
    },
    // One sprint file, from the project page: the lead chat must be in this project, the name one of the sprint's.
    // hash: the file as the page opened it (list's hash), '' to make one again that was deleted since. The lead and the
    // workers edit these files too: one changed since is not replaced (sprintFiles.write checks it, last right before
    // its rename), and 409 sends the files as they are now; the page keeps the user's text.
    async sprintFile(id, body) {
      const value = await record(id);
      if (!value) return refused(404, 'unknown-project');
      if (!only(body, ['lead', 'name', 'text', 'hash']) || typeof body.lead !== 'string' || !ID.test(body.lead) || typeof body.text !== 'string' || typeof body.hash !== 'string') return refused(400, 'request-refused');
      if (row(body.lead)?.project !== id || !sprintFiles?.exists(body.lead)) return refused(404, 'unknown-sprint');
      const saved = sprintFiles.write(body.lead, body.name, body.text, body.hash);
      if (saved === 'changed') return { status: 409, error: 'sprint-file-changed', files: sprintFiles.list(body.lead) };
      if (!saved) return refused(400, 'request-refused');
      return { status: 200, files: sprintFiles.list(body.lead) };
    },
    record,
    startFolder,
    filesStart,
    ownFiles,
    // What the agent gets (N1 chats): the project's instructions and its added files' paths, as one text block before
    // the message. hash names what was sent; prompt() sends it only when it differs from the chat's last message's.
    // The work folder's AGENTS.md or CLAUDE.md is the agent's to read; nothing here opens it.
    async note(conversation) {
      const value = conversation.project ? await record(conversation.project) : null;
      if (!value) return null;
      const said = (await instructions(value.id)).trim(), added = await files(value.id);
      const body = (said ? '\nProject instructions:\n' + said + '\n' : '')
        + (added.length ? '\nFiles added to this project:\n' + added.map((file) => '- ' + path.join(filesOf(value.id), file.name)).join('\n') + '\n' : '');
      const hash = createHash('sha256').update(value.id + '\n' + body).digest('hex');
      return { hash, text: body ? `[P9: this chat is in the project "${value.name}".\n${body}]\n\n` : null };
    },
  };

  // The chats side: a chat's project, title, archive and delete, and the chats started inside a folder.
  const chat = (id) => typeof id === 'string' && ID.test(id) && row(id);
  const chats = {
    // project: an existing project's id, or null for general chats. The chat keeps its folder; its next message
    // carries the new project's instructions (note).
    async move(id, body) {
      if (!chat(id)) return refused(404, 'unknown-conversation');
      if (!only(body, ['project']) || (body.project !== null && (typeof body.project !== 'string' || !ID.test(body.project)))) return refused(400, 'request-refused');
      if (body.project !== null && !await record(body.project)) return refused(404, 'unknown-project');
      db.prepare('UPDATE conversations SET project = ? WHERE id = ?').run(body.project, id);
      emit(id, 'project', { project: body.project });
      return { status: 200, project: body.project };
    },
    rename(id, body) {
      if (!chat(id)) return refused(404, 'unknown-conversation');
      if (!only(body, ['title']) || !text(body.title, 120) || !body.title.trim()) return refused(400, 'request-refused');
      const title = body.title.replace(/\s+/g, ' ').trim();
      db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, id);
      emit(id, 'renamed', { title });
      return { status: 200, title };
    },
    archive(id, body) {
      if (!chat(id)) return refused(404, 'unknown-conversation');
      if (!only(body, ['archived']) || typeof body.archived !== 'boolean') return refused(400, 'request-refused');
      db.prepare('UPDATE conversations SET archived = ? WHERE id = ?').run(body.archived ? 1 : 0, id);
      emit(id, 'archived', { archived: body.archived });
      return { status: 200, archived: body.archived };
    },
    // The chat stops first; then its row and events go, with any sent photo no other chat names (photos are
    // content-addressed, so one may be in several chats). One 'deleted' event tells every window, and the watcher and
    // memory, which drop the chat's rows (O35); it carries what the chat had spent, which stays in the usage totals.
    // O29 (threat model row O29): empty: true is the Agent pill's switch, which deletes only a chat never sent to: no user or
    // held event and no turn under way (its user event is written after the turn starts). Checked before the stop and again
    // with nothing awaited before its rows go, so a message that lands meanwhile keeps the chat. Without it, as before.
    async delete(id, body = {}) {
      await recovered;
      if (!only(body, ['empty']) || (body.empty !== undefined && body.empty !== true)) return refused(400, 'request-refused');
      const conversation = chat(id);
      if (!conversation) return refused(404, 'unknown-conversation');
      if (['moving', 'moved'].includes(conversation.state)) return refused(409, conversation.state);
      const used = () => row(id)?.state === 'turn' || !!db.prepare("SELECT 1 FROM events WHERE conversation = ? AND type IN ('user', 'held') LIMIT 1").get(id);
      if (body.empty && (conversation.parent || used())) return refused(409, 'not-empty');
      const result = await stop(id);
      if (result !== 'stopped') return refused(500, 'chat-not-stopped');
      if (body.empty && used()) return refused(409, 'not-empty');
      emit(id, 'deleted', { usage: remove(id) });
      return { status: 200, deleted: id };
    },
    // The offer to add chats already started in a linked folder: the chats whose folder is it or inside it, any project.
    startedIn(folder) {
      if (typeof folder !== 'string' || folder.length > 4096) return refused(400, 'request-refused');
      const target = path.resolve(workspace, folder);
      const inside = (value) => { const relative = path.relative(target, path.resolve(workspace, value ?? '')); return !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)); };
      return { status: 200, conversations: db.prepare('SELECT id, provider, title, folder, project, created FROM conversations ORDER BY created DESC').all().filter((c) => c.folder !== IN_P9 && inside(c.folder)) };
    },
  };
  return { ...store, chats };
}
