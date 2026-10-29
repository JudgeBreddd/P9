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
    'root-refused': 'P9 does not open that folder: it holds the workspace, your home folder or P9\'s own files.',
    'root-not-found': 'No folder at that path' + there + '.',
    'path-not-absolute': 'Type the folder\'s full path on the server, starting with /.',
    'request-refused': 'That is not a folder path P9 can open.',
    'daemon-unavailable': server ? 'The server is not answering through the tunnel. P9 reconnects on its own; try again in a few seconds.'
      : 'P9\'s background service is not answering. Try again in a few seconds.',
    'daemon-outdated': 'The P9' + (server ? ' on the server' : '') + ' is older than this app and cannot open other folders yet. Update it first.',
  }[error] ?? 'P9 could not open that folder' + there + ' (' + error + ').';
}
