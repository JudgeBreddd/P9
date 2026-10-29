// What Mission Control's files may hold, field by field. mission.mjs's parsers check every record against these tables,
// and the P9 MCP server publishes them as JSON Schema with the docs, so what an agent reads is what the parser accepts.
import path from 'node:path';

export const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export function relativePath(value) {
  return typeof value === 'string' && value && !path.isAbsolute(value) && !value.split('/').some((part) => !part || part === '.' || part === '..');
}
export const strings = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string' && item && !item.includes('\0'));
export const optional = (record, key, check) => !(key in record) || check(record[key]);
export const web = (value) => typeof value === 'string' && /^https?:\/\/[^\s]+$/.test(value);

// A page may open with a scheme the user listed in settings.page_schemes. These never open, even when listed (they run code or read files).
const NEVER_SCHEMES = new Set(['javascript', 'file', 'data', 'vbscript', 'blob']);
// Two letters at least, so a Windows drive path (c:\...) is never a scheme.
const SCHEME = /^[a-z][a-z0-9+.-]{1,31}$/;
const schemeOf = (url) => url.match(/^([a-z][a-z0-9+.-]*):/i)?.[1].toLowerCase();
// A page link: http(s), or a scheme from settings.page_schemes that is not on the never list (M6).
const pageUrl = (value, schemes = []) => web(value) || (typeof value === 'string' && value.length <= 2000 && !/[\s\x00-\x1f\x7f]/.test(value)
  && schemeOf(value) !== undefined && !NEVER_SCHEMES.has(schemeOf(value)) && schemes.includes(schemeOf(value)) && value.length > schemeOf(value).length + 1);
// A button argument may be a plain label or {label, choices: [...]}: the server then accepts only those values (M5).
// choices may also name a list P9 fills itself: "plans" is every plan.md under the scripts root (workspace-hub's list).
const NAMED_CHOICES = new Set(['plans']);
const argSpec = (arg) => typeof arg === 'string' || (arg && typeof arg === 'object' && typeof arg.label === 'string'
  && optional(arg, 'choices', (choices) => NAMED_CHOICES.has(choices) || (Array.isArray(choices) && choices.length >= 1 && choices.length <= 50
    && choices.every((choice) => typeof choice === 'string' && choice && choice.length <= 200))));

const text = (value) => typeof value === 'string';
const flag = (value) => typeof value === 'boolean';
const id = { type: 'string', required: true, check: (value) => typeof value === 'string' && ID.test(value),
  doc: 'Lowercase letters, digits and dashes, starting with a letter or digit, at most 64 characters. Unique: a duplicated ID drops every record that has it.' };
// A tile icon: an emoji or a few letters, never a link or a file path (no / \\ :), so nothing is fetched or opened for it.
const icon = { type: 'string', check: (value) => typeof value === 'string' && /^[^\s\x00-\x1f\x7f/\\:]{1,16}$/u.test(value),
  doc: 'The tile icon: an emoji, or up to 16 characters of text with no spaces. Never a link or a file path (no / \\ or :). Omit it for the lettered default.' };
// A tile picture: the name P9 gave a file it stored in the icons folder beside the registry (a hash and an extension), never a path.
export const PICTURE = /^[0-9a-f]{16}\.(png|jpg|webp|ico|svg)$/;
const picture = { type: 'string', check: (value) => typeof value === 'string' && PICTURE.test(value),
  doc: 'The tile picture, set by the Mission edit form: the name of a file P9 stored in the icons folder beside the registry. Never a path or a link.' };
const relative = (doc) => ({ type: 'string', check: relativePath, doc: doc + ' A relative path with / separators and no empty, . or .. parts.' });

