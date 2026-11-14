import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { remoteDaemon } from './helpers.mjs';
import { phone } from './phone-c16-helpers.mjs';

// The phone audit's fixes (O61 to O65). Each test fails on main 6f52cef.
const A = '00000000-0000-4000-8000-0000000000a1', B = '00000000-0000-4000-8000-0000000000b2';
const shots = process.env.P9_SCREENSHOTS || '/tmp';
const shot = async (page, name) => { const png = await page.screenshot({ type: 'png', path: shots + '/' + name + '.png' }); if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png.toString('base64')); };
const db = (server) => new DatabaseSync(path.join(server.directory, '.local', 'state', 'p9-foundation', 'p9.db'));
// Chats the daemon never ran, written straight into its ledger: [type, data] rows.
function seed(server, id, title, events) {
  const ledger = db(server);
  ledger.prepare('INSERT INTO conversations (id, provider, title, state, created) VALUES (?, ?, ?, ?, ?)').run(id, 'claude', title, 'idle', Date.now());
  append(ledger, id, events); ledger.close();
}
function append(ledger, id, events) {
  const event = ledger.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)');
  ledger.exec('BEGIN'); for (const [type, data] of events) event.run(id, type, JSON.stringify(data), Date.now()); ledger.exec('COMMIT');
}
const later = (server, id, events) => { const ledger = db(server); append(ledger, id, events); ledger.close(); };
const turn = (text, ...more) => [['user', { text }], ['update', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Reply to ' + text } }], ...more, ['turn-end', { stopReason: 'end_turn' }]];
const settings = (extra = []) => ['config', { model: { current: 'm1', options: [{ value: 'm1', name: 'Model one' }, { value: 'm2', name: 'Model two' }] },
  pickers: [{ id: 'effort', name: 'Effort', current: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }, ...extra] }] }];
async function open(page, server, id) {
  await page.waitForSelector('h1:text("Chats")');
  await page.goto(server.origin + '/phone/#chat=' + id);
  await page.waitForSelector('#prompt', { state: 'visible', timeout: 15000 });
  await page.waitForSelector('#events > *', { timeout: 15000 });
}
const go = async (page, server, id) => { await page.goto(server.origin + '/phone/#chat=' + id); await page.waitForFunction((id) => document.querySelector('#conversation').value === id, id); await page.waitForTimeout(300); };
// The prompt route answered here, every attempt kept; 'hang' never answers, 'drop' fails the connection.
async function prompts(page, answers) {
  const attempts = [];
  await page.route('**/chat/*/prompt', (route) => {
    const request = route.request(), answer = answers[Math.min(attempts.length, answers.length - 1)];
    attempts.push({ chat: new URL(request.url()).pathname.split('/')[2], op: request.headers()['x-p9-op'], body: request.postDataJSON() });
    if (answer === 'hang') return;
    if (answer === 'drop') return route.abort('connectionfailed');
    return route.fulfill({ status: answer, contentType: 'application/json', body: JSON.stringify(answer === 202 ? { accepted: true } : { error: 'refused' }) });
  });
  return attempts;
}
const pick = (page, value) => page.evaluate((value) => { const select = document.querySelector('#pickers select[data-config="effort"]'); select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); }, value);

test('O61: each chat keeps its own unsent text', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  seed(server, A, 'Chat A', turn('hello a')); seed(server, B, 'Chat B', turn('hello b'));
  const { page } = await phone(t, server);
  await open(page, server, A);
  await page.fill('#prompt', 'only for A');
  await go(page, server, B);
  assert.equal(await page.inputValue('#prompt'), '', "chat A's text is in chat B's box");
  await page.fill('#prompt', 'only for B');
  await go(page, server, A);
  assert.equal(await page.inputValue('#prompt'), 'only for A', "chat A's text was not kept for it");
  await page.waitForTimeout(600); await page.reload(); await page.waitForSelector('#prompt', { state: 'visible', timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('#prompt').value === 'only for A', null, { timeout: 15000 });
  await go(page, server, B);
  assert.equal(await page.inputValue('#prompt'), 'only for B', "chat B's text did not survive the reload");
  console.log('PASS O61: A and B each kept their own text, across a chat switch and a reload');
});

test('O62: a send that fails says why, and the text stays', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  seed(server, A, 'Chat A', turn('hello a'));
  const { page } = await phone(t, server);
  const attempts = await prompts(page, ['drop', 202]);
  await open(page, server, A);
  await page.fill('#prompt', 'does this arrive');
  await page.click('#send', { force: true });
  await page.waitForFunction(() => !document.querySelector('#composerNote').hidden, null, { timeout: 10000 }).catch(() => {});
  const said = await page.locator('#composerNote').textContent();
  assert.match(said, /Not sent yet: P9 could not be reached/, 'a failed send said nothing');
  assert.equal(await page.inputValue('#prompt'), 'does this arrive');
  await page.click('#send', { force: true });
  await page.waitForFunction(() => document.querySelector('#prompt').value === '', null, { timeout: 10000 });
  assert.equal(attempts.length, 2); assert.equal(attempts[1].op, attempts[0].op, 'the retry was a new operation: it could arrive twice');
  console.log('PASS O62: a dropped send wrote "' + said + '" then the retry went with the same operation ID');
});

