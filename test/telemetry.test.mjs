// The watcher (telemetry.mjs; _research/p9-learning-layer/plan.md phase 2): one row per turn in telemetry.db, derived
// from ledger events by one function live and on replay, written off the chat path. Fixture ledgers are written by hand
// below, with fixed times, and the expected rows were worked out by hand before the first run.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openLedger } from '../apps/server/ledger.mjs';
import { createChat } from '../apps/server/chat.mjs';
import { createLifecycle } from '../apps/server/lifecycle.mjs';
import { startTelemetry, COLUMNS, DERIVER } from '../apps/server/telemetry.mjs';
import { daemon, restart, http, authenticated, root } from './helpers.mjs';

const T = 1767000000000; // fixture clock
const A = 'aaaaaaaa-0000-4000-8000-000000000001', B = 'bbbbbbbb-0000-4000-8000-000000000002', D = 'dddddddd-0000-4000-8000-000000000004';
const E = 'eeeeeeee-0000-4000-8000-000000000005', F = 'ffffffff-0000-4000-8000-000000000006';
const FAKE_KEY = 'sk-ant-api03-FAKEKEY0123456789abcdefFAKEKEY';
const say = (text) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const think = (text) => ({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } });
const tool = (toolCallId, kind, status) => ({ sessionUpdate: 'tool_call', toolCallId, title: 'Read /ho' + 'me/x/proj/secret.txt', kind, status });
const toolDone = (toolCallId, status) => ({ sessionUpdate: 'tool_call_update', toolCallId, status, content: [{ type: 'content', content: { type: 'text', text: 'file body ' + FAKE_KEY } }] });

// The [metric] fixture: three turns. Cursors are 1.. in this order on a fresh ledger.
const METRIC = [
  [A, 'created', { provider: 'claude', title: 'Claude', folder: '' }, T], // 1
  [A, 'user', { text: 'Fix the build. My key is ' + FAKE_KEY + ' in /ho' + 'me/x/proj/.env' }, T + 1000], // 2: turn A1 opens
  [A, 'config', { model: { current: 'opus', options: [{ value: 'opus' }] }, pickers: [] }, T + 1200], // 3: model set inside the turn
  [A, 'update', think('thinking about ' + FAKE_KEY), T + 1500], // 4: first output, 500 ms in
  [A, 'update', tool('t1', 'read', 'pending'), T + 2000], // 5
  [A, 'update', toolDone('t1', 'completed'), T + 2600], // 6: t1 600 ms
  [A, 'update', tool('t2', 'edit', 'pending'), T + 3000], // 7
  [A, 'approval', { request: 'r1', toolCall: { title: 'Write /ho' + 'me/x/proj/a.txt' }, options: [] }, T + 3100], // 8
  [A, 'answered', { request: 'r1', answer: { outcome: { outcome: 'selected', optionId: 'allow' } } }, T + 5100], // 9: wait 2000 ms
  [A, 'update', toolDone('t2', 'failed'), T + 5400], // 10: t2 2400 ms
  [A, 'update', say('Done. ' + FAKE_KEY), T + 6000], // 11
  [A, 'turn-end', { stopReason: 'end_turn', usage: { inputTokens: 2, outputTokens: 446, cachedReadTokens: 11946, cachedWriteTokens: 30545, totalTokens: 42939 } }, T + 9000], // 12
  [B, 'created', { provider: 'codex', title: 'Codex', folder: '/ho' + 'me/x/proj' }, T + 10000], // 13
  [B, 'config', { model: { current: 'gpt-6.1-sol', options: [] }, pickers: [] }, T + 10500], // 14: before the turn: carried
  [B, 'user', { text: 'Run the tests' }, T + 11000], // 15: turn B1 opens
  [B, 'update', say('On it'), T + 11800], // 16: first output 800 ms in
  [B, 'update', tool('t3', 'execute', 'completed'), T + 12000], // 17: done as it starts: 0 ms
  [B, 'update', tool('t4', 'search', 'in_progress'), T + 12500], // 18
  [B, 'update', toolDone('t4', 'completed'), T + 13500], // 19: t4 1000 ms
  [B, 'turn-end', { stopReason: 'end_turn', usage: { totalTokens: 24730, inputTokens: 12429, cachedReadTokens: 12288, outputTokens: 13, thoughtTokens: 512 } }, T + 15000], // 20
  [A, 'user', { text: 'Now deploy it' }, T + 20000], // 21: turn A2 opens
  [A, 'update', tool('t5', 'execute', 'pending'), T + 20400], // 22: first output 400 ms in; never completes
  [A, 'question', { request: 'q1', form: {} }, T + 20500], // 23: never answered
  [A, 'error', { message: 'Internal error: could not read /ho' + 'me/x/proj/.env ' + FAKE_KEY }, T + 23000], // 24: failed, no turn-end
];
const NONE = { tools_read: 0, tools_edit: 0, tools_delete: 0, tools_move: 0, tools_search: 0, tools_execute: 0, tools_think: 0,
  tools_fetch: 0, tools_switch_mode: 0, tools_other: 0 };
