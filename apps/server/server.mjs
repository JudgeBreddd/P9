import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { readdir, readFile as readAsset, writeFile, rename, stat, access, mkdir, open, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { constants as fsConstants, existsSync } from 'node:fs';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getRequestListener } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import { ORIGIN, MAX_BYTES, PUBLIC_ROUTES, FRAME_CSP, parseSave, SIGN_IN_ORIGINS, DEVICE_CODE, signInUrl } from '../../packages/protocol/index.mjs';
import { readFile as readWorkspaceFile, listDirectory, guardedSave, createFile, createDirectory, setProtection, protection, HEAVY } from '../../packages/files/index.mjs';
import { createXfer } from './xfer.mjs';
import { createUpdate, toolPath } from './update.mjs';
import { createMission, parseSettings, rootRefused, inside } from './mission.mjs';
import { SETTINGS } from './mission-fields.mjs';
import { createHub } from './hub.mjs';
import { openLedger, operations } from './ledger.mjs';
import { createAnymouse } from './anymouse.mjs';
import { createChat } from './chat.mjs';
import { createMcp } from './mcp.mjs';
import { createLifecycle } from './lifecycle.mjs';
import { createTerminals } from './terminals.mjs';
import { readSprint, SPRINT_TMUX } from './sprint.mjs';
import { createAuth, SESSION_MS } from './auth.mjs';
import { agentDirs, planLimits } from './limits.mjs';
import { loginPage, loginScript } from './login-page.mjs';
import { authority, stillAuthorized } from './authority.mjs';
import { createIcons } from './icons.mjs';
import { daemonEditor, editorProblem, editorDownload, EDITOR_DIR } from '../desktop/editor-host.mjs';
import { AGENTS, adminCommand, wizardDependencies, found as onPath, placeAgents } from './deps.mjs';
import pkg from '../../package.json' with { type: 'json' };

// RS1: a restart is done when /health names a different boot, not when the old process is gone.
const boot = { pid: process.pid, started: Date.now() };
// The daemon's version: package.json's, imported so the daemon bundle (bundle-daemon.mjs) carries it inline and needs no
// package.json beside it at runtime.
const VERSION = pkg.version;

