// The pages main serves from memory: build assets read into a map, their inline-script CSP hashes, and Dev Focus's error page when the editor host cannot start. Split out of main.mjs (F9) with no change in behaviour.
import { editorDownload, editorProblem, EDITOR_DIR } from './editor-host.mjs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

// D5: the page Dev Focus shows when it cannot start. It names the cause; a missing editor server or another release of it
// gets one button, Install, which asks main (p9dev:install-editor, no arguments) for the pinned download (threat model row 52).
export const html = text => String(text).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');
export const INSTALL_SCRIPT = "const b = document.getElementById('install'), n = document.getElementById('note');\n"
  + "b.onclick = async () => { b.disabled = true; n.textContent = 'Installing and checking it. This takes a minute or two.';\n"
  + "  const r = await window.p9dev.installEditor().catch(() => ({ error: 'The install did not answer. Try again.' }));\n"
  + "  if (r.error) { n.textContent = r.error; b.disabled = false; } else n.textContent = 'Installed. Starting Dev Focus.'; };";
// Issue #14: a start that failed says what is missing and what to do, for the causes seen on real installs.
export const AGAIN = ' Switch to another focus and back to Dev Focus to try again.';
export const failedText = (message, where) => /spawn systemd-run ENOENT/.test(message)
  ? 'Dev Focus is unavailable: ' + where + ' has no systemd-run. P9 runs the editor server in a systemd user scope (part of systemd), so it needs a Linux with systemd.'
  : /Failed to connect to .*bus|Failed to create bus connection/i.test(message)
    ? 'Dev Focus is unavailable: ' + where + ' has no systemd user session for the editor server (systemd-run --user could not reach the user bus). Log in there normally (not with su or sudo); on a remote, run "loginctl enable-linger" as you once, then restart P9.' + AGAIN
    : message === 'editor-host-timeout' ? 'Dev Focus is unavailable: the editor server on ' + where + ' did not say it was ready within 30 seconds.' + AGAIN
      : 'Dev Focus is unavailable: the editor server on ' + where + ' did not start (' + message.slice(0, 300) + '). Installing it again replaces a damaged copy.';
export function devErrorPage(error, download = editorDownload()) {
  const plain = ['daemon-unavailable', 'server-old'].includes(error.message);
  const problem = plain ? error.message : error.problem ?? editorProblem(error);
  // error.server: Server mode, where the daemon there answered (POST /dev/editor) with the cause, its folder and its download.
  const remote = typeof error.server === 'string', where = remote ? 'the remote ' + error.server : 'this computer';
  const host = remote ? error.place : process.env.P9_EDITOR_HOST ?? path.join(EDITOR_DIR, 'codium-server');
  if (remote) download = error.download;
  const text = {
    'daemon-unavailable': remote ? 'Dev Focus is unavailable: the remote ' + error.server + ' is not answering through the tunnel. P9 reconnects on its own; open Dev Focus again in a few seconds.'
      : 'Dev Focus is unavailable: P9\'s background service is not answering. It restarts on its own; open Dev Focus again in a few seconds.',
    'server-old': 'Dev Focus is unavailable: the P9 on the remote ' + error.server + ' is older than 0.1.6 and cannot run the editor for this window. Update P9 on the remote, then open Dev Focus again.',
    missing: 'Dev Focus needs VSCodium\'s editor server (release 1.121.03429), and it is not installed on ' + where + '. It belongs in ' + host + '.',
    'other-release': 'Dev Focus needs VSCodium\'s editor server release 1.121.03429; ' + host + ' on ' + where + ' holds a different release.',
    failed: failedText(String(error.message), where),
  }[problem];
  const fixable = problem === 'missing' || problem === 'other-release' || (problem === 'failed' && / did not start \(/.test(text));
  const fix = !fixable ? '' : download ? '<p><button id="install" style="font:inherit;padding:6px 14px">Install the editor server' + (remote ? ' on the remote' : '') + '</button></p>'
      + '<p id="note" style="color:#8b97ad">' + (!remote && path.isAbsolute(download[0]) ? 'Takes the copy this AppImage carries' : 'Downloads about 83 MB from VSCodium\'s GitHub releases' + (remote ? ' onto ' + html(error.server) : ''))
      + ', checks its SHA-256 against the one P9 pins, and installs it there.'
      + (problem !== 'missing' ? ' The copy there now is kept beside it.' : '') + '</p><script>' + INSTALL_SCRIPT + '</script>'
    : '<p style="color:#8b97ad">P9 has no download of it for ' + html(remote ? 'that remote' : 'this computer (' + process.platform + '-' + process.arch + ')') + '. The README\'s Requirements say how to install it by hand.</p>';
  const page = '<!doctype html><title>Dev Focus</title><body style="background:#05070e;color:#dce4f2;font:14px system-ui;padding:24px"><p id="cause">' + html(text) + '</p>' + fix + '</body>';
  return { files: new Map([['/index.html', Buffer.from(page)]]), csp: "default-src 'none'; style-src 'unsafe-inline'; script-src " + (inlineHashes(page).join(' ') || "'none'") };
}
// CSP hashes of a page's inline scripts (the ones without src).
export const inlineHashes = html => [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
  .filter(match => !/\bsrc\s*=/.test(match[1]))
  .map(match => "'sha256-" + createHash('sha256').update(match[2]).digest('base64') + "'");
export async function assets(directory, prefix = '/') {
  const result = new Map();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name), route = prefix + entry.name;
    if (entry.isDirectory()) for (const [key, value] of await assets(name, route + '/')) result.set(key, value);
    else if (entry.isFile()) result.set(route, await readFile(name));
    else throw new Error('nonregular-build-asset');
  }
  return result;
}