// Worked by hand from METRIC. folder_id: sha256('') and sha256('/ho' + 'me/x/proj'), first 16 hex. cache_read_share:
// 11946 / (2 + 11946 + 30545) = 0.281129 and 12288 / (12429 + 12288) = 0.497148, to 6 places.
const EXPECTED = [
  { key: 2, conversation: A, end_cursor: 12, deriver: 1, outcome: 'finished', unprompted: 0, steers: 0, stop_reason: 'end_turn', error_code: null,
    provider: 'claude', model: 'opus', model_source: 'set', folder_id: 'e3b0c44298fc1c14', turn_number: 1, start_at: T + 1000, end_at: T + 9000,
    first_output_ms: 500, total_ms: 8000, tool_count: 2, tool_ms: 3000, approval_wait_ms: 2000, ...NONE, tools_read: 1, tools_edit: 1,
    usage: 1, input_tokens: 2, output_tokens: 446, cached_read_tokens: 11946, cached_write_tokens: 30545, thought_tokens: null, total_tokens: 42939,
    cache_read_share: 0.281129, layers: 'baseline', cpu_ms: null, mem_peak_bytes: null },
  { key: 15, conversation: B, end_cursor: 20, deriver: 1, outcome: 'finished', unprompted: 0, steers: 0, stop_reason: 'end_turn', error_code: null,
    provider: 'codex', model: 'gpt-6.1-sol', model_source: 'carried', folder_id: '0e837629b59802ef', turn_number: 1, start_at: T + 11000, end_at: T + 15000,
    first_output_ms: 800, total_ms: 4000, tool_count: 2, tool_ms: 1000, approval_wait_ms: 0, ...NONE, tools_execute: 1, tools_search: 1,
    usage: 1, input_tokens: 12429, output_tokens: 13, cached_read_tokens: 12288, cached_write_tokens: null, thought_tokens: 512, total_tokens: 24730,
    cache_read_share: 0.497148, layers: 'baseline', cpu_ms: null, mem_peak_bytes: null },
  // t5 is still open at the error: 23000 - 20400 = 2600 ms; q1 unanswered: 23000 - 20500 = 2500 ms.
  { key: 21, conversation: A, end_cursor: 24, deriver: 1, outcome: 'failed', unprompted: 0, steers: 0, stop_reason: null, error_code: 'agent-error',
    provider: 'claude', model: 'opus', model_source: 'carried', folder_id: 'e3b0c44298fc1c14', turn_number: 2, start_at: T + 20000, end_at: T + 23000,
    first_output_ms: 400, total_ms: 3000, tool_count: 1, tool_ms: 2600, approval_wait_ms: 2500, ...NONE, tools_execute: 1,
    usage: 0, input_tokens: null, output_tokens: null, cached_read_tokens: null, cached_write_tokens: null, thought_tokens: null, total_tokens: null,
    cache_read_share: null, layers: 'baseline', cpu_ms: null, mem_peak_bytes: null },
];
// Turn identity: a failed turn, a cut-off one (daemon restart), a steered one, Codex's startedNewTurn (a steer after the
// end, closed by an unprompted turn-end), a bare unprompted turn-end, and a prompt cut off by the next prompt.
const IDENTITY = [
  [D, 'created', { provider: 'claude', title: 'Claude', folder: '' }, T], // 1
  [D, 'user', { text: 'a' }, T + 100], [D, 'update', say('x'), T + 200], [D, 'error', { message: 'Internal error' }, T + 300], // 2-4: failed
  [D, 'user', { text: 'b' }, T + 1000], [D, 'update', say('x'), T + 1100], [D, 'interrupted', { reason: 'daemon-restart' }, T + 50000], // 5-7: cut off
  [D, 'user', { text: 'c' }, T + 60000], [D, 'update', say('x'), T + 60100], [D, 'user', { text: 'also', steered: true }, T + 60500], // 8-10
  [D, 'update', say('got:also'), T + 60800], // 11
  [D, 'turn-end', { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 20, cachedReadTokens: 300, cachedWriteTokens: 40, totalTokens: 370 } }, T + 61000], // 12
  [D, 'user', { text: 'd' }, T + 70000], [D, 'turn-end', { stopReason: 'end_turn' }, T + 71000], // 13-14
  [D, 'user', { text: 'late', steered: true }, T + 71500], [D, 'update', say('got:late'), T + 72000], // 15-16: startedNewTurn
  [D, 'turn-end', { stopReason: 'end_turn', unprompted: true }, T + 82000], // 17
  [D, 'turn-end', { stopReason: 'end_turn', unprompted: true }, T + 90000], // 18: no open turn
  [D, 'user', { text: 'e' }, T + 100000], [D, 'user', { text: 'f' }, T + 100500], [D, 'turn-end', { stopReason: 'end_turn' }, T + 101000], // 19-21
];
// Zero vs missing: zeros reported stay 0, no usage stays NULL, a value of the wrong type is NULL.
const ZERO = [
  [E, 'created', { provider: 'codex', title: 'Codex', folder: '' }, T],
  [E, 'user', { text: 'a' }, T + 10], [E, 'turn-end', { stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, thoughtTokens: 0, totalTokens: 0 } }, T + 20],
  [E, 'user', { text: 'b' }, T + 30], [E, 'turn-end', { stopReason: 'end_turn' }, T + 40],
  [E, 'user', { text: 'c' }, T + 50], [E, 'turn-end', { stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 'lots', totalTokens: -1 } }, T + 60],
];

