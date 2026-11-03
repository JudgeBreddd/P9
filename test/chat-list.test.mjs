// GET /chat (chat.list()) on a ledger the size of a long-used one: 36 chats over 200 MB. The phone lists again whenever a
// turn ends or a chat asks something, so list() must stay quick. Each row carries waiting (a question or approval not
// answered since the last turn ended) and preview (the first line of the last thing said), both by the phone's own
// digest() rule, so a chat whose events the phone has not read yet shows the same line as one it has.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { openLedger } from '../apps/server/ledger.mjs';
import { createChat } from '../apps/server/chat.mjs';
import { createLifecycle } from '../apps/server/lifecycle.mjs';

test('GET /chat on 36 chats over 200 MB: waiting and preview by the phone\'s rule, timed', { timeout: 300000 }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-chat-list-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ledger = openLedger(path.join(dir, 'ledger.db'));
  const db = ledger.db;
  const chat = createChat({ ledger, workspace: dir, adapterOverride: path.join(import.meta.dirname, 'fake-acp-agent.mjs'),
    instance: 'list-' + process.pid, lifecycle: createLifecycle() });
  t.after(() => chat.shutdown());

  const id = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
  const conversation = db.prepare('INSERT INTO conversations (id, provider, title, state, created) VALUES (?, ?, ?, ?, ?)');
  const event = db.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)');
  const add = (c, type, data) => event.run(c, type, JSON.stringify(data), Date.now());
  const say = (c, text) => add(c, 'update', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
  const tool = (c) => add(c, 'update', { sessionUpdate: 'tool_call', toolCallId: 't', title: 'Read', content: [{ type: 'text', text: 'x'.repeat(8000) }] });
  const words = 'The build passed on the second try after the cache was cleared and the test ran again on the server '.split(' ');
  // Each turn: the prompt, three tool calls with their output (most of a real ledger's bytes), a streamed reply, its end.
  const turn = (c, n) => {
    add(c, 'user', { text: 'Prompt ' + n });
    for (let k = 0; k < 3; k++) tool(c);
    for (const word of words) say(c, word + ' ');
    say(c, '\nSecond line of turn ' + n);
    add(c, 'turn-end', {});
  };
  db.exec('BEGIN');
  for (let c = 1; c <= 36; c++) {
    conversation.run(id(c), 'claude', 'Chat ' + c, 'idle', Date.now());
    for (let n = 0; n < 230; n++) turn(id(c), n);
  }
  // The newest chats end in the cases a list has to tell apart.
  say(id(1), 'Warning: something the agent program printed\n\n'); // a warning is not the reply (agentWarning)
  tool(id(2)); // a tool call after the reply: the reply stays the last thing said
  add(id(3), 'user', { text: 'A prompt with no reply yet\nand a second line' }); // the prompt is the last thing said
  add(id(4), 'approval', { request: 'r4', toolCall: { title: 'Write' }, options: [] }); // open: waiting
  add(id(5), 'approval', { request: 'r5', toolCall: { title: 'Write' }, options: [] });
  add(id(5), 'answered', { request: 'r5', answer: { outcome: { outcome: 'selected', optionId: 'allow' } } }); // answered
  add(id(6), 'question', { request: 'r6', form: {} }); add(id(6), 'interrupted', {}); // its turn ended: not waiting
  add(id(7), 'user', { text: 'go' }); say(id(7), 'x'.repeat(300)); add(id(7), 'turn-end', {}); // a reply's first line is cut near 100 characters
  conversation.run(id(37), 'codex', 'Never used', 'idle', Date.now()); // no events at all
  db.exec('COMMIT');
  const bytes = db.prepare('SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()').get().n;
  assert.ok(bytes > 200e6, 'the ledger is over 200 MB: ' + bytes);

  const times = [];
  for (let i = 0; i < 7; i++) { const start = performance.now(); chat.list(); times.push(performance.now() - start); }
  times.sort((a, b) => a - b);
  console.log('P9_TIME chat-list ' + JSON.stringify({ chats: 37, mb: Math.round(bytes / 1e6), events: db.prepare('SELECT count(*) AS n FROM events').get().n,
    medianMs: Math.round(times[3]), maxMs: Math.round(times[6]) }));
  assert.ok(times[3] < 250, 'list() median ' + times[3] + ' ms on 36 chats over 200 MB');

  const rows = new Map(chat.list().map((row) => [row.id, row]));
  const line = 'The build passed on the second try after the cache was cleared and the test ran again on the server';
  assert.equal(rows.get(id(1)).preview, line);
  assert.equal(rows.get(id(2)).preview, line);
  assert.equal(rows.get(id(3)).preview, 'A prompt with no reply yet');
  assert.equal(rows.get(id(8)).preview, line);
  assert.equal(rows.get(id(7)).preview, 'x'.repeat(99) + '…');
  assert.equal(rows.get(id(37)).preview, '');
  assert.deepEqual([4, 5, 6, 8].map((n) => rows.get(id(n)).waiting), [true, false, false, false]);

});
