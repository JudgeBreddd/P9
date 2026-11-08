// Memory capture (memory.mjs; _research/p9-learning-layer/plan-layers-2-5.md phase 2): one record per prompted turn in
// memory.db, read from the ledger by one capture function live and on replay. Fixture ledgers are written by hand below,
// with fixed times, and the expected records were worked out by hand before the first run.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openLedger } from '../apps/server/ledger.mjs';
import { createChat } from '../apps/server/chat.mjs';
import { createLifecycle } from '../apps/server/lifecycle.mjs';
import { startMemory, CAPTURE, RULES, MEMORY_CONVERSATION as MEM } from '../apps/server/memory.mjs';

const T = 1767000000000; // fixture clock: event n of a fresh ledger is at T + 100 n
const A = 'aaaaaaaa-0000-4000-8000-000000000001', B = 'bbbbbbbb-0000-4000-8000-000000000002', S = 'cccccccc-0000-4000-8000-000000000003';
const V = 'dddddddd-0000-4000-8000-000000000004';
const P = [1, 2, 3, 4, 5, 6, 7].map((n) => 'eeeeeeee-0000-4000-8000-00000000000' + n);
// Markers for what must never reach memory.db: tool output, thoughts, images.
const OUTPUT = 'TOOLOUTPUTMARKER', THOUGHT = 'THOUGHTMARKER', IMAGE = 'iVBORw0KGgoIMAGEMARKER';
const on = [MEM, 'memory', { action: 'switch', on: true }], off = [MEM, 'memory', { action: 'switch', on: false }];
const say = (text, messageId) => ({ sessionUpdate: 'agent_message_chunk', ...(messageId !== undefined && { messageId }), content: { type: 'text', text } });
const call = (toolCallId, kind, extra = {}) => ({ sessionUpdate: 'tool_call', toolCallId, title: 'Tool ' + toolCallId, kind, status: 'pending', ...extra });
const end = ['turn-end', { stopReason: 'end_turn' }];