async function scratch(t, name) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-telemetry-' + name + '-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, ledgerFile: path.join(dir, 'p9.db'), file: path.join(dir, 'telemetry.db') };
}
// Fixture events go straight into the ledger with their own times, as a long-used ledger holds them.
function write(ledger, events) {
  const insert = ledger.db.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)');
  for (const [conversation, type, data, at] of events) insert.run(conversation, type, JSON.stringify(data), at);
}
function rows(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare('SELECT * FROM turns ORDER BY key').all().map((row) => ({ ...row })); } finally { db.close(); }
}
async function replay(ledgerFile, file, options = {}) {
  const telemetry = startTelemetry({ ledgerFile, file, ...options });
  await telemetry.idle();
  const stats = telemetry.stats();
  await telemetry.close();
  return stats;
}
let chats = 0;
function chatOn(t, ledger, dir) {
  const chat = createChat({ ledger, workspace: dir, adapterOverride: path.join(import.meta.dirname, 'fake-acp-agent.mjs'),
    instance: 'tel-' + process.pid + '-' + (chats += 1), lifecycle: createLifecycle() });
  t.after(() => chat.shutdown());
  return chat;
}
// One prompt to its end, through the browser's long poll. Returns the turn's time in the ledger (user to end) and the
// wall time from the prompt to the browser seeing the end.
async function turn(chat, id, text, cursor) {
  const started = performance.now();
  assert.equal((await chat.prompt(id, { text })).status, 202);
  const seen = [];
  for (let i = 0; i < 200; i++) {
    const page = await chat.events(cursor, 1000);
    cursor = page.cursor;
    seen.push(...page.events);
    const end = seen.find((event) => event.conversation === id && ['turn-end', 'error'].includes(event.type));
    if (end) {
      const user = seen.find((event) => event.conversation === id && event.type === 'user');
      return { cursor, end, ms: end.at - user.at, wall: performance.now() - started };
    }
  }
  throw new Error('no turn end: ' + JSON.stringify(seen.slice(-3).map((event) => event.type)));
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

test('[metric] replay of the hand-written fixture gives exactly the hand-computed row for each turn', async (t) => {
  const { ledgerFile, file } = await scratch(t, 'metric');
  write(openLedger(ledgerFile), METRIC);
  const stats = await replay(ledgerFile, file);
  assert.equal(stats.rowsWritten, 3, JSON.stringify(stats));
  assert.deepEqual(rows(file), EXPECTED);
  console.log('PASS metric fixture: 3 rows equal the hand-computed rows (Claude cache write, Codex reasoning, failed with no turn-end)');
});

test('parity: the same events live (through emit, ledger.append) and by replay give identical rows, deriver included', async (t) => {
  const { dir, ledgerFile, file } = await scratch(t, 'parity');
  const ledger = openLedger(ledgerFile);
  const telemetry = startTelemetry({ ledgerFile, file });
  t.after(() => telemetry.close());
  ledger.tap = telemetry.push;
  for (const [conversation, type, data] of [...METRIC, ...IDENTITY]) ledger.append(conversation, type, data);
  const chat = chatOn(t, ledger, dir);
  const id = (await chat.create({ provider: 'claude' })).conversation;
  let { cursor } = await turn(chat, id, 'hello', 0);
  ({ cursor } = await turn(chat, id, 'stream 3', cursor));
  // An approval through the real emit path: answered while the turn waits.
  assert.equal((await chat.prompt(id, { text: 'permission' })).status, 202);
  let approval;
  for (let i = 0; i < 40 && !approval; i++) { const page = await chat.events(cursor, 1000); cursor = page.cursor; approval = page.events.find((event) => event.type === 'approval'); }
  assert.equal(chat.answer(id, { request: approval.data.request, answer: { optionId: 'allow' } }).status, 200);
  for (let i = 0; i < 40; i++) { const page = await chat.events(cursor, 1000); cursor = page.cursor; if (page.events.some((event) => event.type === 'turn-end' && event.conversation === id)) break; }
  await telemetry.idle();
  const live = rows(file);
  assert.equal(live.length, 3 + 8 + 3, 'rows written live: ' + live.length);
  await replay(ledgerFile, path.join(dir, 'replayed.db'));
  assert.deepEqual(rows(path.join(dir, 'replayed.db')), live);
  assert.ok(live.every((row) => row.deriver === DERIVER));
  const chatRows = live.filter((row) => row.conversation === id);
  assert.ok(chatRows[2].approval_wait_ms >= 0 && chatRows[1].tools_read === 3, JSON.stringify(chatRows));
  console.log('PASS parity: ' + live.length + ' rows live (fixture through ledger.append, 3 fake-agent turns through emit) equal the replay, deriver ' + DERIVER);
});

test('zero vs missing: no usage is NULL with the flag off, never 0; Codex NULL cache write, Claude NULL reasoning', async (t) => {
  const { ledgerFile, file } = await scratch(t, 'zero');
  write(openLedger(ledgerFile), [...METRIC, ...ZERO]);
  await replay(ledgerFile, file);
  const all = rows(file);
  const tokens = ['input_tokens', 'output_tokens', 'cached_read_tokens', 'cached_write_tokens', 'thought_tokens', 'total_tokens'];
  const pick = (row) => Object.fromEntries(['usage', ...tokens].map((column) => [column, row[column]]));
  const zero = all.filter((row) => row.conversation === E);
  assert.deepEqual(pick(zero[0]), { usage: 1, input_tokens: 0, output_tokens: 0, cached_read_tokens: 0, cached_write_tokens: null, thought_tokens: 0, total_tokens: 0 });
  assert.deepEqual(pick(zero[1]), { usage: 0, input_tokens: null, output_tokens: null, cached_read_tokens: null, cached_write_tokens: null, thought_tokens: null, total_tokens: null });
  assert.deepEqual(pick(zero[2]), { usage: 1, input_tokens: 5, output_tokens: null, cached_read_tokens: null, cached_write_tokens: null, thought_tokens: null, total_tokens: null });
  assert.equal(all.find((row) => row.key === 15).cached_write_tokens, null, 'Codex cache write');
  assert.equal(all.find((row) => row.key === 2).thought_tokens, null, 'Claude reasoning');
  assert.ok(all.filter((row) => row.usage === 0).every((row) => tokens.every((column) => row[column] === null)), 'a row without usage holds a 0');
  console.log('PASS zero vs missing: reported zeros 0, no usage NULL with usage=0, bad values NULL; Codex cache write and Claude reasoning NULL');
});

test('privacy: no turns column can hold free text, and a fixture prompt with a fake key never reaches telemetry.db', async (t) => {
  const { ledgerFile, file } = await scratch(t, 'privacy');
  write(openLedger(ledgerFile), [...METRIC, ...IDENTITY]);
  await replay(ledgerFile, file);
  const db = new DatabaseSync(file);
  const columns = db.prepare('PRAGMA table_info(turns)').all();
  assert.deepEqual(columns.filter((column) => column.type === 'TEXT').map((column) => column.name).sort(),
    ['conversation', 'error_code', 'folder_id', 'layers', 'model', 'model_source', 'outcome', 'provider', 'stop_reason']);
  const names = columns.map((column) => column.name);
  const valid = db.prepare('SELECT * FROM turns WHERE key = 2').get();
  const insert = (row) => db.prepare('INSERT INTO turns (' + names.join(', ') + ') VALUES (' + names.map(() => '?').join(', ') + ')').run(...names.map((name) => row[name]));
  insert({ ...valid, key: 900000 }); // the row as stored goes in: each refusal below is the free text's
  const free = ['Fix the build. My key is ' + FAKE_KEY, '/ho' + 'me/x/proj/.env', 'two words', 'opus; DROP TABLE turns'];
  for (const name of names) for (const text of free) {
    assert.throws(() => insert({ ...valid, key: 900001, [name]: text }), /CHECK constraint failed|cannot store TEXT value|datatype mismatch/, name + ' took ' + JSON.stringify(text));
  }
  db.exec('DELETE FROM turns WHERE key = 900000');
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (!existsSync(file + suffix)) continue;
    const bytes = await readFile(file + suffix);
    for (const secret of [FAKE_KEY, 'FAKEKEY', '/ho' + 'me/x/proj', 'Fix the build', 'Internal error', 'secret.txt']) assert.equal(bytes.includes(secret), false, secret + ' in telemetry.db' + suffix);
  }
  console.log('PASS privacy: TEXT columns are the allowlist; ' + names.length + ' columns x ' + free.length + ' free texts all refused; fake key, path and prompt absent from the file');
});

