import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session, shell, WebContentsView } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { appendFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { appendFileSync, constants, openSync, watch } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { health, daemonRequest, windowsTask, repairWindowsTask, restartWindowsTask, restartLinuxService, repairLinuxService, unitFor, appImageService, answered, AGENT_START_MS } from '../../scripts/teh.mjs';
import { connectServer, restartServer, sshHosts, serverFolder, HOST } from './remote.mjs';
import { ORIGIN } from '../../packages/protocol/index.mjs';
import { WebSocket } from 'ws';
import { contextMenu, windowsFullName } from './native.mjs';
import { startEditorHost, stopEditorHost, openInCode, hostWritable } from './editor-host.mjs';
import { offReason, startUpdater, updateAction } from './updater.mjs';
import { readState, writeState, begin, timedOut, healthy, quit, rolledBack, startHealthy, launcherCommand, promoteLauncher, readRollback, markShown,
  rollbackLog, sanitize, reportLink, shareRoot, START_MS } from './rollback.mjs';
import { REPO, NEW_ISSUE } from '../server/anymouse.mjs';

export const APP_URL = 'p9://app/';
export const DEV_URL = 'p9://dev/';
export const WEBVIEW_URL = 'p9://webview/';
export const DOCS_URL = 'https://github.com/' + REPO + '#readme';
// HI1: a Settings row's "i" opens its part of the guide (docs/guide.md headings); any other section is refused.
export const GUIDE_URL = 'https://github.com/' + REPO + '/blob/main/docs/guide.md#';
export const GUIDE_SECTIONS = Object.freeze(['settings', 'focus-modes', 'pets', 'agent-lock', 'file-protection', 'updates', 'maintenance', 'mission-control-files', 'buttons-apps-and-pages']);
// Check for updates (threat model row 28): the newest release page; GitHub's sign-in and the download happen in the browser.
export const RELEASES_URL = 'https://github.com/' + REPO + '/releases/latest';
// Settings → Pets: where pets come from (GitHub issue #4 follow-up, the owner 2026-10-20: the petdex.dev text needs a link).
export const PETDEX_URL = 'https://petdex.dev';
// placeholder: SECURITY.md § File protection exists on GitHub only once the PR merges; confirm or replace this URL then
// (the builder's needs-done list tracks it).
export const FILE_PROTECTION_DOCS = 'https://github.com/' + REPO + '/blob/main/SECURITY.md#file-protection';
export const FILE_PROTECTION_RISK = 'File protection stops P9\'s editor, here and on your paired phone, from opening or changing your secrets '
  + '(.env files and the secrets and _private folders), your git history (.git), P9\'s own recovery files (.p9-*) and the script list behind Mission buttons.\n\n'
  + 'With it off, one wrong save can break those files, and anyone holding your unlocked, paired phone can read or change them, keys included.\n\n'
  + 'Agents, terminals and editor extensions are not affected: they can already change any file you can. You can turn protection back on any time in Settings.';
// The Settings page's UI settings (threat model row 15): one fixed shape, checked here, kept in the profile folder.
// pet: each focus mode's own pet settings: shown or not, size in pixels, a petdex pet per agent (system when the agent has
// none), and where the user dragged the top pets (top) and the in-chat pets (pane), as fractions of the window and the chat.
// Skipper is the System pet a new profile starts with (the owner, 2026-10-20: "the pet we will ship as the system default").
const petLook = on => Object.freeze({ on, size: 48, claude: null, codex: null, system: 'skipper', top: null, pane: null });
// name: the landing page's greeting ('' greets with no name); startLast: open in the last used focus instead of the landing page.
export const DEFAULT_SETTINGS = Object.freeze({ zoom: 1, closeOnSend: false, focus: Object.freeze({ chat: true, dev: true, mission: true }),
  pet: Object.freeze({ chat: petLook(true), dev: petLook(false), mission: petLook(false) }), name: '', startLast: false });
const NAME = /^[^\p{Cc}\p{Cf}]{0,40}$/u;
const PET_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/, PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const exactly = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === keys;
const petName = name => name === null || (typeof name === 'string' && PET_NAME.test(name));
const spot = at => at === null || (Array.isArray(at) && at.length === 2 && at.every(n => Number.isFinite(n) && n >= 0 && n <= 1));
const checkPet = p => exactly(p, 'claude,codex,on,pane,size,system,top') && typeof p.on === 'boolean' && Number.isInteger(p.size) && p.size >= 24 && p.size <= 128
  && [p.claude, p.codex, p.system].every(petName) && spot(p.top) && spot(p.pane)
  && { on: p.on, size: p.size, claude: p.claude, codex: p.codex, system: p.system, top: p.top && [...p.top], pane: p.pane && [...p.pane] };
export function checkSettings(value) {
  if (!exactly(value, 'closeOnSend,focus,name,pet,startLast,zoom') || typeof value.closeOnSend !== 'boolean' || !Number.isFinite(value.zoom)
      || typeof value.name !== 'string' || !NAME.test(value.name) || typeof value.startLast !== 'boolean'
      || value.zoom < 0.5 || value.zoom > 3 || !exactly(value.focus, 'chat,dev,mission') || !exactly(value.pet, 'chat,dev,mission')) return null;
  const focus = value.focus, pet = { chat: checkPet(value.pet.chat), dev: checkPet(value.pet.dev), mission: checkPet(value.pet.mission) };
  if (![focus.chat, focus.dev, focus.mission].every(on => typeof on === 'boolean') || !(focus.chat || focus.dev || focus.mission)) return null;
  if (!pet.chat || !pet.dev || !pet.mission) return null;
  return { zoom: value.zoom, closeOnSend: value.closeOnSend, focus: { chat: focus.chat, dev: focus.dev, mission: focus.mission }, pet, name: value.name, startLast: value.startLast };
}
// Older files: no pet, one pet name, or one pet per agent ({ claude, codex, system }) become every focus's pets, shown in Chat only.
// Files from before the landing page get its name (the account's, below) and startLast off.
export function upgradeSettings(file, name = '') {
  const old = file?.pet;
  if (old === undefined || old === null || typeof old === 'string' || exactly(old, 'claude,codex,system')) {
    const roles = typeof old === 'string' || old == null ? { claude: null, codex: null, system: old ?? null } : old; // an older file keeps its own (no) pet
    file = { ...file, pet: Object.fromEntries(['chat', 'dev', 'mission'].map(f => [f, { ...petLook(f === 'chat'), ...roles }])) };
  }
  return { name, startLast: false, ...file };
}
// Windows keeps the full name in the output of "net user <login>"; the label is localized, so another language falls back to the login name.
// ponytail: local accounts only (a work-domain full name needs "net user /domain"); a Microsoft account with no full name set also falls back.
// The greeting's first name: the first word of the account's full name (the passwd comment on Linux, net user on Windows), else the login name.
export async function accountName() {
  const { username, uid } = os.userInfo();
  const full = process.platform === 'linux' ? (await readFile('/etc/passwd', 'utf8').catch(() => '')).split('\n').map(l => l.split(':')).find(f => f[2] === String(uid))?.[4]
    : process.platform === 'win32' ? windowsFullName(await new Promise(resolve => execFile('net', ['user', username], { windowsHide: true, timeout: 5000 }, (_error, out) => resolve(out ?? '')))) : '';
  const word = (full?.split(',')[0].trim().split(/\s+/)[0] || username || '').slice(0, 40);
  return NAME.test(word) ? word.charAt(0).toUpperCase() + word.slice(1) : '';
}
// Agent-working pets (threat model row 16): a petdex folder under <profile>/pets, read as plain files only (never a link),
// pet.json up to 16 KB, the spritesheet a bare .webp/.png name up to 8 MB with a matching signature, handed over as a data URL.
async function readPlain(file, max) {
  if ((await lstat(file)).isSymbolicLink()) throw new Error('pet-refused'); // Windows has no O_NOFOLLOW
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > max) throw new Error('pet-refused');
    return await handle.readFile();
  } finally { await handle.close(); }
}
async function readPet(pets, name) {
  if (typeof name !== 'string' || !PET_NAME.test(name)) return null;
  try {
    const folder = path.join(pets, name);
    if (!(await lstat(folder)).isDirectory()) return null;
    const meta = JSON.parse(await readPlain(path.join(folder, 'pet.json'), 16384));
    const file = meta?.spritesheetPath;
    if (typeof meta?.id !== 'string' || typeof meta.displayName !== 'string' || typeof file !== 'string'
        || file.startsWith('.') || !/^[\w.-]{1,128}\.(?:webp|png)$/i.test(file)) return null;
    const bytes = await readPlain(path.join(folder, file), 8 << 20);
    const type = bytes.subarray(0, 8).equals(PNG) ? 'png' : bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP' ? 'webp' : null;
    return type && { meta, file, bytes, type };
  } catch { return null; }
}
async function loadPet(pets, name) {
  const pet = await readPet(pets, name);
  return pet && { name, displayName: pet.meta.displayName.slice(0, 80), sprite: `data:image/${pet.type};base64,` + pet.bytes.toString('base64') };
}
// Adding copies a checked pet out of a folder the user picked: a rewritten pet.json and the sheet bytes, never over an existing pet.
async function addPet(pets, folder) {
  const name = path.basename(folder), pet = await readPet(path.dirname(folder), name);
  if (!PET_NAME.test(name)) return 'name';
  if (!pet) return 'invalid';
  const target = path.join(pets, name), { id, displayName, description = '', spritesheetPath } = pet.meta;
  await mkdir(pets, { recursive: true });
  try { await mkdir(target); } catch (error) { return error.code === 'EEXIST' ? 'exists' : 'invalid'; }
  try {
    await writeFile(path.join(target, 'pet.json'), JSON.stringify({ id, displayName, description: String(description).slice(0, 1000), spritesheetPath }, null, 2) + '\n');
    await writeFile(path.join(target, spritesheetPath), pet.bytes);
  } catch { await rm(target, { recursive: true, force: true }); return 'invalid'; }
  return null;
}
// The Dev Focus page itself (query and hash aside); any other p9://dev/ file is an asset, never a page with IPC.
const isDevPage = url => url.split(/[?#]/)[0] === DEV_URL;

// CSP hashes of a page's inline scripts (the ones without src).
const inlineHashes = html => [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
  .filter(match => !/\bsrc\s*=/.test(match[1]))
  .map(match => "'sha256-" + createHash('sha256').update(match[2]).digest('base64') + "'");

async function assets(directory, prefix = '/') {
  const result = new Map();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name), route = prefix + entry.name;
    if (entry.isDirectory()) for (const [key, value] of await assets(name, route + '/')) result.set(key, value);
    else if (entry.isFile()) result.set(route, await readFile(name));
    else throw new Error('nonregular-build-asset');
  }
  return result;
}

export async function createDesktop({ state, open } = {}) {
  // KDE/GNOME on Wayland match a window to its menu entry and icon by app id; without this it is "electron" (generic icon).
  if (process.platform === 'linux') app.setDesktopName('p9-event-horizon.desktop');
  // Lets the freeze record read the stack a hung page is stuck in (with the Document-Policy header serve() sends).
  app.commandLine.appendSwitch('enable-features', 'DocumentPolicyIncludeJSCallStacksInCrashReports');
  await app.whenReady();
  // Windows: the daemon is the user's 'P9 Foundation' Scheduled Task, which runs at logon. Not answering (it died, or was
  // stopped) means start it; the page keeps asking until it answers (GitHub issue #4: a relaunch never brought it back).
  // No task, or v0.1.1's powershell.exe one (issue #6 B3), cannot be fixed by starting it: the installed app runs the
  // installer's script again, once per launch (no retry loop). If that fails too, reason says reinstall.
  // Fixed argv, no shell, the user's own task. At most every 30 s, since each look runs PowerShell.
  // ponytail: a daemon that is running but hung stays hung (/Run on a running task does nothing); the page says not-answering.
  // changing: p9:workspace-change is between Stop All and the new task's start; a /Run then restarted the old task on the
  // old folder and the change rolled back (Fable review finding 3).
  let reason = 'not-answering', woke = 0, repaired = false, changing = false, rebuilding = false;
  const wake = async () => {
    if (changing || serverHost || Date.now() - woke < 30000) return;
    woke = Date.now();
    const task = await windowsTask();
    reason = !task ? 'task-missing' : task.execute !== 'conhost.exe' ? 'task-stale' : 'not-answering';
    if (reason !== 'not-answering' && app.isPackaged && !repaired) {
      repaired = true;
      if (await repairWindowsTask(process.resourcesPath)) { reason = 'not-answering'; return; }
    }
    if (task) execFile('schtasks.exe', ['/Run', '/TN', 'P9 Foundation'], { windowsHide: true }, () => {});
  };
  if (process.platform === 'win32' && state) health(state).catch(wake);
  // AU4: the AppImage's mount goes when it quits, so its daemon is copied out and the service installed, or restarted onto
  // the new version after an update (teh.mjs appImageService, which logs and never throws). Once per launch.
  if (process.platform === 'linux' && app.isPackaged && process.env.APPIMAGE) appImageService(process.resourcesPath);
  const webDist = fileURLToPath(new URL('../web/dist/', import.meta.url));
  const appSite = async () => {
    const files = await assets(webDist);
    const html = files.get('/index.html').toString('utf8');
    return { files, csp: `default-src 'none'; script-src 'self' ${inlineHashes(html).join(' ')}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'` };
  };
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2',
    '.woff': 'font/woff', '.ttf': 'font/ttf', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.mp3': 'audio/mpeg' };
  // Three origins: p9://app (the shell), p9://dev (Dev Focus, filled once the editor host is up) and p9://webview (its
  // extension pages). Each gets its own CSP, and each session serves only its own origins.
  const sites = { app: await appSite() };
  const serve = (...hosts) => request => {
    const url = new URL(request.url);
    const key = url.pathname === '/' ? '/index.html' : url.pathname;
    const site = hosts.includes(url.host) && Object.hasOwn(sites, url.host) ? sites[url.host] : null, data = site?.files.get(key);
    if (request.method !== 'GET' || url.username || url.password || url.port || !data) return new Response('Not found', { status: 404 });
    return new Response(data, { headers: { 'Content-Type': types[path.extname(key)] ?? 'application/octet-stream', 'Content-Security-Policy': site.csp, 'X-Content-Type-Options': 'nosniff', 'Document-Policy': 'include-js-call-stacks-in-crash-reports' } });
  };
  protocol.handle('p9', serve('app'));
  const settingsFile = path.join(app.getPath('userData'), 'p9-settings.json');
  const name = await accountName();
  let settings = checkSettings(await readFile(settingsFile, 'utf8').then(text => upgradeSettings(JSON.parse(text), name)).catch(() => null)) ?? { ...structuredClone(DEFAULT_SETTINGS), name };
  let settingsSaving = Promise.resolve();
  // Server mode (remote.mjs, threat model row 50): while a host is chosen, state is that server's forward, else this machine's
  // daemon. Both daemons keep running; switching reloads the window onto the other. The choice is kept in p9-server.json.
  const localState = state, serverFile = path.join(app.getPath('userData'), 'p9-server.json');
  const sshCommand = (!app.isPackaged && process.env.P9_SSH) || 'ssh'; // P9_SSH: the tests' stand-in, source checkouts only
  // last: the host used before, so Local can show a one-click way back.
  const saved = await readFile(serverFile, 'utf8').then(text => JSON.parse(text), () => ({})), named = h => typeof h === 'string' && HOST.test(h) ? h : null;
  let serverHost = named(saved?.host), serverLast = named(saved?.last) ?? serverHost, server = null, serverError = null, serverTry = 0;
  // One attempt chain per choice (serverTry): retried 1 s, then doubling to 30 s; a drop starts it again.
  const connect = async (attempt, wait = 1000) => {
    if (attempt !== serverTry || !serverHost) return;
    try {
      const s = await connectServer({ host: serverHost, ssh: sshCommand, onDrop: () => { if (attempt === serverTry) { server = null; serverError = 'server-dropped'; connect(attempt); } } });
      if (attempt !== serverTry) return void s.close();
      server = s; serverError = null;
    } catch (error) {
      serverError = error.message;
      if (attempt === serverTry) setTimeout(() => connect(attempt, Math.min(wait * 2, 30000)), wait);
    }
  };
  const useServer = async host => {
    const attempt = ++serverTry, old = server;
    server = null; serverError = null; serverHost = host; serverLast = host ?? serverLast;
    state = host ? serverFolder(host) : localState;
    await old?.close().catch(() => {});
    await writeFile(serverFile, JSON.stringify({ host, last: serverLast }), { mode: 0o600 });
    connect(attempt);
  };
  if (serverHost) { state = serverFolder(serverHost); connect(++serverTry); }
  app.on('will-quit', () => { serverTry++; server?.close().catch(() => {}); });
  const petsFolder = path.join(app.getPath('userData'), 'pets');
  // A profile with no pets folder yet gets the bundled Skipper through Add's checks; one the user removes stays removed.
  if (!(await lstat(petsFolder).catch(() => null))) await addPet(petsFolder, fileURLToPath(new URL('pets/skipper', import.meta.url))).catch(() => null);
  // Copy buttons write plain text (threat model row 19) and turn-finished notices show (row 21); everything else, clipboard read included, stays refused.
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'clipboard-sanitized-write' || permission === 'notifications'));
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => permission === 'clipboard-sanitized-write' || permission === 'notifications');
  // P9's own package.json, not app.getVersion(): started as electron start.cjs (scripts/p9.mjs, the tests) that is Electron's version.
  const version = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).version;
  // Auto-update's lines (threat model row 39) and the rollback's (row 40) go to p9-update.log in the profile folder.
  // ponytail: never rotated, a few lines per check.
  const updateLog = line => appendFile(path.join(app.getPath('userData'), 'p9-update.log'), new Date().toISOString() + ' ' + line + '\n').catch(() => {});
  // AU5 (threat model row 40, rollback.mjs): wherever updates are on, each start is watched. A version never seen healthy
  // that has failed 2 starts goes back to the newest healthy one, through the launcher outside the install, and quits.
  const watched = offReason({ packaged: app.isPackaged, resources: process.resourcesPath, platform: process.platform, env: process.env }) === null;
  const startFile = path.join(app.getPath('userData'), 'update-state.json'), share = shareRoot();
  const goBack = (start, to) => {
    // Sync lines, and the exit only once the launcher's start is known: app.exit drops pending writes.
    const line = text => { try { appendFileSync(path.join(app.getPath('userData'), 'p9-update.log'), new Date().toISOString() + ' ' + text + '\n'); } catch {} };
    rolledBack(start, version);
    try { writeState(startFile, start); } catch (error) { line('update-state.json not written: ' + error.message); }
    line(`rollback: ${version} failed 2 starts, going back to ${to}`);
    const { file, args, env, launcher } = launcherCommand({ to, from: version });
    // The exact command, and the names (not values) of what it inherits: the CI step replays it.
    line('rollback launcher command: ' + JSON.stringify(launcher ?? [file, ...args]));
    line('rollback launcher env names: ' + Object.keys(env).sort().join(','));
    if (process.platform === 'win32') {
      // The hop (rollback.mjs launcherCommand): the app exits once it has reported the launcher's pid; the launcher is
      // outside libuv's job, so ending the hop with the app does not end it. Pipes, not a log file: an inherited fd would
      // cost the hop its CREATE_NO_WINDOW. Not 'close': the launcher inherits the pipes' handles and holds them open.
      let output = '', errors = '', finished = false;
      const done = (text) => { if (finished) return; finished = true; clearTimeout(timer); line(text); app.exit(0); };
      const timer = setTimeout(() => done('rollback launcher did not start: the hop did not answer in 60 s'), 60000);
      try {
        const hop = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
        hop.stdout.on('data', (data) => {
          output += data;
          const pid = /launcher pid (\d+)/.exec(output)?.[1];
          if (pid) done(`rollback launcher started (pid ${pid})`);
        });
        hop.stderr.on('data', (data) => { errors += data; });
        hop.on('error', (error) => done('rollback launcher did not start: ' + error.message));
        // Output still in the pipe when the hop exits gets 1 s.
        hop.on('exit', (code) => setTimeout(() => done(`rollback launcher did not start: hop exit ${code}: ` + (output + errors).slice(-2000)), 1000));
      } catch (error) { done('rollback launcher did not start: ' + error.message); }
      return;
    }
    // The launcher's own output (an sh error before its first rollback.log line) goes to rollback-launch.log beside
    // rollback.log, not into it.
    let out = 'ignore';
    try { out = openSync(path.join(share, 'rollback-launch.log'), 'a'); } catch (error) { line('rollback-launch.log not opened: ' + error.message); }
    try {
      const child = spawn(file, args, { detached: true, stdio: ['ignore', out, out], windowsHide: true, env });
      child.on('spawn', () => { line(`rollback launcher started (pid ${child.pid})`); child.unref(); app.exit(0); });
      child.on('error', error => { line('rollback launcher did not start: ' + error.message); app.exit(0); });
    } catch (error) { line('rollback launcher did not start: ' + error.message); app.exit(0); }
  };
  // A deliberate quit (the user quits or closes the last window) before the start is healthy clears it; a crash emits no
  // event, so it still counts at the next start. Sync: Electron does not wait for promises on quit. session-end is a Windows
  // logoff or shutdown, which skips before-quit. app.exit (goBack) emits neither.
  const quitting = () => {
    const now = readState(startFile);
    if (!quit(now, version)) return;
    try { writeState(startFile, now); } catch (error) { updateLog('update-state.json not written: ' + error.message); }
    updateLog(`quit before a healthy start of ${version}: not counted`);
  };
  if (watched) {
    const start = readState(startFile), to = begin(start, version);
    // A profile folder that cannot be written loses the watch, not the app.
    try { writeState(startFile, start); } catch (error) { updateLog('update-state.json not written: ' + error.message); }
    if (to) { goBack(start, to); return null; }
    app.on('before-quit', quitting);
  }
  // MT1: Rebuild + reload is for source checkouts only; P9_PACKAGED=1 lets a test see what a packaged build shows.
  const source = !app.isPackaged && process.env.P9_PACKAGED !== '1';
  const window = new BrowserWindow({ width: 1440, height: 900, minWidth: 720, minHeight: 600, backgroundColor: '#000000',
    webPreferences: { preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)), sandbox: true, contextIsolation: true,
      nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
      additionalArguments: ['--p9-version=' + version, ...(process.env.P9_LANDING === 'off' ? ['--p9-landing=off'] : []), // the test runs click the shell straight away
        ...(source ? ['--p9-source'] : [])] } });
  window.removeMenu();
  if (watched) {
    window.on('session-end', quitting);
    const ready = new Promise(resolve => window.once('ready-to-show', resolve));
    startHealthy({ version, ready, health: () => health(state) }).then(ok => {
      const start = readState(startFile);
      if (ok) {
        healthy(start, version);
        writeState(startFile, start);
        updateLog('healthy start ' + version);
        return promoteLauncher(share).then(promoted => promoted && updateLog('launcher promoted'));
      }
      if (start.pending !== version) return; // quit first: not counted (timedOut checks the same)
      const to = timedOut(start, version);
      if (to) return goBack(start, to);
      writeState(startFile, start);
      updateLog(`start of ${version} not healthy in ${START_MS / 1000} s (${start.failed[version] ?? 0} of 2${start.healthy.length ? '' : ', no healthy version to go back to'})`);
    }).catch(error => updateLog('start check failed: ' + error.message));
    // The restored version, once: what happened, loudly, and the bug report the user files under their own login.
    ready.then(async () => {
      const record = await readRollback(share);
      if (!record || record.shown || record.to !== version) return;
      markShown(share, record);
      const log = sanitize(await rollbackLog({ share, profile: app.getPath('userData') }));
      updateLog('rollback notice shown');
      const { response } = await dialog.showMessageBox(window, { type: 'warning', title: 'P9 went back to ' + record.to,
        message: `P9 ${record.from} did not start, so P9 went back to ${record.to}.`,
        detail: 'Your workspace and chats are as you left them, and P9 works as before. P9 will not install ' + record.from
          + ' again; a newer version will come as usual.\n\nReport on GitHub opens a prefilled bug report in your browser with the log below '
          + '(home folder, user and host names, tokens and IP addresses removed). Read it, then submit it under your own login.\n\n' + log,
        buttons: ['Report on GitHub', 'Close'], defaultId: 0, cancelId: 1, noLink: true });
      if (response !== 0) return;
      const link = reportLink({ from: record.from, to: record.to, log });
      if (process.env.P9_OPEN_URL) spawn(process.env.P9_OPEN_URL, [link], { shell: false, stdio: 'ignore' }).on('error', () => {});
      else await shell.openExternal(link);
    }).catch(error => updateLog('rollback notice failed: ' + error.message));
  }
  window.webContents.on('dom-ready', () => window.webContents.setZoomFactor(settings.zoom));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('context-menu', (_event, params) => {
    const menu = contextMenu(params, word => window.webContents.replaceMisspelling(word), word => window.webContents.session.addWordToSpellCheckerDictionary(word));
    if (menu.length) Menu.buildFromTemplate(menu).popup({ window });
  });
  window.webContents.on('will-navigate', (event, url) => { if (url !== APP_URL) event.preventDefault(); });
  window.webContents.on('will-frame-navigate', event => { if (!event.isMainFrame) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  // Freeze record (Builder, 2026-10-20: the window freezes "and i just need to close and reopen the app"): when the window
  // stops answering, the JavaScript it is stuck in goes to p9-freeze.log in the profile folder, then how long it lasted.
  // "no stack" means it was stuck outside JavaScript (layout, paint, an IPC wait). ponytail: never rotated, a few lines per freeze.
  const note = line => appendFile(path.join(app.getPath('userData'), 'p9-freeze.log'), new Date().toISOString() + ' ' + line + '\n').catch(() => {});
  let frozeAt = 0;
  window.webContents.on('unresponsive', async () => {
    frozeAt = Date.now(); note('window unresponsive');
    const stack = await Promise.race([window.webContents.mainFrame.collectJavaScriptCallStack().catch(() => null), new Promise(resolve => setTimeout(resolve, 5000))]);
    note(stack ? 'stuck in:' + stack.replace(/\s*\n\s*/g, ' | ') : 'no stack: not stuck in JavaScript');
  });
  window.webContents.on('responsive', () => note(`window responsive again after ${Math.round((Date.now() - frozeAt) / 1000)} s`));
  window.webContents.on('render-process-gone', (_event, details) => note('window process gone: ' + details.reason));
  app.on('child-process-gone', (_event, details) => note(details.type + ' process gone: ' + details.reason));
  let persistent = true, stoppingBeforeQuit = false;
  ipcMain.handle('p9:lifecycle', async (event, action, payload) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== APP_URL
        || action !== 'mode' || !payload || Object.keys(payload).join(',') !== 'persistent' || typeof payload.persistent !== 'boolean') throw new Error('ipc-sender-refused');
    persistent = payload.persistent;
    return { ok: true };
  });
  app.on('before-quit', (event) => {
    // Server mode: quitting this window never stops the server's chats (the owner, 2026-10-26); the phone may be in one.
    if (persistent || stoppingBeforeQuit || !state || serverHost) return;
    event.preventDefault();
    stoppingBeforeQuit = true;
    daemonRequest(state, 'POST', '/stop-all', {}, randomBytes(16).toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*/, '$1-$2-$3-$4-$5'))
      .catch(() => {}).finally(() => app.quit());
  });
  ipcMain.handle('p9:get-status', async (event, ...args) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== APP_URL || args.length) throw new Error('ipc-sender-refused');
    // savedWorkspace: the saved folder was not there at the daemon's start, so it runs on the default (apps/server/main.mjs).
    // Server mode: mode and host for the title-bar badge; error says why it is not connected yet (remote.mjs codes).
    if (serverHost) {
      const h = await server?.check().catch(() => null);
      return h?.status === 'ok' ? { status: 'ok', mode: 'server', host: serverHost } : { status: 'unavailable', mode: 'server', host: serverHost, error: serverError ?? 'server-connecting' };
    }
    try {
      const h = state && await health(state);
      if (h?.status === 'ok') return { status: 'ok', ...(h.savedWorkspace ? { savedWorkspace: h.savedWorkspace, workspace: h.workspace } : {}) };
    } catch {}
    if (process.platform !== 'win32' || !state) return { status: 'unavailable' };
    await wake();
    return { status: 'unavailable', reason };
  });
  ipcMain.handle('p9:usage', async (event, ...args) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== APP_URL || args.length) throw new Error('ipc-sender-refused');
    if (!state) return { status: 503, body: { state: 'unavailable' } };
    try { return await daemonRequest(state, 'GET', '/usage'); }
    catch { return { status: 503, body: { state: 'unavailable' } }; }
  });
  // Anymouse: the daemon files the note, or answers with GitHub's prefilled new-issue page for P9's repo, which only
  // this exact prefix (anymouse.mjs NEW_ISSUE) may open (in the user's browser). ponytail: P9_OPEN_URL swaps the browser for a test logger.
  ipcMain.handle('p9:anymouse', async (event, ...args) => {
    const [payload] = args;
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== APP_URL
        || args.length !== 1 || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('ipc-sender-refused');
    if (!state) return { status: 503, body: { error: 'daemon-unavailable' } };
    let result;
    try { result = await daemonRequest(state, 'POST', '/anymouse', payload); }
    catch { return { status: 503, body: { error: 'daemon-unavailable' } }; }
    const open = result.body?.open;
    if (open === undefined) return result;
    if (typeof open !== 'string' || !open.startsWith(NEW_ISSUE) || /[\s]/.test(open)) return { status: 502, body: { error: 'request-refused' } };
    if (process.env.P9_OPEN_URL) spawn(process.env.P9_OPEN_URL, [open], { shell: false, stdio: 'ignore' }).on('error', () => {});
    else await shell.openExternal(open);
    return { status: 200, body: { opened: true, cut: result.body.cut === true } };
  });
  // Wizard sign-in (threat model row 31): the daemon runs the agent's own login CLI. "Browser didn't open?" opens the
  // URL the CLI printed only if its parsed origin is that vendor's sign-in page (no prefix match: claude.com.evil.example
  // and claude.com@evil.example fail). The page sees whether a URL exists, never the URL or any other output.
  const SIGN_IN_ORIGINS = { claude: ['https://claude.com', 'https://claude.ai', 'https://console.anthropic.com'], codex: ['https://auth.openai.com'] };
  const vendorUrl = (agent, text) => { try { const url = new URL(text); return SIGN_IN_ORIGINS[agent].includes(url.origin) ? url.href : null; } catch { return null; } };
  ipcMain.handle('p9:agent-login', async (event, ...args) => {
    const [action, agent, code] = args;
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== APP_URL
        || !['state', 'start', 'open', 'code', 'stop'].includes(action) || args.length !== (action === 'code' ? 3 : action === 'state' ? 1 : 2)
        || (action !== 'state' && (typeof agent !== 'string' || !Object.hasOwn(SIGN_IN_ORIGINS, agent)))) throw new Error('ipc-sender-refused');
    if (!state) return { status: 503, body: { error: 'daemon-unavailable' } };
    try {
      if (action === 'start') return await daemonRequest(state, 'POST', '/setup/login', { agent });
      if (action === 'code') return await daemonRequest(state, 'POST', '/setup/login/code', { agent, code });
      if (action === 'stop') return await daemonRequest(state, 'POST', '/setup/login/stop', { agent });
      const result = await daemonRequest(state, 'GET', '/setup/login');
      if (result.status !== 200) return result;
      if (action === 'state') return { status: 200, body: Object.fromEntries(Object.keys(SIGN_IN_ORIGINS).map(name => [name,
        { running: result.body[name]?.running === true, url: typeof result.body[name]?.url === 'string' && vendorUrl(name, result.body[name].url) !== null,
          exit: Number.isInteger(result.body[name]?.exit) ? result.body[name].exit : null }])) };
      const open = typeof result.body[agent]?.url === 'string' ? vendorUrl(agent, result.body[agent].url) : null;
      if (!open) return { status: 409, body: { error: 'no-sign-in-page' } };
      if (process.env.P9_OPEN_URL) spawn(process.env.P9_OPEN_URL, [open], { shell: false, stdio: 'ignore' }).on('error', () => {});
      else await shell.openExternal(open);
      return { status: 200, body: { opened: true } };
    } catch { return { status: 503, body: { error: 'daemon-unavailable' } }; }
  });
  // Mission Control: a fixed list of actions, each mapped to one daemon route; the daemon validates the rest.
  const id = value => (typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value) ? value : null);
  const missionRoutes = {
    overview: () => ['GET', '/mission'],
    run: ({ id: script, ...body }) => id(script) && ['POST', `/scripts/${script}/run`, body],
    output: ({ run, from }) => /^[0-9a-f-]{36}$/.test(run ?? '') && Number.isSafeInteger(from) && from >= 0 && ['GET', `/runs/${run}?from=${from}`],
    launch: ({ kind, id: target, ...body }) => ['apps', 'pages'].includes(kind) && id(target) && ['POST', `/${kind}/${target}/launch`, body],
    answer: body => ['POST', '/mission/answer', body],
    hub: () => ['GET', '/mission/hub'],
    hubText: ({ kind, host = '', name = '' }) => [kind, host, name].every(v => typeof v === 'string') && ['GET', '/mission/hub/text?' + new URLSearchParams({ kind, host, name })],
    hubDecide: body => ['POST', '/mission/hub/decide', body],
    fix: ({ host, name }) => [host, name].every(v => typeof v === 'string') && ['POST', '/mission/fix', { host, name }],
    idea: ({ name, text, needs_done }) => [name, text].every(v => typeof v === 'string') && typeof needs_done === 'boolean' && ['POST', '/mission/idea', { name, text, needs_done }],
    // Chat Focus file browser (threat model row 23): read-only; the daemon applies the file routes' path and File protection rules.
    list: ({ path: dir = '' }) => typeof dir === 'string' && ['GET', '/files/list?' + new URLSearchParams({ path: dir })],
    read: ({ path: file }) => typeof file === 'string' && ['GET', '/files?' + new URLSearchParams({ path: file })],
    // Notes (threat model row 34): the daemon checks the root name against settings, the path, .md and File protection.
    notes: ({ root }) => id(root) && ['GET', '/mission/notes?' + new URLSearchParams({ root })],
    noteRead: ({ root, path: file }) => id(root) && typeof file === 'string' && ['GET', '/mission/notes/file?' + new URLSearchParams({ root, path: file })],
    noteSave: body => ['POST', '/mission/notes/save', body],
    noteCreate: body => ['POST', '/mission/notes/create', body],
    noteRename: body => ['POST', '/mission/notes/rename', body],
    // The Mission edit form (names and icons): the daemon checks the kind, fields, hash and File protection.
    editState: () => ['GET', '/mission/edit'],
    edit: body => ['POST', '/mission/edit', body],
    // Tile art (threat model row 44): the daemon's cache of site icons and pictures; programs the daemon cannot find an icon for
    // (not Linux) are asked of the OS below, with app.getFileIcon.
    icons: () => ['GET', '/mission/icons'],
  };
  // The program on PATH (or the absolute path) that an app's first command word names, or null.
  const programPath = async (name) => {
    if (path.isAbsolute(name)) return name;
    for (const folder of (process.env.PATH ?? '').split(path.delimiter)) {
      for (const ext of process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE').split(';')] : ['']) {
        const file = path.join(folder, name + ext);
        if (folder && await stat(file).then(info => info.isFile(), () => false)) return file;
      }
    }
    return null;
  };
  ipcMain.handle('p9:mission', async (event, ...args) => {
    const [action, payload = {}] = args;
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== APP_URL
        || args.length > 2 || !Object.hasOwn(missionRoutes, action) || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('ipc-sender-refused');
    const route = missionRoutes[action](payload);
    if (!route) return { status: 400, body: { error: 'request-refused' } };
    if (!state) return { status: 503, body: { error: 'daemon-unavailable' } };
    try {
      const result = await daemonRequest(state, route[0], route[1], route[2], undefined, action === 'fix' ? AGENT_START_MS : undefined);
      if (action === 'icons' && result.status === 200) {
        const { programs = [], ...art } = result.body;
        for (const { id: app_id, program } of programs) {
          try {
            const file = await programPath(program), image = file && await app.getFileIcon(file, { size: 'large' });
            if (image && !image.isEmpty()) (art.apps[app_id] ??= {}).auto = image.toDataURL();
          } catch {}
        }
        return { status: 200, body: art };
      }
      return result;
    }
    catch { return { status: 503, body: { error: 'daemon-unavailable' } }; }
  });
  // The Mission edit form's Picture button (ME6, row 44): the native file picker, then the file's bytes for the form to send with its Save.
  // Nothing is written here; the daemon checks the bytes' type and size again and stores the file only after the guarded save's checks.
  ipcMain.handle('p9:pick-picture', async (event, ...args) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== APP_URL || args.length) throw new Error('ipc-sender-refused');
    const pick = await dialog.showOpenDialog(window, { title: 'Choose a picture', buttonLabel: 'Use picture', properties: ['openFile'],
      filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'webp', 'ico', 'svg'] }] });
    if (pick.canceled || !pick.filePaths[0]) return null;
    const info = await stat(pick.filePaths[0]).catch(() => null);
    if (!info?.isFile()) return { error: 'picture-unreadable' };
    if (info.size > 256_000) return { error: 'picture-too-big' };
    // mime only to preview the choice in the form; the daemon decides what the bytes are
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', ico: 'image/x-icon', svg: 'image/svg+xml' }[path.extname(pick.filePaths[0]).slice(1).toLowerCase()] ?? 'image/png';
    return { data: (await readFile(pick.filePaths[0])).toString('base64'), mime };
  });
  // Chat: the same pattern. The renderer may name its own operation ID so a retry after a lost reply is not run twice.
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
  const wizardPaths = body => Object.entries(body).every(([key, value]) => ['primary', 'registry', 'waiting', 'hub', 'scripts_root'].includes(key) && typeof value === 'string' && value.length <= 400);
  // Settings → Mission Control files (ST1/ST2): settings.json keys only, small values (null removes one); the daemon checks
  // the rest as it checks the file itself.
  const SETTINGS_KEYS = ['primary', 'registry', 'waiting', 'scripts_root', 'hub', 'space', 'page_schemes', 'server_host', 'notes_roots'];
  const short = value => typeof value === 'string' && value.length <= 400;
  const settingsChange = body => Object.keys(body).length > 0 && Object.entries(body).every(([key, value]) => SETTINGS_KEYS.includes(key) && (value === null || short(value)
    || (Array.isArray(value) && value.length <= 16 && value.every(short))
    || (key === 'notes_roots' && typeof value === 'object' && Object.keys(value).length <= 16 && Object.entries(value).every(([name, folder]) => name.length <= 64 && short(folder)))));
  const chatRoutes = {
    list: () => ['GET', '/chat'],
    // only/until (E2): one chat's history, or the chats still running at launch; the daemon checks them again.
    events: ({ after = 0, wait = 0, only, until }) => Number.isSafeInteger(after) && after >= 0 && Number.isSafeInteger(wait) && wait >= 0 && wait <= 8000
      && (only === undefined || Array.isArray(only) && only.length <= 100 && only.every(uuid)) && (until === undefined || Number.isSafeInteger(until) && until >= 0)
      && ['GET', `/chat/events?after=${after}&wait=${wait}${only ? '&only=' + only.join(',') : ''}${until === undefined ? '' : '&until=' + until}`],
    create: body => ['POST', '/chat', body],
    prompt: ({ id: chat, ...body }) => uuid(chat) && ['POST', `/chat/${chat}/prompt`, body],
    answer: ({ id: chat, ...body }) => uuid(chat) && ['POST', `/chat/${chat}/answer`, body],
    cancel: ({ id: chat }) => uuid(chat) && ['POST', `/chat/${chat}/cancel`],
    unhold: ({ id: chat, held }) => uuid(chat) && uuid(held) && ['POST', `/chat/${chat}/unhold`, { held }],
    stop: ({ id: chat, close, ...rest }) => uuid(chat) && (close === undefined || close === true) && !Object.keys(rest).length && ['POST', `/chat/${chat}/stop`, ...(close ? [{ close }] : [])],
    handoff: ({ id: chat }) => uuid(chat) && ['POST', `/chat/${chat}/handoff`],
    image: ({ id: chat, hash }) => uuid(chat) && typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash) && ['GET', `/chat/${chat}/images/${hash}`],
    lock: () => ['GET', '/agent-lock'],
    // The wizard's paths ride as plain text (the daemon parses them as settings.json would): GET /setup's plan for them, and
    // "Create my starter files" with them; {} is the settings file's paths, or the starter set in an empty folder.
    setup: body => wizardPaths(body) && ['GET', '/setup' + (Object.keys(body).length ? '?' + new URLSearchParams(body) : '')],
    starter: body => wizardPaths(body) && ['POST', '/setup/starter', body],
    missionFiles: body => !Object.keys(body).length && ['GET', '/setup/settings'],
    saveMissionFiles: body => settingsChange(body) && ['POST', '/setup/settings', body],
    setLock: body => ['POST', '/agent-lock', body],
    stopAll: body => !Object.keys(body).length && ['POST', '/stop-all', body],
  };
  ipcMain.handle('p9:chat', async (event, ...args) => {
    const [action, payload = {}] = args;
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== APP_URL
        || args.length > 2 || !Object.hasOwn(chatRoutes, action) || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('ipc-sender-refused');
    const { op, ...rest } = payload;
    const route = (op === undefined || uuid(op)) && chatRoutes[action](rest);
    if (!route) return { status: 400, body: { error: 'request-refused' } };
    if (!state) return { status: 503, body: { error: 'daemon-unavailable' } };
    try { return await daemonRequest(state, route[0], route[1], route[2], op, action === 'prompt' ? AGENT_START_MS : undefined); }
    catch { return { status: 503, body: { error: 'daemon-unavailable' } }; }
  });
  // Terminal dock (Builder, 2026-10-18: a real shell in the dock; threat model row 13): one of P9's own tmux sessions, the same
  // routes and socket the phone uses, over the daemon's desktop socket with the desktop's credentials, which the page never
  // holds. One socket at a time; frames pass through as they are (the page stamps keys with the daemon's leases, like the
  // phone) and the daemon checks every one. Each socket has a serial, so the page can tell a new socket's frames from an old one's.
  const fromApp = event => event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === APP_URL;
  // Test-only: the UI tests' sample data (test/sample-data.mjs), never in a packaged build (GitHub issue #4). JSON drops its helpers.
  const sample = !app.isPackaged && process.env.P9_SAMPLE_DATA === '1'
    ? JSON.parse(JSON.stringify((await import(new URL('../../test/sample-data.mjs', import.meta.url).href)).M)) : null;
  ipcMain.on('p9:sample', event => { event.returnValue = event.sender === window.webContents ? sample : null; }); // asked while the preload runs, before the frame has its URL
  const terminalRoutes = { list: () => ['GET', '/terminals'], create: () => ['POST', '/terminals', {}], stop: ({ id: shell }) => uuid(shell) && ['POST', '/terminals/' + shell + '/stop', {}] };
  ipcMain.handle('p9:terminal', async (event, ...args) => {
    const [action, payload = {}] = args;
    if (!fromApp(event) || args.length > 2 || !Object.hasOwn(terminalRoutes, action) || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('ipc-sender-refused');
    const route = terminalRoutes[action](payload);
    if (!route) return { status: 400, body: { error: 'request-refused' } };
    if (!state) return { status: 503, body: { error: 'daemon-unavailable' } };
    try { return await daemonRequest(state, ...route); }
    catch { return { status: 503, body: { error: 'daemon-unavailable' } }; }
  });
  let dockSocket = null, dockSerial = 0;
  const endDock = () => { dockSerial++; dockSocket?.terminate(); dockSocket = null; };
  // Settings > Server: no argument reads the mode and the ~/.ssh/config hosts; null is Local; a host name connects there, and
  // the window reloads onto that daemon. Neither daemon is stopped.
  ipcMain.handle('p9:server', async (event, ...args) => {
    if (!fromApp(event) || args.length > 1 || (args.length && args[0] !== null && (typeof args[0] !== 'string' || !HOST.test(args[0])))) throw new Error('ipc-sender-refused');
    if (!args.length) return { host: serverHost, last: serverLast, connected: !!server, error: server ? null : serverError, hosts: await sshHosts() };
    endDock();
    await useServer(args[0]);
    setTimeout(() => { if (!window.isDestroyed()) window.webContents.reload(); });
    return { ok: true };
  });
  ipcMain.handle('p9:terminal-open', async (event, ...args) => {
    if (!fromApp(event) || args.length !== 1 || !uuid(args[0])) throw new Error('ipc-sender-refused');
    endDock();
    const serial = dockSerial;
    const credentials = state && await readFile(path.join(state, 'desktop.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (serial !== dockSerial) return null;  // a newer open came in meanwhile
    if (!credentials) return null;
    const ws = new WebSocket('ws+unix:' + (credentials.socketPath ?? path.join(state, 'daemon.sock')) + ':/terminals/' + args[0] + '/socket',
      { origin: ORIGIN, headers: { host: 'p9.local', cookie: 'p9=' + credentials.cookie, 'x-p9-csrf': credentials.csrf } });
    dockSocket = ws;
    const tell = message => { if (!window.isDestroyed()) window.webContents.send('p9:terminal', serial, message); };
    ws.on('open', () => tell({ open: true }));
    ws.on('message', (data, binary) => tell(binary ? { bytes: new Uint8Array(data) } : { text: String(data) }));
    ws.on('close', code => { if (dockSocket === ws) dockSocket = null; tell({ close: code }); });
    ws.on('error', () => {});  // a close follows
    return serial;
  });
  // A key frame is a lease and at most 32 KiB (the page's paste pieces); the one text frame is a resize.
  ipcMain.on('p9:terminal-send', (event, ...args) => {
    const [serial, frame] = args;
    if (!fromApp(event) || args.length !== 2 || serial !== dockSerial || dockSocket?.readyState !== WebSocket.OPEN) return;
    if (typeof frame === 'string' ? frame.length <= 64 : frame instanceof Uint8Array && frame.length > 8 && frame.length <= 8 + 32768) dockSocket.send(frame);
  });
  ipcMain.on('p9:terminal-close', (event, ...args) => { if (fromApp(event) && args.length === 1 && args[0] === dockSerial) endDock(); });
  // A reload (hot reload included) leaves no tmux client behind; the new page opens its own.
  window.webContents.on('did-start-loading', endDock);
  // Dev Focus: the editor page in its own view, session and origin, laid over the shell's Dev pane. Started on first open.
  // A failed start or a crashed page is rebuilt on the next open; the editor host, once up, is kept.
  // devFolder: Open Folder's choice ({ path, outside }), null for the workspace; kept until restart or Back to the workspace.
  // devServing: the folder the loaded page was given (its saves go there).
  let dev = null, devView = null, editorHost = null, look = null, devReady = false, queued = [], devFolder = null, devServing = null;
  const fromDev = event => devView && event.sender === devView.webContents && event.senderFrame === devView.webContents.mainFrame && isDevPage(event.senderFrame.url);
  const startHost = () => editorHost ??= (async () => {
    // The quit handler exists before the host does, so a quit during startup still stops it. Synchronous: Electron does not
    // wait for promises on quit, and the host must not outlive the app.
    // Quit before systemd has made the scope: the stop finds nothing, so the abort kills the server process too.
    const unit = 'p9-editor-host-' + randomBytes(4).toString('hex'), quit = new AbortController();
    app.once('will-quit', () => { stopEditorHost(unit); quit.abort(); });
    return startEditorHost({ unit, signal: quit.signal });
  })().catch(error => { editorHost = null; throw error; });
  const openDev = () => dev ??= (async () => {
    const devSession = session.fromPartition('persist:p9-dev');
    if (!devSession.protocol.isProtocolHandled('p9')) devSession.protocol.handle('p9', serve('dev', 'webview'));
    // An extension page's files are asked for at https://*.vscode-cdn.net and answered by VS Code's service worker from the
    // editor host; a request that gets past it never leaves the machine.
    devSession.webRequest.onBeforeRequest({ urls: ['*://*.vscode-cdn.net/*'] }, (_details, callback) => callback({ cancel: true }));
    devReady = false;
    if (devView) { window.contentView.removeChildView(devView); devView.webContents.close(); }
    devSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'clipboard-sanitized-write'));
    devSession.setPermissionCheckHandler((_contents, permission) => permission === 'clipboard-sanitized-write');
    devView = new WebContentsView({ webPreferences: { preload: fileURLToPath(new URL('./dev-preload.cjs', import.meta.url)), session: devSession, sandbox: true,
      contextIsolation: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false } });
    devView.setBackgroundColor('#05070e');
    devView.webContents.on('dom-ready', () => devView?.webContents.setZoomFactor(settings.zoom));
    devView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    devView.webContents.on('will-navigate', (event, url) => { if (!isDevPage(url)) event.preventDefault(); });
    // Subframes (the workbench's webviews) stay on p9://dev/ and p9://webview/; the CSP's frame-src says the same.
    devView.webContents.on('will-frame-navigate', event => { if (!event.isMainFrame && !event.url.startsWith(DEV_URL) && !event.url.startsWith(WEBVIEW_URL) && !/^about:(blank|srcdoc)$/.test(event.url)) event.preventDefault(); });
    devView.webContents.on('will-attach-webview', event => event.preventDefault());
    devView.webContents.on('render-process-gone', () => { dev = null; devReady = false; });
    // Ctrl/Alt+1/2/3 switch focus from inside the editor too: hand the key to the shell.
    devView.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && (input.control || input.alt) && !input.shift && ['1', '2', '3'].includes(input.key)) {
        event.preventDefault();
        window.webContents.focus();
        window.webContents.send('p9:focus', { 1: 'chat', 2: 'dev', 3: 'mission' }[input.key]);
      }
    });
    window.contentView.addChildView(devView);
    let config;
    try {
      if (!state) throw new Error('daemon-unavailable');
      if (serverHost) throw new Error('server-mode');
      const [devFiles, status] = await Promise.all([assets(fileURLToPath(new URL('../dev/dist/', import.meta.url))), health(state)]);
      const host = await startHost();
      const origin = 'http://127.0.0.1:' + host.port;
      // Extension pages (webviews: a README, an image preview) get their own origin, p9://webview, so their scripts can't reach
      // window.p9dev (threat model row 5; Builder, 2026-10-19: "photos ... blocked"). VS Code injects an inline script into each
      // page, so inline scripts run there; the page's own CSP narrows that, and index-*.html carries its own hash-only CSP.
      const isWebview = name => /^\/assets\/(index-[^/]+\.html|fake-[^/]+\.html|service-worker-[^/]+\.js)$/.test(name);
      sites.webview = { files: new Map([...devFiles].filter(([name]) => isWebview(name))), csp: "default-src 'none'; script-src 'self' 'unsafe-inline' https://*.vscode-cdn.net; "
        + "style-src 'self' 'unsafe-inline' https://*.vscode-cdn.net; img-src 'self' data: blob: https:; font-src 'self' data: https://*.vscode-cdn.net; "
        + "media-src 'self' blob: https://*.vscode-cdn.net; connect-src 'self' https://*.vscode-cdn.net; worker-src 'self'; frame-src 'self'; "
        + "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors p9://dev p9://webview" };
      const devScripts = [...devFiles].filter(([name]) => name.endsWith('.html') && !isWebview(name)).flatMap(([, data]) => inlineHashes(data.toString('utf8')));
      sites.dev = { files: devFiles, csp: `default-src 'none'; script-src 'self' 'wasm-unsafe-eval' ${devScripts.join(' ')}; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; `
        // Images from any https host: extension icons (Open VSX) and README images (badges, raw.githubusercontent.com), as VS Code
        // allows (threat model row 5; A/B: with Open VSX only, all 5 of the YAML README's images stay blank). Gallery search, installs
        // and README text come through the editor host, so connect-src stays local.
        + `img-src 'self' data: blob: ${origin} https:; font-src 'self' data: blob: ${origin}; media-src 'self' blob:; connect-src 'self' ws://127.0.0.1:${host.port} ${origin}; `
        + "frame-src 'self' p9://webview; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'" };
      // workspace is the guard root (the folder saves are relative to); folder is the one the editor shows.
      if (devFolder?.outside && (await daemonRequest(state, 'POST', '/dev/root', { path: devFolder.path }).catch(() => null))?.status !== 200) devFolder = null;
      devServing = devFolder;
      config = { port: host.port, token: host.token, commit: host.commit, workspace: devFolder?.outside ? devFolder.path : status.workspace, folder: devFolder && (devFolder.outside ? devFolder.path : status.workspace + devFolder.tail), data: host.data };
    } catch (error) {
      sites.dev = { files: new Map([['/index.html', Buffer.from('<!doctype html><title>Dev Focus</title><body style="background:#05070e;color:#dce4f2;font:14px system-ui;padding:24px">' + (error.message === 'server-mode' ? 'Dev Focus works on this computer\'s files only for now. Switch to Local in Settings to use it.' : 'Dev Focus is unavailable: the editor host or daemon did not start.') + '</body>')]]),
        csp: "default-src 'none'; style-src 'unsafe-inline'" };
      config = { error: error.message };
    }
    await devView.webContents.loadURL(DEV_URL);
    if (config.error) dev = null;
    return config;
  })().catch(error => { dev = null; throw error; });
  // A new folder (Open Folder, a workspace change) loads a new editor page in the same place; its open-ready delivers what is queued.
  const reopenDev = () => {
    if (!devView) return;
    const bounds = devView.getBounds(), shown = devView.getVisible();
    dev = null;
    openDev().catch(error => console.error('p9: Dev Focus failed to open:', error.message));
    devView.setBounds(bounds);
    devView.setVisible(shown);
    if (shown) devView.webContents.focus();
  };
  // A workspace change shows the new workspace, whatever folder was open.
  const devToWorkspace = () => { devFolder = null; reopenDev(); };
  // Dev Focus's Open Folder (threat model row 41): the native picker, then a folder inside the workspace opens at once; one outside
  // it asks first, naming the folder, and the daemon checks it (POST /dev/root) before the editor shows it.
  ipcMain.handle('p9dev:open-folder', async (event, ...args) => {
    if (!fromDev(event) || args.length) throw new Error('ipc-sender-refused');
    if (!state || serverHost) return { error: 'daemon-unavailable' };
    const workspace = await realpath((await health(state)).workspace);
    const pick = await dialog.showOpenDialog(window, { title: 'Open Folder', buttonLabel: 'Open', properties: ['openDirectory'], defaultPath: devFolder?.path ?? workspace });
    if (pick.canceled || !pick.filePaths[0]) return { ok: false };
    const real = await realpath(pick.filePaths[0]).catch(() => null);
    if (!real) return { error: 'root-not-found' };
    const key = p => process.platform === 'win32' ? p.toLowerCase() : p; // Windows paths compare without case.
    const outside = key(real) !== key(workspace) && !key(real).startsWith(key(workspace) + path.sep);
    let set; // the daemon's answer: the root as it stores it, which saves must name exactly
    if (outside) {
      const { response } = await dialog.showMessageBox(window, { type: 'warning', title: 'Open a folder outside the workspace?', message: 'Open ' + real + ' in Dev Focus?',
        detail: 'It is outside the workspace. Saves there still go through P9\'s guarded save. P9 keeps it open until you restart or open the workspace again.',
        buttons: ['Cancel', 'Open folder'], defaultId: 0, cancelId: 0, noLink: true });
      if (response !== 1) return { ok: false };
      set = await daemonRequest(state, 'POST', '/dev/root', { path: real }).catch(() => null);
      if (set?.status !== 200) return { error: set?.body?.error ?? 'daemon-unavailable' };
    } else if (devFolder?.outside) await daemonRequest(state, 'POST', '/dev/root', { path: null }).catch(() => null);
    // Inside: kept as the part after the workspace, so the page gets the daemon's own spelling of it (Windows case, a linked workspace).
    devFolder = key(real) === key(workspace) ? null : { path: outside ? set.body.root : real, outside, tail: real.slice(workspace.length) };
    // After the reply, so it is not sent to the page being replaced.
    setTimeout(reopenDev);
    return { ok: true };
  });
  ipcMain.handle('p9:dev-view', async (event, ...args) => {
    const [b] = args, whole = value => Number.isSafeInteger(value) && value >= 0 && value <= 100000;
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== APP_URL
        || args.length !== 1 || !b || typeof b.visible !== 'boolean' || (b.visible && !['x', 'y', 'width', 'height'].every(key => whole(b[key])))) throw new Error('ipc-sender-refused');
    if (!b.visible) { devView?.setVisible(false); return { ok: true }; }
    const shown = devView?.getVisible();
    openDev().catch(error => console.error('p9: Dev Focus failed to open:', error.message));
    // The shell measures in its own (zoomed) CSS pixels; the view is placed in window pixels.
    const z = window.webContents.getZoomFactor(), px = value => Math.round(value * z);
    devView.setBounds({ x: px(b.x), y: px(b.y), width: px(b.width), height: px(b.height) });
    devView.setVisible(true);
    if (!shown) devView.webContents.focus();
    return { ok: true };
  });
  // Settings: no argument reads them; one argument is the whole new shape, refused unless checkSettings takes it.
  ipcMain.handle('p9:settings', async (event, ...args) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== APP_URL
        || args.length > 1) throw new Error('ipc-sender-refused');
    if (!args.length) return settings;
    const next = checkSettings(args[0]);
    if (!next) throw new Error('settings-refused');
    // One save at a time: saves share the .tmp file, and Ctrl = held down sends many at once.
    const saved = settingsSaving.then(async () => {
      await writeFile(settingsFile + '.tmp', JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
      await rename(settingsFile + '.tmp', settingsFile);
    });
    settingsSaving = saved.catch(() => {});
    await saved;
    settings = next;
    window.webContents.setZoomFactor(settings.zoom);
    devView?.webContents.setZoomFactor(settings.zoom);
    return settings;
  });
  // Pets: no argument lists the usable ones (name and display name only); one argument is a folder name to load.
  ipcMain.handle('p9:pets', async (event, ...args) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== APP_URL
        || args.length > 1) throw new Error('ipc-sender-refused');
    if (args.length) return (await loadPet(petsFolder, args[0])) ?? Promise.reject(new Error('pet-refused'));
    const names = (await readdir(petsFolder).catch(() => [])).filter(name => PET_NAME.test(name)).sort().slice(0, 50);
    const pets = (await Promise.all(names.map(name => loadPet(petsFolder, name)))).filter(Boolean).map(({ name, displayName }) => ({ name, displayName }));
    return { folder: petsFolder, pets, importable: (await importable()).length };
  });
  // Import: petdex's own folder, names P9 does not have yet; each still goes through addPet's checks on the click.
  const petdexFolder = () => path.join(app.getPath('home'), '.codex', 'pets');
  const importable = async () => {
    const have = new Set(await readdir(petsFolder).catch(() => []));
    return (await readdir(petdexFolder()).catch(() => [])).filter(name => PET_NAME.test(name) && !have.has(name)).sort().slice(0, 20);
  };
  const addFolders = async folders => {
    const added = [], refused = [];
    for (const folder of folders.slice(0, 20)) {
      const why = await addPet(petsFolder, folder);
      (why ? refused : added).push({ name: path.basename(folder).slice(0, 80), ...(why && { why }) });
    }
    return { added, refused };
  };
  ipcMain.handle('p9:pet-import', async (event, ...args) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== APP_URL
        || args.length) throw new Error('ipc-sender-refused');
    return addFolders((await importable()).map(name => path.join(petdexFolder(), name)));
  });
  // Install (Builder, 2026-10-18: paste "the npm command from petdex.dev"): the page sends the pasted text; main keeps only the pet
  // names after "install", then does what petdex 1.4.0's install does (read 2026-10-18): petdex.dev's manifest, then the pet's
  // pet.json and sheet from assets.petdex.dev only. Nothing downloaded runs; each pet goes through Add's checks (threat model row 16).
  const getBytes = async (url, max) => {
    const res = await fetch(url, { headers: { Accept: 'application/json, image/*' }, signal: AbortSignal.timeout(20000) });
    if (!res.ok || +res.headers.get('content-length') > max) throw new Error('fetch');
    const bytes = Buffer.from(await res.arrayBuffer()); if (bytes.length > max) throw new Error('fetch'); return bytes;
  };
  const asset = (rel, base) => { const u = new URL(rel, base + '/'); if (u.protocol !== 'https:' || u.hostname !== 'assets.petdex.dev') throw new Error('host'); return u.href; };
  ipcMain.handle('p9:pet-install', async (event, ...args) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== APP_URL
        || args.length !== 1 || typeof args[0] !== 'string' || args[0].length > 300) throw new Error('ipc-sender-refused');
    // The words after the last "install" (or all of them), each a pet name; split, not one regex (a nested one froze main on a long typo).
    const words = args[0].trim().split(/\s+/), tail = words.slice(words.lastIndexOf('install') + 1);
    const names = tail.every(word => PET_NAME.test(word)) ? [...new Set(tail)].slice(0, 5) : [];
    if (!names.length) return { added: [], refused: [{ name: args[0].slice(0, 80), why: 'command' }] };
    let list;
    try { const m = JSON.parse(await getBytes('https://petdex.dev/api/manifest/v2', 16 << 20)); list = m.v === 2 && Array.isArray(m.pets) && m.pets; if (!list) throw 0; asset('', m.assetBase); list.base = m.assetBase; }
    catch { return { added: [], refused: names.map(name => ({ name, why: 'offline' })) }; }
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'p9-petdex-')), folders = [], refused = [];
    try {
      for (const name of names) {
        const row = list.find(p => Array.isArray(p) && p[0] === name);
        if (!row) { refused.push({ name, why: 'unknown' }); continue; }
        try {
          const meta = JSON.parse(await getBytes(asset(row[5], list.base), 16 << 10)), sheet = asset(row[4], list.base), ext = path.extname(new URL(sheet).pathname);
          if (!['.webp', '.png'].includes(ext)) throw 0;
          await mkdir(path.join(tmp, name));
          await writeFile(path.join(tmp, name, 'pet.json'), JSON.stringify({ id: String(meta.id ?? name), displayName: String(meta.displayName ?? row[1]), description: String(meta.description ?? ''), spritesheetPath: 'spritesheet' + ext }));
          await writeFile(path.join(tmp, name, 'spritesheet' + ext), await getBytes(sheet, 8 << 20));
          folders.push(path.join(tmp, name));
        } catch (error) { refused.push({ name, why: error?.message === 'host' ? 'invalid' : 'offline' }); }
      }
      const r = await addFolders(folders); r.refused.push(...refused); return r;
    } finally { await rm(tmp, { recursive: true, force: true }); }
  });
  // Add: no argument; the user picks folders in the native picker (it opens where the petdex command installs). Remove: one pet name.
  ipcMain.handle('p9:pet-add', async (event, ...args) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== APP_URL
        || args.length) throw new Error('ipc-sender-refused');
    const petdex = petdexFolder();
    const pick = await dialog.showOpenDialog(window, { title: 'Add pets', buttonLabel: 'Add', properties: ['openDirectory', 'multiSelections'],
      defaultPath: (await stat(petdex).catch(() => null))?.isDirectory() ? petdex : app.getPath('home') });
    return addFolders(pick.canceled ? [] : pick.filePaths);
  });
  // New chat's Choose folder... (threat model row 24): the system folder dialog, then only a folder inside the workspace's real path goes
  // back, workspace-relative ('' is the workspace itself). The daemon checks it again when the chat is made.
  // Setup's Pick buttons name a file ('setup-file') or folder ('setup-folder') the same way; the daemon checks the path again.
  const PICKS = { 'setup-file': ['Choose the file', 'Use this file', 'openFile'], 'setup-folder': ['Choose the folder', 'Use this folder', 'openDirectory'] };
  ipcMain.handle('p9:pick-folder', async (event, ...args) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== APP_URL
        || args.length > 1 || (args.length && !Object.hasOwn(PICKS, args[0]))) throw new Error('ipc-sender-refused');
    if (!state) return null;
    // ponytail: no picker in Server mode (this machine's dialog cannot browse the server); acts as Cancel. A server folder list is the sprint's.
    if (serverHost) return undefined;
    const root = await realpath((await health(state)).workspace);
    const [title, buttonLabel, kind] = args.length ? PICKS[args[0]] : ['Start the chat in', 'Start here', 'openDirectory'];
    const pick = await dialog.showOpenDialog(window, { title, buttonLabel, properties: [kind], defaultPath: root });
    if (pick.canceled || !pick.filePaths[0]) return undefined;
    const real = await realpath(pick.filePaths[0]).catch(() => null);
    if (real === root) return '';
    return real?.startsWith(root + path.sep) ? real.slice(root.length + 1).split(path.sep).join('/') : null;
  });
  // Setup's Change the folder (threat model row 32): no argument; the native picker, then a native confirm naming the folder. Main writes
  // no unit: it re-runs the installed copy's own uninstall-service.mjs and install-service.mjs with only the folder, with the unit's own
  // node and PATH so the new unit differs only in --workspace, and installs the old folder again when the new one does not come up.
  // Windows: the installed copy's own install-windows.ps1 -Workspace through repairWindowsTask, as the launch repair runs it; the
  // script stops the old daemon itself. P9's private folder there is %LOCALAPPDATA%\P9, the state folder's parent.
  ipcMain.handle('p9:workspace-change', async (event, ...args) => {
    if (!fromApp(event) || args.length) throw new Error('ipc-sender-refused');
    if (serverHost) return { error: 'server-mode-local-only' }; // this machine's service; the server's folder is set where it is installed
    const old = state && (await health(state).catch(() => null))?.workspace;
    if (!old) return { error: 'daemon-unavailable' };
    const win = process.platform === 'win32';
    if (!win && process.platform !== 'linux') return { error: 'workspace-change-unsupported', workspace: old };
    // The steps below rewrite the p9-foundation unit; a window on the dev daemon (p9-dev) must not touch the daily one.
    if (!win && unitFor(state) !== 'p9-foundation.service') return { error: 'workspace-change-unsupported', workspace: old };
    const pick = await dialog.showOpenDialog(window, { title: 'Choose the workspace folder', buttonLabel: 'Use this folder',
      properties: ['openDirectory', 'createDirectory'], defaultPath: old });
    if (pick.canceled || !pick.filePaths[0]) return { workspace: old };
    // Never the home folder, a root, or a folder that holds or is inside P9's private state (the daemon refuses those at start too).
    const folder = await realpath(pick.filePaths[0]).catch(() => null), home = await realpath(os.homedir());
    const key = p => win ? p.toLowerCase() : p; // Windows paths compare without case.
    const near = (a, b) => ([a, b] = [key(a), key(b)], a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep));
    const stateReal = await realpath(state).catch(() => path.resolve(state));
    const kept = [stateReal, win ? path.dirname(stateReal) : path.join(home, '.local', 'state', 'p9-foundation')];
    if (!folder || !(await stat(folder)).isDirectory() || folder === home || path.dirname(folder) === folder || kept.some(p => near(folder, p))) {
      return { error: 'workspace-refused', workspace: old };
    }
    if (folder === old) return { workspace: old };
    const { response } = await dialog.showMessageBox(window, { type: 'warning', title: 'Change the workspace folder?', message: 'Use ' + folder + ' as the workspace?',
      detail: 'P9 restarts its background service. Running chats, scripts and terminals stop.', buttons: ['Cancel', 'Change folder'], defaultId: 0, cancelId: 0, noLink: true });
    if (response !== 1) return { workspace: old };
    if (win) {
      if (!await stat(path.join(process.resourcesPath, 'daemon', 'scripts', 'install-windows.ps1')).catch(() => null)) return { error: 'service-missing', workspace: old };
      if ((await daemonRequest(state, 'POST', '/stop-all', {}).catch(() => null))?.status !== 200) return { error: 'stop-all-failed', workspace: old };
      // The script returns once the task is started; the new daemon is up when /health names the folder.
      const on = async (want) => { for (const end = Date.now() + 60_000; Date.now() < end; await new Promise(r => setTimeout(r, 1000))) {
        if ((await health(state).catch(() => null))?.workspace?.toLowerCase() === want.toLowerCase()) return true; } return false; };
      changing = true;
      try {
        const ran = await repairWindowsTask(process.resourcesPath, folder);
        if (ran && await on(folder)) { devToWorkspace(); return { workspace: folder }; }
        await repairWindowsTask(process.resourcesPath, old);
        await on(old);
        return { error: 'workspace-not-started', detail: ran ? 'daemon-not-answering' : 'install-windows.ps1 failed (service-install.log)',
          workspace: (await health(state).catch(() => null))?.workspace ?? null };
      } finally { changing = false; }
    }
    // The unit as install-service.mjs quoted it: ExecStart's node and server, and Environment's PATH.
    const unit = await readFile(path.join(os.homedir(), '.config', 'systemd', 'user', 'p9-foundation.service'), 'utf8').catch(() => '');
    const unquote = s => s.replace(/\\(.)/g, '$1').replaceAll('%%', '%').replaceAll('$$', '$');
    let [node, server] = [...(unit.match(/^ExecStart=(.*)$/m)?.[1] ?? '').matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => unquote(m[1]));
    // The AppImage's unit (AU4) starts with the launcher, and the version it names may be gone since: daemon/current's.
    if (node?.endsWith('/launcher/p9-launch.sh')) {
      const share = path.dirname(path.dirname(node)), version = (await readFile(path.join(share, 'daemon', 'current'), 'utf8').catch(() => '')).trim();
      [node, server] = version ? [path.join(share, 'daemon', version, 'node'), path.join(share, 'daemon', version, 'apps', 'server', 'main.mjs')] : [];
    }
    const unitPath = unit.match(/^Environment="PATH=((?:[^"\\]|\\.)*)"$/m)?.[1];
    if (!server) return { error: 'service-missing', workspace: old };
    // Stop All first, so a daemon that cannot stop its chats leaves everything as it was.
    if ((await daemonRequest(state, 'POST', '/stop-all', {}).catch(() => null))?.status !== 200) return { error: 'stop-all-failed', workspace: old };
    const env = { ...process.env, ...(unitPath ? { PATH: unquote(unitPath) } : {}) }, scripts = path.join(path.dirname(server), '..', '..', 'scripts');
    let detail = '';
    const run = (script, ...more) => new Promise(resolve => execFile(node, [path.join(scripts, script), ...more], { env, timeout: 60_000 },
      (error, _stdout, stderr) => { if (error) detail = String(stderr).trim().split('\n').filter(l => /^\w*Error/.test(l)).pop()?.slice(0, 300) ?? 'exit ' + error.code; resolve(!error); }));
    if (!await run('uninstall-service.mjs')) await run('uninstall-service.mjs', '--force');
    if (await run('install-service.mjs', folder)) { devToWorkspace(); return { workspace: folder }; }
    // install-service.mjs removed its own unit when the daemon did not answer; the old folder again.
    const why = detail;
    await run('install-service.mjs', old);
    return { error: 'workspace-not-started', detail: why, workspace: (await health(state).catch(() => null))?.workspace ?? null };
  });
  // Mission's "Restart P9 to apply" (M2) and Settings → Maintenance: restarts the background service on the folder it already
  // has; asks first, since running chats, scripts and terminals stop. RS1: done only once /health names a new boot (teh.mjs).
  // Repair (MT1) runs the installer again: install-windows.ps1, as the launch repair does, or the Linux unit enabled again
  // (installed when it is missing). It is the way back for a task the installer left stale (Windows) without a reinstall.
  const service = repair => async (event, ...args) => {
    if (!fromApp(event) || args.length) throw new Error('ipc-sender-refused');
    if (!state) return { error: 'daemon-unavailable' };
    if (serverHost && repair) return { error: 'server-mode-local-only' };
    const win = process.platform === 'win32';
    if (!serverHost && !win && process.platform !== 'linux') return { error: (repair ? 'repair' : 'restart') + '-unsupported' };
    if (repair && win && !await stat(path.join(process.resourcesPath, 'daemon', 'scripts', 'install-windows.ps1')).catch(() => null)) return { error: 'service-missing' };
    const { response } = await dialog.showMessageBox(window, { type: 'warning', title: repair ? 'Repair P9?' : 'Restart P9?',
      message: repair ? 'Repair P9\'s background service?' : serverHost ? 'Restart P9 on ' + serverHost + '?' : 'Restart P9\'s background service?',
      detail: (repair ? 'P9 sets up its background service again and starts it. ' : '') + (serverHost ? 'Running chats, scripts and terminals on the server stop, the ones open on your phone too.' : 'Running chats, scripts and terminals stop.'),
      buttons: ['Cancel', repair ? 'Repair' : 'Restart'], defaultId: 0, cancelId: 0, noLink: true });
    if (response !== 1) return { cancelled: true };
    // A daemon that does not answer at all is restarted anyway (finding 6: otherwise a hung service had no way back); one that
    // answers but cannot stop something is left running, as before.
    const stopped = await daemonRequest(state, 'POST', '/stop-all', {}).catch(() => 'no-answer');
    if (stopped !== 'no-answer' && stopped?.status !== 200) return { error: 'stop-all-failed' };
    if (serverHost) {
      const remote = server, before = await remote?.check().then(h => h.boot, () => null);
      if (!remote || !await restartServer(serverHost, sshCommand)) return { error: 'restart-failed' };
      return answered(state, before, undefined, () => remote.check());
    }
    if (!win) return repair ? repairLinuxService(state) : restartLinuxService(state);
    changing = true;
    try {
      if (!repair) return await restartWindowsTask(state);
      const before = await health(state).then(h => h.boot, () => null);
      return await repairWindowsTask(process.resourcesPath) ? await answered(state, before) : { error: 'repair-failed', detail: 'install-windows.ps1 failed (service-install.log)' };
    } finally { changing = false; }
  };
  ipcMain.handle('p9:restart-service', service(false));
  ipcMain.handle('p9:repair-service', service(true));
  // MT1 Rebuild + reload, source checkouts only: pnpm build in this checkout, then the window loads the new build. Chats live
  // in the daemon and keep running; daemon code still needs Restart. P9_BUILD names another command (the tests' stand-in).
  ipcMain.handle('p9:rebuild', async (event, ...args) => {
    if (!fromApp(event) || args.length || !source) throw new Error('ipc-sender-refused');
    rebuilding = true;
    try {
      const [command, more] = process.env.P9_BUILD ? [process.env.P9_BUILD, []] : ['pnpm', ['build']];
      const built = await new Promise(resolve => execFile(command, more, { cwd: fileURLToPath(new URL('../../', import.meta.url)), timeout: 600_000, maxBuffer: 16 * 1024 * 1024 },
        (error, _stdout, stderr) => resolve(error ? { error: 'build-failed', detail: String(stderr).trim().split('\n').slice(-3).join('\n').slice(0, 300) } : null)));
      if (built) return built;
      sites.app = await appSite();
    } finally { rebuilding = false; }
    window.webContents.reload();
    return { rebuilt: true };
  });
  ipcMain.handle('p9:pet-remove', async (event, ...args) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== APP_URL
        || args.length !== 1 || typeof args[0] !== 'string' || !PET_NAME.test(args[0])) throw new Error('ipc-sender-refused');
    const folder = path.join(petsFolder, args[0]), info = await lstat(folder).catch(() => null);
    if (!info?.isDirectory()) throw new Error('pet-refused'); // lstat: a link is never a directory here
    await rm(folder, { recursive: true });
    return { removed: args[0] };
  });
  ipcMain.handle('p9:open-docs', async (event, ...args) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== APP_URL
        || args.length > 1 || (args.length && !GUIDE_SECTIONS.includes(args[0]))) throw new Error('ipc-sender-refused');
    const url = args.length ? GUIDE_URL + args[0] : DOCS_URL;
    if (process.env.P9_OPEN_URL) spawn(process.env.P9_OPEN_URL, [url], { shell: false, stdio: 'ignore' }).on('error', () => {});
    else await shell.openExternal(url);
    return { opened: true };
  });
  ipcMain.handle('p9:open-updates', async (event, ...args) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== APP_URL
        || args.length) throw new Error('ipc-sender-refused');
    if (process.env.P9_OPEN_URL) spawn(process.env.P9_OPEN_URL, [RELEASES_URL], { shell: false, stdio: 'ignore' }).on('error', () => {});
    else await shell.openExternal(RELEASES_URL);
    return { opened: true };
  });
  // Auto-update (threat model row 39): off unless this is an installed build with a feed (updater.mjs); its lines go to
  // p9-update.log. skip: the version a rollback came back from (row 40).
  const updater = startUpdater({ app, version, log: updateLog, skip: {
    get: () => readState(startFile).skip,
    clear: () => { const start = readState(startFile); start.skip = null; writeState(startFile, start); } } });
  ipcMain.handle('p9:updates', async (event, ...args) => {
    const action = updateAction(args);
    if (!fromApp(event) || !action) throw new Error('ipc-sender-refused');
    return (await updater)[action]();
  });
  ipcMain.handle('p9:open-petdex', async (event, ...args) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== APP_URL
        || args.length) throw new Error('ipc-sender-refused');
    if (process.env.P9_OPEN_URL) spawn(process.env.P9_OPEN_URL, [PETDEX_URL], { shell: false, stdio: 'ignore' }).on('error', () => {});
    else await shell.openExternal(PETDEX_URL);
    return { opened: true };
  });
  // File protection (threat model row 4): no argument reads it, a boolean sets it. Turning it off asks first in a native dialog,
  // which the page can neither draw nor answer; turning it on never asks.
  ipcMain.handle('p9:file-protection', async (event, ...args) => {
    if (!fromApp(event) || args.length > 1 || (args.length && typeof args[0] !== 'boolean')) throw new Error('ipc-sender-refused');
    if (!state) return { status: 503, body: { error: 'daemon-unavailable' } };
    try {
      if (!args.length) return await daemonRequest(state, 'GET', '/file-protection');
      while (!args[0]) {
        const { response } = await dialog.showMessageBox(window, { type: 'warning', title: 'Turn off file protection?', message: 'Turn off file protection?',
          detail: FILE_PROTECTION_RISK, buttons: ['Keep protection on', 'Turn off protection', 'Read about the risk'], defaultId: 0, cancelId: 0, noLink: true });
        if (response === 1) break;
        if (response !== 2) return await daemonRequest(state, 'GET', '/file-protection');
        if (process.env.P9_OPEN_URL) spawn(process.env.P9_OPEN_URL, [FILE_PROTECTION_DOCS], { shell: false, stdio: 'ignore' }).on('error', () => {});
        else await shell.openExternal(FILE_PROTECTION_DOCS);
      }
      return await daemonRequest(state, 'POST', '/file-protection', { on: args[0] });
    } catch { return { status: 503, body: { error: 'daemon-unavailable' } }; }
  });
  // The shell's DUWOP look (colours as #rrggbbaa), kept for the next Dev Focus start and passed on to a running one.
  const LOOK_TOKENS = ['background', 'foreground', 'card', 'primary', 'primary-foreground', 'muted', 'muted-foreground', 'accent', 'border', 'ring'];
  ipcMain.handle('p9:look', (event, ...args) => {
    const [input] = args;
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== APP_URL || args.length !== 1
        || !input || typeof input.dark !== 'boolean' || !input.colors || Object.keys(input.colors).length !== LOOK_TOKENS.length
        || !LOOK_TOKENS.every(token => /^#[0-9a-f]{8}$/.test(input.colors[token] ?? ''))) throw new Error('ipc-sender-refused');
    look = { dark: input.dark, colors: Object.fromEntries(LOOK_TOKENS.map(token => [token, input.colors[token]])) };
    devView?.webContents.send('p9dev:look', look);
    return { ok: true };
  });
  ipcMain.handle('p9dev:config', async (event, ...args) => {
    if (!fromDev(event) || args.length) throw new Error('ipc-sender-refused');
    return { ...(await openDev()), look };
  });
  // A folder outside the workspace: the write names the root this page was opened on, so the daemon refuses it once Dev Focus has
  // moved on. A restarted daemon has forgotten the root: set it again once, while it is still the open folder.
  const devWrite = async (method, body) => {
    const served = devServing, write = () => daemonRequest(state, method, '/files', served?.outside ? { ...body, root: served.path } : body);
    const result = await write();
    if (result.body?.error !== 'dev-root-unset' || served !== devFolder) return result;
    if ((await daemonRequest(state, 'POST', '/dev/root', { path: served.path })).status !== 200) return result;
    return write();
  };
  // Every editor save is the daemon's guarded save: the expected hash is what the editor loaded, so a disk change is a conflict.
  ipcMain.handle('p9dev:save', async (event, ...args) => {
    const [input] = args;
    if (!fromDev(event) || args.length !== 1 || !input || typeof input.path !== 'string' || !/^[0-9a-f]{64}$/.test(input.hash ?? '') || typeof input.content !== 'string') throw new Error('ipc-sender-refused');
    if (!state) return { kind: 'failed', error: 'daemon-unavailable' };
    try { return (await devWrite('PUT', { path: input.path, hash: input.hash, content: input.content })).body; }
    catch { return { kind: 'failed', error: 'daemon-unavailable' }; }
  });
  ipcMain.handle('p9dev:create', async (event, ...args) => {
    const [input] = args;
    if (!fromDev(event) || args.length !== 1 || !input || typeof input.path !== 'string' || typeof input.content !== 'string') throw new Error('ipc-sender-refused');
    if (!state) return { kind: 'failed', error: 'daemon-unavailable' };
    try {
      const result = await devWrite('POST', { path: input.path, content: input.content });
      return result.status === 201 ? result.body : { kind: 'failed', error: result.body?.error ?? String(result.status) };
    } catch { return { kind: 'failed', error: 'daemon-unavailable' }; }
  });
  ipcMain.handle('p9dev:host-path', async (event, ...args) => {
    if (!fromDev(event) || args.length !== 2 || typeof args[0] !== 'string' || !['write', 'name'].includes(args[1])) throw new Error('ipc-sender-refused');
    const host = await editorHost?.catch(() => null);
    return Boolean(host) && hostWritable(host.data, args[0], args[1]);
  });
  ipcMain.handle('p9dev:open-in-code', async (event, ...args) => {
    const [input] = args;
    if (!fromDev(event) || args.length !== 1 || !input) throw new Error('ipc-sender-refused');
    const config = await openDev();
    if (config.error) return { ok: false, error: config.error };
    return openInCode({ workspace: config.workspace, name: input.name, line: input.line, reason: input.reason });
  });
  // p9 edit / p9 diff (threat model row 14). Anything running as Builder can start a second instance, so this is the boundary:
  // exact shape, absolute paths, real path a regular file inside the workspace's real path. It only opens; saving stays guarded.
  const checkOpen = async data => {
    if (!state || !data || typeof data !== 'object' || Array.isArray(data)) return null;
    const keys = Object.keys(data).sort().join(',');
    const edit = data.open === 'edit' && keys === 'line,open,path' && Number.isSafeInteger(data.line) && data.line >= 1 && data.line <= 10000000;
    if (!edit && !(data.open === 'diff' && keys === 'a,b,open')) return null;
    const root = (await realpath((await health(state)).workspace)) + path.sep;
    const name = async file => {
      if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
      try {
        const real = await realpath(file);
        return real.startsWith(root) && (await stat(real)).isFile() ? real.slice(root.length).split(path.sep).join('/') : null;
      } catch { return null; }
    };
    const names = await Promise.all(edit ? [name(data.path)] : [name(data.a), name(data.b)]);
    if (names.includes(null)) return null;
    return edit ? { open: 'edit', name: names[0], line: data.line } : { open: 'diff', a: names[0], b: names[1] };
  };
  const deliver = () => { while (devReady && queued.length) devView.webContents.send('p9dev:open', queued.shift()); };
  const request = async data => {
    const checked = await checkOpen(data).catch(() => null);
    if (!checked) return console.error('p9: open request refused');
    queued.push(checked);
    // Names are workspace-relative: a folder outside it goes back to the workspace first (the new page's open-ready delivers).
    if (devFolder?.outside) { daemonRequest(state, 'POST', '/dev/root', { path: null }).catch(() => null); devToWorkspace(); }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    window.webContents.send('p9:focus', 'dev');
    deliver();
  };
  app.on('second-instance', (_event, _argv, _cwd, data) => { if (data && Object.keys(data).length) request(data); });
  ipcMain.handle('p9dev:open-ready', (event, ...args) => {
    if (!fromDev(event) || args.length) throw new Error('ipc-sender-refused');
    devReady = true;
    deliver();
    return { ok: true };
  });
  // Hot reload, source checkouts only: a new web build (pnpm build) is read again and the window reloads. Chats live in the
  // daemon and keep running; unsent composer text is lost. Daemon code still needs a daemon restart.
  // ponytail: an 800 ms quiet gap stands in for "build finished"; a half-written dist fails to load and the next file event retries.
  if (!app.isPackaged) {
    let timer;
    watch(webDist, { recursive: true }, () => {
      clearTimeout(timer);
      if (rebuilding) return; // p9:rebuild reloads once the build is done
      timer = setTimeout(() => appSite().then(site => { sites.app = site; window.webContents.reload(); }, () => {}), 800);
    });
  }
  await window.loadURL(APP_URL);
  if (open) request(open);
  return window;
}
