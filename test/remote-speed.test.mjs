// O247-O251 (measure first): the desktop window on a remote, over a slow link. A remote's window reaches the daemon through an
// ssh forward of its socket (apps/desktop/remote.mjs); here a proxy socket stands in for that forward and delays every
// connect and every chunk by half a round trip each way, and the window's state folder holds only desktop.json with the
// socket path pointed at the proxy (the same rewrite remote.mjs does). The proxy logs each request, so the log shows what
// the window waits on before its chats show.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, http, authenticated, root, remoteDaemon } from './helpers.mjs';
import { phone } from './phone-c16-helpers.mjs';
import { randomUUID } from 'node:crypto';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const RTT = Number(process.env.P9_TEST_RTT || 300); // ms: a phone hotspot or a relayed tailnet link
const BPS = 250_000; // 2 Mbit/s
const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-p9-op': randomUUID() }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => ({ status: r.status, ...JSON.parse(r.text) }));
const until = async (check, what, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (await check()) return;
  throw new Error('timed out: ' + what);
};
// The chat's newest event is a turn's end (any turn-end in the first page would match the turn before).
const ended = (instance, id) => until(async () => (await call(instance, '/chat/events?after=0&tail=1&only=' + id)).events.at(-1)?.type === 'turn-end', id + ' answered');

// A socket that forwards to `to` with `rtt` ms of round trip: half before each chunk each way, in order, and one round trip to connect.
async function slowLink(to, at, rtt, t) {
  const log = [], t0 = Date.now(), half = rtt / 2;
  // Each direction is a queue: a chunk waits while the link is held (a sleeping machine), then half a round trip, then its
  // size at BPS (bytes a second), so a page of events costs what it would over the link.
  const gate = { held: null, release: null };
  const later = (sock) => { let tail = Promise.resolve(); return (chunk, sent) => { tail = tail.then(() => gate.held).then(() => new Promise((r) => setTimeout(r, half + (chunk?.length ?? 0) * 1000 / BPS))).then(() => { sent?.(); return sock.destroyed || (chunk === null ? sock.destroy() : sock.write(chunk)); }); }; };
  const server = net.createServer((client) => {
    client.pause();
    setTimeout(() => {
      const up = net.connect(to); const toUp = later(up), toClient = later(client);
      let entry = null;
      client.on('data', (c) => {
        const line = /^([A-Z]+) (\S+) HTTP/.exec(c.toString('latin1', 0, 300));
        if (line) log.push(entry = { req: line[1] + ' ' + line[2].replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id').slice(0, 70), at: Date.now() - t0, bytes: 0, done: null });
        toUp(c);
      });
      up.on('data', (c) => { if (entry) { entry.bytes += c.length; const e2 = entry; e2.n = (e2.n || 0) + 1; } const e2c = entry; toClient(c, () => { if (e2c) e2c.done = Date.now() - t0; }); });
      const end = () => { client.destroy(); up.destroy(); };
      client.on('error', end); up.on('error', end); // A close goes through the same queue, after the data sent before it, as over a real link.
      client.on('close', () => toUp(null)); up.on('close', () => toClient(null));
      client.resume();
    }, rtt);
  });
  await new Promise((r) => server.listen(at, r));
  t.after(() => server.close());
  return { log, t0, hold: () => { gate.held = new Promise((r) => { gate.release = r; }); }, release: () => { gate.release?.(); gate.held = null; } };
}

test('remote speed: the window over a slow link, how long until the chats show, and what it waits on', { timeout: 300000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  for (let i = 0; i < 12; i += 1) {
    const id = (await call(instance, '/chat', 'POST', { provider: 'claude', title: 'Chat ' + i })).conversation;
    await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'hello ' + i }); await ended(instance, id);
  }
  const slow = await mkdtemp(path.join(os.tmpdir(), 'p9-remote-'));
  const sock = path.join(slow, 'daemon.sock');
  const creds = JSON.parse(await readFile(path.join(instance.state, 'desktop.json'), 'utf8'));
  await writeFile(path.join(slow, 'desktop.json'), JSON.stringify({ ...creds, socketPath: sock }), { mode: 0o600 });
  const link = await slowLink(path.join(instance.state, 'daemon.sock'), sock, RTT, t);

  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const start = Date.now() - link.t0;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', slow, '--user-data-dir=' + path.join(slow, 'profile')], env, chromiumSandbox: true, timeout: 60000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((r) => setTimeout(r, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1400, height: 900 }).catch(() => {});
  await page.locator('#navList .row[data-chat]').nth(11).waitFor({ timeout: 120000 });
  const shown = Date.now() - link.t0;
  await page.locator('#dataNote', { hasText: 'Chat live' }).waitFor({ timeout: 120000 });
  const live = Date.now() - link.t0;
  await new Promise((r) => setTimeout(r, 3000));
  console.log(`REMOTE rtt ${RTT} ms: launch at ${start}, 12 chats shown at ${shown} (+${shown - start} ms), Chat live at ${live} (+${live - start} ms)`);
  console.log(`REMOTE requests before the chats showed: ${link.log.filter((e) => e.at < shown).length}; in the 3 s after Chat live: ${link.log.filter((e) => e.at > live).length}`);
  for (const e of link.log) console.log(`REMOTE ${String(e.at - start).padStart(6)} -> ${String(e.done == null ? 'open' : e.done - start).padStart(6)} ms ${String(e.bytes).padStart(8)} B ${e.n ?? 0} chunks  ${e.req}`);
  assert.deepEqual(errors, []);
});