test('chat isolation: locked, read-only or corrupt telemetry.db never delays a turn; drops counted; a corrupt file is set aside and rebuilt', { timeout: 120000 }, async (t) => {
  const run = async (name, setup) => {
    const { dir, ledgerFile, file } = await scratch(t, 'iso-' + name);
    const ledger = openLedger(ledgerFile);
    write(ledger, METRIC); // 3 turns already in the ledger
    const extra = await setup?.({ dir, ledgerFile, file });
    const telemetry = extra?.off ? null : startTelemetry({ ledgerFile, file });
    if (telemetry) { t.after(() => telemetry.close()); ledger.tap = telemetry.push; }
    const chat = chatOn(t, ledger, dir);
    const id = (await chat.create({ provider: 'claude' })).conversation;
    let cursor = 0;
    const times = [];
    for (let i = 0; i < 6; i++) { const result = await turn(chat, id, 'hello ' + i, cursor); cursor = result.cursor; if (i) times.push(result.ms); } // the first starts the adapter
    await telemetry?.idle();
    await extra?.release?.();
    return { times, stats: telemetry?.stats(), file, ledgerFile, extra };
  };
  const off = await run('off', () => ({ off: true }));
  const locked = await run('locked', async ({ ledgerFile, file }) => {
    await replay(ledgerFile, file); // the file exists, then another process holds its write lock
    const locker = new DatabaseSync(file);
    locker.exec('BEGIN EXCLUSIVE');
    return { release: () => { locker.exec('ROLLBACK'); locker.close(); } };
  });
  const readOnly = await run('readonly', async ({ ledgerFile, file }) => {
    await replay(ledgerFile, file);
    await chmod(file, 0o444);
    return { release: () => chmod(file, 0o644) };
  });
  const garbage = Buffer.from('this is not a database. '.repeat(400));
  const corrupt = await run('corrupt', async ({ file }) => { await writeFile(file, garbage); });
  const base = median(off.times);
  for (const [name, result] of Object.entries({ locked, readOnly, corrupt })) {
    assert.ok(median(result.times) <= base + 50, name + ': turns took ' + JSON.stringify(result.times) + ' ms against ' + JSON.stringify(off.times) + ' with the watcher off');
  }
  // 3 the start's replay tried again (already in the file) plus the 6 new turns: none written.
  assert.equal(locked.stats.droppedRows, 3 + 6, 'locked drops: ' + JSON.stringify(locked.stats));
  assert.equal(rows(locked.file).length, 3);
  assert.equal(readOnly.stats.droppedRows, 3 + 6, 'read-only drops: ' + JSON.stringify(readOnly.stats));
  assert.equal(rows(readOnly.file).length, 3);
  assert.equal(corrupt.stats.setAside.length, 1, JSON.stringify(corrupt.stats));
  assert.deepEqual(await readFile(corrupt.stats.setAside[0]), garbage, 'the corrupt file is kept as it was');
  assert.equal(rows(corrupt.file).length, 3 + 6, 'rebuilt from the ledger, then the new turns');
  console.log('PASS isolation: median turn ms off ' + base + ', locked ' + median(locked.times) + ', read-only ' + median(readOnly.times) + ', corrupt ' + median(corrupt.times)
    + '; dropped rows locked ' + locked.stats.droppedRows + ', read-only ' + readOnly.stats.droppedRows + '; corrupt set aside and rebuilt to ' + rows(corrupt.file).length + ' rows');
});

