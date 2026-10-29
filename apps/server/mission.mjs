// Mission Control: workspace-hub's registry, waiting queue and main project card, read through packages/files.
// Scripts run only by registry ID as a fixed argv (spawn without a shell); the client never supplies command text.
import { spawn } from 'node:child_process';
import { childEnv } from './child-env.mjs';
import { stillAuthorized, captureAuthority } from './authority.mjs';
import { randomUUID, createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { realpath, readdir as fsReaddir, readFile as fsReadFile, writeFile as fsWriteFile, rename as fsRename } from 'node:fs/promises';
import { readFile, listDirectory, guardedSave, createFile, renameFile, HEAVY } from '../../packages/files/index.mjs';
import { launchTree, endTree, stopScopes, windowsArgv, windowsJobCommand } from './process-tree.mjs';
import { ID, web, problem, unknownFields, sectionId, dataShape, RECORD, PAGE, SECTION, LOG, FOLDER, CHECKLIST, MARK, DATA, CARD, CARD_BYTES, WEBLINK, DATA_LIMITS, SETTINGS, spaceName, NEVER_SCHEMES, schemeOf } from './mission-fields.mjs';

const windows = process.platform === 'win32';
const system32 = (file) => path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', file);

const ITEM = /^[\w.-]{1,120}\.md$/;
// The answer line: empty "A.", or "A:" holding only an _italic placeholder_ (some live _tyler items use that form).
const EMPTY_ANSWER = /^A[.:][ \t]*(?:_[^_\n]*_[ \t]*)?$/m;
// Every argument: no control characters (a NUL ends the C string the program gets).
const CONTROL = /[\x00-\x1f\x7f]/;
// Only a batch file (cmd.exe parses its line again) or ssh (its remote shell parses the command) can read these as syntax;
// any other target gets the argument as one plain argv entry (spawn has no shell).
const STRICT = /[;&|`$<>\\]/;
const STRICT_MAX = 1000;
// ponytail: 8,000 is under cmd.exe's 8,191-character line and far under Linux's 128 KiB per argument; a longer total
// command line is refused by the OS and shows as "could not start", so no total is counted here.
const ARG_MAX = 8000;
// ssh joins its remote command with spaces and the remote shell splits and globs it: an ssh button takes one plain word.
const SSH_WORD = /^[\w.@%+=:,/-]+$/;
const RUN_LIMIT_MS = 15 * 60 * 1000;
const PRINT_URL_MS = 30000;
const OUTPUT_LIMIT = 1024 * 1024;
const MAX_RUNNING = 4;

// Windows editors save UTF-8 with a leading U+FEFF, which JSON.parse refuses; one is dropped (M1). Settings, registry and space all read through here.
export const stripBom = (text) => (text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);

export function parseSettings(text) {
  const settings = JSON.parse(stripBom(text));
  // detail: what is wrong, for the P9 MCP server's validate; the error message stays the code callers match.
  const detail = problem(settings, SETTINGS, true);
  if (detail) throw Object.assign(new Error('invalid-settings'), { detail });
  return Object.freeze(settings);
}

// The field tables (mission-fields.mjs) are the rules; an invalid entry's detail says which one failed.
const recordProblem = (record, kind, schemes) => problem(record, kind === 'pages' ? PAGE : RECORD, false, schemes);

// Folders the plans list never walks into: dependencies, archives, private and template trees (workspace-hub skipped the same).
const PLAN_SKIP = new Set([...HEAVY, '_archive', '_private', '_intake', '_templates', 'templates', 'recommended-delete', 'agent_skills']);

// Malformed records and every record sharing a duplicated ID are dropped and reported, never run.
export function parseRegistry(text, schemes = []) {
  const registry = JSON.parse(stripBom(text));
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) throw new Error('invalid-registry');
  const result = { invalid: [] };
  for (const kind of ['scripts', 'apps', 'pages']) {
    const records = Array.isArray(registry[kind]) ? registry[kind] : [];
    const counts = new Map();
    for (const record of records) if (typeof record?.id === 'string') counts.set(record.id, (counts.get(record.id) ?? 0) + 1);
    result[kind] = [];
    records.forEach((record, index) => {
      const detail = recordProblem(record, kind, schemes);
      if (detail) result.invalid.push({ kind, index, reason: 'malformed-record', detail });
      else if (counts.get(record.id) > 1) result.invalid.push({ kind, index, id: record.id, reason: 'duplicate-id' });
      else result[kind].push(record);
    });
  }
  return result;
}

// Checklist lines (threat model row M4-a). Every write keeps the file's own line breaks: split keeps them as odd pieces.
const BREAKS = /(\r\n|\n|\r)/;
const ROW = /^(\s*[-*] \[)([^\[\]\r\n]{1,32})(\] )(.*)$/;
const REVIEW = /^review:/;
const HEADING = /^#{1,6}\s+(.*?)\s*#*\s*$/;
// A checklist file's review word (null unless exactly one review: line) and its rows, under item.heading when set.
function checklistParse(content, item) {
  const pieces = content.split(BREAKS), reviews = pieces.filter((piece, index) => index % 2 === 0 && REVIEW.test(piece));
  const review = reviews.length === 1 ? reviews[0].slice(7).trim().replace(/^(["'])(.*)\1$/, '$2') : null;
  const rows = [];
  let under = !item.heading;
  for (let line = 0; item.marks && line < pieces.length; line += 2) {
    const heading = pieces[line].match(HEADING);
    if (heading && item.heading) { under = heading[1] === item.heading.trim(); continue; }
    const row = pieces[line].match(ROW);
    if (under && row && MARK.test(row[2])) rows.push({ n: rows.length, mark: row[2], text: row[4], line });
  }
  return { review, rows };
}
// The guard every checklist write passes: the same pieces and line breaks, exactly one line different, and that line
// differing only between [ and ] (kind mark) or after "review: " (kind review).
export function oneLineChange(before, after, kind) {
  const a = before.split(BREAKS), b = after.split(BREAKS);
  if (a.length !== b.length) return false;
  const changed = a.flatMap((piece, index) => (piece === b[index] ? [] : [index]));
  if (changed.length !== 1 || changed[0] % 2) return false;
  const [x, y] = [a[changed[0]], b[changed[0]]];
  if (kind === 'review') return REVIEW.test(x) && y.startsWith('review: ') && /^[\w-]{1,32}$/.test(y.slice(8));
  const m = x.match(ROW), n = y.match(ROW);
  return Boolean(kind === 'mark' && m && n && m[1] === n[1] && m[3] === n[3] && m[4] === n[4]);
}

// The free-form space (settings.space, one JSON file): sections, each with optional text, buttons, log views and notes.
// A button is a registry script record and runs the same way, by ID; a log view shows the end of one workspace file;
// notes names a folder from settings.notes_roots by its key, never by path.
// Strict (M1): an unknown field is listed by name (kept, so an older or newer file still draws), and a section repeating an
// earlier one's title or id is dropped. A section with no id gets one from its title here, in memory only (withIds).
export function parseSpace(text) {
  const space = JSON.parse(stripBom(text));
  if (!space || typeof space !== 'object' || !Array.isArray(space.sections)) throw new Error('invalid-space');
  const result = { sections: [], invalid: [] };
  for (const detail of unknownFields(space, { sections: true }, 'the space')) result.invalid.push({ kind: 'space', reason: 'unknown-field', detail });
  const titles = new Set(), ids = new Set();
  withIds(space.sections).forEach((section, index) => {
    const wrong = problem(section, SECTION);
    if (wrong) return result.invalid.push({ kind: 'space', index, reason: 'malformed-section', detail: wrong });
    const title = section.title.trim(), buttons = [], logs = [], folders = [];
    if (titles.has(title) || ids.has(section.id)) return result.invalid.push({ kind: 'space', index, reason: 'duplicate-section',
      detail: (titles.has(title) ? 'Another section is already titled "' + title + '"' : 'Another section already has the id ' + section.id) + '; titles and ids must be unique. This one is not shown.' });
    titles.add(title); ids.add(section.id);
    for (const detail of unknownFields(section, SECTION, 'a section')) result.invalid.push({ kind: 'space', index, reason: 'unknown-field', detail });
    (section.buttons ?? []).forEach((record, button) => { const detail = recordProblem(record, 'scripts');
      for (const extra of unknownFields(record, RECORD, 'a button')) result.invalid.push({ kind: 'space', index, button, reason: 'unknown-field', detail: extra });
      if (detail) result.invalid.push({ kind: 'space', index, button, reason: 'malformed-record', detail }); else buttons.push({ ...record, group: title }); });
    (section.logs ?? []).forEach((record, log) => { const detail = problem(record, LOG);
      for (const extra of unknownFields(record, LOG, 'a log view')) result.invalid.push({ kind: 'space', index, log, reason: 'unknown-field', detail: extra });
      if (detail) result.invalid.push({ kind: 'space', index, log, reason: 'malformed-record', detail }); else logs.push({ id: record.id, title: record.title, path: record.path }); });
    // Data tiles and links (M3): a bad one is dropped and named, the rest of the section stays.
    const items = { data: [], cards: [], links: [] };
    for (const [key, fields, what] of [['data', DATA, 'a data tile'], ['cards', CARD, 'a card'], ['links', WEBLINK, 'a link']]) {
      (section[key] ?? []).forEach((record, n) => { const detail = problem(record, fields);
        for (const extra of unknownFields(record, fields, what)) result.invalid.push({ kind: 'space', index, [key]: n, reason: 'unknown-field', detail: extra });
        if (detail) result.invalid.push({ kind: 'space', index, [key]: n, reason: 'malformed-record', detail });
        else items[key].push(Object.fromEntries(Object.keys(fields).filter((field) => field in record).map((field) => [field, record[field]]))); });
    }
    (section.folders ?? []).forEach((record, folder) => { const detail = problem(record, FOLDER, true);
      if (detail) result.invalid.push({ kind: 'space', index, folder, reason: 'malformed-record', detail }); else folders.push({ ...record }); });
    const checklists = [];
    (section.checklists ?? []).forEach((record, checklist) => {
      const detail = problem(record, CHECKLIST, true) ?? (record.file || /\.md$/i.test(record.path ?? '') ? undefined : 'path must be a .md file, or file must name the .md file in each subfolder');
      if (detail) result.invalid.push({ kind: 'space', index, checklists: checklist, reason: 'malformed-record', detail }); else checklists.push({ ...record }); });
    result.sections.push({ id: section.id, title, text: section.text ?? '', buttons, logs, folders, refs: section.refs ?? [], ...(checklists.length ? { checklists } : {}), ...(section.widget ? { widget: section.widget } : {}), ...(section.quick_note ? { quick_note: { ...section.quick_note } } : {}), ...(section.icon ? { icon: section.icon } : {}), ...(section.picture ? { picture: section.picture } : {}), ...(items.data.length ? { data: items.data } : {}), ...(items.cards.length ? { cards: items.cards } : {}), ...(items.links.length ? { links: items.links } : {}), ...(section.notes ? { notes: section.notes } : {}) });
  });
  return result;
}

// A file name against a folder list's pattern: * any run, ? one character. Two pointers with one star to fall back to,
// so a crafted pattern costs at most name x pattern steps (a regex of many stars can backtrack far longer).
export function wildcard(pattern, name) {
  let p = 0, n = 0, star = -1, mark = 0;
  while (n < name.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === name[n])) { p++; n++; }
    else if (pattern[p] === '*') { star = p++; mark = n; }
    else if (star >= 0) { p = star + 1; n = ++mark; }
    else return false;
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}

// The sections with an id on each one that has none, made from its title and unique against every id the file already
// has. Copies: the file's own objects are untouched. The MCP write path saves the same ids, so they never change once seen.
export function withIds(sections) {
  const taken = new Set(sections.map((section) => section?.id).filter((id) => typeof id === 'string'));
  return sections.map((section) => (section && typeof section === 'object' && !Array.isArray(section) && section.id === undefined && typeof section.title === 'string'
    ? { id: sectionId(section.title.trim(), taken), ...section } : section));
}

// Where the space file is read and written: a workspace path under the workspace, or the absolute mission-space.json
// (threat model row 69) under its own folder, through the same no-symlink walk.
export const spaceAt = (workspace, file) => (path.isAbsolute(file) ? [path.dirname(file), path.basename(file)] : [workspace, file]);
// A scratch space's file (threat model row 71): drafts is <settings folder>/spaces. The name is checked before the join, and the
// file must sit directly in drafts; read and saved through spaceAt, whose walk refuses a link at the folder or the file. null: refused.
export function draftAt(drafts, name) {
  if (!drafts || !spaceName(name)) return null;
  const file = path.join(drafts, name + '.json');
  return path.dirname(file) === drafts ? file : null;
}
// The scratch spaces there are, by name; a file whose name fails the rule is not one.
export async function draftNames(drafts) {
  if (!drafts) return [];
  try { return (await fsReaddir(drafts, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith('.json') && spaceName(entry.name.slice(0, -5)))
    .map((entry) => entry.name.slice(0, -5)).sort(); }
  catch { return []; }
}

// The registry plus the space: a space button joins the registry's scripts, so run() finds it by ID like any script.
// Exported so the P9 MCP server's validate tools merge exactly as Mission Control does.
export function combine(reg, space) {
  const invalid = [...reg.invalid, ...space.invalid];
  const scripts = unique([...reg.scripts, ...space.sections.flatMap((section) => section.buttons)], 'scripts', invalid);
  const logs = new Set(unique(space.sections.flatMap((section) => [...section.logs, ...(section.data ?? []), ...(section.cards ?? [])]), 'space', invalid));
  const folders = new Set(unique(space.sections.flatMap((section) => [...section.folders, ...(section.checklists ?? [])]), 'space', invalid));
  const sections = space.sections.map((section) => ({ ...section, logs: section.logs.filter((log) => logs.has(log)), folders: section.folders.filter((folder) => folders.has(folder)),
    ...(section.checklists ? { checklists: section.checklists.filter((item) => folders.has(item)) } : {}),
    ...(section.data ? { data: section.data.filter((tile) => logs.has(tile)) } : {}), ...(section.cards ? { cards: section.cards.filter((card) => logs.has(card)) } : {}) }));
  return { ...reg, scripts, invalid, space: sections };
}

// Every record sharing an ID with another is dropped and reported, as parseRegistry does within one kind.
function unique(records, kind, invalid) {
  const counts = new Map();
  for (const record of records) counts.set(record.id, (counts.get(record.id) ?? 0) + 1);
  for (const record of records) if (counts.get(record.id) > 1) invalid.push({ kind, id: record.id, reason: 'duplicate-id' });
  return records.filter((record) => counts.get(record.id) === 1);
}

const age = (ms) => { const minutes = Math.max(0, Math.round((Date.now() - ms) / 60000));
  return minutes < 60 ? `${minutes} min` : minutes < 2880 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} d`; };

// workspace-hub's argv_for: cmd with ~ expanded, then the non-blank arguments, then tail.
export function argvFor(item, args, scriptsRoot) {
  const expand = (value) => {
    const replaced = value.replaceAll('~/workspace', scriptsRoot);
    return replaced === '~' || replaced.startsWith('~/') ? path.join(os.homedir(), replaced.slice(1)) : replaced;
  };
  return [...item.cmd.map(expand), ...args.filter((arg) => arg.trim()), ...(item.tail ?? []).map(expand)];
}

// Why an argument is refused, naming the character, or undefined when it is fine (M5). Control characters and length apply to
// every target; the shell-syntax set only to a batch file or ssh, where something downstream parses it again.
const shown = (char) => (/[\x00-\x1f\x7f]/.test(char) ? 'U+' + char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0') : '"' + char + '"');
export function argRefusal(item, arg, index) {
  const name = 'argument ' + (index + 1);
  if (typeof arg !== 'string') return name + ' is not text';
  // ssh.exe is ssh: Windows registries name it so (release review finding 3).
  const target = item.cmd[0].split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, ''), strict = target === 'ssh' || /\.(cmd|bat)$/.test(target);
  const max = strict ? STRICT_MAX : ARG_MAX;
  if (arg.length > max) return name + ' is ' + arg.length + ' characters; the limit is ' + max;
  const control = arg.match(CONTROL)?.[0];
  if (control) return name + ' contains the control character ' + shown(control);
  const spec = item.args?.[index];
  if (spec?.choices && arg !== '' && !spec.choices.includes(arg)) return name + ' must be one of the listed choices';
  if (strict) {
    const bad = arg.match(STRICT)?.[0];
    if (bad) return name + ' contains ' + shown(bad) + ', which ' + (target === 'ssh' ? 'the remote shell' : 'cmd.exe') + ' would read as syntax';
  }
  if (target === 'ssh' && !SSH_WORD.test(arg)) return name + ' may use only letters, digits and . @ % + = : , / -';
}

export const inside = (parent, child) => { const relative = path.relative(parent, child); return !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)); };
// A folder P9 reaches outside the workspace (notes, threat model row 34; the Dev Focus root, row 41). One that holds the
// workspace, the recovery folder, the home folder or one of `also` (a drive root holds them all), or sits inside recovery or
// `also`, would reach P9's own files, and guardedSave keeps its drafts only outside the folder it saves in.
export async function rootRefused(root, { workspace, recovery, also = [] }) {
  const home = await realpath(os.homedir()).catch(() => os.homedir());
  return [workspace, recovery, home, ...also].some((guarded) => inside(root, guarded)) || [recovery, ...also].some((folder) => inside(folder, root));
}