// The [metric] fixture: a Claude turn (3 text chunks under 2 messageIds, an image and a thought between them), a Codex
// turn (a chunk with an id, then one without), a steered turn and a cut-off one. Cursors 1.. on a fresh ledger.
const metric = (ws) => [
  on, // 1
  [A, 'created', { provider: 'claude', title: 'Claude', folder: '' }], // 2
  [A, 'user', { text: 'Fix alpha/src/app.mjs please' }], // 3: turn opens
  [A, 'update', { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking ' + THOUGHT } }], // 4
  [A, 'update', call('t1', 'read', { rawInput: {}, _meta: { claudeCode: { toolName: 'Read' } } })], // 5: Claude's tool_call has an empty rawInput
  [A, 'update', { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', _meta: { claudeCode: { toolName: 'Read' } },
    rawInput: { file_path: path.join(ws, 'alpha/src/app.mjs'), content: 'body ' + OUTPUT }, rawOutput: 'raw ' + OUTPUT,
    content: [{ type: 'content', content: { type: 'text', text: 'file ' + OUTPUT } }] }], // 6: the path arrives here, beside the output
  [A, 'update', say('Reading ', 'm1')], // 7
  [A, 'update', say('the file.', 'm1')], // 8
  [A, 'update', { sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'image', mimeType: 'image/png', data: IMAGE } }], // 9
  [A, 'update', say('Fixed it.', 'm2')], // 10: a new message id: a new paragraph
  [A, ...end], // 11
  [B, 'created', { provider: 'codex', title: 'Codex', folder: 'beta' }], // 12
  [B, 'user', { text: 'Run the tests' }], // 13: turn opens
  [B, 'update', call('c1', 'execute', { rawInput: { command: 'npm test', cwd: path.join(ws, 'beta') } })], // 14
  [B, 'update', { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', rawOutput: { stdout: OUTPUT } }], // 15
  [B, 'update', say('All ', 'x1')], // 16
  [B, 'update', say('green.', null)], // 17: no id continues the message
  [B, ...end], // 18
  [A, 'user', { text: 'Deploy it' }], // 19: turn opens
  [A, 'update', say('Deploying.', 'm3')], // 20
  [A, 'user', { text: 'Use staging', steered: true }], // 21: folds into the open turn
  [A, 'update', say('Staging it is.', 'm4')], // 22
  [A, ...end], // 23
  [B, 'user', { text: 'Long job' }], // 24: turn opens
  [B, 'update', say('Starting', null)], // 25
  [B, 'interrupted', { reason: 'daemon-restart' }], // 26: cut off; it ends at its last event (25)
];
const at = (cursor) => T + 100 * cursor;
const base = { capture: CAPTURE, rules: RULES, private: 0 };
const EXPECTED = [
  { key: 3, conversation: A, end_cursor: 11, ...base, outcome: 'finished', start_at: at(3), end_at: at(11), provider: 'claude',
    user_text: 'Fix alpha/src/app.mjs please', reply: 'Reading the file.\n\nFixed it.', tools: '["Read"]', project: 'alpha' },
  { key: 13, conversation: B, end_cursor: 18, ...base, outcome: 'finished', start_at: at(13), end_at: at(18), provider: 'codex',
    user_text: 'Run the tests', reply: 'All green.', tools: '["execute"]', project: 'beta' },
  // No paths: the chat's last project.
  { key: 19, conversation: A, end_cursor: 23, ...base, outcome: 'finished', start_at: at(19), end_at: at(23), provider: 'claude',
    user_text: 'Deploy it\n\nUse staging', reply: 'Deploying.\n\nStaging it is.', tools: '[]', project: 'alpha' },
  { key: 24, conversation: B, end_cursor: 26, ...base, outcome: 'cut-off', start_at: at(24), end_at: at(25), provider: 'codex',
    user_text: 'Long job', reply: 'Starting', tools: '[]', project: 'beta' },
];

// A workspace with four projects (strong marks .git and plan.md beat package.json) and an Unrestricted folder outside it.
async function scratch(t, name) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'p9-memory-' + name + '-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ws = path.join(dir, 'ws'), outside = path.join(dir, 'outside');
  for (const folder of ['alpha', 'beta/.git', 'gamma/app', 'secretproj', 'notes/_private']) await mkdir(path.join(ws, folder), { recursive: true });
  await mkdir(path.join(outside, '.git'), { recursive: true });
  for (const [file, text] of [['alpha/plan.md', ''], ['gamma/plan.md', ''], ['gamma/app/package.json', '{}'], ['secretproj/plan.md', ''], ['notes/plan.md', '']]) {
    await writeFile(path.join(ws, file), text);
  }
  return { dir, ws, outside, ledgerFile: path.join(dir, 'p9.db'), file: path.join(dir, 'memory.db') };
}
// Fixture events go straight into the ledger with their own times, as a long-used ledger holds them.
function write(ledger, events) {
  const insert = ledger.db.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)');
  const first = Number(ledger.db.prepare('SELECT coalesce(max(cursor), 0) n FROM events').get().n) + 1;
  events.forEach(([conversation, type, data], i) => insert.run(conversation, type, JSON.stringify(data), at(first + i)));
  return ledger;
}
function query(file, sql) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare(sql).all().map((row) => ({ ...row })); } finally { db.close(); }
}
const records = (file) => query(file, 'SELECT * FROM records ORDER BY key');
async function replay(ledgerFile, file, workspace, options = {}) {
  const memory = startMemory({ ledgerFile, file, workspace, ...options });
  await memory.idle();
  const stats = memory.stats();
  await memory.close();
  return stats;
}
async function bytesOf(file) {
  const parts = [];
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(file + suffix)) parts.push(await readFile(file + suffix));
  return Buffer.concat(parts);
}
let chats = 0;
function chatOn(t, ledger, workspace) {
  const chat = createChat({ ledger, workspace, adapterOverride: path.join(import.meta.dirname, 'fake-acp-agent.mjs'),
    instance: 'mem-' + process.pid + '-' + (chats += 1), lifecycle: createLifecycle() });
  t.after(() => chat.shutdown());
  return chat;
}
// One prompt to its end, through the browser's long poll; returns the turn's time in the ledger (user to end).
async function turn(chat, id, text, cursor) {
  assert.equal((await chat.prompt(id, { text })).status, 202);
  const seen = [];
  for (let i = 0; i < 200; i++) {
    const page = await chat.events(cursor, 1000);
    cursor = page.cursor;
    seen.push(...page.events);
    const last = seen.find((event) => event.conversation === id && ['turn-end', 'error'].includes(event.type));
    if (last) return { cursor, ms: last.at - seen.find((event) => event.conversation === id && event.type === 'user').at };
  }
  throw new Error('no turn end: ' + JSON.stringify(seen.slice(-3).map((event) => event.type)));
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

test('[metric] replay of the hand-written fixture gives exactly the hand-built record for each turn', async (t) => {
  const { ws, ledgerFile, file } = await scratch(t, 'metric');
  write(openLedger(ledgerFile), metric(ws));
  const stats = await replay(ledgerFile, file, ws);
  assert.equal(stats.recordsWritten, 4, JSON.stringify(stats));
  assert.deepEqual(records(file), EXPECTED);
  console.log('PASS metric fixture: 4 records equal the hand-built ones (2 messageIds, a missing messageId, a steer, a cut-off)');
});

test('parity: the same events live (through ledger.append and emit) and by replay give identical records, capture version included', async (t) => {
  const { dir, ws, ledgerFile, file } = await scratch(t, 'parity');
  const ledger = openLedger(ledgerFile);
  const memory = startMemory({ ledgerFile, file, workspace: ws });
  t.after(() => memory.close());
  ledger.tap = (event) => memory.push(event);
  for (const [conversation, type, data] of metric(ws)) ledger.append(conversation, type, data);
  const chat = chatOn(t, ledger, ws);
  const id = (await chat.create({ provider: 'claude' })).conversation;
  let { cursor } = await turn(chat, id, 'hello', 0);
  ({ cursor } = await turn(chat, id, 'stream 3', cursor));
  await turn(chat, id, 'edit alpha/notes.md', cursor);
  await memory.idle();
  const live = records(file);
  assert.equal(live.length, 4 + 3, 'records written live: ' + JSON.stringify(memory.stats()));
  await replay(ledgerFile, path.join(dir, 'replayed.db'), ws);
  assert.deepEqual(records(path.join(dir, 'replayed.db')), live);
  assert.ok(live.every((row) => row.capture === CAPTURE && row.rules === RULES));
  const mine = live.filter((row) => row.conversation === id);
  assert.deepEqual(mine.map((row) => [row.user_text, row.reply, row.tools, row.project]), [
    ['hello', 'echo:hello', '[]', ''],
    ['stream 3', 'step 1 done. step 2 done. step 3 done. ', '["read","read","read"]', ''],
    ['edit alpha/notes.md', 'edited', '["edit"]', 'alpha'],
  ]);
  assert.equal((await bytesOf(file)).includes('line line'), false, 'the fake agent\'s tool output reached memory.db');
  console.log('PASS parity: ' + live.length + ' records live (fixture through ledger.append, 3 fake-agent turns through emit) equal the replay, capture ' + CAPTURE + ', rules ' + RULES);
});

test('never captured: tool output, rawOutput, tool rawInput content, thoughts and images never reach memory.db, -wal or -shm', async (t) => {
  const { ws, ledgerFile, file } = await scratch(t, 'never');
  write(openLedger(ledgerFile), metric(ws));
  const memory = startMemory({ ledgerFile, file, workspace: ws });
  t.after(() => memory.close());
  await memory.idle();
  const bytes = await bytesOf(file); // read while the worker still holds the file, so the -wal is there too
  await memory.close();
  assert.equal(records(file).length, 4);
  for (const marker of [OUTPUT, THOUGHT, IMAGE, 'IMAGEMARKER', 'body ', 'raw ']) assert.equal(bytes.includes(marker), false, marker + ' in memory.db');
  assert.ok(bytes.includes('Fixed it.'), 'the reply is in the file (the byte check reads the right file)');
  console.log('PASS never captured: ' + bytes.length + ' bytes of memory.db, -wal and -shm hold no tool output, rawOutput, rawInput content, thought or image');
});

// Fake secrets, built from pieces so the repo's own secret scan does not flag this file.
const ANTHROPIC = 'sk-ant-' + 'api03-' + 'q7Wm2Kp9Lx4Rt8Vn3Hs6Jd1Fg5Bz0Ce'.repeat(3).slice(0, 93) + 'AA';
const GITHUB = 'gh' + 'p_' + 'R8kq2Lm9Xw4Tz7Vb3Nc6Hd1Jf5Gs0Pa8Ye2U';
const PEM_BODY = 'MIIEowIBAAKCAQEAq7Wm2Kp9Lx4Rt8Vn3Hs6Jd1Fg5Bz0CeR8kq2Lm9Xw4Tz7Vb3Nc6Hd1Jf5Gs0Pa8Ye2U';
const PEM = '-----BEGIN RSA ' + 'PRIVATE KEY-----\n' + PEM_BODY + '\n-----END RSA ' + 'PRIVATE KEY-----';
test('secret scan: a fake Anthropic key, GitHub token and private key are markers in your text and the reply; a new rules version rebuilds', async (t) => {
  const { ws, ledgerFile, file } = await scratch(t, 'secrets');
  const text = 'Here are three: ' + ANTHROPIC + ' and ' + GITHUB + '\n' + PEM + '\nThe end.';
  write(openLedger(ledgerFile), [on, [A, 'created', { provider: 'claude', title: 'Claude', folder: '' }], [A, 'user', { text }],
    [A, 'update', say(text, 'm1')], [A, ...end], [A, 'user', { text: 'plain prose, nothing secret' }], [A, 'update', say('fine', 'm2')], [A, ...end]]);
  await replay(ledgerFile, file, ws);
  const scrubbed = 'Here are three: [secret:anthropic-api-key] and [secret:github-pat]\n[secret:private-key]\nThe end.';
  assert.deepEqual(records(file).map((row) => [row.user_text, row.reply, row.rules]), [[scrubbed, scrubbed, RULES], ['plain prose, nothing secret', 'fine', RULES]]);
  const bytes = await bytesOf(file);
  for (const secret of [ANTHROPIC, GITHUB, PEM_BODY, 'q7Wm2Kp9Lx4Rt8Vn', 'R8kq2Lm9Xw4Tz7Vb']) assert.equal(bytes.includes(secret), false, secret.slice(0, 12) + '... in memory.db');
  // Another rules version in the file: the next start rebuilds every record with the current rules.
  const db = new DatabaseSync(file);
  db.exec("UPDATE meta SET value = 'old-rules' WHERE key = 'rules'; UPDATE records SET user_text = 'stale' WHERE key = 3;");
  db.close();
  const stats = await replay(ledgerFile, file, ws);
  assert.equal(stats.rebuilds, 1, JSON.stringify(stats));
  assert.equal(records(file)[0].user_text, scrubbed, 'rebuilt from the ledger with the current rules');
  assert.equal(query(file, "SELECT value FROM meta WHERE key = 'rules'")[0].value, RULES);
  console.log('PASS secret scan: 3 fake secrets replaced by markers in both texts, absent from the file bytes; rules ' + RULES + ', an old rules version rebuilt ' + stats.recordsWritten + ' records');
});

test('[metric] project identity: 6 chats (plus one more no-paths chat) each get the hand-assigned project', async (t) => {
  const { ws, outside, ledgerFile, file } = await scratch(t, 'projects');
  const created = (id, provider, folder) => [id, 'created', { provider, title: provider, folder }];
  const update = (id, data) => [id, 'update', data];
  write(openLedger(ledgerFile), [on,
    // 1: cwd '' touching one project (Claude: the path in tool_call_update.rawInput); your text names another, the tool's path wins.
    created(P[0], 'claude', ''), [P[0], 'user', { text: 'look, like gamma/notes.txt' }], update(P[0], call('a', 'read', { rawInput: {} })),
    update(P[0], { sessionUpdate: 'tool_call_update', toolCallId: 'a', rawInput: { file_path: path.join(ws, 'alpha/x.md') } }), [P[0], ...end],
    // 2: cwd '' touching three: alpha once, beta twice, gamma once (gamma/app has package.json, gamma plan.md: gamma).
    created(P[1], 'claude', ''), [P[1], 'user', { text: 'survey' }],
    update(P[1], call('a', 'read', { locations: [{ path: path.join(ws, 'alpha/a.md') }] })),
    update(P[1], call('b', 'edit', { locations: [{ path: path.join(ws, 'beta/b1.md') }] })),
    update(P[1], call('c', 'edit', { locations: [{ path: path.join(ws, 'beta/b2.md') }] })),
    update(P[1], call('d', 'read', { rawInput: { path: path.join(ws, 'gamma/app/c.json') } })), [P[1], ...end],
    // 3: an explicit project cwd (gamma/app), a relative path in a command.
    created(P[2], 'codex', 'gamma/app'), [P[2], 'user', { text: 'hi' }], update(P[2], call('e', 'execute', { rawInput: { command: 'cat src/main.mjs' } })), [P[2], ...end],
    // 4: an absolute Unrestricted cwd outside the workspace.
    created(P[3], 'codex', outside), [P[3], 'user', { text: 'build' }], update(P[3], call('f', 'execute', { rawInput: { command: 'make', cwd: outside } })), [P[3], ...end],
    // 5: relative paths only (a command), then a turn whose only path is in your text.
    created(P[4], 'codex', ''), [P[4], 'user', { text: 'check' }], update(P[4], call('g', 'execute', { rawInput: { command: 'sed -n 1,5p beta/README.md' } })), [P[4], ...end],
    [P[4], 'user', { text: 'what about gamma/notes.txt?' }], [P[4], ...end],
    // 6: no paths at all, cwd '': the workspace root, never a project.
    created(P[5], 'claude', ''), [P[5], 'user', { text: 'hello there' }], update(P[5], say('hi', 'm1')), [P[5], ...end],
    // 7: no paths at all, cwd beta: falls back to the cwd's project.
    created(P[6], 'claude', 'beta'), [P[6], 'user', { text: 'hello again' }], [P[6], ...end],
  ]);
  await replay(ledgerFile, file, ws);
  assert.deepEqual(records(file).map((row) => [row.conversation, row.project]), [
    [P[0], 'alpha'], [P[1], 'beta'], [P[2], 'gamma'], [P[3], outside], [P[4], 'beta'], [P[4], 'gamma'], [P[5], ''], [P[6], 'beta'],
  ]);
  console.log('PASS project identity: 8 turns in 7 chats each got the hand-assigned project (tool path over text path, most touched, strong mark over package.json, absolute outside, text-only, root, cwd fallback)');
});

test('private: a turn touching a private-toggled folder is flagged and never in the shared index; a _private path alone is not; a later toggle hides earlier turns', async (t) => {
  const { ws, ledgerFile, file } = await scratch(t, 'private');
  const touch = (id, target) => [V, 'update', call(id, 'edit', { locations: [{ path: path.join(ws, target) }] })];
  write(openLedger(ledgerFile), [on, [V, 'created', { provider: 'claude', title: 'Claude', folder: '' }],
    [V, 'user', { text: 'alpha work ALPHAMARK' }], touch('a', 'alpha/a.md'), [V, ...end], // 3
    [MEM, 'memory', { action: 'private', folder: 'secretproj', on: true }],
    [V, 'user', { text: 'secret work PRIVMARK' }], touch('b', 'secretproj/s.md'), [V, ...end], // 7
    [V, 'user', { text: 'under underscore private UNDERMARK' }], touch('c', 'notes/_' + 'private/u.md'), [V, ...end], // 10
    [MEM, 'memory', { action: 'private', folder: 'alpha', on: true }],
    [V, 'user', { text: 'more alpha ALPHATWO' }], touch('d', 'alpha/b.md'), [V, ...end], // 14
  ]);
  await replay(ledgerFile, file, ws);
  assert.deepEqual(records(file).map((row) => [row.key, row.project, row.private]), [[3, 'alpha', 1], [7, 'secretproj', 1], [10, 'notes', 0], [14, 'alpha', 1]]);
  const found = (marker) => query(file, `SELECT count(*) n FROM shared WHERE shared MATCH '${marker}'`)[0].n;
  assert.deepEqual(['PRIVMARK', 'ALPHAMARK', 'ALPHATWO', 'UNDERMARK'].map(found), [0, 0, 0, 1]);
  const content = JSON.stringify(query(file, 'SELECT * FROM shared_content'));
  for (const marker of ['PRIVMARK', 'ALPHAMARK', 'ALPHATWO']) assert.equal(content.includes(marker), false, marker + ' in the shared table');
  console.log('PASS private: toggled folders flagged (2), a later toggle hid the earlier alpha turn, _private path alone stayed shared; shared index holds UNDERMARK only');
});

test('rebuild never resurrects: a switch-off stretch, a forgotten turn and a tombstone, rebuilt from the ledger from scratch', async (t) => {
  const { ws, ledgerFile, file } = await scratch(t, 'rebuild');
  const ledger = write(openLedger(ledgerFile), [on, [S, 'created', { provider: 'claude', title: 'Claude', folder: '' }],
    [S, 'user', { text: 'first ONMARK' }], [S, ...end], // 3
    off, [S, 'user', { text: 'second OFFSTRETCH' }], [S, 'update', say('OFFSTRETCH reply', 'm1')], [S, ...end], // 6: switch off
    on, [S, 'user', { text: 'third FORGETME' }], [S, 'update', say('reply FORGETME', 'm2')], [S, ...end], // 10
    [S, 'user', { text: 'fourth KEEPMARK' }], [S, ...end], // 13
  ]);
  const memory = startMemory({ ledgerFile, file, workspace: ws });
  t.after(() => memory.close());
  ledger.tap = (event) => memory.push(event);
  await memory.idle();
  assert.deepEqual(records(file).map((row) => row.key), [3, 10, 13]);
  // Live: forget the third turn, and a tombstone, as ledger events.
  ledger.append(MEM, 'memory', { action: 'forget', key: 10 });
  ledger.append(MEM, 'memory', { action: 'tombstone', text: 'never suggest BLOCKME' });
  await memory.idle();
  let bytes = await bytesOf(file);
  await memory.close();
  assert.deepEqual(records(file).map((row) => row.key), [3, 13]);
  for (const marker of ['FORGETME', 'forgetme', 'OFFSTRETCH', 'offstretch']) assert.equal(bytes.includes(marker), false, marker + ' in memory.db after the forget');
  // From scratch: memory.db gone, rebuilt from the ledger alone.
  for (const suffix of ['', '-wal', '-shm']) await rm(file + suffix, { force: true });
  const stats = await replay(ledgerFile, file, ws);
  assert.deepEqual(records(file).map((row) => [row.key, row.user_text]), [[3, 'first ONMARK'], [13, 'fourth KEEPMARK']], JSON.stringify(stats));
  assert.deepEqual(query(file, 'SELECT text FROM tombstones').map((row) => row.text), ['never suggest BLOCKME']);
  assert.equal(query(file, "SELECT count(*) n FROM shared WHERE shared MATCH 'FORGETME OR OFFSTRETCH'")[0].n, 0);
  bytes = await bytesOf(file);
  for (const marker of ['FORGETME', 'OFFSTRETCH']) assert.equal(bytes.includes(marker), false, marker + ' in the rebuilt memory.db');
  console.log('PASS rebuild: no off-stretch record, the forgotten turn stays gone (and its text left the file bytes), the tombstone is back after a rebuild. Tombstones blocking items is phase 3 (compile)');
});

test('off the chat path: locked, read-only or corrupt memory.db never delays a turn; drops counted; the ledger fills the gap; a corrupt file is set aside and rebuilt', { timeout: 120000 }, async (t) => {
  const run = async (name, setup) => {
    const { ws, ledgerFile, file } = await scratch(t, 'iso-' + name);
    const ledger = write(openLedger(ledgerFile), metric(ws)); // 4 turns already in the ledger, switch on
    const extra = await setup?.({ ws, ledgerFile, file });
    const memory = extra?.off ? null : startMemory({ ledgerFile, file, workspace: ws });
    if (memory) { t.after(() => memory.close()); ledger.tap = (event) => memory.push(event); }
    const chat = chatOn(t, ledger, ws);
    const id = (await chat.create({ provider: 'claude' })).conversation;
    let cursor = 0;
    const times = [];
    for (let i = 0; i < 6; i++) { const result = await turn(chat, id, 'hello ' + i, cursor); cursor = result.cursor; if (i) times.push(result.ms); } // the first starts the adapter
    await memory?.idle();
    const stats = memory?.stats();
    const during = extra?.off ? null : records(file).length;
    await extra?.release?.();
    await memory?.idle(); // the next pass reads the gap back from the ledger
    return { times, stats, during, after: extra?.off ? null : records(file).length };
  };
  const off = await run('off', () => ({ off: true }));
  const locked = await run('locked', async ({ ws, ledgerFile, file }) => {
    await replay(ledgerFile, file, ws); // the file exists, then another process holds its write lock
    const locker = new DatabaseSync(file);
    locker.exec('BEGIN EXCLUSIVE');
    t.after(() => { if (locker.isOpen) { locker.exec('ROLLBACK'); locker.close(); } });
    return { release: () => { locker.exec('ROLLBACK'); locker.close(); } };
  });
  const readOnly = await run('readonly', async ({ ws, ledgerFile, file }) => {
    await replay(ledgerFile, file, ws);
    await chmod(file, 0o444);
    return { release: () => chmod(file, 0o644) };
  });
  const garbage = Buffer.from('this is not a database. '.repeat(400));
  let corruptFile;
  const corrupt = await run('corrupt', async ({ file }) => { corruptFile = file; await writeFile(file, garbage); });
  const baseline = median(off.times);
  for (const [name, result] of Object.entries({ locked, readOnly, corrupt })) {
    assert.ok(median(result.times) <= baseline + 50, name + ': turns took ' + JSON.stringify(result.times) + ' ms against ' + JSON.stringify(off.times) + ' with memory off');
  }
  for (const [name, result] of Object.entries({ locked, readOnly })) {
    assert.ok(result.stats.droppedOutputs >= 6, name + ' drops: ' + JSON.stringify(result.stats));
    assert.equal(result.stats.setAside.length, 0, name + ' set a good file aside');
    assert.equal(result.during, 4, name + ': nothing new written while blocked');
    assert.equal(result.after, 4 + 6, name + ': once unblocked, the ledger fills the gap');
  }
  assert.equal(corrupt.stats.setAside.length, 1, JSON.stringify(corrupt.stats));
  assert.deepEqual(await readFile(corrupt.stats.setAside[0]), garbage, 'the corrupt file is kept as it was');
  assert.equal(corrupt.during, 4 + 6, 'rebuilt from the ledger, then the new turns');
  assert.ok(existsSync(corruptFile));
  console.log('PASS off the chat path: median turn ms off ' + baseline + ', locked ' + median(locked.times) + ', read-only ' + median(readOnly.times) + ', corrupt ' + median(corrupt.times)
    + '; drops locked ' + locked.stats.droppedOutputs + ', read-only ' + readOnly.stats.droppedOutputs + ', both refilled to 10 records; corrupt set aside and rebuilt to ' + corrupt.during);
});