test('slow writer: with every write held 2 s, turn-end reaches the ledger and the browser at once; the queue stays under its cap and counts drops', { timeout: 60000 }, async (t) => {
  const { dir, ledgerFile, file } = await scratch(t, 'slow');
  const ledger = openLedger(ledgerFile);
  const telemetry = startTelemetry({ ledgerFile, file, cap: 20, delayMs: 2000 });
  t.after(() => telemetry.close());
  ledger.tap = telemetry.push;
  await telemetry.idle();
  const chat = chatOn(t, ledger, dir);
  const id = (await chat.create({ provider: 'claude' })).conversation;
  let cursor = 0;
  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  const results = [];
  const began = performance.now();
  for (let i = 0; i < 3; i++) { const result = await turn(chat, id, 'stream 10', cursor); cursor = result.cursor; results.push(result); }
  lag.disable();
  const during = telemetry.stats();
  for (const result of results.slice(1)) {
    assert.ok(result.ms < 1000, 'turn took ' + result.ms + ' ms in the ledger');
    assert.ok(result.wall < 1500, 'the browser saw the end after ' + Math.round(result.wall) + ' ms');
  }
  assert.ok(lag.max / 1e6 < 500, 'event loop stalled ' + Math.round(lag.max / 1e6) + ' ms');
  assert.ok(during.maxQueue <= 20, 'queue reached ' + during.maxQueue);
  assert.ok(during.droppedEvents > 0, 'no drops counted: ' + JSON.stringify(during));
  await telemetry.idle();
  assert.ok(performance.now() - began >= 2000, 'the writer was not held: all done in ' + Math.round(performance.now() - began) + ' ms');
  assert.equal(rows(file).length, 3, 'caught up from the ledger after the drops');
  console.log('PASS slow writer: turns ' + results.map((r) => r.ms + ' ms / browser ' + Math.round(r.wall) + ' ms').join(', ') + '; loop max '
    + Math.round(lag.max / 1e6) + ' ms; max queue ' + during.maxQueue + ' of 20, ' + during.droppedEvents + ' events dropped, 3 rows after catch-up');
});

