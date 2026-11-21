// 0.1.9 O52: P9 asks an agent for ACP v2 and shows it to the rest of P9 as v1 (apps/server/acp-v2.mjs); an agent that
// answers 1, or refuses the ask, runs on v1. The fake here speaks recorded v2 shapes as raw JSON-RPC.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { daemon, http, authenticated, root } from './helpers.mjs';
import { acpAsk } from '../apps/server/chat.mjs';
import { diffs, v1Stream } from '../apps/server/acp-v2.mjs';
import { agentWarning } from '../apps/web/src/helpers.mjs';

const fake = path.join(root, 'test/fake-acp-v2-agent.mjs');
const start = (t, env = {}) => daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake], env }));
const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (promise) => { const result = await promise; return { ...result, body: JSON.parse(result.text) }; };
async function until(instance, match, after = 0) {
  const seen = [];
  for (let i = 0; i < 20; i += 1) {
    const { body } = await json(call(instance, `/chat/events?after=${after}&wait=2000`));
    seen.push(...body.events); after = body.cursor;
    const hit = body.events.find(match);
    if (hit) return { hit, seen, cursor: after };
  }
  throw new Error('event-timeout: ' + JSON.stringify(seen.slice(-6)));
}
const create = async (instance, provider) => (await json(call(instance, '/chat', 'POST', { provider }))).body.conversation;
const updates = (seen, kind) => seen.filter((event) => event.type === 'update' && event.data.sessionUpdate === kind).map((event) => event.data);
const says = (seen) => updates(seen, 'agent_message_chunk').map((data) => data.content.text);

test('an agent that answers ACP 2 reaches the ledger in ACP 1 shapes: turn end, tool calls, diff, approval, command output', async (t) => {
  const instance = await start(t);
  const id = await create(instance, 'codex');
  assert.equal((await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'edit' })).status, 202);
  const { hit: approval, cursor } = await until(instance, (event) => event.type === 'approval');
  assert.deepEqual(approval.data.options.map((option) => option.optionId), ['allow_once', 'cancel']);
  assert.equal(approval.data.toolCall?.toolCallId, 'exec-1', 'the approval names its tool call, as on v1');
  assert.equal((await call(instance, `/chat/${id}/answer`, 'POST', { request: approval.data.request, answer: { optionId: 'allow_once' } })).status, 200);
  const done = await until(instance, (event) => event.type === 'turn-end', cursor);
  const seen = (await json(call(instance, '/chat/events?after=0'))).body.events;
  // The v2 turn ends with an idle state, not a prompt reply: P9 still gets one turn-end with the reason and the usage.
  assert.equal(done.hit.data.stopReason, 'end_turn');
  assert.equal(done.hit.data.usage?.totalTokens, 120);
  assert.equal(seen.filter((event) => event.type === 'turn-end').length, 1);
  assert.ok(says(seen).includes('permission:allow_once'));
  // v2 has only tool_call_update: the first per tool call must arrive as tool_call, which every reader keys on.
  assert.deepEqual(updates(seen, 'tool_call').map((data) => data.toolCallId), ['exec-1', 'exec-2']);
  assert.deepEqual(updates(seen, 'tool_call')[0].content, [{ type: 'diff', path: '/w/notes.md', oldText: 'one\ntwo', newText: 'one\nthree', _meta: { hunks: [{ old: 1, new: 1, rows: [['ctx', 'one'], ['del', 'two'], ['add', 'three']] }] } }]);
  const output = updates(seen, 'tool_call_update').filter((data) => data.toolCallId === 'exec-2').flatMap((data) => data.content ?? []);
  assert.deepEqual(output, [{ type: 'content', content: { type: 'text', text: 'one\nthree\n' } }]);
  assert.deepEqual(updates(seen, 'plan')[0]?.entries.map((entry) => entry.content), ['Check the file']);
  assert.ok(says(seen).includes('Warning: A setting was ignored.\n\n'), 'O221: the warning line shape');
  // Nothing v2-only is stored, and the sign-in notices' email reaches neither the ledger nor the event stream.
  const kinds = new Set(seen.filter((event) => event.type === 'update').map((event) => event.data.sessionUpdate));
  for (const kind of ['state_update', 'user_message_chunk', 'terminal_update', 'plan_update', 'notice']) assert.ok(!kinds.has(kind), kind);
  assert.equal(updates(seen, 'session_info_update').length, 1, 'status-only session_info_update is dropped, the title kept');
  const all = JSON.stringify(seen);
  for (const leak of ['person@example.com', 'configId', 'git_patch']) assert.ok(!all.includes(leak), leak);
  console.log(`PASS acp v2 turn: ${seen.length} events, one turn-end with usage, tool_call x2, v1 diff, command output, plan, warning; no v2-only update, no email`);
});

