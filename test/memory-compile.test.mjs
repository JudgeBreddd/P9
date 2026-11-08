// Memory compile (memory.mjs; _research/p9-learning-layer/plan-layers-2-5.md phase 3): a chat's records into items with
// proof, tombstones and fact updates. Fixture ledgers are written by hand with fixed times; every expected item, anchor,
// range and weight below was worked out by hand (design: the project's private notes, p9-memory-phase3/design.md) before the
// first run. Weight = 1 + 2 steer + 2 correction + 2 failed tool call, over the item's range.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { openLedger } from '../apps/server/ledger.mjs';
import { startMemory, compile, turnsOf, blocked, resolverFor, TOMBSTONE_MS, MEMORY_CONVERSATION as MEM } from '../apps/server/memory.mjs';

const T = 1767000000000; // event n of a fresh ledger is at T + 100 n
const X = 'aaaaaaaa-0000-4000-8000-000000000001', Y = 'bbbbbbbb-0000-4000-8000-000000000002', Z = 'cccccccc-0000-4000-8000-000000000003';
const W = 'dddddddd-0000-4000-8000-000000000004', F1 = 'eeeeeeee-0000-4000-8000-000000000005', F2 = 'ffffffff-0000-4000-8000-000000000006';
const on = [MEM, 'memory', { action: 'switch', on: true }];
const say = (id, text, messageId) => [id, 'update', { sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } }];
const call = (id, toolCallId, kind, extra = {}) => [id, 'update', { sessionUpdate: 'tool_call', toolCallId, kind, status: 'pending', ...extra }];
const done = (id, toolCallId, status, extra = {}) => [id, 'update', { sessionUpdate: 'tool_call_update', toolCallId, status, ...extra }];
const end = (id) => [id, 'turn-end', { stopReason: 'end_turn' }];
const created = (id, provider, folder = '') => [id, 'created', { provider, title: provider, folder }];

// Three chats (cursors in the comments): X smooth, Y a steer and a correction, Z a failed command then the fixed one.
const three = (ws) => [
  on, // 1
  created(X, 'claude'), // 2
  [X, 'user', { text: 'Add a footer to alpha/site/index.html' }], // 3: no marker, no item
  call(X, 'x1', 'edit', { locations: [{ path: path.join(ws, 'alpha/site/index.html') }] }), done(X, 'x1', 'completed'), // 4, 5
  say(X, 'Alpha is a static site with a home page and a blog. The site lives in alpha/site and is built with plain HTML. I added a footer to alpha/site/index.html with the copyright line. Want it only in alpha/site/blog.html instead?', 'xm1'), // 6: overview and a question, no item
  end(X), // 7
  created(Y, 'codex'), // 8
  [Y, 'user', { text: 'Start the dev server for gamma/app' }], // 9: turn 1 opens
  call(Y, 'y1', 'execute', { rawInput: { command: 'npm run dev -- --port 8080', cwd: path.join(ws, 'gamma/app') } }), done(Y, 'y1', 'completed'), // 10, 11
  say(Y, 'Started the dev server on port 8080.', 'ym1'), // 12
  [Y, 'user', { text: 'Actually use port 5173, the proxy expects it.', steered: true }], // 13: steer + correction
  say(Y, 'Restarted it on port 5173 because the proxy only allows that port.', 'ym2'), // 14
  end(Y), // 15
  [Y, 'user', { text: 'No, keep the old config in gamma/vite.config.js untouched.' }], // 16: turn 2, a correction
  say(Y, "Understood, I won't touch gamma/vite.config.js. Next: wire the proxy in gamma/app/proxy.mjs.", 'ym3'), // 17
  end(Y), // 18
  created(Z, 'claude'), // 19
  [Z, 'user', { text: 'Build the app in beta/app' }], // 20
  call(Z, 'z1', 'execute', { rawInput: {} }), done(Z, 'z1', 'failed', { rawInput: { command: 'pnpm build' } }), // 21, 22
  call(Z, 'z2', 'execute', { rawInput: {} }), done(Z, 'z2', 'completed', { rawInput: { command: 'pnpm -F app build' } }), // 23, 24
  say(Z, '`pnpm build` fails at the root because there is no build script there. `pnpm -F app build` works and writes beta/app/dist.', 'zm1'), // 25
  end(Z), // 26
];
const at = (cursor) => T + 100 * cursor;
const item = (conversation, kind, claim, anchors, from, to, project, weight, extra = {}) => ({ conversation, kind, claim, anchors: JSON.stringify(anchors),
  from_cursor: from, to_cursor: to, project, cross: 0, private: 0, weight, source: 'turns', valid_from: at(to), valid_to: null, ...extra });
