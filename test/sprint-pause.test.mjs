// Pause sprint / Resume (0.1.9 phase 4.5, S13; SECURITY.md § Pause sprint): while a sprint is paused its workers start no
// turn for what an agent or P9 sends them; each such message is kept, in order, across a restart, and Resume sends them
// in that order with their senders. A note passes, ask_chat is refused, the owner's own message goes through, the lead
// opens no worker, and at most 100 are kept.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { daemon, restart, http, authenticated, root } from './helpers.mjs';
import { Client } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const call = (instance, route, method = 'GET', body) => http({ socketPath: instance.credentials.socketPath, route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  .then((result) => ({ ...result, body: result.text ? JSON.parse(result.text) : null }));
const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rows = async (instance) => (await call(instance, '/chat')).body.conversations;
const events = async (instance, id) => (await call(instance, '/chat/events?after=0&only=' + id)).body.events;
const cursor = async (instance) => (await call(instance, '/chat/events?after=0&wait=0')).body.cursor;
async function until(instance, match, after = 0) {
  for (let i = 0; i < 40; i += 1) {
    const { body } = await call(instance, `/chat/events?after=${after}&wait=2000`);
    after = body.cursor;
    const hit = body.events.find(match);
    if (hit) return { hit, cursor: after };
  }
  throw new Error('event-timeout');
}
// The SDK client from the MCP entry a chat's agent was handed on its last "mcp" message.
async function attach(t, instance, conversation, after = 0) {
  const { hit } = await until(instance, (e) => e.conversation === conversation && e.data?.content?.text?.startsWith('mcp:'), after);
  const [entry] = JSON.parse(hit.data.content.text.slice(4));
  const client = new Client({ name: 'p9-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env: Object.fromEntries(entry.env.map(({ name, value }) => [name, value])) }));
  t.after(() => client.close());
  const tool = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  return { conversation, tool };
}

test('Pause sprint: a paused sprint\'s workers start no turn for what agents send; it is kept in order across a restart and Resume sends it with its senders; a note and the owner\'s own message go through; ask_chat and open_chat are refused; 100 at most', { timeout: 300000 }, async (t) => {
  let instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const ws = instance.workspace, repo = path.join(ws, 'repo');
  fs.mkdirSync(repo); g(repo, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); g(repo, 'add', 'a.txt'); g(repo, 'commit', '-qm', 'a');
  await call(instance, '/file-protection', 'POST', { on: false });
  const project = (await call(instance, '/projects', 'POST', { name: 'Fresh', work: { kind: 'new', parent: '', name: 'fresh' } })).body.project.id;
  // P9 learns Claude's models and efforts when it first runs.
  const first = (await call(instance, '/chat', 'POST', { provider: 'claude', project })).body.conversation;
  await call(instance, `/chat/${first}/prompt`, 'POST', { text: 'config' });
  await until(instance, (e) => e.conversation === first && e.data?.content?.text?.startsWith('config:'));

  // A started sprint: a lead and two workers, each sent "mcp" as its work so the test holds its tools.
  const prep = (await call(instance, '/projects/' + project + '/sprints', 'POST', { title: 'P1' })).body, sprint = prep.sprint;
  const row = (key, model, effort) => ({ key, provider: 'claude', model, effort });
  fs.writeFileSync(path.join(prep.folder, 'roles.json'), JSON.stringify({ folder: 'repo', roles: [row('lead', 'opus', 'high'), row('w1', 'haiku', 'low'), row('w2', 'haiku', 'low')] }));
  for (const key of ['lead', 'w1', 'w2']) fs.writeFileSync(path.join(prep.folder, `roles/${key}.work.md`), 'mcp');
  // Pause before Start: nothing to pause.
  assert.deepEqual([(await call(instance, `/sprints/${sprint}/pause`, 'POST', {})).status], [404], 'a sprint with no lead was paused');
  const press = await call(instance, `/sprints/${sprint}/start`, 'POST', {});
  assert.equal(press.status, 200, JSON.stringify(press.body));
  const id = Object.fromEntries(press.body.chats.map((c) => [c.key, c.chat]));
  const lead = await attach(t, instance, sprint), w1 = await attach(t, instance, id.w1), w2 = await attach(t, instance, id.w2);
  for (const w of [id.w1, id.w2]) for (;;) { if (!(await lead.tool('wait_chat', { chat: w })).timedOut) break; }
  // A note to an idle lead waits for its next message (a 'note' event); into a running turn it is a 'user' one.
  const told = (e, prefix) => e.conversation === sprint && ['note', 'user'].includes(e.type) && e.data.from === 'p9' && e.data.text?.startsWith(prefix);
  const notices = async (prefix) => (await events(instance, sprint)).filter((e) => told({ ...e, conversation: sprint }, prefix)).map((e) => e.data.text);
  const turns = async (chat, text, after) => (await events(instance, chat)).filter((e) => e.cursor > after && e.type === 'user' && e.data.text?.includes(text));

  // The owner's press: desktop route, no fields, a sprint only; the lead hears of it once; the page and rows say Paused.
  assert.equal((await call(instance, `/sprints/${sprint}/pause`, 'POST', { by: 'x' })).status, 400, 'the press has no fields');
  assert.equal((await call(instance, `/sprints/${id.w1}/pause`, 'POST', {})).status, 404, 'a worker was paused as a sprint');
  let got = await call(instance, `/sprints/${sprint}/pause`, 'POST', {});
  assert.deepEqual([got.status, got.body], [200, { paused: true }]);
  assert.deepEqual((await call(instance, `/sprints/${sprint}/pause`, 'POST', {})).body, { paused: true, already: true });
  await until(instance, (e) => told(e, '[p9] The user paused'));
  assert.equal((await notices('[p9] The user paused')).length, 1, 'the lead was not told once');
  assert.equal((await call(instance, '/projects/' + project)).body.project.sprints.find((s) => s.lead === sprint).paused, true);
  const marked = Object.fromEntries((await rows(instance)).map((c) => [c.id, !!c.paused]));
  assert.deepEqual([marked[sprint], marked[id.w1], marked[id.w2], marked[first]], [true, true, true, false]);
  assert.equal((await w1.tool('pause_sprint')).error, 'not-a-sprint-lead');

  // Agents' messages are kept: no turn starts.
  let mark = await cursor(instance);
  for (const text of ['pause-one', 'pause-two']) {
    got = await lead.tool('send_chat', { chat: id.w1, text });
    assert.ok(got.held, JSON.stringify(got));
  }
  // A note passes (it starts nothing), a question from beside is refused, the lead opens no worker.
  assert.match((await lead.tool('send_chat', { chat: id.w1, text: 'a note', when: 'note' })).sent, /^as a note/);
  await call(instance, `/chat/${id.w1}/askable`, 'POST', { on: true });
  assert.equal((await w2.tool('ask_chat', { chat: id.w1, text: 'mode' })).error, 'sprint-paused');
  assert.equal((await lead.tool('open_chat', { text: 'x', key: 'paused-new' })).error, 'sprint-paused');
  assert.equal((await rows(instance)).length, 4, 'a chat was made while paused');
  await pause(1500);
  assert.deepEqual(await turns(id.w1, 'pause-', mark), [], 'a paused worker started a turn');
  assert.deepEqual((await events(instance, id.w1)).filter((e) => e.cursor > mark && e.type === 'held' && e.data.when === 'pause').map((e) => e.data.text), ['pause-one', 'pause-two']);
  // The owner's own message goes through.
  await call(instance, `/chat/${id.w1}/prompt`, 'POST', { text: 'owner-typed' });
  await until(instance, (e) => e.conversation === id.w1 && e.data?.content?.text?.includes('owner-typed'), mark);

  // A restart keeps the pause and what it holds; nothing starts.
  instance.child.kill('SIGTERM'); await once(instance.child, 'exit');
  instance = await restart(t, instance, 'state-2');
  mark = await cursor(instance);
  await pause(2000);
  assert.equal((await rows(instance)).find((c) => c.id === id.w1).paused, true, 'the pause did not survive the restart');
  assert.deepEqual(await turns(id.w1, 'pause-', 0), [], 'a held message started a turn after the restart');

  // Resume: both, in order, each with its sender; the lead hears of it once; the marks go.
  got = await call(instance, `/sprints/${sprint}/resume`, 'POST', {});
  assert.deepEqual([got.status, got.body], [200, { paused: false, sent: 2 }]);
  await until(instance, (e) => e.conversation === id.w1 && e.data?.content?.text?.includes('pause-two'), mark);
  const sent = await turns(id.w1, 'pause-', mark);
  assert.deepEqual(sent.map((e) => [e.data.text.includes('pause-one') ? 'one' : 'two', e.data.from]), [['one', sprint], ['two', sprint]]);
  await until(instance, (e) => told(e, '[p9] The user resumed'), mark);
  assert.deepEqual(await notices('[p9] The user resumed'), ['[p9] The user resumed this sprint. 2 kept messages sent in order.']);
  assert.equal((await rows(instance)).find((c) => c.id === id.w1).paused, undefined);
  assert.equal((await call(instance, '/projects/' + project)).body.project.sprints.find((s) => s.lead === sprint).paused, undefined);
  assert.deepEqual((await call(instance, `/sprints/${sprint}/resume`, 'POST', {})).body, { paused: false, already: true });

  // The cap: the lead's own pause (no note to itself), 100 kept, the 101st refused by name.
  await call(instance, `/chat/${sprint}/prompt`, 'POST', { text: 'mcp' });
  const again = await attach(t, instance, sprint, mark);
  assert.deepEqual(await again.tool('pause_sprint'), { paused: true });
  assert.equal((await notices('[p9] The user paused')).length, 1, 'the lead\'s own pause sent it a note');
  for (let i = 0; i < 100; i += 1) assert.ok((await again.tool('send_chat', { chat: id.w2, text: 'cap-' + i })).held, 'message ' + i + ' was not kept');
  got = await again.tool('send_chat', { chat: id.w2, text: 'cap-100' });
  assert.equal(got.reason ?? got.error, 'sprint-paused-full', JSON.stringify(got));
  console.log('PASS Pause sprint: held in order across a restart, resumed with senders; note and owner pass; ask_chat, open_chat refused; cap 100');
});
