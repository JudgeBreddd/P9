// Send files to the server (item 23, spec tunnel-file-transfer.md): desktop main compares a folder's manifest on this
// computer's daemon and the server's (apps/server/xfer.mjs) with the record of what was last sent, asks when the two
// sides disagree, then copies pieces between the daemons as the chat move does (move.mjs), over a tunnel of its own.
// Every replaced or deleted file lands in that daemon's recovery folder; the record is updated only for what landed.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { daemonRequest } from '../../scripts/teh.mjs';
import { connectServer } from './remote.mjs';

const LONG = 120_000; // a 4 MiB piece over a slow link, or a daemon hashing a big folder
const BATCH = 2000;   // files a commit: keeps its body under the daemon's 12 MiB limit
// The limits (Builder, 2026-10-27: each a Setting, and a refusal names it): defaults and the largest each Setting allows
// (the server's ceilings, apps/server/xfer.mjs MAX_FILE and MAX_COUNT).
export const XFER_LIMITS = Object.freeze({
  fileMiB: { label: 'Largest file to send', unit: 'MiB', default: 512, max: 64 * 1024 },
  files: { label: 'Most files in one send', unit: 'files', default: 20000, max: 200000 },
  sendGiB: { label: 'Most data in one send', unit: 'GiB', default: 4, max: 1024 },
});
const MiB = 1024 ** 2, GiB = 1024 ** 3;
const size = (bytes) => bytes >= GiB ? (bytes / GiB).toFixed(1) + ' GiB' : bytes >= MiB ? (bytes / MiB).toFixed(1) + ' MiB' : Math.ceil(bytes / 1024) + ' KiB';
const clock = (ms) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