test('ACP 2 settings, cancel, a failed turn and steering go through the same P9 routes', async (t) => {
  const instance = await start(t);
  const id = await create(instance, 'codex');
  // The mode and model picks are set_config_option calls: v2 refuses them without its `type`, and names options by configId.
  assert.equal((await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'mode', mode: 'Read-only', model: 'opus' })).status, 202);
  const first = await until(instance, (event) => event.type === 'turn-end');
  assert.ok(says(first.seen).includes('mode:read-only model:opus'), JSON.stringify(says(first.seen)));
  assert.equal((await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'slow' })).status, 202);
  await until(instance, (event) => event.type === 'update' && event.data.content?.text === 'working', first.cursor);
  assert.equal((await call(instance, `/chat/${id}/cancel`, 'POST')).status, 200);
  const cancelled = await until(instance, (event) => event.type === 'turn-end', first.cursor);
  assert.equal(cancelled.hit.data.stopReason, 'cancelled');
  assert.equal((await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'fail' })).status, 202);
  const failed = await until(instance, (event) => event.type === 'error', cancelled.cursor);
  assert.match(JSON.stringify(failed.hit.data), /not signed in/, 'a v2 turn that ends in an error is the prompt\'s error, code kept');
  console.log('PASS acp v2 routes: mode and model set with a type, cancel ends the turn cancelled, an error stop is the turn\'s error');
});

test('fallback: an agent that answers ACP 1, or refuses the v2 ask, runs on ACP 1; P9_ACP_VERSION=1 never asks for 2', async (t) => {
  for (const flag of ['v1-only', 'refuse-v2']) {
    const instance = await start(t);
    await writeFile(path.join(instance.workspace, flag), '');
    const id = await create(instance, 'codex');
    assert.equal((await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'hello' })).status, 202);
    const { seen, hit } = await until(instance, (event) => event.type === 'turn-end' || event.type === 'error');
    assert.equal(hit.type, 'turn-end', flag + ': ' + JSON.stringify(hit.data));
    assert.ok(says(seen).includes('v1:hello'), flag);
  }
  assert.deepEqual([acpAsk('codex', {}), acpAsk('claude', {}), acpAsk('codex', { P9_ACP_VERSION: '1' }), acpAsk('claude', { P9_ACP_VERSION: '1' }), acpAsk('codex', { P9_ACP_VERSION: '9' })], [2, 1, 1, 1, 2]);
  console.log('PASS acp v2 fallback: answers-1 and refuses-2 agents both ran a v1 turn; the version ask follows the per-agent setting and the override');
});

test('a git patch becomes one v1 diff per file; a new file has no old text', () => {
  const patch = 'diff --git /a.md /a.md\nnew file mode 100644\n--- /dev/null\n+++ /a.md\n@@ -0,0 +1,2 @@\n+one\n+two\ndiff --git /b.md /b.md\n--- /b.md\n+++ /b.md\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n';
  assert.deepEqual(diffs({ patch: { text: patch } }).map(({ _meta, ...d }) => d), [{ type: 'diff', path: '/a.md', oldText: null, newText: 'one\ntwo' }, { type: 'diff', path: '/b.md', oldText: 'one\ntwo', newText: 'one\nthree' }]);
  assert.deepEqual(diffs({ patch: {} }), []);
});