// O249: a remote with a busy chat (MBs of screenshots and repeated slash-command lists) drew empty boxes for ~45 s, because
// launch replayed every open chat before it drew the list. The list should draw in a few round trips, whatever a chat holds.
test('O249 a busy chat does not hold the chat list back over a slow link', { timeout: 300000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  // The busy chat first, so the two newest (the ones shown at launch) are small: the list must not wait on any chat's events.
  const heavy = (await call(instance, '/chat', 'POST', { provider: 'claude', title: 'Busy' })).conversation;
  await call(instance, `/chat/${heavy}/prompt`, 'POST', { text: 'heavy 8' }); await ended(instance, heavy);
  // Only the newest slash-command list comes in a chat's tail (ledger.tail): eight came before, 0.5 MB of nothing.
  const tail = await call(instance, '/chat/events?after=0&tail=200&only=' + heavy);
  const lists = tail.events.filter((e) => e.data?.sessionUpdate === 'available_commands_update');
  assert.equal(lists.length, 1, 'one slash-command list in the tail');
  assert.equal(lists[0].data.availableCommands?.length, 300, 'the list kept is the real one, not the tool whose output names its kind');
  assert.ok(tail.events.some((e) => e.data?.toolCallId === 'heavy-decoy'), 'the tool call naming the kind stays');
  let id;
  for (let i = 0; i < 11; i += 1) {
    id = (await call(instance, '/chat', 'POST', { provider: 'claude', title: 'Chat ' + i })).conversation;
    await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'hello ' + i }); await ended(instance, id);
  }
  const slow = await mkdtemp(path.join(os.tmpdir(), 'p9-remote-'));
  const sock = path.join(slow, 'daemon.sock');
  const creds = JSON.parse(await readFile(path.join(instance.state, 'desktop.json'), 'utf8'));
  await writeFile(path.join(slow, 'desktop.json'), JSON.stringify({ ...creds, socketPath: sock }), { mode: 0o600 });
  const link = await slowLink(path.join(instance.state, 'daemon.sock'), sock, RTT, t);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const start = Date.now(); // not from Chat live: before the fix that came only when the whole replay had arrived
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', slow, '--user-data-dir=' + path.join(slow, 'profile')], env, chromiumSandbox: true, timeout: 60000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((r) => setTimeout(r, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1400, height: 900 }).catch(() => {});
  await page.locator('#navList .row[data-chat]').nth(11).waitFor({ timeout: 120000 });
  await page.locator('#chats').getByText('echo:hello 10', { exact: false }).first().waitFor({ timeout: 120000 });
  const drawn = Date.now() - start;
  console.log(`O249 rtt ${RTT} ms, ${BPS * 8 / 1e6} Mbit/s: 12 chats listed and the shown chat drawn ${drawn} ms after launch`);
  for (const e of link.log) console.log(`O249 ${String(e.at).padStart(6)} -> ${String(e.done == null ? 'open' : e.done).padStart(6)} ms ${String(e.bytes).padStart(8)} B  ${e.req}`);
  // The busy chat's ~3.5 MB alone is 14 s at 2 Mbit/s; the list and the shown chat are a few small reads after the window starts.
  assert.ok(drawn < 10000, `the list and the shown chat drew ${drawn} ms after launch; a busy chat's events must not come first`);
  // Review round 1: the busy chat is still loading after the list (late(), ~13 s of history at 2 Mbit/s). An event from it
  // meanwhile waits for that load on its own; the shown chat's reply does not wait behind it.
  await call(instance, `/chat/${heavy}/prompt`, 'POST', { text: 'hello busy' });
  await new Promise((r) => setTimeout(r, 500));
  const asked = Date.now();
  await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'hello again' });
  await page.locator('#chats').getByText('echo:hello again', { exact: false }).first().waitFor({ timeout: 120000 });
  const replied = Date.now() - asked;
  console.log(`O249 the shown chat's reply drew ${replied} ms after its prompt, while the busy chat loaded`);
  assert.ok(replied < 6000, `the shown chat's reply drew ${replied} ms after its prompt; it waited behind the busy chat's history`);
  // Self-review: an ask that comes in while the busy chat still loads shows its notice; before, every notice waited for all
  // the background loads (late()), about 13 s more here.
  const askAt = Date.now();
  await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'ask' });
  await page.locator('#toasts .toast', { hasText: 'needs you' }).first().waitFor({ timeout: 8000 });
  console.log(`O249 an ask's notice showed ${Date.now() - askAt} ms after it came, while the busy chat loaded`);
  // It still loads, after: opened, its history and the reply that came while it loaded both show (behind() kept it).
  await page.locator(`#navList .row[data-chat="${heavy}"]`).click();
  await page.locator('#chats').getByText('heavy done', { exact: false }).first().waitFor({ timeout: 120000 });
  await page.locator('#chats').getByText('echo:hello busy', { exact: false }).first().waitFor({ timeout: 30000 });
  assert.deepEqual(errors, []);
});

