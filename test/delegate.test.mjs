import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { daemon, http, authenticated, root } from './helpers.mjs';
// The real MCP SDK client, as in mcp.test.mjs: the tools are called the way an agent's adapter calls them.
import { Client } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
// profile.log in the workspace: the stand-in writes there what provider settings each agent start was given (a hash, never the key).
const start = (t) => daemon(t, undefined, false, async ({ workspace }) => { fs.writeFileSync(path.join(workspace, 'profile.log'), ''); return { args: ['--acp-override', fake] }; });
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

test('Delegate: open_chat asks the user first; the sub-agent is an ordinary chat with its parent kept; the same key makes one chat; a mode wider than the sender is refused', { timeout: 120000 }, async (t) => {
  const instance = await start(t);
  const a = await agent(t, instance);
  const approval = (after) => until(instance, (event) => event.conversation === a.conversation && event.type === 'approval', after);
  const answer = (request, optionId) => call(instance, `/chat/${a.conversation}/answer`, 'POST', { request, answer: { optionId } });

  // File protection is on in a new install, so P9 asks in the parent's chat. Reject: nothing is made.
  let pending = a.tool('open_chat', { text: 'mode', title: 'Kid', key: 'kid-1', mode: 'Plan' });
  let asked = await approval(a.cursor);
  assert.match(asked.hit.data.toolCall.title, /^P9 Delegate: start a Claude sub-agent "Kid" in mode Plan\. Its task: mode$/);
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
  // The HTTP route cannot name a parent: lineage comes only from the tool.
  const typed = await call(instance, '/chat', 'POST', { provider: 'claude', parent: a.conversation, key: 'x' });
  assert.ok(typed.status !== 201 || !(await rows(instance)).find((c) => c.id === typed.body.conversation).parent, 'a request body set a parent');
  console.log('PASS Delegate open_chat: reject made nothing, allow made one Plan chat with its parent, the key returned it again, wider modes refused unasked');
});

test('Delegate: send, wait, read, list and stop reach a chat\'s own sub-agents; another chat sees none of them; an approval stays the user\'s; the lock refuses', { timeout: 180000 }, async (t) => {
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

  // list_chats: the parent sees its sub-agent; a general chat sees nothing of another general chat.
  const listed = await a.tool('list_chats');
  assert.deepEqual(listed.chats.map((c) => [c.id, c.key, c.parent, c.yours]), [[made.chat, 'kid', a.conversation, true]]);
  assert.deepEqual((await b.tool('list_chats')).chats, []);
  for (const [name, args] of [['read_chat', {}], ['wait_chat', {}], ['send_chat', { text: 'x' }], ['stop_chat', {}], ['answer_chat', { request: 'r', answer: {} }]]) {
    assert.equal((await b.tool(name, { chat: made.chat, ...args })).error, 'chat-not-found', name + ' from another chat');
    assert.equal((await a.tool(name, { chat: b.conversation, ...args })).error, 'chat-not-found', name + ' on a chat it did not start');
  }
  assert.equal((await a.tool('read_chat', { chat: a.conversation })).error, 'chat-not-found', 'a chat is not its own target');
  assert.deepEqual((await events(instance, made.chat)).filter((e) => e.type === 'user').map((e) => e.data.text), ['hello', 'second'], 'the refused sends reached nothing');

  // A question the sub-agent asks: its parent may answer. An approval: only the user.
  await a.tool('send_chat', { chat: made.chat, text: 'ask' });
  let got = await a.tool('wait_chat', { chat: made.chat });
  assert.deepEqual([got.state, got.ended, got.waiting?.kind, got.waiting?.text], ['working', false, 'question', 'Pick a colour']);
  assert.deepEqual(await a.tool('answer_chat', { chat: made.chat, request: got.waiting.request, answer: { action: 'accept', content: { colour: 'red' } } }), { chat: made.chat, action: 'answered' });
  assert.match((await a.done(made.chat)).last, /^ask:.*red/);
  assert.equal((await events(instance, made.chat)).find((e) => e.type === 'answered').data.from, a.conversation, 'the answer says which chat gave it');
  await a.tool('send_chat', { chat: made.chat, text: 'permission' });
  got = await a.tool('wait_chat', { chat: made.chat });
  assert.equal(got.waiting?.kind, 'approval');
  assert.equal((await a.tool('answer_chat', { chat: made.chat, request: got.waiting.request, answer: { optionId: 'allow' } })).error, 'approval-is-the-users');
  await pause(300);
  assert.equal((await a.tool('wait_chat', { chat: made.chat, timeoutMs: 0 })).waiting?.kind, 'approval', 'the approval still waits for the user');
  await call(instance, `/chat/${made.chat}/answer`, 'POST', { request: got.waiting.request, answer: { optionId: 'allow' } });
  assert.equal((await a.done(made.chat)).last, 'permission:allow');

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
  console.log('PASS Delegate tools: sent, waited, read and listed its own sub-agent; another chat got chat-not-found on all five; question answered, approval refused; timeout stopped nothing; lock refused');
});

test('Delegate: a finished sub-agent tells its running parent in one line, not while the parent waits on it; a stopped parent is not started', { timeout: 120000 }, async (t) => {
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

test('Delegate: chats in one project read and message each other but stop only their own sub-agents; a sub-agent starts in its parent\'s project', { timeout: 120000 }, async (t) => {
  const instance = await start(t);
  await call(instance, '/file-protection', 'POST', { on: false });
  const project = (await call(instance, '/projects', 'POST', { name: 'Fresh', work: { kind: 'new', parent: '', name: 'fresh' } })).body.project.id;
  const a = await agent(t, instance, { project }), b = await agent(t, instance, { project }), out = await agent(t, instance);
  const made = await a.tool('open_chat', { text: 'cwd', title: 'Kid' });
  const first = await a.done(made.chat);
  assert.equal((await rows(instance)).find((c) => c.id === made.chat).project, project);
  assert.equal(first.last, 'cwd:new:' + made.folder, 'the folder open_chat returned is where the sub-agent works');
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

test('Delegate: a provider-profile chat\'s sub-agent stays on that profile, on its parent\'s model or another the profile lists', { timeout: 120000 }, async (t) => {
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
    assert.deepEqual(more, [], 'one agent start per sub-agent');
    return [line.what, line.model, line.baseUrl, line.keyHash, line.keyOutside];
  };
  assert.deepEqual(await started({}), ['new', 'glm-5.3', 'https://models.example.test/api', hash, false]);
  assert.deepEqual(await started({ model: 'kimi-k3:cloud' }), ['new', 'kimi-k3:cloud', 'https://models.example.test/api', hash, false]);
  assert.equal(typeof await started({ model: 'opus' }), 'string', 'a model the profile does not list was started');
  assert.equal((await rows(instance)).length, 3);
  console.log('PASS Delegate profile: the sub-agent got the profile\'s address, key and model; a model outside the profile was refused');
});
