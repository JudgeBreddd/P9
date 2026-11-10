// O35: deleting a chat removes what it left behind. Its memory records (memory.db) and telemetry rows (telemetry.db, and
// its turns' resource rows in telemetry-samples.db) go, and a sent photo goes when no other chat's ledger names it. What it
// already spent stays counted in the usage totals, the same before and after a restart. The real daemon and the fake agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { daemon, restart, http, authenticated, root } from './helpers.mjs';
import { MEMORY_CONVERSATION as MEM } from '../apps/server/memory.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-p9-op': randomUUID() }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => ({ ...r, body: /json/.test(r.headers['content-type'] ?? '') ? JSON.parse(r.text) : r.text }));
const until = async (check, what, ms = 20000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 200))) if (await check()) return;
  throw new Error('timed out: ' + what);
};
// One read of a daemon's database, opened read-only and closed again. A file not there yet, or made but without
// its table yet ("no such table", CI 2026-11-10 on PR 59), reads as no rows; any other error still throws.
const rows = (file, sql, ...args) => {
  if (!existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare(sql).all(...args); } catch (e) { if (/no such table/.test(e.message)) return []; throw e; } finally { db.close(); }
};
async function turn(instance, id, text, images) {
  assert.equal((await call(instance, `/chat/${id}/prompt`, 'POST', { text, ...(images && { images }) })).status, 202);
  await until(async () => {
    const events = (await call(instance, `/chat/events?after=0&only=${id}`)).body.events ?? [];
    const at = events.findLastIndex((e) => e.type === 'user' && e.data.text === text);
    return at >= 0 && events.slice(at).some((e) => e.type === 'turn-end');
  }, 'a turn end for ' + text);
}
const photo = (text) => ({ mimeType: 'image/png', data: Buffer.from(text).toString('base64') });
const hashOf = (image) => createHash('sha256').update(Buffer.from(image.data, 'base64')).digest('hex');

test('deleting a chat removes its memory, its telemetry and a photo no other chat uses; what it spent stays counted after a restart', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const own = path.join(instance.directory, '.local', 'state', 'p9-foundation');
  const ledgerFile = path.join(own, 'p9.db'), memoryFile = path.join(own, 'memory.db');
  const telemetryFile = path.join(own, 'telemetry.db'), samplesFile = path.join(own, 'telemetry-samples.db'), images = path.join(own, 'images');
  // Capture is off by default, and then there is no memory.db: the switch event turns it on, as memory.test.mjs does.
  const ledger = new DatabaseSync(ledgerFile);
  ledger.exec('PRAGMA busy_timeout = 5000');
  ledger.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)').run(MEM, 'memory', JSON.stringify({ action: 'switch', on: true }), Date.now());
  ledger.close();

  const shared = photo('a photo both chats sent'), own1 = photo('a photo only A sent'), own2 = photo('a photo only B sent');
  const A = (await call(instance, '/chat', 'POST', { provider: 'claude' })).body.conversation;
  const B = (await call(instance, '/chat', 'POST', { provider: 'codex' })).body.conversation;
  await turn(instance, A, 'spend 1', [shared, own1]);
  await turn(instance, B, 'spend 2', [shared, own2]);
  const of = (file, table, id) => rows(file, `SELECT * FROM ${table} WHERE conversation = ?`, id);
  await until(() => of(telemetryFile, 'turns', A).length && of(telemetryFile, 'turns', B).length, 'telemetry rows for both chats');
  await until(() => of(memoryFile, 'records', A).length && of(memoryFile, 'records', B).length, 'memory records for both chats');
  const keysA = of(telemetryFile, 'turns', A).map((r) => r.key);
  await until(() => rows(samplesFile, 'SELECT turn_key FROM resources').length >= 2, 'resource rows for both turns');
  const resources = () => rows(samplesFile, 'SELECT turn_key FROM resources').map((r) => r.turn_key);
  assert.ok(keysA.every((key) => resources().includes(key)), 'A has resource rows before the delete');
  const files = () => ['own1', 'own2', 'shared'].filter((name) => existsSync(path.join(images, hashOf({ own1, own2, shared }[name]) + '.png')));
  assert.deepEqual(files(), ['own1', 'own2', 'shared'], 'all three photos are kept before the delete');
  const usage = async (instance) => { const { totals, contexts } = (await call(instance, '/usage')).body; return { totals, chats: contexts.map((c) => c.conversation).sort() }; };
  const spent = { inputTokens: 3000, outputTokens: 300, cachedTokens: 30, costUsd: 3 };
  assert.deepEqual(await usage(instance), { totals: spent, chats: [A, B].sort() }, 'both chats counted before the delete');

  assert.equal((await call(instance, `/chat/${A}/delete`, 'POST', {})).status, 200);
  // 1. memory.db and telemetry.db: A's rows go, B's stay.
  await until(() => !of(telemetryFile, 'turns', A).length, "A's telemetry rows removed");
  await until(() => !of(memoryFile, 'records', A).length, "A's memory records removed");
  for (const table of ['items', 'dropped', 'stale']) assert.deepEqual(of(memoryFile, table, A), [], 'no ' + table + ' rows for A');
  assert.deepEqual(rows(memoryFile, 'SELECT key FROM shared WHERE key IN (SELECT value FROM json_each(?))', JSON.stringify(keysA)), [], 'nor shared rows of its turns');
  assert.equal(of(telemetryFile, 'turns', B).length, 1, "B's telemetry row stays");
  assert.equal(of(memoryFile, 'records', B).length, 1, "B's memory record stays");
  await until(() => !keysA.some((key) => resources().includes(key)), "A's resource rows removed");
  // 2. Photos: the one only A sent goes; the one B also sent stays, and B's own.
  assert.deepEqual(files(), ['own2', 'shared'], 'the photo no other chat names is removed');
  // 3. Usage: what A spent stays in the totals; its context meter goes with it.
  assert.deepEqual(await usage(instance), { totals: spent, chats: [B] }, 'spent stays counted after the delete');

  instance.child.kill('SIGTERM');
  await once(instance.child, 'exit');
  const second = await restart(t, instance, 'state-2');
  assert.deepEqual(await usage(second), { totals: spent, chats: [B] }, 'and the same after a restart');
  // The workers replay the ledger at start; one more turn of B shows they are past the replay, and A did not come back.
  await turn(second, B, 'after the restart');
  await until(() => of(telemetryFile, 'turns', B).length === 2 && of(memoryFile, 'records', B).length === 2, "B's new turn recorded");
  assert.deepEqual([of(telemetryFile, 'turns', A), of(memoryFile, 'records', A)], [[], []], 'A stays gone after the replay');
  assert.deepEqual(files(), ['own2', 'shared']);
  console.log('PASS O35: delete removed A\'s telemetry, resources and memory rows and its own photo; shared photo, B\'s rows and $3 / 3000 tokens kept, also after a restart');
});