function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function cookieValue(header, name) {
  const values = (header ?? '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(name + '='));
  return values.length === 1 ? values[0].slice(name.length + 1) : '';
}
const READS = ['GET', 'HEAD', 'OPTIONS'];
const isPublic = (route) => PUBLIC_ROUTES.some((prefix) => route === prefix || route.startsWith(prefix + '/'));
const TERMINAL_SOCKET = /^\/terminals\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/socket$/;
// An upgrade's path, or null. Only an origin-form target ('/x') is parsed: 'GET //' throws in new URL, and an upgrade
// callback is outside Hono's error handler, so it would end the daemon.
const upgradeRoute = (url) => {
  if (!/^\/(?![/\\])/.test(url ?? '')) return null;
  try { return new URL(url, 'http://p9.invalid').pathname; } catch { return null; }
};
const refuse = (socket, status) => socket.end('HTTP/1.1 ' + status + ' Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
// The setup wizard's starter files (threat model row 17): settings.json's three required paths and the two notes.
const STARTER_SETTINGS = Object.freeze({ primary: 'AGENTS.md', registry: 'mission/registry.json', waiting: 'needs-you' });
const STARTER_AGENTS = '# My workspace\n\nAgents working in this folder read this file first. Write here what they should know: your projects,\n'
  + 'where things live, and how you like work done.\n';
const STARTER_WAITING = '# Needs you\n\nAgents put a note here when they need your answer or your OK. Each .md file in this folder shows\n'
  + 'on Mission Control as an item that needs you, until it is moved or deleted.\n';
const webRoot = fileURLToPath(new URL('../web/dist/', import.meta.url));
const types = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' };

export function authorize(headers, method, transport, credentials) {
  // The desktop check. The remote listener never accepts desktop credentials, proxy headers or source IP.
  if (!['unix', 'pipe'].includes(transport)) return 401;
  const cookies = (headers.cookie ?? '').split(';').map((part) => part.trim());
  if (cookies.filter((part) => part.startsWith('p9=')).length !== 1
      || !equal(cookies.find((part) => part.startsWith('p9='))?.slice(3), credentials.cookie)) return 401;
  if (headers.origin !== ORIGIN || headers.host !== 'p9.local') return 403;
  if ((!READS.includes(method) || headers.upgrade)
      && !equal(headers['x-p9-csrf'], credentials.csrf)) return 403;
  return 0;
}

// The remote check (phase 10): this device's passkey session, the pinned Serve origin and host, and the session's
// CSRF token on anything that is not a read. Tailscale-User-* headers and the source address are never consulted.
export function authorizeRemote(headers, method, route, auth, remote) {
  if (headers.host !== remote.host) return { status: 403 };
  const sameOrigin = headers.origin === remote.origin;
  const upgrade = Boolean(headers.upgrade);
  const mutating = !READS.includes(method) || upgrade;
  if (isPublic(route)) return { status: mutating && !sameOrigin ? 403 : 0 };
  const session = auth.session(cookieValue(headers.cookie, 'p9s'));
  if (session.status) return session;
  // A browser sends Origin on every mutation and upgrade, so a missing one is refused like a foreign one.
  if ((headers.origin !== undefined || mutating) && !sameOrigin) return { status: 403 };
  // A browser WebSocket cannot send x-p9-csrf, but always sends Origin: an upgrade needs the exact origin instead.
  if (upgrade) return sameOrigin ? session : { status: 403 };
  if (mutating && !equal(headers['x-p9-csrf'], session.csrf)) return { status: 403 };
  return session;
}

// D7/D8: the agents' sign-in commands. Item 15: no install command; both CLIs ship with P9 (deps.mjs puts them on the
// terminals' PATH), so the wizard's Install writes a launcher instead of downloading anything.
const AGENT_COMMANDS = { claude: { login: 'claude auth login' }, codex: { login: 'codex login' } };

// The rebuild's test stand-ins count only under the test home (P9_TEST_HOME, the daemon's test switch): P9_PACKAGED=1
// answers as a packaged app would, P9_BUILD runs instead of pnpm build. Outside it both are ignored.
export const rebuildStandIns = (env) => ({ packaged: !!env.P9_TEST_HOME && env.P9_PACKAGED === '1', build: (env.P9_TEST_HOME && env.P9_BUILD) || null });

export function createListener({ workspace, savedWorkspace, recovery, state, ownership, credentials, transport, settings, settingsInvalid = false, settingsFile, ledger = openLedger(':memory:'), adapterOverride, instance = 'test', tmuxSocket = 'p9-' + instance, terminalPlatform, remote, anymouse = createAnymouse(), updateRoot = fileURLToPath(new URL('../../', import.meta.url)).replace(/[\\/]$/, ''), updateArchive, updateTurnMs }) {
  const lifecycle = createLifecycle();
  let mission = createMission({ workspace, recovery, settings, instance, lifecycle });
  let hub = createHub({ workspace, settings });
  const chat = createChat({ ledger, workspace, adapterOverride, instance, lifecycle, socketPath: credentials?.socketPath, state, ownership });
  const xfer = createXfer({ workspace, ownership, recovery });
  const update = createUpdate({ ownership, state, chat, lifecycle, version: VERSION, root: updateRoot, archive: updateArchive, turnLimit: updateTurnMs });
  // Rebuild + reload (remoteApp /rebuild): source checkouts only, as on the desktop (main.mjs source). A bundled daemon has no
  // lockfile or web sources; P9_PACKAGED=1 lets a test see what one answers (under the test home only, as P9_BUILD). Fixed argv, no shell, 10 minutes, one at a
  // time; the error carries only the last 3 lines of stderr, at most 300 characters. P9_BUILD is the tests' stand-in.
  const checkout = fileURLToPath(new URL('../../', import.meta.url));
  const buildable = () => !rebuildStandIns(process.env).packaged
    && ['package.json', 'pnpm-lock.yaml', 'apps/web/src/pages/phone.astro'].every((name) => existsSync(path.join(checkout, name)));
  let building = null;
  const rebuild = (device) => new Promise((resolve) => {
    const stand = rebuildStandIns(process.env).build;
    const [command, args] = stand ? [stand, []] : ['pnpm', ['build']];
    const started = Date.now();
    console.error(JSON.stringify({ event: 'P9_REBUILD_STARTED', device, command: [path.basename(command), ...args].join(' ') }));
    execFile(command, args, { cwd: checkout, timeout: 600_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PATH: toolPath() } }, (error, _stdout, stderr) => {
      console.error(JSON.stringify({ event: 'P9_REBUILD_DONE', device, ok: !error, ms: Date.now() - started }));
      resolve(error ? { status: 500, error: 'build-failed', detail: String(stderr).trim().split('\n').slice(-3).join('\n').slice(0, 300) } : { status: 200, rebuilt: true });
    });
  });
  const terminals = createTerminals({ ledger, workspace, lifecycle, socket: tmuxSocket, platform: terminalPlatform });
  const auth = remote ? createAuth({ ledger, rpID: remote.rpID, origin: remote.origin }) : null;
  // Server mode's Dev Focus (threat model row 50): Linux daemons only, the editor's socket beside the daemon's own.
  const editor = transport === 'unix' && state ? daemonEditor({ socket: path.join(state, 'editor.sock'), unit: 'p9-editor-server-' + instance }) : null;
  // File protection (threat model row 4; Builder, 2026-10-18): on unless the desktop turned it off; createChat made the prefs table.
  setProtection(ledger.db.prepare("SELECT value FROM prefs WHERE key = 'file-protection'").get()?.value !== 'off');
  const json = async (c) => {
    if (c.req.header('content-type') !== 'application/json') throw new Error('json-required');
    return c.req.json();
  };
  const reply = (c, { status, ...result }) => c.json(result, status);
  // EBUSY is 503 (try again), not 409, which the clients read as "the file changed", nor 423, which means a locked device.
  const statuses = { ENOENT: 404, EACCES: 403, EPERM: 403, EROFS: 403, EBUSY: 503, ENOSPC: 507, EDQUOT: 507, EIO: 500 };
  const onError = (error) => {
    if (error.message === 'session-ended') return new Response(JSON.stringify({ error: 'login-required' }), { status: 401, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    // A Mission file a settings key names is not there (mission.mjs): which key, and its workspace-relative path from
    // settings.json, never the system's error text.
    if (error.message === 'file-not-found') return new Response(JSON.stringify({ error: 'file-not-found', setting: error.setting, file: error.file }), { status: 404, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    const invalid = error instanceof SyntaxError || ['unsafe-path', 'locked-path', 'unsafe-file', 'path-changed',
      'binary-or-oversize', 'invalid-save', 'json-required'].includes(error.message) || ['ELOOP', 'ENOTDIR'].includes(error.code);
    const code = Object.hasOwn(statuses, error.code) ? error.code : invalid ? 'REQUEST_REFUSED' : 'INTERNAL_FAILURE';
    if (code !== 'REQUEST_REFUSED') console.error(JSON.stringify({ event: 'P9_REQUEST_FAILED', code }));
    return new Response(JSON.stringify({ error: code === 'REQUEST_REFUSED' ? 'request-refused' : 'storage-unavailable' }), {
      status: statuses[code] ?? (invalid ? 400 : 500), headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  };
  const hardening = async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    await next();
  };
  const limit = bodyLimit({ maxSize: MAX_BYTES * 6 + 8192, onError: (c) => c.json({ error: 'body-too-large' }, 413) });

  // The routes both listeners serve. Device management is desktop-only and the login routes are remote-only.
  const api = new Hono();
  api.onError(onError);
  // F2: the phone (a remote device) never needs the workspace's full path, so only the desktop gets it.
  // savedWorkspace: the folder the task or unit names, when it was not there at start and this run uses the default (main.mjs).
  // version: the daemon's own; the installed app counts a start healthy only when it matches its own (AU5, rollback.mjs).
  api.get('/health', async (c) => c.json({ status: 'ok', phase: 11, writes: 'guarded', ...(c.get('device') ? {} : { workspace, boot, version: VERSION, ...(savedWorkspace ? { savedWorkspace } : {}) }),
    recoveryRecordCount: (await readdir(recovery)).filter((name) => name.startsWith('.p9-conflict-')).length }));
  api.get('/files', async (c) => c.json(await readWorkspaceFile(workspace, c.req.query('path'))));
  // The file tree never shows the folders P9 does not crawl (HEAVY: node_modules, .venv and the like).
  api.get('/files/list', async (c) => c.json({ entries: (await listDirectory(workspace, c.req.query('path') ?? '')).filter((entry) => !(entry.dir && HEAVY.includes(entry.name))) }));
  // File protection off lifts these three read-only rules too (Builder, 2026-10-18: "Everything").
  const readOnly = (path, name = path.toLowerCase()) => protection() && Boolean(
    // The registry is the script allowlist: an API that can rewrite it could run anything, so P9 never writes it.
    // ponytail: Builder edits registry.json outside P9; a reviewed registry editor would need its own confirm step.
    (settings && name === settings.registry.toLowerCase())
    // The space holds button commands too, so it is read-only to P9 for the same reason.
    || (settings?.space && name === settings.space.toLowerCase())
    // workspace-hub still runs its own Python until it retires, so the same rule covers that file.
    || (settings?.hub && name === (settings.hub + '/mission_control.py').toLowerCase()));
  const mcp = createMcp({ workspace, recovery, state, settingsFile, settings: () => settings, mission: () => mission, chat, readOnly, protection });
  // Dev Focus's second root (threat model row 41): a folder outside the workspace, set only by the desktop (POST /dev/root),
  // kept in memory only, and checked again on every use, as notes roots are. A save names it by the path main set, so a save from
  // the page of a folder Dev Focus has since left is refused, never written into the new one.
  let devRoot = null;
  const devCheck = async (folder) => {
    let root;
    try { root = await realpath(folder); } catch { return { status: 404, error: 'root-not-found' }; }
    const also = [state, ownership && await realpath(ownership).catch(() => ownership)].filter(Boolean);
    if (!(await stat(root)).isDirectory() || await rootRefused(root, { workspace, recovery, also })) return { status: 403, error: 'root-refused' };
    // A folder inside the workspace is opened as the workspace, with its own guards (File protection's read-only files).
    if (inside(await realpath(workspace), root)) return { status: 409, error: 'inside-workspace' };
    return { root };
  };
  const devTarget = (body) => {
    if (!body || typeof body !== 'object' || !Object.hasOwn(body, 'root')) return { root: workspace };
    if (!devRoot) return { status: 409, error: 'dev-root-unset' };
    return body.root === devRoot ? devCheck(devRoot) : { status: 409, error: 'dev-root-changed' };
  };
  const withoutRoot = (body) => (body && typeof body === 'object' && Object.hasOwn(body, 'root') ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'root')) : body);
  api.put('/files', async (c) => {
    if (c.req.header('content-type') !== 'application/json') return c.json({ error: 'json-required' }, 415);
    const body = await c.req.json(), dev = Boolean(body) && typeof body === 'object' && Object.hasOwn(body, 'root');
    if (dev && c.get('device')) return c.json({ error: 'request-refused' }, 403); // the phone never writes in the second root
    const target = await devTarget(body);
    if (target.error) return reply(c, target);
    const input = parseSave(withoutRoot(body));
    await reloadSettings();
    // Read-only names are workspace paths; the second root has none.
    if (!dev && readOnly(input.path)) return c.json({ error: 'registry-read-only' }, 403);
    const result = await guardedSave(target.root, input.path, input.hash, input.content, recovery);
    if (result.draftRetained) console.error(JSON.stringify({ event: 'P9_DRAFT_RETAINED' }));
    if (result.kind === 'failed') console.error(JSON.stringify({ event: 'P9_REQUEST_FAILED', code: result.code }));
    return c.json(result, result.kind === 'saved' ? 200 : result.kind === 'conflict' ? 409 : statuses[result.code] ?? 500);
  });
  // M2: the settings file is read again on every Mission request and swapped in when its text changed, so an edit shows
  // in the next refresh with no restart. A file that no longer parses keeps the last good settings (the overview says so).
  // ponytail: one small file read per Mission request; a watcher if that ever shows up in a profile.
  let settingsText, settingsError = null;
  const reloadSettings = async () => {
    if (!settingsFile) return;
    let text;
    try { text = await readAsset(settingsFile, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') return; }
    if (text === settingsText) return;
    settingsText = text;
    if (text === undefined) { settingsError = null; return; } // deleted: the last good settings stay until a valid file returns
    try { settings = parseSettings(text); settingsInvalid = false; settingsError = null; }
    catch (error) { settingsError = String(error.message).slice(0, 200); if (!settings) settingsInvalid = true; return; }
    mission.setSettings(settings);
    hub = createHub({ workspace, settings });
  };
  // What a restart would apply: no settings.json key needs one (all of them are read per request), so the only reason is a
  // saved workspace folder that was missing at start (main.mjs); the desktop button restarts the service once it is back.
  const restart = () => (savedWorkspace ? { needed: true, reason: 'workspace-folder-missing', folder: savedWorkspace } : { needed: false });
  for (const route of ['/mission', '/mission/*', '/scripts/*', '/runs/*', '/apps/*', '/pages/*']) {
    api.use(route, async (c, next) => { await reloadSettings(); return settings ? next() : c.json({ error: settingsInvalid ? 'settings-invalid' : 'settings-missing' }, 503); });
  }
  api.get('/mission', async (c) => c.json({ ...(await mission.overview()), settingsError, restart: restart(), update: update.brief() }));
  api.post('/mission/answer', async (c) => reply(c, await mission.answer(await json(c))));
  api.get('/mission/hub', async (c) => reply(c, await hub.overview()));
  // A space log view rides the hub text route, so both clients open it like any other log.
  api.get('/mission/hub/text', async (c) => reply(c, c.req.query('kind') === 'space' ? await mission.spaceLog(c.req.query('name')) : await hub.text(c.req.query())));
  // Fix with Claude: the daemon reads the incident through the hub's own checks and seeds a Claude chat with it; the
  // client names only the machine and incident, never prompt text. workspace-hub opened a terminal here instead.
  api.post('/mission/fix', async (c) => {
    const { host, name } = (await json(c)) ?? {};
    const incident = await hub.text({ kind: 'incident', host, name });
    if (incident.status !== 200) return reply(c, incident);
    // Only an incident the hub lists: a server read that fails comes back as a placeholder line, not an error.
    if (!(await hub.sections()).incidents.some((i) => i.host === host && i.name === name)) return reply(c, { status: 404, error: 'not-found' });
    const where = host === os.hostname().split('.')[0] ? '' : ` You are on ${os.hostname().split('.')[0]}; reach ${host} with ssh ${host} (its workspace is ~/workspace).`;
    const made = await chat.create({ provider: 'claude', title: 'Fix: ' + name.replace(/\.md$/, '').slice(0, 100) });
    const sent = await chat.prompt(made.conversation, { text: `This is a doctor incident from ${host}. Find the cause and fix it, then run `
      + `doctor.sh --fix (the workspace's _system/scripts) to confirm it passes.${where}\n\n${incident.text.slice(-90_000)}` });
    return reply(c, sent.status === 202 ? { status: 201, conversation: made.conversation } : sent);
  });
  // New idea: one new file in _ideas/ (or _ideas/needs-done/), named as workspace-hub's new_idea names it; never replaces one.
  api.post('/mission/idea', async (c) => {
    const { name, text, needs_done: needsDone } = (await json(c)) ?? {};
    if (typeof name !== 'string' || typeof text !== 'string' || typeof needsDone !== 'boolean' || name.length > 200) return reply(c, { status: 400, error: 'invalid-idea' });
    const dot = name.trim().lastIndexOf('.');
    const [base, ext] = dot > 0 ? [name.trim().slice(0, dot), name.trim().slice(dot + 1)] : [name.trim(), 'md'];
    const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
    if (!slug) return reply(c, { status: 400, error: 'give it a name' });
    const file = `${slug}.${ext.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) || 'md'}`;
    const relative = ['_ideas', ...(needsDone ? ['needs-done'] : []), file].join('/');
    try { await createFile(workspace, relative, text.trimEnd() + '\n'); }
    catch (error) {
      if (error.code === 'EEXIST') return reply(c, { status: 409, error: `${file} already exists` });
      if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return reply(c, { status: 404, error: 'no _ideas folder' });
      // F2: onError answers with an allowlisted code; a system error's message names the file's full path.
      throw error;
    }
    return reply(c, { status: 201, path: relative });
  });
  api.post('/mission/hub/decide', async (c) => reply(c, await hub.decide(await json(c))));
  // Sprint tracker: read-only view of the coordinator's status file; Open tmux is a new P9 terminal running one fixed
  // command (sprint.mjs), with an empty body only, like the agent terminal (threat model row 53). Tmux only: Windows' terminals have none.
  api.get('/mission/sprint', async (c) => reply(c, await readSprint()));
  api.post('/mission/sprint/tmux', async (c) => {
    const body = await json(c);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) return reply(c, { status: 400, error: 'request-refused' });
    if (process.platform === 'win32') return reply(c, { status: 409, error: 'tmux-not-on-windows' });
    return reply(c, await terminals.create({}, { typed: SPRINT_TMUX, run: true, phone: !!c.get('device') }));
  });
  // Notes (threat model row 34): both listeners, the same gates; mission.mjs checks the root, path and kind.
  api.get('/mission/notes', async (c) => reply(c, await mission.notesList(c.req.query('root'))));
  api.get('/mission/notes/file', async (c) => reply(c, await mission.notesRead(c.req.query('root'), c.req.query('path'))));
  api.post('/mission/notes/save', async (c) => reply(c, await mission.notesSave(await json(c))));
  api.post('/mission/notes/create', async (c) => reply(c, await mission.notesCreate(await json(c))));
  api.post('/mission/notes/rename', async (c) => reply(c, await mission.notesRename(await json(c))));
  api.post('/scripts/:id/run', async (c) => reply(c, await mission.run(c.req.param('id'), await json(c))));
  api.get('/runs/:id', (c) => reply(c, mission.output(c.req.param('id'), Number(c.req.query('from') ?? 0))));
  api.post('/apps/:id/launch', async (c) => reply(c, await mission.launch('apps', c.req.param('id'), await json(c))));
  api.post('/pages/:id/launch', async (c) => reply(c, await mission.launch('pages', c.req.param('id'), await json(c))));
  api.get('/agent-lock', (c) => reply(c, chat.lock()));
  // Settings > Security (c18, threat model rows 15, 4, 49 and 66): the phone changes the agent lock, File protection and
  // Mission Control files too, through the desktop's own handlers, behind its session, CSRF and the op ledger.
  api.post('/agent-lock', async (c) => reply(c, await chat.setLock(await json(c))));
  api.get('/chat', (c) => c.json({ conversations: chat.list() }));
  api.post('/chat', async (c) => reply(c, await chat.create(await json(c))));
  api.get('/chat/events', async (c) => { const only = c.req.query('only'), until = c.req.query('until'), tail = c.req.query('tail');
    return reply(c, await chat.events(Number(c.req.query('after') ?? 0), Number(c.req.query('wait') ?? 0), only === undefined ? undefined : only.split(',').filter(Boolean), until === undefined ? undefined : Number(until), tail === undefined ? undefined : Number(tail))); });
  // P8: a signed-out Codex has no plan figure (its old sessions would show one months old) and is named signed out. Claude
  // is left out: on a Mac its login is in the Keychain, so a missing credentials file says nothing.
  api.get('/usage', async (c) => { const { claudeLive, ...usage } = ledger.usage(), limits = await planLimits({ home: os.homedir(), claudeLive });
    const signedOut = (await signedIn()).codex ? [] : ['codex'];
    return c.json({ ...usage, limits: { ...limits, ...(signedOut.length ? { codex: null } : {}), signedOut } }); });
  api.post('/anymouse', async (c) => reply(c, await anymouse(await json(c))));
  api.post('/chat/:id/prompt', async (c) => reply(c, await chat.prompt(c.req.param('id'), await json(c))));
  api.post('/chat/:id/answer', async (c) => reply(c, chat.answer(c.req.param('id'), await json(c))));
  api.post('/chat/:id/cancel', async (c) => reply(c, await chat.cancel(c.req.param('id'))));
  api.post('/chat/:id/unhold', async (c) => reply(c, chat.unhold(c.req.param('id'), await json(c))));
  api.post('/chat/:id/stop', async (c) => reply(c, await chat.stop(c.req.param('id'), c.req.header('content-type') ? await json(c) : {})));
  // Hand off (PH5): the chat stops; a new P9 terminal opens in its folder with the claude command typed in. The user
  // presses Enter, so nothing reaches claude.ai before they do.
  api.post('/chat/:id/handoff', async (c) => {
    const { cwd, command, ...result } = await chat.handoff(c.req.param('id'));
    if (result.status !== 200) return reply(c, result);
    const made = await terminals.create({}, { cwd, typed: command, phone: !!c.get('device') });
    return reply(c, made.terminal ? { ...result, terminal: made.terminal } : { ...made, command });
  });
  api.get('/chat/:id/images/:hash', (c) => reply(c, chat.image(c.req.param('id'), c.req.param('hash'))));
  api.get('/terminals', async (c) => {
    try { return c.json({ terminals: await terminals.list() }); } catch (error) {
      if (error.message === 'tmux-not-found') return c.json({ error: 'tmux-not-found' }, 503);
      if (error.message === 'terminal-unavailable') return c.json({ error: 'terminal-unavailable', reason: error.reason }, 503);
      throw error;
    }
  });
  api.post('/terminals', async (c) => reply(c, await terminals.create(await json(c), { phone: !!c.get('device') })));
  api.post('/terminals/:id/stop', async (c) => reply(c, await terminals.stop(c.req.param('id'))));
  api.post('/stop-all', async (c) => {
    // Checked after the lifecycle wait for running starts, so a device revoked meanwhile stops nothing.
    // ponytail: a desktop Stop All that joins this one in that window gets its 401 too; pressing it again works.
    const results = await lifecycle.stopAll(() => {
      stillAuthorized();
      return Promise.all([chat.stopAll(), mission.stopAll(), terminals.stopAll()]);
    });
    const result = results.some((value) => String(value).startsWith('cleanup-failed')) ? 'cleanup-failed' : 'stopped';
    return c.json({ result, components: { chat: results[0], scripts: results[1], terminals: results[2] } }, result === 'stopped' ? 200 : 500);
  });

  const app = new Hono();
  app.onError(onError);
  // The P9 MCP server (mcp.mjs): a chat's relay over the desktop socket, with that chat's token instead of the desktop
  // cookie, so it comes before the desktop check. A stopped chat's token stops working.
  app.post('/mcp', hardening, limit, async (c) => {
    const conversation = ['unix', 'pipe'].includes(transport) ? chat.mcpConversation(c.req.header('x-p9-mcp')) : null;
    if (!conversation) return c.json({ error: 'login-required' }, 401);
    let message;
    try { message = await c.req.json(); } catch { return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    // The relay exits when its agent is done with it, which closes this request and cancels an approval still waiting.
    const ended = new AbortController();
    c.env.outgoing.once('close', () => ended.abort());
    await reloadSettings(); // as on every Mission request (M2), so an agent's settings.json edit counts at once
    const answer = await mcp.handle(conversation, message, ended.signal);
    return answer ? c.json(answer) : c.body(null, 204);
  });
  app.use('*', async (c, next) => {
    const status = authorize(Object.fromEntries(c.req.raw.headers), c.req.method, transport, credentials);
    if (status) return c.json({ error: status === 401 ? 'login-required' : 'request-refused' }, status);
    await next();
  });
  app.use('*', hardening, limit, operations(ledger, 'desktop'));
  if (auth) {
    // The only way a device is approved, locked, revoked or reset: the desktop, over the Unix socket.
    app.get('/devices', (c) => c.json(auth.list()));
    app.post('/devices/enrollments/:id/approve', (c) => reply(c, auth.approve(c.req.param('id'))));
    app.post('/devices/enrollments/:id/refuse', (c) => reply(c, auth.refuse(c.req.param('id'))));
    app.post('/devices/reset', (c) => reply(c, auth.reset()));
    app.post('/devices/:id/lock', (c) => reply(c, auth.lock(c.req.param('id'), 'desktop')));
    app.post('/devices/:id/revoke', (c) => reply(c, auth.revoke(c.req.param('id'))));
  }
  // Send to server (D14, threat model row 51, move.mjs): the desktop moves a chat; the phone never sees these routes.
  app.post('/chat/:id/send-away', async (c) => reply(c, await chat.sendAway(c.req.param('id'))));
  app.get('/chat/:id/move-part', async (c) => reply(c, await chat.part(c.req.param('id'), c.req.query('kind'), Number(c.req.query('offset')))));
  app.post('/chat/:id/moved', async (c) => reply(c, await chat.moved(c.req.param('id'), await json(c))));
  app.post('/chat-import/:id/part', async (c) => reply(c, await chat.take(c.req.param('id'), await json(c))));
  app.post('/chat-import/:id/cancel', async (c) => reply(c, await chat.cancelUpload(c.req.param('id'))));
  app.post('/chat-import/:id', async (c) => reply(c, await chat.land(c.req.param('id'), await json(c))));
  // Send files over the tunnel (item 23, xfer.mjs): desktop main copies a folder between two daemons; never the phone's.
  app.post('/xfer/manifest', async (c) => reply(c, await xfer.manifest(await json(c))));
  app.get('/xfer/file', async (c) => reply(c, await xfer.file(c.req.query('path'), Number(c.req.query('offset')))));
  app.post('/xfer/:id/part', async (c) => reply(c, await xfer.part(c.req.param('id'), await json(c))));
  app.post('/xfer/:id/commit', async (c) => reply(c, await xfer.commit(c.req.param('id'), await json(c))));
  app.post('/xfer/:id/abort', async (c) => reply(c, await xfer.abort(c.req.param('id'))));
  // The server updates itself on connect (item 14, update.mjs, threat model row 62): the desktop only, never the phone.
  app.post('/update/:id/part', async (c) => reply(c, await update.part(c.req.param('id'), await json(c))));
  app.post('/update/:id/commit', async (c) => reply(c, await update.commit(c.req.param('id'), await json(c))));
  app.post('/update/fetch', async (c) => reply(c, await update.fetch(await json(c))));
  app.get('/update/status', async (c) => reply(c, await update.status()));
  // New files from Dev Focus (threat model row 4): create-only through packages/files, so it never replaces a file.
  app.post('/files', async (c) => {
    if (c.req.header('content-type') !== 'application/json') return c.json({ error: 'json-required' }, 415);
    const body = await c.req.json(), target = await devTarget(body), input = withoutRoot(body);
    if (!input || typeof input !== 'object' || Object.keys(input).sort().join() !== 'content,path' || typeof input.path !== 'string' || typeof input.content !== 'string') return c.json({ error: 'request-refused' }, 400);
    if (target.error) return reply(c, target);
    if (target.root === workspace && readOnly(input.path)) return c.json({ error: 'registry-read-only' }, 403);
    try { return c.json(await createFile(target.root, input.path, input.content), 201); }
    catch (error) { if (error.code === 'EEXIST') return c.json({ error: 'file-exists' }, 409); throw error; }
  });
  // Dev Focus's Open Folder outside the workspace (threat model row 41): main sends it after the native picker and confirm;
  // null goes back to the workspace. A refused folder leaves the root unset.
  app.post('/dev/root', async (c) => {
    const input = await json(c);
    if (!input || typeof input !== 'object' || Object.keys(input).join() !== 'path' || (input.path !== null && (typeof input.path !== 'string' || !path.isAbsolute(input.path)))) return c.json({ error: 'request-refused' }, 400);
    devRoot = null;
    if (input.path === null) return c.json({ root: null });
    const target = await devCheck(input.path);
    if (target.error) return reply(c, target);
    devRoot = target.root;
    return c.json({ root: devRoot });
  });
  // Server mode's Dev Focus (threat model row 50): the desktop asks the server's daemon for its editor, which listens on
  // editor.sock (0600) in the state folder; the tunnel's second forward carries it. Same answer as the desktop's own start:
  // the token, the release and the data folder; a failure names the cause as Dev Focus's page does, and whether Install can fix it.
  if (editor) {
    const empty = async (c) => { const input = await json(c); return input && typeof input === 'object' && !Array.isArray(input) && !Object.keys(input).length; };
    app.post('/dev/editor', async (c) => {
      if (!(await empty(c))) return c.json({ error: 'request-refused' }, 400);
      try { const host = await editor.start(); return c.json({ token: host.token, commit: host.commit, data: host.data }); }
      catch (error) {
        return c.json({ error: editorProblem(error), message: String(error.message).slice(0, 300), download: Boolean(editorDownload()),
          place: process.env.P9_EDITOR_HOST ?? path.join(EDITOR_DIR, 'codium-server') }, 503);
      }
    });
    // Install (threat model row 52): the same pinned, checked download as the desktop's button, run here on the server.
    app.post('/dev/editor/install', async (c) => {
      if (!(await empty(c))) return c.json({ error: 'request-refused' }, 400);
      try { await editor.install(); return c.json({ ok: true }); }
      catch (error) { return c.json({ error: String(error.message).slice(0, 200) }, error.message === 'editor-running' ? 409 : 502); }
    });
    // The dev view's writes into the editor's own data folder (p9dev:host-path): checked where the folder is.
    app.post('/dev/editor/writable', async (c) => {
      const input = await json(c);
      if (!input || typeof input !== 'object' || Object.keys(input).sort().join() !== 'kind,path' || typeof input.path !== 'string' || !['write', 'name'].includes(input.kind)) return c.json({ error: 'request-refused' }, 400);
      return c.json({ ok: await editor.writable(input.path, input.kind) });
    });
  }
  // First-run welcome (threat model row 17): what is missing, as booleans; the credential files are stat'ed, never opened.
  // Desktop only (F2): it names the workspace and settings file, which the phone never shows.
  // The credential files are looked for where the agents keep them: CLAUDE_CONFIG_DIR and CODEX_HOME when set (BL10).
  // Every call re-reads the disk (the wizard stores no progress): the settings file as it is now, not as it was at start.
  const present = (file) => (file ? stat(file).then((s) => s.isFile(), () => false) : false);
  const settingsOnDisk = async () => {
    let text;
    if (!settingsFile) return {};
    try { text = await readAsset(settingsFile, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
    try { return { text, parsed: parseSettings(text) }; } catch (error) { return { text, error: String(error.message).slice(0, 200) }; }
  };
  // The old file is kept as settings.json.bak (an older .bak is replaced); the new one lands by rename, never half written.
  const replaceSettings = async (old, next) => {
    if (old !== undefined) await writeFile(settingsFile + '.bak', old, { mode: 0o600 });
    const file = await open(settingsFile + '.tmp', 'w', 0o600);
    try { await file.writeFile(JSON.stringify(next, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
    await rename(settingsFile + '.tmp', settingsFile);
    await reloadSettings();
  };
  const isFolder = (relative) => stat(path.join(workspace, relative)).then((s) => s.isDirectory(), () => false);
  // "Use what's here" (needs-done p9-wizard-respects-existing-workspace): with no settings in a folder that already has things
  // in it, what the wizard can point at instead of making its own: a workspace-hub checkout (its registry and folder), an
  // AGENTS.md at the top, a needs-you or waiting folder. Links are never followed; at most three folders deep.
  const SKIP = new Set([...HEAVY, '_archive', '_private', '_intake', '_templates', 'templates', 'recommended-delete']);
  // The folder names a workspace keeps what is waiting on its owner in (the kit's _tyler included; Mission Control labels come from the owner's own folder).
  const WAITING_NAMES = new Set(['needs-you', '_needs-you', 'waiting', '_waiting', '_tyler']);
  const byDepth = (a, b) => a.split('/').length - b.split('/').length;
  const existing = async () => {
    const found = {};
    const agents = [], registries = [], waits = [];
    const walk = async (relative, depth) => {
      const entries = await readdir(path.join(workspace, relative), { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isFile() && entry.name === 'AGENTS.md') agents.push(relative ? relative + '/AGENTS.md' : 'AGENTS.md');
        if (entry.isFile() && entry.name === 'registry.json') registries.push(relative ? relative + '/registry.json' : 'registry.json');
        if (entry.isDirectory() && WAITING_NAMES.has(entry.name)) waits.push(relative ? relative + '/' + entry.name : entry.name);
        if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
        const child = relative ? relative + '/' + entry.name : entry.name;
        if (entry.name === 'workspace-hub' && !found.hub && await present(path.join(workspace, child, 'registry.json'))) found.hub = child;
        else if (depth < 3) await walk(child, depth + 1);
      }
    };
    await walk('', 1);
    if (found.hub) {
      found.registry = found.hub + '/registry.json';
      // Registry commands written relative to the folder above the workspace (the workspace is a folder inside a bigger one)
      // only resolve with scripts_root set there.
      const text = (await readAsset(path.join(workspace, found.registry), 'utf8').catch(() => '')).replace(/^﻿/, '');
      const base = path.basename(workspace) + '/', above = path.dirname(workspace);
      let records = [];
      try { const reg = JSON.parse(text); records = [...(reg.scripts ?? []), ...(reg.apps ?? [])]; } catch {}
      // S2: an ssh record's paths name the other machine, and a path that is not there above the workspace proves nothing.
      const local = records.filter((r) => Array.isArray(r?.cmd) && !/^ssh(\.exe)?$/i.test(path.basename(String(r.cmd[0]))));
      const candidates = local.flatMap((r) => [r.cwd, ...r.cmd]).filter((v) => typeof v === 'string' && v.startsWith(base) && !v.includes('..'));
      let proven = false;
      for (const v of candidates.slice(0, 50)) if (await stat(path.join(above, v)).then(() => true, () => false)) { proven = true; break; }
      if (path.basename(workspace) && proven) found.scripts_root = above;
    } else if (await present(path.join(workspace, STARTER_SETTINGS.registry))) found.registry = STARTER_SETTINGS.registry;
    else {
      // D6: a workspace with its own registry.json and no workspace-hub folder: the shallowest one that holds buttons, apps or pages.
      for (const file of registries.sort(byDepth)) {
        const reg = await readAsset(path.join(workspace, file), 'utf8').then((text) => JSON.parse(text.replace(/^\uFEFF/, ''))).catch(() => null);
        if (reg && typeof reg === 'object' && ['scripts', 'apps', 'pages'].some((key) => Array.isArray(reg[key]))) { found.registry = file; break; }
      }
    }
    // primary: an AGENTS.md with the line Mission parses (**Main project: ...** (`path`)), else the top one.
    const mainLine = async (file) => /\*\*Main project: [^*]+\*\* \(`[^`]+`/.test(await readAsset(path.join(workspace, file), 'utf8').catch(() => ''));
    for (const file of agents.sort((a, b) => a.split('/').length - b.split('/').length)) if (!found.primary && await mainLine(file)) found.primary = file;
    // D6: no top AGENTS.md (the workspace's own sits in a folder such as Work/): the shallowest one.
    if (!found.primary && agents.length) found.primary = agents.includes('AGENTS.md') ? 'AGENTS.md' : agents.sort(byDepth)[0];
    for (const folder of ['needs-you', 'waiting']) if (!found.waiting && await isFolder(folder)) found.waiting = folder;
    if (!found.waiting && waits.length) found.waiting = waits.sort(byDepth)[0];
    // waiting: no such folder, so one whose own AGENTS.md first heading says it holds what is waiting on the owner.
    for (const file of agents.filter((name) => name !== 'AGENTS.md')) {
      if (found.waiting) break;
      const text = await readAsset(path.join(workspace, file), 'utf8').catch(() => '');
      if (/waiting on/i.test(text.split('\n').find((line) => /^#+\s/.test(line)) ?? '')) found.waiting = path.posix.dirname(file);
    }
    return Object.fromEntries(Object.entries(found).filter(([, value]) => value));
  };
  // Exactly what a starter run with these paths makes: each of the three that is missing (a missing waiting folder gets its
  // AGENTS.md; an existing one is left as it is), and _ideas/ only in an empty workspace.
  const WIZARD_KEYS = ['primary', 'registry', 'waiting', 'hub', 'scripts_root'];
  const planFor = async (paths, empty) => [
    ...(await present(path.join(workspace, paths.primary)) ? [] : [paths.primary]),
    ...(await present(path.join(workspace, paths.registry)) ? [] : [paths.registry]),
    ...(await isFolder(paths.waiting) ? [] : [paths.waiting + '/AGENTS.md']),
    ...(empty && !(await isFolder('_ideas')) ? ['_ideas/'] : [])];
  // The wizard's own paths, checked as settings.json would be: only the four keys, each workspace-relative.
  const wizardPaths = (input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).every((key) => WIZARD_KEYS.includes(key))) return null;
    try { return parseSettings(JSON.stringify(input)); } catch { return null; }
  };
  // Settings are per machine, not per workspace: after "Change workspace" they can name starter paths this folder lacks while
  // the folder has its own layout. What it has that the settings do not name; non-empty means Create must not lay a starter.
  const differing = async (loaded, empty) => {
    if (!loaded) return empty ? {} : existing();
    if (empty || !(await planFor(loaded, false)).length) return {};
    const own = await existing();
    return Object.fromEntries(Object.entries(own).filter(([key, value]) => loaded[key] !== value));
  };
  // Whether each agent is signed in: its credentials file exists (never read).
  const signedIn = async () => ({ claude: await present(path.join(agentDirs(os.homedir()).claudeDir, '.credentials.json')),
    codex: await present(path.join(agentDirs(os.homedir()).codexHome, 'auth.json')) });
  app.get('/setup', async (c) => {
    const disk = await settingsOnDisk(), empty = !(await readdir(workspace)).length;
    // A settings file (loaded or on disk) decides the paths. Without one: an empty folder gets the starter paths, any other
    // gets what it already has, filled in with the starter paths, which the wizard shows and lets the owner change.
    const loaded = settings ?? disk.parsed;
    const found = (settings || disk.text !== undefined || empty) && !loaded ? {} : await differing(loaded, empty);
    const query = c.req.query(), asked = Object.keys(query).length ? wizardPaths(query) : null;
    const proposed = loaded && Object.keys(found).length ? asked ?? { ...loaded, ...found } : settings ?? disk.parsed ?? asked ?? { ...STARTER_SETTINGS, ...found };
    const paths = settings ?? disk.parsed ?? STARTER_SETTINGS;
    return c.json({ workspace, settingsFile: settingsFile ?? null, settings: Boolean(settings), settingsPresent: disk.text !== undefined,
      settingsInvalid: Boolean(disk.error), settingsError: disk.error ?? null,
      writable: await access(workspace, fsConstants.W_OK).then(() => true, () => false), workspaceEmpty: empty,
      found, conflict: Boolean(loaded && Object.keys(found).length), proposed,
      creates: disk.error ? [] : await planFor(proposed, empty), ...(Object.keys(query).length && !asked ? { pathsInvalid: true } : {}),
      agentsFile: await present(path.join(workspace, paths.primary)), registryFile: await present(path.join(workspace, paths.registry)),
      // null off Linux: only the tmux backend has a socket, and only it needs a binary installed.
      tmux: terminals.socket ? await terminals.list().then(() => true, (error) => error.message !== 'tmux-not-found') : null,
      ...await signedIn(),
      // D8: each agent's own CLI, for a terminal and Hand off (chats use the CLI the adapter ships, so they work without it).
      claudeCli: await onPath('claude'), codexCli: await onPath('codex'),
      // Item 15: every dependency, its reason and, for a system package, the admin command (deps.mjs).
      dependencies: await wizardDependencies() });
  });
  // "Create my starter files" (Builder, 2026-10-22: "1 yes"; threat model row 17): create-only, so an existing file or
  // folder counts as done and is never replaced. An invalid settings file is never touched; the wizard shows its error.
  // The new settings load live: with no settings every Mission route answered 503, so no run exists to lose here.
  // The body is {} (the settings file's paths, or the starter paths in an empty folder) or the wizard's chosen paths, which
  // a folder with things in it always needs: the fixed starter paths never land there unshown.
  app.post('/setup/starter', async (c) => {
    const body = await json(c);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'request-refused' }, 400);
    const chosen = Object.keys(body).length ? wizardPaths(body) : null;
    if (Object.keys(body).length && !chosen) return c.json({ error: 'request-refused' }, 400);
    if (!settingsFile) return c.json({ error: 'settings-file-unknown' }, 409);
    const disk = await settingsOnDisk();
    if (disk.error) return c.json({ error: 'settings-invalid', detail: disk.error }, 409);
    const old = disk.parsed ?? settings, empty = !(await readdir(workspace)).length;
    // Settings are replaced only when the owner confirms other paths for a folder whose own layout they do not name.
    const repoint = Boolean(chosen && old);
    if (repoint && !Object.keys(await differing(old, empty)).length) return c.json({ error: 'settings-exist' }, 409);
    if (!chosen && !settings && disk.text === undefined && !empty) return c.json({ error: 'paths-required' }, 409);
    // The wizard's keys are the chosen ones; every other key of the old file (space, notes_roots, server_host ...) carries over.
    const paths = repoint ? parseSettings(JSON.stringify({ ...Object.fromEntries(Object.entries(old).filter(([key]) => !WIZARD_KEYS.includes(key))), ...chosen }))
      : settings ?? disk.parsed ?? chosen ?? STARTER_SETTINGS;
    // The settings name starter paths this folder lacks, and it has its own: nothing is laid beside them unshown.
    if (!repoint && (settings || disk.parsed) && Object.keys(await differing(paths, empty)).length) return c.json({ error: 'layout-differs' }, 409);
    const made = (promise) => promise.then(() => true, (error) => { if (error.code === 'EEXIST') return false; throw error; });
    const folders = async (relative) => { for (let i = 1; i < relative.length; i++) await made(createDirectory(workspace, relative.slice(0, i).join('/'))); };
    const created = [], plan = await planFor(paths, empty);
    // BL1: a file where a planned folder goes (waiting named a file) failed mid-create as ENOTDIR, a 400 request-refused.
    // Checked before anything is made, so nothing is half laid.
    for (const relative of plan) {
      const parts = relative.replace(/\/$/, '').split('/');
      for (let i = 1; i < parts.length; i++) {
        const segment = parts.slice(0, i).join('/');
        if (await stat(path.join(workspace, segment)).then((s) => !s.isDirectory(), () => false)) return c.json({ error: 'path-is-a-file', detail: segment }, 409);
      }
    }
    for (const [relative, content] of [[paths.primary, STARTER_AGENTS], [paths.registry, '{"scripts":[],"apps":[],"pages":[]}\n'], [paths.waiting + '/AGENTS.md', STARTER_WAITING]]) {
      if (!plan.includes(relative)) continue;
      await folders(relative.split('/'));
      if (await made(createFile(workspace, relative, content))) created.push(relative);
    }
    if (plan.includes('_ideas/') && await made(createDirectory(workspace, '_ideas'))) created.push('_ideas/');
    if (repoint) {
      await replaceSettings(disk.text, paths);
      created.push(settingsFile);
    } else if (disk.text === undefined) {
      await mkdir(path.dirname(settingsFile), { recursive: true, mode: 0o700 });
      const file = await open(settingsFile, 'wx', 0o600).catch((error) => { if (error.code === 'EEXIST') return null; throw error; });
      if (!file) return c.json({ error: 'settings-changed' }, 409); // written by someone else meanwhile: Retry re-reads it
      try { await file.writeFile(JSON.stringify(paths, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
      created.push(settingsFile);
    }
    if (!settings) {
      settings = disk.parsed ?? paths;
      settingsInvalid = false;
      server.mission = mission = createMission({ workspace, recovery, settings, instance, lifecycle });
      hub = createHub({ workspace, settings });
    }
    return c.json({ created, settings: true }, 201);
  });
  // ST1/ST2: Settings → Mission Control files edits the loaded settings.json; the phone too since c18 (row 66), unlike the rest of /setup. The body
  // names only settings.json keys (null removes one); the result is checked by parseSettings, the same rules as at start, so
  // this route has none of its own. Notes folders keep their read-time refusals (home, workspace, recovery).
  // ponytail: read-change-write with no lock; the one caller saves one row at a time.
  api.get('/setup/settings', async (c) => {
    const disk = await settingsOnDisk();
    // remoteOrigin: this daemon's own phone address (--remote-origin), for "Continue on phone"; absent with remote logins off.
    return c.json({ settings: disk.parsed ?? null, error: disk.error ?? null, ...(remote && !c.get('device') ? { remoteOrigin: remote.origin } : {}) });
  });
  let settingsSaves = Promise.resolve();
  api.post('/setup/settings', async (c) => {
    const body = await json(c);
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length || !Object.keys(body).every((key) => Object.hasOwn(SETTINGS, key))) return c.json({ error: 'request-refused' }, 400);
    if (!settingsFile) return c.json({ error: 'settings-file-unknown' }, 409);
    // One save at a time: each reads the file the one before it wrote, so quick saves of different keys all land.
    const turn = settingsSaves.then(async () => {
      await reloadSettings();
      const disk = await settingsOnDisk();
      if (disk.error) return c.json({ error: 'settings-invalid', detail: disk.error }, 409);
      if (!disk.parsed || !settings) return c.json({ error: 'settings-missing' }, 409);
      const next = { ...disk.parsed };
      for (const [key, value] of Object.entries(body)) { if (value === null) delete next[key]; else next[key] = value; }
      let parsed;
      try { parsed = parseSettings(JSON.stringify(next)); } catch (error) { return c.json({ error: 'settings-refused', detail: error.detail ?? error.message }, 400); }
      await replaceSettings(disk.text, parsed);
      return c.json({ settings: parsed });
    });
    settingsSaves = turn.then(() => {}, () => {});
    return turn;
  });
  // Wizard sign-in (threat model row 31), desktop only: main is the only caller, and opens the URL only after its origin check.
  app.get('/setup/login', (c) => reply(c, chat.login.state()));
  app.post('/setup/login', async (c) => reply(c, await chat.login.start(await json(c))));
  app.post('/setup/login/code', async (c) => reply(c, chat.login.code(await json(c))));
  app.post('/setup/login/stop', async (c) => reply(c, await chat.login.stop(await json(c))));
  // D7/D8 (threat model row 53): an agent's official install or sign-in command, typed into a new P9 terminal and never run:
  // the owner reads it and presses Enter, and the terminal shows its output. The command comes from this table only; the
  // credentials the CLI saves stay in its own folder and never pass through P9.
  app.post('/setup/agent-terminal', async (c) => {
    const body = await json(c);
    if (!body || typeof body !== 'object' || Object.keys(body).sort().join() !== 'action,agent' || typeof body.agent !== 'string' || typeof body.action !== 'string'
        || !Object.hasOwn(AGENT_COMMANDS, body.agent) || !Object.hasOwn(AGENT_COMMANDS[body.agent], body.action)) return reply(c, { status: 400, error: 'request-refused' });
    const command = AGENT_COMMANDS[body.agent][body.action];
    const made = await terminals.create({}, { cwd: workspace, typed: command });
    return reply(c, made.terminal ? { status: 201, terminal: made.terminal, command } : { ...made, command });
  });
  // Item 15: the wizard's Install for the agents the owner picked, {claude, codex} as booleans: a launcher in P9's bin folder
  // for each true one, pointing at the CLI P9 ships. Nothing is downloaded and nothing needs the admin password.
  app.post('/setup/agents', async (c) => {
    const body = await json(c);
    if (!body || typeof body !== 'object' || Object.keys(body).sort().join() !== 'claude,codex' || typeof body.claude !== 'boolean' || typeof body.codex !== 'boolean'
        || !(body.claude || body.codex)) return reply(c, { status: 400, error: 'request-refused' });
    try { return reply(c, { status: 200, installed: await placeAgents(AGENTS.filter((agent) => body[agent])) }); }
    catch (error) { return reply(c, { status: 500, error: 'agents-not-installed', detail: error.code ?? error.message }); }
  });
  // Item 15 (threat model row 61): a system package P9 cannot carry, installed with the admin password. The command comes
  // from deps.mjs's table for a dependency that is missing now, typed into a new P9 terminal and never run: the owner reads
  // the reason first (the wizard's screen), then the command, and presses Enter; sudo asks for the password there.
  app.post('/setup/admin-terminal', async (c) => {
    const body = await json(c);
    if (!body || typeof body !== 'object' || Object.keys(body).join() !== 'id' || typeof body.id !== 'string') return reply(c, { status: 400, error: 'request-refused' });
    const command = await adminCommand(body.id);
    if (!command) return reply(c, { status: 409, error: 'nothing-to-install' });
    const made = await terminals.create({}, { cwd: workspace, typed: command });
    return reply(c, made.terminal ? { status: 201, terminal: made.terminal, command } : { ...made, command });
  });
  api.get('/file-protection', (c) => c.json({ on: protection() }));
  api.post('/file-protection', async (c) => {
    const body = await json(c);
    if (!body || typeof body !== 'object' || Object.keys(body).join() !== 'on' || typeof body.on !== 'boolean') return c.json({ error: 'request-refused' }, 400);
    ledger.db.prepare("INSERT INTO prefs (key, value) VALUES ('file-protection', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(body.on ? 'on' : 'off');
    setProtection(body.on);
    return c.json({ on: protection() });
  });
  // The Mission edit form (mission-editor.mjs), desktop only: names and icons of apps, links and sections, through the
  // MCP tools' own update() with its guards. File protection asks first: the form sends confirm once the user agreed.
  const editing = async (c, next) => { await reloadSettings(); return settings ? next() : c.json({ error: settingsInvalid ? 'settings-invalid' : 'settings-missing' }, 503); };
  app.get('/mission/edit', editing, async (c) => c.json(await mcp.editState()));
  // Tile art (apps/server/icons.mjs): site icons fetched from the sites themselves, program icons, and the user's pictures,
  // all as data: URIs for <img>. Desktop only; the phone lists links and shows no tiles.
  const icons = createIcons({ dir: state, workspace, registry: () => settings.registry });
  app.get('/mission/icons', editing, async (c) => c.json(await icons.collect(await mission.iconSources())));
  app.post('/mission/edit', editing, async (c) => {
    const { kind, confirm, ...rest } = (await json(c)) ?? {};
    if (!['apps', 'pages', 'sections'].includes(kind) || (confirm !== undefined && typeof confirm !== 'boolean')
      || !Object.keys(rest).every((name) => ['key', 'title', 'icon', 'picture', 'hash'].includes(name))) return c.json({ error: 'request-refused' }, 400);
    // A picture is '' (back to the automatic icon) or {data: base64}. The file is stored only after File protection's confirm and a
    // matching hash, so a refused save leaves nothing behind; the record then names it by the name P9 gave it.
    const { picture } = rest;
    if (picture !== undefined && picture !== '') {
      if (!picture || typeof picture !== 'object' || Object.keys(picture).join() !== 'data' || typeof picture.data !== 'string' || picture.data.length > 400_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(picture.data)) return c.json({ error: 'request-refused' }, 400);
      const now = await mcp.editState();
      if (now.protection && confirm !== true) return c.json({ error: 'registry-read-only' }, 403);
      const disk = kind === 'sections' ? now.space : now.registry;
      if (rest.hash !== undefined && rest.hash !== disk) return c.json({ error: 'hash-conflict', diskHash: disk }, 409);
      const stored = await icons.savePicture(Buffer.from(picture.data, 'base64'));
      if (stored.error) return c.json(stored, 400);
      rest.picture = stored.name;
    }
    const { error, ...result } = await mcp.update(kind, rest, { user: true, confirm });
    return c.json(error ? { error, ...result } : result, !error ? 200 : error === 'hash-conflict' ? 409 : error === 'registry-read-only' ? 403 : 400);
  });
  app.route('/', api);

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const attachTerminal = (request, socket, head, route) => {
    const match = TERMINAL_SOCKET.exec(route);
    if (!match) return refuse(socket, 404);
    wss.handleUpgrade(request, socket, head, (ws) => {
      // Before anything else: ws reports a protocol error (an over-limit frame, bad UTF-8) as an 'error' event, and an
      // unheard one would end the daemon. The socket is cut; attach's close handler stops its tmux client.
      ws.on('error', () => ws.terminate());
      terminals.attach(match[1], ws, socket).catch(() => (ws.readyState === ws.OPEN ? ws.close(1011, 'terminal-failed') : ws.terminate()));
    });
  };
  const options = { maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 5000 };
  const server = createServer(options, getRequestListener(app.fetch));
  server.on('upgrade', (request, socket, head) => {
    const status = authorize(request.headers, request.method, transport, credentials);
    if (status) return refuse(socket, status);
    const route = upgradeRoute(request.url);
    if (!route) return refuse(socket, 400);
    attachTerminal(request, socket, head, route);
  });
  server.maxConnections = 32;
  Object.assign(server, { chat, mission, terminals, lifecycle, auth });
  if (auth) server.remote = remoteListener();
  server.editor = editor;
  return server;

  function remoteListener() {
    // Every open socket of each device (requests in flight, long polls, terminal sockets): revoke, lock, reset and a
    // new login of that device destroy them at once, so nothing keeps working on an old session.
    const open = new Map();
    const watched = new WeakSet();
    const busy = new WeakMap();  // socket -> Map(device -> requests still running on it; HTTP pipelining can stack them)
    const track = (device, socket) => {
      if (!open.has(device)) open.set(device, new Set());
      open.get(device).add(socket);
      if (watched.has(socket)) return;
      watched.add(socket);
      socket.once('close', () => { for (const sockets of open.values()) sockets.delete(socket); });
    };
    auth.onClose((device) => { for (const socket of open.get(device) ?? []) socket.destroy(); open.delete(device); });
    const cookie = (token, ms) => 'p9s=' + token + '; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=' + Math.max(0, Math.floor(ms / 1000));
    const remoteApp = new Hono();
    remoteApp.onError(onError);
    remoteApp.use('*', async (c, next) => {
      const headers = Object.fromEntries(c.req.raw.headers);
      const result = authorizeRemote(headers, c.req.method, c.req.path, auth, remote);
      // A browser opening a page with no session (the installed phone app starting on /phone/) goes to the login page;
      // fetches and sockets keep the JSON 401. ponytail: keyed on Sec-Fetch-Mode (Safari 16.4+, every current Chromium).
      if (result.status === 401 && c.req.method === 'GET' && headers['sec-fetch-mode'] === 'navigate') return c.redirect('/login');
      if (result.status) return c.json({ error: { 401: 'login-required', 423: 'locked' }[result.status] ?? 'request-refused' }, result.status);
      // A keep-alive socket belongs to the devices with a request still running on it plus this request's device: a
      // public login on it must not be cut by that login's own rotation, one device's revoke must not cut another
      // device's request, and a request pipelined behind a long poll must not untrack the poll.
      const socket = c.env.incoming.socket;
      const running = busy.get(socket) ?? new Map();
      busy.set(socket, running);
      for (const [device, sockets] of open) if (!running.get(device)) sockets.delete(socket);
      if (!result.device) return next();
      const device = result.device, token = cookieValue(headers.cookie, 'p9s');
      c.set('device', device);
      track(device, socket);
      running.set(device, (running.get(device) ?? 0) + 1);
      // Handlers call stillAuthorized() before a side effect that follows an await; this is the check they run.
      // Counted until the response has gone out, not just until the handler returns: queued bytes stay cuttable.
      c.env.outgoing.once('close', () => running.set(device, running.get(device) - 1));
      await authority.run(() => auth.session(token).status === 0, next);
      // P2: a renewed session gets its cookie again with the new end, so the browser keeps it as long as the daemon does.
      if (result.renewed) c.header('Set-Cookie', cookie(token, result.expires - Date.now()), { append: true });
    });
    remoteApp.use('*', hardening, limit);
    remoteApp.use('*', async (c, next) => {
      await next();
      // img-src data: (threat model row 26, v0.1.6 P9): an agent's own images and attachment chips; a data: image makes no request.
      // font-src 'self' (c18): the theme picker's fonts, the same bundled files the desktop loads.
      // frame-src 'self' (item 19, row 65): the artifact frame, /frame/, which gets its own sandboxed CSP and may sit only in this origin's pages.
      c.header('Content-Security-Policy', c.req.path === '/frame/' ? FRAME_CSP + "; frame-ancestors 'self'"
        : "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; manifest-src 'self'; worker-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      c.header('Referrer-Policy', 'no-referrer');
    });
    const login = (c, { status, token, csrf, ...result }) => {
      if (token) c.header('Set-Cookie', cookie(token, SESSION_MS));
      return c.json(csrf ? { ...result, csrf } : result, status);
    };
    remoteApp.get('/login', (c) => c.html(loginPage));
    remoteApp.get('/login.js', (c) => c.body(loginScript, 200, { 'content-type': 'text/javascript; charset=utf-8' }));
    remoteApp.post('/auth/enroll', async (c) => reply(c, auth.request(await json(c))));
    remoteApp.post('/auth/enroll/:id/options', async (c) => reply(c, await auth.enrollOptions(c.req.param('id'))));
    remoteApp.post('/auth/enroll/:id/verify', async (c) => login(c, await auth.enrollVerify(c.req.param('id'), await json(c))));
    remoteApp.post('/auth/login/options', async (c) => reply(c, await auth.loginOptions()));
    remoteApp.post('/auth/login/verify', async (c) => login(c, await auth.loginVerify(await json(c))));
    // The body can take a while to arrive: re-check the session once it has, before any handler acts on it.
    remoteApp.use('*', async (c, next) => {
      if (!['GET', 'HEAD'].includes(c.req.method)) { await c.req.text(); stillAuthorized(); }
      await next();
    });
    // Operation IDs bind to the device, so one device can never replay or read another device's stored reply.
    remoteApp.use('*', operations(ledger, (c) => 'device:' + c.get('device')));
    remoteApp.get('/', (c) => c.redirect('/phone/'));
    remoteApp.get('/phone', (c) => c.redirect('/phone/'));
    remoteApp.get('/phone/', async (c) => c.html(await readAsset(path.join(webRoot, 'phone', 'index.html'), 'utf8')));
    remoteApp.get('/manifest.webmanifest', async (c) => c.body(await readAsset(path.join(webRoot, 'manifest.webmanifest')), 200,
      { 'content-type': types['.webmanifest'] }));
    remoteApp.get('/sw.js', async (c) => c.body(await readAsset(path.join(webRoot, 'sw.js')), 200,
      { 'content-type': types['.js'], 'service-worker-allowed': '/' }));
    // The theme's boot script (DuwopBoot): puts the phone's saved look on the page before it paints.
    remoteApp.get('/duwop-boot.js', async (c) => c.body(await readAsset(path.join(webRoot, 'duwop-boot.js')), 200,
      { 'content-type': types['.js'] }));
    remoteApp.get('/p9-icon.png', async (c) => c.body(await readAsset(path.join(webRoot, 'p9-icon.png')), 200,
      { 'content-type': 'image/png' }));
    remoteApp.get('/p9-icon.svg', async (c) => c.body(await readAsset(path.join(webRoot, 'p9-icon.svg')), 200,
      { 'content-type': types['.svg'] }));
    // Item 19 (row 65): the artifact frame's page, and the runtimes the phone page fetches and hands to it (Mermaid, React, TypeScript).
    remoteApp.get('/frame/', async (c) => c.html(await readAsset(path.join(webRoot, 'frame', 'index.html'), 'utf8')));
    remoteApp.get('/frame/:file', async (c) => {
      const file = c.req.param('file');
      if (!/^[a-z0-9-]+\.js$/.test(file)) return c.json({ error: 'request-refused' }, 400);
      return c.body(await readAsset(path.join(webRoot, 'frame', file)), 200, { 'content-type': types['.js'] });
    });
    remoteApp.get('/_astro/:file', async (c) => {
      const file = c.req.param('file');
      if (!/^[a-zA-Z0-9_.-]+$/.test(file)) return c.json({ error: 'request-refused' }, 400);
      // P1: build files are named by their content, so the phone keeps them (every open read 1 MB again under no-store).
      return c.body(await readAsset(path.join(webRoot, '_astro', file)), 200,
        { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'private, max-age=31536000, immutable' });
    });
    // Self-lock answers on its own socket, so that one is spared; every other socket of the device closes.
    remoteApp.post('/lock', (c) => {
      const socket = c.env.incoming.socket, device = c.get('device');
      if (busy.get(socket)?.get(device) === 1) open.get(device)?.delete(socket);  // not when another request of it runs there
      return reply(c, auth.lock(device, 'self'));
    });
    // Rebuild + reload (c18, threat model row 64): the desktop's p9:rebuild for the phone. The UI build runs in the checkout
    // this daemon serves the phone from; the phone page and its files are read from disk per request, so the next load
    // gets the new build. Chats keep running and nothing restarts. The phone only, as the desktop has its own.
    remoteApp.get('/rebuild', (c) => c.json({ available: buildable(), running: !!building }));
    remoteApp.post('/rebuild', async (c) => {
      if (!['', '{}'].includes((await c.req.text()).trim())) return c.json({ error: 'request-refused' }, 400);
      if (!buildable()) return c.json({ error: 'rebuild-unsupported' }, 403);
      if (building || update.brief()) return c.json({ error: building ? 'rebuild-running' : 'update-running' }, 409);
      building = rebuild(c.get('device')).finally(() => { building = null; });
      return reply(c, await building);
    });
    // P9 (threat model row 31): the phone's sign-in, the wizard's own login. The phone has no main, so the daemon checks
    // the URL and the code itself; POST answers carry neither, since the operations ledger keeps them.
    remoteApp.get('/phone/sign-in', async (c) => {
      const state = chat.login.state(), on = await signedIn();
      c.header('cache-control', 'no-store');
      return c.json(Object.fromEntries(Object.keys(SIGN_IN_ORIGINS).map((agent) => { const l = state[agent]; return [agent, { signedIn: on[agent],
        running: l.running, url: typeof l.url === 'string' ? signInUrl(agent, l.url) : null, code: agent === 'codex' && DEVICE_CODE.test(l.code ?? '') ? l.code : null,
        unsupported: l.unsupported, exit: l.exit }]; })));
    });
    remoteApp.post('/phone/sign-in', async (c) => reply(c, await chat.login.start(await json(c))));
    remoteApp.post('/phone/sign-in/code', async (c) => reply(c, chat.login.code(await json(c))));
    remoteApp.post('/phone/sign-in/stop', async (c) => reply(c, await chat.login.stop(await json(c))));
    remoteApp.route('/', api);
    const remoteServer = createServer(options, getRequestListener(remoteApp.fetch));
    remoteServer.on('upgrade', (request, socket, head) => {
      const route = upgradeRoute(request.url);
      if (!route) return refuse(socket, 400);
      const result = isPublic(route) ? { status: 404 } : authorizeRemote(request.headers, request.method, route, auth, remote);
      if (result.status) return refuse(socket, result.status);
      track(result.device, socket);
      // An open terminal ends with its session, not only when the next HTTP request finds it expired.
      const expiry = setTimeout(() => socket.destroy(), Math.max(0, result.expires - Date.now()));
      expiry.unref();
      socket.once('close', () => clearTimeout(expiry));
      attachTerminal(request, socket, head, route);
    });
    remoteServer.maxConnections = 32;
    return remoteServer;
  }
}