test('turn identity: failed, cut-off, steered, startedNewTurn and unprompted turns each get exactly one row', async (t) => {
  const { ledgerFile, file } = await scratch(t, 'identity');
  write(openLedger(ledgerFile), IDENTITY);
  await replay(ledgerFile, file);
  const all = rows(file);
  const shape = all.map(({ key, end_cursor, outcome, unprompted, steers, turn_number, total_ms }) => ({ key, end_cursor, outcome, unprompted, steers, turn_number, total_ms }));
  assert.deepEqual(shape, [
    { key: 2, end_cursor: 4, outcome: 'failed', unprompted: 0, steers: 0, turn_number: 1, total_ms: 200 },
    { key: 5, end_cursor: 7, outcome: 'cut-off', unprompted: 0, steers: 0, turn_number: 2, total_ms: 100 }, // ends at its last event, not the restart
    { key: 8, end_cursor: 12, outcome: 'finished', unprompted: 0, steers: 1, turn_number: 3, total_ms: 1000 },
    { key: 13, end_cursor: 14, outcome: 'finished', unprompted: 0, steers: 0, turn_number: 4, total_ms: 1000 },
    { key: 15, end_cursor: 17, outcome: 'finished', unprompted: 1, steers: 1, turn_number: 5, total_ms: 10500 },
    { key: 18, end_cursor: 18, outcome: 'finished', unprompted: 1, steers: 0, turn_number: 6, total_ms: 0 },
    { key: 19, end_cursor: 20, outcome: 'cut-off', unprompted: 0, steers: 0, turn_number: 7, total_ms: 0 },
    { key: 20, end_cursor: 21, outcome: 'finished', unprompted: 0, steers: 0, turn_number: 8, total_ms: 500 },
  ]);
  const steered = all.filter((row) => row.input_tokens === 10);
  assert.equal(steered.length, 1);
  assert.deepEqual([steered[0].key, steered[0].output_tokens, steered[0].cached_read_tokens, steered[0].cached_write_tokens, steered[0].total_tokens], [8, 20, 300, 40, 370]);
  assert.equal(all.find((row) => row.key === 2).error_code, 'agent-error');
  console.log('PASS turn identity: 8 rows, one per turn: failed, cut-off by restart, steered (tokens in one row), startedNewTurn, bare unprompted, cut-off by the next prompt');
});