const THREE = [
  item(Y, 'decision', 'Actually use port 5173, the proxy expects it.', ['5173'], 9, 15, 'gamma', 5),
  item(Y, 'fact', 'Restarted it on port 5173 because the proxy only allows that port.', ['5173'], 9, 15, 'gamma', 5),
  item(Y, 'decision', 'No, keep the old config in gamma/vite.config.js untouched.', ['gamma/vite.config.js'], 16, 18, 'gamma', 3),
  item(Y, 'fact', "Understood, I won't touch gamma/vite.config.js.", ['gamma/vite.config.js'], 16, 18, 'gamma', 3),
  item(Y, 'left-off', 'Next: wire the proxy in gamma/app/proxy.mjs.', ['gamma/app/proxy.mjs'], 16, 18, 'gamma', 3),
  item(Z, 'fact', '`pnpm -F app build` works', ['pnpm -F app build'], 20, 26, 'beta', 3),
];

async function scratch(t, name) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'p9-compile-' + name + '-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ws = path.join(dir, 'ws');
  for (const folder of ['alpha/site', 'beta/.git', 'beta/app', 'gamma/app']) await mkdir(path.join(ws, folder), { recursive: true });
  for (const file of ['alpha/plan.md', 'gamma/plan.md']) await writeFile(path.join(ws, file), '');
  return { ws, ledgerFile: path.join(dir, 'p9.db'), file: path.join(dir, 'memory.db') };
}
function write(ledgerFile, events) {
  const ledger = openLedger(ledgerFile);
  const insert = ledger.db.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)');
  const first = Number(ledger.db.prepare('SELECT coalesce(max(cursor), 0) n FROM events').get().n) + 1;
  events.forEach(([conversation, type, data], i) => insert.run(conversation, type, JSON.stringify(data), at(first + i)));
  ledger.db.close();
}
function query(file, sql, ...args) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare(sql).all(...args).map((row) => ({ ...row })); } finally { db.close(); }
}
async function replay(t, ledgerFile, file, ws) {
  const memory = startMemory({ ledgerFile, file, workspace: ws });
  t.after(() => memory.close());
  await memory.idle();
  const stats = memory.stats();
  await memory.close();
  assert.equal(stats.lastError, null, JSON.stringify(stats));
  return stats;
}
const ITEM = 'SELECT conversation, kind, claim, anchors, from_cursor, to_cursor, project, cross, private, weight, source, valid_from, valid_to FROM items';
// compile() straight on one chat, with its records from memory.db and its turns from the ledger.
function chatTurns(ledgerFile, file, ws, conversation) {
  const ledger = new DatabaseSync(ledgerFile, { readOnly: true });
  try { return turnsOf(ledger, query(file, 'SELECT * FROM records WHERE conversation = ? ORDER BY key', conversation), ws); } finally { ledger.close(); }
}

test('[metric] three hand-labelled chats compile to exactly the hand-listed items and weights; the smooth chat gives none', async (t) => {
  const { ws, ledgerFile, file } = await scratch(t, 'three');
  write(ledgerFile, three(ws));
  await replay(t, ledgerFile, file, ws);
  assert.deepEqual(query(file, ITEM + ' ORDER BY conversation, id'), THREE);
  assert.deepEqual(query(file, 'SELECT conversation, kind, reason, cursor FROM dropped ORDER BY rowid'), [{ conversation: Z, kind: 'fact', reason: 'failed command only', cursor: 26 }]);
  console.log('PASS metric: 3 chats, 6 items equal the hand-listed ones (weights 5 5 3 3 3 3), smooth chat X 0 items from 3 overview sentences and a question, 1 drop (failed command only)');
});

