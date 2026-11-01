// What Mission Control's files may hold, field by field. mission.mjs's parsers check every record against these tables,
// and the P9 MCP server publishes them as JSON Schema with the docs, so what an agent reads is what the parser accepts.
import path from 'node:path';
import icm from './templates/icm.json' with { type: 'json' };
import obsidian from './templates/obsidian.json' with { type: 'json' };
import homelab from './templates/homelab.json' with { type: 'json' };
import blank from './templates/blank.json' with { type: 'json' };
// A section's parts, in the order they draw when its order field names none; the page and the phone read the same list.
import { PARTS } from '../../packages/protocol/index.mjs';

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
// A space link (threat model row 74): http(s), or another scheme that is not on the never list. Whether it may open is
// settings.page_schemes, checked when it opens: the space is read without the settings.
export const linkUrl = (value) => web(value) || (typeof value === 'string' && value.length <= 2000 && !/[\s\x00-\x1f\x7f]/.test(value)
  && schemeOf(value) !== undefined && !NEVER_SCHEMES.has(schemeOf(value)) && value.length > schemeOf(value).length + 1);
export { NEVER_SCHEMES, schemeOf };
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
  group: { type: 'string', check: text, doc: 'The heading it is listed under. A registry group named like a space section joins that section (the first one with the title). A space button keeps its group but draws in its own section.' },
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
  path: { ...relative('The file whose last 200 lines it shows, inside root or the workspace.'), required: true },
  root: { type: 'string', check: (value) => typeof value === 'string' && ID.test(value),
    doc: 'A key of settings.notes_roots (allow_folder asks the user to add one, e.g. a logs folder in the home folder): path is inside that folder. Without it, the workspace.' },
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
  fix: { type: 'string', check: (value) => typeof value === 'string' && Boolean(value.trim()) && value.length <= 2000,
    doc: 'What a Claude chat should do with an opened file, at most 2000 characters. With it, the file viewer has Fix with Claude: a new Claude chat gets this text, then the file.',
    example: 'This is a doctor incident. Find the cause and fix it, then run doctor.sh --fix to confirm it passes.' },
};
// A checklist (threat model row M4-a): rows like "- [x] text" and a "review: word" line in .md files, each changed one mark or
// one line at a time through the guarded save. The audit's Approve, Park, Deny and Apply, the Wiki inbox's merge or reject.
export const MARK = /^[^\[\]\r\n]{1,32}$/;
const label = (value) => typeof value === 'string' && Boolean(value.trim()) && value.length <= 40 && !/[\r\n]/.test(value);
export const CHECKLIST = {
  id,
  title: { type: 'string', required: true, check: text, doc: 'The checklist label.' },
  root: { type: 'string', check: (value) => typeof value === 'string' && ID.test(value),
    doc: 'A key of settings.notes_roots (allow_folder asks the user, naming these writes): the path is in that root. Without it, in the workspace. Never a path.' },
  path: relative('A .md file; with file, a folder whose subfolders each hold that file. Without it, the root itself.'),
  file: { type: 'string', check: (value) => typeof value === 'string' && /^[^/\\\0.][^/\\\0]{0,119}$/.test(value) && /\.md$/i.test(value),
    doc: 'The .md file each subfolder of path holds, e.g. _decision.md: one entry per subfolder, by name.' },
  newest: { type: 'boolean', check: (value) => typeof value === 'boolean', doc: 'Only the newest dated subfolder: the last by name of those starting YYYY-MM-DD (other folders are skipped). Default false.' },
  heading: { type: 'string', check: (value) => typeof value === 'string' && Boolean(value.trim()) && value.length <= 200 && !/[\r\n]/.test(value),
    doc: 'Only rows under the heading with this text, up to the next heading.' },
  marks: { type: 'object', check: (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length >= 1
    && Object.keys(value).length <= 8 && Object.entries(value).every(([mark, name]) => MARK.test(mark) && label(name)),
    doc: 'The marks a row may take, each mark (what goes between [ and ], 1 to 32 characters, no brackets or line breaks) to its button label, 1 to 8: '
      + '{"x": "Approve", "parked": "Park", " ": "Deny"}. Rows show only when marks are set.' },
  review: { type: 'array', items: 'string', check: (value) => Array.isArray(value) && value.length >= 1 && value.length <= 8 && new Set(value).size === value.length
    && value.every((word) => typeof word === 'string' && /^[\w-]{1,32}$/.test(word)),
    doc: 'The words the file\'s one "review:" line may be set to, 1 to 8, e.g. ["merge", "reject", "pending"].' },
  apply: { type: 'string', check: (value) => typeof value === 'string' && ID.test(value),
    doc: 'A script or space button ID taking one arg: Apply sets "review: pending" to "review: apply", then runs it with the subfolder\'s name. Only from pending.' },
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
      + '{"type":"table","columns":["Name","State"],"rows":[["web","up"]]} or {"type":"rings","rings":[{"label":"Disk","percent":42}]}. Any of them may add "level":"ok", "warn" or "bad": warn or bad draws the tile, '
      + 'its section\'s panel and the section\'s top-row tile amber or red. Anything else shows what it printed.' },
  frame: { type: 'boolean', check: (value) => typeof value === 'boolean', doc: 'false draws the tile without its own box and title (its section\'s already says it); title-bar buttons still show. Default true.' },
};
// A custom card (M5, threat model row M5): a workspace .html file drawn in the chat-artifact frame (no network, no P9,
// no navigation), fed one data script's JSON as data. The script runs under the data tile rules above.
export const CARD_BYTES = 256 * 1024;
export const CARD = {
  id,
  title: { type: 'string', required: true, check: text, doc: 'The card label.' },
  html: { ...relative('The workspace .html file the card draws (256 KiB at most). An agent writes it with its own file tool, which the user approves; Mission tools never write it.'), required: true, check: (value) => relativePath(value) && /\.html$/i.test(value) },
  script: { ...DATA.script, doc: 'The ID of a registry script or space button with no args, confirm, terminal or detach, run under the data tile rules: only after the user answers Allow on the card, '
    + 'only while Mission shows it, at most every 30 s, stopped at 10 s, 64 KiB read. It prints any JSON. The card reads it as window.p9data, and gets a p9data event (event.detail) on each run: '
    + 'both are the parsed JSON value (an object, array, string or number, never the raw text); before the first run window.p9data is undefined. '
    + 'The card is as wide as its section and as tall as its content (60 to 720 px; a page sized to 100vh grows to 720). Its page gets color-scheme light or dark from P9\'s theme, '
    + 'so system colours (Canvas, CanvasText) follow it; P9\'s own theme colours are not passed in. '
    + 'The card runs with no network (no fetch, no images or CSS from the web), no access to P9 and no navigation, like a chat artifact: put styles and scripts inline. '
    + 'This script is not drawn as its own button row.' },
  buttons: { type: 'array', items: 'string', check: (value) => Array.isArray(value) && value.length <= 4 && value.every((item) => typeof item === 'string' && ID.test(item)),
    doc: 'Up to 4 IDs of registry scripts or space buttons, drawn as small buttons in the card\'s title bar instead of as rows. A press opens the button\'s run window, '
    + 'which still asks before a confirm button runs. An ID nothing has shows "not found".', example: ['sprint-start', 'sprint-close'] },
  folder: { type: 'object', check: (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.entries(value).every(([key, item]) => ['root', 'path', 'pattern', 'recursive', 'match', 'fix'].includes(key) && FOLDER[key].check(item)),
    doc: 'Files the card may open in P9\'s text viewer: root, path, pattern, recursive, match and fix as in a folder list, drawn as no row. The card calls '
    + 'p9open(path) from a click (a call with no click is ignored), path as the folder list gives it (from the root or the workspace). A file outside the list does not open.',
    example: { path: 'logs', pattern: '*.log' } },
  frame: { type: 'boolean', check: (value) => typeof value === 'boolean', doc: 'false draws the card without its own box and title (its section\'s already says it); title-bar buttons still show. Default true.' },
};
// A plain web link (M3): http and https only, so javascript:, file: and data: never open from a section.
export const WEBLINK = {
  id,
  title: { type: 'string', required: true, check: text, doc: 'The link label.' },
  url: { type: 'string', required: true, check: linkUrl,
    doc: 'An http:// or https:// address, or a link whose scheme is in settings.page_schemes (e.g. obsidian://open); never javascript, file, data, vbscript or blob. '
      + 'A link that is not http(s) shows the full link and asks before it opens, on the device that asked.' },
  ask: { type: 'string', check: (value) => typeof value === 'string' && Boolean(value.trim()) && value.length <= 40 && !/[\r\n]/.test(value),
    doc: 'Ask for one line of text first (this is its label, e.g. "Note title"). The text is URL-encoded and added to the end of url, which must end in =.' },
};
// What a data tile's script printed, checked against the four shapes: null when it fits, else what is wrong in plain words.
const cell = (value) => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
const listOf = (value, max, check) => Array.isArray(value) && value.length <= max && value.every(check);
const object = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
// Any shape may carry a level: warn or bad draws the tile, and the section holding it, amber or red.
export const LEVELS = ['ok', 'warn', 'bad'];
export function dataShape(value) {
  if (!object(value)) return 'printed JSON that is not an object';
  if (!optional(value, 'level', (l) => LEVELS.includes(l))) return 'printed a level that is not ok, warn or bad';
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
// The last three are P9's built-in tiles (W-D): + New idea, Sprint status, Edit names and icons.
export const WIDGETS = ['waiting', 'usage', 'apps', 'notifications', 'primary', 'idea', 'sprint', 'edit'];
// Where a section draws on the desktop page: a top-row tile that opens its window, or open in one of the three columns.
export const PLACES = ['tile', 'col1', 'col2', 'col3'];
export const SECTION = {
  id: { type: 'string', check: (value) => typeof value === 'string' && ID.test(value),
    doc: 'The section\'s id: lowercase letters, digits and dashes, unique among sections, and the key the tools and the page use (titles may repeat). Optional: P9 makes one from the title and saves it on the first write.' },
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
  // Threat model row 76: a create-only form for one folder; no example, so the build guide's item list leaves it out.
  quick_note: { type: 'object', check: (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => key === 'root' || key === 'path') && typeof value.root === 'string' && ID.test(value.root) && relativePath(value.path),
    doc: 'A Quick note form: {root, path}. Save writes one new .md (title as file name, at most 64 KiB) into that folder of the settings.notes_roots key; an existing name is refused, never replaced.' },
  folders: { type: 'array', check: Array.isArray, fields: FOLDER, doc: 'Folder lists: files in a folder, newest first, with a count. Each opens read-only. A folder outside the workspace needs a notes_roots key (allow_folder asks the user).',
    example: [{ id: 'open-handoffs', title: 'Open handoffs', path: 'projects', pattern: 'HANDOFF.md', recursive: true, match: 'Status: open' }] },
  refs: { type: 'array', items: 'string', check: (value) => Array.isArray(value) && value.length <= 64 && value.every((item) => typeof item === 'string' && ID.test(item)),
    doc: 'IDs of registry scripts, apps or pages (or space buttons) shown in this section too, at most 64. An ID nothing has shows "not found".', example: ['disk-free', 'dashboard'] },
  data: { type: 'array', check: Array.isArray, fields: DATA, doc: 'Data tiles: a script\'s JSON drawn as a number, list, table or rings (threat model row 70).',
    example: [{ id: 'inbox-count', title: 'Inbox', script: 'count-inbox' }] },
  cards: { type: 'array', check: Array.isArray, fields: CARD, doc: 'Custom cards: your own HTML file, drawn in a sandbox with no network, showing one script\'s JSON (threat model row M5). Write the .html file first, then add the card here.',
    example: [{ id: 'inbox-card', title: 'Inbox', html: 'cards/inbox.html', script: 'count-inbox' }] },
  checklists: { type: 'array', check: Array.isArray, fields: CHECKLIST, doc: 'Checklists: the user sets each row\'s mark, or the file\'s review line, one at a time (threat model row M4-a). Each needs a .md path or a file.',
    example: [{ id: 'wiki-audit', title: 'Weekly Wiki audit', root: 'audit', path: 'runs', file: '_decision.md', newest: true, heading: 'Proposed register changes',
      marks: { x: 'Approve', parked: 'Park', ' ': 'Deny' }, apply: 'audit-apply' }] },
  links: { type: 'array', check: Array.isArray, fields: WEBLINK, doc: 'Web links, http and https only.',
    example: [{ id: 'docs', title: 'Docs', url: 'https://example.com/docs' }] },
  // Fresh-install finding 3a (threat model row 72): P9's built-in panels draw on a space only where a section names them.
  widget: { type: 'string', check: (value) => WIDGETS.includes(value),
    doc: 'One of P9\'s built-in panels, drawn as this section: ' + 'waiting (Waiting on you), usage (Usage), apps (Apps and pages) or notifications (Notifications)'
      + ' or primary (the Main project card). Without a space the first four show; on a space only the ones a section names. Or one of P9\'s built-in tiles, '
      + 'drawn where the section is under its title: idea (+ New idea), sprint (Sprint status; its window runs this section\'s buttons and script refs, '
      + 'or sprint-start, sprint-close and sprint-heavy when it has none) or edit (Edit names and icons). While no section names a built-in tile, all three '
      + 'show at the end of the top row; once one does, only the named ones show.', example: 'waiting' },
  widgets: { type: 'array', items: 'string', check: (value) => Array.isArray(value) && value.length <= WIDGETS.length && value.every((item) => WIDGETS.includes(item)),
    doc: 'Built-in panels drawn inside this section, after its other parts unless order says otherwise; unlike widget, the section keeps its title, icon, text and buttons. Any of ' + WIDGETS.join(', ')
      + ' (idea, sprint and edit draw their tile\'s button). A panel named here shows as if a section named it in widget. The phone leaves them out.', example: ['notifications'] },
  order: { type: 'array', items: 'string', check: (value) => Array.isArray(value) && value.length <= 32 && value.every((item) => typeof item === 'string'),
    doc: 'The order the section\'s parts draw in, by field name, any of: ' + PARTS.join(', ') + ' (buttons are its button rows, widgets its panels). Parts left out follow '
      + 'the named ones in their usual order, the order of that list; an unknown name is ignored. At most 32. The phone keeps it too.', example: ['cards', 'checklists', 'folders', 'buttons'] },
  place: { type: 'string', check: (value) => PLACES.includes(value),
    doc: 'Where the section draws on the desktop Mission page: tile (the default) is a tile in the top row that opens the section\'s window; col1, col2 or col3 draws it open in that column, '
      + 'its items shown in place (a widget section draws its panel there), in file order. Once any section has a column, the three columns hold only the sections placed in them. The phone ignores it.', example: 'col2' },
};
// The file P9 makes for the space when settings names none, next to settings.json (threat model row 69).
export const SPACE_FILE = 'mission-space.json';
// A scratch space's name (threat model row 71) becomes <settings folder>/spaces/<name>.json, so it is checked before any
// path is built: 1 to 32 of a-z 0-9 -, starting with a letter or digit, and never a Windows device name.
export const SPACES_DIR = 'spaces';
export const spaceName = (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(value) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(value);
export const SPACE_NAME_RULE = 'a scratch space name: 1 to 32 of a-z 0-9 -, starting with a letter or digit';
export const SETTINGS = {
  // Fresh-install finding 1: all three are optional; a new Mission starts empty and is built from its onboarding card.
  primary: relative('The main project: its folder, or a workspace file naming it ("**Main project: Name** (`folder/`"). Optional.'),
  registry: relative('The registry JSON file (scripts, apps, pages). Optional: without it Mission has no registry buttons, apps or pages.'),
  waiting: relative('The folder of needs-you .md items. Optional: without it the Waiting on you list is empty.'),
  scripts_root: { type: 'string', check: (value) => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0'),
    doc: 'An absolute folder where registry commands run and ~/workspace expands to. Default: the workspace.' },
  // Read by the old built-in hub, gone since 0.1.6; still accepted so a settings file that names it keeps loading.
  hub: relative('Ignored: the workspace-hub folder the old built-in hub read.'),
  space: { type: 'string', check: (value) => relativePath(value) || (typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0') && path.basename(value) === SPACE_FILE),
    doc: 'The space JSON file (free-form sections with buttons and log views): a relative workspace path, or the absolute path of a file named ' + SPACE_FILE + ' (P9 makes one beside settings.json on the first space write). A relative workspace path has / separators and no empty, . or .. parts.' },
  space_name: { type: 'string', check: spaceName,
    doc: 'The scratch space Mission shows instead of the main space, set by the space picker: ' + SPACE_NAME_RULE + '. Absent: the main space.' },
  page_schemes: { type: 'array', items: 'string', check: (value) => Array.isArray(value) && value.length >= 1 && value.length <= 16 && value.every((scheme) => typeof scheme === 'string' && SCHEME.test(scheme)),
    doc: 'Extra link schemes pages may use (e.g. obsidian), 1 to 16 lowercase schemes of 2 to 32 characters. javascript, file, data, vbscript and blob never open.' },
  server_host: { type: 'string', check: (value) => typeof value === 'string' && /^[\w.-]{1,64}$/.test(value), doc: 'Ignored: the server\'s host name the old built-in hub read, letters, digits, _ . and -, at most 64.' },
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
// The fields of record that fields does not know, kept as they are (W-F): an older or newer file's extra keys survive a read.
export const extras = (record, fields) => Object.fromEntries(Object.entries(record ?? {}).filter(([key]) => !Object.hasOwn(fields, key)));
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
// The space templates (M4, threat model row 72): files shipped with the app, sections with text and https links only.
export const TEMPLATES = Object.entries({ icm, obsidian, homelab, blank }).map(([name, template]) => ({ name, ...template }));
export const SCHEMAS = {
  settings: { description: 'P9 settings.json. Unknown fields make the whole file invalid (Mission Control then answers settings-invalid).', ...jsonSchema(SETTINGS, {}, true) },
  registry: { type: 'object', description: 'The registry. Each list is optional; a malformed record or a duplicated ID is dropped and listed as invalid, never run.',
    properties: { scripts: list(jsonSchema(RECORD), 'Buttons whose output Mission Control shows.'), apps: list(jsonSchema(RECORD), 'Programs launched and left running.'),
      pages: list(jsonSchema(PAGE), 'Links.') } },
  space: { type: 'object', required: ['sections'], additionalProperties: false, description: 'The space: free-form sections. A malformed section, button or log view, '
    + 'and a section repeating an earlier one\'s id, is dropped (titles may repeat) and listed as invalid. An unknown field of a section or an item is listed by name and kept as it is.',
    properties: { sections: list(jsonSchema(SECTION, { buttons: { items: jsonSchema(RECORD) }, logs: { items: jsonSchema(LOG) }, folders: { items: jsonSchema(FOLDER) },
      data: { items: jsonSchema(DATA) }, cards: { items: jsonSchema(CARD) }, links: { items: jsonSchema(WEBLINK) }, checklists: { items: jsonSchema(CHECKLIST) },
      widgets: { items: { type: 'string', enum: WIDGETS } } }), 'Sections in order.') } },
};

// describe_mission's answer (threat model row 68): constants only, never the user's files, so it is safe for any chat.
export function describeMission() {
  const items = Object.entries(SECTION).filter(([key, field]) => field.example !== undefined && key !== 'widget' && key !== 'place' && key !== 'order' && key !== 'widgets').map(([key, field]) => ({
    item: key, about: field.doc, ...(field.fields ? { fields: jsonSchema(field.fields).properties } : {}),
    example: { id: 'example-' + key, title: 'Example ' + key, [key]: field.example } }));
  return {
    about: 'Mission Control shows the space: one JSON file of sections in order. Each section has a title, optional text and icon, and items of the types below. '
      + 'A section\'s order field sets the order its parts draw in, and its widgets field draws P9\'s own panels inside it. Build it with add_section, add_button (with section) and the update and remove tools, or write a whole file and check it first with validate_space. '
      + 'patch_section, patch_item, move_section and move_button set any field and reorder. A section is named by its id (or by its title while only one section has it); '
      + 'a second section with the same id is refused, titles may repeat. An unknown field is named by validate_space but kept, never dropped. A button runs only when the user clicks it; a data tile only after the user answers Allow on it.',
    file: { sections: [{ id: 'ops', title: 'Ops', text: 'Server chores.', place: SECTION.place.example, buttons: SECTION.buttons.example.slice(0, 1), logs: SECTION.logs.example }] },
    items, templates: TEMPLATES, schema: SCHEMAS.space,
  };
}