test('workload fingerprint on every row: turn number, tools by kind, cache-read share, folder hash, provider and model', async (t) => {
  const { ledgerFile, file } = await scratch(t, 'fingerprint');
  const more = [[F, 'created', { provider: 'claude', title: 'Claude', folder: '/ho' + 'me/x/other project' }, T + 30000],
    [F, 'config', { model: { current: 'opus[1m]', options: [] } }, T + 30001]];
  for (let n = 0; n < 3; n++) more.push([F, 'user', { text: 'p' + n }, T + 31000 + n * 1000], [F, 'update', tool('f' + n, n === 2 ? 'mystery' : 'fetch', 'completed'), T + 31100 + n * 1000],
    [F, 'turn-end', { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 10, cachedReadTokens: 300, cachedWriteTokens: 100, totalTokens: 510 } }, T + 31500 + n * 1000]);
  write(openLedger(ledgerFile), [...METRIC, ...more]);
  await replay(ledgerFile, file);
  const all = rows(file);
  assert.equal(all.length, 6);
  for (const row of all) {
    assert.ok(['claude', 'codex'].includes(row.provider) && typeof row.model === 'string', JSON.stringify(row));
    assert.match(row.folder_id, /^[0-9a-f]{16}$/);
    assert.equal(Object.keys(row).filter((column) => column.startsWith('tools_')).reduce((sum, column) => sum + row[column], 0), row.tool_count);
    assert.equal(row.cache_read_share === null, row.input_tokens === null || row.cached_read_tokens === null);
    assert.equal(row.layers, 'baseline');
  }
  for (const conversation of [A, B, F]) assert.deepEqual(all.filter((row) => row.conversation === conversation).map((row) => row.turn_number), conversation === A ? [1, 2] : conversation === B ? [1] : [1, 2, 3]);
  const f = all.filter((row) => row.conversation === F);
  assert.deepEqual(f.map((row) => [row.tools_fetch, row.tools_other, row.cache_read_share, row.model]), [[1, 0, 0.6, 'opus[1m]'], [1, 0, 0.6, 'opus[1m]'], [0, 1, 0.6, 'opus[1m]']]); // 300 / (100 + 300 + 100)
  assert.notEqual(f[0].folder_id, all[0].folder_id);
  console.log('PASS fingerprint: 6 rows, each with turn number, tools by kind summing to tool_count, share where tokens exist, 16-hex folder id, provider, model');
});

