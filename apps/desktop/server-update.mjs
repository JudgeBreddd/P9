// The server updates itself on connect (item 14, apps/server/update.mjs, threat model row 62): this laptop's half.
// On a connect to a server whose P9 is older, a source checkout pushes `git archive HEAD` in pieces; a packaged app (no
// checkout) asks the server to download its version's release source. Then it follows the server's turn wait, build and
// restart until /health names the new version or the swap says it rolled back. A server newer than this app is never
// touched: the window is told to update the app instead.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { daemonRequest } from '../../scripts/teh.mjs';
import { newer } from '../server/update.mjs';
import { PIECE } from '../server/pieces.mjs';

const run = promisify(execFile), LONG = 60_000, POLL_MS = 2000;
// ponytail: 3 h, past the server's longest update: the build (20 min), the turn limit (2 h) and the swap (under 15 min).
const FOLLOW_MS = 3 * 60 * 60_000;
// A step line names files, never where they are on the server: any absolute path becomes its last part (a URL stays whole).
// Exported for its test.
export const names = (steps) => Array.isArray(steps) ? steps.map((line) => String(line).replace(/(^|[\s'"(=])(\/[^\s'",:)]+)/g, (_, before, p) => before + path.basename(p))) : steps;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// What this app would send: a checkout's committed HEAD (its version from HEAD's package.json), or a packaged app's version.
async function offer({ checkout, version }) {
  if (!checkout) return { version };
  const head = await run('git', ['-C', checkout, 'show', 'HEAD:package.json']).then(({ stdout }) => JSON.parse(stdout).version, () => null);
  const commit = await run('git', ['-C', checkout, 'rev-parse', 'HEAD']).then(({ stdout }) => stdout.trim(), () => null);
  return head && commit ? { version: head, commit } : null;
}

// git archive into a temp folder, then its pieces to /update/<id>/part; a 409 with a size resumes from there.
async function push(state, checkout, target) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'p9-update-')), file = path.join(folder, 'p9.tar.gz');
  try {
    await run('git', ['-C', checkout, 'archive', '--format=tar.gz', '--prefix=p9/', '-o', file, target.commit]);
    const data = await readFile(file), id = randomUUID();
    for (let offset = 0; offset < data.length;) {
      const sent = await daemonRequest(state, 'POST', '/update/' + id + '/part', { offset, data: data.subarray(offset, offset + PIECE).toString('base64') }, undefined, LONG);
      if (sent.status === 200) offset = sent.body.size;
      else if (sent.status === 409 && sent.body.error === 'offset' && sent.body.size !== offset) offset = sent.body.size;
      else return sent;
    }
    return daemonRequest(state, 'POST', '/update/' + id + '/commit', { version: target.version, commit: target.commit, bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex') }, undefined, LONG);
  } finally { await rm(folder, { recursive: true, force: true }); }
}

// tell(event): { phase, ... } for the window. live(): false once this connection is gone or replaced, which ends the follow.
// check(): the tunnel's health check, which picks up the restarted daemon's new credentials (remote.mjs).
// deadline: how long the follow waits for the server's end, then says so (timed-out) instead of waiting for ever.
export async function updateServer({ state, check, version, checkout, host, tell = () => {}, live = () => true, deadline = FOLLOW_MS }) {
  const health = await check().catch(() => null);
  if (!health?.version) return { phase: 'unknown' };
  if (newer(health.version, version)) return tell({ phase: 'app-older', host, server: health.version, app: version }) ?? { phase: 'app-older' };
  const target = await offer({ checkout, version });
  if (!target || !newer(target.version, health.version)) return { phase: 'current' };
  const status = await daemonRequest(state, 'GET', '/update/status').catch(() => null);
  // A server older than 0.1.6 has no /update routes: it cannot update itself, so the window says how to do it once by hand.
  if (status?.status === 404) return tell({ phase: 'too-old', host, server: health.version, app: target.version }) ?? { phase: 'too-old' };
  if (status?.status !== 200) return { phase: 'unknown' };
  if (!status.body.supported) return tell({ phase: 'unsupported', host, server: health.version, app: target.version }) ?? { phase: 'unsupported' };
  // A version this server already tried and could not start or build is not sent again on every connect (each try is a
  // rebuild, and a rollback two restarts): only a newer target tries again. A lost piece or download does retry.
  const { job: prior, result: tried } = status.body;
  if (tried?.version === target.version && !tried.ok) {
    const event = { phase: 'rolled-back', host, version: target.version, reason: tried.reason, rolledBack: tried.rolledBack, steps: names(tried.steps) };
    tell(event);
    return event;
  }
  if (prior?.phase === 'failed' && prior.version === target.version && !['incomplete', 'download-failed'].includes(prior.error)) {
    const event = { phase: 'failed', host, version: target.version, error: prior.error, log: prior.logTail };
    tell(event);
    return event;
  }
  let started = status.body.job && !['failed'].includes(status.body.job.phase) ? { status: 202, body: status.body.job } : null;
  if (!started) started = checkout ? await push(state, checkout, target) : await daemonRequest(state, 'POST', '/update/fetch', { version: target.version }, undefined, LONG);
  if (started.status !== 202) return tell({ phase: 'failed', host, version: target.version, error: started.body?.error ?? 'update-refused' }) ?? { phase: 'failed' };
  const id = started.body.id;
  let last = '';
  const end = Date.now() + deadline;
  while (live()) {
    if (Date.now() > end) {
      const lost = { phase: 'timed-out', host, version: target.version, minutes: Math.round(deadline / 60_000) };
      tell(lost);
      return lost;
    }
    await wait(POLL_MS);
    // Through the restart nothing answers for a while; check() re-reads the new daemon's credentials once it is back.
    const now = await check().catch(() => null);
    const answer = await daemonRequest(state, 'GET', '/update/status').catch(() => null);
    const { job, result } = answer?.status === 200 ? answer.body : {};
    if (result?.id === id) {
      const done = result.ok ? { phase: 'done', host, version: target.version } : { phase: 'rolled-back', host, version: target.version, reason: result.reason, rolledBack: result.rolledBack, steps: names(result.steps) };
      tell(done);
      return done;
    }
    if (job?.id === id && job.phase === 'failed') {
      const failed = { phase: 'failed', host, version: target.version, error: job.error, log: job.logTail };
      tell(failed);
      return failed;
    }
    if (job?.id === id) {
      const event = { phase: job.phase, host, version: target.version, turns: job.turns, missing: job.missing };
      const key = JSON.stringify(event);
      if (key !== last) { last = key; tell(event); }
    } else if (now?.version === target.version) { tell({ phase: 'done', host, version: target.version }); return { phase: 'done' }; }
  }
  return { phase: 'left' };
}
