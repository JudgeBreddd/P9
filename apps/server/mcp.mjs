// The P9 MCP server (issue #11 enhancement 7): Mission Control's schemas, files and buttons for the agent of one P9 chat.
// The adapter starts mcp-relay.mjs (chat.mjs hands it over in ACP's mcpServers), which carries each stdio line to
// POST /mcp with that chat's token; the token says which chat is calling. Writes go through the same guarded save,
// parsers and File protection as the desktop; the agent lock turns every write off; running a script or answering a
// needs-you item asks the user in the chat first.
// ponytail: MCP by hand (JSON-RPC, tools and resources only, no SDK in the daemon); the SDK if P9 needs more of the protocol.
import { DELEGATE_TOOLS, createDelegate } from './delegate.mjs';
import { readFile as readText, writeFile as writeText, open, mkdir, lstat, chmod, realpath, rename, readdir, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { readFile, guardedSave, createFile } from '../../packages/files/index.mjs';
import { parseSettings, parseRegistry, parseSpace, combine, argvFor, argRefusal, stripBom, rootRefused, withIds, spaceAt, draftAt, draftNames, spaceFile } from './mission.mjs';
import { problem, unknownFields, jsonSchema, describeMission, sectionId, SCHEMAS, RECORD, PAGE, SECTION, WIDGETS, PLACES, SPACE_FILE, CARD_BYTES, ID, SPACES_DIR, SPACE_NAME_RULE, TEMPLATES, spaceName } from './mission-fields.mjs';
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
// A title or a section name: any length, as in the file (W-O); the request body's own limit bounds it.
const words = (value) => typeof value === 'string';

const INSTRUCTIONS = 'P9 Mission Control, for this chat. Call describe_mission before building the space (it also reads as p9://schema/space; the registry\'s is p9://schema/registry), '
  + 'and dry-run a whole file with validate_registry or validate_space. Every write tool says what changed and returns the file\'s new '
  + 'hash; pass it back as hash so a file changed meanwhile is reported instead of overwritten. Writes are refused while the agent lock '
  + 'is on, and the registry and space are read-only while File protection is on. run_script, answer_needs_you and allow_folder ask the user in this '
  + 'chat first, except in Unrestricted mode (agent lock and File protection both off), where they run without asking. request_restart only asks the user; nothing restarts. To show the user an artifact beside the chat, put it in a fenced '
  + 'block whose info string is "<type> artifact [panel|pinned|full] [title]" (type: html, svg, mermaid, jsx, markdown, or any code '
  + 'language); it runs sandboxed with no network, React may import only react and react-dom, and the user\'s comments come back as one message.';

const hashField = { type: 'string', description: 'The file\'s hash from a resource read or the last write. A file changed since is reported as hash-conflict, not overwritten.' };
const sectionName = 'A space section: its id, or its title while only one section has it (two with the same title are named by id).';
const sectionField = { type: 'string', description: sectionName + ' Without it the button goes to (or comes from) the registry\'s scripts.' };
const placeField = { type: 'string', description: 'Where it draws on the desktop page: ' + PLACES.join(', ') + '. tile (the default) is a top-row tile; col1 to col6 draws it open in that column (span, set with patch_section, sets the column\'s width).' };
const orderField = { type: 'array', items: { type: 'string' }, maxItems: 32, description: SECTION.order.doc };
const widgetsField = { type: 'array', items: { type: 'string', enum: WIDGETS }, maxItems: WIDGETS.length, description: SECTION.widgets.doc };
const iconField = { type: 'string', description: RECORD.icon.doc + ' An empty string removes it.' };
const cardIdField = { type: 'string', description: 'Your name for the card, like status or todo: 1 to 64 of A-Z a-z 0-9 . _ -' };
const input = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
// The section items an agent sets as a whole list: every SECTION list of records with an example except buttons, which
// have their own tools. A new item type with fields and an example (M2, M3) joins this tool with nothing else to change.
// Scratch spaces (threat model row 71): these tools write a named draft instead of the live space when given space.
const spaceField = { type: 'string', description: 'Optional. Without it a tool reads and writes the space Mission shows (the main space, or the scratch space '
  + 'picked in Mission\'s space picker); every reply names the file. A name (' + SPACE_NAME_RULE + ') writes that scratch space instead, made on the first write; '
  + '"" writes the main space while a scratch space is shown.' };
const SPACE_TOOLS = new Set(['validate_space', 'preview_card', 'add_button', 'add_section', 'update_button', 'update_section', 'remove_button', 'remove_section', 'set_section_items', 'patch_section', 'patch_item', 'move_section', 'move_button']);
const setField = { type: 'object', description: 'The fields to write, by name, each to its new value; null removes one. Checked by the same tables as the file (describe_mission).' };
// A save racing another edit (the desktop form, or an agent that read the file a while ago): with base, a changed file is no reason to refuse.
const baseField = { type: 'object', description: 'Optional, with hash: each field of set as it was when you read the record (null or left out: it had none). If the file changed since hash, '
  + 'the write still goes ahead when every one of these fields is still as it was (another edit changed only other things); otherwise it is refused as hash-conflict, naming the fields that changed.' };
const ITEM_KINDS = Object.keys(SECTION).filter((key) => SECTION[key].fields && SECTION[key].example !== undefined && key !== 'buttons' && key !== 'widget');
const TOOLS = [
  ['describe_mission', 'How to build the Mission space: its format, an example of every item type, and the templates. Reads nothing of yours.', input({})],
  ['validate_registry', 'Dry-run a registry file with Mission Control\'s own parser (the current space included, for IDs shared between them). Nothing is written.',
    input({ text: { type: 'string', description: 'The whole registry JSON. Default: the file on disk.' } })],
  ['validate_space', 'Dry-run a space file with Mission Control\'s own parser (the current registry included). Nothing is written.',
    input({ text: { type: 'string', description: 'The whole space JSON. Default: the file on disk.' }, space: { type: 'string', description: 'Optional. Check this scratch space\'s file ("" the main space\'s) instead of the space Mission shows.' } })],
  ['add_button', 'Add a script button to the registry, or to a space section. Refused if Mission Control would drop it.',
    input({ record: jsonSchema(RECORD, {}, true), section: sectionField, space: spaceField, hash: hashField }, ['record'])],
  ['add_app', 'Add an app to the registry.', input({ record: jsonSchema(RECORD, {}, true), hash: hashField }, ['record'])],
  ['add_page', 'Add a link to the registry.', input({ record: jsonSchema(PAGE, {}, true), hash: hashField }, ['record'])],
  ['add_section', 'Add an empty section to the space.', input({ title: { type: 'string' }, id: { type: 'string', description: SECTION.id.doc }, text: { type: 'string' }, place: placeField, order: orderField, widgets: widgetsField, space: spaceField, hash: hashField }, ['title'])],
  ['update_button', 'Change a script button\'s title or icon in the registry, or in a space section. icon "" removes the icon.',
    input({ id: { type: 'string' }, section: sectionField, title: { type: 'string' }, icon: iconField,
      move_to: { type: 'string', description: 'Move the button (with section, its current section) into this space section (its id, or a title only one section has), in one write, so nothing points at a missing ID in between.' },
      space: spaceField, hash: hashField }, ['id'])],
  ['update_app', 'Change an app\'s title or icon. icon "" removes the icon.', input({ id: { type: 'string' }, title: { type: 'string' }, icon: iconField, hash: hashField }, ['id'])],
  ['update_page', 'Change a link\'s title or icon. icon "" removes the icon.', input({ id: { type: 'string' }, title: { type: 'string' }, icon: iconField, hash: hashField }, ['id'])],
  ['update_section', 'Change a space section: rename it (new_title), change its icon, draw one of P9\'s built-in panels as it (widget) or inside it (widgets), place it on the page (place), '
    + 'set the order of its parts (order), show registry entries in it (refs) or show a notes folder (notes). "" or [] removes a field.',
    input({ title: { type: 'string', description: sectionName }, new_title: { type: 'string' }, icon: iconField,
      text: { type: 'string', description: 'The paragraph under the heading. "" removes it.' },
      widget: { type: 'string', description: 'One of ' + WIDGETS.join(', ') + '. "" removes it.' },
      place: { ...placeField, description: placeField.description + ' "" removes it.' },
      refs: { type: 'array', items: { type: 'string' }, description: 'IDs of registry scripts, apps or pages (read them from p9://registry) or of space buttons, at most 64. [] removes them.' },
      notes: { type: 'string', description: 'A key of settings.notes_roots (allow_folder asks the user to add one), never a path. "" removes it.' },
      order: { ...orderField, description: orderField.description + ' [] removes it.' }, widgets: { ...widgetsField, description: widgetsField.description + ' [] removes them.' },
      space: spaceField, hash: hashField }, ['title'])],
  ['remove_button', 'Remove a script button by ID from the registry, or from a space section.', input({ id: { type: 'string' }, section: sectionField, space: spaceField, hash: hashField }, ['id'])],
  ['remove_app', 'Remove an app by ID.', input({ id: { type: 'string' }, hash: hashField }, ['id'])],
  ['remove_page', 'Remove a link by ID.', input({ id: { type: 'string' }, hash: hashField }, ['id'])],
  ['remove_section', 'Remove a space section, its buttons and log views, by id (or a title only one section has).', input({ title: { type: 'string', description: sectionName }, space: spaceField, hash: hashField }, ['title'])],
  ['allow_folder', 'Ask the user, in this chat, to let Mission Control list a folder outside the workspace: read-only, except that a space checklist can change review and mark lines in it. On yes it is added to settings.notes_roots '
    + 'as name: use name as a space folders item\'s root, or as a section\'s notes. A folder holding the workspace, the home folder or P9\'s own files is refused.',
    input({ name: { type: 'string', description: 'The root\'s name: 1 to 64 of a-z 0-9 -, starting with a letter or digit, not already in settings.notes_roots.' },
      folder: { type: 'string', description: 'The folder, as an absolute path.' } }, ['name', 'folder'])],
  ['set_section_items', 'Replace one kind of item in a space section with this list ([] removes them): ' + ITEM_KINDS.join(', ')
    + '. describe_mission gives each kind\'s fields and an example (a card or data tile with frame false draws without its own box). A field P9 does not know is kept and named in the reply. '
    + 'A data tile runs only after the user answers Allow on it in Mission.',
    input({ title: { type: 'string', description: sectionName }, kind: { type: 'string', enum: ITEM_KINDS },
      items: { type: 'array', items: { type: 'object' } }, space: spaceField, hash: hashField }, ['title', 'kind', 'items'])],
  ['patch_section', 'Set any fields of a space section in one write (null removes one): every field of describe_mission, quick_note and id included, and its item lists whole. '
    + 'A field P9 does not know is kept and named in the reply.', input({ section: { type: 'string', description: sectionName }, set: setField, base: baseField, space: spaceField, hash: hashField }, ['section', 'set'])],
  ['patch_item', 'Set any fields of a script button, app or page in one write (null removes one), as add_button, add_app and add_page check them. A button in a space section needs section.',
    input({ kind: { type: 'string', enum: ['scripts', 'apps', 'pages'] }, id: { type: 'string' }, section: sectionField, set: setField, base: baseField, space: spaceField, hash: hashField }, ['kind', 'id', 'set'])],
  ['preview_card', 'How a space card looks (#5): its HTML file with sample data put in as window.p9data and the p9data event, as one HTML document. Show it to the user in a fenced block whose info string is '
    + '"html artifact panel <title>": the artifact frame is the same sandbox the card runs in. Reads the card\'s file; runs nothing.',
    input({ id: { type: 'string', description: 'The card\'s id in the space.' }, data: { description: 'Optional sample JSON, as the card\'s script would print it. Without it window.p9data is undefined, as before the first run.' },
      space: spaceField }, ['id'])],
  ['move_section', 'Move a space section to a place in the file\'s order: index 0 is first. The page draws its tiles and columns in this order.',
    input({ section: { type: 'string', description: sectionName }, index: { type: 'integer', minimum: 0 }, space: spaceField, hash: hashField }, ['section', 'index'])],
  ['move_button', 'Move a space button to index within its section (0 is first), or into another section with to (at index, default last).',
    input({ id: { type: 'string' }, section: { type: 'string', description: 'The button\'s section. ' + sectionName }, to: { type: 'string', description: 'The section to move it into. ' + sectionName },
      index: { type: 'integer', minimum: 0 }, space: spaceField, hash: hashField }, ['id', 'section'])],
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
  ...DELEGATE_TOOLS(input),
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
const ANSWERING = new Set(['describe_mission', 'status', 'validate_registry', 'validate_space', 'list_chats', 'read_chat', 'wait_chat']);

export function createMcp({ workspace, recovery, state, settingsFile, settings: current, mission: currentMission, chat, readOnly, protection, useSpace, changeSettings }) {
  const inflight = new Map(); // conversation + request ID -> AbortController, for notifications/cancelled

  const need = () => { const settings = current(); if (!settings) throw new Error('settings-missing'); return settings; };
  // The scratch space a tool call or the desktop form writes (threat model row 71); undefined: the main space.
  const drafts = settingsFile ? path.join(path.dirname(settingsFile), SPACES_DIR) : null;
  const drafting = new AsyncLocalStorage();
  const badName = () => ({ error: 'request-refused', detail: 'space: ' + SPACE_NAME_RULE + ', or "" for the main space.' });
  // The space a call reads and writes (W-A): its space argument ("" the main space), else the one Mission shows (settings.space_name).
  const shown = () => drafting.getStore() ?? current()?.space_name ?? '';
  // Mission Control's own merge: a space that will not parse drops only the space (mission.mjs registry()), unless it is the file being checked.
  function merged(registryText, spaceText, strictSpace = false) {
    let space = empty();
    if (spaceText !== undefined) {
      try { space = parseSpace(spaceText); } catch (error) { if (strictSpace) throw error; space.invalid.push({ kind: 'space', reason: 'unreadable-space' }); }
    }
    return combine(parseRegistry(registryText, current()?.page_schemes), space);
  }
  // draft: a scratch space's name, "" the main space. file: the space file it names (null for a bad name, undefined with no main space).
  async function files(settings = need(), draft = shown()) {
    const registry = settings.registry === undefined ? { content: '{}' } : await readFile(workspace, settings.registry), file = spaceFile(settings, drafts, draft);
    const space = file ? await readFile(...spaceAt(workspace, file)).catch(() => null) : null;
    return { registry, space, file };
  }
  const counts = (all) => ({ scripts: all.scripts.length, apps: all.apps.length, pages: all.pages.length, sections: all.space.length, invalid: all.invalid.length });

  async function status() {
    let settings = 'missing';
    try { if (settingsFile) { parseSettings(await readText(settingsFile, 'utf8')); settings = 'ok'; } }
    catch (error) { if (error.code !== 'ENOENT') settings = 'invalid'; }
    const result = { version: pkg.version, agentLock: chat.lock().on, fileProtection: protection(), settings, missionControl: current() ? 'on' : 'off',
      ...(current() ? { space: spaceFile(current(), drafts) ?? 'no space file yet: the first add_section creates one', ...(current().space_name ? { spaceName: current().space_name } : {}) } : {}) };
    if (current()) {
      try { const { registry, space } = await files(current(), current().space_name ?? ''); result.mission = counts(merged(registry.content, space?.content)); }
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
    const settings = need(), draft = shown(), { registry, space, file } = await files(settings, draft);
    if (kind === 'space') {
      // Wall 8: a scratch space (space) is checked as its own file, so Main need not exist.
      if (text === undefined && draft && !space) return { ok: false, file, error: 'no-space-file', detail: 'No scratch space named ' + draft + ' yet: its first write makes it.' };
      if (text === undefined && !settings.space && !draft) return { ok: false, ...noSpace() };
      if (text === undefined && !space) return { ok: false, ...missingSpace(settings.space) };
      const subject = text === undefined ? 'The space file ' + (draft || settings.space) : 'The text';
      if (!(text ?? space.content).trim()) return { ok: false, ...spaceWords(subject, 'empty') };
      try { parseSpace(text ?? space.content); } catch (error) { return { ok: false, ...spaceWords(subject, error) }; }
    }
    try {
      const all = kind === 'registry' ? merged(text ?? registry.content, space?.content) : merged(registry.content, text ?? space?.content ?? '', true);
      return { ok: !all.invalid.length, ...(kind === 'space' ? { file } : {}), accepted: counts(all), invalid: all.invalid };
    } catch (error) { return { ok: false, ...unparsable(error) }; }
  }

  // One edit of the registry or the space: change(data) edits the parsed file and says what it did; the new file must
  // still parse, and accepted(all) says whether Mission Control keeps what was added. Then the guarded save.
  // by.user: the desktop's edit form. The agent lock is about agents, so it does not stop the user; File protection still
  // does, unless the form got the user's confirmation first (by.confirm).
  async function edit(which, hash, change, by = {}) {
    if (chat.lock().on && !by.user) return { error: 'agent-lock-on', detail: 'The agent lock is on: the user turns it off on the desktop.' };
    if (hash !== undefined && !(typeof hash === 'string' && HASH.test(hash))) return { error: 'request-refused', detail: 'hash: 64 hex characters' };
    // A tool's space argument, else the space Mission shows (W-A), for the tools and the desktop form alike. Only a named space refuses a registry write.
    const draft = shown();
    let settings = need(), file = which === 'registry' ? settings.registry : spaceFile(settings, drafts, draft);
    if (which === 'registry' && settings.registry === undefined) return { error: 'request-refused', detail: 'No registry file is set in settings.json.' };
    if (drafting.getStore() && which === 'registry') return { error: 'request-refused', detail: 'A scratch space holds sections only. Buttons outside a section, apps and pages go to the registry: leave space out.' };
    if (which === 'space' && draft) {
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
    if (done.error) return { file, ...done };
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
  // A new owner-only file holding text, never through a link or over another file, synced before it counts.
  async function exclusive(file, text) {
    const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
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
  async function install(name, space, confirm) {
    const template = TEMPLATES.find((entry) => entry.name === name) ?? await userTemplate(name);
    if (!template) return { error: 'unknown-template' };
    if (space !== undefined && !draftAt(drafts, space)) return badName();
    return drafting.run(space, () => edit('space', undefined, (data) => {
      if (!Array.isArray(data.sections)) return { error: 'invalid-space' };
      if (data.sections.length) return { error: 'space-not-empty', detail: 'The space has sections already, so P9 adds no template to it.' };
      data.sections = structuredClone(template.space.sections);
      return { changed: { action: 'installed', template: name, ...(space !== undefined ? { space } : {}) } };
    }, { user: true, confirm: confirm === true }));
  }
  // Finding 4 adds (threat model rows A and B): Delete a space, and user templates in the settings folder.
  const home = settingsFile ? path.dirname(settingsFile) : null, templatesDir = home && path.join(home, 'templates');
  async function plainFolder(dir) {
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const folder = await lstat(dir);
      return folder.isSymbolicLink() || !folder.isDirectory() ? { error: 'request-refused', detail: dir + ' is not a plain folder, so P9 will not write there.' } : {};
    } catch (error) { return { error: 'save-failed', code: error.code }; }
  }
  // Main is never in the spaces folder, so it is never deleted; the last space is kept (Main counts when settings name its file).
  async function deleteSpace(name, confirm) {
    const file = draftAt(drafts, name);
    if (!file) return badName();
    const names = await draftNames(drafts), settings = need();
    if (!names.includes(name)) return { error: 'unknown-space' };
    if (names.length === 1 && !settings.space) return { error: 'last-space', detail: 'This is the only space, so P9 keeps it. Add another space first.' };
    if (protection() && confirm !== true) return { error: 'registry-read-only', detail: 'File protection is on: the user confirms the move with a second click.' };
    // A real delete (no deleted folder, no trash) after the confirm that names the space; a link is never in names.
    try { await unlink(file); } catch (error) { return { error: 'save-failed', code: error.code }; }
    return { deleted: name, next: settings.space ? null : names.find((entry) => entry !== name) };
  }
  // A user template read back: a plain file under 6 MB, { title, about, space }, and a space validate_space accepts; else left out.
  async function userTemplate(name) {
    if (!templatesDir || !spaceName(name) || TEMPLATES.some((entry) => entry.name === name)) return null;
    try {
      const handle = await open(path.join(templatesDir, name + '.json'), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let text;
      try { const info = await handle.stat(); if (!info.isFile() || info.size > 6 * 1024 * 1024) return null; text = await handle.readFile('utf8'); } finally { await handle.close(); }
      const data = JSON.parse(stripBom(text));
      if (!object(data) || typeof data.title !== 'string' || typeof data.about !== 'string' || !object(data.space) || !Array.isArray(data.space.sections)) return null;
      return (await validate('space', JSON.stringify(data.space))).ok ? { name, title: data.title.slice(0, 80), about: data.about.slice(0, 200), space: data.space, user: true } : null;
    } catch { return null; }
  }
  async function userTemplates() {
    if (!templatesDir) return [];
    const names = await readdir(templatesDir, { withFileTypes: true }).then((list) => list.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name.slice(0, -5)).sort(), () => []);
    return (await Promise.all(names.map(userTemplate))).filter(Boolean);
  }
  // The space Mission shows, as it is now, saved as <settings folder>/templates/<name>.json. A clash asks Replace or Rename.
  async function saveTemplate(name, about, replace) {
    if (!templatesDir || !spaceName(name)) return badName();
    if (TEMPLATES.some((entry) => entry.name === name)) return { error: 'builtin-template', detail: 'A built-in template has that name.' };
    const settings = need(), { space } = await files(settings);
    if (!space?.content) return noSpace();
    const check = await validate('space', space.content);
    if (!check.ok) return { error: 'invalid-space', detail: 'Mission Control would drop part of this space, so it was not saved as a template.', invalid: check.invalid ?? [] };
    const made = await plainFolder(templatesDir);
    if (made.error) return made;
    const file = path.join(templatesDir, name + '.json'), there = await lstat(file).then(() => true, () => false);
    if (there && replace !== true) return { error: 'template-exists' };
    // Replace: written beside it under a temporary name, then renamed over it, so a failed write leaves the old template whole.
    const to = there ? path.join(templatesDir, '.' + name + '.' + Date.now() + '.tmp') : file;
    let handle;
    try { handle = await open(to, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); }
    catch (error) { return { error: 'save-failed', code: error.code }; }
    try { await handle.writeFile(JSON.stringify({ title: name, about, space: JSON.parse(stripBom(space.content)) }, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
    if (there) try { await rename(to, file); } catch (error) { await unlink(to).catch(() => {}); return { error: 'save-failed', code: error.code }; }
    return { saved: name };
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
  // A section by its id, else by its title while only one section has it (W-C); an ambiguous title names the ids to use.
  function section(data, key) {
    const sections = list(data, 'sections');
    if (!sections) return { error: 'invalid-space' };
    const byId = sections.filter((entry) => object(entry) && entry.id === key);
    if (byId.length === 1) return { entry: byId[0], sections };
    const found = sections.filter((entry) => typeof entry?.title === 'string' && entry.title.trim() === key.trim()), ids = found.map((entry) => entry.id);
    return found.length === 1 ? { entry: found[0], sections } : found.length
      ? { error: 'ambiguous-section', section: key, ids, detail: ids.length + ' sections are titled "' + key.trim() + '": name one by its id (' + ids.join(', ') + ').' } : { error: 'unknown-section', section: key };
  }
  function add(kind, record, sectionTitle, hash) {
    const wrong = problem(record, kind === 'pages' ? PAGE : RECORD, true);
    if (wrong) return { error: 'invalid-record', detail: wrong };
    if (sectionTitle !== undefined && !words(sectionTitle)) return { error: 'request-refused' };
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
    if (!string(id, 200) || (sectionTitle !== undefined && !words(sectionTitle))) return { error: 'request-refused' };
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
  // A section also takes widget, widgets, place, order, refs and notes (threat model row 72 e); any other kind given one is refused. "" or [] removes each.
  const FIELDS = { scripts: RECORD, apps: RECORD, pages: PAGE, sections: SECTION };
  // picture (the name of a stored file, '' removes it) is the desktop form's alone: an agent's tool call is refused if it names one.
  function update(kind, { key, section: sectionTitle, title, icon, picture, widget, place, refs, notes, text, order, widgets, move_to: moveTo, hash }, by) {
    if (!words(key) || ![sectionTitle, title, icon, picture, widget, place, notes, moveTo, text].every((value) => value === undefined || words(value)) || (picture !== undefined && !by?.user) || [refs, order, widgets].some((value) => value !== undefined && !Array.isArray(value))
      || (kind !== 'sections' && [widget, place, refs, notes, text, order, widgets].some((value) => value !== undefined))
      || (moveTo !== undefined && (kind !== 'scripts' || sectionTitle === undefined))) return { error: 'request-refused' };
    if ([title, icon, picture, widget, place, refs, notes, text, order, widgets, moveTo].every((value) => value === undefined)) return { error: 'nothing-to-change', detail: 'Give a title or an icon (a section also takes text, widget, widgets, place, order, refs or notes; a space button move_to).' };
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
        // Wall 12: move a space button to another section in the same write.
        if (moveTo !== undefined) {
          const to = section(data, moveTo); if (to.error) return to;
          if (!Array.isArray(to.entry.buttons ?? [])) return { error: 'invalid-space' };
          target.splice(target.indexOf(entry), 1); (to.entry.buttons ??= []).push(entry);
        }
      }
      const before = { ...entry };
      if (title !== undefined) entry.title = title;
      if (icon === '') delete entry.icon; else if (icon !== undefined) entry.icon = icon;
      if (picture === '') delete entry.picture; else if (picture !== undefined) entry.picture = picture;
      // A section's panel, place, references and notes key (threat model row 72 e): "" or [] removes; the SECTION table checks the rest below.
      for (const [field, value] of Object.entries({ text, widget, place, refs, notes, order, widgets })) if (value?.length === 0) delete entry[field]; else if (value !== undefined) entry[field] = value;
      const wrong = problem(entry, FIELDS[kind], false, current()?.page_schemes);
      if (wrong) return { error: 'invalid-record', detail: wrong };
      return { changed: { action: 'updated', kind, [kind === 'sections' ? 'section' : 'id']: key, record: entry, was: before },
        accepted: (all) => (kind === 'sections' ? all.space.some((item) => item.id === entry.id) : all[kind].some((item) => item.id === key)) };
    }, by);
  }

  // The generic patch (W-E, W-N): set names fields and their new values, null removes one. A section takes any field, known or not
  // (an unknown one is kept and named, W-F), and its item lists whole, each item checked as set_section_items checks it. A button, app
  // or page takes only its table's fields, as add_* does; an unknown key the record already has stays. The same rules as the specific
  // tools hold: the field tables, picture from the desktop form only, unique ids, and Mission Control's own merge keeping the result.
  function patch(kind, { key, section: where, set, base, hash }, by) {
    const fields = FIELDS[kind];
    if (!fields || !words(key) || (where !== undefined && (kind !== 'scripts' || !words(where))) || !object(set) || !Object.keys(set).length || ('picture' in set && !by?.user)
      || (base !== undefined && (!object(base) || hash === undefined))) {
      return { error: 'request-refused', detail: 'kind: scripts, apps, pages or sections; set: an object of fields (picture only from the desktop form); section only for a space button; base only with hash.' };
    }
    const added = kind !== 'sections' && Object.keys(set).find((name) => !Object.hasOwn(fields, name) && set[name] !== null);
    if (added) return { error: 'invalid-record', detail: unknownFields({ [added]: set[added] }, fields, 'this record')[0] };
    // With base, the hash is checked field by field below instead of whole (the save itself still refuses a file changed after this read).
    return edit(kind === 'sections' || where !== undefined ? 'space' : 'registry', base ? undefined : hash, (data) => {
      let entry, others;
      if (kind === 'sections') { const found = section(data, key); if (found.error) return found; entry = found.entry; others = found.sections; }
      else {
        let target;
        if (where === undefined) target = list(data, kind);
        else { const found = section(data, where); if (found.error) return found; target = list(found.entry, 'buttons'); }
        const hits = target?.filter((item) => item?.id === key) ?? [];
        if (hits.length !== 1) return { error: hits.length ? 'duplicate-id' : 'unknown-id', id: key };
        entry = hits[0]; others = target;
      }
      // ponytail: compared as JSON text, so a field whose keys were reordered by hand counts as changed (refused, never lost).
      const moved = base ? Object.keys(set).filter((name) => JSON.stringify(entry[name] ?? null) !== JSON.stringify(base[name] ?? null)) : [];
      if (moved.length) return { error: 'hash-conflict', fields: moved, detail: 'The file changed since it was read, and so did ' + moved.join(', ') + ': nothing was saved.' };
      const before = structuredClone(entry);
      for (const [name, value] of Object.entries(set)) if (value === null) delete entry[name]; else entry[name] = value;
      const wrong = kind === 'sections' && entry.id === undefined ? 'id: a section keeps its id; set a new one instead' : problem(entry, fields, false, current()?.page_schemes);
      if (wrong) return { error: 'invalid-record', detail: wrong };
      if (others.some((other) => other !== entry && other?.id === entry.id)) return { error: kind === 'sections' ? 'duplicate-section' : 'duplicate-id', id: entry.id };
      const unknown = kind === 'sections' ? unknownFields(Object.fromEntries(Object.entries(set).filter(([, value]) => value !== null)), SECTION, 'a section').map((detail) => ({ detail })) : [];
      for (const name of kind === 'sections' ? Object.keys(set).filter((name) => SECTION[name]?.fields && set[name] !== null) : []) {
        for (const [index, item] of entry[name].entries()) {
          const bad = problem(item, SECTION[name].fields, false, current()?.page_schemes), had = (before[name] ?? []).find((old) => object(old) && old.id === item?.id);
          if (bad) return { error: 'invalid-item', kind: name, index, detail: bad };
          // A button is a command: no field add_button would refuse, unless that button already had it.
          const extra = Object.keys(item).find((field) => !Object.hasOwn(RECORD, field) && !(had && Object.hasOwn(had, field)));
          if (name === 'buttons' && extra) return { error: 'invalid-item', kind: name, index, detail: unknownFields({ [extra]: item[extra] }, RECORD, 'a button')[0] };
          if (name !== 'buttons') unknown.push(...unknownFields(item, SECTION[name].fields, 'this record').map((detail) => ({ kind: name, index, detail })));
        }
      }
      return { changed: { action: 'patched', kind, [kind === 'sections' ? 'section' : 'id']: entry.id, record: entry, was: before, ...(unknown.length ? { unknown } : {}) },
        accepted: (all) => {
          if (kind !== 'sections') return all[kind].some((item) => item.id === entry.id);
          const kept = all.space.find((item) => item.id === entry.id);
          return Boolean(kept) && Object.keys(set).filter((name) => SECTION[name]?.fields).every((name) => (name === 'buttons'
            ? (entry.buttons ?? []).every((button) => all.scripts.some((item) => item.id === button.id && item.section === entry.id)) : (kept[name]?.length ?? 0) === (entry[name]?.length ?? 0)));
        } };
    }, by);
  }
  // Reorder (W-E): a section to index in the file, or a space button to index in its section or, with to, in another one.
  function move({ section: key, id, to, index, hash }, by) {
    if (!words(key) || (id !== undefined && !string(id, 200)) || (to !== undefined && (id === undefined || !words(to))) || (index !== undefined && !(Number.isSafeInteger(index) && index >= 0))
      || (id === undefined && index === undefined)) return { error: 'request-refused', detail: 'section; index (0 is first); for a button id, and to for another section.' };
    return edit('space', hash, (data) => {
      const found = section(data, key);
      if (found.error) return found;
      const { entry, sections } = found;
      if (id === undefined) {
        if (index >= sections.length) return { error: 'request-refused', detail: 'index: 0 to ' + (sections.length - 1) };
        sections.splice(sections.indexOf(entry), 1); sections.splice(index, 0, entry);
        return { changed: { action: 'moved', kind: 'section', section: entry.id, index, order: sections.map((item) => item?.id) }, accepted: (all) => all.space.some((item) => item.id === entry.id) };
      }
      const into = to === undefined ? found : section(data, to);
      if (into.error) return into;
      const from = list(entry, 'buttons'), target = list(into.entry, 'buttons');
      if (!from || !target) return { error: 'not-a-list', detail: 'buttons is not a list' };
      const hits = from.filter((item) => item?.id === id);
      if (hits.length !== 1) return { error: hits.length ? 'duplicate-id' : 'unknown-id', id };
      from.splice(from.indexOf(hits[0]), 1);
      const at = index ?? target.length;
      if (at > target.length) return { error: 'request-refused', detail: 'index: 0 to ' + target.length };
      target.splice(at, 0, hits[0]);
      return { changed: { action: 'moved', kind: 'button', id, section: into.entry.id, index: at, order: target.map((item) => item?.id) },
        accepted: (all) => all.scripts.some((item) => item.id === id && item.section === into.entry.id) };
    }, by);
  }

  // A named choices list ("plans") is filled by Mission itself, so argRefusal checks the same values a run does.
  const lookup = async (id) => {
    const { registry, space } = await files(), item = merged(registry.content, space?.content).scripts.find((entry) => entry.id === id);
    return item && (await currentMission().named([item]))[0];
  };
  // Unrestricted mode (v0.1.6 U3, threat model row 33): the user turned the asks off, so the tool acts; every other check stays.
  const allowed = (conversation, request, signal) => chat.loose(conversation) || chat.approve(conversation, request, signal);
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
    if (!await allowed(conversation, { toolCallId: 'p9-mcp-' + randomUUID(), title, kind: 'execute' }, signal)) return { error: 'not-allowed', detail: 'The user did not allow it.' };
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
    if (await rootRefused(real, { workspace, recovery, also: state ? [state] : [], loose: chat.loose() })) return { error: 'root-refused', detail: 'It holds the workspace, the home folder or P9\'s own files.' };
    let before, roots;
    try { before = await readText(settingsFile, 'utf8'); roots = parseSettings(before).notes_roots ?? {}; }
    catch (error) { return { ...unparsable(error), error: 'settings-invalid' }; }
    if (Object.hasOwn(roots, name)) return { error: 'name-taken', name, folder: roots[name] };
    if (Object.keys(roots).length >= 16) return { error: 'request-refused', reason: 'settings.notes_roots already has 16 folders' };
    // Threat model row M4-a: a checklist can write review and mark lines in a notes root, so the question says so.
    const title = 'P9 Mission Control: let Mission list the folder ' + real + ', named ' + name + '. Mission reads it, and a checklist in your space can change the review and mark lines of files in it, nothing else.';
    if (title.length > 5000) return { error: 'request-refused', reason: 'the folder is too long to show the user in full' };
    if (!await allowed(conversation, { toolCallId: 'p9-mcp-' + randomUUID(), title, kind: 'edit' }, signal)) return { error: 'not-allowed', detail: 'The user did not allow it.' };
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
    if (!await allowed(conversation, { toolCallId: 'p9-mcp-' + randomUUID(), title, kind: 'edit' }, signal)) return { error: 'not-allowed', detail: 'The user did not allow it.' };
    const { status: code, diskContent, content, conflict, ...result } = await currentMission().answer({ name, hash, answer });
    return result.kind === 'saved' ? { action: 'answered', name, hash: result.hash } : result.kind === 'conflict' ? { error: result.reason, name, diskHash: result.diskHash }
      : result.error ? result : { error: result.reason ?? 'save-failed', code: result.code };
  }

  const calls = {
    ...createDelegate({ chat, allowed }),
    describe_mission: () => describeMission(),
    validate_registry: (args) => validate('registry', args.text),
    validate_space: (args) => validate('space', args.text),
    add_button: (args) => add('scripts', args.record, args.section, args.hash),
    add_app: (args) => add('apps', args.record, undefined, args.hash),
    add_page: (args) => add('pages', args.record, undefined, args.hash),
    // A title may repeat (W-C): the new section gets its own id, given or made from the title.
    add_section: ({ title, id, text, place, order, widgets, hash }) => {
      const record = { ...(id !== undefined ? { id } : {}), title, ...(text !== undefined ? { text } : {}), ...(place !== undefined ? { place } : {}), ...(order !== undefined ? { order } : {}), ...(widgets !== undefined ? { widgets } : {}) };
      const wrong = problem(record, SECTION);
      if (wrong) return { error: 'invalid-section', detail: wrong };
      return edit('space', hash, (data) => {
        const sections = list(data, 'sections');
        if (!sections) return { error: 'invalid-space' };
        // ids are unique among sections (M1); every section has one by now (edit() added any missing).
        const taken = new Set(sections.map((other) => other?.id));
        if (id !== undefined && taken.has(id)) return { error: 'duplicate-section', id, detail: 'Another section already has the id ' + id + '.' };
        const entry = { id: id ?? sectionId(record.title.trim(), taken), ...record };
        sections.push(entry);
        return { changed: { action: 'added', kind: 'section', record: entry }, accepted: (all) => all.space.some((item) => item.id === entry.id) };
      });
    },
    set_section_items: ({ title, kind, items, hash }) => {
      if (!words(title) || !ITEM_KINDS.includes(kind) || !Array.isArray(items)) {
        return { error: 'request-refused', reason: 'title: a section id or title; kind: one of ' + ITEM_KINDS.join(', ') + '; items: a list' };
      }
      // Each item is checked before anything is written, so a javascript: link is named, not dropped. An unknown field is kept, as the parser
      // keeps it (W-F), and named in the reply so a typo shows.
      for (const [index, item] of items.entries()) {
        const wrong = problem(item, SECTION[kind].fields);
        if (wrong) return { error: 'invalid-item', kind, index, detail: wrong };
      }
      const unknown = items.flatMap((item, index) => unknownFields(item, SECTION[kind].fields, 'this record').map((detail) => ({ index, detail })));
      return edit('space', hash, (data) => {
        const found = section(data, title);
        if (found.error) return found;
        if (items.length) found.entry[kind] = items; else delete found.entry[kind];
        return { changed: { action: 'updated', kind, section: found.entry.id, items, ...(unknown.length ? { unknown } : {}) },
          accepted: (all) => (all.space.find((entry) => entry.id === found.entry.id)?.[kind]?.length ?? 0) === items.length };
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
      if (!words(title)) return { error: 'request-refused' };
      return edit('space', hash, (data) => {
        const found = section(data, title);
        if (found.error) return found;
        found.sections.splice(found.sections.indexOf(found.entry), 1);
        return { changed: { action: 'removed', kind: 'section', record: found.entry } };
      });
    },
    patch_section: ({ section: key, set, base, hash }) => patch('sections', { key, set, base, hash }),
    patch_item: ({ kind, id, section: where, set, base, hash }) => (['scripts', 'apps', 'pages'].includes(kind) ? patch(kind, { key: id, section: where, set, base, hash }) : { error: 'request-refused', detail: 'kind: scripts, apps or pages' }),
    preview_card: (args) => previewCard(args),
    move_section: ({ section: key, index, hash }) => (index === undefined ? { error: 'request-refused', detail: 'index: 0 is first' } : move({ section: key, index, hash })),
    move_button: ({ id, section: key, to, index, hash }) => (id === undefined ? { error: 'request-refused' } : move({ section: key, id, to, index, hash })),
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
      // The space Mission shows (W-A), and path names its file.
      const settings = need(), { registry, space, file: where } = await files(settings), file = uri === 'p9://registry' ? registry : space;
      if (!file) return json({ path: where ?? null, ...(uri === 'p9://registry' ? { error: 'unreadable-registry' } : where ? missingSpace(where) : noSpace()) });
      let invalid;
      try { invalid = merged(registry.content, space?.content).invalid; } catch (error) { invalid = [unparsable(error)]; }
      return json({ path: uri === 'p9://registry' ? settings.registry : where, hash: file.hash, text: file.content, invalid });
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
      // Peer help (SECURITY.md § Delegate): while this chat's turn answers another chat's question, only the tools
      // that read run. A list of what may run, so a tool added later is refused until someone puts it here.
      if (chat.answering(conversation) && !ANSWERING.has(params.name)) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'answer-only', detail: 'This turn answers another chat\'s question and is read-only: answer in your reply.' }, null, 2) }], isError: true };
      }
      try {
        if (args.space === undefined || !SPACE_TOOLS.has(params.name)) result = await call();
        else result = args.space === '' || draftAt(drafts, args.space) ? await drafting.run(args.space, call) : badName();
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

  // preview_card (#5): the card's own file, read as the page reads it, with the sample data set before its scripts run and sent as the
  // p9data event once it has loaded, as the page does after each run. The size it gets on the page is said beside it.
  async function previewCard({ id, data }) {
    if (!words(id)) return { error: 'request-refused', detail: 'id: the card\'s id' };
    const { space, file } = await files();
    if (!space) return file ? missingSpace(file) : noSpace();
    let all;
    try { all = parseSpace(space.content); } catch (error) { return { file, ...unparsable(error) }; }
    const where = all.sections.find((entry) => (entry.cards ?? []).some((item) => item.id === id)), card = where?.cards.find((item) => item.id === id);
    if (!card) return { error: 'unknown-id', id, file };
    let html;
    // Review 3 L2: read as the page reads it (P11).
    try { html = (await readFile(workspace, card.html, { space: true })).content; } catch { return { error: 'not-found', detail: 'The card file ' + card.html + ' was not found in the workspace.', file }; }
    if (Buffer.byteLength(html) > CARD_BYTES) return { error: 'too-big', detail: 'The card file ' + card.html + ' is over 256 KiB.', file };
    const json = data === undefined ? 'undefined' : JSON.stringify(data).replace(/</g, '\\u003c');
    const head = `<script>window.p9data = ${json}; addEventListener('load', () => { if (window.p9data !== undefined) dispatchEvent(new CustomEvent('p9data', { detail: window.p9data })); });</script>`;
    return { id, title: card.title, section: where.id, file, html: card.html, frame: card.frame !== false,
      size: 'On the page the card is as wide as its section (a column or the section\'s window) and as tall as its content, 60 to 720 px; a page sized to 100vh grows to 720.'
        + (card.frame === false ? ' frame is false, so it draws with no box or title of its own.' : ' It draws in a box under its title.'),
      document: head + html };
  }
  // The desktop's edit form (/mission/edit): the file hashes it edits against (the space Mission shows, W-B), and the same update() the tools use.
  async function editState() {
    const { registry, space } = await files(need());
    // The records as the files hold them, for the field editor (W-N): each section, app and page whole, unknown keys included.
    const read = (file) => { try { const data = JSON.parse(stripBom(file?.content ?? '{}')); return object(data) ? data : {}; } catch { return {}; } };
    const reg = read(registry), spc = read(space), lists = (data, key) => (Array.isArray(data[key]) ? data[key].filter(object) : []);
    return { registry: registry.hash, space: space?.hash ?? null, protection: protection(), records: { scripts: lists(reg, 'scripts'), apps: lists(reg, 'apps'), pages: lists(reg, 'pages'), sections: lists(spc, 'sections') } };
  }
  return { handle, update, patch, move, editState, install, deleteSpace, saveTemplate, userTemplates };
}