// The SDK ignores a notification P9 has no handler for, so the daemon test above cannot show this drop: checked here on
// the translator itself, which is the one place that must never pass the account's email on.
test('the agent\'s sign-in notices stop at the translator', async () => {
  const toAgent = new TransformStream(), fromAgent = new TransformStream();
  const p9 = v1Stream({ readable: fromAgent.readable, writable: toAgent.writable });
  const write = p9.writable.getWriter(), agent = fromAgent.writable.getWriter(), read = p9.readable.getReader();
  await write.write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 2, clientCapabilities: {} } });
  await (await toAgent.readable.getReader()).read();
  agent.write({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 2, info: { name: 'x' }, capabilities: {} } });
  assert.equal((await read.read()).value.result.protocolVersion, 2);
  agent.write({ jsonrpc: '2.0', method: 'auth/status_update', params: { status: { type: 'authenticated', email: 'person@example.com' } } });
  agent.write({ jsonrpc: '2.0', method: '_auth/status_update', params: { email: 'person@example.com' } });
  agent.write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'next' } } } });
  const next = (await read.read()).value;
  assert.equal(next.method, 'session/update', JSON.stringify(next));
  assert.equal(next.params.update.content.text, 'next');
});

// O121 part 3, O219: codex-acp 2.6.0 streams a command's output to a v2 client as terminal_output_chunk pieces, and its
// exit (terminal_update with exitStatus) carries no output when the output streamed. P9 sends each new piece once, as a
// tool_call_update marked _meta['p9/append'] that the window and phone add to the tool's text: the first piece at once,
// then at most once a second; a held piece shows a second on, or at the exit, the tool call's end or the turn's end.
// A terminal_update that carries output is the whole text (unstreamed output): it replaces, unmarked, as before.
async function v2Pipe() {
  const toAgent = new TransformStream(), fromAgent = new TransformStream();
  const p9 = v1Stream({ readable: fromAgent.readable, writable: toAgent.writable });
  const write = p9.writable.getWriter(), agent = fromAgent.writable.getWriter(), read = p9.readable.getReader(), asked = toAgent.readable.getReader();
  await write.write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 2, clientCapabilities: {} } });
  await asked.read();
  agent.write({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 2, info: { name: 'x' }, capabilities: {} } });
  await read.read();
  const said = [];
  const send = (update) => agent.write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update } });
  // A marker message after each step: everything before it has come through.
  let marks = 0;
  const step = async (...updates) => {
    for (const u of updates) send(u);
    const mark = 'mark' + (marks += 1);
    send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: mark } });
    for (;;) { const m = (await read.read()).value; if (m.params?.update?.content?.text === mark) return; said.push(m); }
  };
  // Each output update for a tool call: [its text, '+' if it is a piece to add, '=' if it replaces].
  const texts = (id) => said.filter((m) => m.params?.update?.sessionUpdate === 'tool_call_update' && m.params.update.toolCallId === id && m.params.update.content)
    .map((m) => [m.params.update.content.filter((c) => c.type === 'content').map((c) => c.content.text).join(''), m.params.update._meta?.['p9/append'] === true ? '+' : '=']);
  const joined = (id) => texts(id).reduce((all, [text, how]) => (how === '+' ? all + text : text), '');
  return { step, said, texts, joined, write, asked };
}
const b64 = (s) => Buffer.from(s).toString('base64');
const run = (id) => [{ sessionUpdate: 'terminal_update', terminalId: id, command: 'make', cwd: '/w' },
  { sessionUpdate: 'tool_call_update', toolCallId: id, kind: 'execute', title: 'make', status: 'in_progress', rawInput: { command: 'make' }, content: [{ type: 'terminal', terminalId: id }] }];
