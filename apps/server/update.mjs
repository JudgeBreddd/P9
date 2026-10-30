// The server updates itself on connect (item 14, spec tunnel-file-transfer.md, threat model row 62). A laptop with a newer
// P9 pushes its source here in pieces (pieces.mjs), or a packaged app names its version and this daemon downloads that
// release's source archive; either way it is unpacked and built beside the running checkout (<root>.new-<id>), never in it.
// When no chat is mid-turn, new starts are held and scripts/update-swap.mjs, started outside this service by systemd-run,
// swaps the folders, restarts the service and puts the old checkout back if the new one does not answer with its version.
// Desktop routes only, never the phone's. Never an older or equal version: the check is here, not only on the laptop.
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appendPiece, checkStaged, validPiece } from './pieces.mjs';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, HASH = /^[0-9a-f]{64}$/, COMMIT = /^[0-9a-f]{40}$/;
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
// A P9 source archive is a few MiB; this only stops a runaway upload or download.
export const MAX_ARCHIVE = 256 * 1024 * 1024;
const BUILD_MS = 20 * 60_000, TURN_POLL_MS = 2000, LOG_TAIL = 4000;
// ponytail: a turn that has not ended in 2 h fails the update (turn-never-ended) and the server runs on; 5 min for the new
// version to answer /health once its service is active (a slow machine's first start builds caches).
const TURN_LIMIT_MS = 2 * 60 * 60_000, START_WAIT_MS = 5 * 60_000;
export const ARCHIVE = 'https://github.com/JudgeBreddd/P9/archive/refs/tags/';
const SWAP = fileURLToPath(new URL('../../scripts/update-swap.mjs', import.meta.url));
const refused = (status, error, extra) => ({ status, error, ...extra });
// The service's PATH is systemd's default, which has no pnpm: install.sh puts it beside this node or in ~/.local/bin.
export const toolPath = () => [process.env.PATH, path.dirname(process.execPath), path.join(os.homedir(), '.local', 'bin')].filter(Boolean).join(path.delimiter);

// Semver order: a > b. A pre-release sorts below its release; its dot parts compare as numbers when both are digits.
export function newer(a, b) {
  const x = VERSION.exec(a), y = VERSION.exec(b);
  if (!x || !y) return false;
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) > Number(y[i]);
  if (!x[4] || !y[4]) return !x[4] && !!y[4];
  const p = x[4].split('.'), q = y[4].split('.');
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined || q[i] === undefined) return q[i] === undefined;
    if (p[i] === q[i]) continue;
    const m = /^\d+$/.test(p[i]), n = /^\d+$/.test(q[i]);
    return m && n ? Number(p[i]) > Number(q[i]) : m !== n ? n : p[i] > q[i];
  }
  return false;
}