test('replay after a restart never records a turn twice: in process, and through the daemon\'s own start (main.mjs)', { timeout: 60000 }, async (t) => {
  const { ledgerFile, file } = await scratch(t, 'replay');
  const ledger = openLedger(ledgerFile);
  write(ledger, [...METRIC, ...IDENTITY]);
  assert.equal((await replay(ledgerFile, file)).rowsWritten, 11);
  const first = rows(file);
  const again = await replay(ledgerFile, file);
  assert.equal(again.rowsWritten, 0, JSON.stringify(again));
  assert.deepEqual(rows(file), first);
  write(ledger, [[B, 'user', { text: 'more' }, T + 200000], [B, 'turn-end', { stopReason: 'end_turn' }, T + 201000]]);
  assert.equal((await replay(ledgerFile, file)).rowsWritten, 1);
  assert.equal(rows(file).length, 12);
  assert.equal(new Set(rows(file).map((row) => row.key)).size, 12);

  // The real daemon: telemetry.db beside its ledger, a turn, a stop, a new daemon on the same home, another turn.
  const fake = path.join(root, 'test/fake-acp-agent.mjs');
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const call = (one, route, method = 'GET', body) => http({ socketPath: path.join(one.state, 'daemon.sock'), route, method,
    headers: { ...authenticated(one.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const telemetryFile = path.join(instance.directory, '.local', 'state', 'p9-foundation', 'telemetry.db');
  const waitRows = async (n) => { for (let i = 0; i < 100; i++) { if (existsSync(telemetryFile) && rows(telemetryFile).length >= n) return rows(telemetryFile); await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error('rows: ' + (existsSync(telemetryFile) ? rows(telemetryFile).length : 'no file ' + (await readdir(instance.directory, { recursive: true })).filter((name) => name.includes('p9')).join(','))); };
  const id = JSON.parse((await call(instance, '/chat', 'POST', { provider: 'claude' })).text).conversation;
  assert.equal((await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'hello' })).status, 202);
  const before = await waitRows(1);
  instance.child.kill('SIGTERM');
  await once(instance.child, 'exit');
  const second = await restart(t, instance, 'state-2');
  assert.equal((await call(second, `/chat/${id}/prompt`, 'POST', { text: 'again' })).status, 202);
  const after = await waitRows(2);
  assert.equal(after.length, 2, JSON.stringify(after.map((row) => row.key)));
  assert.deepEqual(after[0], before[0]);
  assert.notEqual(after[0].key, after[1].key);
  console.log('PASS replay: in process 11 rows, a second start wrote 0, a new turn 1 (12 unique keys); daemon restart kept 1 row and added 1');
});