test('proof: a handoff item whose anchor is not in its range is dropped with the reason; a handoff cannot prove itself', async (t) => {
  const { ws, ledgerFile, file } = await scratch(t, 'proof');
  write(ledgerFile, three(ws));
  await replay(t, ledgerFile, file, ws);
  const turns = chatTurns(ledgerFile, file, ws, Y);
  const handoff = { cursor: 1000, text: [
    '- decision: Use port `5173` for the gamma/app dev server',
    '- fact: The proxy wiring goes in gamma/app/proxy.mjs',
    '- fact: Settings live in gamma/app/settings.json', // invented: no turn holds it
    '- next: wire the proxy in gamma/app/proxy.mjs',
  ].join('\n') };
  const { items, dropped } = compile({ turns, handoff, resolve: resolverFor(ws), workspace: ws });
  const fromHandoff = items.filter((x) => x.source === 'handoff');
  assert.deepEqual(fromHandoff.map((x) => [x.kind, x.claim, x.from_cursor, x.to_cursor, x.project]), [
    ['decision', 'Use port `5173` for the gamma/app dev server', 9, 18, 'gamma'], // gamma/app is in turn 2 too (gamma/app/proxy.mjs)
    ['fact', 'The proxy wiring goes in gamma/app/proxy.mjs', 16, 18, 'gamma'],
    ['left-off', 'wire the proxy in gamma/app/proxy.mjs', 16, 18, 'gamma'],
  ]);
  assert.deepEqual(dropped.filter((x) => x.source === 'handoff').map((x) => [x.claim, x.reason]), [['Settings live in gamma/app/settings.json', 'unproven: gamma/app/settings.json']]);
  assert.equal(items.filter((x) => x.kind === 'left-off').length, 1, 'the handoff next line replaces the rule left-off');
  // Written before turn 2 ended: only turn 1 is proof, so both proxy items go too.
  const early = compile({ turns, handoff: { cursor: 17, text: handoff.text }, resolve: resolverFor(ws), workspace: ws });
  assert.deepEqual(early.items.filter((x) => x.source === 'handoff').map((x) => x.claim), ['Use port `5173` for the gamma/app dev server']);
  assert.deepEqual(early.dropped.filter((x) => x.source === 'handoff').map((x) => x.reason), ['unproven: gamma/app/proxy.mjs', 'unproven: gamma/app/settings.json', 'unproven: gamma/app/proxy.mjs']);
  console.log('PASS proof: handoff 4 lines -> 3 items, the invented path dropped (unproven: gamma/app/settings.json); written at cursor 17 only the turn-1 item survives');
});

test('failed attempts are not facts: pnpm build fails, pnpm -F app build works; the item names only the second', async (t) => {
  const { ws, ledgerFile, file } = await scratch(t, 'failed');
  write(ledgerFile, three(ws));
  await replay(t, ledgerFile, file, ws);
  const items = query(file, ITEM + ' WHERE conversation = ?', Z);
  assert.deepEqual(items.map((x) => [x.claim, x.anchors]), [['`pnpm -F app build` works', '["pnpm -F app build"]']]);
  assert.equal(JSON.stringify(items).includes('"pnpm build"'), false);
  assert.deepEqual(query(file, 'SELECT claim, reason FROM dropped WHERE conversation = ?', Z),
    [{ claim: '`pnpm build` fails at the root because there is no build script there.', reason: 'failed command only' }]);
  // The same sentence about the command when it completed is a fact.
  const turns = chatTurns(ledgerFile, file, ws, Z).map((turn) => ({ ...turn, tools: turn.tools.map((tool) => ({ ...tool, status: 'completed' })) }));
  assert.ok(compile({ turns, resolve: resolverFor(ws), workspace: ws }).items.some((x) => x.claim.startsWith('`pnpm build` fails')));
  console.log('PASS failed: 1 item (pnpm -F app build), the pnpm build sentence dropped as failed command only; completed, it would be kept');
});

test('item scope: a root chat on alpha then beta compiles each item to its own project; no paths takes the fallback, never cross', async (t) => {
  const { ws, ledgerFile, file } = await scratch(t, 'scope');
  write(ledgerFile, [on, created(W, 'claude'), // 1, 2
    [W, 'user', { text: 'Always run alpha/app tests through the dev space.' }], // 3
    call(W, 'w1', 'edit', { locations: [{ path: path.join(ws, 'alpha/app/x.mjs') }] }), done(W, 'w1', 'completed'), say(W, 'Done.', 'wm1'), end(W), // 4-7
    [W, 'user', { text: 'Never restart beta/compose.yml services by hand.' }], // 8
    call(W, 'w2', 'read', { locations: [{ path: path.join(ws, 'beta/compose.yml') }] }), done(W, 'w2', 'completed'), say(W, 'Ok.', 'wm2'), end(W), // 9-12
    [W, 'user', { text: "Don't deploy after 17:00 on Fridays." }], end(W), // 13, 14
  ]);
  await replay(t, ledgerFile, file, ws);
  assert.deepEqual(query(file, 'SELECT claim, project, cross FROM items ORDER BY id').map((x) => [x.claim, x.project, x.cross]), [
    ['Always run alpha/app tests through the dev space.', 'alpha', 0],
    ['Never restart beta/compose.yml services by hand.', 'beta', 0],
    ["Don't deploy after 17:00 on Fridays.", 'beta', 0], // no paths in its range: the chat's last project
  ]);
  // A handoff may mark an item for all projects; with no paths in its range it still is not cross.
  const turns = chatTurns(ledgerFile, file, ws, W);
  const { items } = compile({ turns, handoff: { cursor: 1000, text: "decision (all projects): Always run alpha/app tests through the dev space\ndecision (all projects): Don't deploy after 17:00" },
    resolve: resolverFor(ws), workspace: ws });
  assert.deepEqual(items.filter((x) => x.source === 'handoff').map((x) => [x.project, x.cross]), [['alpha', 1], ['beta', 0]]);
  console.log('PASS scope: alpha item -> alpha, beta item -> beta (chat first touched alpha), no-path item -> beta fallback, cross 0; tagged handoff items cross 1 / 0');
});