// allowed: the file holding the user's Allow answers for data tiles (threat model row 70), beside settings.json; none keeps them in memory.
export function createMission({ workspace, recovery, settings, instance = 'test', lifecycle, allowed, drafts }) {
  // The settings file is read again when it changes (M2); setSettings swaps the parsed value, the next request sees it.
  const setSettings = (next) => { settings = next; plansCache.at = 0; };
  const runs = new Map();
  const recovered = stopScopes('p9-run', instance);
  // Registry commands run where the registry's relative paths resolve: the hub's ~/workspace, which can sit above P9's workspace.
  const root = () => settings?.scripts_root ?? workspace;
  // A settings key's file that is not there names itself (server.mjs answers file-not-found), not "storage unavailable".
  // A key left out (all three are optional) reads as `none`: no file is opened.
  const settingFile = (key, read, none) => settings[key] === undefined ? Promise.resolve(none) : read(settings[key]).catch((error) => {
    throw error.code === 'ENOENT' ? Object.assign(new Error('file-not-found'), { setting: key, file: settings[key] }) : error;
  });
  // The "plans" list: every plan.md under the scripts root, as the root-relative paths the button's command takes. Read only
  // when a button names it; links are never followed.
  // ponytail: kept a minute and at most 8 folders deep; a watcher if a large workspace shows it in a profile.
  const plansCache = { at: 0, list: [] };
  async function plans() {
    if (Date.now() - plansCache.at < 60000) return plansCache.list;
    const list = [];
    const walk = async (relative, depth) => {
      for (const entry of await fsReaddir(path.join(root(), relative), { withFileTypes: true }).catch(() => [])) {
        const child = relative ? relative + '/' + entry.name : entry.name;
        if (entry.isFile() && entry.name === 'plan.md') list.push(child);
        else if (entry.isDirectory() && depth < 8 && !entry.name.startsWith('.') && !PLAN_SKIP.has(entry.name)) await walk(child, depth + 1);
      }
    };
    await walk('', 0);
    Object.assign(plansCache, { at: Date.now(), list: list.sort().slice(0, 500) });
    return plansCache.list;
  }
  const named = async (records) => {
    if (!records.some((record) => record.args?.some((arg) => arg?.choices === 'plans'))) return records;
    const list = await plans();
    return records.map((record) => (record.args ? { ...record, args: record.args.map((arg) => (arg?.choices === 'plans' ? { ...arg, choices: list } : arg)) } : record));
  };
  // The registry plus the space: a space button joins the registry's scripts, so run() finds it by ID like any script.
  async function registry() {
    if (!settings) throw new Error('settings-missing');
    const reg = parseRegistry((await settingFile('registry', (file) => readFile(workspace, file), { content: '{}' })).content, settings.page_schemes);
    let space = { sections: [], invalid: [] };
    // The space picker's scratch space (settings.space_name) is shown instead of the main one; the main file is not read then.
    const file = settings.space_name ? draftAt(drafts, settings.space_name) : settings.space;
    if (file || settings.space_name) {
      try { space = parseSpace((await readFile(...spaceAt(workspace, file))).content); }
      catch { space.invalid.push({ kind: 'space', reason: 'unreadable-space' }); }
    }
    const combined = combine(reg, space);
    return { ...combined, scripts: await named(combined.scripts), apps: await named(combined.apps) };
  }
  async function queue() {
    const items = [];
    for (const entry of await settingFile('waiting', (folder) => listDirectory(workspace, folder), [])) {
      if (entry.dir || !entry.name.endsWith('.md') || ['AGENTS.md', 'CLAUDE.md'].includes(entry.name)) continue;
      let file;
      try { file = await readFile(workspace, `${settings.waiting}/${entry.name}`); } catch { continue; }
      if (/^A\.[ \t]*\S/m.test(file.content)) continue; // answered: an agent wires it in and removes the file
      const title = file.content.split('\n').find((line) => line.trim())?.replace(/^#+\s*/, '').trim() || entry.name.slice(0, -3);
      items.push({ name: entry.name, project: entry.name.slice(0, -3), title, age: age(entry.mtimeMs), updated: entry.mtimeMs, hash: file.hash,
        content: file.content, answerable: EMPTY_ANSWER.test(file.content) });
    }
    return items;
  }
  async function primary() {
    if (settings.primary === undefined) return null;
    // A folder (the wizard's pick since fresh-install finding 1) is the main project itself, named by its folder.
    const folder = await listDirectory(workspace, settings.primary).then(() => true, () => false);
    const text = folder ? '' : (await settingFile('primary', (file) => readFile(workspace, file))).content;
    const match = folder ? [, path.posix.basename(settings.primary.replace(/\/$/, ''))] : text.match(/\*\*Main project: ([^*]+)\*\* \(`([^`]+)`/);
    if (!match) return null;
    const directory = folder ? settings.primary.replace(/\/$/, '') : path.posix.join(path.posix.dirname(settings.primary), match[2].replace(/\/$/, ''));
    let status = '';
    try { status = (await readFile(workspace, `${directory}/AGENTS.md`)).content.match(/^\*\*Status:\*\*\s*(.+)$/m)?.[1].trim() ?? ''; }
    catch {}
    return { name: match[1].trim(), path: directory, status: status.slice(0, 240) };
  }
  async function overview() {
    const reg = await registry(), waiting = await queue();
    const strip = ({ id, title, icon, picture, desc = '', group = '', args = [], confirm = false, terminal = false, url = '' }) =>
      ({ id, title, ...(icon ? { icon } : {}), ...(picture ? { picture } : {}), desc, group, args: args.map((arg) => (typeof arg === 'string' ? arg : arg.choices ? { label: arg.label, choices: arg.choices } : arg.label)), confirm, terminal, url });
    // A button a checklist runs as its Apply is not drawn again as its own row; it still runs by ID through the checklist.
    const applies = new Set(reg.space.flatMap((section) => (section.checklists ?? []).map((item) => item.apply).filter(Boolean)));
    return { waiting: settings.waiting, icmFiles: Boolean(settings.registry || settings.waiting), scripts: reg.scripts.filter((script) => !applies.has(script.id)).map(strip), apps: reg.apps.map(strip), pages: reg.pages.map(strip), invalid: reg.invalid.filter((entry) => entry.reason !== 'unknown-field'), // shown and kept: only validate names them
     
      space: reg.space.map(({ id, title, text, logs, notes, icon, picture, folders, refs, data, cards, links, checklists, widget, quick_note }) => ({ id, title, text, ...(widget ? { widget } : {}), ...(quick_note ? { quick_note } : {}), ...(icon ? { icon } : {}), ...(picture ? { picture } : {}), logs: logs.map(({ id, title: name }) => ({ id, title: name })), folders: folders.map(({ id, title: name, root }) => ({ id, title: name, ...(root ? { root } : {}) })), refs: refs.map((id) => reference(reg, id)), ...(notes ? { notes } : {}),
        ...(data ? { data: data.map(({ id, title: name }) => ({ id, title: name })) } : {}), ...(cards ? { cards: cards.map(({ id, title: name }) => ({ id, title: name })) } : {}), ...(links ? { links } : {}),
        ...(checklists ? { checklists: checklists.map(({ id, title: name }) => ({ id, title: name })) } : {}) })),
      queue: waiting, primary: await primary(), spaceName: settings.space_name ?? null, spaces: await draftNames(drafts),
      // A fresh profile (M4): nothing to show, so Mission draws only the onboarding card.
      empty: !settings.space_name && !settings.hub && !reg.space.length && !reg.scripts.length && !reg.apps.length && !reg.pages.length && !waiting.length };
  }
  // A section's reference to a script, app or page by ID (M2): the tile names what it found, or says it is missing.
  function reference(reg, id) {
    for (const kind of ['scripts', 'apps', 'pages']) {
      const found = reg[kind].find((record) => record.id === id);
      if (found) return { id, kind, title: found.title, ...(found.icon ? { icon: found.icon } : {}) };
    }
    return { id, missing: true };
  }
  // ponytail: a log view reads the whole file (packages/files refuses one over MAX_BYTES) and shows the last 200 lines.
  async function spaceLog(id) {
    if (typeof id !== 'string' || !ID.test(id)) return { status: 400, error: 'request-refused' };
    const log = (await registry()).space.flatMap((section) => section.logs).find((record) => record.id === id);
    if (!log) return { status: 404, error: 'unknown-id' };
    try { return { status: 200, text: (await readFile(workspace, log.path)).content.split('\n').slice(-200).join('\n') }; }
    catch { return { status: 404, error: 'not-found' }; }
  }

  // Notes (threat model row 34): a folder named in settings.notes_roots and shown by a space section. Every path is
  // relative to the folder's realpath and goes through packages/files, so links out of it and locked names are refused.
  const refused = { status: 400, error: 'request-refused' };
  const fields = (body, keys) => body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).sort().join(',') === keys;
  // .md only; a name starting with a dot (.obsidian, .trash, .git, .env) is neither listed nor opened.
  const note = (value) => typeof value === 'string' && value.length <= 1024 && /\.md$/i.test(value) && !value.split('/').some((part) => part.startsWith('.'));
  async function notesRoot(name) {
    if (typeof name !== 'string' || !ID.test(name)) return refused;
    if (!(await registry()).space.some((section) => section.notes === name)) return { status: 404, error: 'unknown-root' };
    return namedRoot(name);
  }
  // A settings.notes_roots folder by its key, as its realpath; refused when it holds the workspace, home or recovery folder.
  async function namedRoot(name) {
    const folder = settings.notes_roots && Object.hasOwn(settings.notes_roots, name) ? settings.notes_roots[name] : undefined;
    if (!folder) return { status: 404, error: 'unknown-root' };
    let root;
    try { root = await realpath(folder); } catch { return { status: 404, error: 'root-not-found' }; }
    if (await rootRefused(root, { workspace, recovery })) return { status: 403, error: 'root-refused' };
    return { root };
  }
  // ponytail: a breadth-first walk of at most 2,000 folders, 8 deep; the newest 500 notes are sent, with the total found.
  const NOTES_SHOWN = 500, NOTES_FOLDERS = 2000, NOTES_DEPTH = 8;
  async function notesList(name) {
    const target = await notesRoot(name);
    if (target.error) return target;
    const files = [], folders = [''];
    for (let walked = 0; folders.length && walked < NOTES_FOLDERS; walked++) {
      const folder = folders.shift();
      let entries;
      try { entries = await listDirectory(target.root, folder); } catch (error) { if (!folder) throw error; continue; }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const relative = folder ? `${folder}/${entry.name}` : entry.name;
        if (entry.dir) { if (relative.split('/').length < NOTES_DEPTH) folders.push(relative); }
        else if (note(entry.name)) files.push({ path: relative, modified: entry.mtimeMs });
      }
    }
    files.sort((a, b) => b.modified - a.modified);
    return { status: 200, files: files.slice(0, NOTES_SHOWN), total: files.length, shown: NOTES_SHOWN, partial: folders.length > 0 };
  }
  // Folder lists (threat model row M2-a): a space item names a folder in the workspace or a notes root. The walk is
  // listDirectory's (no links, no locked names) with the notes limits; only names and times are read, plus, for match,
  // the newest FOLDER_MATCHED files through readFile. A file opens only when this walk lists it.
  const FOLDER_MATCHED = 200;
  async function folderFiles(id) {
    if (typeof id !== 'string' || !ID.test(id)) return refused;
    const item = (await registry()).space.flatMap((section) => section.folders).find((folder) => folder.id === id);
    if (!item) return { status: 404, error: 'unknown-id' };
    const target = item.root ? await namedRoot(item.root) : { root: workspace };
    if (target.error) return target;
    const base = item.path ?? '', depth = base ? base.split('/').length : 0, files = [], folders = [base];
    for (let walked = 0; folders.length && walked < NOTES_FOLDERS; walked++) {
      const folder = folders.shift();
      let entries;
      try { entries = await listDirectory(target.root, folder); } catch { if (folder === base) return { status: 404, error: 'not-found' }; continue; }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const relative = folder ? `${folder}/${entry.name}` : entry.name;
        if (entry.dir) { if (item.recursive && relative.split('/').length - depth < NOTES_DEPTH) folders.push(relative); }
        else if (wildcard(item.pattern ?? '*', entry.name)) files.push({ path: relative, name: relative.slice(base ? base.length + 1 : 0), modified: entry.mtimeMs });
      }
    }
    files.sort((a, b) => b.modified - a.modified);
    let found = files, partial = folders.length > 0;
    if (item.match) {
      const line = item.match.trim();
      partial ||= files.length > FOLDER_MATCHED;
      found = [];
      for (const file of files.slice(0, FOLDER_MATCHED)) {
        try { if ((await readFile(target.root, file.path)).content.split('\n').some((text) => text.trim() === line)) found.push(file); } catch {}
      }
    }
    return { status: 200, root: target.root, files: found.slice(0, NOTES_SHOWN), total: found.length, shown: NOTES_SHOWN, partial };
  }
  async function folderList(id) {
    const { root, ...list } = await folderFiles(id);
    return list;
  }
  async function folderRead(id, relative) {
    if (typeof relative !== 'string' || relative.length > 1024) return refused;
    const list = await folderFiles(id);
    if (list.error) return list;
    if (!list.files.some((file) => file.path === relative)) return { status: 404, error: 'not-found' };
    try { return { status: 200, text: (await readFile(list.root, relative)).content }; } catch { return { status: 404, error: 'not-found' }; }
  }
  // Checklists (threat model row M4-a): the files an item names, read through packages/files: in the workspace, or in a
  // notes root the user said yes to (allow_folder, whose question names these writes). A write is one mark or one review
  // line, checked again by oneLineChange, saved only over the hash the client read.
  const CHECK_FILES = 200;
  async function checklistFiles(item) {
    const target = item.root ? await namedRoot(item.root) : { root: workspace };
    if (target.error) return target;
    const base = item.path ?? '';
    let paths = [[base, path.posix.basename(base)]];
    if (item.file) {
      let entries;
      try { entries = await listDirectory(target.root, base); } catch { return { status: 404, error: 'not-found' }; }
      let names = entries.filter((entry) => entry.dir && !entry.name.startsWith('.')).map((entry) => entry.name).sort();
      // Newest is the last date-named folder (YYYY-MM-DD...): a run folder like backfill-undated sorts after every date.
      if (item.newest) names = names.filter((name) => /^\d{4}-\d{2}-\d{2}/.test(name)).slice(-1);
      paths = names.slice(0, CHECK_FILES).map((name) => [(base ? base + '/' : '') + name + '/' + item.file, name]);
    }
    const files = [];
    for (const [relative, name] of paths) {
      let file;
      try { file = await readFile(target.root, relative); } catch { if (!item.file) return { status: 404, error: 'not-found' }; continue; }
      files.push({ path: relative, name, ...file, ...checklistParse(file.content, item) });
    }
    return { status: 200, root: target.root, files };
  }
  async function checklistItem(id) {
    if (typeof id !== 'string' || !ID.test(id)) return refused;
    return (await registry()).space.flatMap((section) => section.checklists ?? []).find((item) => item.id === id) ?? { status: 404, error: 'unknown-id' };
  }
  async function checklist(id) {
    const item = await checklistItem(id);
    if (item.error) return item;
    const list = await checklistFiles(item);
    if (list.error) return list;
    return { status: 200, marks: item.marks ?? null, review: item.review ?? null, apply: Boolean(item.apply),
      files: list.files.map(({ path: relative, name, hash, review, rows }) => ({ path: relative, name, hash, review, rows: rows.map(({ n, mark, text }) => ({ n, mark, text })) })) };
  }
  async function checklistSet(body) {
    const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).sort().join(',') : '';
    const kind = { 'hash,id,mark,path,row': 'mark', 'hash,id,path,review': 'review', 'apply,hash,id,path': 'apply' }[keys];
    if (!kind || typeof body.path !== 'string' || body.path.length > 1024 || typeof body.hash !== 'string' || !/^[a-f0-9]{64}$/.test(body.hash)) return refused;
    const item = await checklistItem(body.id);
    if (item.error) return item;
    const list = await checklistFiles(item);
    if (list.error) return list;
    const file = list.files.find((entry) => entry.path === body.path);
    if (!file) return { status: 404, error: 'not-found' };
    if (file.hash !== body.hash) return { status: 409, kind: 'conflict', reason: 'hash-conflict', diskHash: file.hash };
    const pieces = file.content.split(BREAKS);
    if (kind === 'mark') {
      const row = Number.isInteger(body.row) ? file.rows[body.row] : undefined;
      if (!item.marks || typeof body.mark !== 'string' || !Object.hasOwn(item.marks, body.mark) || !row) return refused;
      const [, start, , end, rest] = pieces[row.line].match(ROW);
      pieces[row.line] = start + body.mark + end + rest;
    } else {
      if (kind === 'review' && (!item.review || !item.review.includes(body.review))) return refused;
      if (kind === 'apply' && (body.apply !== true || !item.apply || !/^[\w.-]{1,64}$/.test(file.name))) return refused;
      const lines = pieces.flatMap((piece, index) => (index % 2 === 0 && REVIEW.test(piece) ? [index] : []));
      if (kind === 'apply' && (lines.length !== 1 || pieces[lines[0]] !== 'review: pending')) return { status: 409, error: 'not-pending' };
      if (lines.length !== 1) return { status: 409, error: 'review-line-count' };
      pieces[lines[0]] = 'review: ' + (kind === 'apply' ? 'apply' : body.review);
    }
    const content = pieces.join('');
    if (!oneLineChange(file.content, content, kind === 'mark' ? 'mark' : 'review')) return refused;
    stillAuthorized();
    const saved = await guardedSave(list.root, file.path, body.hash, content, recovery);
    if (saved.kind !== 'saved') return { status: saved.kind === 'conflict' ? 409 : 500, ...saved };
    if (kind !== 'apply') return { status: 200, hash: saved.hash };
    stillAuthorized();
    const started = await run(item.apply, { args: [file.name], confirm: true });
    return { ...started, hash: saved.hash };
  }
  // What the space reaches (migrate_mission's after list): every file its folder lists and checklists show, by real path,
  // with the item that shows it; a root not in settings.notes_roots yet is named instead.
  // ponytail: a folder list counts its newest NOTES_SHOWN files, as Mission shows them.
  async function reach() {
    const files = new Map(), unallowed = new Set(), refusedItems = [];
    for (const section of (await registry()).space) {
      for (const [kind, item] of [...section.folders.map((entry) => ['folders', entry]), ...(section.checklists ?? []).map((entry) => ['checklists', entry])]) {
        const where = section.title + ' › ' + item.title;
        if (item.root && !(settings.notes_roots && Object.hasOwn(settings.notes_roots, item.root))) { unallowed.add(item.root); continue; }
        const found = kind === 'folders' ? await folderFiles(item.id) : await checklistFiles(item);
        if (found.error) { refusedItems.push({ where, error: found.error }); continue; }
        for (const file of found.files) {
          const at = await realpath(path.join(found.root, file.path)).catch(() => path.join(found.root, file.path));
          if (!files.has(at)) files.set(at, where);
        }
      }
    }
    return { files, unallowed: [...unallowed].sort(), refused: refusedItems };
  }
  async function notesRead(name, relative) {
    if (!note(relative)) return refused;
    const target = await notesRoot(name);
    if (target.error) return target;
    const file = await readFile(target.root, relative);
    return { status: 200, path: relative, content: file.content, hash: file.hash };
  }
  // The same guarded save and conflict reply as answer(): a note changed on disk since it was read is never overwritten.
  async function notesSave(body) {
    if (!fields(body, 'content,hash,path,root') || !note(body.path) || typeof body.content !== 'string' || typeof body.hash !== 'string') return refused;
    const target = await notesRoot(body.root);
    if (target.error) return target;
    stillAuthorized();
    const result = await guardedSave(target.root, body.path, body.hash, body.content, recovery);
    return { status: result.kind === 'saved' ? 200 : result.kind === 'conflict' ? 409 : 500, ...result };
  }
  async function notesCreate(body) {
    if (!fields(body, 'content,path,root') || !note(body.path) || typeof body.content !== 'string') return refused;
    // A Quick note (threat model row 76): only a new file directly in the section's folder, so the vault never gets the full editor.
    const at = body.path.lastIndexOf('/'), name = body.path.slice(at + 1);
    const quick = (await registry()).space.some((section) => section.quick_note?.root === body.root && section.quick_note.path === body.path.slice(0, Math.max(at, 0)));
    if (quick && (name.length > 103 || /[\x00-\x1f\x7f\\:*?"<>|#^[\]]/.test(name))) return refused;
    if (quick && Buffer.byteLength(body.content) > 64 * 1024) return { status: 413, error: 'too-large' };
    const target = quick ? await namedRoot(body.root) : await notesRoot(body.root);
    if (target.error) return target;
    stillAuthorized();
    try { return { status: 201, path: body.path, hash: (await createFile(target.root, body.path, body.content)).hash }; }
    catch (error) {
      if (error.code === 'EEXIST') return { status: 409, error: 'exists' };
      if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return { status: 404, error: 'no-such-folder' };
      throw error;
    }
  }
  // A new name in the same folder; a name that exists is refused, never replaced.
  async function notesRename(body) {
    if (!fields(body, 'name,path,root') || !note(body.path) || !note(body.name) || body.name.includes('/')) return refused;
    const target = await notesRoot(body.root);
    if (target.error) return target;
    stillAuthorized();
    try { await renameFile(target.root, body.path, body.name); }
    catch (error) { if (error.code === 'EEXIST') return { status: 409, error: 'exists' }; throw error; }
    return { status: 200, path: [...body.path.split('/').slice(0, -1), body.name].join('/') };
  }

  // Resolves false when the program did not start (no konsole or xdg-open, a command not found), so the button says
  // so instead of "launched" (D1). Windows resolves the command first and runs a .cmd through cmd.exe (D3).
  function launchDetached(argv, cwd, stdio = 'ignore') {
    let child;
    try {
      const { argv: full, verbatim } = windows ? windowsArgv(argv, childEnv()) : { argv, verbatim: false };
      child = spawn(full[0], full.slice(1), { cwd, shell: false, env: childEnv(), detached: true, stdio, windowsVerbatimArguments: verbatim });
    } catch { return Promise.resolve(null); }
    return new Promise((done) => {
      child.once('spawn', () => done(child));
      child.once('error', () => done(null));
    }).then((started) => { if (started && stdio === 'ignore') started.unref(); return started; });
  }
  // Windows: the host script starts the command outside the daemon's job, so it outlives a daemon restart (W2), and exits 0
  // once it has (D1). Console gives it a new console window, Launch none.
  function hosted(argv, cwd, mode) {
    let host;
    try { host = windowsJobCommand(argv, childEnv(), mode); } catch { return Promise.resolve(null); }
    return new Promise((done) => {
      const child = spawn(host[0], host.slice(1), { cwd, shell: false, env: childEnv(), stdio: 'ignore', windowsHide: true });
      child.once('error', () => done(null));
      child.once('exit', (code) => done(code === 0 ? child : null));
    });
  }
  // Linux: a window app or a link starts as a transient unit of the user's systemd, the way the desktop's own launcher
  // starts apps. It gets the session's environment (X refuses a client without XAUTHORITY), not this unit's
  // NoNewPrivileges (an AppImage needs the setuid fusermount), and it outlives a daemon restart. systemd-run passes on
  // none of its own environment, and that is childEnv, so the daemon's secrets stay here. Type exec: a program that
  // cannot start fails here (D1). ExitType=cgroup: a launcher that starts its app and exits (hub.sh wave) leaves it running.
  // No systemd-run, no user manager or systemd before 250: the plain spawn. Scripts and terminals keep the plain spawn.
  function transient(argv, cwd) {
    return new Promise((done) => {
      const child = spawn('systemd-run', ['--user', '--collect', '--quiet', '--service-type=exec', '-p', 'ExitType=cgroup',
        `--working-directory=${cwd}`, '--', ...argv], { cwd, shell: false, env: childEnv(), stdio: 'ignore' });
      child.once('error', () => done(false));
      child.once('exit', (code) => done(code === 0));
    }).then((started) => started || launchDetached(argv, cwd));
  }
  // Linux: konsole.
  const terminal = (argv, cwd) => windows ? hosted(argv, cwd, 'Console') : launchDetached(['konsole', '--workdir', cwd, '-e', ...argv], cwd);
  const app = (argv, cwd) => windows ? hosted(argv, cwd, 'Launch') : transient(argv, cwd);
  // Windows opens a URL through its protocol handler, never cmd's start, which would parse an & in the URL (D1).
  const open = (url) => windows ? app([system32('rundll32.exe'), 'url.dll,FileProtocolHandler', url], root()) : transient(['xdg-open', url], root());
  const notStarted = { status: 502, error: 'could-not-start' };
  async function resolve(kind, id, body, allowedKeys) {
    if (typeof id !== 'string' || !ID.test(id)) return { status: 404, error: 'unknown-id' };
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !allowedKeys.includes(key))) {
      return { status: 400, error: 'request-refused' };
    }
    const item = (await registry())[kind].find((record) => record.id === id);
    if (!item) return { status: 404, error: 'unknown-id' };
    const declared = item.args?.length ?? 0;
    const args = body.args ?? [];
    if (!Array.isArray(args) || args.length > declared) return { status: 400, error: 'request-refused', reason: 'too many arguments' };
    const refused = args.map((arg, index) => argRefusal(item, arg, index)).find(Boolean);
    if (refused) return { status: 400, error: 'request-refused', reason: refused };
    if (item.confirm && body.confirm !== true) return { status: 409, error: 'confirm-required' };
    const argv = argvFor(item, args, root());
    stillAuthorized();
    return { item, argv, cwd: path.join(root(), item.cwd ?? '') };
  }

  async function run(id, body) {
    await recovered;
    const release = lifecycle.begin();
    if (!release) return { status: 503, error: lifecycle.refusal() };
    try {
    const target = await resolve('scripts', id, body, ['args', 'confirm']);
    if (target.error) return target;
    if (target.item.terminal) return await terminal(target.argv, target.cwd) ? { status: 200, launched: true } : notStarted;
    if ([...runs.values()].filter((entry) => entry.done === false).length >= MAX_RUNNING) return { status: 429, error: 'too-many-runs' };
    // ponytail: runs live in memory (latest 20); a daemon restart forgets them, the hub never kept them either.
    for (const key of [...runs.keys()].slice(0, Math.max(0, runs.size - 19))) if (runs.get(key).done) runs.delete(key);
    const entry = { id: randomUUID(), script: id, output: `$ ${target.argv.join(' ')}\n\n`, done: false, code: null, started: Date.now() };
    runs.set(entry.id, entry);
    const append = (chunk) => {
      if (entry.output.length >= OUTPUT_LIMIT) return;
      entry.output += chunk.toString('utf8');
      if (entry.output.length >= OUTPUT_LIMIT) entry.output = entry.output.slice(0, OUTPUT_LIMIT) + '\n[output truncated at 1 MB]\n';
    };
    // ponytail: the unit's KillMode=process lets a running script outlive a daemon stop; per-run cgroups (systemd-run --scope) if that matters.
    let proc;
    // Windows resolves the executable before launch and throws when it is missing; the run must still finish and free its slot.
    try { proc = launchTree(target.argv, target.cwd, { instance, prefix: 'p9-run', scope: true, stdio: ['ignore', 'pipe', 'pipe'], detach: target.item.detach === true }); }
    catch (error) {
      append(`[could not start: ${error.message}]\n\n[exit 127 in 0.0s]\n`);
      Object.assign(entry, { done: true, code: 127 });
      return { status: 202, run: entry.id };
    }
    const { child } = proc;
    entry.proc = proc;
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    // A detach script's kept children inherit its output pipes, so 'close' would wait for them: once the script exits,
    // read what is buffered, then let go. ponytail: a 1 s drain; what a kept child writes after that is not shown.
    if (target.item.detach === true) child.once('exit', () => setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); }, 1000).unref());
    const timer = setTimeout(() => { endTree(proc).then(() => append('\n[stopped: 15 minute limit]\n')); }, RUN_LIMIT_MS);
    const finish = (code, message) => {
      if (entry.done) return;
      clearTimeout(timer);
      if (message) append(`[could not start: ${message}]\n`);
      append(`\n[exit ${code} in ${((Date.now() - entry.started) / 1000).toFixed(1)}s]\n`);
      entry.done = true;
      entry.code = code;
    };
    child.on('error', (error) => finish(127, error.code ?? 'error'));
    child.on('close', (code, signal) => finish(code ?? signal));
    return { status: 202, run: entry.id };
    } finally { release(); }
  }

  function output(id, from) {
    const entry = runs.get(id);
    if (!entry) return { status: 404, error: 'unknown-run' };
    const start = Number.isSafeInteger(from) && from >= 0 ? Math.min(from, entry.output.length) : 0;
    return { status: 200, script: entry.script, output: entry.output.slice(start), next: entry.output.length, done: entry.done, code: entry.code };
  }

  // A server that prints its URL (hub's vscode-web): run it up to 30 s, open the last stdout line if it is http(s).
  // ponytail: on Windows it stays in the daemon's job (the host gives no stdout back), so a daemon restart ends what it left running.
  async function printUrl(target) {
    const allowed = captureAuthority();
    const child = await launchDetached(target.argv, target.cwd, ['ignore', 'pipe', 'ignore']);
    if (!child) return notStarted;
    // Windows has no process groups: taskkill /T ends the tree (before D1 the kill threw there and the request hung).
    const kill = () => windows ? spawn(system32('taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell: false, env: childEnv(), stdio: 'ignore', windowsHide: true }).on('error', () => {})
      : process.kill(-child.pid, 'SIGKILL');
    const timer = setTimeout(() => { try { kill(); } catch {} }, PRINT_URL_MS);
    let stdout = '';
    child.stdout.on('data', (chunk) => { if (stdout.length < 65536) stdout += chunk; });
    await new Promise((closed) => child.on('close', closed));
    clearTimeout(timer);
    const url = stdout.trim().split('\n').pop()?.trim() ?? '';
    if (!web(url)) return { status: 502, error: 'no-url-printed' };
    if (!allowed()) return { status: 401, error: 'login-required' };
    return await open(url) ? { status: 200, launched: true, url } : notStarted;
  }
  // A space link (threat model rows 74, 75): found by ID, the typed text URL-encoded onto its end, and a scheme that is not
  // http(s) checked against settings.page_schemes and confirmed. It returns the link and opens nothing: the device that asked opens it.
  async function link(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['id', 'text', 'confirm'].includes(key))
      || typeof body.id !== 'string' || !ID.test(body.id)) return { status: 400, error: 'request-refused' };
    const found = (await registry()).space.flatMap((section) => section.links ?? []).find((item) => item.id === body.id);
    if (!found) return { status: 404, error: 'unknown-id' };
    let url = found.url;
    if (found.ask !== undefined) {
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!url.endsWith('=') || !text || text.length > 200 || /[\x00-\x1f\x7f]/.test(text)) return { status: 400, error: 'request-refused' };
      url += encodeURIComponent(text);
    } else if (body.text !== undefined) return { status: 400, error: 'request-refused' };
    if (!web(url)) {
      const scheme = schemeOf(url);
      if (NEVER_SCHEMES.has(scheme) || !(settings.page_schemes ?? []).includes(scheme)) return { status: 403, error: 'scheme-not-allowed', scheme };
      if (body.confirm !== true) return { status: 409, error: 'confirm-required', url };
    }
    return { status: 200, open: url };
  }
  async function launch(kind, id, body) {
    const release = lifecycle.begin();
    if (!release) return { status: 503, error: lifecycle.refusal() };
    try {
    if (kind === 'pages') {
      if (typeof id !== 'string' || !ID.test(id) || !body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'confirm')) {
        return { status: id && ID.test(id) ? 400 : 404, error: id && ID.test(id) ? 'request-refused' : 'unknown-id' };
      }
      const page = (await registry()).pages.find((record) => record.id === id);
      if (!page) return { status: 404, error: 'unknown-id' };
      // A link that is not http(s) opens another program (M6): the page must have shown the full link and sent confirm:true.
      if (!web(page.url) && body.confirm !== true) return { status: 409, error: 'confirm-required', url: page.url };
      stillAuthorized();
      return await open(page.url) ? { status: 200, launched: true } : notStarted;
    }
    const target = await resolve('apps', id, body, ['args', 'confirm']);
    if (target.error) return target;
    if (target.item.print_url) return await printUrl(target);
    const allowed = captureAuthority();
    if (!await (target.item.terminal ? terminal(target.argv, target.cwd) : app(target.argv, target.cwd))) return notStarted;
    if (target.item.url) setTimeout(() => { if (allowed()) open(target.item.url); }, target.item.url_delay ?? 0).unref();
    return { status: 200, launched: true };
    } finally { release(); }
  }

  // The answer lands on the empty A. line through the guarded save; a file changed since it was read is kept.
  async function answer(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'answer,hash,name'
        || typeof body.name !== 'string' || !ITEM.test(body.name) || ['AGENTS.md', 'CLAUDE.md'].includes(body.name)
        || typeof body.hash !== 'string' || !/^[a-f0-9]{64}$/.test(body.hash)
        || typeof body.answer !== 'string' || !body.answer.trim() || body.answer.length > 4000 || /[\x00-\x08\x0a-\x1f\x7f]/.test(body.answer)) {
      return { status: 400, error: 'request-refused' };
    }
    if (settings.waiting === undefined) return { status: 404, error: 'file-not-found' };
    const relative = `${settings.waiting}/${body.name}`;
    const current = await readFile(workspace, relative);
    if (current.hash !== body.hash) {
      return { status: 409, kind: 'conflict', reason: 'hash-conflict', diskContent: current.content, diskHash: current.hash };
    }
    if (!EMPTY_ANSWER.test(current.content)) return { status: 409, error: 'no-empty-answer-line' };
    const content = current.content.replace(EMPTY_ANSWER, () => `A. ${body.answer.trim()}`);
    stillAuthorized();
    const result = await guardedSave(workspace, relative, body.hash, content, recovery);
    return { status: result.kind === 'saved' ? 200 : result.kind === 'conflict' ? 409 : 500, ...result };
  }

  async function stopAll() {
    await recovered;
    const results = await Promise.all([...runs.values()].filter((entry) => !entry.done && entry.proc).map((entry) => endTree(entry.proc)));
    results.push(await stopScopes('p9-run', instance));
    if (!results.includes('cleanup-failed')) return 'stopped';
    return results.at(-1) === 'cleanup-failed' ? 'cleanup-failed-reconcile' : 'cleanup-failed-runs';
  }

  // What the tile icons are made from (icons.mjs): the links, the apps' programs and the sections, as parsed.
  const iconSources = async () => { const reg = await registry(); return { pages: reg.pages, apps: reg.apps, sections: reg.space }; };
  // Data tiles (threat model row 70). A tile runs the script it names only after the user's Allow, which is kept with a hash of
  // the exact argv and folder: a tile pointed somewhere else, or a script whose command changed, asks again.
  let answers = allowed ? null : {};
  let answerSaves = Promise.resolve();
  const answered = async () => (answers ??= await fsReadFile(allowed, 'utf8').then(JSON.parse).catch(() => ({})));
  async function tile(id) {
    if (typeof id !== 'string' || !ID.test(id)) return { status: 400, error: 'request-refused' };
    const reg = await registry();
    // A card (M5) runs its script by the same rules; its answer is any JSON. A tile and a card share one ID space.
    const item = reg.space.flatMap((section) => [...(section.data ?? []), ...(section.cards ?? [])]).find((record) => record.id === id);
    if (!item) return { status: 404, error: 'unknown-id' };
    const script = reg.scripts.find((record) => record.id === item.script);
    if (!script) return { status: 404, error: 'unknown-script', detail: 'No registry script or space button has the ID ' + item.script + '.' };
    if (script.args?.length || script.confirm || script.terminal || script.detach) {
      return { status: 409, error: 'not-a-data-script', detail: script.title + ' takes arguments or is marked confirm, terminal or detach, so a tile never runs it.' };
    }
    const target = await resolve('scripts', script.id, {}, []);
    if (target.error) return target;
    const key = createHash('sha256').update(JSON.stringify([id, target.argv, target.cwd])).digest('hex');
    return { ...target, script, key, card: 'html' in item };
  }
  async function allow(body) {
    if (!body || typeof body !== 'object' || Object.keys(body).join() !== 'id') return { status: 400, error: 'request-refused' };
    const target = await tile(body.id);
    if (target.error) return target;
    const turn = answerSaves.then(async () => {
      const next = { ...(await answered()), [body.id]: target.key };
      // Owner-only, written whole and renamed into place: a crash leaves the old answers, never half a file.
      if (allowed) { await fsWriteFile(allowed + '.tmp', JSON.stringify(next, null, 2) + '\n', { mode: 0o600 }); await fsRename(allowed + '.tmp', allowed); }
      answers = next;
    });
    answerSaves = turn.catch(() => {});
    await turn;
    return { status: 200, allowed: body.id };
  }
  // A card's HTML (threat model row M5): read through packages/files (inside the workspace, symlinks resolved), sent as text.
  // It runs only in the artifact frame on the page, so reading it needs no Allow; its script still does.
  async function card(id) {
    if (typeof id !== 'string' || !ID.test(id)) return { status: 400, error: 'request-refused' };
    const item = (await registry()).space.flatMap((section) => section.cards ?? []).find((record) => record.id === id);
    if (!item) return { status: 404, error: 'unknown-id' };
    let file;
    try { file = await readFile(workspace, item.html); } catch { return { status: 404, error: 'not-found', detail: 'The card file ' + item.html + ' was not found in the workspace.' }; }
    if (Buffer.byteLength(file.content) > CARD_BYTES) return { status: 413, error: 'too-big', detail: 'The card file ' + item.html + ' is over 256 KiB.' };
    return { status: 200, html: file.content };
  }
  // The last run per tile: a second ask within 30 s, or while it runs, gets the same answer, so a tile never runs more often.
  const tileRuns = new Map();
  async function data(id) {
    const target = await tile(id);
    if (target.error) return target;
    if ((await answered())[id] !== target.key) return { status: 409, error: 'allow-required', script: target.script.title };
    const last = tileRuns.get(id);
    if (last?.key === target.key && Date.now() - last.at < DATA_LIMITS.everyMs) return { status: 200, ...(await last.result) };
    const result = runTile(target);
    tileRuns.set(id, { key: target.key, at: Date.now(), result });
    return { status: 200, ...(await result) };
  }
  // One run: stdout only, 64 KiB at most, the whole tree ended at 10 s. Every outcome is an answer the tile draws as text.
  async function runTile(target) {
    const release = lifecycle?.begin();
    if (lifecycle && !release) return { why: 'did not run: P9 is stopping' };
    try {
      let proc;
      try { proc = launchTree(target.argv, target.cwd, { instance, prefix: 'p9-run', scope: true, stdio: ['ignore', 'pipe', 'ignore'] }); }
      catch (error) { return { why: 'could not start (' + error.message + ')' }; }
      const { child } = proc;
      let out = Buffer.alloc(0), over = false, late = false;
      const timer = setTimeout(() => { late = true; endTree(proc).catch(() => {}); }, DATA_LIMITS.timeoutMs);
      child.stdout.on('data', (chunk) => {
        if (over) return;
        out = Buffer.concat([out, chunk]);
        if (out.length > DATA_LIMITS.bytes) { over = true; out = out.subarray(0, DATA_LIMITS.bytes); endTree(proc).catch(() => {}); }
      });
      const code = await new Promise((done) => { child.once('error', () => done(127)); child.once('close', (exit, signal) => done(exit ?? signal)); });
      clearTimeout(timer);
      const printed = out.toString('utf8');
      const head = printed.slice(0, 2000);
      if (late) return { why: 'took longer than 10 s and was stopped', printed: head };
      if (over) return { why: 'printed more than 64 KiB and was stopped', printed: head };
      if (code !== 0) return { why: 'ended with code ' + code, printed: head };
      let value;
      try { value = JSON.parse(printed); } catch { return { why: 'printed something that is not JSON', printed: head }; }
      if (target.card) return { json: value };
      const wrong = dataShape(value);
      return wrong ? { why: wrong, printed: head } : { shape: value };
    } finally { release?.(); }
  }

  return { overview, iconSources, run, output, launch, link, answer, stopAll, spaceLog, setSettings, named, notesList, notesRead, notesSave, notesCreate, notesRename, folderList, folderRead, checklist, checklistSet, reach, data, allow, card };
}