const chunk = (id, s) => ({ sessionUpdate: 'terminal_output_chunk', terminalId: id, data: b64(s) });
const exit = (id) => ({ sessionUpdate: 'terminal_update', terminalId: id, exitStatus: { exitCode: 0, signal: null } });
const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('O219: a Codex command\'s streamed output goes out piece by piece, each piece once: first at once, then at most once a second', async () => {
  const p = await v2Pipe();
  await p.step(...run('t1'), chunk('t1', 'one\n'));
  assert.deepEqual(p.texts('t1'), [['one\n', '+']], 'the first piece shows at once');
  await p.step(chunk('t1', 'two\n'), chunk('t1', 'three\n'));
  assert.deepEqual(p.texts('t1'), [['one\n', '+']], 'pieces within a second are held, not one ledger row each');
  await p.step(exit('t1'), { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
  assert.deepEqual(p.texts('t1'), [['one\n', '+'], ['two\nthree\n', '+']], 'the exit sends only what was held, never the whole text again');
  await p.step(...run('t2'), chunk('t2', 'a\n'));
  await later(1100);
  await p.step(chunk('t2', 'b\n'));
  assert.deepEqual(p.texts('t2'), [['a\n', '+'], ['b\n', '+']], 'a piece a second after the last shown one shows at once');
  await p.step(chunk('t2', 'c\n'));
  await later(1200);
  await p.step();
  assert.deepEqual(p.texts('t2'), [['a\n', '+'], ['b\n', '+'], ['c\n', '+']], 'a held piece shows a second on, though no other piece comes (a command gone quiet)');
  await p.step(exit('t2'));
  assert.equal(p.texts('t2').length, 3, 'nothing held: the exit adds no row');
  console.log('PASS O219: pieces once each, live');
});

test('O219: held pieces go out at the tool call\'s end or the turn\'s end when no exit comes; two commands stay apart', async () => {
  const p = await v2Pipe();
  await p.step(...run('t1'), ...run('t2'), chunk('t1', 'x1\n'), chunk('t2', 'y1\n'), chunk('t1', 'x2\n'), chunk('t2', 'y2\n'));
  await p.step({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed' });
  assert.deepEqual(p.texts('t1'), [['x1\n', '+'], ['x2\n', '+']], 'the tool call\'s end sends what was held');
  const at = p.said.findIndex((m) => m.params?.update?.status === 'failed');
  assert.equal(p.said[at - 1]?.params?.update?.content?.[0]?.content?.text, 'x2\n', 'before its status');
  await p.write.write({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 's', prompt: [] } });
  await p.asked.read();
  await p.step({ sessionUpdate: 'state_update', state: 'running' }, { sessionUpdate: 'state_update', state: 'idle', stopReason: 'cancelled' });
  assert.deepEqual(p.texts('t2'), [['y1\n', '+'], ['y2\n', '+']], 'a cancelled turn\'s idle sends what was held');
  const end = p.said.findIndex((m) => m.id === 2);
  assert.ok(end > p.said.findLastIndex((m) => m.params?.update?.toolCallId === 't2'), 'before the turn\'s end');
  await p.step(chunk('t2', 'late\n'));
  assert.deepEqual(p.texts('t2').at(-1), ['late\n', '+'], 'a later piece goes out at once');
  console.log('PASS O219: held pieces at tool end and turn end; commands apart');
});

test('O219: a character split across pieces stays whole; at most 2,000 characters a second are kept; a whole-text update replaces', async () => {
  const p = await v2Pipe();
  const bytes = Buffer.from('é✓\n');
  await p.step(...run('t1'), { sessionUpdate: 'terminal_output_chunk', terminalId: 't1', data: bytes.subarray(0, 1).toString('base64') });
  await later(1100);
  await p.step({ sessionUpdate: 'terminal_output_chunk', terminalId: 't1', data: bytes.subarray(1, 4).toString('base64') });
  await later(1100);
  await p.step({ sessionUpdate: 'terminal_output_chunk', terminalId: 't1', data: bytes.subarray(4).toString('base64') }, exit('t1'));
  assert.equal(p.joined('t1'), 'é✓\n', 'no piece holds half a character');
  assert.ok(p.texts('t1').every(([text]) => !text.includes('�')));
  await p.step(...run('t2'), chunk('t2', 'z'.repeat(30000)), chunk('t2', '✓'.repeat(25000)), exit('t2'));
  assert.deepEqual(p.texts('t2'), [['…\n' + 'z'.repeat(2000), '+'], ['…\n' + '✓'.repeat(2000), '+']], 'more than 2,000 characters in a second: the last 2,000, marked as cut');
  await p.step(...run('t5'), chunk('t5', 'z'.repeat(5000)), chunk('t5', '😀'.repeat(1001) + 'x'), exit('t5'));
  assert.deepEqual(p.texts('t5').at(-1), ['…\n' + '😀'.repeat(999) + 'x', '+'], 'the cut never leaves half an emoji');
  await p.step({ sessionUpdate: 'terminal_update', terminalId: 't6', command: 'make', cwd: '/w' }, chunk('t6', 'early\n'));
  await p.step({ sessionUpdate: 'tool_call_update', toolCallId: 't6', kind: 'execute', title: 'make', status: 'in_progress', content: [{ type: 'terminal', terminalId: 't6' }] });
  const t6 = p.said.filter((m) => m.params?.update?.toolCallId === 't6');
  assert.deepEqual([t6[0].params.update.sessionUpdate, p.texts('t6')], ['tool_call', [['early\n', '+']]], 'output before its tool call shows right after it');
  await p.step(...run('t3'), chunk('t3', 'old\n'), { sessionUpdate: 'terminal_update', terminalId: 't3', output: { data: b64('whole\n') } }, chunk('t3', 'more\n'), exit('t3'));
  assert.deepEqual(p.texts('t3'), [['old\n', '+'], ['whole\nmore\n', '=']], 'the whole text replaces; a piece after it joins it');
  await p.step(...run('t4'), { sessionUpdate: 'terminal_update', terminalId: 't4', output: { data: b64('all at once\n') }, exitStatus: { exitCode: 1, signal: null } });
  assert.deepEqual(p.texts('t4'), [['all at once\n', '=']], 'output that did not stream: one replacing update, as before');
  await p.step(chunk('t9', 'never announced\n'), exit('t9'));
  assert.deepEqual(p.texts('t9'), [], 'output of a terminal no tool call names is not shown, as before');
  console.log('PASS O219: split character, 2,000 a second, whole-text replace');
});

// O221 (O121 part 4): a v2 notice is the agent program's own line, not words of the reply. The window and phone draw a
// reply chunk that is exactly "Warning: <text>\n\n" as the grey warning line (agentWarning, helpers.mjs) and the chat
// list leaves it out of the preview; any other shape was added to the reply text as if the agent had said it.
test('O221: a Codex notice reaches the window and phone as the warning line, never as reply text', async () => {
  const { step, said } = await v2Pipe();
  const odd = { toString: null };
  await step({ sessionUpdate: 'notice', severity: 'warning', title: 'A setting was ignored.' },
    { sessionUpdate: 'notice', severity: 'warning', title: ' Model changed ', description: 'Using a smaller model.\n' },
    { sessionUpdate: 'notice', severity: 'error', title: 'The sandbox failed.' },
    { sessionUpdate: 'notice', severity: 'warning', title: '', description: '  ' },
    { sessionUpdate: 'notice', severity: 'warning', title: odd, description: odd });
  const texts = said.map((m) => m.params?.update?.content?.text);
  assert.deepEqual(texts.map(agentWarning), ['A setting was ignored.', 'Model changed\nUsing a smaller model.', 'Error: The sandbox failed.'], JSON.stringify(texts));
  assert.ok(said.every((m) => m.params.update.sessionUpdate === 'agent_message_chunk' && m.params.update.messageId === undefined));
});
