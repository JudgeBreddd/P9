import { open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// The Sprint tracker (Mission Control): a sprint coordinator rewrites this file on each wake-up (the sprint skill's
// templates/status.schema.md); the daemon only reads it. One file per machine, in the daemon user's home.
export const sprintFile = () => path.join(os.homedir(), '.local', 'state', 'sprint', 'status.json');
const MAX = 256 * 1024;
const STATES = new Set(['running', 'waiting', 'merged', 'blocked']);
const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');

// 404 while there is no sprint (the button hides); 422 when the file is there but unreadable (the button stays, the
// window says why); else only the known fields, cut to size, so nothing else in the file reaches a client.
export async function readSprint(file = sprintFile()) {
  let handle;
  try { handle = await open(file, 'r'); } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { status: 404, error: 'no-sprint' };
    return { status: 422, error: 'status-unreadable', reason: error.code ?? 'open-failed' };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { status: 422, error: 'status-unreadable', reason: 'not-a-file' };
    if (info.size > MAX) return { status: 422, error: 'status-unreadable', reason: 'too-large' };
    const buffer = Buffer.alloc(info.size);
    await handle.read(buffer, 0, info.size, 0);
    let data;
    try { data = JSON.parse(buffer.toString('utf8')); } catch { return { status: 422, error: 'status-unreadable', reason: 'not-json' }; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { status: 422, error: 'status-unreadable', reason: 'not-an-object' };
    const chunks = (Array.isArray(data.chunks) ? data.chunks : []).slice(0, 30).filter(c => c && typeof c === 'object').map(c => {
      const percent = Number.isFinite(c.percent) ? Math.round(Math.min(100, Math.max(0, c.percent))) : 0;
      return { id: text(c.id, 40), title: text(c.title, 200), state: STATES.has(c.state) ? c.state : 'unknown', percent, waitingOn: text(c.waitingOn, 300) };
    });
    return { status: 200, sprint: text(data.sprint, 200), updatedAt: text(data.updatedAt, 64), cutoff: text(data.cutoff, 64), chunks };
  } finally { await handle.close(); }
}

// Open tmux: a fixed command, never text from a request. Inside a P9 terminal TMUX names P9's own tmux server, so it is
// unset to reach the user's default server, where the sprint's session lives.
export const SPRINT_TMUX = 'env -u TMUX tmux attach -t p9';
