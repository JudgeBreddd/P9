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
