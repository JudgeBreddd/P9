// Send to server (D14, threat model row 51): moves one Claude chat from this computer's daemon to the server's, between turns.
// The daemons do the checking (apps/server/move.mjs); this only carries the pieces over a tunnel of its own, so a Server mode
// switch meanwhile does not touch it. Never two live copies: this computer's copy stays frozen until the server has the chat,
// and is marked moved only once the server said so. An answer that never came leaves it frozen; pressing again is safe,
// because the server answers "already here" for a chat it has.
import path from 'node:path';
import os from 'node:os';
import { daemonRequest } from '../../scripts/teh.mjs';
import { connectServer } from './remote.mjs';

const LONG = 120_000; // a 4 MiB piece over a slow link, or the server hashing a long transcript
const SYNC_WAIT = 120_000, SYNC_EVERY = 2000; // Syncthing catching up with the files the chat changed
const HEARTBEAT = 5000;
const CANCELLED = 'You cancelled the move. The chat stays here.';

// onProgress (the p9:move stream, specs/move-progress-events.md): { id, seq, phase, percent, bytes: { sent, total }, host,
// error?, message? }, for drawing only; the ledger's moving, moved and move-failed events stay the record. bytes.sent is what
// the server acknowledged, never what went into the socket. A phase that lasts repeats its last event every 5 s.
// signal: Cancel. Checked between requests only, so a chat the server has taken is never cancelled half way.
export async function sendToServer({ local, id, host, ssh = 'ssh', runtime = process.env.XDG_RUNTIME_DIR || os.tmpdir(), syncWait = SYNC_WAIT,
  onProgress = () => {}, signal, heartbeat = HEARTBEAT }) {
  let seq = 0, beat, last;
  const send = () => { try { onProgress({ id, seq: ++seq, host, ...last, bytes: { ...last.bytes } }); } catch {} };
  const tell = (phase, percent = last.percent, bytes = last.bytes, extra) => {
    last = { phase, percent, bytes, ...extra };
    clearInterval(beat);
    send();
    if (!['done', 'failed', 'unknown'].includes(phase)) (beat = setInterval(send, heartbeat)).unref?.();
  };
  try { return await move(); } finally { clearInterval(beat); }

  async function move() {
    const away = await daemonRequest(local, 'POST', `/chat/${id}/send-away`);
    if (away.status !== 200) return away; // refused before the freeze: the answer says why, and nothing is drawn
    const { status: _, ...manifest } = away.body;
    const total = manifest.parts.transcript.bytes + manifest.parts.events.bytes;
    tell('stopping', 0, { sent: 0, total });
    // Settles this computer's copy: moved for good, or runnable here again with the reason.
    const settle = async (ok, message, extra) => {
      await daemonRequest(local, 'POST', `/chat/${id}/moved`, { ok, host, ...(message && { message: message.slice(0, 600) }) }).catch(() => {});
      if (ok) tell('done', 100, { sent: total, total }); else tell('failed', undefined, undefined, { error: 'move-failed', message, ...extra });
      return ok ? { status: 200, body: { moved: true, host } } : { status: 409, body: { error: 'move-failed', message, ...extra } };
    };
    tell('connecting');
    let tunnel;
    try { tunnel = await connectServer({ host, ssh, runtime: path.join(runtime, 'p9-move-' + id.slice(0, 8)), editor: false }); }
    catch (error) { return settle(false, 'Could not reach the server (' + error.message + '). The chat stays here.'); }
    const server = (route, body) => daemonRequest(tunnel.state, 'POST', route, body, undefined, LONG);
    // Cancel: the server deletes what it has of the upload at once. One it took already (an answer lost before) finishes instead.
    const cancelled = async () => {
      if (!signal?.aborted) return false;
      const answer = await server(`/chat-import/${id}/cancel`, {});
      return !(answer.status === 409 && answer.body.error === 'already-here');
    };
    try {
      for (let round = 0; ; round++) {
        // The pieces. A 409 with a size is the server saying how much it has: carry on from there.
        let done = 0;
        for (const kind of ['transcript', 'events']) {
          for (let offset = 0; offset < manifest.parts[kind].bytes;) {
            if (await cancelled()) return settle(false, CANCELLED, { cancelled: true });
            const piece = await daemonRequest(local, 'GET', `/chat/${id}/move-part?kind=${kind}&offset=${offset}`, undefined, undefined, LONG);
            if (piece.status !== 200 || !piece.body.bytes) return settle(false, 'This computer could not read the chat (' + piece.body.error + '). The chat stays here.');
            const sent = await server(`/chat-import/${id}/part`, { kind, offset, data: piece.body.data });
            if (sent.status === 200) offset = sent.body.size;
            else if (sent.status === 409 && sent.body.error === 'offset' && sent.body.size !== offset) offset = sent.body.size;
            else if (sent.status === 409 && sent.body.error === 'already-here') break;
            else return settle(false, 'The server refused the chat (' + sent.body.error + '). The chat stays here.');
            const at = Math.min(done + offset, total);
            tell('uploading', total ? Math.floor(99 * at / total) : 0, { sent: at, total });
          }
          done += manifest.parts[kind].bytes;
        }
        // The commit. Files the chat changed that the server does not have yet: wait for the sync, then name them.
        const start = Date.now();
        let landed;
        tell('landing', 99);
        for (;;) {
          if (await cancelled()) return settle(false, CANCELLED, { cancelled: true });
          landed = await server(`/chat-import/${id}`, manifest);
          if (landed.status !== 409 || landed.body.error !== 'files-not-synced' || Date.now() - start >= syncWait) break;
          if (last.phase !== 'syncing') tell('syncing', 99);
          await new Promise((resolve) => setTimeout(resolve, SYNC_EVERY));
        }
        if (landed.status === 200) return settle(true);
        // A piece went wrong on the way (or an old upload was there): the server threw them away, so send them once more.
        if (landed.body.error === 'upload-mismatch' && round === 0) continue;
        if (landed.body.error === 'files-not-synced') {
          return settle(false, 'The server does not have the latest copy of ' + landed.body.files.join(', ') + (landed.body.count > landed.body.files.length ? ' and ' + (landed.body.count - landed.body.files.length) + ' more' : '')
            + '. Let the sync finish, then send the chat again. The chat stays here.');
        }
        if (landed.body.error === 'folder-missing') return settle(false, 'The server has no folder ' + landed.body.folder + ' in its workspace. The chat stays here.');
        return settle(false, 'The server refused the chat (' + landed.body.error + '). The chat stays here.');
      }
    } catch {
      // No answer: the server may have the chat or not. This copy stays frozen, so the two can never both run.
      const message = 'Lost the server before it answered. Press Send to server again to finish the move.';
      tell('unknown', undefined, undefined, { error: 'move-unknown', message });
      return { status: 503, body: { error: 'move-unknown', message } };
    } finally { await tunnel.close().catch(() => {}); }
  }
}
