import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { childEnv } from './child-env.mjs';
import { stillAuthorized } from './authority.mjs';
import { hasUserBus } from './process-tree.mjs';
import { quietFfi } from '../../packages/files/index.mjs';
// Loaded on Windows only (node:ffi and kernel32); a failed load leaves the terminal unavailable with its reason.
const conpty = process.platform === 'win32' ? await quietFfi(() => import('./conpty.mjs')).catch((error) => ({ error })) : null;

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

// Every platform gets the same routes (issue #11): tmux on Linux, ConPTY on Windows, and anywhere else (or when the
// Windows backend cannot load) a backend that answers every route with terminal-unavailable and the reason.
export function createTerminals({ ledger, workspace, lifecycle, socket, platform = process.platform }) {
  if (platform === 'linux') return tmuxTerminals({ ledger, workspace, lifecycle, socket });
  if (platform === 'win32' && conpty?.spawnPty) return conptyTerminals({ ledger, workspace, lifecycle });
  return unavailable(platform === 'win32' ? 'The Windows terminal could not load: ' + String(conpty?.error?.message ?? 'not loaded').slice(0, 200)
    : `P9 has no terminal for ${platform === 'darwin' ? 'macOS' : platform} yet.`);
}

function unavailable(reason) {
  const refused = { status: 503, error: 'terminal-unavailable', reason };
  return {
    list: async () => { throw Object.assign(new Error('terminal-unavailable'), { reason }); },
    create: async () => refused,
    stop: async () => refused,
    stopAll: async () => 'stopped',
    attach: async (id, ws) => ws.close(4503, 'terminal-unavailable'),
  };
}

