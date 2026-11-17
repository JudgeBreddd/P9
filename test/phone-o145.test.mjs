import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { remoteDaemon } from './helpers.mjs';
import { phone } from './phone-c16-helpers.mjs';

// O145: the phone keeps a block's signature while the block is unchanged, so a long chat does not stringify every block on
// every poll. A block that changes after it was drawn (a request answered, an ask closed, a tool ended by the turn's end)
// must be drawn again: a signature kept by mistake leaves its buttons, its open form or its spinner on screen.
const A = '00000000-0000-4000-8000-0000000001a5';
const db = (server) => new DatabaseSync(path.join(server.directory, '.local', 'state', 'p9-foundation', 'p9.db'), { timeout: 5000 });
function append(server, events) {
  const ledger = db(server), event = ledger.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)');
  ledger.exec('BEGIN'); for (const [type, data] of events) event.run(A, type, JSON.stringify(data), Date.now()); ledger.exec('COMMIT'); ledger.close();
}

test('O145: a request answered, an ask closed and a tool ended are drawn again', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  const ledger = db(server);
  ledger.prepare('INSERT INTO conversations (id, provider, title, state, created) VALUES (?, ?, ?, ?, ?)').run(A, 'claude', 'Chat O145', 'idle', Date.now());
  ledger.close();
  // One running turn: a tool still going, an approval waiting with its two buttons, a question with its form open.
  append(server, [['user', { text: 'do the thing' }],
    ['update', { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run the build', kind: 'execute', status: 'in_progress' }],
    ['approval', { request: 'r1', toolCall: { title: 'Write the file' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }] }],
    ['question', { request: 'q1', message: 'Which branch?', form: { fields: [] } }]]);
  const { page } = await phone(t, server);
  await page.waitForSelector('h1:text("Chats")');
  await page.goto(server.origin + '/phone/#chat=' + A);
  await page.waitForSelector('#events [data-request="r1"]', { timeout: 15000 });
  const before = await page.evaluate(() => ({ buttons: document.querySelectorAll('#events [data-request="r1"]').length,
    ask: !!document.querySelector('#events article[data-kind="ask"].open'), spin: document.querySelectorAll('#events [data-status="in_progress"]').length }));
  assert.deepEqual(before, { buttons: 2, ask: true, spin: 1 }, 'the open turn was not drawn as expected first');

  // The request is answered, then the turn ends: the ask closes and the tool stops. The note it ends with is drawn either way.
  append(server, [['answered', { request: 'r1', answer: { outcome: { outcome: 'selected', optionId: 'allow' } } }],
    ['turn-end', { stopReason: 'cancelled' }]]);
  await page.waitForSelector('#events :text("Turn ended · cancelled")', { timeout: 30000 });
  const after = await page.evaluate(() => ({ buttons: document.querySelectorAll('#events [data-request="r1"]').length,
    ask: !!document.querySelector('#events article[data-kind="ask"].open'), spin: document.querySelectorAll('#events [data-status="in_progress"]').length,
    ended: document.querySelectorAll('#events [data-status="ended"]').length }));
  assert.equal(after.buttons, 0, 'the answered request still shows its buttons');
  assert.equal(after.ask, false, 'the question is still open after its turn ended');
  assert.equal(after.spin, 0, 'the tool still spins after its turn ended');
  assert.equal(after.ended, 1, 'the tool is not drawn as ended');
  console.log('PASS O145: answered request, closed ask and ended tool all drawn again ' + JSON.stringify({ before, after }));
});