// The record: { path: sha256 } as last sent or received, one file per server (0600).
const recordFile = (userData, host) => path.join(userData, 'xfer', encodeURIComponent(host) + '.json');
export async function readRecord(userData, host) {
  try {
    const value = JSON.parse(await readFile(recordFile(userData, host), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}
async function writeRecord(userData, host, record) {
  const file = recordFile(userData, host), temporary = file + '.' + randomUUID();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
  await rename(temporary, file);
}

// The plan, from the two manifests and the record (null: nothing sent to this server yet). Each file is in at most one list:
// send (laptop's copy goes over), deletes (deleted on the laptop since the last send: asked), conflicts (changed on both
// sides, or deleted on one and changed on the other: asked), first (no record, both have it, they differ: asked).
// A file changed only on the server stays as it is: a Send goes one way.
export function plan(laptop, server, record, folder) {
  const L = new Map(laptop.files.map((f) => [f.path, f])), S = new Map(server.files.map((f) => [f.path, f]));
  const send = [], deletes = [], conflicts = [], first = [], same = [];
  for (const name of [...new Set([...L.keys(), ...S.keys()])].sort()) {
    const l = L.get(name), s = S.get(name), r = record?.[name];
    if (l && s && l.sha256 === s.sha256) { same.push({ path: name, sha256: l.sha256 }); continue; }
    const item = { path: name, laptop: l ?? null, server: s ?? null };
    if (l && s) {
      if (!record) first.push(item);
      else if (r === s.sha256) send.push(item);
      else if (r !== l.sha256) conflicts.push(item);
    } else if (l) {
      if (r === undefined) send.push(item);       // new on the laptop
      else if (r !== l.sha256) conflicts.push(item); // changed on the laptop, deleted on the remote
    } else if (r !== undefined) {
      if (r === s.sha256) deletes.push(item);     // deleted on the laptop
      else conflicts.push(item);                  // deleted on the laptop, changed on the remote
    }
  }
  const newer = (item) => !item.server ? 'laptop' : !item.laptop ? 'server' : item.laptop.mtimeMs >= item.server.mtimeMs ? 'laptop' : 'server';
  const count = (list, side) => list.filter((item) => newer(item) === side).length;
  return { folder, send, deletes, conflicts, first, same,
    summary: { laptopNewer: count([...conflicts, ...first], 'laptop'), serverNewer: count([...conflicts, ...first], 'server') },
    skipped: laptop.skipped, truncated: laptop.truncated || server.truncated,
    syncthing: { laptop: laptop.syncthing ?? [], server: server.syncthing ?? [] } };
}

// What differs about one asked-about file, in words (NEXT-ROUND item 23 wording).
export function describe(item, record) {
  const { laptop: l, server: s } = item;
  if (!l) return record ? 'deleted on the laptop; changed on the remote since your last send (' + clock(s.mtimeMs) + ')' : 'only on the remote';
  if (!s) return 'changed on the laptop (' + clock(l.mtimeMs) + '); deleted on the remote since your last send';
const WHO = { laptop: 'laptop', server: 'remote' }; // the side's internal name, the side's name on screen
  const side = l.mtimeMs >= s.mtimeMs ? ['laptop', l, 'server', s] : ['server', s, 'laptop', l];
  return (record ? 'changed on both since your last send; ' : 'different on the two; ')
    + 'the ' + WHO[side[0]] + '\'s copy is newer (' + clock(side[1].mtimeMs) + ') than the ' + WHO[side[2]] + '\'s (' + clock(side[3].mtimeMs) + ')';
}

// The work a choice makes of the plan. choice: 'laptop' | 'server' | 'newer' for conflicts and first-send differences
// (first has no 'server'); deleteToo: the laptop's deletes go to the server too.
export function resolve(p, choice, deleteToo) {
  const toServer = [...p.send], toLaptop = [], serverDeletes = [], laptopDeletes = [], forget = [];
  const asked = [...p.conflicts, ...p.first];
  if (asked.length && !['laptop', 'server', 'newer'].includes(choice)) return null;
  if (p.first.length && choice === 'server') return null;
  for (const item of asked) {
    // "Newer": a changed copy beats a delete (answer 8: a delete is never silent).
    const side = choice !== 'newer' ? choice : !item.server ? 'laptop' : !item.laptop ? 'server' : item.laptop.mtimeMs >= item.server.mtimeMs ? 'laptop' : 'server';
    if (side === 'laptop') (item.laptop ? toServer : serverDeletes).push(item);
    else (item.server ? toLaptop : laptopDeletes).push(item);
  }
  for (const item of p.deletes) (deleteToo ? serverDeletes : forget).push(item);
  return { toServer, toLaptop, serverDeletes, laptopDeletes, forget };
}

// Refused before anything is sent when past a limit: the message names the Setting.
export function overLimit(work, limits, truncated) {
  const moving = [...work.toServer.map((i) => i.laptop), ...work.toLaptop.map((i) => i.server)];
  const largest = moving.reduce((big, f) => (f.size > (big?.size ?? -1) ? f : big), null);
  const total = moving.reduce((sum, f) => sum + f.size, 0);
  const refuse = (setting, message) => ({ error: 'limit', setting, message: message + ' Change it in Settings, ' + XFER_LIMITS[setting].label + '.' });
  if (truncated || moving.length > limits.files) return refuse('files', 'This send has ' + (truncated ? 'more than ' + XFER_LIMITS.files.max : moving.length) + ' files; the limit is ' + limits.files + ' files.');
  if (largest && largest.size > limits.fileMiB * MiB) return refuse('fileMiB', largest.path + ' is ' + size(largest.size) + '; the limit is ' + limits.fileMiB + ' MiB a file.');
  if (total > limits.sendGiB * GiB) return refuse('sendGiB', 'This send is ' + size(total) + '; the limit is ' + limits.sendGiB + ' GiB a send.');
  return null;
}

// D19: a request with no answer says which P9 it was, so the message is not "this computer" for both.
export const tagSide = (side, asked) => asked.catch((error) => { throw Object.assign(error, { side: error.side ?? side }); });
// What a send says when a daemon gave no answer. bad-response is a non-JSON answer: a daemon without the route, older than this app.
export function noAnswer(error, host) {
  const why = String(error?.message ?? error).slice(0, 200);
  if (error?.side === 'remote') return why === 'bad-response' ? 'P9 on ' + host + ' is older than this app and cannot take files or chats. Update P9 there, then send again.'
    : 'P9 on ' + host + ' did not answer (' + why + '). Check it in Settings > Remote Connect, then send again.';
  if (error?.side === 'local') return why === 'bad-response' ? 'P9\'s background service on this computer is older than this app. Restart P9 (Settings), then send again.'
    : 'P9 on this computer did not answer (' + why + '). Restart P9 (Settings), then send again.';
  return 'The send stopped (' + why + ').';
}

// Opens the tunnel and gives the two daemons' requests. Closed by the caller.
async function open({ local, host, ssh, runtime }) {
  const tunnel = await connectServer({ host, ssh, editor: false, runtime: path.join(runtime, 'p9-xfer-' + randomUUID().slice(0, 8)) });
  return { tunnel, laptopCall: (method, route, body) => tagSide('local', daemonRequest(local, method, route, body, undefined, LONG)),
    serverCall: (method, route, body) => tagSide('remote', daemonRequest(tunnel.state, method, route, body, undefined, LONG)) };
}

export async function planFolder({ local, host, folder, userData, ssh = 'ssh', runtime = process.env.XDG_RUNTIME_DIR || os.tmpdir() }) {
  const laptop = await tagSide('local', daemonRequest(local, 'POST', '/xfer/manifest', { folder }, undefined, LONG));
  if (laptop.status !== 200) return { error: laptop.body.error, message: 'This computer could not list ' + (folder || 'the workspace') + ' (' + laptop.body.error + ').' };
  let link;
  try { link = await open({ local, host, ssh, runtime }); }
  catch (error) { return { error: 'unreachable', message: 'Could not reach the remote (' + error.message + ').' }; }
  try {
    const server = await link.serverCall('POST', '/xfer/manifest', { folder });
    if (server.status === 409 && server.body.error === 'folder-missing') server.body = { files: [], skipped: {}, truncated: false, syncthing: [] };
    else if (server.status !== 200) return { error: server.body.error, message: 'The remote could not list ' + (folder || 'its workspace') + ' (' + server.body.error + ').' };
    const record = await readRecord(userData, host);
    // Nothing recorded under this folder yet: a first send for it.
    const entries = Object.entries(record ?? {}).filter(([name]) => !folder || name.startsWith(folder + '/'));
    return { plan: plan(laptop.body, server.body, entries.length ? Object.fromEntries(entries) : null, folder) };
  } finally { await link.tunnel.close().catch(() => {}); }
}

// Carries one file's pieces from one daemon to the other. A 409 with a size is the target saying how much it has.
async function copy(from, to, id, file, counted, signal) {
  for (let offset = 0; offset < file.size;) {
    if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
    const piece = await from('GET', '/xfer/file?path=' + encodeURIComponent(file.path) + '&offset=' + offset);
    if (piece.status !== 200 || !piece.body.bytes) throw Object.assign(new Error('read'), { file: file.path, code: piece.body.error ?? 'changed' });
    const sent = await to('POST', '/xfer/' + id + '/part', { path: file.path, offset, data: piece.body.data });
    if (sent.status === 200) { counted(sent.body.size - offset); offset = sent.body.size; }
    else if (sent.status === 409 && sent.body.error === 'offset' && sent.body.size !== offset) offset = sent.body.size;
    else throw Object.assign(new Error('refused'), { file: file.path, code: sent.body.error });
  }
}

// Sends the files one way and commits them in batches. Returns what landed and what changed meanwhile.
async function oneWay(from, to, files, deletes, onBytes, signal) {
  const id = randomUUID(), landed = { written: [], removed: [], changed: [], replaced: [] };
  try {
    for (let round = 0; ; round++) {
      for (const f of files) await copy(from, to, id, f.source, onBytes, signal);
      const mismatch = [];
      for (let i = 0; i < Math.max(files.length, deletes.length); i += BATCH) {
        const body = { files: files.slice(i, i + BATCH).map((f) => ({ path: f.source.path, size: f.source.size, sha256: f.source.sha256, expect: f.expect })),
          deletes: deletes.slice(i, i + BATCH) };
        if (!body.files.length && !body.deletes.length) continue;
        const done = await to('POST', '/xfer/' + id + '/commit', body);
        if (done.status === 409 && done.body.error === 'upload-mismatch') { mismatch.push(...done.body.files); continue; }
        if (done.status !== 200 && done.body.error !== 'changed') throw Object.assign(new Error('commit'), { code: done.body.error });
        landed.written.push(...done.body.written); landed.removed.push(...done.body.removed.map((r) => r.path));
        landed.replaced.push(...done.body.replaced, ...done.body.removed.filter((r) => r.recovery));
        if (done.body.error === 'changed') landed.changed.push(...done.body.files);
      }
      // A piece went wrong on the way: those files once more, then stop (spec: one resend).
      if (!mismatch.length) return landed;
      if (round) throw Object.assign(new Error('mismatch'), { code: 'upload-mismatch' });
      files = files.filter((f) => mismatch.includes(f.source.path));
      deletes = [];
    }
  } finally { await to('POST', '/xfer/' + id + '/abort', {}).catch(() => {}); }
}

// Runs a resolved plan. onProgress({ total, sent }) as bytes are acknowledged by the receiving daemon. signal: a move's Cancel,
// checked before each piece; what was committed already stays.
export async function runPlan({ local, host, userData, plan: p, work, ssh = 'ssh', runtime = process.env.XDG_RUNTIME_DIR || os.tmpdir(), onProgress = () => {}, signal }) {
  const total = [...work.toServer.map((i) => i.laptop.size), ...work.toLaptop.map((i) => i.server.size)].reduce((a, b) => a + b, 0);
  let sent = 0;
  const counted = (bytes) => { sent += bytes; onProgress({ total, sent }); };
  onProgress({ total, sent });
  let link;
  try { link = await open({ local, host, ssh, runtime }); }
  catch (error) { return { error: 'unreachable', message: 'Could not reach the remote (' + error.message + '). Nothing was sent.' }; }
  const record = { ...(await readRecord(userData, host) ?? {}) };
  const result = { sent: [], received: [], deletedOnServer: [], deletedHere: [], recovery: { server: [], laptop: [] }, changed: [] };
  try {
    for (const { path: name, sha256 } of p.same) record[name] = sha256;
    for (const item of work.forget) delete record[item.path];
    const up = await oneWay(link.laptopCall, link.serverCall, work.toServer.map((i) => ({ source: i.laptop, expect: i.server?.sha256 ?? null })),
      work.serverDeletes.map((i) => ({ path: i.path, expect: i.server.sha256 })), counted, signal);
    for (const name of up.written) record[name] = work.toServer.find((i) => i.path === name).laptop.sha256;
    for (const name of up.removed) delete record[name];
    Object.assign(result, { sent: up.written, deletedOnServer: up.removed, changed: up.changed });
    result.recovery.server = up.replaced;
    const down = await oneWay(link.serverCall, link.laptopCall, work.toLaptop.map((i) => ({ source: i.server, expect: i.laptop?.sha256 ?? null })),
      work.laptopDeletes.map((i) => ({ path: i.path, expect: i.laptop.sha256 })), counted, signal);
    for (const name of down.written) record[name] = work.toLaptop.find((i) => i.path === name).server.sha256;
    for (const name of down.removed) delete record[name];
    Object.assign(result, { received: down.written, deletedHere: down.removed, changed: [...result.changed, ...down.changed] });
    result.recovery.laptop = down.replaced;
    return result.changed.length ? { ...result, error: 'changed', message: result.changed.length + ' file(s) changed while sending; nothing was written over them. Send again to see them.' } : result;
  } catch (error) {
    return { ...result, error: error.code ?? 'lost', message: error.file ? error.file + ': ' + (error.code ?? error.message) + '. The rest was not sent; send again.'
      : 'The send stopped (' + (error.code ?? error.message) + '). Files already written are kept; send again to finish.' };
  } finally {
    await writeRecord(userData, host, record).catch(() => {});
    await link.tunnel.close().catch(() => {});
  }
}
