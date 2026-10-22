// Mission Control: workspace-hub's registry, waiting queue and main project card, read through packages/files.
// Scripts run only by registry ID as a fixed argv (spawn without a shell); the client never supplies command text.
import { spawn } from 'node:child_process';
import { childEnv } from './child-env.mjs';
import { stillAuthorized, captureAuthority } from './authority.mjs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { readFile, listDirectory, guardedSave } from '../../packages/files/index.mjs';
import { launchTree, endTree, stopScopes, windowsArgv, windowsJobCommand } from './process-tree.mjs';

const windows = process.platform === 'win32';
const system32 = (file) => path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', file);

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ITEM = /^[\w.-]{1,120}\.md$/;
// The answer line: empty "A.", or "A:" holding only an _italic placeholder_ (some live _tyler items use that form).
const EMPTY_ANSWER = /^A[.:][ \t]*(?:_[^_\n]*_[ \t]*)?$/m;
// The checkpoint button appends its argument to an ssh remote command, which a remote shell parses.
const UNSAFE_ARG = /[\x00-\x1f\x7f;&|`$<>\\]/;
// ssh joins its remote command with spaces and the remote shell splits and globs it: an ssh button takes one plain word.
const SSH_WORD = /^[\w.@%+=:,/-]+$/;
const RUN_LIMIT_MS = 15 * 60 * 1000;
const PRINT_URL_MS = 30000;
const OUTPUT_LIMIT = 1024 * 1024;
const MAX_RUNNING = 4;

function relativePath(value) {
  return typeof value === 'string' && value && !path.isAbsolute(value) && !value.split('/').some((part) => !part || part === '.' || part === '..');
}

export function parseSettings(text) {
  const settings = JSON.parse(text);
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)
      || !['primary', 'registry', 'waiting'].every((key) => relativePath(settings[key]))
      || !Object.keys(settings).every((key) => ['primary', 'registry', 'waiting', 'scripts_root', 'hub', 'space', 'server_host'].includes(key))
      || !optional(settings, 'hub', relativePath) || !optional(settings, 'space', relativePath)
      || !optional(settings, 'server_host', (value) => typeof value === 'string' && /^[\w.-]{1,64}$/.test(value))
      || !optional(settings, 'scripts_root', (value) => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0'))) throw new Error('invalid-settings');
  return Object.freeze(settings);
}

const strings = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string' && item && !item.includes('\0'));
const optional = (record, key, check) => !(key in record) || check(record[key]);
const web = (value) => typeof value === 'string' && /^https?:\/\/[^\s]+$/.test(value);

function validRecord(record, kind) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.id !== 'string' || !ID.test(record.id)
      || typeof record.title !== 'string') return false;
  if (kind === 'pages') return web(record.url);
  return strings(record.cmd) && record.cmd.length > 0
    && optional(record, 'args', (args) => Array.isArray(args) && args.length <= 4 && args.every((arg) => typeof arg === 'string'
      || (arg && typeof arg === 'object' && typeof arg.label === 'string')))
    && optional(record, 'tail', strings) && optional(record, 'cwd', relativePath) && optional(record, 'url', web)
    && ['terminal', 'confirm', 'print_url'].every((key) => optional(record, key, (value) => typeof value === 'boolean'))
    && optional(record, 'url_delay', (value) => Number.isSafeInteger(value) && value >= 0 && value <= 30000)
    && ['desc', 'group', 'where'].every((key) => optional(record, key, (value) => typeof value === 'string'));
}

// Malformed records and every record sharing a duplicated ID are dropped and reported, never run.
export function parseRegistry(text) {
  const registry = JSON.parse(text);
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) throw new Error('invalid-registry');
  const result = { invalid: [] };
  for (const kind of ['scripts', 'apps', 'pages']) {
    const records = Array.isArray(registry[kind]) ? registry[kind] : [];
    const counts = new Map();
    for (const record of records) if (typeof record?.id === 'string') counts.set(record.id, (counts.get(record.id) ?? 0) + 1);
    result[kind] = [];
    records.forEach((record, index) => {
      if (!validRecord(record, kind)) result.invalid.push({ kind, index, reason: 'malformed-record' });
      else if (counts.get(record.id) > 1) result.invalid.push({ kind, index, id: record.id, reason: 'duplicate-id' });
      else result[kind].push(record);
    });
  }
  return result;
}

// The free-form space (settings.space, one JSON file): sections, each with optional text, buttons and log views.
// A button is a registry script record and runs the same way, by ID; a log view shows the end of one workspace file.
export function parseSpace(text) {
  const space = JSON.parse(text);
  if (!space || typeof space !== 'object' || !Array.isArray(space.sections)) throw new Error('invalid-space');
  const result = { sections: [], invalid: [] };
  space.sections.forEach((section, index) => {
    if (!section || typeof section !== 'object' || typeof section.title !== 'string' || !section.title.trim()
        || !['buttons', 'logs'].every((key) => optional(section, key, Array.isArray)) || !optional(section, 'text', (value) => typeof value === 'string')) {
      return result.invalid.push({ kind: 'space', index, reason: 'malformed-section' });
    }
    const title = section.title.trim(), buttons = [], logs = [];
    (section.buttons ?? []).forEach((record, button) => (validRecord(record, 'scripts') ? buttons.push({ ...record, group: title })
      : result.invalid.push({ kind: 'space', index, button, reason: 'malformed-record' })));
    (section.logs ?? []).forEach((record, log) => (record && typeof record.id === 'string' && ID.test(record.id) && typeof record.title === 'string'
      && relativePath(record.path) ? logs.push({ id: record.id, title: record.title, path: record.path })
      : result.invalid.push({ kind: 'space', index, log, reason: 'malformed-record' })));
    result.sections.push({ title, text: section.text ?? '', buttons, logs });
  });
  return result;
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

export function createMission({ workspace, recovery, settings, instance = 'test', lifecycle }) {
  const runs = new Map();
  const recovered = stopScopes('p9-run', instance);
  // Registry commands run where the registry's relative paths resolve: the hub's ~/workspace, which can sit above P9's workspace.
  const scriptsRoot = settings?.scripts_root ?? workspace;
  // The registry plus the space: a space button joins the registry's scripts, so run() finds it by ID like any script.
  async function registry() {
    if (!settings) throw new Error('settings-missing');
    const reg = parseRegistry((await readFile(workspace, settings.registry)).content);
    let space = { sections: [], invalid: [] };
    if (settings.space) {
      try { space = parseSpace((await readFile(workspace, settings.space)).content); }
      catch { space.invalid.push({ kind: 'space', reason: 'unreadable-space' }); }
    }
    const invalid = [...reg.invalid, ...space.invalid];
    const scripts = unique([...reg.scripts, ...space.sections.flatMap((section) => section.buttons)], 'scripts', invalid);
    const logs = new Set(unique(space.sections.flatMap((section) => section.logs), 'space', invalid));
    const sections = space.sections.map((section) => ({ ...section, logs: section.logs.filter((log) => logs.has(log)) }));
    return { ...reg, scripts, invalid, space: sections };
  }
  async function queue() {
    const items = [];
    for (const entry of await listDirectory(workspace, settings.waiting)) {
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
    const text = (await readFile(workspace, settings.primary)).content;
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
    const strip = ({ id, title, desc = '', group = '', args = [], confirm = false, terminal = false, url = '' }) =>
      ({ id, title, desc, group, args: args.map((arg) => (typeof arg === 'string' ? arg : arg.label)), confirm, terminal, url });
    return { waiting: settings.waiting, scripts: reg.scripts.map(strip), apps: reg.apps.map(strip), pages: reg.pages.map(strip), invalid: reg.invalid,
      space: reg.space.map(({ title, text, logs }) => ({ title, text, logs: logs.map(({ id, title: name }) => ({ id, title: name })) })),
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
  // Linux: konsole. Windows: the host script starts the command in a new console window and exits 0 once it has (D1).
  function terminal(argv, cwd) {
    if (!windows) return launchDetached(['konsole', '--workdir', cwd, '-e', ...argv], cwd);
    let host;
    try { host = windowsJobCommand(argv, childEnv(), 'Console'); } catch { return Promise.resolve(null); }
    return new Promise((done) => {
      const child = spawn(host[0], host.slice(1), { cwd, shell: false, env: childEnv(), stdio: 'ignore', windowsHide: true });
      child.once('error', () => done(null));
      child.once('exit', (code) => done(code === 0 ? child : null));
    });
  }
  // Windows opens a URL through its protocol handler, never cmd's start, which would parse an & in the URL (D1).
  const open = (url) => launchDetached(windows ? [system32('rundll32.exe'), 'url.dll,FileProtocolHandler', url] : ['xdg-open', url], scriptsRoot);
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
    if (!Array.isArray(args) || args.length > declared || !args.every((arg) => typeof arg === 'string' && arg.length <= 1000 && !UNSAFE_ARG.test(arg)
      && (path.basename(item.cmd[0]) !== 'ssh' || SSH_WORD.test(arg)))) {
      return { status: 400, error: 'request-refused' };
    }
    if (item.confirm && body.confirm !== true) return { status: 409, error: 'confirm-required' };
    const argv = argvFor(item, args, scriptsRoot);
    stillAuthorized();
    return { item, argv, cwd: path.join(scriptsRoot, item.cwd ?? '') };
  }

  async function run(id, body) {
    await recovered;
    const release = lifecycle.begin();
    if (!release) return { status: 503, error: 'stop-all-running' };
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
    try { proc = launchTree(target.argv, target.cwd, { instance, prefix: 'p9-run', scope: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) {
      append(`[could not start: ${error.message}]\n\n[exit 127 in 0.0s]\n`);
      Object.assign(entry, { done: true, code: 127 });
      return { status: 202, run: entry.id };
    }
    const { child } = proc;
    entry.proc = proc;
    child.stdout.on('data', append);
    child.stderr.on('data', append);
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
    if (!release) return { status: 503, error: 'stop-all-running' };
    try {
    if (kind === 'pages') {
      if (typeof id !== 'string' || !ID.test(id) || !body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) {
        return { status: id && ID.test(id) ? 400 : 404, error: id && ID.test(id) ? 'request-refused' : 'unknown-id' };
      }
      const page = (await registry()).pages.find((record) => record.id === id);
      if (!page) return { status: 404, error: 'unknown-id' };
      stillAuthorized();
      return await open(page.url) ? { status: 200, launched: true } : notStarted;
    }
    const target = await resolve('apps', id, body, ['args', 'confirm']);
    if (target.error) return target;
    if (target.item.print_url) return await printUrl(target);
    const allowed = captureAuthority();
    if (!await (target.item.terminal ? terminal(target.argv, target.cwd) : launchDetached(target.argv, target.cwd))) return notStarted;
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

  return { overview, run, output, launch, answer, stopAll, spaceLog };
}
