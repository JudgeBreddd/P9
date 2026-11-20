// O200: the panel's search also finds a chat by what was said in it (GET /chat/search, chat.search()), from the ledger P9
// already keeps: prompts and the agent's reply chunks, a reply joined before matching. Each result carries a snippet.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { openLedger } from '../apps/server/ledger.mjs';
import { createChat } from '../apps/server/chat.mjs';
import { createLifecycle } from '../apps/server/lifecycle.mjs';

const id = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const setup = async (t, file = ':memory:') => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-chat-search-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ledger = openLedger(file === ':memory:' ? file : path.join(dir, file));
  const chat = createChat({ ledger, workspace: dir, adapterOverride: path.join(import.meta.dirname, 'fake-acp-agent.mjs'),
    instance: 'search-' + process.pid, lifecycle: createLifecycle() });
  t.after(() => chat.shutdown());
  const db = ledger.db, event = db.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)');
  const conversation = db.prepare('INSERT INTO conversations (id, provider, title, state, created) VALUES (?, ?, ?, ?, ?)');
  const add = (c, type, data) => event.run(c, type, JSON.stringify(data), Date.now());
  return { db, chat, add, chatOf: (n, title = 'Chat ' + n) => conversation.run(id(n), 'claude', title, 'idle', Date.now()),
    user: (c, text) => add(c, 'user', { text }), say: (c, text) => add(c, 'update', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }) };
};
const found = (result) => Object.fromEntries((result.matches ?? []).map((m) => [m.chat, m.snippet]));

test('O200 search: a word split across two reply chunks still finds the chat, with a snippet that shows it', async (t) => {
  const { chat, chatOf, user, say } = await setup(t);
  chatOf(1); chatOf(2);
  user(id(1), 'what should we bake'); say(id(1), 'A pine'); say(id(1), 'apple tart, I think.');
  user(id(2), 'what should we bake'); say(id(2), 'Bread.');
  const result = chat.search('Pineapple');
  assert.equal(result.status, 200);
  const hits = found(result);
  assert.deepEqual(Object.keys(hits), [id(1)]);
  assert.match(hits[id(1)], /pineapple tart/i);
});

test('O200 search: a word only in a prompt finds the chat, whatever its case', async (t) => {
  const { chat, chatOf, user, say } = await setup(t);
  chatOf(1);
  user(id(1), 'Fix the Zanzibar build please'); say(id(1), 'Done.');
  assert.match(found(chat.search('zanzibar'))[id(1)] ?? '', /Zanzibar build/);
});

test('O200 search: a word across the 64 KB cut of a long reply still matches', async (t) => {
  const { chat, chatOf, user, say } = await setup(t);
  chatOf(1);
  user(id(1), 'go'); say(id(1), 'a'.repeat(65537) + ' kum'); say(id(1), 'quat jam');
  assert.ok(found(chat.search('kumquat'))[id(1)], 'the word that straddles the cut');
});

test('O200 search: the end of a reply and the next prompt are not joined into one match', async (t) => {
  const { chat, chatOf, user, say } = await setup(t);
  chatOf(1);
  user(id(1), 'one'); say(id(1), 'pine'); user(id(1), 'apple');
  assert.deepEqual(found(chat.search('pineapple')), {});
});

test('O200 search: an empty, one-letter or over-long query is refused', async (t) => {
  const { chat } = await setup(t);
  for (const q of [undefined, '', ' a ', 'x'.repeat(201)]) assert.equal(chat.search(q).status, 400, JSON.stringify(q));
});

test('O200 search timed: 36 chats over 200 MB, a word said once in the last chat', { timeout: 300000 }, async (t) => {
  const { db, chat, add, chatOf, user, say } = await setup(t, 'ledger.db');
  const words = 'The build passed on the second try after the cache was cleared and the test ran again on the server '.split(' ');
  db.exec('BEGIN');
  for (let c = 1; c <= 36; c++) {
    chatOf(c);
    for (let n = 0; n < 230; n++) {
      user(id(c), 'Prompt ' + n);
      for (let k = 0; k < 3; k++) add(id(c), 'update', { sessionUpdate: 'tool_call', toolCallId: 't', title: 'Read', content: [{ type: 'text', text: 'x'.repeat(8000) }] });
      for (const word of words) say(id(c), word + ' ');
      add(id(c), 'turn-end', {});
    }
  }
  say(id(36), 'the quoll lives in Tasmania');
  db.exec('COMMIT');
  const times = [];
  let result;
  for (let k = 0; k < 3; k++) { const start = performance.now(); result = chat.search('quoll'); times.push(Math.round(performance.now() - start)); }
  console.log('O200 search ms (36 chats, 230 turns each, 3 runs): ' + times.join(' '));
  assert.deepEqual(Object.keys(found(result)), [id(36)]);
});

test('O200 FIX1 search: replies of separate turns with no prompt between are not joined into one match', async (t) => {
  const { chat, chatOf, user, say, add } = await setup(t);
  const ends = ['turn-end', 'interrupted', 'exited', 'stopped', 'closed', 'error'];
  ends.forEach((type, n) => { chatOf(n + 1); user(id(n + 1), 'what fruit'); say(id(n + 1), 'A pine'); add(id(n + 1), type, {}); say(id(n + 1), 'apple, later.'); });
  chatOf(9); user(id(9), 'and you'); say(id(9), 'A pine'); add(id(9), 'turn-end', {}); say(id(9), 'cone'); say(id(9), 'pineapple in one reply');
  assert.deepEqual(Object.keys(found(chat.search('pineapple'))), [id(9)], 'a word across a turn boundary is not a match');
  assert.equal(Object.keys(found(chat.search('apple, later'))).length, ends.length, 'the reply after the boundary is still searched');
});

test('O200 FIX1 panel search: only the newest answer is used (same words after new activity, Q then R then Q, a cleared box)', async () => {
  const { searcher } = await import('../apps/web/src/panel.mjs');
  const pending = [], applied = [];
  const ask = searcher(() => new Promise((resolve) => pending.push(resolve)), (q, m) => applied.push(q + ':' + m.map((x) => x.chat).join()));
  const answer = (i, chats) => pending[i]({ status: 200, body: { matches: chats.map((chat) => ({ chat, snippet: '' })) } });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  // The search typed first is slow and finds nothing; a message arrives, the same words are searched again and found.
  let a = ask('pine'), b = ask('pine'); await flush();
  answer(1, ['x']); await b; answer(0, []); await a;
  assert.deepEqual(applied, ['pine:x'], 'the late answer of the first search does not replace the newer one');
  applied.length = 0; pending.length = 0;
  a = ask('q1'); b = ask('r1'); const c = ask('q1'); await flush();
  answer(2, ['new']); await c; answer(1, ['r']); await b; answer(0, ['old']); await a;
  assert.deepEqual(applied, ['q1:new'], 'Q, R, Q: only the last Q counts');
  applied.length = 0; pending.length = 0;
  a = ask('q2'); await flush(); void ask(''); answer(0, ['y']); await a;
  assert.deepEqual(applied, [], 'an answer arriving after the box is cleared is dropped');
});