test('tombstones: 5 pairs (exact, reworded, changed number, other project, expired), and a tombstone event removes and keeps blocking', async (t) => {
  const it = { claim: 'The dev server for gamma/app runs on port 5173.', project: 'gamma', valid_from: T + 10 * 86400000 };
  const tomb = (text, project = 'gamma', when = T) => [{ text, project, at: when }];
  assert.deepEqual([
    tomb('The dev server for gamma/app runs on port 5173.'), // exact
    tomb('gamma/app dev server: use port 5173'), // reworded, same literals
    tomb('The dev server for gamma/app runs on port 8080.'), // changed number
    tomb('The dev server for gamma/app runs on port 5173.', 'beta'), // other project
    tomb('The dev server for gamma/app runs on port 5173.', 'gamma', it.valid_from - TOMBSTONE_MS - 1), // expired: 60 days and 1 ms
  ].map((t) => Boolean(blocked(it, t))), [true, true, false, false, false]);
  const { ws, ledgerFile, file } = await scratch(t, 'tomb');
  write(ledgerFile, [...three(ws), [MEM, 'memory', { action: 'tombstone', text: 'Do not touch gamma/vite.config.js', project: 'gamma' }]]); // 27
  await replay(t, ledgerFile, file, ws);
  const live = () => query(file, 'SELECT claim FROM items ORDER BY id').map((x) => x.claim);
  const expected = THREE.map((x) => x.claim).filter((claim) => !claim.includes('gamma/vite.config.js'));
  assert.deepEqual(live(), expected);
  assert.deepEqual(query(file, "SELECT kind, reason FROM dropped WHERE reason = 'tombstone' ORDER BY rowid"), [{ kind: 'decision', reason: 'tombstone' }, { kind: 'fact', reason: 'tombstone' }]);
  // Live order (items first, the tombstone later, one running worker, no restart, so no recompile) gives the same: the
  // event itself takes them out.
  const live2 = await scratch(t, 'tomb-live');
  write(live2.ledgerFile, three(live2.ws));
  const memory = startMemory({ ledgerFile: live2.ledgerFile, file: live2.file, workspace: live2.ws });
  t.after(() => memory.close());
  await memory.idle();
  assert.equal(query(live2.file, 'SELECT count(*) n FROM items')[0].n, 6);
  write(live2.ledgerFile, [[MEM, 'memory', { action: 'tombstone', text: 'Do not touch gamma/vite.config.js', project: 'gamma' }]]);
  await memory.idle();
  assert.equal(memory.stats().lastError, null);
  await memory.close();
  assert.deepEqual(query(live2.file, 'SELECT claim FROM items ORDER BY id').map((x) => x.claim), expected);
  console.log('PASS tombstones: pairs blocked exact + reworded, passed changed number, other project, expired; a tombstone event removed 2 items, on replay and live');
});

test('fact updates: a newer item with the same anchor and another value closes the old one; live_items holds only the open one', async (t) => {
  const { ws, ledgerFile, file } = await scratch(t, 'update');
  write(ledgerFile, [on,
    created(F1, 'claude', 'gamma'), [F1, 'user', { text: 'Which port?' }], say(F1, 'The gamma/app dev server must use port 5173.', 'f1'), end(F1), // 2-5
    created(F2, 'claude', 'gamma'), [F2, 'user', { text: 'Port again?' }], say(F2, 'The gamma/app dev server must use port 5174 now.', 'f2'), end(F2), // 6-9
  ]);
  await replay(t, ledgerFile, file, ws);
  assert.deepEqual(query(file, 'SELECT claim, valid_from, valid_to FROM items ORDER BY id'), [
    { claim: 'The gamma/app dev server must use port 5173.', valid_from: at(5), valid_to: at(9) },
    { claim: 'The gamma/app dev server must use port 5174 now.', valid_from: at(9), valid_to: null },
  ]);
  assert.deepEqual(query(file, 'SELECT claim FROM live_items').map((x) => x.claim), ['The gamma/app dev server must use port 5174 now.']);
  console.log('PASS fact updates: port 5173 closed at the 5174 item (valid_to ' + at(9) + '), live_items holds 1 of 2');
});
