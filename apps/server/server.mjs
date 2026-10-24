import { createServer } from 'node:http';
import { readdir, readFile as readAsset, writeFile, rename, stat, access, mkdir, open, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getRequestListener } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import { ORIGIN, MAX_BYTES, PUBLIC_ROUTES, parseSave } from '../../packages/protocol/index.mjs';
import { readFile as readWorkspaceFile, listDirectory, guardedSave, createFile, createDirectory, setProtection, protection } from '../../packages/files/index.mjs';
import { createMission, parseSettings, rootRefused, inside } from './mission.mjs';
import { createHub } from './hub.mjs';
import { openLedger, operations } from './ledger.mjs';
import { createAnymouse } from './anymouse.mjs';
import { createChat } from './chat.mjs';
import { createMcp } from './mcp.mjs';
import { createLifecycle } from './lifecycle.mjs';
import { createTerminals } from './terminals.mjs';
import { createAuth } from './auth.mjs';
import { planLimits } from './limits.mjs';
import { loginPage, loginScript } from './login-page.mjs';
import { authority, stillAuthorized } from './authority.mjs';

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
const types = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

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

export function createListener({ workspace, savedWorkspace, recovery, state, ownership, credentials, transport, settings, settingsInvalid = false, settingsFile, ledger = openLedger(':memory:'), adapterOverride, instance = 'test', tmuxSocket = 'p9-' + instance, terminalPlatform, remote, anymouse = createAnymouse() }) {
  const lifecycle = createLifecycle();
  let mission = createMission({ workspace, recovery, settings, instance, lifecycle });
  let hub = createHub({ workspace, settings });
  const chat = createChat({ ledger, workspace, adapterOverride, instance, lifecycle, socketPath: credentials?.socketPath });
  const terminals = createTerminals({ ledger, workspace, lifecycle, socket: tmuxSocket, platform: terminalPlatform });
  const auth = remote ? createAuth({ ledger, rpID: remote.rpID, origin: remote.origin }) : null;
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
  api.get('/health', async (c) => c.json({ status: 'ok', phase: 11, writes: 'guarded', ...(c.get('device') ? {} : { workspace, ...(savedWorkspace ? { savedWorkspace } : {}) }),
    recoveryRecordCount: (await readdir(recovery)).filter((name) => name.startsWith('.p9-conflict-')).length }));
  api.get('/files', async (c) => c.json(await readWorkspaceFile(workspace, c.req.query('path'))));
  api.get('/files/list', async (c) => c.json({ entries: await listDirectory(workspace, c.req.query('path') ?? '') }));
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
  api.get('/mission', async (c) => c.json({ ...(await mission.overview()), settingsError, restart: restart() }));
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
  api.get('/chat', (c) => c.json({ conversations: chat.list() }));
  api.post('/chat', async (c) => reply(c, await chat.create(await json(c))));
  api.get('/chat/events', async (c) => { const only = c.req.query('only'), until = c.req.query('until');
    return reply(c, await chat.events(Number(c.req.query('after') ?? 0), Number(c.req.query('wait') ?? 0), only === undefined ? undefined : only.split(',').filter(Boolean), until === undefined ? undefined : Number(until))); });
  api.get('/usage', async (c) => { const { claudeLive, ...usage } = ledger.usage(); return c.json({ ...usage, limits: await planLimits({ home: os.homedir(), claudeLive }) }); });
  api.post('/anymouse', async (c) => reply(c, await anymouse(await json(c))));
  api.post('/chat/:id/prompt', async (c) => reply(c, await chat.prompt(c.req.param('id'), await json(c))));
  api.post('/chat/:id/answer', async (c) => reply(c, chat.answer(c.req.param('id'), await json(c))));
  api.post('/chat/:id/cancel', async (c) => reply(c, await chat.cancel(c.req.param('id'))));
  api.post('/chat/:id/stop', async (c) => reply(c, await chat.stop(c.req.param('id'))));
  api.get('/terminals', async (c) => {
    try { return c.json({ terminals: await terminals.list() }); } catch (error) {
      if (error.message === 'tmux-not-found') return c.json({ error: 'tmux-not-found' }, 503);
      if (error.message === 'terminal-unavailable') return c.json({ error: 'terminal-unavailable', reason: error.reason }, 503);
      throw error;
    }
  });
  api.post('/terminals', async (c) => reply(c, await terminals.create(await json(c))));
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
  // Threat model row 15: only the desktop turns the agent lock on or off; reading it is on the shared api.
  app.post('/agent-lock', async (c) => reply(c, await chat.setLock(await json(c))));
  // Threat model row 4: file protection is read and changed by the desktop only; the phone just lives with it.
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
  // First-run welcome (threat model row 17): what is missing, as booleans; the credential files are stat'ed, never opened.
  // Desktop only (F2): it names the workspace and settings file, which the phone never shows.
  // ponytail: default credential paths only (no CLAUDE_CONFIG_DIR or CODEX_HOME); add them if someone moves theirs.
  // Every call re-reads the disk (the wizard stores no progress): the settings file as it is now, not as it was at start.
  const present = (file) => (file ? stat(file).then((s) => s.isFile(), () => false) : false);
  const settingsOnDisk = async () => {
    let text;
    if (!settingsFile) return {};
    try { text = await readAsset(settingsFile, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
    try { return { text, parsed: parseSettings(text) }; } catch (error) { return { text, error: String(error.message).slice(0, 200) }; }
  };
  const isFolder = (relative) => stat(path.join(workspace, relative)).then((s) => s.isDirectory(), () => false);
  // "Use what's here" (needs-done p9-wizard-respects-existing-workspace): with no settings in a folder that already has things
  // in it, what the wizard can point at instead of making its own: a workspace-hub checkout (its registry and folder), an
  // AGENTS.md at the top, a needs-you or waiting folder. Links are never followed; at most three folders deep.
  const SKIP = new Set(['node_modules', '_archive', '_private', '_intake', '_templates', 'templates', 'recommended-delete']);
  const existing = async () => {
    const found = {};
    const agents = [];
    const walk = async (relative, depth) => {
      const entries = await readdir(path.join(workspace, relative), { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isFile() && entry.name === 'AGENTS.md') agents.push(relative ? relative + '/AGENTS.md' : 'AGENTS.md');
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
      const base = path.basename(workspace) + '/';
      let records = [];
      try { const reg = JSON.parse(text); records = [...(reg.scripts ?? []), ...(reg.apps ?? [])]; } catch {}
      if (path.basename(workspace) && records.some((r) => [r?.cwd, ...(Array.isArray(r?.cmd) ? r.cmd : [])].some((v) => typeof v === 'string' && v.startsWith(base)))) {
        found.scripts_root = path.dirname(workspace);
      }
    } else if (await present(path.join(workspace, STARTER_SETTINGS.registry))) found.registry = STARTER_SETTINGS.registry;
    // primary: an AGENTS.md with the line Mission parses (**Main project: ...** (`path`)), else the top one.
    const mainLine = async (file) => /\*\*Main project: [^*]+\*\* \(`[^`]+`/.test(await readAsset(path.join(workspace, file), 'utf8').catch(() => ''));
    for (const file of agents.sort((a, b) => a.split('/').length - b.split('/').length)) if (!found.primary && await mainLine(file)) found.primary = file;
    if (!found.primary && agents.includes('AGENTS.md')) found.primary = 'AGENTS.md';
    for (const folder of ['needs-you', 'waiting']) if (!found.waiting && await isFolder(folder)) found.waiting = folder;
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
      claude: await present(path.join(os.homedir(), '.claude', '.credentials.json')), codex: await present(path.join(os.homedir(), '.codex', 'auth.json')) });
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
    for (const [relative, content] of [[paths.primary, STARTER_AGENTS], [paths.registry, '{"scripts":[],"apps":[],"pages":[]}\n'], [paths.waiting + '/AGENTS.md', STARTER_WAITING]]) {
      if (!plan.includes(relative)) continue;
      await folders(relative.split('/'));
      if (await made(createFile(workspace, relative, content))) created.push(relative);
    }
    if (plan.includes('_ideas/') && await made(createDirectory(workspace, '_ideas'))) created.push('_ideas/');
    if (repoint) {
      // The old file is kept as settings.json.bak (an older .bak is replaced); the new one lands by rename, never half written.
      if (disk.text !== undefined) await writeFile(settingsFile + '.bak', disk.text, { mode: 0o600 });
      const file = await open(settingsFile + '.tmp', 'w', 0o600);
      try { await file.writeFile(JSON.stringify(paths, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
      await rename(settingsFile + '.tmp', settingsFile);
      await reloadSettings();
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
  // Wizard sign-in (threat model row 31), desktop only: main is the only caller, and opens the URL only after its origin check.
  app.get('/setup/login', (c) => reply(c, chat.login.state()));
  app.post('/setup/login', async (c) => reply(c, await chat.login.start(await json(c))));
  app.post('/setup/login/code', async (c) => reply(c, chat.login.code(await json(c))));
  app.post('/setup/login/stop', async (c) => reply(c, await chat.login.stop(await json(c))));
  app.get('/file-protection', (c) => c.json({ on: protection() }));
  app.post('/file-protection', async (c) => {
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
  app.post('/mission/edit', editing, async (c) => {
    const { kind, confirm, ...rest } = (await json(c)) ?? {};
    if (!['apps', 'pages', 'sections'].includes(kind) || (confirm !== undefined && typeof confirm !== 'boolean')
      || !Object.keys(rest).every((name) => ['key', 'title', 'icon', 'hash'].includes(name))) return c.json({ error: 'request-refused' }, 400);
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
    });
    remoteApp.use('*', hardening, limit);
    remoteApp.use('*', async (c, next) => {
      await next();
      c.header('Content-Security-Policy', "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      c.header('Referrer-Policy', 'no-referrer');
    });
    const login = (c, { status, token, csrf, ...result }) => {
      if (token) c.header('Set-Cookie', 'p9s=' + token + '; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200');
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
    remoteApp.get('/p9-icon.png', async (c) => c.body(await readAsset(path.join(webRoot, 'p9-icon.png')), 200,
      { 'content-type': 'image/png' }));
    remoteApp.get('/p9-icon.svg', async (c) => c.body(await readAsset(path.join(webRoot, 'p9-icon.svg')), 200,
      { 'content-type': types['.svg'] }));
    remoteApp.get('/_astro/:file', async (c) => {
      const file = c.req.param('file');
      if (!/^[a-zA-Z0-9_.-]+$/.test(file)) return c.json({ error: 'request-refused' }, 400);
      return c.body(await readAsset(path.join(webRoot, '_astro', file)), 200,
        { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
    });
    // Self-lock answers on its own socket, so that one is spared; every other socket of the device closes.
    remoteApp.post('/lock', (c) => {
      const socket = c.env.incoming.socket, device = c.get('device');
      if (busy.get(socket)?.get(device) === 1) open.get(device)?.delete(socket);  // not when another request of it runs there
      return reply(c, auth.lock(device, 'self'));
    });
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
