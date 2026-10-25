// Auto-update (threat model row 39, SECURITY.md § Auto-update): the installed app asks P9's public GitHub releases
// (Stable only, no sign-in) shortly after it starts and every 4 hours, downloads a newer version in the background, and
// installs it when the app quits, or at once from Settings → Maintenance → Updates (window.p9.updates, COORD A ↔ B1).
// Off for a source checkout, a build without app-update.yml (its feed), and on Linux anything but the AppImage.
// electron-updater is loaded only when on, so a source checkout never runs any of it.
import { existsSync } from 'node:fs';
import path from 'node:path';

const FIRST_CHECK_MS = 10_000, EVERY_MS = 4 * 3600_000;

// Why updates are off here, or null when they are on.
export function offReason({ packaged, resources, platform, env }) {
  if (!packaged) return 'source checkout';
  if (!['win32', 'linux'].includes(platform)) return 'not built for this system';
  if (!existsSync(path.join(resources, 'app-update.yml'))) return 'this build has no update feed';
  if (platform === 'linux' && !env.APPIMAGE) return 'not the AppImage';
  return null;
}

// The page's three calls: none reads the status, { check: true } starts a check, { install: true } restarts into a
// downloaded version. Anything else is null and refused.
export function updateAction(args) {
  if (!args.length) return 'read';
  const [ask] = args;
  if (args.length !== 1 || !ask || typeof ask !== 'object' || Array.isArray(ask)) return null;
  const keys = Object.keys(ask).join();
  return keys === 'check' && ask.check === true ? 'check' : keys === 'install' && ask.install === true ? 'install' : null;
}

// Returns { read, check, install }, each giving { state, current, available, reason }. state: off, idle, checking,
// downloading, ready or error. log(line) gets electron-updater's own lines and each change of state.
// load: the test's stand-in for electron-updater. skip: the version a rollback came back from (AU5, rollback.mjs), which
// is never downloaded again; get() reads it, clear() forgets it once a different release is offered.
export async function startUpdater({ app, version, log, resources = process.resourcesPath, platform = process.platform,
  env = process.env, load = () => import('electron-updater').then(module => module.default.autoUpdater), skip = { get: () => null, clear() {} } }) {
  const status = { state: 'off', current: version, available: null,
    reason: offReason({ packaged: app.isPackaged, resources, platform, env }) };
  const read = () => ({ ...status });
  if (status.reason) return { read, check: read, install: read };
  let updater;
  try { updater = await load(); }
  catch (error) { Object.assign(status, { state: 'error', reason: 'the updater did not load' }); log('load failed: ' + error.message); return { read, check: read, install: read }; }
  // The download starts on update-available below, as autoDownload would start it, unless that version is skipped.
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.logger = { info: log, warn: log, error: log, debug() {} };
  const set = (state, fields = {}) => { Object.assign(status, { state, reason: null }, fields); log(`state ${state}${status.available ? ' ' + status.available : ''}`); };
  updater.on('checking-for-update', () => set('checking'));
  updater.on('update-not-available', () => set('idle', { available: null }));
  updater.on('update-available', info => {
    const skipped = skip.get();
    if (info.version === skipped) { log('skipped ' + skipped + ': P9 went back from it'); return set('idle', { available: null }); }
    if (skipped) skip.clear();
    set('downloading', { available: info.version });
    updater.downloadUpdate().catch(() => {}); // a failure also arrives as 'error'
  });
  updater.on('update-downloaded', info => set('ready', { available: info.version }));
  // The first line only: electron-updater's messages can run to a whole HTTP response.
  updater.on('error', error => set('error', { reason: String(error?.message ?? error).split('\n')[0].slice(0, 200) }));
  const check = () => {
    // A download under way or done needs no new check; electron-updater would only find the same version.
    if (status.state !== 'downloading' && status.state !== 'ready') {
      set('checking');
      updater.checkForUpdates().catch(() => {}); // a failure also arrives as 'error'
    }
    return read();
  };
  const install = () => {
    // Silent, then start the new version (NSIS /S --force-run; the AppImage replaces itself and runs).
    if (status.state === 'ready') setImmediate(() => updater.quitAndInstall(true, true));
    return read();
  };
  setTimeout(check, FIRST_CHECK_MS).unref();
  setInterval(check, EVERY_MS).unref();
  set('idle');
  return { read, check, install };
}