// O251: back after time away. The window was open, its machine slept (the link held), one chat worked meanwhile; on wake the
// window should draw that chat's current state in one step, not page through every update the chat streamed meanwhile.
test('O251 back after time away: the window draws the current state in one step, not every update since', { timeout: 300000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const id = (await call(instance, '/chat', 'POST', { provider: 'claude', title: 'Worker' })).conversation;
  await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'hello' }); await ended(instance, id);
  const slow = await mkdtemp(path.join(os.tmpdir(), 'p9-remote-'));
  const sock = path.join(slow, 'daemon.sock');
  const creds = JSON.parse(await readFile(path.join(instance.state, 'desktop.json'), 'utf8'));
  await writeFile(path.join(slow, 'desktop.json'), JSON.stringify({ ...creds, socketPath: sock }), { mode: 0o600 });
  const link = await slowLink(path.join(instance.state, 'daemon.sock'), sock, RTT, t);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', slow, '--user-data-dir=' + path.join(slow, 'profile')], env, chromiumSandbox: true, timeout: 60000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((r) => setTimeout(r, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const said = []; page.on('console', (m) => said.push(`${Date.now() - link.t0} ${m.type()} ${m.text().slice(0, 200)}`));
  await page.setViewportSize({ width: 1400, height: 900 }).catch(() => {});
  await page.locator('#dataNote', { hasText: 'Chat live' }).waitFor({ timeout: 120000 });
  await page.locator(`#navList .row[data-chat="${id}"]`).click();
  await page.locator('#chatPane, .stage').getByText('hello', { exact: false }).first().waitFor({ timeout: 30000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2000));
  link.hold();
  const N = 1500;
  await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'stream ' + N }); await ended(instance, id);
  // A chat made while away: its created event is in the skipped gap, so its row comes from the list.
  assert.equal((await call(instance, '/chat', 'POST', { provider: 'claude', title: 'Made away' })).status < 300, true);
  const gap = (await call(instance, '/chat/events?after=0&only=&tail=1')).cursor; // a tail of no chats answers with the newest cursor
  const mark = link.log.length, woke = Date.now() - link.t0;
  link.release();
  const t1 = Date.now();
  const drawn = await page.locator(`text=step ${N} done. >> visible=true`).first().waitFor({ timeout: 60000 }).then(() => true, () => false);
  if (!drawn) {
    console.log('P9_SHOT o251-stuck ' + (await page.screenshot()).toString('base64'));
    for (const x of [...said, ...errors]) console.log('O251 page ' + x);
    for (const e of link.log.slice(mark)) console.log(`O251 ${String(e.at - woke).padStart(6)} ms -> ${String(e.done === null ? "never" : e.done - woke).padStart(6)} ${String(e.bytes).padStart(8)} B  ${e.req}`);
  }
  assert.ok(drawn, 'the chat shows its current state after wake');
  await page.locator('#navList .row', { hasText: 'Made away' }).first().waitFor({ timeout: 15000 });
  const took = Date.now() - t1;
  const after = link.log.slice(mark), pages = after.filter((e) => /^GET \/chat\/events/.test(e.req));
  console.log(`O251 rtt ${RTT} ms, ${BPS * 8 / 1e6} Mbit/s: ${3 * N} updates streamed while away (ledger cursor ${gap}); current state drawn ${took} ms after wake; ${after.length} requests, ${pages.length} event reads, ${after.reduce((a, e) => a + e.bytes, 0)} bytes`);
  for (const e of after.slice(0, 30)) console.log(`O251 ${String(e.at - woke).padStart(6)} -> ${String(e.done == null ? 'open' : e.done - woke).padStart(6)} ms ${String(e.bytes).padStart(8)} B  ${e.req}`);
  assert.ok(pages.length <= 4, `the window read the gap in ${pages.length} event reads; one step is at most 4 (the wake's read, the newest cursor, the shown chat's tail, the next wait)`);
  assert.deepEqual(errors, []);
});

