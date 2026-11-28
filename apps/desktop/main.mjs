import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, protocol, session, shell, WebContentsView } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { appendFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { appendFileSync, constants, openSync, readFileSync, watch } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { health, daemonRequest, windowsTask, repairWindowsTask, restartWindowsTask, restartLinuxService, repairLinuxService, unitFor, appImageService, useInstalledDaemon, answered, AGENT_START_MS, failedReply } from '../../scripts/teh.mjs';
import { sshLogin, makeKey, installKey } from './ssh-login.mjs';
import { daemonOffer, keptCheckout, keepText, failureOf, guarded } from './use-installed.mjs';
import { connectServer, forwardPath, restartServer, startServer, stopServer, sshHosts, serverFolder, probeServer, remoteMode, remoteDeps, HOST, PASSWORD, useKey } from './remote.mjs';
import { updateServer } from './server-update.mjs';
import { installRemote, sourceArchive, slimArchive, adminLocal, adminArgs } from './remote-install.mjs';
import { adminCommand } from '../server/deps.mjs';
import { AGENT_IDS, SIGN_IN_KIND, publicAgents } from '../server/agents.mjs';
import { trimLog, unitOf, windowsTaskName } from '../server/windows.mjs';
import { createKeeper } from './keep.mjs';
import { sendToServer } from './move.mjs';
import { XFER_LIMITS, planFolder, resolve as resolveXfer, overLimit, runPlan, describe as describeXfer, noAnswer, open as openXfer, isFull } from './xfer.mjs';
import { ORIGIN, FILE_PROTECTION_RISK, FRAME_CSP, SIGN_IN_ORIGINS, DEVICE_CODE, signInUrl } from '../../packages/protocol/index.mjs';
import { WebSocket } from 'ws';
import { contextMenu, windowsFullName } from './native.mjs';
import { startEditorHost, stablePort, stopEditorHost, openInCode, hostWritable, installEditorHost, editorDownload, editorProblem, EDITOR_DIR, EDITOR_COMMIT, EDITOR_DOWNLOADS } from './editor-host.mjs';
import { offReason, startUpdater, updateAction } from './updater.mjs';
import { readState, writeState, begin, timedOut, healthy, quit, rolledBack, startHealthy, launcherCommand, promoteLauncher, readRollback, markShown,
  rollbackLog, sanitize, reportLink, shareRoot, START_MS } from './rollback.mjs';
import { REPO, NEW_ISSUE } from '../server/anymouse.mjs';
import { updatedFrom } from './whats-new.mjs';
import { trusted, setTrust, unrestricted, chatFolder, openFolder } from './dev-folder.mjs';
import { CARDS_URL, cardsSite } from './cards-page.mjs';
import { PET_NAME, addPet } from './pet-files.mjs';
import { devErrorPage, inlineHashes, assets } from './served-pages.mjs';
import { sendIpc } from './send-ipc.mjs';
import { cardsIpc } from './cards-ipc.mjs';
import { petsIpc } from './pets-ipc.mjs';
import { devIpc } from './dev-ipc.mjs';
import { projectRoutes } from './project-routes.mjs';

export const APP_URL = 'p9://app/';
const FRAME_URL = 'p9://frame/'; // item 19: the artifact frame's page (row 65)
export const DEV_URL = 'p9://dev/';
export const WEBVIEW_URL = 'p9://webview/';
export const DOCS_URL = 'https://github.com/' + REPO + '#readme';
// HI1: a Settings row's "i" opens its part of the guide (docs/guide.md headings); any other section is refused.
export const GUIDE_URL = 'https://github.com/' + REPO + '/blob/main/docs/guide.md#';
export const GUIDE_SECTIONS = Object.freeze(['settings', 'focus-modes', 'pets', 'agent-lock', 'file-protection', 'updates', 'maintenance', 'mission-control-files', 'buttons-apps-and-pages', 'security-settings', 'remote-connect-send-to-remote-and-send-files', 'send-files']);
// Check for updates (threat model row 28): the newest release page; GitHub's sign-in and the download happen in the browser.
export const RELEASES_URL = 'https://github.com/' + REPO + '/releases/latest';
// Settings → Pets: where pets come from (GitHub issue #4 follow-up: the petdex.dev text needs a link).
export const PETDEX_URL = 'https://petdex.dev';
// placeholder: SECURITY.md § File protection exists on GitHub only once the PR merges; confirm or replace this URL then
// (the builder's needs-done list tracks it).
export const FILE_PROTECTION_DOCS = 'https://github.com/' + REPO + '/blob/main/SECURITY.md#file-protection';
export { FILE_PROTECTION_RISK }; // the warning's words, in protocol so the phone's Settings asks with them too (c18)
// The Settings page's UI settings (threat model row 15): one fixed shape, checked here, kept in the profile folder.
// pet: each focus mode's own pet settings: shown or not, size in pixels, a petdex pet per agent (system when the agent has
// none), and where the user dragged the top pets (top) and the in-chat pets (pane), as fractions of the window and the chat.
// Skipper is the System pet a new profile starts with (the pet that ships as the system default).
const petLook = on => Object.freeze({ on, size: 48, claude: null, codex: null, system: 'skipper', top: null, pane: null });
// name: what cards waiting on the user call them ("needs <name>"; '' leaves the name out).
// xfer: Send files' limits (apps/desktop/xfer.mjs), each a whole number from 1 to its ceiling.
const XFER_DEFAULTS = Object.freeze(Object.fromEntries(Object.entries(XFER_LIMITS).map(([key, limit]) => [key, limit.default])));
const checkXfer = x => exactly(x, 'fileMiB,files,sendGiB') && Object.entries(XFER_LIMITS).every(([key, limit]) => Number.isInteger(x[key]) && x[key] >= 1 && x[key] <= limit.max);
export const DEFAULT_SETTINGS = Object.freeze({ zoom: 1, closeOnSend: false, focus: Object.freeze({ chat: true, dev: true, mission: true }),
  pet: Object.freeze({ chat: petLook(true), dev: petLook(false), mission: petLook(false) }), name: '', xfer: XFER_DEFAULTS });
const NAME = /^[^\p{Cc}\p{Cf}]{0,40}$/u;
const exactly = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === keys;
const petName = name => name === null || (typeof name === 'string' && PET_NAME.test(name));
const spot = at => at === null || (Array.isArray(at) && at.length === 2 && at.every(n => Number.isFinite(n) && n >= 0 && n <= 1));
const checkPet = p => exactly(p, 'claude,codex,on,pane,size,system,top') && typeof p.on === 'boolean' && Number.isInteger(p.size) && p.size >= 24 && p.size <= 128
  && [p.claude, p.codex, p.system].every(petName) && spot(p.top) && spot(p.pane)
  && { on: p.on, size: p.size, claude: p.claude, codex: p.codex, system: p.system, top: p.top && [...p.top], pane: p.pane && [...p.pane] };
export function checkSettings(value) {
  if (!exactly(value, 'closeOnSend,focus,name,pet,xfer,zoom') || !checkXfer(value.xfer) || typeof value.closeOnSend !== 'boolean' || !Number.isFinite(value.zoom)
      || typeof value.name !== 'string' || !NAME.test(value.name)
      || value.zoom < 0.5 || value.zoom > 3 || !exactly(value.focus, 'chat,dev,mission') || !exactly(value.pet, 'chat,dev,mission')) return null;
  const focus = value.focus, pet = { chat: checkPet(value.pet.chat), dev: checkPet(value.pet.dev), mission: checkPet(value.pet.mission) };
  if (![focus.chat, focus.dev, focus.mission].every(on => typeof on === 'boolean') || !(focus.chat || focus.dev || focus.mission)) return null;
  if (!pet.chat || !pet.dev || !pet.mission) return null;
  return { zoom: value.zoom, closeOnSend: value.closeOnSend, focus: { chat: focus.chat, dev: focus.dev, mission: focus.mission }, pet, name: value.name,
    xfer: { fileMiB: value.xfer.fileMiB, files: value.xfer.files, sendGiB: value.xfer.sendGiB } };
}
// Older files: no pet, one pet name, or one pet per agent ({ claude, codex, system }) become every focus's pets, shown in Chat only.
// Files from before the name get the account's (below). startLast (0.1.8's "Start in my last focus mode") went with the landing
// page (O122): an old file's is dropped, so the file still loads.
export function upgradeSettings(file, name = '') {
  const old = file?.pet;
  if (old === undefined || old === null || typeof old === 'string' || exactly(old, 'claude,codex,system')) {
    const roles = typeof old === 'string' || old == null ? { claude: null, codex: null, system: old ?? null } : old; // an older file keeps its own (no) pet
    file = { ...file, pet: Object.fromEntries(['chat', 'dev', 'mission'].map(f => [f, { ...petLook(f === 'chat'), ...roles }])) };
  }
  const { startLast, ...rest } = file ?? {};
  return { name, xfer: XFER_DEFAULTS, ...rest };
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
// The Dev Focus page itself (query and hash aside); any other p9://dev/ file is an asset, never a page with IPC.
const isDevPage = url => url.split(/[?#]/)[0] === DEV_URL;




export async function createDesktop({ state, open } = {}) {
  // outer: createDesktop's names that the modules split out of it (F9) read and set; getters and setters keep them live.
  const outer = { spikeShell: event => spikeShell(event), get APP_URL() { return APP_URL; }, get cardsHide() { return cardsHide; }, set cardsHide(v) { cardsHide = v; },
    get cardsItems() { return cardsItems; }, set cardsItems(v) { cardsItems = v; },
    get cardsView() { return cardsView; }, set cardsView(v) { cardsView = v; }, get devFolder() { return devFolder; },
    get devReady() { return devReady; }, set devReady(v) { devReady = v; }, get devServing() { return devServing; },
    get devToWorkspace() { return devToWorkspace; }, get devView() { return devView; }, get editorHost() { return editorHost; },
    get fromApp() { return fromApp; }, get fromDev() { return fromDev; }, get localState() { return localState; }, get look() { return look; },
    get openDev() { return openDev; }, get petsFolder() { return petsFolder; }, get queued() { return queued; }, get serve() { return serve; },
    get serverHost() { return serverHost; }, get serverLast() { return serverLast; }, get serverUpdate() { return serverUpdate; },
    get settings() { return settings; }, get sites() { return sites; }, get sshCommand() { return sshCommand; }, get state() { return state; },
    get tellUpdate() { return tellUpdate; }, set tellUpdate(v) { tellUpdate = v; },
    get updateWindow() { return updateWindow; }, set updateWindow(v) { updateWindow = v; }, get uuid() { return uuid; },
    get window() { return window; } };
  // KDE/GNOME on Wayland match a window to its menu entry and icon by app id; without this it is "electron" (generic icon).
  if (process.platform === 'linux') app.setDesktopName('p9-event-horizon.desktop');
  // Lets the freeze record read the stack a hung page is stuck in (with the Document-Policy header serve() sends).
  app.commandLine.appendSwitch('enable-features', 'DocumentPolicyIncludeJSCallStacksInCrashReports');
  await app.whenReady();
  // F3 (list 21): these reads start together, beside appSite() below (accountName runs 'net user' on Windows); each is awaited where it was.
  const settingsFile = path.join(app.getPath('userData'), 'p9-settings.json'), serverFile = path.join(app.getPath('userData'), 'p9-server.json');
  const petsFolder = path.join(app.getPath('userData'), 'pets');
  const nameSoon = accountName(), settingsSoon = readFile(settingsFile, 'utf8'), savedSoon = readFile(serverFile, 'utf8'), petsSoon = lstat(petsFolder).catch(() => null);
  settingsSoon.catch(() => {}); savedSoon.catch(() => {}); // read below; a missing file is handled there
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
    // O6b: a dev window (--state %LOCALAPPDATA%\p9-dev\runtime) wakes its own task 'P9 p9-dev', and never re-registers
    // anything at launch: the dev task is set up by hand (install-windows.ps1 -Unit), so the daily task is not touched.
    const unit = unitOf(localState), task = await windowsTask(unit);
    reason = !task ? 'task-missing' : task.execute !== 'conhost.exe' ? 'task-stale' : 'not-answering';
    if (reason !== 'not-answering' && app.isPackaged && !repaired && unit === 'p9-foundation') {
      repaired = true;
      if (await repairWindowsTask(process.resourcesPath)) { reason = 'not-answering'; return; }
    }
    if (task) execFile('schtasks.exe', ['/Run', '/TN', windowsTaskName(unit)], { windowsHide: true }, () => {});
  };
  // AU4: the AppImage's mount goes when it quits, so its daemon is copied out and the service installed, or restarted onto
  // the new version after an update (teh.mjs appImageService, which logs and never throws). Once per launch.
  const appImage = process.platform === 'linux' && app.isPackaged && Boolean(process.env.APPIMAGE);
  // O22: a system library the staged daemon node cannot load (libatomic1) is named in the status, so the window says it.
  let missingLib = null;
  const serviceResult = appImage ? appImageService(process.resourcesPath).then((result) => { missingLib = result?.missing ?? null; return result; }) : null;
  // Item 16 (threat model row 52): the AppImage carries the pinned editor server (package-linux.mjs) and installs it from that
  // copy, checked against the same SHA-256 as the download, when ~/.local/share/p9's is missing or another release (a first
  // start, or an update that moved the pin). Dev Focus's Install uses the copy too, so no network is needed. Logs, never throws.
  const editorCopy = appImage ? [path.join(process.resourcesPath, 'editor', 'reh.tar.gz'), EDITOR_DOWNLOADS.x64[1]] : undefined;
  let editorInstall = null;
  const installEditor = () => editorInstall ??= installEditorHost({ download: editorCopy }).finally(() => { editorInstall = null; });
  if (editorCopy) readFile(path.join(EDITOR_DIR, 'codium-server', 'product.json'), 'utf8').then(text => JSON.parse(text).commit, () => null)
    .then(commit => commit === EDITOR_COMMIT || installEditor().then(() => console.log('P9: editor server installed from the AppImage'),
      error => console.error('P9: the editor server was not installed from the AppImage: ' + error.message)));
  const webDist = fileURLToPath(new URL('../web/dist/', import.meta.url));
  const appSite = async () => {
    const files = await assets(webDist);
    const html = files.get('/index.html').toString('utf8');
    return { files, csp: `default-src 'none'; script-src 'self' ${inlineHashes(html).join(' ')}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src ${FRAME_URL}; frame-ancestors 'none'` };
  };
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2',
    '.woff': 'font/woff', '.ttf': 'font/ttf', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.mp3': 'audio/mpeg',
    '.webp': 'image/webp', '.mp4': 'video/mp4' };
  // Three origins: p9://app (the shell), p9://dev (Dev Focus, filled once the editor host is up) and p9://webview (its
  // extension pages). Each gets its own CSP, and each session serves only its own origins.
  const sites = { app: await appSite() };
  // Item 19 (threat model row 65): the artifact frame's page on its own origin, p9://frame/, with nothing else there.
  sites.frame = { get files() { return new Map([['/index.html', sites.app.files.get('/frame/index.html')]]); }, csp: FRAME_CSP + '; frame-ancestors p9://app' };
  const serve = (...hosts) => request => {
    const url = new URL(request.url);
    const key = url.pathname === '/' ? '/index.html' : url.pathname;
    const site = hosts.includes(url.host) && Object.hasOwn(sites, url.host) ? sites[url.host] : null, data = site?.files.get(key);
    if (request.method !== 'GET' || url.username || url.password || url.port || !data) return new Response('Not found', { status: 404 });
    return new Response(data, { headers: { 'Content-Type': types[path.extname(key)] ?? 'application/octet-stream', 'Content-Security-Policy': site.csp, 'X-Content-Type-Options': 'nosniff', 'Document-Policy': 'include-js-call-stacks-in-crash-reports' } });
  };
  sites.chat = { get files() { return sites.app.files; }, csp: sites.app.csp.replace("frame-ancestors 'none'", 'frame-ancestors p9://dev p9://webview') }; // SPIKE o294
  protocol.handle('p9', serve('app', 'frame'));
  const name = await nameSoon;
  let settings = checkSettings(await settingsSoon.then(text => upgradeSettings(JSON.parse(text), name)).catch(() => null)) ?? { ...structuredClone(DEFAULT_SETTINGS), name };
  let settingsSaving = Promise.resolve();
  // Server mode (remote.mjs, threat model row 50): while a host is chosen, state is that server's forward, else this machine's
  // daemon. Both daemons keep running; switching reloads the window onto the other. The choice is kept in p9-server.json.
  const localState = state;
  const sshCommand = (!app.isPackaged && process.env.P9_SSH) || 'ssh'; // P9_SSH: the tests' stand-in, source checkouts only
  // last: the host used before, so Local can show a one-click way back.
  const saved = await savedSoon.then(text => JSON.parse(text), () => ({})), named = h => typeof h === 'string' && HOST.test(h) ? h : null;
  // Aborted on quit: ends a forward connectServer is still waiting on (a quit mid-connect left its ssh running).
  const leaving = new AbortController();
  // O95: a switch ends the attempt it replaces (tries) and waits for it (connecting) before its own starts: both use this
  // host's one forward folder, and the old one, finishing after the new one was up, took the socket and removed the folder.
  let tries = new AbortController(), connecting = Promise.resolve();
  // 0.1.8 Settings > Open P9 on (openOn): null, where it was last (host, as before); '', this computer; a host, that remote,
  // which connects like Connect does and shows the connecting screen while it cannot be reached.
  let openOn = saved?.openOn === '' ? '' : named(saved?.openOn);
  let openOnKept = openOn, openOnTurn = 0; // what the file holds (moved only when a write lands); a count of the choices made
  let serverHost = openOn === '' ? null : openOn ?? named(saved?.host), serverLast = named(saved?.last) ?? serverHost, server = null, serverError = null, serverTry = 0, knownHosts = null;
  // D3: the remotes added in Settings, beside the ~/.ssh/config hosts. None is built in.
  let remotes = Array.isArray(saved?.remotes) ? saved.remotes.filter(named) : [];
  // Row 79: P9's own ssh key, in its data folder; noKey: the remotes whose key offer got Don't ask again.
  const sshKeyFile = path.join(app.getPath('userData'), 'ssh', 'p9_ed25519');
  useKey(sshKeyFile);
  let noKey = Array.isArray(saved?.noKey) ? saved.noKey.filter(named) : [];
  // O250, O258 (stablePort): host ('' for this computer's own editor) -> its editor ports, the one in use first. No prototype: a host may be named constructor.
  const devPorts = Object.assign(Object.create(null), Object.fromEntries(Object.entries(saved?.devPorts && typeof saved.devPorts === 'object' ? saved.devPorts : {})
    .map(([h, ports]) => [h, Array.isArray(ports) ? ports.filter(p => Number.isInteger(p) && p > 1023 && p < 65536) : []]).filter(([h, ports]) => (h === '' || named(h)) && ports.length)));
  // stablePort's kept and others for one editor; keepPort puts the port it got first and saves it.
  const portsOf = key => [devPorts[key] ?? [], new Set(Object.entries(devPorts).flatMap(([h, ports]) => h === key ? [] : ports))];
  const keepPort = (key, port) => {
    const kept = devPorts[key] ?? [];
    if (kept[0] === port) return;
    devPorts[key] = [port, ...kept.filter(p => p !== port)];
    keepServer().catch(error => console.error('p9: the editor port was not saved, the next start may open the editor empty:', error.message));
  };
  // The agents each remote's slim Temporary P9 gets (claude, codex, both or none), asked once in the window
  // after connecting; the install there sends none, and fetchAgents below asks that daemon for these once connected.
  // agentsAgain: the machine menu's AI agents item asks again on this remote (this launch only).
  const pickable = list => Array.isArray(list) && list.length <= AGENT_IDS.length && new Set(list).size === list.length && list.every(a => AGENT_IDS.includes(a));
  const agentsFor = Object.fromEntries(Object.entries(saved?.agents && typeof saved.agents === 'object' ? saved.agents : {}).filter(([h, list]) => named(h) && pickable(list)));
  const agentsAgain = new Set(), agentsTried = new WeakSet();
  let agentsJob = null; // { host, names, phase: running | done | failed, error, at }
  const slimTried = new Map(); // review 2 L2: host -> the old slim version this launch reinstalled over
  // Row I1: Keep P9 running there? per host (keep.mjs), applied at each connect.
  // U8: Keep on the slim Temporary P9 there (P9_KEEP full) is the full install, with keep and this password if any.
  const keeper = createKeeper({ saved: saved?.keep, named, save: () => keepServer(), run: (h, action, password) => remoteMode(h, action, sshCommand, password)
    .then(r => { if (r.phase === 'full' && h === serverHost) runInstall(password, { full: true, keep: true }); return r; }) });
  // Temp file + rename, one write at a time: a reader (the next start, a test) never sees a half-written file, and two
  // quick saves cannot interleave. The data is read when the write starts, so the last save always wins.
  let serverSaving = Promise.resolve();
  const keepServer = () => serverSaving = serverSaving.catch(() => {}).then(() => {
    const wrote = openOn;
    return writeFile(serverFile + '.tmp', JSON.stringify({ host: serverHost, last: serverLast, remotes, keep: keeper.keep, noKey, agents: agentsFor, devPorts, ...(openOn !== null && { openOn }) }), { mode: 0o600 })
      .then(() => rename(serverFile + '.tmp', serverFile)).then(() => { openOnKept = wrote; });
  });
  // The download runs on the remote (POST /setup/agents-fetch); the page shows its phase from p9:get-status.
  const fetchAgents = (host, names) => {
    if (!names.length || !server?.slim || (agentsJob?.host === host && agentsJob.phase === 'running')) return;
    const job = agentsJob = { host, names, phase: 'running' };
    daemonRequest(state, 'POST', '/setup/agents-fetch', Object.fromEntries(AGENT_IDS.map(a => [a, names.includes(a)])), undefined, 1320000) // review 3 L4: past the daemon's 1,300 s
      .then(r => r.status === 200 ? { phase: 'done' } : { phase: 'failed', error: r.status === 404 || r.body?.error === 'request-refused' ? 'daemon-outdated' : r.body?.detail ?? r.body?.error ?? 'daemon-unavailable' },
        () => ({ phase: 'failed', error: 'daemon-unavailable' }))
      .then(end => { if (agentsJob === job) agentsJob = { ...job, ...end, at: Date.now() }; });
  };
  // The server update's last event, kept for a window that loads after it (a switch reloads the window); tellUpdate is
  // pointed at the window once it exists.
  let serverUpdate = null, serverUpdating = false, tellUpdate = () => {}, updateWindow = null;
  // W1 (ask first, one rule for every build kind): a dialog naming both versions before this app
  // changes the server's P9. Not now leaves it as it is, and that host and pair are not asked again until the next launch.
  const updateDeclined = new Map();
  const askUpdate = async ({ host, server: there, app: here }) => {
    if (updateDeclined.get(host) === there + '>' + here) return false;
    const options = { type: 'question', title: 'Update P9 on ' + host + '?', message: 'P9 on ' + host + ' is ' + there + '. This app is ' + here + '.',
      detail: 'Update the server to ' + here + '? It waits for running turns to finish, then restarts. Not now leaves it on ' + there + '.',
      buttons: ['Not now', 'Update to ' + here], defaultId: 1, cancelId: 0, noLink: true };
    const { response } = await (updateWindow && !updateWindow.isDestroyed() ? dialog.showMessageBox(updateWindow, options) : dialog.showMessageBox(options));
    if (response !== 1) updateDeclined.set(host, there + '>' + here);
    return response === 1;
  };
  // D15a (remote-install.mjs, threat model row 67; U6: no separate yes): the install on this remote, its last event for the
  // status poll; phase 'starting' while setUp tries startServer first.
  let remoteInstall = null;
  // P9's own package.json, not app.getVersion(): started as electron start.cjs (scripts/p9.mjs, the tests) that is Electron's version.
  const ownVersion = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).version;
  // One attempt chain per choice (serverTry): retried 1 s, then doubling to 30 s; a drop starts it again.
  // Row 78: the ssh login waiting on the password window: { id, prompt, again, resolve }. One at a time; a new connect ends it.
  // dropped: the connection was up and fell (said in the password window). keyOffer: { host, id }, after a password login.
  let sshAsk = null, sshAsks = 0, dropped = false, keyOffer = null;
  // U6: set when runInstall exists (below); a connect that fails before then retries in 1 s and gets it.
  let setUp = () => {};
  // U8: the same for runInstall, which Keep on a slim remote and a slim remote's update call.
  let runInstall = () => ({ ok: false });
  // O8: each remote's starts and installs in flight (setUp, runInstall), chained per host so a later one, or another
  // remote's, never hides an earlier one. Disconnect waits for them before its stop, so a start or a slim reinstall that
  // lands after the stop cannot leave P9 on there. stopping: that remote's stop in flight, which a Connect to it waits for.
  // intent: counts the Connect, Switch, Local and Disconnect asks in the order they came, so one that waited (for a stop)
  // can tell a newer ask came meanwhile and leave the window where that one put it.
  const remoteBusy = new Map(), stopping = new Map();
  let intent = 0;
  const busyWith = (host, job) => { remoteBusy.set(host, Promise.all([remoteBusy.get(host), job]).then(() => {}, () => {})); return job; };
  const connect = async (attempt, wait = 1000, loggedIn = false) => {
    if (attempt !== serverTry || !serverHost) return;
    try {
      const pending = connectServer({ host: serverHost, ssh: sshCommand, signal: AbortSignal.any([leaving.signal, tries.signal]), onDrop: () => { if (attempt === serverTry && !leaving.signal.aborted) { server = null; serverError = 'server-dropped'; dropped = true; dropNote(attempt); connect(attempt); } } });
      connecting = pending.then(s => attempt === serverTry ? null : s.close(), () => {}).catch(() => {});
      const s = await pending;
      if (attempt !== serverTry) return; // closed by connecting
      const back = dropped; // O19: up again after a drop (the machine slept, rebooted or lost the network)
      server = s; serverError = null; dropped = false;
      if (back) devAgain(true);
      if (/^(starting|done)$/.test(remoteInstall?.phase)) remoteInstall = null; // U6: a later no-P9 sets up again
      keeper.connected(serverHost, !!s.background);
      if (!serverUpdating) {
        // Item 14 (server-update.mjs): an older server is updated from this app; a newer one only says to update this app.
        serverUpdating = true;
        updateServer({ state: s.state, check: s.check, version: ownVersion, host: serverHost, live: () => attempt === serverTry,
          checkout: !app.isPackaged && process.env.P9_PACKAGED !== '1' ? fileURLToPath(new URL('../../', import.meta.url)) : null,
          reinstall: s.slim ? old => {
            if (attempt !== serverTry || remoteInstall?.phase === 'running') return;
            if (slimTried.get(serverHost) === old) return false; // L2: once per host and old version, each launch
            slimTried.set(serverHost, old); runInstall();
          } : null,
          ask: askUpdate, tell: event => { serverUpdate = event; tellUpdate(event); } }).catch(() => {}).finally(() => { serverUpdating = false; });
      }
    } catch (error) {
      if (attempt !== serverTry) return; // an attempt replaced (O95: ended by its abort) says nothing over the new one
      serverError = error.message; knownHosts = error.knownHosts ?? null;
      // Row 78: a changed host key, or a remote that needs a key from this Windows computer, stops here until the person's
      // Try again: no password window, no timed retry.
      if (serverError === 'ssh-host-key-changed' || serverError === 'ssh-key-needed' || serverError === 'ssh-missing') return;
      // Row 78: key-only ssh refused. One login with the password window, then connect over it. Never retried on a timer:
      // a refused or cancelled login waits for the person's Try again.
      if (serverError === 'ssh-login-needed' && !loggedIn) {
        const r = await sshLogin({ host: serverHost, ssh: sshCommand, ask: a => new Promise(resolve => { sshAsk = { ...a, id: ++sshAsks, dropped, resolve }; }) });
        sshAsk?.resolve(null); sshAsk = null;
        if (attempt !== serverTry) return;
        // Row 79: the offer comes after every password login (a refused key included) unless this remote said Don't ask again.
        if (r === 'ok' && !noKey.includes(serverHost)) keyOffer = { host: serverHost, id: ++sshAsks };
        if (r === 'ok') return connect(attempt, wait, true);
        if (r?.changed !== undefined) { serverError = 'ssh-host-key-changed'; knownHosts = r.changed; return; }
        serverError = 'ssh-' + r;
        return;
      }
      if (serverError === 'ssh-login-needed') { serverError = 'ssh-failed'; return; }
      // A start that said ok but whose P9 still does not answer 30 s later (setUp's until) stops with Try again, never
      // "Starting P9" forever; the timer below keeps trying, so a late answer still connects. Try again starts it again.
      if ((remoteInstall?.phase === 'starting' && serverError !== 'server-no-p9' || remoteInstall?.phase === 'done') && remoteInstall.until < Date.now()) remoteInstall = { phase: 'failed', error: 'not-answering', started: remoteInstall.started };
      else if (serverError === 'server-no-p9' || serverError === 'server-not-answering') setUp(serverHost, serverError === 'server-not-answering');
      setTimeout(() => connect(attempt, Math.min(wait * 2, 30000)), wait);
    }
  };
  // A connection that dropped on its own and is still down 30 s later is a notification; a shorter blip
  // stays quiet (D20). A disconnect, a switch or a quit is on purpose and says nothing.
  const dropNote = attempt => { const host = serverHost; setTimeout(() => { if (attempt === serverTry && !server && !leaving.signal.aborted) tellUpdate({ phase: 'dropped', host }); }, 30000); };
  const useServer = async host => {
    const attempt = ++serverTry, old = server;
    tries.abort(); tries = new AbortController();
    // A finished install stays for its own remote while it reconnects, so the window says installed, not Install again.
    serverUpdate = null; if (remoteInstall?.phase !== 'running' && !(/^(done|starting)$/.test(remoteInstall?.phase) && host === serverHost)) remoteInstall = null;
    sshAsk?.resolve(null); sshAsk = null; dropped = false; if (keyOffer?.host !== host) keyOffer = null;
    server = null; serverError = null; serverHost = host; serverLast = host ?? serverLast;
    state = host ? serverFolder(host) : localState;
    await old?.close().catch(() => {});
    await connecting;
    await keepServer();
    connect(attempt);
  };
  if (serverHost) { state = serverFolder(serverHost); connect(++serverTry); }
  // Here, not beside wake(): wake() reads serverHost, which does not exist before this point.
  if (process.platform === 'win32' && localState) health(localState).catch(wake);
  app.on('will-quit', () => { serverTry++; leaving.abort(); server?.close().catch(() => {}); });
  // A profile with no pets folder yet gets the bundled Skipper through Add's checks; one the user removes stays removed.
  if (!(await petsSoon)) await addPet(petsFolder, fileURLToPath(new URL('pets/skipper', import.meta.url))).catch(() => null);
  // Copy buttons write plain text (threat model row 19) and turn-finished notices show (row 21); everything else, clipboard read included, stays refused.
  // Only for the shell itself: an artifact's frame (item 19, row 65) gets neither.
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => callback(details?.isMainFrame !== false && (permission === 'clipboard-sanitized-write' || permission === 'notifications')));
  session.defaultSession.setPermissionCheckHandler((_contents, permission, _origin, details) => details?.isMainFrame !== false && (permission === 'clipboard-sanitized-write' || permission === 'notifications'));
  // Item 19 (row 65), behind the frame's CSP: the window's session refuses every request a subframe makes; only the frame's page loads.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    let sub = false; try { sub = !!details.frame?.parent; } catch {} // no frame (a worker, a frame already gone): the CSP alone decides
    callback({ cancel: sub && !(details.resourceType === 'subFrame' && details.url === FRAME_URL) });
  });
  const version = ownVersion;
  // Auto-update's lines (threat model row 39) and the rollback's (row 40) go to p9-update.log in the profile folder.
  // ponytail: never rotated, a few lines per check.
  const updateLog = line => appendFile(path.join(app.getPath('userData'), 'p9-update.log'), new Date().toISOString() + ' ' + line + '\n').catch(() => {});
  // AU5 (threat model row 40, rollback.mjs): wherever updates are on, each start is watched. A version never seen healthy
  // that has failed 2 starts goes back to the newest healthy one, through the launcher outside the install, and quits.
  const watched = offReason({ packaged: app.isPackaged, resources: process.resourcesPath, platform: process.platform, env: process.env }) === null;
  const startFile = path.join(app.getPath('userData'), 'update-state.json'), share = shareRoot();
  // D13: once per start, read before the window asks: the version this profile ran before, when this start is an update.
  let whatsNew = (from => from === null ? null : { version: ownVersion, from, link: 'https://github.com/' + REPO + '/commit/v' + ownVersion })(updatedFrom(app.getPath('userData'), ownVersion));
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
  // O25: no OS title bar on Windows and Linux; P9's top row is the title bar (drag region in shell.css) and the window
  // buttons are drawn over its right end, in the theme's foreground (p9:look). macOS keeps its own title bar.
  const overlay = process.platform !== 'darwin' && { color: '#00000000', symbolColor: '#ffffff', height: 44 };
  const window = new BrowserWindow({ width: 1440, height: 900, minWidth: 720, minHeight: 600, backgroundColor: '#000000',
    ...(overlay && { titleBarStyle: 'hidden', titleBarOverlay: overlay }),
    webPreferences: { preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)), sandbox: true, contextIsolation: true,
      nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
      additionalArguments: ['--p9-version=' + version, '--p9-defaults=' + JSON.stringify(DEFAULT_SETTINGS), ...(process.env.P9_FIRST_RUN === 'off' ? ['--p9-first-run=off'] : []), // the test runs click the shell straight away
        ...(source ? ['--p9-source'] : []), ...(source && /^\d+$/.test(process.env.P9_SEND_CAP_MS ?? '') ? ['--p9-send-cap=' + process.env.P9_SEND_CAP_MS] : [])] } });
  window.removeMenu();
  // D13.5: opens maximised every time. ponytail: a later un-maximise is not remembered; a saved flag if people ask.
  window.maximize();
  // O135 part B: a service that runs another copy is moved onto the installed daemon only with the user's OK (use-installed.mjs
  // decides whether to ask; teh.mjs useInstalledDaemon moves it, or refuses and logs why). Keep my setup is remembered for that
  // checkout (keep-my-setup.json); Not now asks again next start. Linux AppImage only, once per launch.
  serviceResult?.then(async (result) => {
    const p9 = path.join(os.homedir(), '.local', 'share', 'p9'), keepFile = path.join(p9, 'keep-my-setup.json');
    const unit = Boolean(await stat(path.join(os.homedir(), '.config', 'systemd', 'user', 'p9-foundation.service')).catch(() => null));
    const from = (await health(localState).catch(() => null))?.from;
    if (daemonOffer({ result, from, keep: keptCheckout(await readFile(keepFile, 'utf8').catch(() => '')), unit, installed: path.join(p9, 'daemon') }) !== 'ask' || window.isDestroyed()) return;
    const { response } = await dialog.showMessageBox(window, { type: 'question', title: 'Use the installed P9?',
      message: 'P9\'s background service runs another copy, not P9 ' + ownVersion + '.',
      detail: 'It runs: ' + result.checkout + '\n\nUse the installed P9 moves the service onto the copy this update installed, with the same workspace. The old service file is kept as a backup and put back if the new one does not start. Running chats, scripts and terminals stop.\n\nKeep my setup leaves it as it is and does not ask again.',
      buttons: ['Not now', 'Keep my setup', 'Use the installed P9'], defaultId: 0, cancelId: 0, noLink: true });
    if (response === 1) {
      // A failed write is said, not swallowed: the user would be asked again next start with no word why.
      const failed = await failureOf(mkdir(p9, { recursive: true, mode: 0o700 }).then(() => writeFile(keepFile, keepText(result.checkout), { mode: 0o600 })));
      if (!failed) return;
      updateLog('keep my setup not saved: ' + failed);
      if (window.isDestroyed()) return;
      return guarded(() => dialog.showMessageBox(window, { type: 'warning', title: 'Keep my setup', message: 'P9 could not save your choice to keep this setup.',
        detail: failed + '\n\nThe service is unchanged. P9 will ask again at the next start. File: ' + keepFile, noLink: true }), updateLog, 'keep my setup warning failed');
    }
    if (response !== 2) return;
    const moved = await useInstalledDaemon({ checkout: result.checkout, seen: result.seen, state: localState });
    if (window.isDestroyed()) return;
    await dialog.showMessageBox(window, { type: moved.done ? 'info' : 'warning', title: 'Use the installed P9',
      message: moved.done ? 'The background service now runs P9 ' + moved.version + '.' : 'The background service was not moved (' + moved.error + ').',
      detail: (moved.done ? 'The old service file is kept as ' + moved.backup + '.' : moved.restored === false ? 'Putting the old service back failed; the old service file is ' + moved.backup + '.'
        : moved.restored ? 'The old service is back as it was.' : 'Nothing was changed.') + ' Details: ' + path.join(p9, 'service-install.log'), noLink: true });
  }).catch((error) => updateLog('use installed offer failed: ' + (error?.message || String(error))));
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
    const menu = contextMenu(params, word => window.webContents.replaceMisspelling(word), word => window.webContents.session.addWordToSpellCheckerDictionary(word),
      { copyImage: () => window.webContents.copyImageAt(params.x, params.y), copyLink: url => clipboard.writeText(url) });
    if (menu.length) Menu.buildFromTemplate(menu).popup({ window });
  });
  window.webContents.on('will-navigate', (event, url) => { if (url !== APP_URL) event.preventDefault(); });
  window.webContents.on('will-frame-navigate', event => { if (!event.isMainFrame && event.url !== FRAME_URL) event.preventDefault(); }); // item 19: only the artifact frame's page
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  // Freeze record (the window froze until the app was closed and reopened): when the window
  // stops answering, the JavaScript it is stuck in goes to p9-freeze.log in the profile folder, then how long it lasted.
  // "no stack" means it was stuck outside JavaScript (layout, paint, an IPC wait). Kept as daemon.log is (trimLog): over 5 MB
  // it goes to p9-freeze.log.1 and starts again, checked before each line; the lines are written one at a time, in order.
  const freezeLog = path.join(app.getPath('userData'), 'p9-freeze.log');
  let noting = Promise.resolve();
  const note = line => {
    const text = new Date().toISOString() + ' ' + line + '\n';
    noting = noting.then(() => trimLog(freezeLog)).then(() => appendFile(freezeLog, text)).catch(() => {});
  };
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
    if (!spikeShell(event)
        || action !== 'mode' || !payload || Object.keys(payload).join(',') !== 'persistent' || typeof payload.persistent !== 'boolean') throw new Error('ipc-sender-refused');
    persistent = payload.persistent;
    return { ok: true };
  });
  app.on('before-quit', (event) => {
    // Server mode: quitting this window never stops the server's chats; the phone may be in one.
    if (persistent || stoppingBeforeQuit || !state || serverHost) return;
    event.preventDefault();
    stoppingBeforeQuit = true;
    daemonRequest(state, 'POST', '/stop-all', {}, randomBytes(16).toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*/, '$1-$2-$3-$4-$5'))
      .catch(() => {}).finally(() => app.quit());
  });
  ipcMain.handle('p9:get-status', async (event, ...args) => {
    if (!spikeShell(event) || args.length) throw new Error('ipc-sender-refused');
    // savedWorkspace: the saved folder was not there at the daemon's start, so it runs on the default (apps/server/main.mjs).
    // Server mode: mode and host for the title-bar badge; error says why it is not connected yet (remote.mjs codes).
    if (serverHost) {
      // A check that answers after a switch is the old connection's: not ok for the new one.
      const was = server, h = await server?.check().then(r => was === server && r, () => null);
      // background: P9 there stops when nobody uses it (row I1); ask: the Keep P9 running question is due.
      const there = { ...keeper.status(serverHost, !!server?.background), ...(server?.slim && { slim: true }), ...(keyOffer?.host === serverHost && { keyOffer: { id: keyOffer.id } }) };
      // The agents: asked when this remote has no choice yet (or the machine menu asked again); a stored choice is fetched once per
      // connection (an update there may have brought new versions; ones already there are skipped); a finished job shows 30 s.
      if (h?.status === 'ok' && server?.slim) {
        if (!Object.hasOwn(agentsFor, serverHost) || agentsAgain.has(serverHost)) there.agentsAsk = agentsFor[serverHost] ?? [];
        else if (!agentsTried.has(server)) { agentsTried.add(server); fetchAgents(serverHost, agentsFor[serverHost]); }
      }
      const job = agentsJob?.host === serverHost && (agentsJob.phase !== 'done' || Date.now() - agentsJob.at < 30000) ? agentsJob : null;
      if (job) there.agents = { phase: job.phase, names: job.names, ...(job.error && { error: job.error }) };
      return h?.status === 'ok' ? { status: 'ok', mode: 'server', host: serverHost, ...there } : { status: 'unavailable', mode: 'server', host: serverHost, error: serverError ?? (server ? 'server-not-answering' : 'server-connecting'), ...(serverError === 'ssh-host-key-changed' && knownHosts && { knownHosts }), ...(remoteInstall && { install: remoteInstall }), ...(sshAsk && { sshAsk: { id: sshAsk.id, prompt: sshAsk.prompt, again: sshAsk.again, dropped: sshAsk.dropped } }) };
    }
    try {
      const h = state && await health(state);
      // O135: an update can leave the service on another daemon (a unit or drop-in naming an older copy). Say which, and where
      // it runs from (/health from; a daemon older than #261 has none), instead of Daemon connected.
      const other = h?.version && h.version !== ownVersion && [`Daemon ${h.version}, not ${ownVersion}` + (h.from ? ': ' + h.from : ''),
        `This window is P9 ${ownVersion}, but its background service still runs ${h.version}` + (h.from ? ' from ' + h.from : '') + '. Updating P9 did not move it; start the service from the installed P9 to use ' + ownVersion + '.'];
      if (h?.status === 'ok') return { status: 'ok', ...(h.savedWorkspace ? { savedWorkspace: h.savedWorkspace, workspace: h.workspace } : {}), ...(other && { note: other }) };
    } catch {}
    if (process.platform !== 'win32' || !state) return { status: 'unavailable', ...(missingLib && { reason: 'missing-library', library: missingLib }) };
    await wake();
    return { status: 'unavailable', reason };
  });
  ipcMain.handle('p9:usage', async (event, ...args) => {
    if (!spikeShell(event) || args.length) throw new Error('ipc-sender-refused');
    if (!state) return { status: 503, body: { state: 'unavailable' } };
    try { return await daemonRequest(state, 'GET', '/usage'); }
    catch { return { status: 503, body: { state: 'unavailable' } }; }
  });
  // A3 (2): the Usage window's Tokens and Cost tabs, one range of the route's (usage-turns.mjs RANGES) a call.
  ipcMain.handle('p9:usage-turns', async (event, ...args) => {
    if (!spikeShell(event)
      || args.length !== 1 || ![1, 7, 30, 90].includes(args[0])) throw new Error('ipc-sender-refused');
    if (!state) return { status: 503, body: { state: 'unavailable' } };
    try { return await daemonRequest(state, 'GET', '/usage/turns?days=' + args[0]); }
    catch (error) { return error?.status === 404 ? { status: 404, body: { state: 'unsupported' } } : { status: 503, body: { state: 'unavailable' } }; }
  });
  // Anymouse: the daemon files the note, or answers with GitHub's prefilled new-issue page for P9's repo, which only
  // this exact prefix (anymouse.mjs NEW_ISSUE) may open (in the user's browser). ponytail: P9_OPEN_URL swaps the browser for a test logger.
  ipcMain.handle('p9:anymouse', async (event, ...args) => {
    const [payload] = args;
    if (!spikeShell(event)
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
    const cut = result.body.cut === true, counts = cut && Number.isSafeInteger(result.body.kept) && Number.isSafeInteger(result.body.total);
    return { status: 200, body: { opened: true, cut, ...(counts ? { kept: result.body.kept, total: result.body.total } : {}) } };
  });
  // Wizard sign-in (threat model row 31): the daemon runs the agent's own login CLI. "Browser didn't open?" opens the
  // URL the CLI printed only after signInUrl's origin check. The page sees whether a URL exists, never the URL or any other
  // output; D8: Codex's one-time code is shown, and only when it has exactly a code's shape.
  ipcMain.handle('p9:agent-login', async (event, ...args) => {
    const [action, agent, code] = args;
    if (!spikeShell(event)
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
        { running: result.body[name]?.running === true, url: typeof result.body[name]?.url === 'string' && signInUrl(name, result.body[name].url) !== null,
          code: SIGN_IN_KIND[name] === 'device-code' && typeof result.body[name]?.code === 'string' && DEVICE_CODE.test(result.body[name].code) ? result.body[name].code : null,
          unsupported: result.body[name]?.unsupported === true, exit: Number.isInteger(result.body[name]?.exit) ? result.body[name].exit : null }])) };
      const open = typeof result.body[agent]?.url === 'string' ? signInUrl(agent, result.body[agent].url) : null;
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
    link: body => ['POST', '/mission/link', body], // rows 74, 75: opened below, on this computer
    answer: body => ['POST', '/mission/answer', body],
    // Data tiles (threat model row 70): one tile's last answer, and the user's Allow for it.
    data: ({ id: tile }) => id(tile) && ['GET', '/mission/data?' + new URLSearchParams({ id: tile })],
    card: ({ id: card }) => id(card) && ['GET', '/mission/card?' + new URLSearchParams({ id: card })], // a card's HTML (row M5)
    dataAllow: ({ id: tile }) => id(tile) && ['POST', '/mission/data/allow', { id: tile }],
    spaceLog: ({ name }) => typeof name === 'string' && ['GET', '/mission/space-log?' + new URLSearchParams({ name })],
    fix: ({ id: item, path: file, mode }) => id(item) && typeof file === 'string' && ['POST', '/mission/fix', { id: item, path: file, ...(typeof mode === 'string' ? { mode } : {}) }], // MC-1: the pill's mode; the daemon checks it
    // Onboarding and the space picker (threat model rows 71, 72): the daemon checks each name again.
    guide: () => ['GET', '/mission/guide'],
    template: ({ name, space, confirm }) => typeof name === 'string' && ['POST', '/mission/template', { name, ...(space !== undefined ? { space } : {}), ...(confirm !== undefined ? { confirm } : {}) }],
    // MC-17: template, the template a new space starts from; confirm, the user's second click under File protection.
    build: ({ provider, space, mode, template, confirm }) => AGENT_IDS.includes(provider) && ['POST', '/mission/build', { provider, ...(space !== undefined ? { space } : {}), ...(typeof mode === 'string' ? { mode } : {}),
      ...(typeof template === 'string' ? { template } : {}), ...(confirm === true ? { confirm } : {}) }],
    space: ({ name }) => (name === null || typeof name === 'string') && ['POST', '/mission/space', { name }],
    deleteSpace: ({ name, confirm }) => typeof name === 'string' && ['POST', '/mission/space/delete', { name, ...(confirm !== undefined ? { confirm } : {}) }],
    saveTemplate: ({ name, about, replace }) => typeof name === 'string' && ['POST', '/mission/template/save', { name, ...(about !== undefined ? { about } : {}), ...(replace !== undefined ? { replace } : {}) }],
    // Sprint tracker: the connected machine's status file, and a terminal attached to its sprint tmux session (no body).
    sprint: () => ['GET', '/mission/sprint'],
    sprintTmux: () => ['POST', '/mission/sprint/tmux', {}],
    // Folder sprints (SECURITY.md "Applying to your folder is a yes"): the copies, one copy's change to show, its close view,
    // and the owner's yes for exactly the change shown (the daemon checks yes and the digest again).
    sprintCopies: () => ['GET', '/sprints'],
    sprintPreview: ({ id }) => uuid(id) && ['GET', '/sprints/' + id + '/apply'],
    sprintClose: ({ id }) => uuid(id) && ['GET', '/sprints/' + id + '/close'],
    sprintApply: ({ id, shown, ...rest }) => uuid(id) && typeof shown === 'string' && !Object.keys(rest).length && ['POST', '/sprints/' + id + '/apply', { yes: true, shown }],
    idea: ({ name, text, needs_done }) =>[name, text].every(v => typeof v === 'string') && typeof needs_done === 'boolean' && ['POST', '/mission/idea', { name, text, needs_done }],
    // Chat Focus file browser (threat model row 23): read-only; the daemon applies the file routes' path and File protection rules.
    list: ({ path: dir = '' }) => typeof dir === 'string' && ['GET', '/files/list?' + new URLSearchParams({ path: dir })],
    projectList: ({ project, path: dir = '' }) => uuid(project) && typeof dir === 'string' && ['GET', '/files/list?' + new URLSearchParams({ project, path: dir })],
    projectRead: ({ project, path: file }) => uuid(project) && typeof file === 'string' && ['GET', '/files?' + new URLSearchParams({ project, path: file })],
    projectImage: ({ project, path: file }) => uuid(project) && typeof file === 'string' && ['GET', '/files/image?' + new URLSearchParams({ project, path: file })],
    folders: ({ path: dir = '' }) => typeof dir === 'string' && ['GET', '/files/folders?' + new URLSearchParams({ path: dir })], // U4: Unrestricted only
    read: ({ path: file }) => typeof file === 'string' && ['GET', '/files?' + new URLSearchParams({ path: file })],
    image: ({ path: file }) => typeof file === 'string' && ['GET', '/files/image?' + new URLSearchParams({ path: file })],
    // The Chat Focus file window's Save (row 23): exactly the guarded PUT /files, which re-checks the path, locked names and the hash.
    save: ({ path: file, hash, content, ...rest }) => !Object.keys(rest).length && typeof file === 'string' && file.length <= 1000 && typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)
      && typeof content === 'string' && Buffer.byteLength(content) <= 2 * 1024 * 1024 && ['PUT', '/files', { path: file, hash, content }],
    // Notes (threat model row 34): the daemon checks the root name against settings, the path, .md and File protection.
    notes: ({ root }) => id(root) && ['GET', '/mission/notes?' + new URLSearchParams({ root })],
    noteRead: ({ root, path: file }) => id(root) && typeof file === 'string' && ['GET', '/mission/notes/file?' + new URLSearchParams({ root, path: file })],
    noteSave: body => ['POST', '/mission/notes/save', body],
    // Folder lists (row 68): read-only; the daemon lists again and opens only a file its own list holds.
    folder: ({ id: item }) => id(item) && ['GET', '/mission/folder?' + new URLSearchParams({ id: item })],
    folderFile: ({ id: item, path: file }) => id(item) && typeof file === 'string' && ['GET', '/mission/folder/file?' + new URLSearchParams({ id: item, path: file })],
    // Checklists (row M4-a): the daemon lists the item's files again and writes one mark or one review line over the hash read.
    checklist: ({ id: item }) => id(item) && ['GET', '/mission/checklist?' + new URLSearchParams({ id: item })],
    checklistSet: body => ['POST', '/mission/checklist', body],
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
    if (!spikeShell(event)
        || args.length > 2 || !Object.hasOwn(missionRoutes, action) || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('ipc-sender-refused');
    const route = missionRoutes[action](payload);
    if (!route) return { status: 400, body: { error: 'request-refused' } };
    if (!state) return { status: 503, body: { error: 'daemon-unavailable' } };
    try {
      const result = await daemonRequest(state, route[0], route[1], route[2], undefined, action === 'fix' ? AGENT_START_MS : undefined);
      if (action === 'link' && result.status === 200) {
        // The daemon checked page_schemes; main checks the never list again before another program gets the link.
        let url = null;
        try { url = typeof result.body?.open === 'string' && result.body.open.length <= 2400 && !/[\s\p{Cc}\p{Cf}]/u.test(result.body.open) ? new URL(result.body.open) : null; } catch {}
        if (!url || ['javascript:', 'file:', 'data:', 'vbscript:', 'blob:'].includes(url.protocol) || url.username || url.password) return { status: 502, body: { error: 'request-refused' } };
        if (process.env.P9_OPEN_URL) spawn(process.env.P9_OPEN_URL, [url.href], { shell: false, stdio: 'ignore' }).on('error', () => {});
        else await shell.openExternal(url.href);
        return { status: 200, body: { opened: true } };
      }
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
    if (!spikeShell(event) || args.length) throw new Error('ipc-sender-refused');
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
  const wizardPaths = body => Object.entries(body).every(([key, value]) => ['primary', 'registry', 'waiting', 'scripts_root'].includes(key) && typeof value === 'string' && value.length <= 400);
  // Settings → Mission Control files (ST1/ST2): settings.json keys only, small values (null removes one); the daemon checks
  // the rest as it checks the file itself.
  const SETTINGS_KEYS = ['primary', 'registry', 'waiting', 'scripts_root', 'space', 'page_schemes', 'notes_roots'];
  const short = value => typeof value === 'string' && value.length <= 400;
  const settingsChange = body => Object.keys(body).length > 0 && Object.entries(body).every(([key, value]) => SETTINGS_KEYS.includes(key) && (value === null || short(value)
    || (Array.isArray(value) && value.length <= 16 && value.every(short))
    || (key === 'notes_roots' && typeof value === 'object' && Object.keys(value).length <= 16 && Object.entries(value).every(([name, folder]) => name.length <= 64 && short(folder)))));
  const chatRoutes = {
    list: () => ['GET', '/chat?lists=fresh'], // O47: with each agent's model lists
    // only/until (E2): one chat's history, or the chats still running at launch; the daemon checks them again.
    // tail (P20, with only): the newest tail blocks of each of those chats. shots: images as places (O249, chat-view.mjs).
    events: ({ after = 0, wait = 0, only, until, tail }) => Number.isSafeInteger(after) && after >= 0 && Number.isSafeInteger(wait) && wait >= 0 && wait <= 8000
      && (only === undefined || Array.isArray(only) && only.length <= 100 && only.every(uuid)) && (until === undefined || Number.isSafeInteger(until) && until >= 0)
      && (tail === undefined || only !== undefined && Number.isSafeInteger(tail) && tail >= 1 && tail <= 200)
      && ['GET', `/chat/events?shots=1&after=${after}&wait=${wait}${only ? '&only=' + only.join(',') : ''}${until === undefined ? '' : '&until=' + until}${tail === undefined ? '' : '&tail=' + tail}`],
    create: body => ['POST', '/chat', body],
    chatFolder: ({ id: item }) => uuid(item) && ['GET', `/chat/${item}/folder`],
    prompt: ({ id: chat, ...body }) => uuid(chat) && ['POST', `/chat/${chat}/prompt`, body],
    answer: ({ id: chat, ...body }) => uuid(chat) && ['POST', `/chat/${chat}/answer`, body],
    cancel: ({ id: chat }) => uuid(chat) && ['POST', `/chat/${chat}/cancel`],
    note: ({ id: chat, text, ...rest }) => uuid(chat) && typeof text === 'string' && text.length <= 20000 && !Object.keys(rest).length && ['POST', `/chat/${chat}/note`, { text }], // I3: the Sprint View's Note
    unhold: ({ id: chat, held, now }) => uuid(chat) && uuid(held) && (now === undefined || now === true) && ['POST', `/chat/${chat}/unhold`, { held, ...(now && { now }) }], // now (O255): the bolt, send it now
    goal: ({ id: chat, action, ...rest }) => uuid(chat) && (action === 'set' || action === 'clear') && !Object.keys(rest).length && ['POST', `/chat/${chat}/goal`, { action }], // O265: the goal line's buttons
    heldText: ({ id: chat, held, text, was }) => uuid(chat) && uuid(held) && typeof text === 'string' && text.length <= 100000 && typeof was === 'string' && was.length <= 100000 && ['POST', `/chat/${chat}/held-text`, { held, text, was }], // A2 step 3: edit a queued one
    stop: ({ id: chat, close, ...rest }) => uuid(chat) && (close === undefined || close === true) && !Object.keys(rest).length && ['POST', `/chat/${chat}/stop`, ...(close ? [{ close }] : [])],
    handoff: ({ id: chat }) => uuid(chat) && ['POST', `/chat/${chat}/handoff`],
    // O48 provider profiles (threat model "Provider profiles"): the daemon checks the body and never sends a key back.
    profiles: () => ['GET', '/profiles'],
    profileSave: body => ['POST', '/profiles', body],
    profileRemove: ({ id, ...rest }) => uuid(id) && !Object.keys(rest).length && ['DELETE', '/profiles/' + id],
    // O205 Settings > Devices: the phones that asked and the ones signed in, over this socket only (the TCP port has no
    // /devices); the page names an id, never a route.
    devices: body => !Object.keys(body).length && ['GET', '/devices'],
    deviceApprove: ({ id, ...rest }) => uuid(id) && !Object.keys(rest).length && ['POST', `/devices/enrollments/${id}/approve`],
    deviceRefuse: ({ id, ...rest }) => uuid(id) && !Object.keys(rest).length && ['POST', `/devices/enrollments/${id}/refuse`],
    deviceRemove: ({ id, ...rest }) => uuid(id) && !Object.keys(rest).length && ['POST', `/devices/${id}/revoke`],
    ...projectRoutes(uuid), // N1: projects and a chat's project, title, archive and delete
    // D7/D8: an agent's sign-in command typed into a new terminal; the daemon holds the commands, the page only names one.
    agentTerminal: ({ agent, action, ...rest }) => AGENT_IDS.includes(agent) && action === 'login' && !Object.keys(rest).length
      && ['POST', '/setup/agent-terminal', { agent, action }],
    // Item 15: the wizard's Install of the agents picked (launchers for the CLIs P9 ships), and a system package's admin
    // command typed into a terminal (row 61); the daemon holds the commands, the page only names a dependency.
    installAgents: body => exactly(body, [...AGENT_IDS].sort().join()) && AGENT_IDS.every(a => typeof body[a] === 'boolean')
      && ['POST', '/setup/agents', Object.fromEntries(AGENT_IDS.map(a => [a, body[a]]))],
    adminTerminal: ({ id, ...rest }) => ['tmux', 'ssh'].includes(id) && !Object.keys(rest).length && ['POST', '/setup/admin-terminal', { id }],
    // A worker's notes file (SECURITY.md § Sprint files): read-only; the daemon builds the name from the chat's parent and key.
    notes: ({ id: chat, ...rest }) => uuid(chat) && !Object.keys(rest).length && ['GET', `/chat/${chat}/notes`],
    image: ({ id: chat, hash }) => uuid(chat) && typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash) && ['GET', `/chat/${chat}/images/${hash}`],
    // O249: an agent's picture by its place in the events (the daemon's shot: "cursor/n"), fetched when it scrolls into view.
    shot: ({ id: chat, shot, ...rest }) => uuid(chat) && !Object.keys(rest).length && typeof shot === 'string' && /^\d{1,15}\/\d{1,2}$/.test(shot) && ['GET', `/chat/${chat}/shots/${shot}`],
    lock: () => ['GET', '/agent-lock'],
    agents: (body) => !Object.keys(body).length && ['GET', '/agents'], // CAT-1e: the catalog the setup wizard reads
    // The wizard's paths ride as plain text (the daemon parses them as settings.json would): GET /setup's plan for them, and
    // "Create my starter files" with them; {} is the settings file's paths, or the starter set in an empty folder.
    setup: body => wizardPaths(body) && ['GET', '/setup' + (Object.keys(body).length ? '?' + new URLSearchParams(body) : '')],
    starter: body => wizardPaths(body) && ['POST', '/setup/starter', body],
    missionFiles: body => !Object.keys(body).length && ['GET', '/setup/settings'],
    saveMissionFiles: body => settingsChange(body) && ['POST', '/setup/settings', body],
    setLock: body => ['POST', '/agent-lock', body],
    stopAll: body => !Object.keys(body).length && ['POST', '/stop-all', body],
    // Settings > Delegation: {} reads it, anything else saves it (the daemon checks the shape).
    delegation: body => !Object.keys(body).length ? ['GET', '/delegation'] : ['POST', '/delegation', body],
    // Settings > New chats start in (O133): {} reads them, anything else saves them (the daemon checks the shape).
    newChatDefaults: body => !Object.keys(body).length ? ['GET', '/start-defaults'] : ['POST', '/start-defaults', body],
    // Settings > Notices (O197): {} reads them, anything else saves them (the daemon checks the shape).
    notices: body => !Object.keys(body).length ? ['GET', '/notices'] : ['POST', '/notices', body],
  };
  const SPRINT_START_MS = 10 * 60_000; // ponytail: room for the lead's minute and about 20 workers' starts, not measured
  ipcMain.handle('p9:chat', async (event, ...args) => {
    const [action, payload = {}] = args;
    if (!spikeShell(event)
        || args.length > 2 || !Object.hasOwn(chatRoutes, action) || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('ipc-sender-refused');
    const { op, ...rest } = payload;
    const route = (op === undefined || uuid(op)) && chatRoutes[action](rest);
    if (!route) return { status: 400, body: { error: 'request-refused' } };
    // host: which P9 did not answer, so the page can say so in words (chatFailed in helpers.mjs).
    const where = serverHost ? { host: serverHost } : {};
    if (!state) return { status: 503, body: { error: 'daemon-unavailable', ...where } };
    // window-10: Start sprint waits for the lead's agent (up to a minute) and then each chat under it, staggered. The daemon
    // goes on if this gives up first (its route takes no signal); a press meanwhile is refused as sprint-starting.
    try { return await daemonRequest(state, route[0], route[1], route[2], op, action === 'prompt' ? AGENT_START_MS : ['startSprint', 'runSprintScript'].includes(action) ? SPRINT_START_MS : undefined); }
    catch (error) { const reply = failedReply(error); return { ...reply, body: { ...reply.body, ...where } }; }
  });
  // Terminal dock (a real shell in the dock; threat model row 13): one of P9's own tmux sessions, the same
  // routes and socket the phone uses, over the daemon's desktop socket with the desktop's credentials, which the page never
  // holds. One socket at a time; frames pass through as they are (the page stamps keys with the daemon's leases, like the
  // phone) and the daemon checks every one. Each socket has a serial, so the page can tell a new socket's frames from an old one's.
  const fromApp = event => spikeShell(event);
  // Test-only: the UI tests' sample data (test/sample-data.mjs), never in a packaged build (GitHub issue #4). JSON drops its helpers.
  const sample = !app.isPackaged && process.env.P9_SAMPLE_DATA === '1'
    ? JSON.parse(JSON.stringify((await import(new URL('../../test/sample-data.mjs', import.meta.url).href)).M)) : null;
  // Review 12 (CAT-2): this computer's agent catalog (GET /agents' answer) for the preload, so the window has every agent's modes
  // before the daemon answers. Over IPC, not an argument: the catalog grows, and an argument has a length limit.
  // Review 13: local says whether the daemon in use is this computer's own (the window reloads on every switch, so it holds
  // for the window's life); on a remote the catalog only fills the pickers until the remote's GET /agents answers (security.mjs).
  ipcMain.on('p9:agents', event => { event.returnValue = event.sender === window.webContents ? { agents: publicAgents().agents, local: !serverHost } : { agents: [], local: false }; });
  ipcMain.on('p9:sample', event => { event.returnValue = event.sender === window.webContents ? sample : null; }); // asked while the preload runs, before the frame has its URL
  const terminalRoutes = { list: () => ['GET', '/terminals'], create: () => ['POST', '/terminals', {}], stop: ({ id: shell }) => uuid(shell) && ['POST', '/terminals/' + shell + '/stop', {}],
    // Settings > General: {} reads the welcome message setting, { show } changes it.
    greeting: body => !Object.keys(body).length ? ['GET', '/terminal-greeting'] : Object.keys(body).join() === 'show' && typeof body.show === 'boolean' && ['POST', '/terminal-greeting', { show: body.show }] };
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
    if (!args.length) return { host: serverHost, last: serverLast, connected: !!server, slim: !!server?.slim, error: server ? null : serverError, hosts: await sshHosts(), remotes, keep: keeper.keep, noKey, openOn };
    const mine = ++intent;
    endDock();
    // O8: a Connect right after Disconnect waits for that stop, then starts P9 again, unless a newer ask came meanwhile.
    if (stopping.has(args[0])) { await stopping.get(args[0]); if (mine !== intent) return { ok: true, superseded: true }; }
    await useServer(args[0]);
    // Dev Focus follows: the next show asks the new daemon (its own editor, or the server's). Open Folder's choice was this computer's.
    devFolder = null; devServing = null;
    if (devView) reopenDev();
    setTimeout(() => { if (!window.isDestroyed()) window.webContents.reload(); });
    return { ok: true };
  });
  // O8: Disconnect turns P9 off on the remote it leaves (stopServer); Switch (p9:server with another host) leaves it running.
  // This computer first, then the stop: stopped while still in use, the dropped tunnel would reconnect, find no P9 there
  // and start it again (setUp, U6). The window reloads with the switch, so a failed stop is said in a dialog.
  ipcMain.handle('p9:server-off', async (event, ...args) => {
    if (!fromApp(event) || args.length) throw new Error('ipc-sender-refused');
    const host = serverHost;
    if (!host) return { ok: false };
    ++intent;
    endDock();
    await useServer(null);
    devFolder = null; devServing = null;
    if (devView) reopenDev();
    setTimeout(() => { if (!window.isDestroyed()) window.webContents.reload(); });
    for (let busy; busy !== remoteBusy.get(host);) await (busy = remoteBusy.get(host)); // a full-there install hands on to a second one
    // Connected to it again meanwhile: that newer Connect wins, and P9 there stays on.
    if (serverHost === host) return { ok: true, stopped: 'kept' };
    const stop = stopServer(host, sshCommand), done = stop.then(() => {});
    stopping.set(host, done);
    const stopped = await stop;
    if (stopping.get(host) === done) stopping.delete(host);

    if (stopped === 'failed' && !window.isDestroyed()) {
      dialog.showMessageBox(window, { type: 'warning', title: 'P9 is still on ' + host, message: 'P9 could not turn itself off on ' + host + '.',
        detail: 'This window is back on this computer. P9 on ' + host + ' keeps running: connect to it and press Disconnect again, or stop it there.' }).catch(() => {});
    }
    return { ok: true, stopped };
  });
  // D15a, since U6 run by setUp below (pressing Connect is the yes). Only this window's remote, only while it
  // answered without P9, one at a time. An unpackaged app sends its own source (sourceArchive); a packaged app has the remote
  // download its version. started: when it began, for the window's elapsed time; a throw ends it failed, never stuck running.
  // admin: row I2's password, after the install stopped at an admin step; passed to installRemote once, kept nowhere.
  // U8: the folder the slim archive is made from. A packaged app has it (resources/daemon, bundleDaemon's out, with agents.json);
  // an unpackaged one builds it from this checkout (bundle-daemon.mjs slimBundle; rolldown is a dev dependency) and removes
  // it after. null: neither, so the full install runs, as before U8.
  const slimFolder = async () => {
    const packaged = path.join(process.resourcesPath ?? '', 'daemon');
    if (app.isPackaged || process.env.P9_PACKAGED === '1') return await stat(path.join(packaged, 'agents.json')).then(() => ({ folder: packaged }), () => null);
    try {
      const { slimBundle } = await import('../../scripts/bundle-daemon.mjs');
      return { folder: await slimBundle(fileURLToPath(new URL('../../', import.meta.url)), app.getPath('temp')), built: true };
    } catch { return null; }
  };
  // U8: a remote that is not Always on gets the slim Temporary P9 (slimFolder), never ~/p9; Always on (keep), or full (that
  // remote has the full P9 already, or Keep asked for it), gets row 67's full install as before.
  runInstall = (admin = null, { full = false, keep = keeper.keep[serverHost] === true } = {}) => {
    const host = serverHost, started = Date.now(), asked = remoteInstall;
    remoteInstall = { phase: 'running', line: '', started };
    // A wrong password keeps what the window showed: the same list and command, asked again.
    const tell = e => { if (serverHost === host) remoteInstall = { ...(/^(wrong-password|not-allowed)$/.test(e.error ?? '') && { need: asked?.need, command: asked?.command }), ...e, started }; };
    const job = (async () => {
      const slim = full || keep ? null : await slimFolder();
      try {
        const e = slim ? await installRemote({ host, ssh: sshCommand, version: ownVersion, archive: slimArchive(slim.folder), slim: true, admin, tell })
          : await installRemote({ host, ssh: sshCommand, version: ownVersion, keep, admin, tell,
            archive: !app.isPackaged && process.env.P9_PACKAGED !== '1' ? sourceArchive(fileURLToPath(new URL('../../', import.meta.url))) : null });
        if (e.phase === 'full-there' && serverHost === host) return void runInstall(admin, { full: true, keep });
        // 30 s for the new P9 to answer, as a start gets; then Try again, never "Connecting…" forever.
        if (e.phase === 'done' && serverHost === host) { remoteInstall = { ...remoteInstall, until: Date.now() + 30000 }; await useServer(host); }
      } finally {
        if (slim?.built) await rm(slim.folder, { recursive: true, force: true }).catch(() => {});
      }
    })().catch(error => { remoteInstall = { phase: 'failed', error: error.message, started }; });
    busyWith(host, job);
    return { ok: true };
  };
  // U6 (threat model row 50 U6): pressing Connect is the yes. A remote that answers without a running P9 gets it started
  // (startServer); if that finds nothing to start, or P9 still does not answer 30 s after it said started, it is installed
  // or updated (runInstall, row 67's script). Once per Connect or Try again: a failed or stopped one stays in remoteInstall,
  // shown with Try again, until useServer clears it.
  // answers: P9 there has its runtime files but did not answer (server-not-answering): it is started again, never installed over.
  setUp = (host, answers = false) => {
    if (!remoteInstall) {
      const started = Date.now();
      remoteInstall = { phase: 'starting', started };
      busyWith(host, startServer(host, sshCommand).then(r => {
        if (serverHost !== host || remoteInstall?.started !== started) return;
        if (r !== 'ok') return void (answers ? (remoteInstall = { phase: 'failed', error: 'not-answering', started }) : runInstall());
        remoteInstall = { phase: 'starting', started, until: Date.now() + 30000 };
        return useServer(host);
      }).catch(error => { remoteInstall = { phase: 'failed', error: error.message, started }; }));
    } else if (!answers && remoteInstall?.phase === 'starting' && remoteInstall.until < Date.now()) runInstall();
  };
  // Row I2: the admin password typed into the window, for the one admin step this remote is waiting on: the install's
  // (what it showed: P9_ADMIN need and command) or Keep it running's linger. One string, one line; never stored or logged.
  ipcMain.handle('p9:remote-admin', async (event, ...args) => {
    if (!fromApp(event) || args.length !== 1 || !PASSWORD(args[0])) throw new Error('ipc-sender-refused');
    if (serverHost && serverError === 'server-no-p9' && remoteInstall?.phase === 'admin' && remoteInstall.command) return runInstall(args[0]);
    if (serverHost && server && /^(refused|wrong-password)$/.test(keeper.status(serverHost, !!server.background).keeping?.phase ?? '') && keeper.admin(serverHost, !!server.background, args[0])) return { ok: true };
    return { error: 'remote-admin-refused' };
  });
  // Row 78: the password window's answer for the ssh login waiting on it: a password, or null (Cancel).
  // Handed to the login once and kept nowhere.
  ipcMain.handle('p9:ssh-answer', async (event, ...args) => {
    if (!fromApp(event) || args.length !== 1 || (args[0] !== null && !PASSWORD(args[0]))) throw new Error('ipc-sender-refused');
    if (!sshAsk) return { error: 'nothing-asked' };
    const { resolve } = sshAsk;
    sshAsk = null;
    resolve(args[0]);
    return { ok: true };
  });
  // Row 79: the answer to the key offer for this window's remote, only while main's own password login left one open. yes makes
  // P9's key (if it has none) and adds it there; never: Don't ask again for that remote. Nothing is made or sent without yes.
  ipcMain.handle('p9:ssh-key', async (event, ...args) => {
    const [yes, never] = args;
    if (!fromApp(event) || args.length !== 2 || typeof yes !== 'boolean' || typeof never !== 'boolean') throw new Error('ipc-sender-refused');
    if (!keyOffer || keyOffer.host !== serverHost) return { error: 'nothing-offered' };
    const { host } = keyOffer;
    keyOffer = null;
    if (never) { noKey = [...new Set([...noKey, host])].slice(-50); await keepServer(); }
    if (!yes) return { ok: true };
    if (!await makeKey(sshKeyFile, sshCommand)) return { error: 'key-not-made' };
    const r = await installKey({ host, ssh: sshCommand, file: sshKeyFile });
    return r === 'ok' ? { ok: true } : { error: 'key-' + r };
  });
  // Settings > Remote's Offer a P9 key again: the remote's Don't ask again is gone.
  ipcMain.handle('p9:ssh-key-setting', async (event, ...args) => {
    if (!fromApp(event) || args.length !== 1 || typeof args[0] !== 'string' || !HOST.test(args[0])) throw new Error('ipc-sender-refused');
    noKey = noKey.filter(h => h !== args[0]);
    await keepServer();
    return { noKey };
  });
  // Row 61 on a remote: tmux or ssh missing on this window's remote. The check asks the remote for its own command (the
  // admin window shows it); the password then runs that remote's command, computed there again. One check, one password.
  let depsChecked = null;
  ipcMain.handle('p9:remote-deps-check', async (event, ...args) => {
    if (!fromApp(event) || args.length) throw new Error('ipc-sender-refused');
    if (!serverHost || !server) return { error: 'not-connected' };
    const host = serverHost, r = await remoteDeps(host, sshCommand);
    depsChecked = r.phase === 'admin' && serverHost === host ? host : null;
    return depsChecked ? { command: r.command } : { error: r.phase === 'none' ? 'nothing-to-install' : 'remote-deps-failed' };
  });
  ipcMain.handle('p9:remote-deps', async (event, ...args) => {
    if (!fromApp(event) || args.length !== 1 || !PASSWORD(args[0])) throw new Error('ipc-sender-refused');
    if (!serverHost || !server || depsChecked !== serverHost) return { error: 'remote-deps-refused' };
    depsChecked = null;
    const { phase } = await remoteDeps(serverHost, sshCommand, args[0]);
    return phase === 'ok' ? { ok: true } : { error: phase === 'wrong-password' ? phase : phase === 'not-allowed' ? 'remote-not-allowed' : 'admin-failed' };
  });
  // Row 61 (commit C): the wizard's Install for tmux or ssh on this computer, with the admin password typed there. The page
  // names the package only; the command is deps.mjs's own for a package missing now. Not in remote mode: that list is the remote's.
  ipcMain.handle('p9:admin-install', async (event, ...args) => {
    if (!fromApp(event) || !adminArgs(args)) throw new Error('ipc-sender-refused');
    if (serverHost) return { error: 'admin-remote' };
    const command = await adminCommand(args[0]);
    return command ? adminLocal(command, args[1]) : { error: 'nothing-to-install' };
  });
  // The machine menu's live state (threat model row 50, c23 adds): only a remote saved here or used last, one probe per host
  // per 30 s, shared by calls in flight. ponytail: the cache is never pruned; at most 51 hosts can be in it.
  const probes = new Map();
  ipcMain.handle('p9:remote-state', async (event, ...args) => {
    const [host] = args;
    if (!fromApp(event) || args.length !== 1 || typeof host !== 'string' || !HOST.test(host) || !(remotes.includes(host) || host === serverLast)) throw new Error('ipc-sender-refused');
    const hit = probes.get(host);
    if (hit && Date.now() - hit.at < 30000) return hit.state;
    const state = probeServer(host, sshCommand);
    probes.set(host, { at: Date.now(), state });
    return state;
  });
  // The agents for this window's remote (a list of claude and codex, maybe empty), stored and fetched now;
  // null asks again (the machine menu's AI agents). Picking fewer removes nothing already there.
  ipcMain.handle('p9:remote-agents', async (event, ...args) => {
    const [names] = args;
    if (!fromApp(event) || args.length !== 1 || !(names === null || pickable(names))) throw new Error('ipc-sender-refused');
    if (!serverHost || !server) return { error: 'not-connected' };
    if (names === null) { agentsAgain.add(serverHost); return { ok: true }; }
    agentsAgain.delete(serverHost); agentsFor[serverHost] = names;
    await keepServer().catch(() => {});
    fetchAgents(serverHost, names);
    return { ok: true };
  });
  // Row I1: the answer to Keep P9 running on this window's remote (yes: boolean), stored when remember is true, applied now.
  ipcMain.handle('p9:remote-keep', async (event, ...args) => {
    const [yes, remember] = args;
    if (!fromApp(event) || args.length !== 2 || typeof yes !== 'boolean' || typeof remember !== 'boolean') throw new Error('ipc-sender-refused');
    if (!serverHost || !server) return { error: 'not-connected' };
    await keeper.answer(serverHost, !!server.background, yes, remember);
    return { ok: true, keep: keeper.keep };
  });
  // Settings > Remote: the stored choice for one remote (true, false, or null: ask). This window's remote gets it now.
  ipcMain.handle('p9:remote-keep-setting', async (event, ...args) => {
    const [host, choice] = args;
    if (!fromApp(event) || args.length !== 2 || typeof host !== 'string' || !HOST.test(host) || ![true, false, null].includes(choice)) throw new Error('ipc-sender-refused');
    await keeper.set(host, host === serverHost && server ? !!server.background : null, choice);
    return { keep: keeper.keep };
  });
  // D3: Settings > Remote's Add remote and Remove. A name ssh would read as an option never gets in (HOST, threat model row 50).
  ipcMain.handle('p9:remotes', async (event, ...args) => {
    const [action, host] = args;
    // 0.1.8: 'open-on' keeps Settings > Open P9 on: null (where it was last), '' (this computer) or a host.
    const okHost = typeof host === 'string' && HOST.test(host), ok = action === 'open-on' ? host === null || host === '' || okHost : ['add', 'remove'].includes(action) && okHost;
    if (!fromApp(event) || args.length !== 2 || !ok) throw new Error('ipc-sender-refused');
    // The answer is what the file holds after this save, not the newest choice still in the queue. A save that fails
    // gives its choice up (unless a newer choice was made since, even the same value), so no later save writes it unasked.
    if (action === 'open-on') { const turn = ++openOnTurn; openOn = host; try { await keepServer(); } catch (error) { if (turn === openOnTurn) openOn = openOnKept; throw error; } return { remotes, openOn: openOnKept }; }
    remotes = action === 'add' ? [...new Set([...remotes, host])].slice(-50) : remotes.filter(h => h !== host); // ponytail: 50 kept, the oldest go
    if (action === 'remove') noKey = noKey.filter(h => h !== host); // row 79: a removed remote's Don't ask again goes with it
    await keepServer();
    return { remotes };
  });
  sendIpc(outer);
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
  let cardsView = null, cardsItems = [], cardsHide = null;
  let devToken = null, devFailed = false, devGen = 0, devOpening = new Set(), dev = null, devView = null, editorHost = null, look = null, devReady = false, queued = [], devFolder = null, devServing = null;
  // The editor page's build (about 18 MB; review item 22), kept while its index.html keeps the same mtime: every Dev Focus open
  // and reopen used to read it all again. Any build (Rebuild or a hand-run pnpm build:dev, which empties and rewrites dist)
  // writes a new index.html, so the next open reads the new build. A failed stat or read is tried again on the next open.
  const devDist = fileURLToPath(new URL('../dev/dist/', import.meta.url));
  let devBuild = null, devBuilt = null;
  const devAssets = async () => {
    const built = await stat(path.join(devDist, 'index.html')).then(info => info.mtimeMs, () => null);
    if (built === null || built !== devBuilt) { devBuild = null; devBuilt = built; }
    return devBuild ??= assets(devDist).catch(error => { devBuild = null; throw error; });
  };
  // SPIKE o294: the shell's page in a workbench tab (p9://chat/ inside the dev view) counts as the shell.
  function spikeShell(event) { return (event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === APP_URL)
    || (!!devView && event.sender === devView.webContents && !!event.senderFrame?.url.startsWith('p9://chat/')); }
  const fromDev = event => devView && event.sender === devView.webContents && event.senderFrame === devView.webContents.mainFrame && isDevPage(event.senderFrame.url);
  // The quit handler exists before the host does, so a quit during startup still stops it. Synchronous: Electron does not
  // wait for promises on quit, and the host must not outlive the app. One handler for the current start (review item 24:
  // one per start piled up); a failed start aborts its own process at once.
  // Quit before systemd has made the scope: the stop finds nothing, so the abort kills the server process too.
  let hostQuit = null;
  app.once('will-quit', () => hostQuit?.());
  const startHost = () => editorHost ??= (async () => {
    const quit = new AbortController();
    let unit = null;
    hostQuit = () => { if (unit) stopEditorHost(unit); quit.abort(); };
    // An install in progress (the AppImage's first start) finishes first, so Dev Focus opens instead of saying missing.
    await editorInstall?.catch(() => {});
    // O258: on a port that stays the same (stablePort, kept under '' in devPorts), as the remote editor's relay below. One taken
    // between the pick and the host's own listen (a second P9 starting its editor at the same time) is passed over by the next pick.
    for (let tries = 1; ; tries++) {
      unit = 'p9-editor-host-' + randomBytes(4).toString('hex');
      const port = await stablePort('', ...portsOf(''));
      const started = await startEditorHost({ unit, signal: quit.signal, port }).catch(error => error);
      if (started instanceof Error && started.message === 'editor-host-port-taken' && tries < 3 && !quit.signal.aborted) continue;
      if (started instanceof Error) { quit.abort(); throw started; }
      keepPort('', started.port);
      return started;
    }
  })().catch(error => { editorHost = null; throw error; });
  // Server mode (threat model row 50): the server's daemon runs the editor (POST /dev/editor) and the tunnel forwards its socket to
  // editor.sock in the state folder. A relay on 127.0.0.1 here carries the page's http and ws to it, so the page, its CSP and the
  // token check are the same as with a local editor host, which listens on 127.0.0.1 too. One relay, for the current server.
  let relay = null;
  // O250: the editor keeps its open files and file tree under its address, 127.0.0.1:<port>, so each remote keeps the port
  // it got first (devPorts, in p9-server.json), and no two remotes (nor this computer's editor) get the same one (stablePort).
  // A kept port in use by something else at a start is given up for a new one (that start opens the editor empty) and stays
  // kept for good, so no other remote opens onto its place.
  // ponytail: no port is ever freed; the list grows only when a kept port is busy at a start (a few bytes each).
  const listenRelay = async (socket, host, old) => {
    old?.ready.then(l => l.close(), () => {});
    await old?.ready.catch(() => {});
    const listener = net.createServer(client => {
      const far = net.connect(socket);
      client.pipe(far).pipe(client);
      far.on('error', () => client.destroy());
      client.on('error', () => far.destroy());
    });
    const port = await stablePort(host, ...portsOf(host), listener);
    // Switched to another machine while this bound: the port is not this remote's to keep (serverEditor drops the open).
    if (serverHost !== host) { listener.close(); throw Object.assign(new Error('daemon-unavailable'), { server: host }); }
    keepPort(host, port);
    return listener;
  };
  // The remote as the open began: an answer landing after a switch is that remote's, so it binds nothing and opens nothing.
  const serverEditor = async () => {
    const host = serverHost, at = state, moved = () => Object.assign(new Error('daemon-unavailable'), { server: host });
    const asked = await daemonRequest(at, 'POST', '/dev/editor', {}, undefined, 60000).catch(error => error);
    if (serverHost !== host) throw moved();
    if (asked instanceof Error || asked.status === 404) throw new Error(asked.message === 'bad-response' || asked.status === 404 ? 'server-old' : 'daemon-unavailable');
    const { body } = asked;
    if (asked.status !== 200) throw Object.assign(new Error(String(body?.message ?? body?.error)), { problem: body?.error, download: body?.download === true, place: String(body?.place ?? ''), server: host });
    const socket = forwardPath(at, 'editor');
    // Set before any wait: an open that overlaps this one shares its listener instead of binding a second one.
    if (relay?.socket !== socket) relay = { socket, ready: listenRelay(socket, host, relay) };
    const mine = relay, port = await mine.ready.then(l => l.address().port, error => { if (relay === mine) relay = null; throw error; });
    if (serverHost !== host) throw moved();
    return { port, token: body.token, commit: body.commit, data: body.data, server: host };
  };
  const openDev = () => dev ??= trackOpen((async () => {
    // FIX2: a newer open (reopenDev) owns the page from here; an older one still running when it ends writes nothing.
    const mine = ++devGen, next = {};
    const devSession = session.fromPartition('persist:p9-dev');
    if (!devSession.protocol.isProtocolHandled('p9')) devSession.protocol.handle('p9', serve('dev', 'webview', 'chat'));
    // An extension page's files are asked for at https://*.vscode-cdn.net and answered by VS Code's service worker from the
    // editor host; a request that gets past it never leaves the machine.
    devSession.webRequest.onBeforeRequest({ urls: ['*://*.vscode-cdn.net/*'] }, (_details, callback) => callback({ cancel: true }));
    devReady = false; devToken = null;
    if (devView) { window.contentView.removeChildView(devView); devView.webContents.close(); }
    devSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'clipboard-sanitized-write'));
    devSession.setPermissionCheckHandler((_contents, permission) => permission === 'clipboard-sanitized-write');
    devView = new WebContentsView({ webPreferences: { preload: fileURLToPath(new URL('./dev-preload.cjs', import.meta.url)), session: devSession, sandbox: true,
      contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false } });
    devView.setBackgroundColor('#05070e');
    devView.webContents.on('dom-ready', () => devView?.webContents.setZoomFactor(settings.zoom));
    devView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    devView.webContents.on('will-navigate', (event, url) => { if (!isDevPage(url)) event.preventDefault(); });
    // Subframes (the workbench's webviews) stay on p9://dev/ and p9://webview/; the CSP's frame-src says the same.
    devView.webContents.on('will-frame-navigate', event => { if (!event.isMainFrame && !event.url.startsWith(DEV_URL) && !event.url.startsWith(WEBVIEW_URL) && !event.url.startsWith('p9://chat/') && !/^about:(blank|srcdoc)$/.test(event.url)) event.preventDefault(); });
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
    if (cardsView) window.contentView.addChildView(cardsView); // the cards stay above the editor
    let config;
    try {
      if (!state) throw new Error('daemon-unavailable');
      // Just after a switch to a server the tunnel is still coming up: wait for it as long as connectServer does (15 s).
      for (let i = 0; i < 60 && serverHost && !server && !serverError; i++) await new Promise(resolve => setTimeout(resolve, 250));
      const unanswered = () => { throw Object.assign(new Error('daemon-unavailable'), { server: serverHost ?? undefined }); };
      const [devFiles, status] = await Promise.all([devAssets(), (server ? server.check(60000) : health(state)).catch(unanswered)]); // O248: a busy link answers late; 60 s, as /dev/editor below
      const host = serverHost ? await serverEditor() : await startHost();
      const origin = 'http://127.0.0.1:' + host.port;
      // Extension pages (webviews: a README, an image preview) get their own origin, p9://webview, so their scripts can't reach
      // window.p9dev (threat model row 5; images were blocked). VS Code injects an inline script into each
      // page, so inline scripts run there; the page's own CSP narrows that, and index-*.html carries its own hash-only CSP.
      const isWebview = name => /^\/assets\/(index-[^/]+\.html|fake-[^/]+\.html|service-worker-[^/]+\.js)$/.test(name);
      next.webview = { files: new Map([...devFiles].filter(([name]) => isWebview(name))), csp: "default-src 'none'; script-src 'self' 'unsafe-inline' https://*.vscode-cdn.net; "
        + "style-src 'self' 'unsafe-inline' https://*.vscode-cdn.net; img-src 'self' data: blob: https:; font-src 'self' data: https://*.vscode-cdn.net; "
        + "media-src 'self' blob: https://*.vscode-cdn.net; connect-src 'self' https://*.vscode-cdn.net; worker-src 'self'; frame-src 'self' p9://chat; "
        + "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors p9://dev p9://webview" };
      const devScripts = [...devFiles].filter(([name]) => name.endsWith('.html') && !isWebview(name)).flatMap(([, data]) => inlineHashes(data.toString('utf8')));
      next.dev = { files: devFiles, csp: `default-src 'none'; script-src 'self' 'wasm-unsafe-eval' ${devScripts.join(' ')}; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; `
        // Images from any https host: extension icons (Open VSX) and README images (badges, raw.githubusercontent.com)
        // (threat model row 5; A/B: with Open VSX only, all 5 of the YAML README's images stay blank). Gallery search, installs
        // and README text come through the editor host, so connect-src stays local.
        + `img-src 'self' data: blob: ${origin} https:; font-src 'self' data: blob: ${origin}; media-src 'self' blob:; connect-src 'self' ws://127.0.0.1:${host.port} ${origin}; `
        + "frame-src 'self' p9://webview p9://chat; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'" };
      // workspace is the guard root (the folder saves are relative to); folder is the one the editor shows.
      if (devFolder?.outside && (await daemonRequest(state, 'POST', '/dev/root', { path: devFolder.path }).catch(() => null))?.status !== 200) devFolder = null;
      next.serving = devFolder;
      config = { port: host.port, token: host.token, commit: host.commit, server: host.server, workspace: devFolder?.outside ? devFolder.path : status.workspace, folder: devFolder && (devFolder.outside ? devFolder.path : status.workspace + devFolder.tail), data: host.data };
    } catch (error) {
      if (serverHost && error.server === undefined) error.server = serverHost;
      next.dev = devErrorPage(error, editorCopy ?? editorDownload());
      config = { error: error.message };
    }
    if (mine !== devGen) return config;
    if ('serving' in next) { devServing = next.serving; delete next.serving; }
    Object.assign(sites, next);
    // A newer open closes this page's view; that load's rejection is not this open's to report.
    await devView.webContents.loadURL(DEV_URL).catch(error => { if (mine === devGen) throw error; });
    if (mine !== devGen) return config;
    devFailed = !!config.error;
    devToken = config.error ? null : config.token;
    if (config.error) dev = null;
    return config;
  })()).catch(error => { dev = null; throw error; });
  // Every open still running, older ones included (reopenDev starts a new one without waiting): devAgain waits for them.
  function trackOpen(open) { devOpening.add(open); open.finally(() => devOpening.delete(open)).catch(() => {}); return open; }
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
  // Server mode: the server's daemon may have restarted (an update, a reboot, an idle stop) and ended its editor, leaving the
  // page on a dead editor ("Canceled", or VS Code's own reconnect giving up). Asks the daemon again; it hands back the same
  // editor while that runs, and a new token reloads the page. Unsaved edits come back from the page's hot-exit backups.
  // Run when Dev Focus is shown again, and (O19) when the tunnel is up again after a drop, so an editor left open comes back by itself.
  // failed: a page that could not open (the drop came first) opens again; showing Dev Focus already does that itself.
  const devAgain = (failed = false) => {
    if (!devView || !serverHost) return;
    // An open still running may have failed before this connection was up (FIX1): once every open running now has ended,
    // look again, if this connection is still the one. Each ended open leaves devOpening, so this waits on real work only.
    if (failed && devOpening.size) { const s = server; return Promise.allSettled([...devOpening]).then(() => { if (server === s) devAgain(true); }); }
    if (failed && devFailed) return reopenDev();
    if (!devToken) return;
    const had = devToken;
    // check() first: a restarted daemon has new credentials, and check() reads them (remote.mjs).
    Promise.resolve(server?.check()).then(serverEditor).then(host => { if (devToken === had && host.token !== had) reopenDev(); }).catch(() => {});
  };
  // A workspace change shows the new workspace, whatever folder was open.
  const devToWorkspace = () => { devFolder = null; reopenDev(); };
  // D5 (threat model row 52): Install on Dev Focus's error page. No arguments: main installs only the pinned download, one
  // install at a time, never over an editor server that is running; then Dev Focus opens again.
  const INSTALL_ERRORS = {
    'editor-download-unavailable': 'P9 has no download of the editor server for this computer.',
    'editor-download-failed': 'The download did not finish. Check the internet connection, then press Install again.',
    'editor-download-too-big': 'The download was far larger than the editor server is, so it was stopped. Nothing was installed.',
    'editor-download-mismatch': 'The download did not match the SHA-256 P9 pins, so nothing was installed. Press Install to try again.',
    'editor-unpack-failed': 'The download could not be unpacked (tar failed). Nothing was installed.',
    'editor-host-commit-mismatch': 'The download held a different release than P9 runs. Nothing was installed.',
  };
  ipcMain.handle('p9dev:install-editor', async (event, ...args) => {
    if (!fromDev(event) || args.length) throw new Error('ipc-sender-refused');
    if (serverHost) {
      // On the server, by its daemon (POST /dev/editor/install): the same pinned download, checked there.
      const done = await daemonRequest(state, 'POST', '/dev/editor/install', {}, undefined, 660000).catch(() => null);
      if (!done) return { error: 'The remote did not answer. Check the connection in Settings > Remote Connect, then press Install again.' };
      if (done.status === 409) return { error: 'The editor server is already running on the remote.' };
      if (done.status !== 200) return { error: INSTALL_ERRORS[done.body?.error] ?? 'The install on the remote failed (' + String(done.body?.error).slice(0, 200) + ').' };
      setTimeout(reopenDev);
      return { ok: true };
    }
    if (await editorHost?.catch(() => null)) return { error: 'The editor server is already running.' };
    try { await installEditor(); }
    catch (error) { return { error: INSTALL_ERRORS[error.message] ?? 'The install failed (' + String(error.message).slice(0, 200) + ').' }; }
    setTimeout(reopenDev);
    return { ok: true };
  });
  // Unrestricted mode (v0.1.6 U2/U4): dev-folder.mjs. Any failure reads as off, and off drops this place's "Don't ask again".
  const looseNow = () => unrestricted(p => daemonRequest(state, 'GET', p), () => trust(false));
  // "Don't ask again" on Trust this folder? (U2, review 2 L4): per place (this computer or the server's host), honoured only
  // while Unrestricted mode is on, and dropped by the first check that finds the mode off there (dev-folder.mjs).
  // ponytail: no Settings switch to clear it; turning the mode off and opening a folder, or deleting p9-trust.json, does.
  const trustFile = path.join(app.getPath('userData'), 'p9-trust.json'), trustPlace = () => serverHost ?? 'local';
  const trustText = () => readFile(trustFile, 'utf8').catch(() => '');
  const trustAll = async () => trusted(await trustText(), trustPlace());
  const trust = async on => { const next = setTrust(await trustText(), trustPlace(), on); if (next) await writeFile(trustFile, next, { mode: 0o600 }).catch(() => {}); };
  // Dev Focus's Open Folder (threat model rows 41/50): dev-folder.mjs's openFolder; the editor page opens again after the reply,
  // so the reply is not sent to the page being replaced.
  ipcMain.handle('p9dev:open-folder', async (event, ...args) => {
    if (!fromDev(event) || args.length > 1 || (args.length && (!serverHost || typeof args[0] !== 'string'))) throw new Error('ipc-sender-refused');
    return openFolder({
      get server() { return serverHost; }, health: async () => state && health(state), request: (...a) => daemonRequest(state, ...a), failedReply, realpath,
      pick: options => dialog.showOpenDialog(window, options), ask: options => dialog.showMessageBox(window, options),
      get folder() { return devFolder; }, setFolder: next => { devFolder = next; }, loose: looseNow, trustAll, trust,
      platform: process.platform, sep: path.sep, reopen: () => setTimeout(reopenDev),
    }, args);
  });
  ipcMain.handle('p9:dev-view', async (event, ...args) => {
    const [b] = args, whole = value => Number.isSafeInteger(value) && value >= 0 && value <= 100000;
    if (!spikeShell(event)
        || args.length !== 1 || !b || typeof b.visible !== 'boolean' || (b.visible && !['x', 'y', 'width', 'height'].every(key => whole(b[key])))) throw new Error('ipc-sender-refused');
    if (!b.visible) { devView?.setVisible(false); return { ok: true }; }
    const shown = devView?.getVisible();
    // D11 (the editor side flashed white while sliding, only when not connected): a failed start
    // left dev unset, so each placement (every frame of a drag) built a new view. Shown and failed, a placement only moves it; coming
    // back to Dev Focus tries again, as the page says.
    if (!(shown && devFailed)) openDev().catch(error => console.error('p9: Dev Focus failed to open:', error.message));
    // Server mode: coming back asks the server's daemon again, for an editor that ended while the tunnel stayed up (devAgain).
    if (!shown) devAgain();
    // The shell measures in its own (zoomed) CSS pixels; the view is placed in window pixels.
    const z = window.webContents.getZoomFactor(), px = value => Math.round(value * z);
    devView.setBounds({ x: px(b.x), y: px(b.y), width: px(b.width), height: px(b.height) });
    devView.setVisible(true);
    if (!shown) devView.webContents.focus();
    return { ok: true };
  });
  // The view draws above the page, so a top-bar menu opened over it
  // would be under it. The shell asks for a still of the editor, shows it in the view's place, then hides the view while the menu
  // is open. Only the shell may ask; the still goes only to it.
  ipcMain.handle('p9:dev-still', async (event, ...args) => {
    if (!spikeShell(event) || args.length) throw new Error('ipc-sender-refused');
    if (!devView?.getVisible()) return null;
    const image = await devView.webContents.capturePage().catch(() => null);
    if (!image || image.isEmpty()) return null;
    // Review item 26: at the view's own size (half the width on a 2x screen, where it is drawn at that size anyway), quality 80.
    const { width, height } = devView.getBounds(), size = image.getSize();
    return 'data:image/jpeg;base64,' + (size.width > width ? image.resize({ width, height, quality: 'good' }) : image).toJPEG(80).toString('base64');
  });
  cardsIpc(outer);
  // Settings: no argument reads them; one argument is the whole new shape, refused unless checkSettings takes it.
  ipcMain.handle('p9:settings', async (event, ...args) => {
    if (!spikeShell(event)
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
  petsIpc(outer);
  // New chat folder (threat model row 24): the system dialog returns an inside folder relative to the workspace,
  // or an outside folder only in Unrestricted mode. The daemon checks it again when the chat is made.
  // Setup's Pick buttons name a file ('setup-file') or folder ('setup-folder') the same way; the daemon checks the path again.
  const PICKS = { 'setup-file': ['Choose the file', 'Use this file', 'openFile'], 'setup-folder': ['Choose the folder', 'Use this folder', 'openDirectory'] };
  ipcMain.handle('p9:pick-folder', async (event, ...args) => {
    if (!spikeShell(event)
        || args.length > 1 || (args.length && !Object.hasOwn(PICKS, args[0]))) throw new Error('ipc-sender-refused');
    if (!state) return null;
    // Server mode: this machine's dialog cannot browse the server. Setup's picks act as Cancel; a new chat's folder is
    // picked in the page from the server's own folder list (v0.1.6 U4), so main only says so.
    if (serverHost) return args.length ? undefined : { remote: true };
    const root = await realpath((await health(state)).workspace);
    const [title, buttonLabel, kind] = args.length ? PICKS[args[0]] : ['Start the chat in', 'Start here', 'openDirectory'];
    const pick = await dialog.showOpenDialog(window, { title, buttonLabel, properties: [kind], defaultPath: root });
    if (pick.canceled || !pick.filePaths[0]) return undefined;
    // Inside: relative to the workspace; outside: v0.1.6 U4, a new chat (no argument) only, in Unrestricted mode (dev-folder.mjs).
    return chatFolder(root, await realpath(pick.filePaths[0]).catch(() => null), path.sep, args.length > 0, looseNow);
  });
  // The Obsidian vault folder (threat model row 73): no argument, so the page never sends a path. The native folder dialog, then a
  // native confirm naming what it allows; only then main sends the folder to the daemon over its local socket. Server mode: this
  // machine's dialog cannot browse the remote.
  ipcMain.handle('p9:pick-vault', async (event, ...args) => {
    if (!fromApp(event) || args.length) throw new Error('ipc-sender-refused');
    if (serverHost) return { status: 409, body: { error: 'server-mode-local-only' } };
    if (!state) return { status: 503, body: { error: 'daemon-unavailable' } };
    const pick = await dialog.showOpenDialog(window, { title: 'Choose your Obsidian vault folder', buttonLabel: 'Use this folder', properties: ['openDirectory'] });
    if (pick.canceled || !pick.filePaths[0]) return { status: 200, body: { canceled: true } };
    const folder = pick.filePaths[0];
    const { response } = await dialog.showMessageBox(window, { type: 'question', title: 'Use this vault?', message: 'Use ' + folder + ' as your Obsidian vault?',
      detail: 'Mission lists the notes in it, a checklist can change review and mark lines in them, and obsidian: links can open Obsidian on this computer. P9 writes nothing else there.',
      buttons: ['Cancel', 'Use this folder'], defaultId: 0, cancelId: 0, noLink: true });
    if (response !== 1) return { status: 200, body: { canceled: true } };
    try { return await daemonRequest(state, 'POST', '/mission/vault', { folder }); } catch { return { status: 503, body: { error: 'daemon-unavailable' } }; }
  });
  // Setup's Change the folder (threat model row 32): no argument; the native picker, then a native confirm naming the folder. Main writes
  // no unit: it re-runs the installed copy's own uninstall-service.mjs and install-service.mjs with only the folder, with the unit's own
  // node and PATH so the new unit differs only in --workspace, and installs the old folder again when the new one does not come up.
  // Windows: the installed copy's own install-windows.ps1 -Workspace through repairWindowsTask, as the launch repair runs it; the
  // script stops the old daemon itself. P9's private folder there is %LOCALAPPDATA%\P9, the state folder's parent.
  ipcMain.handle('p9:workspace-change', async (event, ...args) => {
    if (!fromApp(event) || args.length) throw new Error('ipc-sender-refused');
    if (serverHost) return { error: 'server-mode-local-only' }; // this machine's service; the remote's folder is set where it is installed
    const old = state && (await health(state).catch(() => null))?.workspace;
    if (!old) return { error: 'daemon-unavailable' };
    const win = process.platform === 'win32';
    if (!win && process.platform !== 'linux') return { error: 'workspace-change-unsupported', workspace: old };
    // The steps below rewrite the p9-foundation unit; a window on the dev daemon (p9-dev) must not touch the daily one.
    if (!win && unitFor(state) !== 'p9-foundation.service') return { error: 'workspace-change-unsupported', workspace: old };
    // O6b: on Windows a dev window changes its own task's folder ('P9 p9-dev'), and only once that task exists.
    const task = win ? unitOf(state) : 'p9-foundation';
    if (task !== 'p9-foundation' && !await windowsTask(task)) return { error: 'dev-task-missing', workspace: old };
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
        const ran = await repairWindowsTask(process.resourcesPath, folder, task);
        if (ran && await on(folder)) { devToWorkspace(); return { workspace: folder }; }
        await repairWindowsTask(process.resourcesPath, old, task);
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
    if (!await run('uninstall-service.mjs', '--keep-menu')) await run('uninstall-service.mjs', '--force', '--keep-menu');
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
    // O6b: a dev window restarts or repairs its own task ('P9 p9-dev'), never 'P9 Foundation', and only once that task exists.
    const unit = win && !serverHost ? unitOf(state) : 'p9-foundation';
    if (unit !== 'p9-foundation' && !await windowsTask(unit)) return { error: 'dev-task-missing' };
    const { response } = await dialog.showMessageBox(window, { type: 'warning', title: repair ? 'Repair P9?' : 'Restart P9?',
      message: repair ? 'Repair P9\'s background service?' : serverHost ? 'Restart P9 on ' + serverHost + '?' : 'Restart P9\'s background service?',
      detail: (repair ? 'P9 sets up its background service again and starts it. ' : '') + (serverHost ? 'Running chats, scripts and terminals on the remote stop, the ones open on your phone too.' : 'Running chats, scripts and terminals stop.'),
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
      return await repairWindowsTask(process.resourcesPath, undefined, unit) ? await answered(state, before) : { error: 'repair-failed', detail: 'install-windows.ps1 failed (service-install.log)' };
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
    if (!spikeShell(event)
        || args.length !== 1 || typeof args[0] !== 'string' || !PET_NAME.test(args[0])) throw new Error('ipc-sender-refused');
    const folder = path.join(petsFolder, args[0]), info = await lstat(folder).catch(() => null);
    if (!info?.isDirectory()) throw new Error('pet-refused'); // lstat: a link is never a directory here
    await rm(folder, { recursive: true });
    return { removed: args[0] };
  });
  ipcMain.handle('p9:open-docs', async (event, ...args) => {
    if (!spikeShell(event)
        || args.length > 1 || (args.length && !GUIDE_SECTIONS.includes(args[0]))) throw new Error('ipc-sender-refused');
    const url = args.length ? GUIDE_URL + args[0] : DOCS_URL;
    if (process.env.P9_OPEN_URL) spawn(process.env.P9_OPEN_URL, [url], { shell: false, stdio: 'ignore' }).on('error', () => {});
    else await shell.openExternal(url);
    return { opened: true };
  });
  // D13: the window asks once at load; the answer is given once, so a reload does not show it again.
  ipcMain.handle('p9:whats-new', (event, ...args) => {
    if (!fromApp(event) || args.length) throw new Error('ipc-sender-refused');
    const answer = whatsNew; whatsNew = null; return answer;
  });
  ipcMain.handle('p9:open-updates', async (event, ...args) => {
    if (!spikeShell(event)
        || args.length) throw new Error('ipc-sender-refused');
    if (process.env.P9_OPEN_URL) spawn(process.env.P9_OPEN_URL, [RELEASES_URL], { shell: false, stdio: 'ignore' }).on('error', () => {});
    else await shell.openExternal(RELEASES_URL);
    return { opened: true };
  });
  // Auto-update (threat model row 39): off unless this is an installed build with a feed (updater.mjs); its lines go to
  // p9-update.log. skip: the version a rollback came back from (row 40).
  // channel: the Nightly switch (O2), its own file beside update-state.json; anything but { nightly: true } is Stable.
  // O24b: update-pending.json (0.1.9's "install at the next open" mark) is left over from an earlier version; nothing
  // reads it now, and it must never install anything, so it goes at each start.
  const channelFile = path.join(app.getPath('userData'), 'update-channel.json');
  rm(path.join(app.getPath('userData'), 'update-pending.json'), { force: true }).catch(() => {});
  const updater = startUpdater({ app, version, log: updateLog, skip: {
    get: () => readState(startFile).skip,
    clear: () => { const start = readState(startFile); start.skip = null; writeState(startFile, start); } }, channel: {
    get: () => { try { return JSON.parse(readFileSync(channelFile, 'utf8'))?.nightly === true; } catch { return false; } },
    set: on => writeState(channelFile, { nightly: on }) },
    // O24: the update-ready popup (the release's own list of changes), a native dialog, as the rollback notice above.
    // O24b: only Update now installs; Later, or closing the box without an answer, installs nothing, and the next open
    // asks again.
    ready: async ({ version: next, notes }) => (await dialog.showMessageBox(window, { type: 'info', title: 'P9 is ready to update',
      message: `P9 ${next} is ready to install.`,
      detail: (notes.length ? 'What changes:\n' + notes.map(line => '• ' + line).join('\n') + '\n\n' : '')
        + 'Update now closes P9, installs the update and opens P9 again by itself. Later asks again the next time you open P9.'
        + ' Your workspace, chats and settings stay.',
      buttons: ['Update now', 'Later'], defaultId: 0, cancelId: 1, noLink: true })).response === 0 ? 'now' : 'later' });
  ipcMain.handle('p9:updates', async (event, ...args) => {
    const action = updateAction(args);
    if (!fromApp(event) || !action) throw new Error('ipc-sender-refused');
    return (await updater)[action](args[0]);
  });
  // A link in an agent reply (threat model row 18): one plain http(s) address, checked again here, opens in the browser.
  ipcMain.handle('p9:open-link', async (event, ...args) => {
    const [href] = args;
    if (!fromApp(event) || args.length !== 1 || typeof href !== 'string' || href.length > 2048 || /[\s\p{Cc}\p{Cf}]/u.test(href)) throw new Error('ipc-sender-refused');
    let url;
    try { url = new URL(href); } catch { throw new Error('ipc-sender-refused'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('ipc-sender-refused');
    if (process.env.P9_OPEN_URL) spawn(process.env.P9_OPEN_URL, [url.href], { shell: false, stdio: 'ignore' }).on('error', () => {});
    else await shell.openExternal(url.href);
    return { opened: true };
  });
  ipcMain.handle('p9:open-petdex', async (event, ...args) => {
    if (!spikeShell(event)
        || args.length) throw new Error('ipc-sender-refused');
    if (process.env.P9_OPEN_URL) spawn(process.env.P9_OPEN_URL, [PETDEX_URL], { shell: false, stdio: 'ignore' }).on('error', () => {});
    else await shell.openExternal(PETDEX_URL);
    return { opened: true };
  });
  // A3 (3) Settings > General: show (true) or hide (false) the Usage tabs; the answer is { show } as the daemon keeps it.
  ipcMain.handle('p9:telemetry-tab', async (event, ...args) => {
    if (!fromApp(event) || args.length !== 1 || typeof args[0] !== 'boolean') throw new Error('ipc-sender-refused');
    if (!state) return { status: 503, body: { error: 'daemon-unavailable' } };
    try { return await daemonRequest(state, 'POST', '/telemetry-tab', { show: args[0] }); }
    catch (error) { return failedReply(error); }
  });
  // File protection (threat model row 4): no argument reads it, a boolean sets it. Turning it off asks first in a native dialog,
  // which the page can neither draw nor answer; turning it on never asks.
  ipcMain.handle('p9:file-protection', async (event, ...args) => {
    // O267b: (on, rev): rev, the daemon's name for the change a put-back undoes (server.mjs POST /file-protection).
    if (!fromApp(event) || args.length > 2 || (args.length && typeof args[0] !== 'boolean') || (args.length > 1 && (typeof args[1] !== 'string' || args[1].length > 64))) throw new Error('ipc-sender-refused');
    if (!state) return { status: 503, body: { error: 'daemon-unavailable' } };
    try {
      if (!args.length) return await daemonRequest(state, 'GET', '/file-protection');
      while (!args[0]) {
        const { response } = await dialog.showMessageBox(window, { type: 'warning', title: 'Turn off file protection?', message: 'Turn off file protection?',
          detail: FILE_PROTECTION_RISK, buttons: ['Keep protection on', 'Turn off protection', 'Read about the risk'], defaultId: 0, cancelId: 0, noLink: true });
        if (response === 1) break;
        // O267b: "Keep protection on" is no write: cancelled, with the setting as it is for display and no rev, so Unrestricted
        // (security.mjs changeFree) stops there and never counts another device's change as its own.
        if (response !== 2) { const now = await daemonRequest(state, 'GET', '/file-protection').catch(() => null);
          return { status: 200, body: { cancelled: true, ...(typeof now?.body?.on === 'boolean' && { on: now.body.on }) } }; }
        if (process.env.P9_OPEN_URL) spawn(process.env.P9_OPEN_URL, [FILE_PROTECTION_DOCS], { shell: false, stdio: 'ignore' }).on('error', () => {});
        else await shell.openExternal(FILE_PROTECTION_DOCS);
      }
      return await daemonRequest(state, 'POST', '/file-protection', { on: args[0], ...(args.length > 1 && { rev: args[1] }) });
    } catch { return { status: 503, body: { error: 'daemon-unavailable' } }; }
  });
  // The shell's DUWOP look (colours as #rrggbbaa), kept for the next Dev Focus start and passed on to a running one.
  const LOOK_TOKENS = ['background', 'foreground', 'card', 'primary', 'primary-foreground', 'muted', 'muted-foreground', 'accent', 'border', 'ring'];
  ipcMain.handle('p9:look', (event, ...args) => {
    const [input] = args;
    if (!spikeShell(event) || args.length !== 1
        || !input || typeof input.dark !== 'boolean' || !input.colors || Object.keys(input.colors).length !== LOOK_TOKENS.length
        || !LOOK_TOKENS.every(token => /^#[0-9a-f]{8}$/.test(input.colors[token] ?? ''))
        || (input.theme !== undefined && (typeof input.theme !== 'string' || !/^[a-z0-9-]{0,40}$/.test(input.theme)))) throw new Error('ipc-sender-refused');
    // theme: the shell's theme id (or ''), so Dev Focus can switch to a theme's own editor theme.
    look = { dark: input.dark, theme: input.theme ?? '', colors: Object.fromEntries(LOOK_TOKENS.map(token => [token, input.colors[token]])) };
    if (overlay) window.setTitleBarOverlay({ ...overlay, symbolColor: look.colors.foreground.slice(0, 7) });
    devView?.webContents.send('p9dev:look', look);
    cardsView?.webContents.send('p9cards:look', look);
    return { ok: true };
  });
  const { request } = devIpc(outer);
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
  // A reload that starts before this first load finishes (Ctrl+R, the hot reload above, a test) aborts it: the newer load
  // took over, the window is fine. Before, the rejection ended createDesktop and start.cjs quit the app (CI agent-setup :359).
  await window.loadURL(APP_URL).catch((error) => { if (error.code !== 'ERR_ABORTED') throw error; });
  if (open) request(open);
  return window;
}