// O29 (threat model row O29): the Agent pill's switch deletes the old chat with empty: true, and the daemon refuses it when
// that chat was ever sent to. A plain delete is unchanged.
test('O29: delete with empty keeps a chat that was sent to, removes one that was not, and a plain delete is unchanged', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const listed = async () => (await call(instance, '/chat')).body.conversations.map((c) => c.id);
  const A = (await call(instance, '/chat', 'POST', { provider: 'claude' })).body.conversation;
  const B = (await call(instance, '/chat', 'POST', { provider: 'codex' })).body.conversation;
  await turn(instance, A, 'a message, so A is not empty');
  const refused = await call(instance, `/chat/${A}/delete`, 'POST', { empty: true });
  assert.deepEqual([refused.status, refused.body.error], [409, 'not-empty'], 'a chat with a sent message is refused');
  assert.ok((await listed()).includes(A), 'and stays listed');
  assert.ok((await call(instance, `/chat/events?after=0&only=${A}`)).body.events.some((e) => e.type === 'user'), 'with its events');
  for (const body of [{ empty: 'yes' }, { empty: false }, { empty: true, also: 1 }]) {
    const r = await call(instance, `/chat/${A}/delete`, 'POST', body);
    assert.deepEqual([r.status, r.body.error], [400, 'request-refused'], JSON.stringify(body) + ' is refused');
  }
  assert.equal((await call(instance, `/chat/${B}/delete`, 'POST', { empty: true })).status, 200, 'a chat never sent to goes');
  assert.ok(!(await listed()).includes(B));
  assert.equal((await call(instance, `/chat/${A}/delete`, 'POST', {})).status, 200, 'a plain delete still removes a chat with messages');
  assert.ok(!(await listed()).includes(A));
  console.log('PASS O29: empty delete refused 409 for a sent chat, 400 for a bad body, 200 for an empty one; plain delete unchanged');
});

test('a database made before its table reads as no rows until the table is there; other errors still throw', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'chat-delete-')), 'telemetry.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA user_version = 1'); // the file exists and has no tables, as the daemon leaves it for a moment
  setTimeout(() => db.exec("CREATE TABLE turns (conversation TEXT); INSERT INTO turns VALUES ('A')"), 600);
  await until(() => rows(file, 'SELECT * FROM turns WHERE conversation = ?', 'A').length, 'the row once the table exists', 5000);
  assert.throws(() => rows(file, 'SELECT * FROM turns WHERE nope = 1'), /no such column/);
  db.close();
});
