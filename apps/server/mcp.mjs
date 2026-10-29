// The P9 MCP server (issue #11 enhancement 7): Mission Control's schemas, files and buttons for the agent of one P9 chat.
// The adapter starts mcp-relay.mjs (chat.mjs hands it over in ACP's mcpServers), which carries each stdio line to
// POST /mcp with that chat's token; the token says which chat is calling. Writes go through the same guarded save,
// parsers and File protection as the desktop; the agent lock turns every write off; running a script or answering a
// needs-you item asks the user in the chat first.
// ponytail: MCP by hand (JSON-RPC, tools and resources only, no SDK in the daemon); the SDK if P9 needs more of the protocol.
import { readFile as readText, open, mkdir, lstat, chmod, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { readFile, guardedSave, createFile } from '../../packages/files/index.mjs';
import { parseSettings, parseRegistry, parseSpace, combine, argvFor, argRefusal, stripBom, rootRefused, withIds, spaceAt, draftAt } from './mission.mjs';
import { problem, jsonSchema, describeMission, sectionId, SCHEMAS, RECORD, PAGE, SECTION, SPACE_FILE, ID, SPACES_DIR, SPACE_NAME_RULE, TEMPLATES } from './mission-fields.mjs';
import { childEnv } from './child-env.mjs';
import { card, KINDS, MAX_TEXT, CARD_ID } from './artifacts.mjs';
import pkg from '../../package.json' with { type: 'json' };

const run = promisify(execFile);
const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
// Under Codex's 60 s MCP tool timeout: a longer run is followed with status.
const WAIT_MS = 45_000;
const HASH = /^[a-f0-9]{64}$/;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rpcError = (code, message) => Object.assign(new Error(message), { rpc: { code, message } });
const string = (value, max = 4000) => typeof value === 'string' && value.length <= max;
const object = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const INSTRUCTIONS = 'P9 Mission Control, for this chat. Call describe_mission before building the space (it also reads as p9://schema/space; the registry\'s is p9://schema/registry), '
  + 'and dry-run a whole file with validate_registry or validate_space. Every write tool says what changed and returns the file\'s new '
  + 'hash; pass it back as hash so a file changed meanwhile is reported instead of overwritten. Writes are refused while the agent lock '
  + 'is on, and the registry and space are read-only while File protection is on. run_script, answer_needs_you and allow_folder ask the user in this '
  + 'chat first. request_restart only asks the user; nothing restarts. To show the user an artifact beside the chat, put it in a fenced '
  + 'block whose info string is "<type> artifact [panel|pinned|full] [title]" (type: html, svg, mermaid, jsx, markdown, or any code '
  + 'language); it runs sandboxed with no network, React may import only react and react-dom, and the user\'s comments come back as one message.';

const hashField = { type: 'string', description: 'The file\'s hash from a resource read or the last write. A file changed since is reported as hash-conflict, not overwritten.' };
const sectionField = { type: 'string', description: 'A space section title. Without it the button goes to (or comes from) the registry\'s scripts.' };
const iconField = { type: 'string', description: RECORD.icon.doc + ' An empty string removes it.' };
const cardIdField = { type: 'string', description: 'Your name for the card, like status or todo: 1 to 64 of A-Z a-z 0-9 . _ -' };
const input = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
// The section items an agent sets as a whole list: every SECTION list of records with an example except buttons, which
// have their own tools. A new item type with fields and an example (M2, M3) joins this tool with nothing else to change.
// Scratch spaces (threat model row 71): these tools write a named draft instead of the live space when given space.
const spaceField = { type: 'string', description: 'Optional. Write this scratch space instead of the space Mission shows (' + SPACE_NAME_RULE
  + '), made on the first write. The user picks it in Mission\'s space picker; the live space is untouched.' };
const SPACE_TOOLS = new Set(['add_button', 'add_section', 'update_button', 'update_section', 'remove_button', 'remove_section', 'set_section_items']);
const ITEM_KINDS = Object.keys(SECTION).filter((key) => SECTION[key].fields && SECTION[key].example !== undefined && key !== 'buttons');
const TOOLS = [
  ['describe_mission', 'How to build the Mission space: its format, an example of every item type, and the templates. Reads nothing of yours.', input({})],
  ['validate_registry', 'Dry-run a registry file with Mission Control\'s own parser (the current space included, for IDs shared between them). Nothing is written.',
    input({ text: { type: 'string', description: 'The whole registry JSON. Default: the file on disk.' } })],
  ['validate_space', 'Dry-run a space file with Mission Control\'s own parser (the current registry included). Nothing is written.',
    input({ text: { type: 'string', description: 'The whole space JSON. Default: the file on disk.' } })],
  ['add_button', 'Add a script button to the registry, or to a space section. Refused if Mission Control would drop it.',
    input({ record: jsonSchema(RECORD, {}, true), section: sectionField, space: spaceField, hash: hashField }, ['record'])],
  ['add_app', 'Add an app to the registry.', input({ record: jsonSchema(RECORD, {}, true), hash: hashField }, ['record'])],
  ['add_page', 'Add a link to the registry.', input({ record: jsonSchema(PAGE, {}, true), hash: hashField }, ['record'])],
  ['add_section', 'Add an empty section to the space.', input({ title: { type: 'string' }, text: { type: 'string' }, space: spaceField, hash: hashField }, ['title'])],
  ['update_button', 'Change a script button\'s title or icon in the registry, or in a space section. icon "" removes the icon.',
    input({ id: { type: 'string' }, section: sectionField, title: { type: 'string' }, icon: iconField, space: spaceField, hash: hashField }, ['id'])],
  ['update_app', 'Change an app\'s title or icon. icon "" removes the icon.', input({ id: { type: 'string' }, title: { type: 'string' }, icon: iconField, hash: hashField }, ['id'])],
  ['update_page', 'Change a link\'s title or icon. icon "" removes the icon.', input({ id: { type: 'string' }, title: { type: 'string' }, icon: iconField, hash: hashField }, ['id'])],
  ['update_section', 'Rename a space section (new_title) or change its icon. icon "" removes the icon.',
    input({ title: { type: 'string', description: 'The section\'s current title.' }, new_title: { type: 'string' }, icon: iconField, space: spaceField, hash: hashField }, ['title'])],
  ['remove_button', 'Remove a script button by ID from the registry, or from a space section.', input({ id: { type: 'string' }, section: sectionField, space: spaceField, hash: hashField }, ['id'])],
  ['remove_app', 'Remove an app by ID.', input({ id: { type: 'string' }, hash: hashField }, ['id'])],
  ['remove_page', 'Remove a link by ID.', input({ id: { type: 'string' }, hash: hashField }, ['id'])],
  ['remove_section', 'Remove a space section, its buttons and log views, by title.', input({ title: { type: 'string' }, space: spaceField, hash: hashField }, ['title'])],
  ['allow_folder', 'Ask the user, in this chat, to let Mission Control list a folder outside the workspace, read-only. On yes it is added to settings.notes_roots '
    + 'as name: use name as a space folders item\'s root, or as a section\'s notes. A folder holding the workspace, the home folder or P9\'s own files is refused.',
    input({ name: { type: 'string', description: 'The root\'s name: 1 to 64 of a-z 0-9 -, starting with a letter or digit, not already in settings.notes_roots.' },
      folder: { type: 'string', description: 'The folder, as an absolute path.' } }, ['name', 'folder'])],
  ['set_section_items', 'Replace one kind of item in a space section with this list ([] removes them): ' + ITEM_KINDS.join(', ')
    + '. describe_mission gives each kind\'s fields and an example. A data tile runs only after the user answers Allow on it in Mission.',
    input({ title: { type: 'string', description: 'The section\'s title.' }, kind: { type: 'string', enum: ITEM_KINDS },
      items: { type: 'array', items: { type: 'object' } }, space: spaceField, hash: hashField }, ['title', 'kind', 'items'])],
  ['run_script', 'Run a Mission Control script or space button by ID, after the user allows it in this chat. Waits up to 45 s; follow a longer run with status.',
    input({ id: { type: 'string' }, args: { type: 'array', items: { type: 'string' }, maxItems: 4, description: 'The values for the script\'s args, in order.' } }, ['id'])],
  ['list_needs_you', 'The needs-you items waiting for the user, with each one\'s hash and whether it has an empty answer line.', input({})],
  ['answer_needs_you', 'Write an answer on a needs-you item\'s empty "A." line, after the user allows it in this chat.',
    input({ name: { type: 'string', description: 'The item\'s file name, like project.md.' }, hash: { type: 'string', description: 'From list_needs_you.' },
      answer: { type: 'string', description: 'One line, at most 4000 characters.' } }, ['name', 'hash', 'answer'])],
  ['status', 'P9\'s state (agent lock, File protection, settings, what Mission Control holds), or with run, a script run\'s output.',
    input({ run: { type: 'string', description: 'A run ID from run_script.' }, from: { type: 'integer', minimum: 0, description: 'Output offset: the last call\'s next.' } })],
  ['request_restart', 'Ask the user to restart P9 (after a settings change, say). Shows your reason in the chat; only the user restarts P9.',
    input({ reason: { type: 'string', maxLength: 500 } }, ['reason'])],
  ['pin_card', 'Pin a card above the composer of this chat, for the user to keep in view: Markdown, a checklist (- [ ] and - [x] items) or a table (GitHub '
    + 'Markdown). The same id replaces that card in place. Text only, at most 8 KB; HTML shows as text, a link as its text, an image as its alt text.',
    input({ id: cardIdField, kind: { type: 'string', enum: KINDS }, text: { type: 'string', description: 'Markdown, at most ' + MAX_TEXT + ' bytes of UTF-8.' } }, ['id', 'kind', 'text'])],
  ['unpin_card', 'Remove a card pinned in this chat.', input({ id: cardIdField }, ['id'])],
].map(([name, description, inputSchema]) => ({ name, description, inputSchema }));

const RESOURCES = [
  ['p9://schema/settings', 'settings.json schema', 'application/schema+json'],
  ['p9://schema/registry', 'Registry schema', 'application/schema+json'],
  ['p9://schema/space', 'Space schema', 'application/schema+json'],
  ['p9://settings', 'The current settings.json and what is wrong with it', 'application/json'],
  ['p9://registry', 'The current registry, its hash and every entry Mission Control drops, with the reason', 'application/json'],
  ['p9://space', 'The current space, its hash and every entry Mission Control drops, with the reason', 'application/json'],
  ['p9://status', 'P9\'s state: agent lock, File protection, settings, counts', 'application/json'],
  ['p9://daemon-log', 'The last 100 lines of the P9 daemon\'s log', 'text/plain'],
].map(([uri, name, mimeType]) => ({ uri, name, mimeType }));

const empty = () => ({ sections: [], invalid: [] });
const unparsable = (error) => ({ error: error instanceof SyntaxError ? 'invalid-json' : error.message, detail: String(error.message).slice(0, 300) });

// The space file's state in words (technical writing: what is wrong, then what to do). subject: "The space file <path>" or "The text".
const spaceWords = (subject, error) => (error === 'empty'
  ? { error: 'empty-space-file', detail: subject + ' is empty. A space is a JSON object such as {"sections": []}; describe_mission shows the format.' }
  : error instanceof SyntaxError ? { error: 'invalid-json', detail: subject + ' is not valid JSON (' + String(error.message).slice(0, 200) + '). validate_space checks a whole text before you write it.' }
    : { error: 'invalid-space', detail: subject + ' is JSON but not a space: it must be an object with a "sections" list, such as {"sections": []}.' });

// useSpace(file): records file as settings.space (server.mjs, through the settings save queue).
export function createMcp({ workspace, recovery, state, settingsFile, settings: current, mission: currentMission, chat, readOnly, protection, useSpace, changeSettings }) {
  const inflight = new Map(); // conversation + request ID -> AbortController, for notifications/cancelled

  const need = () => { const settings = current(); if (!settings) throw new Error('settings-missing'); return settings; };
  // The scratch space a tool call or the desktop form writes (threat model row 71); undefined: the main space.
  const drafts = settingsFile ? path.join(path.dirname(settingsFile), SPACES_DIR) : null;
  const drafting = new AsyncLocalStorage();
  const badName = () => ({ error: 'request-refused', detail: 'space: ' + SPACE_NAME_RULE + '.' });
  // Mission Control's own merge: a space that will not parse drops only the space (mission.mjs registry()), unless it is the file being checked.
  function merged(registryText, spaceText, strictSpace = false) {
    let space = empty();
    if (spaceText !== undefined) {
      try { space = parseSpace(spaceText); } catch (error) { if (strictSpace) throw error; space.invalid.push({ kind: 'space', reason: 'unreadable-space' }); }
    }
    return combine(parseRegistry(registryText, current()?.page_schemes), space);
  }
  async function files(settings = need(), draft) {
    const registry = await readFile(workspace, settings.registry), file = draft !== undefined ? draftAt(drafts, draft) : settings.space;
    const space = file ? await readFile(...spaceAt(workspace, file)).catch(() => null) : null;
    return { registry, space };
  }
  const counts = (all) => ({ scripts: all.scripts.length, apps: all.apps.length, pages: all.pages.length, sections: all.space.length, invalid: all.invalid.length });

  async function status() {
    let settings = 'missing';
    try { if (settingsFile) { parseSettings(await readText(settingsFile, 'utf8')); settings = 'ok'; } }
    catch (error) { if (error.code !== 'ENOENT') settings = 'invalid'; }
    const result = { version: pkg.version, agentLock: chat.lock().on, fileProtection: protection(), settings, missionControl: current() ? 'on' : 'off',
      ...(current() ? { space: current().space ?? 'no space file yet: the first add_section creates one' } : {}) };
    if (current()) {
      try { const { registry, space } = await files(); result.mission = counts(merged(registry.content, space?.content)); }
      catch (error) { result.mission = unparsable(error); }
    }
    return result;
  }

  // Where P9 makes the space when settings names none: beside settings.json (threat model row 69).
  const defaultSpace = () => (settingsFile ? path.join(path.dirname(settingsFile), SPACE_FILE) : null);
  const noSpace = () => ({ error: 'no-space-file', detail: 'There is no space file yet. ' + (defaultSpace() && useSpace
    ? 'The first add_section creates ' + defaultSpace() + ' and names it in settings.' : 'Settings name none, and this P9 has no settings file to record one in.') });
  const missingSpace = (file) => ({ error: 'space-file-missing', file, detail: 'Settings name the space file ' + file + ', but P9 cannot read it there (moved or deleted?). '
    + 'The user can point Settings > Mission Control files at it again.' });

  async function validate(kind, text) {
    if (text !== undefined && !string(text, 6 * 1024 * 1024)) return { error: 'request-refused' };
    const settings = need(), { registry, space } = await files(settings);
    if (kind === 'space') {
      if (text === undefined && !settings.space) return { ok: false, ...noSpace() };
      if (text === undefined && !space) return { ok: false, ...missingSpace(settings.space) };
      const subject = text === undefined ? 'The space file ' + settings.space : 'The text';
      if (!(text ?? space.content).trim()) return { ok: false, ...spaceWords(subject, 'empty') };
      try { parseSpace(text ?? space.content); } catch (error) { return { ok: false, ...spaceWords(subject, error) }; }
    }
    try {
      const all = kind === 'registry' ? merged(text ?? registry.content, space?.content) : merged(registry.content, text ?? space?.content ?? '', true);
      return { ok: !all.invalid.length, accepted: counts(all), invalid: all.invalid };
    } catch (error) { return { ok: false, ...unparsable(error) }; }
  }

  // One edit of the registry or the space: change(data) edits the parsed file and says what it did; the new file must
  // still parse, and accepted(all) says whether Mission Control keeps what was added. Then the guarded save.
  // by.user: the desktop's edit form. The agent lock is about agents, so it does not stop the user; File protection still
  // does, unless the form got the user's confirmation first (by.confirm).
  async function edit(which, hash, change, by = {}) {
    if (chat.lock().on && !by.user) return { error: 'agent-lock-on', detail: 'The agent lock is on: the user turns it off on the desktop.' };
    if (hash !== undefined && !(typeof hash === 'string' && HASH.test(hash))) return { error: 'request-refused', detail: 'hash: 64 hex characters' };
    // A tool's space argument, else (the desktop form only) the scratch space Mission shows.
    const draft = drafting.getStore() ?? (by.user ? current()?.space_name : undefined);
    let settings = need(), file = which === 'registry' ? settings.registry : draft !== undefined ? draftAt(drafts, draft) : settings.space;
    if (draft !== undefined && which === 'registry') return { error: 'request-refused', detail: 'A scratch space holds sections only. Buttons outside a section, apps and pages go to the registry: leave space out.' };
    if (draft !== undefined) {
      // A draft is written under the same rules as the live space: the lock (above), then File protection on every write.
      if (!file) return badName();
      if (protection() && !(by.user && by.confirm)) return { error: 'registry-read-only', detail: 'File protection is on: P9 writes no space file then, scratch spaces included. The user turns it off on the desktop.' };
      const made = await makeDraft(file);
      if (made.error) return made;
    } else if (which === 'space' && !file) {
      // No space yet: the first write makes one (threat model row 69), under the same File protection rule as every space write.
      if (!defaultSpace() || !useSpace) return noSpace();
      if (protection() && !(by.user && by.confirm)) return { error: 'registry-read-only', detail: 'File protection is on: P9 makes and writes no space file then. The user turns it off on the desktop.' };
      const made = await makeSpace(defaultSpace());
      if (made.error) return made;
      await useSpace(defaultSpace());
      settings = need(); file = settings.space;
      if (file !== defaultSpace()) return { error: 'save-failed', detail: 'P9 made ' + defaultSpace() + ' but could not name it in settings.' };
    }
    if (readOnly(file) && !(by.user && by.confirm)) return { error: 'registry-read-only', detail: 'File protection is on: P9 never writes ' + file + ' then. The user turns it off on the desktop.' };
    const both = await files(settings, draft), disk = which === 'registry' ? both.registry : both.space;
    if (!disk) return which === 'space' ? missingSpace(file) : { error: 'file-missing', file };
    if (hash !== undefined && hash !== disk.hash) return { error: 'hash-conflict', file, diskHash: disk.hash };
    if (which === 'space' && !disk.content.trim()) return { file, ...spaceWords('The space file ' + file, 'empty') };
    let data;
    try { data = JSON.parse(stripBom(disk.content)); } catch (error) { return { file, ...(which === 'space' ? spaceWords('The space file ' + file, error) : unparsable(error)) }; }
    if (!object(data)) return which === 'space' ? { file, ...spaceWords('The space file ' + file) } : { error: 'invalid-' + which, file };
    // An older space gets its sections' ids saved now (the same ids parseSpace gives them on every load), its old text kept first.
    const before = which === 'space' && Array.isArray(data.sections) && data.sections.some((entry) => object(entry) && entry.id === undefined) ? disk.content : undefined;
    if (before !== undefined) data.sections = withIds(data.sections);
    const done = change(data);
    if (done.error) return done;
    // ponytail: the file is written back as 2-space JSON, so hand formatting is lost; a text-level splice if that matters.
    const text = JSON.stringify(data, null, 2) + '\n';
    let all;
    try { all = which === 'registry' ? merged(text, both.space?.content) : merged(both.registry.content, text, true); }
    catch (error) { return { file, ...unparsable(error) }; }
    if (done.accepted && !done.accepted(all)) return { error: 'not-accepted', detail: 'Mission Control would drop it.', file, invalid: all.invalid };
    if (before !== undefined && !await keep(file, before)) return { error: 'save-failed', file, detail: 'P9 could not keep a copy of the space before adding section ids, so nothing was written.' };
    const saved = await guardedSave(...(which === 'space' ? spaceAt(workspace, file) : [workspace, file]), disk.hash, text, recovery);
    if (saved.kind === 'conflict') return { error: saved.reason, file, ...(saved.diskHash ? { diskHash: saved.diskHash } : {}) };
    if (saved.kind !== 'saved') return { error: 'save-failed', file, code: saved.code };
    return { file, ...done.changed, hash: saved.hash };
  }
  // The new space file: owner-only, never through a link or over another file; a plain file already there is used as is.
  async function makeSpace(file) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    let handle;
    try { handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') return { error: 'save-failed', file, code: error.code };
      return (await lstat(file)).isFile() ? {} : { error: 'request-refused', file, detail: file + ' is there but is not a plain file, so P9 will not write it.' };
    }
    try { await handle.writeFile('{\n  "sections": []\n}\n'); await handle.sync(); } finally { await handle.close(); }
    return {};
  }
  // A new draft: the drafts folder is P9's own (0700) and never a link, then the same O_EXCL, O_NOFOLLOW file as the space.
  async function makeDraft(file) {
    try {
      await mkdir(drafts, { recursive: true, mode: 0o700 });
      const folder = await lstat(drafts);
      if (folder.isSymbolicLink() || !folder.isDirectory()) return { error: 'request-refused', file: drafts, detail: drafts + ' is not a plain folder, so P9 will not write scratch spaces there.' };
    } catch (error) { return { error: 'save-failed', file: drafts, code: error.code }; }
    return makeSpace(file);
  }
  // A template into the space Mission shows, or into a named scratch space (threat model row 72): only when that space is missing or has no
  // sections, so nothing the user built is replaced. The user's click on the card is the write; File protection still asks.
  function install(name, space, confirm) {
    const template = TEMPLATES.find((entry) => entry.name === name);
    if (!template) return { error: 'unknown-template' };
    if (space !== undefined && !draftAt(drafts, space)) return badName();
    return drafting.run(space, () => edit('space', undefined, (data) => {
      if (!Array.isArray(data.sections)) return { error: 'invalid-space' };
      if (data.sections.length) return { error: 'space-not-empty', detail: 'The space has sections already, so P9 adds no template to it.' };
      data.sections = structuredClone(template.space.sections);
      return { changed: { action: 'installed', template: name, ...(space !== undefined ? { space } : {}) } };
    }, { user: true, confirm: confirm === true }));
  }
  // A copy of the space's old text beside it, owner-only, under a new name (never over a file).
  async function keep(file, text) {
    const [root, name] = spaceAt(workspace, file), copy = name + '.' + Date.now() + '.bak';
    try {
      if ((await createFile(root, copy, text)).kind !== 'created') return false;
      // ponytail: created 644 by createFile then narrowed; a planted link in that instant needs write access to the folder already.
      await chmod(path.join(root, copy), 0o600);
      return true;
    } catch { return false; }
  }
  // The list at data[key], made if absent; null when the file holds something else there.
  const list = (data, key) => { if (data[key] === undefined) data[key] = []; return Array.isArray(data[key]) ? data[key] : null; };
  function section(data, title) {
    const sections = list(data, 'sections');
    if (!sections) return { error: 'invalid-space' };
    const found = sections.filter((entry) => typeof entry?.title === 'string' && entry.title.trim() === title.trim());
    return found.length === 1 ? { entry: found[0], sections } : { error: found.length ? 'ambiguous-section' : 'unknown-section', section: title };
  }
  function add(kind, record, sectionTitle, hash) {
    const wrong = problem(record, kind === 'pages' ? PAGE : RECORD, true);
    if (wrong) return { error: 'invalid-record', detail: wrong };
    if (sectionTitle !== undefined && !string(sectionTitle, 200)) return { error: 'request-refused' };
    return edit(sectionTitle === undefined ? 'registry' : 'space', hash, (data) => {
      let target;
      if (sectionTitle === undefined) target = list(data, kind);
      else { const found = section(data, sectionTitle); if (found.error) return found; target = list(found.entry, 'buttons'); }
      if (!target) return { error: 'not-a-list', detail: (sectionTitle === undefined ? kind : 'buttons') + ' is not a list' };
      target.push(record);
      return { changed: { action: 'added', kind, ...(sectionTitle !== undefined ? { section: sectionTitle } : {}), record },
        accepted: (all) => all[kind].some((entry) => entry.id === record.id && entry.title === record.title) };
    });
  }
  function remove(kind, id, sectionTitle, hash) {
    if (!string(id, 200) || (sectionTitle !== undefined && !string(sectionTitle, 200))) return { error: 'request-refused' };
    return edit(sectionTitle === undefined ? 'registry' : 'space', hash, (data) => {
      let target;
      if (sectionTitle === undefined) target = list(data, kind);
      else { const found = section(data, sectionTitle); if (found.error) return found; target = list(found.entry, 'buttons'); }
      const removed = target?.filter((entry) => entry?.id === id) ?? [];
      if (!removed.length) return { error: 'unknown-id', id };
      target.splice(0, target.length, ...target.filter((entry) => entry?.id !== id));
      return { changed: { action: 'removed', kind, ...(sectionTitle !== undefined ? { section: sectionTitle } : {}), records: removed } };
    });
  }

  // Title and icon of one record (kind scripts|apps|pages) or one space section (kind sections, key = its title). icon '' removes it.
  const FIELDS = { scripts: RECORD, apps: RECORD, pages: PAGE, sections: SECTION };
  // picture (the name of a stored file, '' removes it) is the desktop form's alone: an agent's tool call is refused if it names one.
  function update(kind, { key, section: sectionTitle, title, icon, picture, hash }, by) {
    if (!string(key, 200) || ![sectionTitle, title, icon, picture].every((value) => value === undefined || string(value, 200)) || (picture !== undefined && !by?.user)) return { error: 'request-refused' };
    if (title === undefined && icon === undefined && picture === undefined) return { error: 'nothing-to-change', detail: 'Give a title, an icon, or both.' };
    if (kind !== 'scripts' && sectionTitle !== undefined) return { error: 'request-refused' };
    return edit(kind === 'sections' || sectionTitle !== undefined ? 'space' : 'registry', hash, (data) => {
      let entry, rest;
      if (kind === 'sections') { const found = section(data, key); if (found.error) return found; entry = found.entry; rest = found.sections.filter((other) => other !== entry); }
      else {
        let target;
        if (sectionTitle === undefined) target = list(data, kind);
        else { const found = section(data, sectionTitle); if (found.error) return found; target = list(found.entry, 'buttons'); }
        const hits = target?.filter((item) => item?.id === key) ?? [];
        if (hits.length !== 1) return { error: hits.length ? 'duplicate-id' : 'unknown-id', id: key };
        entry = hits[0];
      }
      const before = { ...entry };
      if (title !== undefined) entry.title = title;
      if (icon === '') delete entry.icon; else if (icon !== undefined) entry.icon = icon;
      if (picture === '') delete entry.picture; else if (picture !== undefined) entry.picture = picture;
      const wrong = problem(entry, FIELDS[kind], false, current()?.page_schemes);
      if (wrong) return { error: 'invalid-record', detail: wrong };
      if (kind === 'sections' && rest.some((other) => typeof other?.title === 'string' && other.title.trim() === entry.title.trim())) return { error: 'duplicate-section', section: entry.title };
      return { changed: { action: 'updated', kind, [kind === 'sections' ? 'section' : 'id']: key, record: entry, was: before },
        accepted: (all) => (kind === 'sections' ? all.space.some((item) => item.title === entry.title.trim()) : all[kind].some((item) => item.id === key)) };
    }, by);
  }

  // A named choices list ("plans") is filled by Mission itself, so argRefusal checks the same values a run does.
  const lookup = async (id) => {
    const { registry, space } = await files(), item = merged(registry.content, space?.content).scripts.find((entry) => entry.id === id);
    return item && (await currentMission().named([item]))[0];
  };
  async function runScript(conversation, { id, args }, signal) {
    if (chat.lock().on) return { error: 'agent-lock-on' };
    if (!string(id, 64) || (args !== undefined && !Array.isArray(args))) return { error: 'request-refused' };
    const settings = need(), item = await lookup(id);
    if (!item) return { error: 'unknown-id', id };
    // Mission's own argument rules, before the user is asked: a refused argument never reaches the approval prompt.
    if ((args ?? []).length > (item.args?.length ?? 0)) return { error: 'request-refused', reason: 'too many arguments' };
    const refused = (args ?? []).map((arg, index) => argRefusal(item, arg, index)).find(Boolean);
    if (refused) return { error: 'request-refused', reason: refused };
    const argv = (entry) => argvFor(entry, args ?? [], settings.scripts_root ?? workspace);
    const shown = argv(item).map((part) => JSON.stringify(part)).join(' ');
    // The user approves exactly what this shows, so it is never cut: a command too long to read is refused instead.
    const title = 'P9 Mission Control: run ' + id + ' (' + item.title + '): ' + shown;
    if (title.length > 5000) return { error: 'request-refused', reason: 'the command is too long to show the user in full; run it from Mission Control' };
    if (!await chat.approve(conversation, { toolCallId: 'p9-mcp-' + randomUUID(), title, kind: 'execute' }, signal)) return { error: 'not-allowed', detail: 'The user did not allow it.' };
    // The command the user allowed, not one the file holds now.
    const again = await lookup(id);
    if (!again || JSON.stringify(argv(again)) !== JSON.stringify(argv(item))) return { error: 'changed-since-allowed', detail: 'The button changed after the user allowed it; nothing ran.' };
    const { status: code, ...started } = await currentMission().run(id, { ...(args ? { args } : {}), confirm: true });
    if (!started.run) return started;
    const until = Date.now() + WAIT_MS;
    let output;
    while (!(output = currentMission().output(started.run, 0)).done && Date.now() < until && !signal.aborted) await wait(250);
    const { status: ignored, ...result } = output;
    return { run: started.run, ...result, output: result.output.slice(-20000), ...(result.done ? {} : { detail: 'Still running: call status with run and from = next.' }) };
  }
  // A folder outside the workspace (threat model row M2-b): only after the user's yes in this chat, and the folder the
  // user saw is the one written, through the Settings route's writer. A file changed during the ask is not overwritten.
  async function allowFolder(conversation, { name, folder }, signal) {
    if (chat.lock().on) return { error: 'agent-lock-on' };
    if (!string(name, 64) || !ID.test(name) || !string(folder, 4096) || folder.includes('\0') || !path.isAbsolute(folder)) {
      return { error: 'request-refused', reason: 'name: 1 to 64 of a-z 0-9 -; folder: an absolute path' };
    }
    if (!settingsFile || !changeSettings) return { error: 'settings-missing' };
    const real = await realpath(folder).catch(() => null);
    if (!real) return { error: 'folder-not-found', folder };
    if (await rootRefused(real, { workspace, recovery, also: state ? [state] : [] })) return { error: 'root-refused', detail: 'It holds the workspace, the home folder or P9\'s own files.' };
    let before, roots;
    try { before = await readText(settingsFile, 'utf8'); roots = parseSettings(before).notes_roots ?? {}; }
    catch (error) { return { ...unparsable(error), error: 'settings-invalid' }; }
    if (Object.hasOwn(roots, name)) return { error: 'name-taken', name, folder: roots[name] };
    if (Object.keys(roots).length >= 16) return { error: 'request-refused', reason: 'settings.notes_roots already has 16 folders' };
    const title = 'P9 Mission Control: let Mission list the folder ' + real + ' (read-only), named ' + name;
    if (title.length > 5000) return { error: 'request-refused', reason: 'the folder is too long to show the user in full' };
    if (!await chat.approve(conversation, { toolCallId: 'p9-mcp-' + randomUUID(), title, kind: 'edit' }, signal)) return { error: 'not-allowed', detail: 'The user did not allow it.' };
    if (await realpath(folder).catch(() => null) !== real) return { error: 'changed-since-allowed', detail: 'The folder changed after the user allowed it; nothing was added.' };
    const saved = await changeSettings((disk, text) => text !== before ? { error: 'hash-conflict', detail: 'settings.json changed while the user was asked; nothing was added.' }
      : { ...disk, notes_roots: { ...disk.notes_roots, [name]: real } });
    if (saved.error) return saved;
    return { name, folder: real, detail: 'Added to settings.notes_roots. Name it as root in a space folders item.' };
  }
  async function answerItem(conversation, { name, hash, answer }, signal) {
    if (chat.lock().on) return { error: 'agent-lock-on' };
    if (!string(name, 120) || !string(hash, 64) || !string(answer)) return { error: 'request-refused' };
    need();
    const title = 'P9 Mission Control: answer the needs-you item ' + name + ' with ' + JSON.stringify(answer); // never cut: the answer is at most 4,000 characters
    if (!await chat.approve(conversation, { toolCallId: 'p9-mcp-' + randomUUID(), title, kind: 'edit' }, signal)) return { error: 'not-allowed', detail: 'The user did not allow it.' };
    const { status: code, diskContent, content, conflict, ...result } = await currentMission().answer({ name, hash, answer });
    return result.kind === 'saved' ? { action: 'answered', name, hash: result.hash } : result.kind === 'conflict' ? { error: result.reason, name, diskHash: result.diskHash }
      : result.error ? result : { error: result.reason ?? 'save-failed', code: result.code };
  }

  const calls = {
    describe_mission: () => describeMission(),
    validate_registry: (args) => validate('registry', args.text),
    validate_space: (args) => validate('space', args.text),
    add_button: (args) => add('scripts', args.record, args.section, args.hash),
    add_app: (args) => add('apps', args.record, undefined, args.hash),
    add_page: (args) => add('pages', args.record, undefined, args.hash),
    add_section: ({ title, text, hash }) => {
      const record = { title, ...(text !== undefined ? { text } : {}) };
      const wrong = problem(record, SECTION);
      if (wrong || !string(title, 200)) return { error: 'invalid-section', detail: wrong ?? 'title: at most 200 characters' };
      return edit('space', hash, (data) => {
        const found = section(data, title);
        if (found.error === 'invalid-space') return found;
        if (!found.error || found.error === 'ambiguous-section') return { error: 'duplicate-section', section: title };
        const sections = list(data, 'sections');
        // ids are unique among sections (M1); every section has one by now (edit() added any missing).
        const entry = { id: sectionId(record.title.trim(), new Set(sections.map((other) => other?.id))), ...record };
        sections.push(entry);
        return { changed: { action: 'added', kind: 'section', record: entry }, accepted: (all) => all.space.some((entry) => entry.title === title.trim()) };
      });
    },
    set_section_items: ({ title, kind, items, hash }) => {
      if (!string(title, 200) || !ITEM_KINDS.includes(kind) || !Array.isArray(items) || items.length > 64) {
        return { error: 'request-refused', reason: 'title: a section title; kind: one of ' + ITEM_KINDS.join(', ') + '; items: a list of at most 64' };
      }
      // Each item is checked before anything is written, so a javascript: link or an unknown field is named, not dropped.
      for (const [index, item] of items.entries()) {
        const wrong = problem(item, SECTION[kind].fields, true);
        if (wrong) return { error: 'invalid-item', kind, index, detail: wrong };
      }
      return edit('space', hash, (data) => {
        const found = section(data, title);
        if (found.error) return found;
        if (items.length) found.entry[kind] = items; else delete found.entry[kind];
        return { changed: { action: 'updated', kind, section: found.entry.title, items },
          accepted: (all) => (all.space.find((entry) => entry.title === found.entry.title.trim())?.[kind]?.length ?? 0) === items.length };
      });
    },
    update_button: ({ id, section, ...rest }) => update('scripts', { key: id, section, ...rest }),
    update_app: ({ id, ...rest }) => update('apps', { key: id, ...rest }),
    update_page: ({ id, ...rest }) => update('pages', { key: id, ...rest }),
    update_section: ({ title, new_title: newTitle, ...rest }) => update('sections', { key: title, title: newTitle, ...rest }),
    remove_button: (args) => remove('scripts', args.id, args.section, args.hash),
    remove_app: (args) => remove('apps', args.id, undefined, args.hash),
    remove_page: (args) => remove('pages', args.id, undefined, args.hash),
    remove_section: ({ title, hash }) => {
      if (!string(title, 200)) return { error: 'request-refused' };
      return edit('space', hash, (data) => {
        const found = section(data, title);
        if (found.error) return found;
        found.sections.splice(found.sections.indexOf(found.entry), 1);
        return { changed: { action: 'removed', kind: 'section', record: found.entry } };
      });
    },
    run_script: (args, conversation, signal) => runScript(conversation, args, signal),
    allow_folder: (args, conversation, signal) => allowFolder(conversation, args, signal),
    list_needs_you: async () => { need(); return { items: (await currentMission().overview()).queue.map(({ name, title, age, hash, answerable, content }) => ({ name, title, age, hash, answerable, content })) }; },
    answer_needs_you: (args, conversation, signal) => answerItem(conversation, args, signal),
    status: (args) => {
      if (args.run === undefined) return status();
      if (!string(args.run, 64)) return { error: 'request-refused' };
      const { status: code, ...result } = currentMission().output(args.run, args.from);
      return result;
    },
    request_restart: ({ reason }, conversation) => {
      if (!string(reason, 500) || !reason.trim()) return { error: 'request-refused', detail: 'reason: 1 to 500 characters' };
      chat.restartRequest(conversation, reason.trim());
      return { asked: true, detail: 'The user sees your reason in this chat. Only the user restarts P9.' };
    },
    pin_card: (args, conversation) => {
      const data = card(args);
      if (data.error) return data;
      chat.pin(conversation, data);
      return { pinned: data.id, detail: 'Shown above this chat\'s composer, on the desktop and the phone.' };
    },
    unpin_card: ({ id }, conversation) => {
      if (typeof id !== 'string' || !CARD_ID.test(id)) return { error: 'request-refused', detail: 'id: 1 to 64 of A-Z a-z 0-9 . _ -' };
      chat.unpin(conversation, id);
      return { unpinned: id };
    },
  };

  async function readResource(uri) {
    const json = (value) => JSON.stringify(value, null, 2);
    if (uri.startsWith('p9://schema/') && Object.hasOwn(SCHEMAS, uri.slice(12))) return json(SCHEMAS[uri.slice(12)]);
    if (uri === 'p9://status') return json(await status());
    if (uri === 'p9://settings') {
      let text;
      try { text = await readText(settingsFile, 'utf8'); } catch (error) { return json({ path: settingsFile ?? null, error: error.code === 'ENOENT' ? 'settings-missing' : 'unreadable' }); }
      try { parseSettings(text); return json({ path: settingsFile, text, ok: true }); }
      catch (error) { return json({ path: settingsFile, text, ok: false, ...unparsable(error), detail: error.detail ?? String(error.message).slice(0, 300) }); }
    }
    if (uri === 'p9://registry' || uri === 'p9://space') {
      const settings = need(), { registry, space } = await files(settings), file = uri === 'p9://registry' ? registry : space;
      if (!file) return json({ path: settings.space ?? null, ...(uri === 'p9://registry' ? { error: 'unreadable-registry' } : settings.space ? missingSpace(settings.space) : noSpace()) });
      let invalid;
      try { invalid = merged(registry.content, space?.content).invalid; } catch (error) { invalid = [unparsable(error)]; }
      return json({ path: uri === 'p9://registry' ? settings.registry : settings.space, hash: file.hash, text: file.content, invalid });
    }
    if (uri === 'p9://daemon-log') {
      // Windows: the task's daemon.log, next to the state folder (install-windows.ps1). Linux: the unit's journal.
      if (process.platform === 'win32') return (await readText(path.join(state, '..', 'daemon.log'), 'utf8').catch(() => '')).split('\n').slice(-101).join('\n');
      try { return (await run('journalctl', ['--user', '-u', 'p9-foundation.service', '-n', '100', '-o', 'cat', '--no-pager'], { env: childEnv(), timeout: 5000 })).stdout; }
      catch { return ''; }
    }
    throw rpcError(-32002, 'Resource not found');
  }

  async function dispatch(conversation, method, params, signal) {
    if (method === 'initialize') {
      return { protocolVersion: VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[1], capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'p9', title: 'P9 Mission Control', version: pkg.version }, instructions: INSTRUCTIONS };
    }
    if (method === 'ping') return {};
    if (method === 'tools/list') return { tools: TOOLS };
    if (method === 'resources/list') return { resources: RESOURCES };
    if (method === 'resources/templates/list') return { resourceTemplates: [] };
    if (method === 'resources/read') {
      if (!string(params.uri, 200)) throw rpcError(-32602, 'Invalid params');
      const mimeType = RESOURCES.find((resource) => resource.uri === params.uri)?.mimeType ?? 'application/schema+json';
      return { contents: [{ uri: params.uri, mimeType, text: await readResource(params.uri) }] };
    }
    if (method === 'tools/call') {
      if (!Object.hasOwn(calls, params.name)) throw rpcError(-32602, 'Unknown tool');
      const args = object(params.arguments) ? params.arguments : {};
      let result;
      // A refusal is the tool's answer (isError), never a protocol error, so the agent reads its reason.
      const call = () => calls[params.name](args, conversation, signal);
      try {
        if (args.space === undefined || !SPACE_TOOLS.has(params.name)) result = await call();
        else result = draftAt(drafts, args.space) ? await drafting.run(args.space, call) : badName();
      }
      catch (error) { result = { error: error.code ?? error.message ?? 'failed' }; }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: Boolean(result.error) };
    }
    throw rpcError(-32601, 'Method not found');
  }

  // One JSON-RPC message from conversation's relay: the reply, or null for a notification. signal ends with the HTTP request.
  async function handle(conversation, message, signal) {
    if (!object(message) || message.jsonrpc !== '2.0') return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    const { id, method } = message, params = object(message.params) ? message.params : {};
    if (typeof method !== 'string') return null; // a response: this server never sends requests
    if (id === undefined || id === null) {
      if (method === 'notifications/cancelled') inflight.get(conversation + '\0' + JSON.stringify(params.requestId))?.abort();
      return null;
    }
    if (!(typeof id === 'string' || Number.isSafeInteger(id))) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    const key = conversation + '\0' + JSON.stringify(id), controller = new AbortController();
    inflight.set(key, controller);
    try { return { jsonrpc: '2.0', id, result: await dispatch(conversation, method, params, AbortSignal.any([signal, controller.signal])) }; }
    catch (error) { return { jsonrpc: '2.0', id, error: error.rpc ?? { code: -32603, message: String(error.message ?? 'Internal error').slice(0, 200) } }; }
    finally { if (inflight.get(key) === controller) inflight.delete(key); }
  }

  // The desktop's edit form (/mission/edit): the file hashes it edits against, and the same update() the tools use.
  async function editState() {
    const { registry, space } = await files(need());
    return { registry: registry.hash, space: space?.hash ?? null, protection: protection() };
  }
  return { handle, update, editState, install };
}
