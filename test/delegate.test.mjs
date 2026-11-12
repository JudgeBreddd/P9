import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { once } from 'node:events';
import { daemon, restart, http, authenticated, root } from './helpers.mjs';
// The real MCP SDK client, as in mcp.test.mjs: the tools are called the way an agent's adapter calls them.
import { Client } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
// profile.log in the workspace: the stand-in writes there what provider settings each agent start was given (a hash, never the key).
const boot = (t) => daemon(t, undefined, false, async ({ workspace }) => { fs.writeFileSync(path.join(workspace, 'profile.log'), ''); return { args: ['--acp-override', fake] }; });
// Settings > Delegation starts on Ask me first; these tests are about the tools, so they run on Agent decides (the
// Delegation test below boots without it).
const ROW = { agent: '', model: '', effort: '' }, five = (...set) => Array.from({ length: 5 }, (_, i) => set[i] ?? ROW);
const start = async (t) => { const instance = await boot(t); await call(instance, '/delegation', 'POST', { start: 'agent', max: 20, workers: [] }); return instance; };
const call = (instance, route, method = 'GET', body) => http({ socketPath: instance.credentials.socketPath, route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  .then((result) => ({ ...result, body: result.text ? JSON.parse(result.text) : null }));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(instance, match, after = 0) {
  for (let i = 0; i < 40; i += 1) {
    const { body } = await call(instance, `/chat/events?after=${after}&wait=2000`);
    after = body.cursor;
    const hit = body.events.find(match);
    if (hit) return { hit, cursor: after };
  }
  throw new Error('event-timeout');
}
const events = async (instance, id) => (await call(instance, '/chat/events?after=0&only=' + id)).body.events;
// A chat the user made, and the SDK client started from the MCP entry its agent was handed.
async function agent(t, instance, more = {}) {
  const { body: { conversation } } = await call(instance, '/chat', 'POST', { provider: 'claude', ...more });
  await call(instance, `/chat/${conversation}/prompt`, 'POST', { text: 'mcp' });
  return connect(t, instance, conversation);
}
// The same client for a chat that was already sent 'mcp' (a worker whose task was that word).
async function connect(t, instance, conversation) {
  const { hit, cursor } = await until(instance, (event) => event.conversation === conversation && event.data?.content?.text?.startsWith('mcp:'));
  const [entry] = JSON.parse(hit.data.content.text.slice(4));
  const client = new Client({ name: 'p9-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env: Object.fromEntries(entry.env.map(({ name, value }) => [name, value])) }));
  t.after(() => client.close());
  const tool = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  // Waits until the chat's turn has ended, however many 50 s calls that takes.
  const done = async (chat) => { for (;;) { const got = await tool('wait_chat', { chat }); if (!got.timedOut) return got; } };
  return { conversation, tool, done, cursor };
}
const rows = async (instance) => (await call(instance, '/chat')).body.conversations;
const notices = async (instance, id) => (await events(instance, id)).filter((e) => e.type === 'user' && e.data.from === 'p9').map((e) => e.data.text);

test('Delegate: open_chat asks the user first; the worker is an ordinary chat with its parent kept; the same key makes one chat; a mode wider than the sender is refused', { timeout: 120000 }, async (t) => {
  const instance = await start(t);
  const a = await agent(t, instance);
  const approval = (after) => until(instance, (event) => event.conversation === a.conversation && event.type === 'approval', after);
  const answer = (request, optionId) => call(instance, `/chat/${a.conversation}/answer`, 'POST', { request, answer: { optionId } });

  // File protection is on in a new install, so P9 asks in the parent's chat. Reject: nothing is made.
  let pending = a.tool('open_chat', { text: 'mode', title: 'Kid', key: 'kid-1', mode: 'Plan' });
  let asked = await approval(a.cursor);
  assert.match(asked.hit.data.toolCall.title, /^P9 Delegate: start a Claude worker "Kid" in mode Plan\. Its task: mode$/);
  await answer(asked.hit.data.request, 'reject');
  assert.equal((await pending).error, 'not-allowed');
  assert.equal((await rows(instance)).length, 1, 'a rejected open_chat made no chat');

  // Allow: one chat, started by this one, working in Plan (narrower than the parent's Manual).
  pending = a.tool('open_chat', { text: 'mode', title: 'Kid', key: 'kid-1', mode: 'Plan' });
  asked = await approval(asked.cursor);
  await answer(asked.hit.data.request, 'allow');
  const made = await pending;
  assert.match(made.chat, /^[0-9a-f-]{36}$/);
  assert.equal(made.mode, 'Plan');
  assert.equal(typeof made.folder, 'string');
  const first = await a.done(made.chat);
  assert.deepEqual([first.state, first.ended, first.waiting, first.last], ['idle', true, null, 'mode:plan']);
  const kid = (await rows(instance)).find((c) => c.id === made.chat);
  assert.equal(kid.parent, a.conversation);
  assert.equal(kid.title, 'Kid');
  const sent = (await events(instance, made.chat)).find((e) => e.type === 'user');
  assert.equal(sent.data.from, a.conversation, 'the message says which chat sent it');
  assert.equal((await events(instance, made.chat)).find((e) => e.type === 'created').data.parent, a.conversation);

  // The same key from the same parent: the chat it made, no second one and no second question.
  const again = await a.tool('open_chat', { text: 'mode', key: 'kid-1' });
  assert.deepEqual([again.chat, again.existing], [made.chat, true]);
  assert.equal((await rows(instance)).length, 2);

  // Wider than the sender (Manual): refused before the user is asked. A bad key and an empty task the same.
  assert.equal((await a.tool('open_chat', { text: 'x', mode: 'Auto' })).error, 'mode-escalation');
  assert.equal((await a.tool('open_chat', { text: 'x', mode: 'Bypass permissions' })).error, 'mode-escalation');
  assert.equal((await a.tool('open_chat', { text: 'x', mode: 'nope' })).error, 'request-refused');
  assert.equal((await a.tool('open_chat', { text: 'x', key: 'Not A Key' })).error, 'request-refused');
  assert.equal((await a.tool('open_chat', { text: '' })).error, 'request-refused');
  assert.equal((await rows(instance)).length, 2);
  // A folder outside the workspace: you allow the start, and the folder check a chat of your own gets still refuses it.
  for (const folder of ['../', '/etc']) {
    pending = a.tool('open_chat', { text: 'x', folder });
    asked = await approval(asked.cursor);
    await answer(asked.hit.data.request, 'allow');
    assert.equal((await pending).error, 'folder-refused', folder);
  }
  assert.equal((await rows(instance)).length, 2, 'a refused folder made a chat');
  // File protection on: a parent's answer to its worker's approval is asked of the user in the parent's chat first.
  await call(instance, `/chat/${made.chat}/prompt`, 'POST', { text: 'permission' });
  await until(instance, (event) => event.conversation === made.chat && event.type === 'approval');
  const waits = (await a.tool('wait_chat', { chat: made.chat, timeoutMs: 0 })).waiting;
  assert.equal(waits?.kind, 'approval');
  pending = a.tool('answer_chat', { chat: made.chat, request: waits.request, answer: { optionId: 'allow' } });
  asked = await approval(asked.cursor);
  assert.match(asked.hit.data.toolCall.title, /^P9 Delegate: answer "allow" to the approval "Kid" waits on: Write marker$/);
  await answer(asked.hit.data.request, 'reject');
  assert.equal((await pending).error, 'not-allowed');
  await pause(300);
  assert.equal((await a.tool('wait_chat', { chat: made.chat, timeoutMs: 0 })).waiting?.kind, 'approval', 'a refused answer still reached the worker');
  pending = a.tool('answer_chat', { chat: made.chat, request: waits.request, answer: { optionId: 'allow' } });
  asked = await approval(asked.cursor);
  await answer(asked.hit.data.request, 'allow');
  assert.deepEqual(await pending, { chat: made.chat, action: 'answered' });
  assert.equal((await a.done(made.chat)).last, 'permission:allow');
  // The HTTP route cannot name a parent: lineage comes only from the tool.
  const typed = await call(instance, '/chat', 'POST', { provider: 'claude', parent: a.conversation, key: 'x' });
  assert.ok(typed.status !== 201 || !(await rows(instance)).find((c) => c.id === typed.body.conversation).parent, 'a request body set a parent');
  console.log('PASS Delegate open_chat: reject made nothing, allow made one Plan chat with its parent, the key returned it again, wider modes refused unasked');
});

test('Delegate: send, wait, read, list and stop reach a chat\'s own workers; another chat sees none of them; an approval stays the user\'s; the lock refuses', { timeout: 180000 }, async (t) => {
  const instance = await start(t);
  await call(instance, '/file-protection', 'POST', { on: false }); // Unrestricted: open_chat does not ask
  const a = await agent(t, instance), b = await agent(t, instance);
  const made = await a.tool('open_chat', { text: 'hello', title: 'Kid', key: 'kid' });
  assert.equal(made.mode, 'Manual', 'left out, the mode is the parent\'s');
  assert.equal((await a.done(made.chat)).last, 'echo:hello');

  // send_chat then read_chat: what it was sent (and by whom) and what it replied; next carries on.
  assert.equal((await a.tool('send_chat', { chat: made.chat, text: 'second' })).sent, 'started a turn');
  assert.equal((await a.done(made.chat)).last, 'echo:second');
  const read = await a.tool('read_chat', { chat: made.chat });
  assert.deepEqual(read.messages.map((m) => [m.role, m.text, m.from]), [['user', 'second', a.conversation], ['assistant', 'echo:second', undefined]]);
  assert.deepEqual((await a.tool('read_chat', { chat: made.chat, after: read.next })).messages, []);
  assert.deepEqual((await a.tool('read_chat', { chat: made.chat, after: 0 })).messages.filter((m) => m.role === 'user').map((m) => m.text), ['hello', 'second']);

  // list_chats: the parent sees its worker; a general chat sees nothing of another general chat.
  const listed = await a.tool('list_chats');
  assert.deepEqual(listed.chats.map((c) => [c.id, c.key, c.parent, c.yours]), [[made.chat, 'kid', a.conversation, true]]);
  assert.deepEqual((await b.tool('list_chats')).chats, []);
  for (const [name, args] of [['read_chat', {}], ['wait_chat', {}], ['send_chat', { text: 'x' }], ['stop_chat', {}], ['answer_chat', { request: 'r', answer: {} }]]) {
    assert.equal((await b.tool(name, { chat: made.chat, ...args })).error, 'chat-not-found', name + ' from another chat');
    assert.equal((await a.tool(name, { chat: b.conversation, ...args })).error, 'chat-not-found', name + ' on a chat it did not start');
  }
  assert.equal((await a.tool('read_chat', { chat: a.conversation })).error, 'chat-not-found', 'a chat is not its own target');
  assert.deepEqual((await events(instance, made.chat)).filter((e) => e.type === 'user').map((e) => e.data.text), ['hello', 'second'], 'the refused sends reached nothing');

  // A question the worker asks: its parent may answer. An approval: only the user.
  await a.tool('send_chat', { chat: made.chat, text: 'ask' });
  let got = await a.tool('wait_chat', { chat: made.chat });
  assert.deepEqual([got.state, got.ended, got.waiting?.kind, got.waiting?.text], ['working', false, 'question', 'Pick a colour']);
  assert.deepEqual(await a.tool('answer_chat', { chat: made.chat, request: got.waiting.request, answer: { action: 'accept', content: { colour: 'red' } } }), { chat: made.chat, action: 'answered' });
  assert.match((await a.done(made.chat)).last, /^ask:.*red/);
  assert.equal((await events(instance, made.chat)).find((e) => e.type === 'answered').data.from, a.conversation, 'the answer says which chat gave it');
  await a.tool('send_chat', { chat: made.chat, text: 'permission' });
  got = await a.tool('wait_chat', { chat: made.chat });
  assert.equal(got.waiting?.kind, 'approval');
  // Unrestricted: the parent answers its worker's approval unasked; a chat that did not start it cannot.
  assert.equal((await b.tool('answer_chat', { chat: made.chat, request: got.waiting.request, answer: { optionId: 'allow' } })).error, 'chat-not-found');
  assert.deepEqual(await a.tool('answer_chat', { chat: made.chat, request: got.waiting.request, answer: { optionId: 'allow' } }), { chat: made.chat, action: 'answered' });
  assert.equal((await a.done(made.chat)).last, 'permission:allow');
  assert.equal((await events(instance, made.chat)).filter((e) => e.type === 'answered').at(-1).data.from, a.conversation, 'the approval\'s answer says which chat gave it');

  // wait_chat's timeout stops nothing; stop_chat interrupts the turn, and with close stops the chat.
  await a.tool('send_chat', { chat: made.chat, text: 'slow' });
  got = await a.tool('wait_chat', { chat: made.chat, timeoutMs: 400 });
  assert.deepEqual([got.state, got.ended, got.timedOut], ['working', false, true]);
  assert.equal((await a.tool('wait_chat', { chat: made.chat, timeoutMs: 0 })).state, 'working', 'the timeout stopped nothing');
  assert.deepEqual(await a.tool('stop_chat', { chat: made.chat }), { chat: made.chat, action: 'interrupted', chats: [made.chat] });
  assert.equal((await a.done(made.chat)).state, 'idle');
  assert.deepEqual(await a.tool('stop_chat', { chat: made.chat, close: true }), { chat: made.chat, action: 'stopped', chats: [made.chat] });
  assert.equal((await a.tool('wait_chat', { chat: made.chat })).state, 'stopped');

  // The agent lock: nothing is started, sent or answered; reading still works.
  await call(instance, '/agent-lock', 'POST', { on: true });
  assert.equal((await a.tool('open_chat', { text: 'x' })).error, 'agent-lock-on');
  assert.equal((await a.tool('send_chat', { chat: made.chat, text: 'x' })).error, 'agent-lock-on');
  assert.equal((await a.tool('answer_chat', { chat: made.chat, request: 'r', answer: {} })).error, 'agent-lock-on');
  assert.equal((await a.tool('read_chat', { chat: made.chat, after: 0 })).messages[0].text, 'hello');
  assert.equal((await rows(instance)).length, 3);
  console.log('PASS Delegate tools: sent, waited, read and listed its own worker; another chat got chat-not-found on all five; question answered, approval refused; timeout stopped nothing; lock refused');
});

test('Delegate: a finished worker tells its running parent in one line, not while the parent waits on it; a stopped parent is not started', { timeout: 120000 }, async (t) => {
  const instance = await start(t);
  await call(instance, '/file-protection', 'POST', { on: false });
  const a = await agent(t, instance);
  // The parent waits on it from before the turn ends: wait_chat's own answer is the news, so no notice.
  const made = await a.tool('open_chat', { text: 'late', title: 'Kid' });
  assert.equal((await a.done(made.chat)).last, 'late reply');
  await pause(500);
  assert.deepEqual(await notices(instance, a.conversation), [], 'a notice was sent while wait_chat was open');
  // Not waiting: one line, marked as P9's, in the parent's chat.
  await a.tool('send_chat', { chat: made.chat, text: 'late' });
  await until(instance, (event) => event.conversation === a.conversation && event.type === 'user' && event.data.from === 'p9');
  assert.deepEqual(await notices(instance, a.conversation), ['[p9] Kid finished: late reply']);
  await until(instance, (event) => event.conversation === a.conversation && event.data?.content?.text === 'echo:[p9] Kid finished: late reply');
  // A stopped parent is not woken.
  await call(instance, `/chat/${a.conversation}/stop`, 'POST', {});
  const before = (await events(instance, a.conversation)).length;
  await call(instance, `/chat/${made.chat}/prompt`, 'POST', { text: 'late' });
  await until(instance, (event) => event.conversation === made.chat && event.type === 'turn-end' , (await events(instance, made.chat)).at(-1).cursor);
  await pause(500);
  assert.equal((await notices(instance, a.conversation)).length, 1, 'a stopped parent was sent a notice');
  assert.ok(!(await events(instance, a.conversation)).slice(before).some((e) => e.type === 'connected'), 'a stopped parent was started');
  console.log('PASS Delegate notice: none while waited on, one line to a running parent, none to a stopped one');
});

test('Delegate: chats in one project read and message each other but stop only their own workers; a worker starts in its parent\'s project', { timeout: 120000 }, async (t) => {
  const instance = await start(t);
  await call(instance, '/file-protection', 'POST', { on: false });
  const project = (await call(instance, '/projects', 'POST', { name: 'Fresh', work: { kind: 'new', parent: '', name: 'fresh' } })).body.project.id;
  const a = await agent(t, instance, { project }), b = await agent(t, instance, { project }), out = await agent(t, instance);
  const made = await a.tool('open_chat', { text: 'cwd', title: 'Kid' });
  const first = await a.done(made.chat);
  assert.equal((await rows(instance)).find((c) => c.id === made.chat).project, project);
  assert.equal(first.last, 'cwd:new:' + made.folder, 'the folder open_chat returned is where the worker works');
  assert.deepEqual((await b.tool('list_chats')).chats.map((c) => [c.id, c.yours]).sort(), [[a.conversation, false], [made.chat, false]].sort());
  assert.equal((await b.tool('send_chat', { chat: made.chat, text: 'from b' })).sent, 'started a turn');
  assert.equal((await b.done(made.chat)).last, 'echo:from b');
  assert.equal((await b.tool('read_chat', { chat: made.chat })).messages[0].from, b.conversation);
  assert.equal((await b.tool('stop_chat', { chat: made.chat })).error, 'not-a-descendant');
  assert.equal((await b.tool('answer_chat', { chat: made.chat, request: 'r', answer: {} })).error, 'not-a-descendant');
  assert.deepEqual((await out.tool('list_chats')).chats, []);
  assert.equal((await out.tool('read_chat', { chat: made.chat })).error, 'chat-not-found');
  console.log('PASS Delegate scope: project chats read and sent, stop and answer kept to the starter, a chat outside saw nothing');
});

test('Delegate: a provider-profile chat\'s worker stays on that profile, on its parent\'s model or another the profile lists', { timeout: 120000 }, async (t) => {
  const instance = await start(t);
  await call(instance, '/file-protection', 'POST', { on: false });
  const KEY = 'sk-profile-test-0f3a9c71d2e84b56'; // the made-up key profiles.test.mjs uses; no service knows it
  const hash = createHash('sha256').update(KEY).digest('hex');
  const seen = () => fs.readFileSync(path.join(instance.workspace, 'profile.log'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const { profile } = (await call(instance, '/profiles', 'POST', { name: 'Far Cloud', baseUrl: 'https://models.example.test/api/', models: ['glm-5.3', 'kimi-k3:cloud'], key: KEY })).body;
  const a = await agent(t, instance, { profile: profile.id, model: 'glm-5.3' });
  const started = async (args) => {
    const before = seen().length, made = await a.tool('open_chat', { text: 'hello', ...args });
    if (made.error) return made.error;
    await a.done(made.chat);
    const [line, ...more] = seen().slice(before);
    assert.deepEqual(more, [], 'one agent start per worker');
    return [line.what, line.model, line.baseUrl, line.keyHash, line.keyOutside];
  };
  assert.deepEqual(await started({}), ['new', 'glm-5.3', 'https://models.example.test/api', hash, false]);
  assert.deepEqual(await started({ model: 'kimi-k3:cloud' }), ['new', 'kimi-k3:cloud', 'https://models.example.test/api', hash, false]);
  assert.equal(typeof await started({ model: 'opus' }), 'string', 'a model the profile does not list was started');
  assert.equal((await rows(instance)).length, 3);
  console.log('PASS Delegate profile: the worker got the profile\'s address, key and model; a model outside the profile was refused');
});

test('Delegate: a chat working in a wider mode takes no message from a narrower one; read_chat gets past a message longer than a page', { timeout: 180000 }, async (t) => {
  const instance = await start(t);
  await call(instance, '/file-protection', 'POST', { on: false });
  const project = (await call(instance, '/projects', 'POST', { name: 'Fresh', work: { kind: 'new', parent: '', name: 'fresh' } })).body.project.id;
  const a = await agent(t, instance, { project }), u = await agent(t, instance, { project });
  const said = (id, text, after) => until(instance, (event) => event.conversation === id && event.data?.content?.text === text, after);
  const sentTo = async (id) => (await events(instance, id)).filter((e) => e.type === 'user').map((e) => e.data.text);
  // The sender is in Plan; the other chat of its project is mid-turn in Auto.
  await call(instance, `/chat/${a.conversation}/prompt`, 'POST', { text: 'mode', mode: 'Plan' });
  await said(a.conversation, 'mode:plan');
  await call(instance, `/chat/${u.conversation}/prompt`, 'POST', { text: 'slow', mode: 'Auto' });
  await said(u.conversation, 'working');
  for (const when of ['auto', 'steer', 'queue']) {
    assert.deepEqual(await a.tool('send_chat', { chat: u.conversation, text: 'run it', when }), { error: 'mode-escalation', detail: 'It is running wider than you; wait_chat, then send.' }, when);
  }
  assert.deepEqual(await sentTo(u.conversation), ['mcp', 'slow'], 'a refused send reached the wider turn');
  // Its turn over, the message starts one in the sender's mode, not the chat's own.
  await call(instance, `/chat/${u.conversation}/cancel`, 'POST', {});
  assert.equal((await a.done(u.conversation)).state, 'idle');
  assert.equal((await a.tool('send_chat', { chat: u.conversation, text: 'mode' })).sent, 'started a turn');
  assert.equal((await a.done(u.conversation)).last, 'mode:plan');
  // The other way round is not an escalation: the Auto chat's message waits for the Plan chat's turn to end. Your own
  // message for Auto, queued after it, is not joined to it: the chat's text runs in Plan and yours after it in Auto.
  await call(instance, `/chat/${u.conversation}/prompt`, 'POST', { text: 'mode', mode: 'Auto' });
  await said(u.conversation, 'mode:auto');
  await call(instance, `/chat/${a.conversation}/prompt`, 'POST', { text: 'late', mode: 'Plan' });
  assert.equal((await u.tool('send_chat', { chat: a.conversation, text: 'mode', when: 'queue' })).sent, 'waiting for the turn to end');
  assert.equal((await call(instance, `/chat/${a.conversation}/prompt`, 'POST', { text: 'mode', mode: 'Auto', when: 'queue' })).status, 202);
  await said(a.conversation, 'mode:auto');
  const replies = (await events(instance, a.conversation)).map((e) => e.data?.content?.text).filter((x) => typeof x === 'string');
  assert.deepEqual(replies.slice(replies.indexOf('late reply') + 1), ['mode:plan', 'mode:auto'], 'the chat\'s queued text ran in the mode of your later message');

  // A 25,000-character task: the first page is that message cut to 20,000, and next moves on to the reply.
  const long = 'x'.repeat(25_000);
  const made = await u.tool('open_chat', { text: long, title: 'Long' });
  await u.done(made.chat);
  const first = await u.tool('read_chat', { chat: made.chat });
  assert.deepEqual(first.messages.map((m) => [m.role, m.text.length, m.truncated]), [['user', 20_000, true]]);
  assert.equal(first.more, true);
  const second = await u.tool('read_chat', { chat: made.chat, after: first.next });
  assert.deepEqual(second.messages.map((m) => [m.role, m.text.slice(0, 8), m.truncated]), [['assistant', 'echo:xxx', true]]);
  assert.ok(second.next > first.next, 'next did not move past the long message');
  const third = await u.tool('read_chat', { chat: made.chat, after: second.next });
  assert.deepEqual([third.messages, third.more], [[], false]);
  console.log('PASS Delegate ceiling and paging: 3 sends to a wider running turn refused, the later one ran in Plan, a queued one was not joined to an Auto message; a 25,000-character message read as 20,000 truncated, then its reply');
});

test('Delegate: stop_chat ends a worker\'s own worker first; the user\'s Stop on a chat stops the chats it started; a worker that dies mid-turn is reported as failed', { timeout: 180000 }, async (t) => {
  const instance = await start(t);
  await call(instance, '/file-protection', 'POST', { on: false });
  const a = await agent(t, instance);
  const state = async (id) => (await rows(instance)).find((c) => c.id === id).state;
  // a -> kid -> grand, both working.
  const kid = await a.tool('open_chat', { text: 'mcp', title: 'Kid' });
  const k = await connect(t, instance, kid.chat);
  const grand = await k.tool('open_chat', { text: 'slow', title: 'Grand' });
  await a.done(kid.chat);
  await a.tool('send_chat', { chat: kid.chat, text: 'slow' });
  await until(instance, (event) => event.conversation === kid.chat && event.data?.content?.text === 'working');
  assert.deepEqual(await a.tool('stop_chat', { chat: kid.chat }), { chat: kid.chat, action: 'interrupted', chats: [grand.chat, kid.chat] });
  assert.equal((await a.done(grand.chat)).state, 'idle');
  assert.equal((await a.done(kid.chat)).state, 'idle');
  // The user stops the middle chat while the one it started works: both stop, the chat above it does not.
  await a.tool('send_chat', { chat: grand.chat, text: 'slow' });
  assert.equal(await state(grand.chat), 'turn');
  assert.equal((await call(instance, `/chat/${kid.chat}/stop`, 'POST', {})).status, 200);
  assert.deepEqual([await state(grand.chat), await state(kid.chat)], ['stopped', 'stopped']);
  assert.ok(['running', 'turn'].includes(await state(a.conversation)), 'the chat above the stopped one was stopped too');

  // A worker whose agent exits mid-turn: its running parent, not waiting on it, is told.
  const crasher = await a.tool('open_chat', { text: 'late', title: 'Crasher' });
  await a.done(crasher.chat);
  await a.tool('send_chat', { chat: crasher.chat, text: 'crash' });
  await until(instance, (event) => event.conversation === a.conversation && event.type === 'user' && event.data.text === '[p9] Crasher failed; read_chat shows why.');
  await pause(500);
  assert.equal((await notices(instance, a.conversation)).filter((line) => line.includes('Crasher failed')).length, 1, 'one line for the crash');
  console.log('PASS Delegate stop and crash: stop_chat interrupted the worker\'s worker first, the user\'s Stop took the chat it started, the dead worker was reported failed');
});

test('Delegate: sprint rules ride with every message a parent\'s agent sends its worker, the default until set_rules; the user\'s own message carries none; list_chats tells model, context and last use', { timeout: 180000 }, async (t) => {
  const instance = await start(t);
  await call(instance, '/file-protection', 'POST', { on: false });
  const a = await agent(t, instance);
  const made = await a.tool('open_chat', { text: 'hello', title: 'Kid' });
  await a.done(made.chat);
  const log = path.join(path.resolve(instance.workspace, made.folder), 'rules.log');
  const sent = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  const users = async () => (await events(instance, made.chat)).filter((e) => e.type === 'user');
  // The sender label: every message another chat's agent sends says so and names that chat; the user's own does not.
  const from = () => { const file = path.join(path.dirname(log), 'from.log'); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []; };
  assert.equal(from().length, 1, 'the first message did not say who sent it');
  assert.ok(from()[0].startsWith('[P9: from another chat\'s agent, not from the user.') && from()[0].includes(`(chat ${a.conversation})`), from()[0]);
  // The first message: P9's default, as its own block (the agent saw only "hello"), a hash in the transcript.
  assert.equal(sent().length, 1, 'the first message carried no rules');
  assert.match(sent()[0], /^\[P9: sprint rules[^\n]*\nBefore you start, say in one line which folder[\s\S]*whether the work passed, failed or is waiting/);
  assert.match((await users())[0].data.rules, /^[0-9a-f]{12}$/);
  assert.ok(!JSON.stringify(await users()).includes('Before you start'), 'the rules text is in the transcript');
  assert.match((await a.tool('set_rules')).rules, /^Before you start/);
  // set_rules: the next send carries the new text and not the old.
  assert.deepEqual(await a.tool('set_rules', { rules: 'Only touch docs.' }), { rules: 'Only touch docs.', sentTo: 1 });
  await a.tool('send_chat', { chat: made.chat, text: 'second' });
  assert.equal((await a.done(made.chat)).last, 'echo:second');
  assert.equal(sent().length, 2);
  assert.ok(sent()[1].includes('\nOnly touch docs.]') && !sent()[1].includes('Before you start'), sent()[1]);
  // Into a running turn (steered): the same block.
  await a.tool('send_chat', { chat: made.chat, text: 'slow' });
  await until(instance, (event) => event.conversation === made.chat && event.type === 'user' && event.data.text === 'slow');
  assert.equal((await a.tool('send_chat', { chat: made.chat, text: 'nudge', when: 'steer' })).sent, 'into its running turn');
  assert.equal(sent().length, 4, 'a steered message carried no rules');
  assert.equal(from().length, 4, 'a steered message did not say who sent it');
  assert.match((await users()).at(-1).data.rules, /^[0-9a-f]{12}$/);
  await a.tool('stop_chat', { chat: made.chat });
  await a.done(made.chat);
  // The user's own message: none.
  await call(instance, `/chat/${made.chat}/prompt`, 'POST', { text: 'mine' });
  await until(instance, (event) => event.conversation === made.chat && event.data?.content?.text === 'echo:mine');
  assert.equal(sent().length, 4, 'the user\'s own message carried the parent\'s rules');
  assert.equal(from().length, 4, 'the user\'s own message was labelled as an agent\'s');
  assert.equal((await users()).at(-1).data.rules, undefined);
  // Empty: none. Too long, or under the lock: refused and unchanged.
  await a.tool('set_rules', { rules: '' });
  await a.tool('send_chat', { chat: made.chat, text: 'third' });
  assert.equal((await a.done(made.chat)).last, 'echo:third');
  assert.equal(sent().length, 4, 'empty rules were sent');
  assert.equal((await a.tool('set_rules', { rules: 'x'.repeat(8001) })).error, 'request-refused');
  await call(instance, '/agent-lock', 'POST', { on: true });
  assert.equal((await a.tool('set_rules', { rules: 'locked' })).error, 'agent-lock-on');
  await call(instance, '/agent-lock', 'POST', { on: false });
  assert.equal((await a.tool('set_rules')).rules, '');
  // open_chat's rules replace them, for every worker of this parent.
  const other = await a.tool('open_chat', { text: 'limits 40', title: 'Two', rules: 'Report in one line.' });
  await a.done(other.chat);
  assert.ok(sent().at(-1).includes('\nReport in one line.]'));
  // list_chats: model, context and last use.
  await until(instance, (event) => event.conversation === other.chat && event.type === 'update' && event.data.sessionUpdate === 'usage_update');
  const row = (await a.tool('list_chats')).chats.find((c) => c.id === other.chat);
  assert.deepEqual(row.context, { used: 400, size: 1000 });
  assert.ok(Math.abs(Date.now() - Date.parse(row.active)) < 60000, row.active);
  assert.ok('model' in row);
  console.log('PASS Delegate sprint rules: default on the first message, set_rules on the next and on a steer, none on the user\'s, none when empty; list_chats context ' + JSON.stringify(row.context) + ', model ' + row.model);
});

test('Delegate: after a restart the top chat of a sprint that was cut mid-turn gets one line and one turn; an idle sprint is not started; the third start in 10 minutes wakes nothing', { timeout: 240000 }, async (t) => {
  let instance = await start(t);
  await call(instance, '/file-protection', 'POST', { on: false });
  const busy = await agent(t, instance), idle = await agent(t, instance);
  const kid = await busy.tool('open_chat', { text: 'slow', title: 'Busy kid' });
  const rested = await idle.tool('open_chat', { text: 'hello', title: 'Idle kid' });
  await idle.done(rested.chat);
  await until(instance, (event) => event.conversation === kid.chat && event.type === 'user');
  const again = async (signal, name) => { instance.child.kill(signal); await once(instance.child, 'exit'); instance = await restart(t, instance, name); };
  const started = async (id, from) => (await events(instance, id)).filter((e) => e.cursor > from && e.type === 'connected').length;
  let mark = (await call(instance, '/chat/events?after=0')).body.cursor;
  // An ordinary stop and start (SIGTERM), the way an update restarts P9.
  await again('SIGTERM', 'state-2');
  const line = '[p9] P9 restarted. Interrupted mid-turn: Busy kid. Not resent.';
  const woke = async (id) => (await notices(instance, id)).filter((text) => text.startsWith('[p9] P9 restarted'));
  await until(instance, (event) => event.conversation === busy.conversation && event.data?.content?.text === 'echo:' + line, mark);
  await pause(1500);
  assert.deepEqual(await woke(busy.conversation), [line]);
  assert.deepEqual(await woke(idle.conversation), [], 'an idle sprint was told');
  assert.deepEqual([await started(kid.chat, mark), await started(idle.conversation, mark), await started(rested.chat, mark)], [0, 0, 0], 'a chat other than the top one was started');
  // Third start inside 10 minutes, this time killed outright with the worker mid-turn again: nothing is woken.
  await call(instance, `/chat/${kid.chat}/prompt`, 'POST', { text: 'slow' });
  await until(instance, (event) => event.conversation === kid.chat && event.type === 'user', mark);
  mark = (await call(instance, '/chat/events?after=0')).body.cursor;
  await again('SIGKILL', 'state-3');
  await call(instance, '/chat'); // answers once the start-up sweep is done
  await pause(3000);
  assert.equal((await events(instance, kid.chat)).filter((e) => e.cursor > mark && e.type === 'interrupted' && e.data.reason === 'daemon-restart').length, 1, 'the kill was not seen as a restart mid-turn');
  assert.deepEqual(await woke(busy.conversation), [line], 'the third start in 10 minutes woke the sprint');
  console.log('PASS Delegate restart wake: one line to the working sprint\'s top chat after a SIGTERM restart, no chat of the idle sprint started, none on the third start');
});

test('Delegate: Settings > Delegation: Ask me first asks before a chat\'s first worker even in Unrestricted; Off refuses; each worker starts on its own Settings row unless open_chat names its own; no more workers than Workers per chat', { timeout: 180000 }, async (t) => {
  const instance = await boot(t);
  const set = (body) => call(instance, '/delegation', 'POST', body);
  assert.deepEqual((await call(instance, '/delegation')).body, { start: 'ask', max: 5, workers: five() }, 'a new install does not start on Ask me first, 5 workers, every row the parent\'s');
  for (const bad of [{}, { start: 'ask' }, { start: 'always', max: 5, workers: [] }, { start: 'ask', max: 0, workers: [] }, { start: 'ask', max: 21, workers: [] }, { start: 'ask', max: 2.5, workers: [] },
    { start: 'ask', max: 5, workers: [{ ...ROW, agent: 'other' }] }, { start: 'ask', max: 5, workers: [{ agent: 'claude', model: 'opus' }] }, { start: 'ask', max: 5, workers: [{ ...ROW, agent: 'profile:../x' }] },
    { start: 'ask', max: 5, workers: [{ agent: 'claude', model: 'x'.repeat(201), effort: '' }] }, { start: 'ask', max: 5, workers: Array(21).fill(ROW) },
    { start: 'ask', max: 5, workers: [], extra: 1 }]) assert.equal((await set(bad)).status, 400, JSON.stringify(bad).slice(0, 80));
  assert.equal((await call(instance, '/delegation')).body.start, 'ask', 'a refused shape was kept');

  // Unrestricted: no acting P9 tool asks. The start of a sprint still does.
  await call(instance, '/file-protection', 'POST', { on: false });
  const a = await agent(t, instance);
  const approval = (after) => until(instance, (event) => event.conversation === a.conversation && event.type === 'approval', after);
  const answer = (request, optionId) => call(instance, `/chat/${a.conversation}/answer`, 'POST', { request, answer: { optionId } });
  let pending = a.tool('open_chat', { text: 'config', title: 'First' });
  let asked = await approval(a.cursor);
  assert.match(asked.hit.data.toolCall.title, /^This starts a sprint \(Settings > Delegation: Ask me first\)\. P9 Delegate: start a Claude worker "First" in mode /);
  await answer(asked.hit.data.request, 'reject');
  assert.equal((await pending).error, 'not-allowed');
  assert.equal((await rows(instance)).length, 1, 'a rejected sprint start made a chat');
  // Turned Off while the user is being asked: Allow starts nothing.
  pending = a.tool('open_chat', { text: 'config', title: 'First' });
  asked = await approval(asked.cursor);
  await set({ start: 'off', max: 5, workers: [] });
  await answer(asked.hit.data.request, 'allow');
  assert.equal((await pending).error, 'delegate-off', 'Delegation turned Off while the user was asked still started a worker');
  assert.equal((await rows(instance)).length, 1);
  // A call still waiting for the user counts toward Workers per chat: with one allowed, a second call at the same time is refused.
  await set({ start: 'ask', max: 1, workers: [] });
  pending = a.tool('open_chat', { text: 'config', title: 'First' });
  asked = await approval(asked.cursor);
  assert.equal((await a.tool('open_chat', { text: 'config', title: 'Twin' })).error, 'too-many-chats', 'two calls at once passed a limit of one');
  await set({ start: 'ask', max: 5, workers: [] });
  await answer(asked.hit.data.request, 'allow');
  const first = await pending;
  assert.match(first.chat, /^[0-9a-f-]{36}$/);
  // The sprint is started: the next worker is not asked about.
  const second = await a.tool('open_chat', { text: 'config', title: 'Second' });
  assert.match(second.chat, /^[0-9a-f-]{36}$/, JSON.stringify(second));
  assert.equal((await events(instance, a.conversation)).filter((e) => e.type === 'approval').length, 3, 'the second worker was asked about');
  assert.match((await a.done(second.chat)).last, /config:model=default,effort=medium,/, 'a worker whose row is left on the parent\'s is not on its parent\'s own');

  // Off: no new worker, said in words the agent can act on. The ones it has stay reachable.
  assert.equal((await set({ start: 'off', max: 5, workers: [] })).status, 200);
  const off = await a.tool('open_chat', { text: 'config', title: 'Third' });
  assert.equal(off.error, 'delegate-off');
  assert.match(off.detail, /Settings > Delegation/);
  assert.equal((await rows(instance)).length, 3);
  assert.equal((await a.tool('read_chat', { chat: second.chat })).error, undefined);

  // One row per worker, taken in the order they start: First and Second hold rows 1 and 2, so the next worker is Worker 3.
  const opus = { agent: 'claude', model: 'opus', effort: 'high' };
  let picks = five(ROW, ROW, opus, opus, { agent: 'claude', model: 'gone-model', effort: 'gone-effort' });
  assert.deepEqual((await set({ start: 'agent', max: 5, workers: picks })).body, { start: 'agent', max: 5, workers: picks });
  const third = await a.tool('open_chat', { text: 'config', title: 'Third' });
  assert.equal(third.worker, 3, JSON.stringify(third));
  assert.match((await a.done(third.chat)).last, /config:model=opus,effort=high,/, 'Worker 3 did not start on its row');
  const own = await a.tool('open_chat', { text: 'config', title: 'Fourth', model: 'haiku', effort: 'low' });
  assert.match((await a.done(own.chat)).last, /config:model=haiku,effort=low,/, 'what open_chat passed did not win over the worker\'s row');
  // A pick the agent no longer lists is passed over (the parent's own is next in line); one the call names is still refused.
  const gone = await a.tool('open_chat', { text: 'config', title: 'Fifth' });
  assert.equal(gone.error, undefined, JSON.stringify(gone));
  assert.match((await a.done(gone.chat)).last, /config:model=default,effort=medium,/, 'a Settings pick the agent does not list was sent to it');

  // Workers per chat: five are running, so a sixth is refused in words the agent can act on.
  const sixth = await a.tool('open_chat', { text: 'config', title: 'Sixth' });
  assert.equal(sixth.error, 'too-many-chats');
  assert.match(sixth.detail, /At most 5 running workers per chat \(the user sets this in Settings > Delegation\)/);
  assert.equal((await rows(instance)).length, 6);
  // A stopped worker frees its row, and only its row: First held Worker 1, now set to the other agent.
  await a.tool('stop_chat', { chat: first.chat, close: true });
  picks = five({ agent: 'codex', model: '', effort: '' }, ...picks.slice(1));
  await set({ start: 'agent', max: 5, workers: picks });
  const other = await a.tool('open_chat', { text: 'config', title: 'Other agent' });
  assert.deepEqual([other.worker, other.provider], [1, 'codex'], JSON.stringify(other));
  await a.done(other.chat);
  // A row on a provider profile: that worker gets the profile's address, key and the row's model, though its parent has none.
  const KEY = 'sk-profile-test-0f3a9c71d2e84b56', seen = () => fs.readFileSync(path.join(instance.workspace, 'profile.log'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const { profile } = (await call(instance, '/profiles', 'POST', { name: 'Far Cloud', baseUrl: 'https://models.example.test/api/', models: ['glm-5.3', 'kimi-k3:cloud'], key: KEY })).body;
  await a.tool('stop_chat', { chat: second.chat, close: true });
  picks = five(picks[0], { agent: 'profile:' + profile.id, model: 'kimi-k3:cloud', effort: '' }, ...picks.slice(2));
  await set({ start: 'agent', max: 5, workers: picks });
  const far = await a.tool('open_chat', { text: 'hello', title: 'Far' });
  assert.equal(far.worker, 2, JSON.stringify(far));
  await a.done(far.chat);
  const line = seen().at(-1);
  assert.deepEqual([line.model, line.baseUrl, line.keyHash], ['kimi-k3:cloud', 'https://models.example.test/api', createHash('sha256').update(KEY).digest('hex')], 'the profile row did not reach its worker');
  // The limit is lowered under what is running: nothing is stopped, and no new worker starts.
  await set({ start: 'agent', max: 2, workers: picks.slice(0, 2) });
  assert.equal((await a.tool('open_chat', { text: 'config', title: 'Over' })).error, 'too-many-chats');
  assert.equal((await a.tool('read_chat', { chat: third.chat })).error, undefined);
  console.log('PASS Delegate Settings: Ask me first asked once in Unrestricted (reject made nothing), Off gave delegate-off, Worker 3 ran on its row (opus/high), haiku/low from the call won, an unlisted pick was passed over, a sixth worker was refused at 5, a stopped worker freed its row for a Codex worker, a profile row gave its worker the profile');
});

test('Delegate peer help: ask_chat asks a chat the user opened to questions; its turn is alone, read-only and its own; the helper\'s mode comes back; no chains, no parent or worker', { timeout: 180000 }, async (t) => {
  const instance = await start(t);
  await call(instance, '/file-protection', 'POST', { on: false });
  const project = (await call(instance, '/projects', 'POST', { name: 'Fresh', work: { kind: 'new', parent: '', name: 'fresh' } })).body.project.id;
  const a = await agent(t, instance, { project }), b = await agent(t, instance, { project }), out = await agent(t, instance);
  const made = await a.tool('open_chat', { text: 'mcp', title: 'Kid' }), kid = await connect(t, instance, made.chat);
  const open = (id, on = true) => call(instance, `/chat/${id}/askable`, 'POST', { on });
  const said = (id, text, after) => until(instance, (e) => e.conversation === id && e.data?.content?.text === text, after);
  const B = b.conversation;

  // Off until the user turns it on, per chat.
  assert.equal((await a.tool('ask_chat', { chat: B, text: 'mode' })).error, 'not-askable');
  assert.equal((await a.tool('list_chats')).chats.find((c) => c.id === B).askable, false);
  assert.equal((await open(B)).body.on, true);
  await open(a.conversation);
  assert.equal((await a.tool('list_chats')).chats.find((c) => c.id === B).askable, true);
  assert.equal((await a.tool('list_chats')).chats.find((c) => c.id === made.chat).askable, false, 'a chat it started is never askable to it');

  // Beside only: not a worker, not the parent, not a chat outside the project.
  await open(made.chat);
  assert.equal((await a.tool('ask_chat', { chat: made.chat, text: 'x' })).error, 'not-a-peer');
  assert.equal((await kid.tool('ask_chat', { chat: a.conversation, text: 'x' })).error, 'not-a-peer');
  assert.equal((await out.tool('ask_chat', { chat: B, text: 'x' })).error, 'chat-not-found');

  // The helper is put in Accept edits and is mid-turn. The question waits, then runs alone (not joined to the user's
  // own waiting message), in the no-write mode; the user's message runs after it, back in the helper's own mode.
  let at = (await call(instance, '/chat/events?after=0&wait=0')).body.cursor;
  await call(instance, `/chat/${B}/prompt`, 'POST', { text: 'late', mode: 'Accept edits' });
  let pending = a.tool('ask_chat', { chat: B, text: 'mode' });
  await until(instance, (e) => e.conversation === B && e.type === 'held', at);
  await call(instance, `/chat/${B}/prompt`, 'POST', { text: 'mode', when: 'queue' });
  let got = await pending;
  assert.equal(got.answered, true);
  assert.equal(got.reply, 'mode:plan', 'the question ran alone and read-only');
  assert.match(got.note, /not the user's/);
  await said(B, 'mode:acceptEdits', at);
  const asked = (await events(instance, B)).find((e) => e.type === 'user' && e.data.ask);
  assert.equal(asked.data.from, a.conversation, 'the question is in the helper\'s chat, marked with its sender');
  assert.ok(!(await events(instance, B)).some((e) => e.type === 'mode' && e.data.mode === 'plan'), 'the window was never told the helper is in Plan');

  // An approval inside the answering turn is rejected without asking anyone.
  got = await a.tool('ask_chat', { chat: B, text: 'permission' });
  assert.equal(got.reply, 'permission:reject');
  assert.ok((await events(instance, B)).some((e) => e.type === 'lock-rejected' && e.data.ask));
  assert.ok(!(await events(instance, B)).some((e) => e.type === 'approval'));

  // While it answers: its own P9 tools only read (so no second question), and a message sent to it waits and does not
  // pin it in Plan.
  at = (await call(instance, '/chat/events?after=0&wait=0')).body.cursor;
  pending = a.tool('ask_chat', { chat: B, text: 'late' });
  await until(instance, (e) => e.conversation === B && e.type === 'user' && e.data.ask, at);
  assert.equal((await b.tool('ask_chat', { chat: a.conversation, text: 'x' })).error, 'answer-only');
  assert.equal((await b.tool('set_rules', { rules: 'x' })).error, 'answer-only');
  assert.equal((await b.tool('list_chats')).error, undefined);
  // A narrower chat still sees the helper's own (wide) mode, not the answering turn's Plan, so its message is refused.
  assert.equal((await kid.tool('send_chat', { chat: B, text: 'mode' })).error, 'mode-escalation');
  assert.equal((await call(instance, `/chat/${B}/prompt`, 'POST', { text: 'mode', mode: 'Accept edits' })).body.when, 'queue', 'the user\'s message waits for the answer to end');
  assert.equal((await pending).reply, 'late reply');
  await said(B, 'mode:acceptEdits', at);

  // The asker's own next message to the helper is not joined to its question: the question's turn is the question alone.
  at = (await call(instance, '/chat/events?after=0&wait=0')).body.cursor;
  await call(instance, `/chat/${a.conversation}/prompt`, 'POST', { text: 'hi', mode: 'Accept edits' });
  await said(a.conversation, 'echo:hi', at);
  await call(instance, `/chat/${B}/prompt`, 'POST', { text: 'late' });
  pending = a.tool('ask_chat', { chat: B, text: 'mode' });
  await until(instance, (e) => e.conversation === B && e.type === 'held', at);
  assert.match((await a.tool('send_chat', { chat: B, text: 'mode', when: 'queue' })).sent, /waiting for the turn to end/);
  assert.equal((await pending).reply, 'mode:plan', 'the question was sent alone');
  await said(B, 'mode:acceptEdits', at);

  // One open question; timeoutMs 0 returns at once; cancel takes a waiting question out; a cancelled turn tells the asker.
  at = (await call(instance, '/chat/events?after=0&wait=0')).body.cursor;
  await call(instance, `/chat/${B}/prompt`, 'POST', { text: 'slow' });
  await said(B, 'working', at);
  assert.equal((await a.tool('ask_chat', { chat: B, text: 'mode', timeoutMs: 0 })).answered, false);
  assert.equal((await a.tool('ask_chat', { chat: B, text: 'again' })).error, 'question-open');
  assert.deepEqual(await a.tool('ask_chat', { cancel: true }), { chat: B, cancelled: true });
  assert.ok((await events(instance, B)).some((e) => e.type === 'unheld' && e.data.why === 'removed'));
  assert.equal((await a.tool('ask_chat', {})).error, 'no-open-question');
  assert.equal((await a.tool('ask_chat', { chat: B, text: 'mode', timeoutMs: 0 })).answered, false);
  await call(instance, `/chat/${B}/cancel`, 'POST');
  for (let i = 0; i < 100 && !(await notices(instance, a.conversation)).some((line) => /did not answer your question/.test(line)); i += 1) await pause(100);
  got = await a.tool('ask_chat', {});
  assert.equal(got.error, 'not-answered');
  assert.equal(got.reason, 'cancelled');

  // A stopped helper is woken with no approval: the user opening it to questions was the yes.
  await call(instance, `/chat/${B}/stop`, 'POST');
  got = await a.tool('ask_chat', { chat: B, text: 'mode' });
  assert.equal(got.reply, 'mode:plan');
  assert.ok(!(await events(instance, a.conversation)).some((e) => e.type === 'approval'), 'the asker\'s user was never asked');

  // Closed again: refused.
  await open(B, false);
  assert.equal((await a.tool('ask_chat', { chat: B, text: 'mode' })).error, 'not-askable');
  console.log('PASS Delegate peer help: opt-in per chat, beside only, alone and read-only, approval rejected, tools read-only, mode back, cancel, a stopped helper woken unasked');
});