// A registry script or app, and a space section's button (which runs like a registry script).
export const RECORD = {
  id,
  title: { type: 'string', required: true, check: text, doc: 'The button label.' },
  icon,
  picture,
  cmd: { type: 'array', items: 'string', required: true, check: (value) => strings(value) && value.length > 0,
    doc: 'The program and its fixed arguments, run without a shell. At least one non-empty string. ~ and ~/workspace expand (to the home folder and settings.scripts_root).' },
  args: { type: 'array', check: (value) => Array.isArray(value) && value.length <= 4 && value.every(argSpec),
    doc: 'Up to 4 arguments the user gives when running it, each a label string, or {label, choices}: 1 to 50 non-empty strings of at most 200 characters, or "plans" for every plan.md under the scripts root; only those are accepted. They go after cmd, before tail.' },
  tail: { type: 'array', items: 'string', check: strings, doc: 'Fixed arguments after the typed ones. Non-empty strings.' },
  cwd: relative('Where it runs, under settings.scripts_root (default: the workspace).'),
  url: { type: 'string', check: web, doc: 'Apps: an http(s) link opened after launch.' },
  terminal: { type: 'boolean', check: flag, doc: 'Run in a new terminal window instead of capturing output.' },
  confirm: { type: 'boolean', check: flag, doc: 'Ask the user before every run.' },
  print_url: { type: 'boolean', check: flag, doc: 'Apps: run up to 30 s and open the last line it prints if it is an http(s) link.' },
  detach: { type: 'boolean', check: flag, doc: 'Scripts: let what it starts outlive the run.' },
  url_delay: { type: 'integer', check: (value) => Number.isSafeInteger(value) && value >= 0 && value <= 30000, doc: 'Apps: milliseconds to wait before opening url, 0 to 30000.' },
  desc: { type: 'string', check: text, doc: 'One line shown under the title.' },
  group: { type: 'string', check: text, doc: 'The heading it is listed under. A space button takes its section title instead.' },
  where: { type: 'string', check: text, doc: 'Which machine it runs on, shown to the user.' },
};
export const PAGE = {
  id,
  title: { type: 'string', required: true, check: text, doc: 'The link label.' },
  icon,
  picture,
  url: { type: 'string', required: true, check: pageUrl,
    doc: 'An http(s) link, or a link whose scheme is listed in settings.page_schemes (never javascript, file, data, vbscript or blob). A non-http(s) link asks the user before it opens.' },
};
export const LOG = {
  id,
  title: { type: 'string', required: true, check: text, doc: 'The log view label.' },
  path: { ...relative('The workspace file whose last 200 lines it shows.'), required: true },
};
// A folder list (threat model row M2-a): file names and times only, read through packages/files, never written.
export const FOLDER = {
  id,
  title: { type: 'string', required: true, check: text, doc: 'The list label.' },
  root: { type: 'string', check: (value) => typeof value === 'string' && ID.test(value),
    doc: 'A key of settings.notes_roots: the folder is in that root. Without it, the folder is in the workspace. Never a path.' },
  path: relative('The folder inside the root or the workspace. Without it, the root itself.'),
  pattern: { type: 'string', check: (value) => typeof value === 'string' && /^[^/\\\0]{1,120}$/.test(value),
    doc: 'File names to list: * is any run of characters, ? is one character, e.g. *.md. Default *. Names starting with a dot are never listed.' },
  recursive: { type: 'boolean', check: (value) => typeof value === 'boolean', doc: 'Look in subfolders too, 8 deep. Default false.' },
  match: { type: 'string', check: (value) => typeof value === 'string' && Boolean(value.trim()) && value.length <= 200 && !/[\r\n\0]/.test(value),
    doc: 'Only files holding a line that is exactly this text (spaces at either end ignored); the newest 200 files are checked.' },
};
// A data tile (M3, threat model row 70): a registry script or space button, by ID, that P9 runs on its own and draws.
export const DATA_LIMITS = { everyMs: 30_000, timeoutMs: 10_000, bytes: 64 * 1024 };
export const DATA = {
  id,
  title: { type: 'string', required: true, check: text, doc: 'The tile label.' },
  script: { type: 'string', required: true, check: (value) => typeof value === 'string' && ID.test(value),
    doc: 'The ID of a registry script or space button with no args, confirm, terminal or detach. It runs only after the user answers Allow on the tile, '
      + 'only while Mission shows the tile, at most every 30 s, stopped at 10 s, 64 KiB of output read. It prints one JSON object: '
      + '{"type":"stat","value":12,"label":"Inbox","unit":"notes"}, {"type":"list","rows":[{"title":"Note","subtitle":"2 h ago","link":"https://example.com","badge":"new"}]}, '
      + '{"type":"table","columns":["Name","State"],"rows":[["web","up"]]} or {"type":"rings","rings":[{"label":"Disk","percent":42}]}. Anything else shows what it printed.' },
};
// A plain web link (M3): http and https only, so javascript:, file: and data: never open from a section.
export const WEBLINK = {
  id,
  title: { type: 'string', required: true, check: text, doc: 'The link label.' },
  url: { type: 'string', required: true, check: (value) => web(value) && value.length <= 2000, doc: 'An http:// or https:// address. Nothing else is accepted.' },
};
// What a data tile's script printed, checked against the four shapes: null when it fits, else what is wrong in plain words.
const cell = (value) => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
const listOf = (value, max, check) => Array.isArray(value) && value.length <= max && value.every(check);
const object = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
export function dataShape(value) {
  if (!object(value)) return 'printed JSON that is not an object';
  if (value.type === 'stat') return cell(value.value) && optional(value, 'label', text) && optional(value, 'unit', text) ? null
    : 'printed a stat without a value (a number or text), or with a label or unit that is not text';
  if (value.type === 'list') return listOf(value.rows, 200, (row) => object(row) && text(row.title) && optional(row, 'subtitle', text) && optional(row, 'badge', cell)
    && optional(row, 'link', web)) ? null : 'printed a list whose rows are not each a title with an optional subtitle, badge and http(s) link (200 at most)';
  if (value.type === 'table') return listOf(value.columns, 20, text) && listOf(value.rows, 200, (row) => listOf(row, 20, cell)) ? null
    : 'printed a table without columns (text) and rows (lists of text or numbers)';
  if (value.type === 'rings') return listOf(value.rings, 12, (ring) => object(ring) && text(ring.label) && typeof ring.percent === 'number' && ring.percent >= 0 && ring.percent <= 100)
    ? null : 'printed rings that are not each a label with a percent from 0 to 100 (12 at most)';
  return 'printed JSON whose type is not stat, list, table or rings';
}
// A section's items: each array or key below with an example is one item type. describe_mission shows every one, so a
// new item type is a field here with doc and example, nothing else (M2 adds its own the same way).
export const SECTION = {
  id: { type: 'string', check: (value) => typeof value === 'string' && ID.test(value),
    doc: 'The section\'s id: lowercase letters, digits and dashes, unique among sections. Optional: P9 makes one from the title.' },
  title: { type: 'string', required: true, check: (value) => typeof value === 'string' && Boolean(value.trim()), doc: 'The section heading. Not blank.' },
  icon,
  picture,
  text: { type: 'string', check: text, doc: 'A paragraph shown under the heading.' },
  buttons: { type: 'array', check: Array.isArray, fields: RECORD, doc: 'Buttons, each a script record. They share the registry scripts\' IDs: an ID used in both drops both.',
    example: [{ id: 'disk-free', title: 'Disk free', icon: '💾', cmd: ['df', '-h'] }, { id: 'greet', title: 'Greet', cmd: ['echo', 'hello'], args: ['Name'] }] },
  logs: { type: 'array', check: Array.isArray, fields: LOG, doc: 'Log views, each the last 200 lines of one workspace file.',
    example: [{ id: 'backup-log', title: 'Backup log', path: 'logs/backup.log' }] },
  notes: { type: 'string', check: (value) => typeof value === 'string' && ID.test(value),
    doc: 'A key of settings.notes_roots: the section shows that folder\'s .md notes (threat model row 34). Never a path.', example: 'vault' },
  folders: { type: 'array', check: Array.isArray, fields: FOLDER, doc: 'Folder lists: files in a folder, newest first, with a count. Each opens read-only. A folder outside the workspace needs a notes_roots key (allow_folder asks the user).',
    example: [{ id: 'open-handoffs', title: 'Open handoffs', path: 'projects', pattern: 'HANDOFF.md', recursive: true, match: 'Status: open' }] },
  refs: { type: 'array', items: 'string', check: (value) => Array.isArray(value) && value.length <= 64 && value.every((item) => typeof item === 'string' && ID.test(item)),
    doc: 'IDs of registry scripts, apps or pages (or space buttons) shown in this section too, at most 64. An ID nothing has shows "not found".', example: ['disk-free', 'dashboard'] },
  data: { type: 'array', check: Array.isArray, fields: DATA, doc: 'Data tiles: a script\'s JSON drawn as a number, list, table or rings (threat model row 70).',
    example: [{ id: 'inbox-count', title: 'Inbox', script: 'count-inbox' }] },
  links: { type: 'array', check: Array.isArray, fields: WEBLINK, doc: 'Web links, http and https only.',
    example: [{ id: 'docs', title: 'Docs', url: 'https://example.com/docs' }] },
};
// The file P9 makes for the space when settings names none, next to settings.json (threat model row 69).
export const SPACE_FILE = 'mission-space.json';
export const SETTINGS = {
  primary: { ...relative('The workspace file naming the main project ("**Main project: Name** (`folder/`").'), required: true },
  registry: { ...relative('The registry JSON file (scripts, apps, pages).'), required: true },
  waiting: { ...relative('The folder of needs-you .md items.'), required: true },
  scripts_root: { type: 'string', check: (value) => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0'),
    doc: 'An absolute folder where registry commands run and ~/workspace expands to. Default: the workspace.' },
  hub: relative('The workspace-hub folder.'),
  space: { type: 'string', check: (value) => relativePath(value) || (typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0') && path.basename(value) === SPACE_FILE),
    doc: 'The space JSON file (free-form sections with buttons and log views): a relative workspace path, or the absolute path of a file named ' + SPACE_FILE + ' (P9 makes one beside settings.json on the first space write). A relative workspace path has / separators and no empty, . or .. parts.' },
  page_schemes: { type: 'array', items: 'string', check: (value) => Array.isArray(value) && value.length >= 1 && value.length <= 16 && value.every((scheme) => typeof scheme === 'string' && SCHEME.test(scheme)),
    doc: 'Extra link schemes pages may use (e.g. obsidian), 1 to 16 lowercase schemes of 2 to 32 characters. javascript, file, data, vbscript and blob never open.' },
  server_host: { type: 'string', check: (value) => typeof value === 'string' && /^[\w.-]{1,64}$/.test(value), doc: 'The server\'s host name, letters, digits, _ . and -, at most 64.' },
  notes_roots: { type: 'object', check: (value) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length >= 1
    && Object.keys(value).length <= 16 && Object.entries(value).every(([name, folder]) => ID.test(name) && typeof folder === 'string' && path.isAbsolute(folder) && !folder.includes('\0')),
    doc: 'Notes folders a space section may show, by name (threat model row 34): 1 to 16 entries, each an ID mapped to an absolute folder, e.g. {"vault": "/srv/notes/Vault"}. A folder holding the workspace, the home folder or P9\'s recovery folder is refused.' },
};

// The first thing wrong with a record, in words, or undefined when the table accepts it. closed: unknown keys are wrong too.
// schemes: settings.page_schemes, for a page's url.
export function problem(record, fields, closed = false, schemes) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return 'must be a JSON object';
  for (const [key, field] of Object.entries(fields)) {
    if (!(key in record)) { if (field.required) return key + ' is required'; continue; }
    if (!field.check(record[key], schemes)) return key + ': ' + field.doc;
  }
  if (closed) return unknownFields(record, fields, 'this record')[0];
}