// O251 on the phone: the same gap, every events read held while the phone sleeps. It reads the shown chat's newest blocks,
// not every page since.
test('O251 phone back after time away: the phone draws the current state in one step, not every update since', { timeout: 300000 }, async (t) => {
  const server = await remoteDaemon(t, { args: ['--acp-override', fake] });
  const { page } = await phone(t, server);
  const id = (await server.desk('/chat', 'POST', { provider: 'claude', title: 'Worker' })).body.conversation;
  const last = async () => (await server.desk('/chat/events?after=0&tail=1&only=' + id)).body.events.at(-1)?.type;
  const done = () => until(async () => (await last()) === 'turn-end', id + ' answered');
  assert.equal((await server.desk('/chat/' + id + '/prompt', 'POST', { text: 'hello' })).status, 202); await done();
  await page.goto(server.origin + '/phone/#chat=' + id);
  await page.locator('text=echo:hello >> visible=true').first().waitFor({ timeout: 30000 }); // the list's preview has it too, hidden
  await new Promise((r) => setTimeout(r, 2000));
  let release; const held = new Promise((r) => { release = r; });
  const events = (url) => new URL(url).pathname.endsWith('/chat/events');
  await page.route(events, async (route) => { await held; await route.continue().catch(() => {}); });
  const N = 1500;
  assert.equal((await server.desk('/chat/' + id + '/prompt', 'POST', { text: 'stream ' + N })).status, 202); await done();
  const reads = []; page.on('response', async (r) => { if (events(r.url())) reads.push({ url: r.url().replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id').slice(-90), bytes: (await r.body().catch(() => Buffer.alloc(0))).length }); });
  const t1 = Date.now(); release();
  const drawn = await page.locator(`text=step ${N} done. >> visible=true`).first().waitFor({ timeout: 60000 }).then(() => true, () => false);
  const ms = Date.now() - t1; await new Promise((r) => setTimeout(r, 1000));
  console.log(`O251 phone: current state drawn ${drawn ? ms + ' ms' : 'never'} after wake; ${reads.length} event reads, ${reads.reduce((a, r) => a + r.bytes, 0)} bytes`);
  for (const r of reads) console.log(`O251 phone ${String(r.bytes).padStart(8)} B  ${r.url}`);
  assert.ok(drawn, 'the chat shows its current state after wake');
  assert.ok(reads.length <= 4, `the phone read the gap in ${reads.length} event reads; one step is at most 4 (the wake's read, the shown chat's tail, the gap check, the next wait)`);
});