test('O62: a send with no answer is the same send after a reload', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  seed(server, A, 'Chat A', [settings(), ...turn('hello a')]);
  const { page } = await phone(t, server);
  const attempts = await prompts(page, ['hang', 202]);
  await open(page, server, A);
  await page.waitForSelector('#pickers select[data-config="effort"]', { state: 'attached', timeout: 15000 });
  await pick(page, 'high');
  await page.fill('#prompt', 'sent before the reload');
  await page.waitForTimeout(600); // the draft is written once typing pauses
  await page.click('#send', { force: true });
  await page.waitForFunction(() => true); while (!attempts.length) await page.waitForTimeout(100);
  await page.reload(); await page.waitForSelector('#prompt', { state: 'visible', timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('#prompt').value === 'sent before the reload', null, { timeout: 15000 });
  await page.waitForSelector('#pickers select[data-config="effort"]', { state: 'attached', timeout: 15000 });
  await page.click('#send', { force: true });
  await page.waitForFunction(() => document.querySelector('#prompt').value === '', null, { timeout: 10000 });
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[1].body, attempts[0].body, 'the retry after a reload is a different message');
  assert.equal(attempts[1].op, attempts[0].op, 'the retry after a reload has a new operation ID: the daemon would run it twice');
  assert.deepEqual(attempts[0].body.config, { effort: 'high' });
  console.log('PASS O62: after a reload the retry had the same body and operation ID ' + attempts[0].op);
});

test('O62: the message goes to the chat on screen, whatever the chat list says', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  seed(server, A, 'Chat A', turn('hello a'));
  const { page } = await phone(t, server);
  const attempts = await prompts(page, [202]);
  await open(page, server, A);
  await page.fill('#prompt', 'to the open chat');
  // Stands in for the open chat having left the list (stopped before its first message, or closed): the select then has no option for it.
  // Emptied and sent in one step, so a list refresh cannot put the option back in between.
  await page.evaluate(() => { const select = document.querySelector('#conversation'); select.innerHTML = '<option value="">No conversations yet</option>'; document.querySelector('#send').click(); });
  for (let i = 0; i < 100 && !attempts.length; i++) await page.waitForTimeout(100);
  await page.waitForTimeout(500);
  assert.deepEqual(attempts.map((attempt) => [attempt.chat, attempt.body.text]), [[A, 'to the open chat']], 'the send did not go to the open chat');
  console.log('PASS O62: sent to the open chat with the list select empty');
});

test('O64: an unsent pick survives the agent reporting its settings, and is sent', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  seed(server, A, 'Chat A', [settings(), ...turn('hello a')]);
  const { page } = await phone(t, server);
  const attempts = await prompts(page, [202]);
  await open(page, server, A);
  await page.waitForSelector('#pickers select[data-config="effort"]', { state: 'attached', timeout: 15000 });
  await pick(page, 'high');
  later(server, A, [settings([{ value: 'max', name: 'Max' }])]); // the agent reports its settings again: the pickers are rebuilt
  await page.waitForFunction(() => document.querySelectorAll('#pickers select[data-config="effort"] option').length === 3, null, { timeout: 30000 });
  assert.equal(await page.locator('#pickers select[data-config="effort"]').inputValue(), 'high', 'the pick was wiped by the rebuild');
  await page.fill('#prompt', 'with my pick');
  await page.click('#send', { force: true });
  await page.waitForFunction(() => document.querySelector('#prompt').value === '', null, { timeout: 10000 });
  assert.deepEqual(attempts[0].body.config, { effort: 'high' }, 'the pick was not in the request');
  // A pick made while a send is on its way belongs to the next message: the first send's answer must not clear it.
  await page.unroute('**/chat/*/prompt');
  let release; const held = new Promise((done) => { release = done; }), next = [];
  await page.route('**/chat/*/prompt', async (route) => { next.push(route.request().postDataJSON()); if (next.length === 1) await held; return route.fulfill({ status: 202, contentType: 'application/json', body: '{"accepted":true}' }); });
  await pick(page, 'low'); await pick(page, 'high');
  await page.fill('#prompt', 'first of two'); await page.click('#send', { force: true });
  while (!next.length) await page.waitForTimeout(100);
  await pick(page, 'max'); release();
  await page.waitForFunction(() => document.querySelector('#prompt').value === '', null, { timeout: 10000 });
  later(server, A, [settings([{ value: 'max', name: 'Max' }, { value: 'xl', name: 'Extra' }])]); // a redraw, the agent still reporting low
  await page.waitForFunction(() => document.querySelectorAll('#pickers select[data-config="effort"] option').length === 4, null, { timeout: 30000 });
  assert.equal(await page.locator('#pickers select[data-config="effort"]').inputValue(), 'max', "a pick made during a send was cleared by that send's answer");
  console.log('PASS O64: the pick survived a rebuild and went out as ' + JSON.stringify(attempts[0].body.config));
});

