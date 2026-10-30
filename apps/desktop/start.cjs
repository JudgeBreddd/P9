const { app, protocol } = require('electron');
// allowServiceWorkers: Dev Focus extension pages (p9://webview) get their files through VS Code's service worker; without it an
// image preview stays blank (share-ready item 2, A/B). stream: the landing's <video> (landing v5) plays from p9://app.
protocol.registerSchemesAsPrivileged([{ scheme: 'p9', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, allowServiceWorkers: true, stream: true } }]);
const path = require('node:path');
const index = process.argv.indexOf('--state');
// The Linux AppImage's daemon is the p9-foundation unit (teh.mjs appImageService), whose state install-service.mjs puts here.
const linuxApp = process.platform === 'linux' && app.isPackaged && process.env.XDG_RUNTIME_DIR ? path.join(process.env.XDG_RUNTIME_DIR, 'p9-foundation') : undefined;
const state = index === -1 ? (process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || path.join(require('node:os').homedir(), 'AppData', 'Local'), 'P9', 'runtime') : linuxApp) : process.argv[index + 1];
if (index !== -1 && (!state || !path.isAbsolute(state))) throw new Error('state-must-be-absolute');
// p9 edit / p9 diff (scripts/p9.mjs, threat model row 14): the request rides Electron's single-instance lock to the running
// app, which checks it again; with no app running, this one starts and opens it.
const at = process.argv.indexOf('--p9-open');
let open = null;
try { open = at === -1 ? null : JSON.parse(process.argv[at + 1]); } catch {}
if (!app.requestSingleInstanceLock(open ?? {})) app.exit(0);
else import('./main.mjs').then(({ createDesktop }) => createDesktop({ state, open })).catch(error => {
  console.error(error.message);
  app.exit(1);
});
app.on('window-all-closed', () => app.quit());