// root: the checkout this daemon runs from. version: its package.json version (what /health says). archive: where a
// packaged app's version is downloaded from. unit: the service the swap restarts.
export function createUpdate({ ownership, state, chat, lifecycle, version, root, archive = ARCHIVE, unit = 'p9-foundation', turnLimit = TURN_LIMIT_MS }) {
  const folder = ownership && path.join(ownership, 'update'), busy = new Set();
  const parent = path.dirname(root), base = path.basename(root);
  let job = null;
  // A run killed mid-update leaves its staging and half-built tree; nothing resumes them.
  const swept = (async () => {
    if (!folder) return;
    await mkdir(folder, { recursive: true, mode: 0o700 });
    for (const name of await readdir(folder)) if (name.endsWith('.tar.gz')) await rm(path.join(folder, name), { force: true });
    for (const name of await readdir(parent).catch(() => [])) {
      if (name.startsWith(base + '.new-') && ID.test(name.slice(base.length + 5))) await rm(path.join(parent, name), { recursive: true, force: true });
    }
  })().catch(() => {});

  // Only a source checkout under systemd can be rebuilt and restarted (answer 6); a bundled or hand-started daemon cannot.
  const supported = () => process.platform !== 'win32' && !!process.env.INVOCATION_ID && !!folder
    && ['package.json', 'pnpm-lock.yaml', 'apps/server/main.mjs'].every((name) => existsSync(path.join(root, name)));
  const active = () => job && !['failed'].includes(job.phase);
  function gate(target) {
    if (typeof target !== 'string' || !VERSION.test(target)) return refused(400, 'request-refused');
    if (!newer(target, version)) return refused(409, 'not-newer', { version });
    if (!supported()) return refused(409, 'update-unsupported');
    if (active()) return refused(409, 'update-running', { phase: job.phase });
    return null;
  }
  const staged = (id) => path.join(folder, id + '.tar.gz');

  async function log(text) { if (job) { job.log = (job.log + text).slice(-LOG_TAIL); await writeFile(path.join(folder, job.id + '.log'), job.log, { mode: 0o600 }).catch(() => {}); } }
  function run(command, args, cwd, timeout = BUILD_MS) {
    return new Promise((resolve) => execFile(command, args, { cwd, timeout, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PATH: toolPath(), CI: '1' } },
      async (error, stdout, stderr) => { await log('$ ' + [command, ...args].join(' ') + '\n' + stdout + stderr); resolve({ ok: !error, stdout }); }));
  }

  // Unpack, check, build, check dependencies, wait for turns, hand over to the swap. Any failure before the swap removes
  // the new tree; the running checkout was never touched.
  async function prepare(archiveFile) {
    const next = path.join(parent, base + '.new-' + job.id);
    const fail = async (error, extra) => {
      lifecycle.release?.('updating');
      await rm(next, { recursive: true, force: true }).catch(() => {});
      Object.assign(job, { phase: 'failed', error, ...extra });
    };
    try {
      job.phase = 'building';
      await rm(next, { recursive: true, force: true });
      await mkdir(next, { mode: 0o755 });
      // GNU tar, no shell: it refuses names with .. and creates links last, so nothing lands outside `next`.
      if (!(await run('tar', ['-xzf', archiveFile, '-C', next, '--strip-components=1', '--no-same-owner', '--no-same-permissions'], parent)).ok) return fail('unpack-failed');
      await rm(archiveFile, { force: true });
      const unpacked = await readFile(path.join(next, 'package.json'), 'utf8').then(JSON.parse, () => null);
      if (unpacked?.version !== job.version) return fail('version-mismatch', { found: unpacked?.version ?? null });
      // install.sh's steps: --ignore-scripts skips Electron's download, which only a desktop install has.
      const electron = existsSync(path.join(root, 'node_modules', 'electron', 'dist'));
      if (!(await run('pnpm', ['install', '--frozen-lockfile', ...(electron ? [] : ['--ignore-scripts'])], next)).ok) return fail('build-failed');
      if (!(await run('pnpm', ['build'], next)).ok) return fail('build-failed');
      // The new version's own dependency check (scripts/deps.mjs, from 0.1.6), in a child so its code never loads here.
      // It never runs sudo; what it cannot place comes back as { id, why, command } for the laptop to show. The window's
      // rule is checked for the checkout's own Electron (root), where the swap moves this build, not for this folder.
      const deps = path.join(next, 'scripts', 'deps.mjs');
      if (existsSync(deps)) {
        const checked = await run(process.execPath, ['--input-type=module', '-e',
          'const { ensureDependencies } = await import(process.argv[1]); process.stdout.write("\\n" + JSON.stringify(await ensureDependencies({ electron: process.argv[2] })) + "\\n");',
          pathToFileURL(deps).href, path.join(root, 'node_modules', 'electron', 'dist', 'electron')], next, 10 * 60_000);
        const result = checked.ok ? (() => { try { return JSON.parse(checked.stdout.trim().split('\n').at(-1)); } catch { return null; } })() : null;
        if (!Array.isArray(result?.missing)) return fail('dependency-check-failed');
        job.missing = result.missing.filter((m) => m && typeof m.id === 'string').slice(0, 50)
          .map((m) => ({ id: m.id.slice(0, 100), why: String(m.why ?? '').slice(0, 500), command: String(m.command ?? '').slice(0, 500) }));
      }
      // The turn wait: a restart now would cut a turn off. Hold new starts, then look again: a prompt admitted before the
      // hold is already 'turn' (chat.mjs sets it in the same tick as its lifecycle start), so this second look sees it.
      job.phase = 'waiting-turns';
      for (const end = Date.now() + turnLimit; ;) {
        job.turns = chat.list().filter((c) => c.state === 'turn').length;
        if (!job.turns) {
          lifecycle.hold('updating');
          job.turns = chat.list().filter((c) => c.state === 'turn').length;
          if (!job.turns) break;
          lifecycle.release('updating');
        }
        if (Date.now() > end) return fail('turn-never-ended');
        await new Promise((resolve) => setTimeout(resolve, TURN_POLL_MS));
      }
      job.phase = 'restarting';
      await rm(path.join(folder, 'result.json'), { force: true });
      // Outside this service: the restart stops this process, so the swap must not be its child.
      const started = await run('systemd-run', ['--user', '--unit', 'p9-update-' + job.id.slice(0, 8), '--collect', '--quiet', '--',
        process.execPath, SWAP, '--root', root, '--next', next, '--version', job.version, '--from', version, '--id', job.id,
        '--state', state, '--result', path.join(folder, 'result.json'), '--service', unit, '--wait', String(START_WAIT_MS)], parent, 30_000);
      if (!started.ok) return fail('restart-not-started');
      // A swap that fails before any restart (swap-failed) leaves this process running and held: hand the starts back and
      // say why. A restart ends this process, and this watch with it. ponytail: 30 minutes, past the swap's longest path
      // (two restarts of up to 120 s, two waits for active of up to 120 s, two 5 min health waits).
      const current = job;
      for (const end = Date.now() + 30 * 60_000; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 1000))) {
        const result = await readFile(path.join(folder, 'result.json'), 'utf8').then(JSON.parse, () => null);
        if (result?.id !== current.id) continue;
        if (!result.ok) { lifecycle.release?.('updating'); Object.assign(current, { phase: 'failed', error: String(result.reason ?? 'swap-failed').slice(0, 100) }); }
        return;
      }
    } catch (error) { await fail('update-failed', { detail: String(error?.message ?? error).slice(0, 300) }); }
  }
  function start(id, target, commit, archiveFile) {
    job = { id, phase: 'building', version: target, ...(commit ? { commit } : {}), from: version, turns: 0, missing: [], log: '', started: Date.now() };
    prepare(archiveFile);
    return { status: 202, id, phase: job.phase };
  }

  return {
    async part(id, body) {
      await swept;
      if (!ID.test(id ?? '') || !validPiece(body?.offset, body?.data)) return refused(400, 'request-refused');
      if (!supported()) return refused(409, 'update-unsupported');
      if (active()) return refused(409, 'update-running', { phase: job.phase });
      return appendPiece(staged(id), body.offset, body.data, MAX_ARCHIVE, busy);
    },
    // { version, bytes, sha256, commit }: the pushed archive is whole, and its version is newer than this one.
    async commit(id, body) {
      await swept;
      if (!ID.test(id ?? '') || !Number.isSafeInteger(body?.bytes) || !HASH.test(body?.sha256 ?? '')
        || (body.commit !== undefined && !COMMIT.test(body.commit))) return refused(400, 'request-refused');
      const refusal = gate(body.version);
      if (refusal) return refusal;
      // The job exists before the hash read, as fetch's does: a second commit meanwhile gets update-running, not a second build.
      job = { id, phase: 'checking', version: body.version, from: version, turns: 0, missing: [], log: '', started: Date.now() };
      if (!await checkStaged(staged(id), body.bytes, body.sha256)) { Object.assign(job, { phase: 'failed', error: 'incomplete' }); return refused(409, 'incomplete'); }
      return start(id, body.version, body.commit, staged(id));
    },
    // A packaged app (answer 7): it has no checkout to push, so this daemon downloads its version's source archive.
    async fetch(body) {
      await swept;
      const refusal = gate(body?.version);
      if (refusal) return refusal;
      const id = randomUUID(), file = staged(id);
      job = { id, phase: 'downloading', version: body.version, from: version, turns: 0, missing: [], log: '', started: Date.now() };
      (async () => {
        let response;
        try { response = await fetch(archive + 'v' + body.version + '.tar.gz', { signal: AbortSignal.timeout(5 * 60_000) }); } catch {}
        if (!response?.ok) return Object.assign(job, { phase: 'failed', error: 'download-failed', detail: response ? 'HTTP ' + response.status : 'unreachable' });
        let size = 0;
        const out = createWriteStream(file, { mode: 0o600 });
        try {
          for await (const chunk of response.body) {
            if ((size += chunk.length) > MAX_ARCHIVE) throw new Error('too-large');
            if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
          }
          await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
        } catch (error) {
          out.destroy(); await rm(file, { force: true });
          return Object.assign(job, { phase: 'failed', error: 'download-failed', detail: String(error.message).slice(0, 200) });
        }
        start(id, body.version, undefined, file);
      })();
      return { status: 202, id, phase: job.phase };
    },
    // The update under way in this run, or else the last swap's result (it outlives the restart; the job does not).
    async status() {
      const result = folder && await readFile(path.join(folder, 'result.json'), 'utf8').then(JSON.parse, () => null);
      const current = job && (({ log, ...rest }) => ({ ...rest, logTail: job.phase === 'failed' ? log.slice(-1500) : undefined }))(job);
      return { status: 200, version, supported: supported(), ...(current ? { job: current } : {}), ...(result ? { result } : {}) };
    },
    // For the phone's Mission tab: what it says while the server is updating.
    brief: () => (active() ? { phase: job.phase, version: job.version, turns: job.turns } : null),
  };
}
