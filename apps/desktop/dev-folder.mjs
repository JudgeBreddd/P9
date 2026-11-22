// Dev Focus's Open Folder (threat model rows 41 and 50): the shape check main runs on a server path typed in Server mode, and the
// words the editor page shows for each refusal. One module for both, so they never disagree; no node imports (the page bundles it).

// A typed server path: absolute, POSIX, at most 4096 characters, no NUL; normalised with the server's rules (slash), whatever
// this computer runs. Whether it is inside the workspace is the server's answer on its real path (POST /dev/root, check).
export function serverPath(typed) {
  if (typeof typed !== 'string' || !typed.trim() || typed.length > 4096 || typed.includes('\0')) return { error: 'request-refused' };
  if (!typed.trim().startsWith('/')) return { error: 'path-not-absolute' };
  const parts = [];
  for (const part of typed.trim().split('/')) if (part === '..') parts.pop(); else if (part && part !== '.') parts.push(part);
  return { real: '/' + parts.join('/') };
}

// The page's words for an Open Folder refusal. server: the reply came from Server mode, so "there" is the server.
export function folderError(error, server) {
  const there = server ? ' on the server' : '';
  return {
    'root-refused': 'P9 does not open that folder: it holds the workspace, your home folder or P9\'s own files. Turn on Unrestricted mode in Settings' + there + ' to open it; P9\'s own folders stay closed even then.',
    'root-not-found': 'No folder at that path' + there + '.',
    'path-not-absolute': 'Type the folder\'s full path on the server, starting with /.',
    'request-refused': 'That is not a folder path P9 can open.',
    'daemon-unavailable': server ? 'The server is not answering through the tunnel. P9 reconnects on its own; try again in a few seconds.'
      : 'P9\'s background service is not answering. Try again in a few seconds.',
    'daemon-outdated': 'The P9' + (server ? ' on the server' : '') + ' is older than this app and cannot open other folders yet. Update it first.',
  }[error] ?? 'P9 could not open that folder' + there + ' (' + error + ').';
}

// "Don't ask again" on Trust this folder? (U2; review 2 L4): kept per place, 'local' or the server's host, in p9-trust.json's
// text. A check that finds the mode off drops that place's flag, so turning the mode on again asks again. An older file with
// one global trustOutside: true trusts nowhere.
const places = (text) => { try { const all = JSON.parse(text)?.trustOutside; return all && typeof all === 'object' && !Array.isArray(all) ? all : {}; } catch { return {}; } };
export const trusted = (text, place) => places(text)[place] === true;
// The file's new text, or null when nothing changes.
export function setTrust(text, place, on) {
  const all = { ...places(text) };
  if ((all[place] === true) === on) return null;
  if (on) all[place] = true; else delete all[place];
  return JSON.stringify({ trustOutside: all }) + '\n';
}

// Unrestricted mode (v0.1.6 U2/U4): the daemon's own predicate, agent lock off and File protection off. Any failure reads as off,
// and off drops this place's "Don't ask again" (L4). get(path) is a GET to this window's daemon; untrust() drops the flag.
export async function unrestricted(get, untrust) {
  const [lock, files] = await Promise.all([get('/agent-lock'), get('/file-protection')]).catch(() => []);
  const loose = lock?.body?.on === false && files?.body?.on === false;
  if (!loose) await untrust();
  return loose;
}

// New chat folder (threat model row 24), after the system dialog: an inside folder relative to the workspace, or (v0.1.6 U4) an
// outside one only for a new chat (setup false) while Unrestricted mode is on; the daemon checks it again when the chat is made.
export async function chatFolder(root, real, sep, setup, loose) {
  if (real === root) return '';
  if (real?.startsWith(root + sep)) return real.slice(root.length + 1).split(sep).join('/');
  return real && !setup && await loose() ? real : null;
}