// O145 step 2: the phone folds only a poll's new events onto the blocks it has. A block an earlier poll drew and a later
// event changes (a reply still streaming, one tool of a folded group, a request the turn's end leaves unanswered) is drawn
// again, and the chat drawn poll by poll is the chat a fresh read draws.
test('O145 step 2: blocks changed by a later poll are drawn again, same as a fresh read', { timeout: 180000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  const ledger = db(server);
  ledger.prepare('INSERT INTO conversations (id, provider, title, state, created) VALUES (?, ?, ?, ?, ?)').run(A, 'claude', 'Chat O145', 'idle', Date.now());
  ledger.close();
  const tool = (id) => ['update', { sessionUpdate: 'tool_call', toolCallId: id, title: 'Step ' + id, kind: 'execute', status: 'in_progress' }];
  append(server, [['user', { text: 'go' }], tool('t1'), tool('t2'), tool('t3'), ['update', { sessionUpdate: 'agent_message_chunk', content: { text: 'Hello' } }], ['error', { message: 'mark 1' }]]);
  const { page } = await phone(t, server);
  await page.waitForSelector('h1:text("Chats")');
  await page.goto(server.origin + '/phone/#chat=' + A);
  await page.waitForSelector('#events :text("mark 1")', { timeout: 15000 });
  // Each poll ends with a new mark: it is drawn whether or not the blocks before it are, so the wait never decides the result.
  let poll = async (n, events) => { append(server, [...events, ['error', { message: 'mark ' + n }]]); await page.waitForSelector(`#events :text("mark ${n}")`, { timeout: 30000 }); };
  // Poll 2: the reply streams on after a note, one tool of the group finishes, an approval waits.
  await poll(2, [['update', { sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'completed' }],
    ['approval', { request: 'r2', toolCall: { title: 'Write it' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] }]]);
  // Poll 3: a new reply (no mark after it, a mark would end the reply), then its second chunk in the next poll. That poll is
  // waited for by the events response that carries it, which comes whether or not the page draws it.
  append(server, [['update', { sessionUpdate: 'agent_message_chunk', content: { text: 'Second' } }]]);
  const carries = (text) => page.waitForResponse(async (response) => response.url().includes('/chat/events') && (await response.text().catch(() => '')).includes(text), { timeout: 30000 });
  await carries('Second');
  const part = carries(' part'); append(server, [['update', { sessionUpdate: 'agent_message_chunk', content: { text: ' part' } }]]); await part;
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const mid = await page.evaluate(() => ({ group: document.querySelectorAll('#events article[data-kind="group"] [data-status="completed"]').length,
    reply: [...document.querySelectorAll('#events article[data-kind="agent"]')].map((node) => node.textContent.trim()), buttons: document.querySelectorAll('#events [data-request="r2"]').length }));
  // Poll 5: the turn ends with the approval unanswered and two tools still running.
  await poll(5, [['turn-end', { stopReason: 'end_turn' }]]);
  const drawn = () => page.evaluate(() => ({ html: document.querySelector('#events').innerHTML.replace(/\s+/g, ' '),
    buttons: document.querySelectorAll('#events [data-request="r2"]').length, notAnswered: !!document.querySelector('#events :is(article)')?.closest('#events')?.textContent.includes('Write it · not answered'),
    spin: document.querySelectorAll('#events [data-status="in_progress"]').length }));
  const live = await drawn();
  await page.reload(); await page.waitForSelector('#events :text("mark 5")', { timeout: 30000 });
  const fresh = await drawn();
  assert.equal(mid.group, 1, 'the finished tool in the group was not drawn again');
  assert.deepEqual(mid.reply, ['Hello', 'Second part'], 'a reply that streamed on in a later poll was not drawn again');
  assert.equal(mid.buttons, 1, 'the waiting approval has no button');
  assert.equal(live.buttons, 0, 'the unanswered request still shows its button after its turn ended');
  assert.ok(live.notAnswered, 'the unanswered request is not marked not answered');
  assert.equal(live.spin, 0, 'a tool still spins after its turn ended');
  assert.equal(live.html, fresh.html, 'the chat drawn poll by poll differs from a fresh read');
  console.log('PASS O145 step 2: streamed reply, group tool, unanswered request drawn again; poll by poll = fresh ' + JSON.stringify({ mid, blocks: (live.html.match(/<article/g) ?? []).length }));
});