// Every field of record that fields does not know, in words, with the nearest known name when one is close (a typo).
export function unknownFields(record, fields, what) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return [];
  return Object.keys(record).filter((key) => !Object.hasOwn(fields, key)).map((key) => {
    const near = Object.keys(fields).map((name) => [name, distance(key.toLowerCase(), name)]).sort((a, b) => a[1] - b[1])[0];
    const guess = near && near[1] <= Math.max(2, Math.floor(key.length / 2)) ? ' Did you mean ' + near[0] + '?' : '';
    return key + ' is not a field of ' + what + '.' + guess + ' Known fields: ' + Object.keys(fields).join(', ') + '.';
  });
}
// Edit distance, for "did you mean".
function distance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}
// A section id from its title, unique against taken (a Set, which it joins): "Home lab!" -> home-lab, then home-lab-2.
export function sectionId(title, taken) {
  const base = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56).replace(/-+$/, '') || 'section';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = base + '-' + n;
  taken.add(id);
  return id;
}

export function jsonSchema(fields, extra = {}, closed = false) {
  const properties = Object.fromEntries(Object.entries(fields).map(([key, { type, items, doc }]) => [key,
    { type, ...(items ? { items: { type: items } } : {}), description: doc, ...extra[key] }]));
  return { type: 'object', required: Object.keys(fields).filter((key) => fields[key].required), properties, additionalProperties: !closed };
}

