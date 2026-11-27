// O270: a background Agent's command rows (tool calls marked with the parentToolUseId that started them) can land between
// the pieces of one reply. They cut the reply in two, so a fenced artifact lost its closing fence and its HTML printed as
// text. The pieces of one message (messageId) now stay one reply, with the other agent's rows after it. A new message,
// or the reply's own row, still starts a new block. The test writes the events into the ledger itself, a few per poll,
// as chat-finished-held.test.mjs does, then reloads so the same turn is checked from history too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { _electron } from '@playwright/test';
import { daemon, http, authenticated, root } from './helpers.mjs';

const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((result) => JSON.parse(result.text));

// The daemon's events as chat.mjs writes them from the adapter.
const say = (text, messageId) => ['update', { sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } }];
const row = (toolCallId, title, sub) => ['update', { sessionUpdate: 'tool_call', toolCallId, title, kind: 'execute', status: 'pending', ...(sub && { _meta: { claudeCode: { toolName: 'Bash', parentToolUseId: 'toolu_helper' } } }) }];
const done = (toolCallId) => ['update', { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' }];

test('O270: another agent\'s rows inside one reply leave its fenced artifact whole, live and from history', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', path.join(root, 'test/fake-acp-agent.mjs')] }));
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-o270-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('#dataNote', { hasText: 'Chat live' }).waitFor({ timeout: 20000 });
  const id = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  const waker = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  await page.locator('#nav .row[data-chat="' + id + '"]').click();
  const pane = page.locator('#chats .pane[data-id="' + id + '"]');
  await pane.waitFor({ timeout: 15000 });
  const db = new DatabaseSync(path.join(instance.directory, '.local', 'state', 'p9-foundation', 'p9.db'), { timeout: 5000 });
  t.after(() => db.close());
  const add = db.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)');
  let wakes = 0;
  const poll = async (drawn, ...events) => {
    db.exec('BEGIN');
    for (const [type, data] of events) add.run(id, type, JSON.stringify(data), Date.now());
    db.exec('COMMIT');
    await call(instance, '/chat/' + waker + '/rename', 'POST', { title: 'wake ' + ++wakes });
    await pane.locator(drawn).first().waitFor({ timeout: 20000 });
  };
  // One reply streams a fenced html artifact in pieces; the other agent's rows come between them, cutting a tag in two.
  await poll('text=Phase checklist', ['user', { text: 'post the checklist' }],
    say('Here is the checklist.\n```html artifact pinned Phase checklist\n<!doctype html><details class=x><summ', 'msg_a'), row('sub-1', 'cd /work/one && make', true));
  await poll('details.tool >> text=cd /work/two', say('ary><span>One</span></summary><div class=body>done</div></details>\n<details class=x><summary', 'msg_a'),
    done('sub-1'), row('sub-2', 'cd /work/two && make', true), done('sub-2'));
  await poll('text=That is the list.', say('><span>Two</span></summary></details>\n```\nThat is the list.', 'msg_a'));
  // A new message after the other agent's row is a new reply; the reply's own row splits it as before.
  await poll('text=Own row after.', row('sub-3', 'cd /work/three && make', true), say('A new message.', 'msg_b'),
    row('own-1', 'git status', false), say('Own row after.', 'msg_b'), ['turn-end', { stopReason: 'end_turn' }]);

  const check = async (where) => {
    await pane.locator('.msg.agent', { hasText: 'Own row after.' }).waitFor({ timeout: 20000 });
    const replies = await pane.locator('.hist .msg.agent').evaluateAll((els) => els.map((el) => el.innerText));
    assert.equal(replies.filter((r) => r.includes('<details') || r.includes('<span>') || r.includes('```')).length, 0, where + ': no reply shows the artifact\'s HTML as text: ' + JSON.stringify(replies));
    assert.equal(await pane.locator('.hist [data-artifact]').count(), 1, where + ': the artifact is one chip');
    assert.equal(replies.length, 3, where + ': three replies (the artifact reply, the new message, its piece after its own row): ' + JSON.stringify(replies));
    assert.ok(replies[0].includes('Here is the checklist.') && replies[0].includes('That is the list.'), where + ': the artifact reply is one block');
    // The other agent's rows sit after the reply they came inside, the own row between the two pieces of msg_b.
    const order = await pane.locator('.hist .msg.agent, .hist details.tool').evaluateAll((els) => els.map((el) => el.matches('.msg.agent') ? 'reply' : el.querySelector('.ttl').textContent));
    assert.deepEqual(order, ['reply', 'cd /work/one && make', 'cd /work/two && make', 'cd /work/three && make', 'reply', 'git status', 'reply'], where + ': rows in order');
  };
  await check('live');
  await page.reload();
  await page.locator('#nav .row[data-chat="' + id + '"]').click();
  await check('history');
  assert.deepEqual(errors, []);
  console.log('PASS O270: one artifact chip, no raw HTML, 3 replies, rows after the reply (live and from history)');
});