// Dev Focus's Open Folder (threat model row 41): the native picker, then a folder inside the workspace opens at once; one outside
// it asks first, naming the folder, and the daemon checks it (POST /dev/root) before the editor shows it. Server mode (rows 41/50
// adds): the picker would list this computer's folders, so the page asks for the server path (one string, only then) and
// serverPath checks it with the server's rules; the rest is the same, through the tunnel. A refusal names its own reason.
// o is main's side, read when used: server (the host or null), health(), request(method, path, body) to the daemon, failedReply,
// realpath, pick(options) and ask(options) (the native dialogs), folder and setFolder (Dev Focus's folder), loose(), trustAll(),
// trust(on), platform, sep, and reopen() (the new folder's editor page, after the reply).
export async function openFolder(o, args) {
  const fail = error => ({ error, server: Boolean(o.server) });
  const status = await o.health().catch(() => null);
  if (!status?.workspace) return fail('daemon-unavailable');
  let workspace, real, key = p => p, sep = '/';
  if (o.server) {
    if (!args.length) return { pathNeeded: true, value: o.folder?.path ?? status.workspace };
    const typed = serverPath(args[0]);
    if (typed.error) return fail(typed.error);
    // Where it really is, from the server (a link inside the workspace may point outside); the check sets nothing.
    const found = await o.request('POST', '/dev/root', { path: typed.real, check: true }).catch(o.failedReply);
    if (found.status !== 200) return fail(found.body?.error === 'request-refused' ? 'daemon-outdated' : found.body?.error ?? 'daemon-unavailable');
    ({ workspace, root: real } = found.body);
  } else {
    workspace = await o.realpath(status.workspace);
    const pick = await o.pick({ title: 'Open Folder', buttonLabel: 'Open', properties: ['openDirectory'], defaultPath: o.folder?.path ?? workspace });
    if (pick.canceled || !pick.filePaths[0]) return { ok: false };
    real = await o.realpath(pick.filePaths[0]).catch(() => null);
    if (!real) return fail('root-not-found');
    key = p => o.platform === 'win32' ? p.toLowerCase() : p; sep = o.sep; // Windows paths compare without case.
  }
  const outside = key(real) !== key(workspace) && !key(real).startsWith(key(workspace) + sep);
  let set; // the daemon's answer: the root as it stores it, which saves must name exactly
  if (outside) {
    const loose = await o.loose();
    if (!(loose && await o.trustAll())) {
      const { response, checkboxChecked } = await o.ask(loose
        ? { type: 'question', title: 'Trust this folder?', message: 'Trust ' + real + (o.server ? ' on ' + o.server : '') + ' and open it in Dev Focus?',
          detail: 'It is outside the workspace. Saves there still go through P9\'s guarded save; P9\'s own folders stay closed.',
          buttons: ['Cancel', 'Trust and open'], defaultId: 1, cancelId: 0, noLink: true, checkboxLabel: 'Don\'t ask again', checkboxChecked: false }
        : { type: 'warning', title: 'Open a folder outside the workspace?', message: 'Open ' + real + (o.server ? ' on ' + o.server : '') + ' in Dev Focus?',
          detail: 'It is outside the workspace. Saves there still go through P9\'s guarded save. P9 keeps it open until you restart or open the workspace again.',
          buttons: ['Cancel', 'Open folder'], defaultId: 0, cancelId: 0, noLink: true });
      if (response !== 1) return { ok: false };
      if (loose && checkboxChecked) await o.trust(true);
    }
    set = await o.request('POST', '/dev/root', { path: real }).catch(o.failedReply);
    if (set.status !== 200) return fail(set.body?.error ?? 'daemon-unavailable');
  } else if (o.folder?.outside) await o.request('POST', '/dev/root', { path: null }).catch(() => null);
  // Inside: kept as the part after the workspace, so the page gets the daemon's own spelling of it (Windows case, a linked workspace).
  o.setFolder(key(real) === key(workspace) ? null : { path: outside ? set.body.root : real, outside, tail: real.slice(workspace.length) });
  o.reopen();
  return { ok: true };
}