const list = (items, description) => ({ type: 'array', items, description });
// The space templates. M1 ships the blank one; more come as files shipped with the app (M4).
export const TEMPLATES = [{ name: 'blank', about: 'An empty space to build up section by section.', space: { sections: [] } }];
export const SCHEMAS = {
  settings: { description: 'P9 settings.json. Unknown fields make the whole file invalid (Mission Control then answers settings-invalid).', ...jsonSchema(SETTINGS, {}, true) },
  registry: { type: 'object', description: 'The registry. Each list is optional; a malformed record or a duplicated ID is dropped and listed as invalid, never run.',
    properties: { scripts: list(jsonSchema(RECORD), 'Buttons whose output Mission Control shows.'), apps: list(jsonSchema(RECORD), 'Programs launched and left running.'),
      pages: list(jsonSchema(PAGE), 'Links.') } },
  space: { type: 'object', required: ['sections'], additionalProperties: false, description: 'The space: free-form sections. A malformed section, button or log view, '
    + 'and a section repeating an earlier one\'s title or id, is dropped and listed as invalid. An unknown field is listed as invalid by name.',
    properties: { sections: list(jsonSchema(SECTION, { buttons: { items: jsonSchema(RECORD, {}, true) }, logs: { items: jsonSchema(LOG, {}, true) }, folders: { items: jsonSchema(FOLDER, {}, true) },
      data: { items: jsonSchema(DATA, {}, true) }, links: { items: jsonSchema(WEBLINK, {}, true) } }, true), 'Sections in order.') } },
};

// describe_mission's answer (threat model row 68): constants only, never the user's files, so it is safe for any chat.
export function describeMission() {
  const items = Object.entries(SECTION).filter(([, field]) => field.example !== undefined).map(([key, field]) => ({
    item: key, about: field.doc, ...(field.fields ? { fields: jsonSchema(field.fields).properties } : {}),
    example: { id: 'example-' + key, title: 'Example ' + key, [key]: field.example } }));
  return {
    about: 'Mission Control shows the space: one JSON file of sections in order. Each section has a title, optional text and icon, and items of the types below. '
      + 'Build it with add_section, add_button (with section) and the update and remove tools, or write a whole file and check it first with validate_space. '
      + 'Unknown fields and a second section with the same title or id are refused. A button runs only when the user clicks it; a data tile only after the user answers Allow on it.',
    file: { sections: [{ id: 'ops', title: 'Ops', text: 'Server chores.', buttons: SECTION.buttons.example.slice(0, 1), logs: SECTION.logs.example }] },
    items, templates: TEMPLATES, schema: SCHEMAS.space,
  };
}
