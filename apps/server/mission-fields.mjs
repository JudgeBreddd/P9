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
export const SECTION = {
  title: { type: 'string', required: true, check: (value) => typeof value === 'string' && Boolean(value.trim()), doc: 'The section heading. Not blank.' },
  icon,
  picture,
  text: { type: 'string', check: text, doc: 'A paragraph shown under the heading.' },
  buttons: { type: 'array', check: Array.isArray, doc: 'Buttons, each a script record. They share the registry scripts\' IDs: an ID used in both drops both.' },
  logs: { type: 'array', check: Array.isArray, doc: 'Log views.' },
  notes: { type: 'string', check: (value) => typeof value === 'string' && ID.test(value),
    doc: 'A key of settings.notes_roots: the section shows that folder\'s .md notes (threat model row 34). Never a path.' },
};
export const SETTINGS = {
  primary: { ...relative('The workspace file naming the main project ("**Main project: Name** (`folder/`").'), required: true },
  registry: { ...relative('The registry JSON file (scripts, apps, pages).'), required: true },
  waiting: { ...relative('The folder of needs-you .md items.'), required: true },
  scripts_root: { type: 'string', check: (value) => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0'),
    doc: 'An absolute folder where registry commands run and ~/workspace expands to. Default: the workspace.' },
  hub: relative('The workspace-hub folder.'),
  space: relative('The space JSON file (free-form sections with buttons and log views).'),
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
  if (closed) for (const key of Object.keys(record)) if (!Object.hasOwn(fields, key)) return 'unknown field ' + key;
}

export function jsonSchema(fields, extra = {}, closed = false) {
  const properties = Object.fromEntries(Object.entries(fields).map(([key, { type, items, doc }]) => [key,
    { type, ...(items ? { items: { type: items } } : {}), description: doc, ...extra[key] }]));
  return { type: 'object', required: Object.keys(fields).filter((key) => fields[key].required), properties, additionalProperties: !closed };
}

const list = (items, description) => ({ type: 'array', items, description });
export const SCHEMAS = {
  settings: { description: 'P9 settings.json. Unknown fields make the whole file invalid (Mission Control then answers settings-invalid).', ...jsonSchema(SETTINGS, {}, true) },
  registry: { type: 'object', description: 'The registry. Each list is optional; a malformed record or a duplicated ID is dropped and listed as invalid, never run.',
    properties: { scripts: list(jsonSchema(RECORD), 'Buttons whose output Mission Control shows.'), apps: list(jsonSchema(RECORD), 'Programs launched and left running.'),
      pages: list(jsonSchema(PAGE), 'Links.') } },
  space: { type: 'object', required: ['sections'], description: 'The space: free-form sections. A malformed section, button or log view is dropped and listed as invalid.',
    properties: { sections: list(jsonSchema(SECTION, { buttons: { items: jsonSchema(RECORD) }, logs: { items: jsonSchema(LOG) } }), 'Sections in order.') } },
};