function tmuxTerminals({ ledger, workspace, lifecycle, socket }) {
  if (!SOCKET.test(socket)) throw new Error('invalid-tmux-socket');
  const db = ledger.db;
  db.exec(`CREATE TABLE IF NOT EXISTS terminals
    (id TEXT PRIMARY KEY, state TEXT NOT NULL, created INTEGER NOT NULL);`);
  // A missing tmux binary is its own error, so the clients can say "tmux not found" instead of a bare "unavailable".
  const tmux = (args, timeout = 3000) => run('tmux', ['-L', socket, ...args], { env: childEnv(), timeout })
    .catch((error) => { throw error.code === 'ENOENT' && error.syscall === 'spawn tmux' ? new Error('tmux-not-found') : error; });
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

  const recover = async () => {
    const real = await sessions();
    const rows = new Map(db.prepare('SELECT id, state FROM terminals').all().map((row) => [row.id, row.state]));
    // Only IDs already in the ledger come back; a stray p9- session on the socket is never adopted (Stop All still ends it).
    for (const session of real) if (rows.has(idFrom(session))) db.prepare("UPDATE terminals SET state = 'running' WHERE id = ?").run(idFrom(session));
    const present = new Set(real.map(idFrom));
    for (const id of rows.keys()) if (!present.has(id)) db.prepare("UPDATE terminals SET state = 'stopped' WHERE id = ?").run(id);
  };
  let recovered = recover();
  // A failed tmux query must not end the daemon as an unhandled rejection; every route still awaits it and fails.
  recovered.catch(() => {});
  // A failed recovery is tried again on the next route call, so installing tmux needs no daemon restart.
  const ready = () => recovered.catch(() => (recovered = recover()));

  // start (Hand off, from server.mjs only, never a request's body): the folder, and a command typed in but not run.
  async function create(body, start = {}) {
    try { await ready(); } catch (error) { if (error.message === 'tmux-not-found') return { status: 503, error: 'tmux-not-found' }; throw error; }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) return { status: 400, error: 'request-refused' };
    const release = lifecycle.begin();
    if (!release) return { status: 503, error: 'stop-all-running' };
    const id = randomUUID();
    try {
      stillAuthorized();
      db.prepare("INSERT INTO terminals VALUES (?, 'starting', ?)").run(id, Date.now());
      await ensureServer();
      stillAuthorized();
      await tmux(['new-session', '-d', '-s', name(id), '-c', start.cwd ?? workspace]);
      if (start.typed) await tmux(['send-keys', '-t', '=' + name(id) + ':', '-l', start.typed]);
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
  const attach = (id, ws, raw) => serve(ws, raw, uptime, async ({ end, usable, send }) => {
    await recovered.catch(() => {});
    const row = ID.test(id) && db.prepare("SELECT state FROM terminals WHERE id = ?").get(id);
    let live = row?.state === 'running';
    // A shell that exited by itself leaves its row 'running'; the ledger learns it here and the ID reads as stopped.
    if (live) try { live = (await sessions()).includes(name(id)); } catch { return end(1011, 'terminal-query-failed'); }
    if (row?.state === 'running' && !live) db.prepare("UPDATE terminals SET state = 'stopped' WHERE id = ?").run(id);
    if (!usable()) return end(1000, 'closed');
    if (!live) return end(4404, 'unknown-terminal');
    const client = spawn('tmux', ['-L', socket, '-C', 'attach-session', '-t', '=' + name(id)], { env: childEnv(), stdio: ['pipe', 'pipe', 'ignore'] });
    client.once('error', () => end(1011, 'terminal-failed'));
    const write = (line) => {
      if (!usable()) return;
      // Input the tmux client has not taken yet is bounded too.
      if (client.stdin.writableLength > 1024 * 1024) return end(1008, 'input-too-fast');
      client.stdin.write(line);
    };
    let pending = '', held = [], heldBytes = 0;
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
    let killed = false;
    client.once('exit', () => {
      if (killed) return;
      // The shell can exit between the lookup and attach-session; the ledger learns it here, not at the next attach.
      sessions().then((list) => { if (!list.includes(name(id))) db.prepare("UPDATE terminals SET state = 'stopped' WHERE id = ?").run(id); }, () => {})
        .finally(() => end(1000, 'terminal-ended'));
    });
    return {
      keys: (bytes) => write('send-keys -t =' + name(id) + ': -H ' + [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join(' ') + '\n'),
      resize: (size) => write('refresh-client -C ' + size + '\n'),
      kill: () => { killed = true; client.kill(); },
    };
  });

  return {
    list: async () => { await ready(); return db.prepare('SELECT id, state, created FROM terminals ORDER BY created').all(); },
    create,
    stop,
    stopAll,
    attach,
    recovered,
    socket,
  };
}

// Windows (issue #11): each terminal is a ConPTY shell the daemon holds. No terminal outlives the daemon: the shells,
// their pseudo consoles and their jobs sit inside the daemon's own Foundation job, so a daemon restart ends every one
// and the ledger marks them stopped at start. A closed window or dock only detaches: the shell keeps running, and the
// next attach gets its recent output replayed.
function conptyTerminals({ ledger, workspace, lifecycle }) {
  const db = ledger.db;
  db.exec(`CREATE TABLE IF NOT EXISTS terminals
    (id TEXT PRIMARY KEY, state TEXT NOT NULL, created INTEGER NOT NULL);`);
  db.prepare("UPDATE terminals SET state = 'stopped' WHERE state != 'stopped'").run();
  const live = new Map();
  // ponytail: replay is the last 256 KiB of raw output, which can start mid escape sequence; a redraw (cls) clears it.
  const REPLAY = 256 * 1024;

  async function create(body, start = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) return { status: 400, error: 'request-refused' };
    const release = lifecycle.begin();
    if (!release) return { status: 503, error: 'stop-all-running' };
    const id = randomUUID();
    try {
      stillAuthorized();
      db.prepare("INSERT INTO terminals VALUES (?, 'starting', ?)").run(id, Date.now());
      let pty;
      try { pty = await conpty.spawnPty({ cwd: start.cwd ?? workspace, env: childEnv() }); } catch (error) {
        // spawnPty undoes its own partial start, so nothing is left running.
        db.prepare("UPDATE terminals SET state = 'stopped' WHERE id = ?").run(id);
        return { status: 503, error: 'terminal-unavailable', reason: 'The Windows terminal did not start: ' + String(error.message).slice(0, 200) };
      }
      const terminal = { pty, attached: new Set(), replay: [], replayBytes: 0 };
      live.set(id, terminal);
      pty.output.on('data', (bytes) => {
        terminal.replay.push(bytes);
        terminal.replayBytes += bytes.length;
        while (terminal.replayBytes > REPLAY && terminal.replay.length > 1) terminal.replayBytes -= terminal.replay.shift().length;
        for (const { send } of terminal.attached) send(bytes);
      });
      pty.exited.then(() => {
        live.delete(id);
        db.prepare("UPDATE terminals SET state = 'stopped' WHERE id = ?").run(id);
        for (const { end } of terminal.attached) end(1000, 'terminal-ended');
      });
      if (start.typed) pty.write(Buffer.from(start.typed));
      db.prepare("UPDATE terminals SET state = 'running' WHERE id = ?").run(id);
      return { status: 201, terminal: id };
    } catch (error) {
      if (error.message === 'session-ended') { db.prepare("UPDATE terminals SET state = 'stopped' WHERE id = ?").run(id); throw error; }
      db.prepare("UPDATE terminals SET state = 'cleanup-failed' WHERE id = ?").run(id);
      return { status: 500, error: 'terminal-start-failed' };
    } finally { release(); }
  }

  async function stop(id) {
    if (!ID.test(id) || !db.prepare('SELECT id FROM terminals WHERE id = ?').get(id)) return { status: 404, error: 'unknown-terminal' };
    stillAuthorized();
    // The job ends the shell and everything it started, detached jobs included.
    await live.get(id)?.pty.kill();
    db.prepare("UPDATE terminals SET state = 'stopped' WHERE id = ?").run(id);
    return { status: 200, result: 'stopped' };
  }

  async function stopAll() {
    stillAuthorized();
    await Promise.all([...live.values()].map(({ pty }) => pty.kill()));
    db.prepare("UPDATE terminals SET state = 'stopped' WHERE state != 'stopped'").run();
    return 'stopped';
  }

  // Every attached socket sees the same output; the last resize sent wins.
  const attach = (id, ws, raw) => serve(ws, raw, conpty.boot, async ({ end, usable, send }) => {
    const terminal = ID.test(id) && live.get(id);
    if (!usable()) return end(1000, 'closed');
    if (!terminal) return end(4404, 'unknown-terminal');
    const viewer = { send, end };
    if (terminal.replayBytes) send(Buffer.concat(terminal.replay));
    terminal.attached.add(viewer);
    return {
      // Input the shell has not taken yet is bounded, as on Linux.
      keys: (bytes) => { if (terminal.pty.write(bytes) > 1024 * 1024) end(1008, 'input-too-fast'); },
      resize: (size) => terminal.pty.resize(...size.split('x').map(Number)),
      kill: () => terminal.attached.delete(viewer),
    };
  });

  return {
    list: async () => db.prepare('SELECT id, state, created FROM terminals ORDER BY created').all(),
    create,
    stop,
    stopAll,
    attach,
  };
}

// The lease clock on Linux: CLOCK_BOOTTIME in milliseconds.
const uptime = () => Number(fs.readFileSync('/proc/uptime', 'latin1').split(' ')[0]) * 1000;

// One terminal socket (threat model surface 13), the same for every backend. open({ end, usable, send }) looks the
// terminal up and returns { keys(bytes), resize('<cols>x<rows>'), kill() }, or nothing once it has ended the socket.
// raw is the socket under ws: revoke, lock and session expiry destroy it, which sets raw.destroyed at once, while ws
// can still hand over frames it had already read. Every write to the shell checks it, so none of those frames runs.
async function serve(ws, raw, boot, open) {
  // The close handler goes on before the first await: a lock or revoke during the lookup must leave nothing attached.
  let session = null, ended = false;
  const end = (code, reason) => {
    ended = true;
    session?.kill();
    // No code: a client that stopped reading would never get a close frame through, so the socket is cut.
    if (code && ws.readyState === ws.OPEN) ws.close(code, reason); else ws.terminate();
  };
  ws.once('close', () => { ended = true; session?.kill(); });
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
  const send = (bytes) => {
    // A client that stops reading must not grow the daemon without bound.
    if (ws.bufferedAmount + bytes.length > 8 * 1024 * 1024) return end();
    if (usable()) ws.send(bytes);
  };
  session = await open({ end, usable, send });
  if (!session) return;
  if (ended) return session.kill();
  // Input freshness (surface 13): every 2 s the daemon sends a new lease, {"lease":"<16 hex>"}, as a text frame, and
  // the phone starts each key frame with the 8 bytes of the newest lease it holds. The phone cannot know a lease before
  // the daemon sent it, so a key frame whose lease left more than 5 s ago was typed more than 5 s ago, however it was
  // delayed or reordered. It closes the socket with 4408, unrun. No lease, no input. boot() never jumps and keeps
  // counting while the laptop sleeps, unlike performance.now() and Date.now().
  const leases = new Map();
  const fresh = (sent) => boot() - sent <= 5000;
  const lease = () => {
    const value = randomBytes(8).toString('hex');
    for (const [key, sent] of leases) if (!fresh(sent)) leases.delete(key);
    leases.set(value, boot());
    if (usable()) ws.send(JSON.stringify({ lease: value }));
  };
  // Liveness only (pongs never touch input): a phone silent for 20 s is detached.
  let heard = performance.now();
  ws.on('pong', () => { heard = performance.now(); });
  const heartbeat = setInterval(() => {
    if (performance.now() - heard > 20000) return end(1001, 'no-pong');
    ws.ping();
    lease();
  }, 2000);
  ws.once('close', () => clearInterval(heartbeat));
  // Binary frames are leased keys; a text frame must be a resize, and anything else closes the socket (surface 13).
  onMessage = (data, binary) => {
    if (!usable()) return;
    if (!binary) {
      const next = resizeFrame(String(data));
      return next ? session.resize(next) : end(1008, 'bad-control-frame');
    }
    const frame = Buffer.from(data), sent = leases.get(frame.subarray(0, 8).toString('hex'));
    if (sent === undefined || !fresh(sent)) return end(4408, 'stale-input');
    if (frame.length > 8) session.keys(frame.subarray(8));
  };
  if (size) session.resize(size);
  lease();
}
