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
