import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { childEnv } from './child-env.mjs';
import { stillAuthorized } from './authority.mjs';
import { hasUserBus } from './process-tree.mjs';

const run = promisify(execFile);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SOCKET = /^[a-zA-Z0-9_-]{1,64}$/;
// The one control frame (threat model surface 13): exactly {"resize":[cols,rows]}, integers in range, else null.
export function resizeFrame(text) {
  try {
    const body = JSON.parse(text), [cols, rows] = body.resize;
    return Object.keys(body).length === 1 && body.resize.length === 2 && Number.isInteger(cols) && cols >= 2 && cols <= 500
      && Number.isInteger(rows) && rows >= 1 && rows <= 200 ? cols + 'x' + rows : null;
  } catch { return null; }
}

export function createTerminals({ ledger, workspace, lifecycle, socket }) {
  if (process.platform !== 'linux') return null;
  if (!SOCKET.test(socket)) throw new Error('invalid-tmux-socket');
  const db = ledger.db;
  db.exec(`CREATE TABLE IF NOT EXISTS terminals
    (id TEXT PRIMARY KEY, state TEXT NOT NULL, created INTEGER NOT NULL);`);
  const tmux = (args, timeout = 3000) => run('tmux', ['-L', socket, ...args], { env: childEnv(), timeout });
  async function sessions() {
    try {
      const { stdout } = await tmux(['list-sessions', '-F', '#{session_name}']);
      return stdout.split('\n').filter((name) => name.startsWith('p9-'));
    } catch (error) {
      const detail = String(error.stderr ?? error.message);
      if (/no server running|failed to connect|No such file/i.test(detail)) return [];
      throw error;
    }
  }
  // The tmux server runs as its own user unit, so a daemon restart or SIGKILL leaves it alone, and Stop All ends
  // everything a pane started (detached background jobs too) by stopping the unit; tmux puts each pane in a scope that
  // is PartOf it. The server gets exactly childEnv(), not the user manager's environment.
  const unit = `p9-tmux-${socket}.service`;
  const systemctl = (args) => run('systemctl', ['--user', ...args], { env: childEnv(), timeout: 2000 });
  // A failed query counts as running, so Stop All never reports a stop it could not confirm.
  const serverState = () => systemctl(['is-active', unit]).then(({ stdout }) => stdout.trim(), (error) => String(error.stdout ?? '').trim() || 'query-failed');
  const gone = (state) => state === 'inactive' || state === 'failed';
  let starting = null;
  const ensureServer = () => starting ??= (async () => {
    // ponytail: without a user bus the server forks from the daemon; Stop All then sees sessions, not detached jobs.
    if (!hasUserBus() || !gone(await serverState())) return;
    await systemctl(['reset-failed', unit]).catch(() => {});
    const environment = Object.entries(childEnv()).map(([key, value]) => key + '=' + value);
    await run('systemd-run', ['--user', '--quiet', '--collect', '--unit', unit, '--property=KillMode=control-group', '--',
      '/usr/bin/env', '-i', ...environment, 'tmux', '-L', socket, '-D'], { env: childEnv(), timeout: 3000 });
    for (let i = 0; i < 60; i++) {
      try { await tmux(['list-sessions']); return; } catch (error) { if (/no sessions/i.test(String(error.stderr))) return; }
      await wait(50);
    }
    throw new Error('tmux-server-start-failed');
  })().finally(() => { starting = null; });
  const name = (id) => `p9-${id}`;
  const idFrom = (session) => session.slice(3);

  const recovered = (async () => {
    const real = await sessions();
    const rows = new Map(db.prepare('SELECT id, state FROM terminals').all().map((row) => [row.id, row.state]));
    // Only IDs already in the ledger come back; a stray p9- session on the socket is never adopted (Stop All still ends it).
    for (const session of real) if (rows.has(idFrom(session))) db.prepare("UPDATE terminals SET state = 'running' WHERE id = ?").run(idFrom(session));
    const present = new Set(real.map(idFrom));
    for (const id of rows.keys()) if (!present.has(id)) db.prepare("UPDATE terminals SET state = 'stopped' WHERE id = ?").run(id);
  })();
  // A failed tmux query must not end the daemon as an unhandled rejection; every route still awaits it and fails.
  recovered.catch(() => {});

  async function create(body) {
    await recovered;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) return { status: 400, error: 'request-refused' };
    const release = lifecycle.begin();
    if (!release) return { status: 503, error: 'stop-all-running' };
    const id = randomUUID();
    try {
      stillAuthorized();
      db.prepare("INSERT INTO terminals VALUES (?, 'starting', ?)").run(id, Date.now());
      await ensureServer();
      stillAuthorized();
      await tmux(['new-session', '-d', '-s', name(id), '-c', workspace]);
      db.prepare("UPDATE terminals SET state = 'running' WHERE id = ?").run(id);
      return { status: 201, terminal: id };
    } catch (error) {
      if (error.message === 'session-ended') { db.prepare("UPDATE terminals SET state = 'stopped' WHERE id = ?").run(id); throw error; }
      db.prepare("UPDATE terminals SET state = 'cleanup-failed' WHERE id = ?").run(id);
      return { status: 500, error: 'terminal-start-failed' };
    } finally { release(); }
  }

  async function stop(id) {
    await recovered;
    if (!ID.test(id) || !db.prepare('SELECT id FROM terminals WHERE id = ?').get(id)) return { status: 404, error: 'unknown-terminal' };
    // ponytail: Stop Session ends the terminal's panes; a job a pane detached (nohup, setsid) lives until Stop All.
    stillAuthorized();
    await tmux(['kill-session', '-t', '=' + name(id)]).catch(() => {});
    const left = await sessions();
    const result = left.includes(name(id)) ? 'cleanup-failed' : 'stopped';
    db.prepare('UPDATE terminals SET state = ? WHERE id = ?').run(result, id);
    return { status: result === 'stopped' ? 200 : 500, result };
  }

  async function stopAll() {
    await recovered;
    const owned = await sessions();
    stillAuthorized();
    await Promise.all(owned.map((session) => tmux(['kill-session', '-t', '=' + session]).catch(() => {})));
    let server = 'inactive';
    if (hasUserBus()) {
      stillAuthorized();
      await systemctl(['stop', unit]).catch(() => {});
      server = await serverState();
    }
    const left = await sessions();
    for (const session of owned) db.prepare('UPDATE terminals SET state = ? WHERE id = ?').run(left.includes(session) ? 'cleanup-failed' : 'stopped', idFrom(session));
    return left.length || !gone(server) ? 'cleanup-failed' : 'stopped';
  }

  // A browser terminal (phase 10): tmux control mode needs no PTY. Output arrives as %output lines with octal escapes;
  // input goes back as send-keys -H, so no byte is ever parsed as a tmux command.
  // raw is the socket under ws: revoke, lock and session expiry destroy it, which sets raw.destroyed at once, while ws
  // can still hand over frames it had already read. Every tmux write checks it, so none of those frames runs.
  async function attach(id, ws, raw) {
    // The close handler goes on before the first await: a lock or revoke during the lookup must leave no tmux client.
    let client = null, ended = false;
    const end = (code, reason) => {
      ended = true;
      client?.kill();
      // No code: a client that stopped reading would never get a close frame through, so the socket is cut.
      if (code && ws.readyState === ws.OPEN) ws.close(code, reason); else ws.terminate();
    };
    ws.once('close', () => { ended = true; client?.kill(); });
    const usable = () => !ended && ws.readyState === ws.OPEN && !raw.destroyed;
    // During the lookup only a resize is kept (the last valid one). A key cannot be valid yet (no lease exists), so it
    // ends the socket unrun; nothing is queued. The socket is not paused, so a close frame sent meanwhile is still read.
    let size = null;
    let onMessage = (data, binary) => {
      if (ended) return;
      if (binary) return end(4408, 'stale-input');
      if (!(size = resizeFrame(String(data)))) end(1008, 'bad-control-frame');
    };
    ws.on('message', (data, binary) => onMessage(data, binary));
    await recovered.catch(() => {});
    const row = ID.test(id) && db.prepare("SELECT state FROM terminals WHERE id = ?").get(id);
    let live = row?.state === 'running';
    // A shell that exited by itself leaves its row 'running'; the ledger learns it here and the ID reads as stopped.
    if (live) try { live = (await sessions()).includes(name(id)); } catch { return end(1011, 'terminal-query-failed'); }
    if (row?.state === 'running' && !live) db.prepare("UPDATE terminals SET state = 'stopped' WHERE id = ?").run(id);
    if (!usable()) return end(1000, 'closed');
    if (!live) return end(4404, 'unknown-terminal');
    client = spawn('tmux', ['-L', socket, '-C', 'attach-session', '-t', '=' + name(id)], { env: childEnv(), stdio: ['pipe', 'pipe', 'ignore'] });
    client.once('error', () => end(1011, 'terminal-failed'));
    const write = (line) => {
      if (!usable()) return;
      // Input the tmux client has not taken yet is bounded too.
      if (client.stdin.writableLength > 1024 * 1024) return end(1008, 'input-too-fast');
      client.stdin.write(line);
    };
    // Input freshness (surface 13): every 2 s the daemon sends a new lease, {"lease":"<16 hex>"}, as a text frame, and
    // the phone starts each key frame with the 8 bytes of the newest lease it holds. The phone cannot know a lease before
    // the daemon sent it, so a key frame whose lease left more than 5 s ago was typed more than 5 s ago, however it was
    // delayed or reordered. It closes the socket with 4408, unrun. No lease, no input. The clock is CLOCK_BOOTTIME
    // (/proc/uptime): it never jumps and keeps counting while the laptop sleeps, unlike performance.now() and Date.now().
    const leases = new Map();
    const boot = () => Number(fs.readFileSync('/proc/uptime', 'latin1').split(' ')[0]) * 1000;
    const fresh = (sent) => boot() - sent <= 5000;
    const lease = () => {
      const value = randomBytes(8).toString('hex');
      for (const [key, sent] of leases) if (!fresh(sent)) leases.delete(key);
      leases.set(value, boot());
      if (usable()) ws.send(JSON.stringify({ lease: value }));
    };
    // Liveness only (pongs never touch input): a phone silent for 20 s loses its tmux client.
    let heard = performance.now();
    ws.on('pong', () => { heard = performance.now(); });
    const heartbeat = setInterval(() => {
      if (performance.now() - heard > 20000) return end(1001, 'no-pong');
      ws.ping();
      lease();
    }, 2000);
    ws.once('close', () => clearInterval(heartbeat));
    let pending = '', held = [], heldBytes = 0;
    const send = (bytes) => {
      // A client that stops reading must not grow the daemon without bound.
      if (ws.bufferedAmount + bytes.length > 8 * 1024 * 1024) return end();
      if (usable()) ws.send(bytes);
    };
    client.stdout.setEncoding('latin1');
    client.stdout.on('data', (chunk) => {
      const lines = (pending + chunk).split('\n');
      pending = lines.pop();
      for (const line of lines) {
        const match = /^%output %\d+ (.*)$/.exec(line);
        if (!match) continue;
        const bytes = Buffer.from(match[1].replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8))), 'latin1');
        if (!held) send(bytes);
        else if ((heldBytes += bytes.length) > 8 * 1024 * 1024) end();
        else held.push(bytes);
      }
    });
    // Control mode sends only new output, so a phone attaching to a running shell first gets the screen as it stands.
    // ponytail: output arriving during the capture can show twice; a redraw (Ctrl+L) clears it.
    Promise.all([tmux(['capture-pane', '-p', '-e', '-t', '=' + name(id) + ':']), tmux(['display-message', '-p', '-t', '=' + name(id) + ':', '#{cursor_x} #{cursor_y}'])])
      .then(([screen, cursor]) => {
        const [x, y] = cursor.stdout.trim().split(' ').map(Number);
        send(Buffer.from('\x1b[2J\x1b[H' + screen.stdout.replace(/\n$/, '').split('\n').join('\x1b[0m\r\n') + '\x1b[0m\x1b[' + (y + 1) + ';' + (x + 1) + 'H'));
      }, () => {})
      .finally(() => { const queued = held; held = null; queued.forEach(send); });
    client.stdin.on('error', () => {});
    client.once('exit', () => {
      if (ended) return;
      // The shell can exit between the lookup and attach-session; the ledger learns it here, not at the next attach.
      sessions().then((list) => { if (!list.includes(name(id))) db.prepare("UPDATE terminals SET state = 'stopped' WHERE id = ?").run(id); }, () => {})
        .finally(() => end(1000, 'terminal-ended'));
    });
    // Binary frames are leased keys; a text frame must be a resize, and anything else closes the socket (surface 13).
    onMessage = (data, binary) => {
      if (!usable()) return;
      if (!binary) {
        const next = resizeFrame(String(data));
        return next ? write('refresh-client -C ' + next + '\n') : end(1008, 'bad-control-frame');
      }
      const frame = Buffer.from(data), sent = leases.get(frame.subarray(0, 8).toString('hex'));
      if (sent === undefined || !fresh(sent)) return end(4408, 'stale-input');
      const bytes = [...frame.subarray(8)].map((byte) => byte.toString(16).padStart(2, '0'));
      if (bytes.length) write('send-keys -t =' + name(id) + ': -H ' + bytes.join(' ') + '\n');
    };
    if (size) write('refresh-client -C ' + size + '\n');
    lease();
  }

  return {
    list: async () => { await recovered; return db.prepare('SELECT id, state, created FROM terminals ORDER BY created').all(); },
    create,
    stop,
    stopAll,
    attach,
    recovered,
    socket,
  };
}
