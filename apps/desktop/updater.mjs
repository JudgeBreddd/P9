// Auto-update (threat model row 39, SECURITY.md § Auto-update): the installed app asks P9's public GitHub releases
// (Stable, or Nightly too when the Settings switch is on; no sign-in) shortly after it starts and every 4 hours, downloads a newer version in the background, and
// asks once it is downloaded (O24, 0.1.9): Update now closes P9, installs and reopens it; Later installs it the next time P9
// opens. Nothing installs when P9 quits: 0.1.8's install-on-quit ran the installer behind a window opened meanwhile and
// ended it, and never reopened P9. Settings → Maintenance → Updates installs at once too (window.p9.updates, COORD A ↔ B1).
// Off for a source checkout, a build without app-update.yml (its feed), and on Linux anything but the AppImage.
// electron-updater is loaded only when on, so a source checkout never runs any of it.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { newer } from '../server/update.mjs';

const FIRST_CHECK_MS = 10_000, EVERY_MS = 4 * 3600_000;

// Why updates are off here, or null when they are on.
export function offReason({ packaged, resources, platform, env }) {
  if (!packaged) return 'source checkout';
  if (!['win32', 'linux'].includes(platform)) return 'not built for this system';
  if (!existsSync(path.join(resources, 'app-update.yml'))) return 'this build has no update feed';
  if (platform === 'linux' && !env.APPIMAGE) return 'not the AppImage';
  return null;
}

// The page's four calls: none reads the status, { check: true } starts a check, { install: true } restarts into a
// downloaded version, { nightly: true | false } picks the channel. Anything else is null and refused.
export function updateAction(args) {
  if (!args.length) return 'read';
  const [ask] = args;
  if (args.length !== 1 || !ask || typeof ask !== 'object' || Array.isArray(ask)) return null;
  const keys = Object.keys(ask).join();
  return keys === 'check' && ask.check === true ? 'check' : keys === 'install' && ask.install === true ? 'install'
    : keys === 'nightly' && typeof ask.nightly === 'boolean' ? 'nightly' : null;
}

