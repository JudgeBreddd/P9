// Send to server, the server update and Send files: their IPC handlers. Split out of main.mjs's createDesktop (F9) with no change in behaviour; names that stay in createDesktop come in through outer.
import { ipcMain, app } from 'electron';
import { resolve as resolveXfer, overLimit, noAnswer, isFull, open as openXfer, planFolder, describe as describeXfer, runPlan } from './xfer.mjs';
import { sendToServer } from './move.mjs';
import { randomUUID } from 'node:crypto';

export function sendIpc(outer) {
  // Send to server (D14, move.mjs): this computer's chat moves to the server used last. From Local only: in Server mode the
  // chats are on the server already. One move per chat at a time; each has its Cancel.
  // Its progress goes to the window on p9:move (specs/move-progress-events.md, threat row 3): phase, percent, bytes and the
  // host main chose, never a path or a credential. Only for drawing; the ledger events stay the record.
  // With a Send files plan (item 23): id, plan id, choice, deleteToo, as the page answered the prompt for the chat's folder. The
  // folder goes over first, a Syncthing folder's not at all (Builder, 2026-10-27: "Keep today's wait"). Limits refuse before the freeze.
  const sending = new Map();
  let xferPlan = null, xferBusy = false; // Send files' plan and its one-at-a-time, below; a move with files takes them too
  ipcMain.handle('p9:send-to-server', async (event, ...args) => {
    const [id, planId, choice, deleteToo] = args;
    const ok = outer.uuid(id) && (args.length === 1 || args.length === 4 && outer.uuid(planId) && (choice === null || ['laptop', 'server', 'newer'].includes(choice)) && typeof deleteToo === 'boolean');
    if (!outer.fromApp(event) || !ok) throw new Error('ipc-sender-refused');
    if (outer.serverHost) return { status: 409, body: { error: 'server-mode', message: 'This window is on the remote already.' } };
    if (!outer.serverLast) return { status: 409, body: { error: 'no-server', message: 'No remote yet: add one in Settings > Remote Connect first.' } };
    if (!outer.localState || sending.has(id)) return { status: 409, body: { error: 'busy', message: 'This chat is moving already.' } };
    let files = null, to;
    if (planId) {
      if (xferBusy) return { status: 409, body: { error: 'busy', message: 'A send is running already.' } };
      if (xferPlan?.id !== planId || xferPlan.host !== outer.serverLast) return { status: 409, body: { error: 'stale', message: 'That check of the files is gone: press Send to remote again.' } };
      const { plan: p } = xferPlan, synced = p.syncthing.laptop.length || p.syncthing.server.length;
      // U4: a chat outside the workspace lands where its plan settled (p.roots.server). In a Syncthing folder its plan
      // carries only that: the files wait for the sync, as a workspace chat's do.
      to = p.roots?.server;
      if (!synced) {
        const work = resolveXfer(p, choice, deleteToo);
        if (!work) return { status: 409, body: { error: 'choice', message: 'Pick how to settle the files that differ.' } };
        const limit = overLimit(work, outer.settings.xfer, p.truncated);
        if (limit) return { status: 409, body: limit };
        files = { userData: app.getPath('userData'), plan: p, work };
      }
      xferPlan = null;
    }
    const stop = new AbortController();
    sending.set(id, stop);
    if (files) xferBusy = true;
    const onProgress = move => { if (!outer.window.isDestroyed()) outer.window.webContents.send('p9:move', move); };
    try { return await sendToServer({ local: outer.localState, id, host: outer.serverLast, ssh: outer.sshCommand, onProgress, signal: stop.signal, files, to }); }
    catch (error) { return { status: 503, body: { error: 'daemon-unavailable', message: noAnswer(error, outer.serverLast) } }; }
    finally { sending.delete(id); if (files) xferBusy = false; }
  });
  ipcMain.handle('p9:move-cancel', (event, ...args) => {
    if (!outer.fromApp(event) || args.length !== 1 || !outer.uuid(args[0])) throw new Error('ipc-sender-refused');
    sending.get(args[0])?.abort();
    return { cancelling: sending.has(args[0]) };
  });
  // Item 14: the server update's progress (server-update.mjs), and its last event for a window that loads after it.
  outer.tellUpdate = event => { if (!outer.window.isDestroyed()) outer.window.webContents.send('p9:server-update', event); };
  outer.updateWindow = outer.window;
  ipcMain.handle('p9:server-update', event => { if (!outer.fromApp(event)) throw new Error('ipc-sender-refused'); return outer.serverUpdate; });
  // Send files (item 23, xfer.mjs): 'plan' compares a workspace folder here and on the server used last and keeps the plan
  // here by id; the page shows what it asks and answers with 'run', id, choice, deleteToo. The page never sees a path's
  // bytes or the server's credentials. One send at a time; progress comes as p9:xfer events.
  const XFER_FOLDER = /^(?:[^/\\\0]+(?:\/[^/\\\0]+)*)?$/, SHOWN = 500;
  const inWorkspace = f => typeof f === 'string' && f.length <= 4096 && XFER_FOLDER.test(f) && !f.split('/').some(p => p === '.' || p === '..');
  const fullPath = f => typeof f === 'string' && f.length <= 4096 && !f.includes('\0') && isFull(f);
  // U4 (Builder, 2026-11-02): the remote folder picker for a chat started outside the workspace walks the remote over a tunnel
  // of its own ('folders' and 'list', as the window's /files/folders and /files/list). Kept open between clicks, closed after
  // a minute without one. ponytail: one picker tunnel; a second window's walk shares it.
  let pickLink = null, pickTimer;
  const pickCall = async (route) => {
    clearTimeout(pickTimer);
    if (pickLink?.host !== outer.serverLast) { pickLink?.link.then(l => l.tunnel.close()).catch(() => {}); pickLink = { host: outer.serverLast, link: openXfer({ local: outer.localState, host: outer.serverLast, ssh: outer.sshCommand }) }; }
    const mine = pickLink;
    try { return await (await mine.link).serverCall('GET', route); }
    catch (error) { if (pickLink === mine) pickLink = null; mine.link.then(l => l.tunnel.close()).catch(() => {}); return { status: 503, body: { error: 'no-answer', message: noAnswer(error, outer.serverLast) } }; }
    finally { pickTimer = setTimeout(() => { const gone = pickLink; pickLink = null; gone?.link.then(l => l.tunnel.close()).catch(() => {}); }, 60_000); pickTimer.unref?.(); }
  };
  // The picker's tunnel goes with P9: an ssh left behind would hold the connection open after quit.
  app.once('will-quit', () => { clearTimeout(pickTimer); const gone = pickLink; pickLink = null; gone?.link.then(l => l.tunnel.close()).catch(() => {}); });
  ipcMain.handle('p9:xfer', async (event, ...args) => {
    const [action, a, b, c] = args;
    // 'plan' with a chat's full path (U4, a chat started outside the workspace) and maybe to, where it goes on the remote.
    const ok = action === 'plan' ? (args.length === 2 && (inWorkspace(a) || fullPath(a))) || (args.length === 3 && fullPath(a) && (inWorkspace(b) || fullPath(b)))
      : action === 'folders' ? args.length === 3 && ['folders', 'list'].includes(a) && typeof b === 'string' && b.length <= 4096 && !b.includes('\0')
      : action === 'run' && args.length === 4 && outer.uuid(a) && (b === null || ['laptop', 'server', 'newer'].includes(b)) && typeof c === 'boolean';
    if (!outer.fromApp(event) || !ok) throw new Error('ipc-sender-refused');
    if (action === 'folders') {
      if (outer.serverHost || !outer.serverLast || !outer.localState) return { status: 409, body: { error: 'no-server' } };
      return pickCall(a === 'folders' ? '/files/folders?' + new URLSearchParams({ path: b }) : '/files/list?' + new URLSearchParams({ path: b }));
    }
    if (outer.serverHost) return { error: 'server-mode', message: 'Switch Settings > Remote Connect to Local first: Send files copies this computer\'s files to the remote.' };
    if (!outer.serverLast) return { error: 'no-server', message: 'No remote yet: add one in Settings > Remote Connect first.' };
    if (!outer.localState) return { error: 'daemon-unavailable', message: 'P9 on this computer did not answer.' };
    if (xferBusy) return { error: 'busy', message: 'A send is running already.' };
    xferBusy = true;
    try {
      if (action === 'plan') {
        const got = await planFolder({ local: outer.localState, host: outer.serverLast, folder: a, to: args.length === 3 ? b : undefined, userData: app.getPath('userData'), ssh: outer.sshCommand });
        if (got.error) return got;
        const p = got.plan, record = !p.first.length; // first: nothing sent to this folder yet
        xferPlan = { id: randomUUID(), host: outer.serverLast, plan: p };
        const asked = [...p.conflicts, ...p.first];
        return { id: xferPlan.id, host: outer.serverLast, folder: a, ...(p.roots && { to: p.roots.server }), send: p.send.length, same: p.same.length, sendBytes: p.send.reduce((n, i) => n + i.laptop.size, 0),
          kind: p.first.length ? 'first' : p.conflicts.length ? 'conflict' : null, summary: p.summary, asked: asked.length,
          list: asked.slice(0, SHOWN).map(item => ({ path: item.path, text: describeXfer(item, record) })),
          deletes: p.deletes.length, deleteList: p.deletes.slice(0, SHOWN).map(item => item.path), skipped: p.skipped, syncthing: p.syncthing };
      }
      if (xferPlan?.id !== a) return { error: 'stale', message: 'That plan is gone: press Send files again.' };
      const { host, plan: p } = xferPlan, work = resolveXfer(p, b, c);
      if (!work) return { error: 'choice', message: 'Pick how to settle the files that differ.' };
      const limit = overLimit(work, outer.settings.xfer, p.truncated);
      if (limit) return limit;
      xferPlan = null; // used once: sending again plans again (Builder, 2026-10-27: that is the resync)
      const r = await runPlan({ local: outer.localState, host, userData: app.getPath('userData'), plan: p, work, ssh: outer.sshCommand,
        onProgress: progress => { if (!outer.window.isDestroyed()) outer.window.webContents.send('p9:xfer', { id: a, ...progress }); } });
      return { ...r, sent: r.sent?.length ?? 0, received: r.received?.length ?? 0, deletedOnServer: r.deletedOnServer?.length ?? 0, deletedHere: r.deletedHere?.length ?? 0,
        kept: (r.recovery?.server.length ?? 0) + (r.recovery?.laptop.length ?? 0), recovery: undefined, changed: r.changed?.length ?? 0 };
    } catch (error) { return { error: 'daemon-unavailable', message: noAnswer(error, outer.serverLast) }; }
    finally { xferBusy = false; }
  });
}
