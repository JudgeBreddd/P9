// Dev Focus's IPC: config, guarded save and create, host paths, Open in VS Code, and opening files from the p9 command. Split out of main.mjs's createDesktop (F9) with no change in behaviour; names that stay in createDesktop come in through outer.
import { ipcMain, app } from 'electron';
import { daemonRequest, health } from '../../scripts/teh.mjs';
import { hostWritable, openInCode } from './editor-host.mjs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export function devIpc(outer) {
  ipcMain.handle('p9dev:config', async (event, ...args) => {
    if (!outer.fromDev(event) || args.length) throw new Error('ipc-sender-refused');
    return { ...(await outer.openDev()), look: outer.look };
  });
  // A folder outside the workspace: the write names the root this page was opened on, so the daemon refuses it once Dev Focus has
  // moved on. A restarted daemon has forgotten the root: set it again once, while it is still the open folder.
  const devWrite = async (method, body) => {
    const served = outer.devServing, write = () => daemonRequest(outer.state, method, '/files', served?.outside ? { ...body, root: served.path } : body);
    const result = await write();
    if (result.body?.error !== 'dev-root-unset' || served !== outer.devFolder) return result;
    if ((await daemonRequest(outer.state, 'POST', '/dev/root', { path: served.path })).status !== 200) return result;
    return write();
  };
  // Every editor save is the daemon's guarded save: the expected hash is what the editor loaded, so a disk change is a conflict.
  ipcMain.handle('p9dev:save', async (event, ...args) => {
    const [input] = args;
    if (!outer.fromDev(event) || args.length !== 1 || !input || typeof input.path !== 'string' || !/^[0-9a-f]{64}$/.test(input.hash ?? '') || typeof input.content !== 'string') throw new Error('ipc-sender-refused');
    if (!outer.state) return { kind: 'failed', error: 'daemon-unavailable' };
    try { return (await devWrite('PUT', { path: input.path, hash: input.hash, content: input.content })).body; }
    catch { return { kind: 'failed', error: 'daemon-unavailable' }; }
  });
  ipcMain.handle('p9dev:create', async (event, ...args) => {
    const [input] = args;
    if (!outer.fromDev(event) || args.length !== 1 || !input || typeof input.path !== 'string' || typeof input.content !== 'string') throw new Error('ipc-sender-refused');
    if (!outer.state) return { kind: 'failed', error: 'daemon-unavailable' };
    try {
      const result = await devWrite('POST', { path: input.path, content: input.content });
      return result.status === 201 ? result.body : { kind: 'failed', error: result.body?.error ?? String(result.status) };
    } catch { return { kind: 'failed', error: 'daemon-unavailable' }; }
  });
  ipcMain.handle('p9dev:host-path', async (event, ...args) => {
    if (!outer.fromDev(event) || args.length !== 2 || typeof args[0] !== 'string' || !['write', 'name'].includes(args[1])) throw new Error('ipc-sender-refused');
    if (outer.serverHost) {
      // The editor's data folder is on the server: its daemon checks the path there.
      const answer = await daemonRequest(outer.state, 'POST', '/dev/editor/writable', { path: args[0], kind: args[1] }).catch(() => null);
      return answer?.status === 200 && answer.body?.ok === true;
    }
    const host = await outer.editorHost?.catch(() => null);
    return Boolean(host) && hostWritable(host.data, args[0], args[1]);
  });
  ipcMain.handle('p9dev:open-in-code', async (event, ...args) => {
    const [input] = args;
    if (!outer.fromDev(event) || args.length !== 1 || !input) throw new Error('ipc-sender-refused');
    const config = await outer.openDev();
    if (config.error) return { ok: false, error: config.error };
    if (config.server) return { ok: false, error: 'server-mode' };
    return openInCode({ workspace: config.workspace, name: input.name, line: input.line, reason: input.reason });
  });
  // p9 edit / p9 diff (threat model row 14). Anything running as Builder can start a second instance, so this is the boundary:
  // exact shape, absolute paths, real path a regular file inside the workspace's real path. It only opens; saving stays guarded.
  const checkOpen = async data => {
    if (!outer.state || !data || typeof data !== 'object' || Array.isArray(data)) return null;
    const keys = Object.keys(data).sort().join(',');
    const edit = data.open === 'edit' && keys === 'line,open,path' && Number.isSafeInteger(data.line) && data.line >= 1 && data.line <= 10000000;
    if (!edit && !(data.open === 'diff' && keys === 'a,b,open')) return null;
    const root = (await realpath((await health(outer.state)).workspace)) + path.sep;
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
  const deliver = () => { while (outer.devReady && outer.queued.length) outer.devView.webContents.send('p9dev:open', outer.queued.shift()); };
  const request = async data => {
    const checked = await checkOpen(data).catch(() => null);
    if (!checked) return console.error('p9: open request refused');
    outer.queued.push(checked);
    // Names are workspace-relative: a folder outside it goes back to the workspace first (the new page's open-ready delivers).
    if (outer.devFolder?.outside) { daemonRequest(outer.state, 'POST', '/dev/root', { path: null }).catch(() => null); outer.devToWorkspace(); }
    if (outer.window.isMinimized()) outer.window.restore();
    outer.window.show();
    outer.window.focus();
    outer.window.webContents.send('p9:focus', 'dev');
    deliver();
  };
  app.on('second-instance', (_event, _argv, _cwd, data) => { if (data && Object.keys(data).length) request(data); });
  ipcMain.handle('p9dev:open-ready', (event, ...args) => {
    if (!outer.fromDev(event) || args.length) throw new Error('ipc-sender-refused');
    outer.devReady = true;
    deliver();
    return { ok: true };
  });
  return { request };
}