// O24: the list of changes for the popup, from electron-updater's releaseNotes (the release body as GitHub's feed gives it, HTML;
// an array of { note } with fullChangelog). The running version's whats-new.mjs only knows its own list. Each list item
// before the first <h2> (the body's "## Install") as plain text, at most 12 of 240 characters; an unknown shape gives [].
export function noteLines(notes) {
  const html = Array.isArray(notes) ? notes.map(n => n?.note ?? '').join('\n') : typeof notes === 'string' ? notes : '';
  const text = s => s.replace(/<[^>]*>/g, ' ').replace(/&(lt|gt|quot|#39|amp);/g, (_, e) => ({ lt: '<', gt: '>', quot: '"', '#39': "'", amp: '&' })[e])
    .replace(/\s+/g, ' ').replace(/ ([.,;:)])/g, '$1').trim();
  const top = html.split(/<h2[\s>]|^## /im)[0];
  const items = /<li[\s>]/i.test(top) ? [...top.matchAll(/<li[^>]*>([^]*?)(?=<li[\s>]|<\/[uo]l>|$)/gi)].map(m => m[1])
    : top.split('\n').filter(l => /^\s*[-*] /.test(l)).map(l => l.replace(/^\s*[-*] /, '').replace(/\*\*|`/g, ''));
  return items.map(text).filter(Boolean).slice(0, 12).map(l => l.length > 240 ? l.slice(0, 239) + '…' : l);
}

// Returns { read, check, install, nightly }, each giving { state, current, available, reason, nightly }. state: off, idle, checking,
// downloading, ready or error. log(line) gets electron-updater's own lines and each change of state.
// load: the test's stand-in for electron-updater. skip: the version a rollback came back from (AU5, rollback.mjs), which
// is never downloaded again; get() reads it, clear() forgets it once a different release is offered. channel: the Nightly
// switch (O2, 0.1.8), get() and set(on); on, GitHub pre-releases (the nightlies) are offered as well as stable releases.
// O24: ready({ version, notes }) is the popup, answering 'now' or 'later'; pending (get(), set(version | null)) keeps the
// downloaded version that waits for the next open; installing(version) says so before that open closes P9 to install.
// Turning it off never goes back down: a nightly stays until a stable release newer than it is out (allowDowngrade off).
// With it off, a pre-release already on its way (a download under way or done, or a check sent while it was on) is
// dropped and never installed on quit (phase 1 review finding 1).
export async function startUpdater({ app, version, log, resources = process.resourcesPath, platform = process.platform,
  env = process.env, load = () => import('electron-updater').then(module => module.default.autoUpdater), skip = { get: () => null, clear() {} },
  channel = { get: () => false, set() {} }, ready = async () => 'later', pending = { get: () => null, set() {} }, installing = async () => {} }) {
  const status = { state: 'off', current: version, available: null,
    reason: offReason({ packaged: app.isPackaged, resources, platform, env }), nightly: channel.get() === true };
  const read = () => ({ ...status });
  // Kept even while updates are off, so it holds once they are on.
  const pick = on => { channel.set(on); status.nightly = on; };
  if (status.reason) return { read, check: read, install: read, nightly: ask => { pick(ask.nightly); return read(); } };
  let updater;
  try { updater = await load(); }
  catch (error) {
    Object.assign(status, { state: 'error', reason: 'the updater did not load' }); log('load failed: ' + error.message);
    return { read, check: read, install: read, nightly: ask => { pick(ask.nightly); return read(); } };
  }
  // The download starts on update-available below, as autoDownload would start it, unless that version is skipped.
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = status.nightly;
  updater.allowDowngrade = false;
  // One line per message: with no normal release, GitHub's 404 page (a whole HTML document) follows "Data:" in
  // electron-updater's error, and it used to fill p9-update.log. The first line names the error and the URL.
  const line = (message) => {
    const text = String(message ?? ''), first = text.split('\n')[0].slice(0, 500);
    return first.length < text.length ? first + ' (' + (text.length - first.length) + ' more characters not logged)' : first;
  };
  updater.logger = { info: m => log(line(m)), warn: m => log(line(m)), error: m => log(line(m)), debug() {} };
  const set = (state, fields = {}) => { Object.assign(status, { state, reason: null }, fields); log(`state ${state}${status.available ? ' ' + status.available : ''}`); };
  updater.on('checking-for-update', () => set('checking'));
  updater.on('update-not-available', () => set('idle', { available: null }));
  const pre = v => String(v ?? '').includes('-');
  const drop = v => { pending.set(null); log('dropped ' + v + ': Nightly is off'); set('idle', { available: null }); };
  updater.on('update-available', info => {
    if (!status.nightly && pre(info.version)) return drop(info.version);
    const skipped = skip.get();
    if (info.version === skipped) { log('skipped ' + skipped + ': P9 went back from it'); pending.set(null); return set('idle', { available: null }); }
    if (skipped) skip.clear();
    set('downloading', { available: info.version });
    updater.downloadUpdate().catch(() => {}); // a failure also arrives as 'error'
  });
  // O24: a version that was waiting when P9 opened installs at once, after installing() says so (P9 reopens on the new
  // one); any other asks once. Downloaded means it waits for the next open, whichever button, or none, is pressed.
  const due = pending.get();
  if (due && !newer(due, version)) pending.set(null);
  let asked = null;
  updater.on('update-downloaded', info => {
    if (!status.nightly && pre(info.version)) return drop(info.version);
    pending.set(info.version);
    set('ready', { available: info.version });
    if (info.version === due && newer(due, version)) {
      log('installing ' + due + ': it was left for this open');
      return void Promise.resolve(installing(due)).catch(() => {}).then(() => updater.quitAndInstall(true, true));
    }
    if (asked === info.version) return;
    asked = info.version;
    Promise.resolve(ready({ version: info.version, notes: noteLines(info.releaseNotes) }))
      .then(answer => { log('popup ' + info.version + ': ' + answer); if (answer === 'now') install(); }, () => {});
  });
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
    // Silent, then start the new version (NSIS /S --force-run; the AppImage replaces itself and runs). The assisted
    // (oneClick false) installer starts P9 after an install only when it is both silent and force-run (electron-builder's
    // installSection.nsh), which is why install-on-quit (silent, no force-run) never reopened it.
    if (status.state === 'ready') setImmediate(() => updater.quitAndInstall(true, true));
    return read();
  };
  // A new channel checks again at once. Off drops a pre-release under way or done; a stable one is kept.
  const nightly = ask => {
    pick(ask.nightly); updater.allowPrerelease = ask.nightly; log('channel ' + (ask.nightly ? 'nightly' : 'stable'));
    if (!ask.nightly && pre(status.available) && (status.state === 'downloading' || status.state === 'ready')) drop(status.available);
    return check();
  };
  // A version left for this open is looked for at once, so P9 closes to install before the user starts anything.
  setTimeout(check, due && newer(due, version) ? 0 : FIRST_CHECK_MS).unref();
  setInterval(check, EVERY_MS).unref();
  set('idle');
  return { read, check, install, nightly };
}