test('O65: a cancelled turn leaves no tool spinning', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  seed(server, A, 'Chat A', [['user', { text: 'run the tests' }],
    ['update', { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run the tests', kind: 'execute', status: 'in_progress' }],
    ['turn-end', { stopReason: 'cancelled' }]]);
  const { page } = await phone(t, server);
  await open(page, server, A);
  await page.waitForSelector('#events :text("Turn ended · cancelled")', { timeout: 15000 });
  await shot(page, 'phone-o65-cancelled');
  assert.equal(await page.locator('#events [data-status=in_progress], #events [data-status=pending]').count(), 0, 'a tool still spins after the turn was cancelled');
  assert.equal(await page.locator('#events [data-status=ended]').count(), 1);
  console.log('PASS O65: no tool block is pending or in progress after "Turn ended · cancelled"');
});

const gap = (page) => page.evaluate(() => { const body = document.querySelector('#chatBody'); return Math.round(body.scrollHeight - body.scrollTop - body.clientHeight); });
test('O63: typing at the bottom of a chat does not move it', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  seed(server, A, 'Chat A', Array.from({ length: 12 }, (_, i) => turn('message ' + i + ' ' + 'word '.repeat(40))).flat());
  const { page } = await phone(t, server);
  await open(page, server, A);
  await page.waitForFunction(() => { const body = document.querySelector('#chatBody'); return body.scrollHeight > body.clientHeight + 200 && body.scrollHeight - body.scrollTop - body.clientHeight < 2; }, null, { timeout: 15000 });
  await page.focus('#prompt');
  const gaps = [];
  for (const key of ['o', 'n', 'e', 'Shift+Enter', 't', 'w', 'o', 'Shift+Enter', 't', 'h', 'r', 'e', 'e']) { await page.keyboard.press(key); gaps.push(await gap(page)); }
  assert.equal(await page.inputValue('#prompt'), 'one\ntwo\nthree');
  assert.ok(Math.max(...gaps) <= 1, 'the chat left the bottom while typing; px from the bottom after each key: ' + gaps.join(','));
  console.log('PASS O63: px from the bottom after each of 13 keys: ' + gaps.join(','));
});

test('O63: a reader keeps their place, and an opened tool stays open, when earlier messages load', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  const tool = [['update', { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read the notes', kind: 'read', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'line\n'.repeat(12) } }] }]];
  seed(server, A, 'Chat A', [...Array.from({ length: 60 }, (_, i) => turn('message ' + i + ' ' + 'word '.repeat(30))).flat(), ...turn('the one with a tool', ...tool), ...turn('after ' + 'word '.repeat(60)), ...turn('last ' + 'word '.repeat(60))]);
  const { page } = await phone(t, server);
  await open(page, server, A);
  await page.addStyleTag({ content: '#chatBody{overflow-anchor:none}' }); // as a browser that does not hold a reader's place by itself
  const row = page.locator('#events [data-kind=tool]').first();
  await row.waitFor({ timeout: 15000 });
  await row.evaluate((node) => { node.scrollIntoView({ block: 'center' }); node.querySelector('details').open = true; });
  await page.waitForTimeout(400);
  const read = () => row.evaluate((node) => ({ top: Math.round(node.getBoundingClientRect().top), open: node.querySelector('details').open, attached: node.isConnected, blocks: document.querySelectorAll('#events > [data-key]').length }));
  const before = await read();
  await page.evaluate(() => document.querySelector('#earlier').click());
  await page.waitForFunction((n) => document.querySelectorAll('#events > [data-key]').length > n, before.blocks, { timeout: 20000 });
  await page.waitForTimeout(400);
  const now = page.locator('#events [data-kind=tool]').first(), after = await now.evaluate((node) => ({ top: Math.round(node.getBoundingClientRect().top), open: node.querySelector('details').open }));
  const same = await row.evaluate((node) => node.isConnected).catch(() => false);
  await shot(page, 'phone-o63-reader');
  assert.ok(Math.abs(after.top - before.top) <= 2, `the tool row moved ${after.top - before.top} px when earlier messages loaded`);
  assert.equal(after.open, true, 'the tool the reader opened was closed by loading earlier messages');
  console.log(`PASS O63: earlier messages loaded (${before.blocks} blocks before), the tool row stayed at ${after.top} px and open; same node kept: ${same}`);
});
