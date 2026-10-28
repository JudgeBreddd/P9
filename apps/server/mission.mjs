// Mission Control: workspace-hub's registry, waiting queue and main project card, read through packages/files.
// Scripts run only by registry ID as a fixed argv (spawn without a shell); the client never supplies command text.
import { spawn } from 'node:child_process';
import { childEnv } from './child-env.mjs';
import { stillAuthorized, captureAuthority } from './authority.mjs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { realpath, readdir as fsReaddir } from 'node:fs/promises';
import { readFile, listDirectory, guardedSave, createFile, renameFile, HEAVY } from '../../packages/files/index.mjs';
import { launchTree, endTree, stopScopes, windowsArgv, windowsJobCommand } from './process-tree.mjs';
import { ID, web, problem, RECORD, PAGE, SECTION, LOG, SETTINGS } from './mission-fields.mjs';

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

// The free-form space (settings.space, one JSON file): sections, each with optional text, buttons, log views and notes.
// A button is a registry script record and runs the same way, by ID; a log view shows the end of one workspace file;
// notes names a folder from settings.notes_roots by its key, never by path.
export function parseSpace(text) {
  const space = JSON.parse(stripBom(text));
  if (!space || typeof space !== 'object' || !Array.isArray(space.sections)) throw new Error('invalid-space');
  const result = { sections: [], invalid: [] };
  space.sections.forEach((section, index) => {
    const wrong = problem(section, SECTION);
    if (wrong) return result.invalid.push({ kind: 'space', index, reason: 'malformed-section', detail: wrong });
    const title = section.title.trim(), buttons = [], logs = [];
    (section.buttons ?? []).forEach((record, button) => { const detail = recordProblem(record, 'scripts');
      if (detail) result.invalid.push({ kind: 'space', index, button, reason: 'malformed-record', detail }); else buttons.push({ ...record, group: title }); });
    (section.logs ?? []).forEach((record, log) => { const detail = problem(record, LOG);
      if (detail) result.invalid.push({ kind: 'space', index, log, reason: 'malformed-record', detail }); else logs.push({ id: record.id, title: record.title, path: record.path }); });
    result.sections.push({ title, text: section.text ?? '', buttons, logs, ...(section.icon ? { icon: section.icon } : {}), ...(section.picture ? { picture: section.picture } : {}), ...(section.notes ? { notes: section.notes } : {}) });
  });
  return result;
}

// The registry plus the space: a space button joins the registry's scripts, so run() finds it by ID like any script.
// Exported so the P9 MCP server's validate tools merge exactly as Mission Control does.
export function combine(reg, space) {
  const invalid = [...reg.invalid, ...space.invalid];
  const scripts = unique([...reg.scripts, ...space.sections.flatMap((section) => section.buttons)], 'scripts', invalid);
  const logs = new Set(unique(space.sections.flatMap((section) => section.logs), 'space', invalid));
  const sections = space.sections.map((section) => ({ ...section, logs: section.logs.filter((log) => logs.has(log)) }));
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

export function createMission({ workspace, recovery, settings, instance = 'test', lifecycle }) {
  // The settings file is read again when it changes (M2); setSettings swaps the parsed value, the next request sees it.
  const setSettings = (next) => { settings = next; plansCache.at = 0; };
  const runs = new Map();
  const recovered = stopScopes('p9-run', instance);
  // Registry commands run where the registry's relative paths resolve: the hub's ~/workspace, which can sit above P9's workspace.
  const root = () => settings?.scripts_root ?? workspace;
  // A settings key's file that is not there names itself (server.mjs answers file-not-found), not "storage unavailable".
  const settingFile = (key, read) => read(settings[key]).catch((error) => {
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
    const reg = parseRegistry((await settingFile('registry', (file) => readFile(workspace, file))).content, settings.page_schemes);
    let space = { sections: [], invalid: [] };
    if (settings.space) {
      try { space = parseSpace((await readFile(workspace, settings.space)).content); }
      catch { space.invalid.push({ kind: 'space', reason: 'unreadable-space' }); }
    }
    const combined = combine(reg, space);
    return { ...combined, scripts: await named(combined.scripts), apps: await named(combined.apps) };
  }
  async function queue() {
    const items = [];
    for (const entry of await settingFile('waiting', (folder) => listDirectory(workspace, folder))) {
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
    const text = (await settingFile('primary', (file) => readFile(workspace, file))).content;
    const match = text.match(/\*\*Main project: ([^*]+)\*\* \(`([^`]+)`/);
    if (!match) return null;
    const directory = path.posix.join(path.posix.dirname(settings.primary), match[2].replace(/\/$/, ''));
    let status = '';
    try { status = (await readFile(workspace, `${directory}/AGENTS.md`)).content.match(/^\*\*Status:\*\*\s*(.+)$/m)?.[1].trim() ?? ''; }
    catch {}
    return { name: match[1].trim(), path: directory, status: status.slice(0, 240) };
  }
  async function overview() {
    const reg = await registry();
    const strip = ({ id, title, icon, picture, desc = '', group = '', args = [], confirm = false, terminal = false, url = '' }) =>
      ({ id, title, ...(icon ? { icon } : {}), ...(picture ? { picture } : {}), desc, group, args: args.map((arg) => (typeof arg === 'string' ? arg : arg.choices ? { label: arg.label, choices: arg.choices } : arg.label)), confirm, terminal, url });
    return { waiting: settings.waiting, scripts: reg.scripts.map(strip), apps: reg.apps.map(strip), pages: reg.pages.map(strip), invalid: reg.invalid,
      space: reg.space.map(({ title, text, logs, notes, icon, picture }) => ({ title, text, ...(icon ? { icon } : {}), ...(picture ? { picture } : {}), logs: logs.map(({ id, title: name }) => ({ id, title: name })), ...(notes ? { notes } : {}) })),
      queue: await queue(), primary: await primary() };
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
    const folder = settings.notes_roots && Object.hasOwn(settings.notes_roots, name) ? settings.notes_roots[name] : undefined;
    if (!folder || !(await registry()).space.some((section) => section.notes === name)) return { status: 404, error: 'unknown-root' };
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
    const target = await notesRoot(body.root);
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
  return { overview, iconSources, run, output, launch, answer, stopAll, spaceLog, setSettings, named, notesList, notesRead, notesSave, notesCreate, notesRename };
}
