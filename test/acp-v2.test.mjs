// 0.1.9 O52: P9 asks an agent for ACP v2 and shows it to the rest of P9 as v1 (apps/server/acp-v2.mjs); an agent that
// answers 1, or refuses the ask, runs on v1. The fake here speaks recorded v2 shapes as raw JSON-RPC.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { daemon, http, authenticated, root } from './helpers.mjs';
import { acpAsk } from '../apps/server/chat.mjs';
import { diffs } from '../apps/server/acp-v2.mjs';

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
  assert.deepEqual(updates(seen, 'tool_call')[0].content, [{ type: 'diff', path: '/w/notes.md', oldText: 'one\ntwo', newText: 'one\nthree' }]);
  const output = updates(seen, 'tool_call_update').filter((data) => data.toolCallId === 'exec-2').flatMap((data) => data.content ?? []);
  assert.deepEqual(output, [{ type: 'content', content: { type: 'text', text: 'one\nthree\n' } }]);
  assert.deepEqual(updates(seen, 'plan')[0]?.entries.map((entry) => entry.content), ['Check the file']);
  assert.ok(says(seen).includes('Warning: A setting was ignored.'));
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
  assert.deepEqual([acpAsk('codex', {}), acpAsk('claude', {}), acpAsk('codex', { P9_ACP_VERSION: '1' }), acpAsk('claude', { P9_ACP_VERSION: '2' }), acpAsk('codex', { P9_ACP_VERSION: '9' })], [2, 1, 1, 2, 2]);
  console.log('PASS acp v2 fallback: answers-1 and refuses-2 agents both ran a v1 turn; the version ask follows the per-agent setting and the override');
});

test('a git patch becomes one v1 diff per file; a new file has no old text', () => {
  const patch = 'diff --git /a.md /a.md\nnew file mode 100644\n--- /dev/null\n+++ /a.md\n@@ -0,0 +1,2 @@\n+one\n+two\ndiff --git /b.md /b.md\n--- /b.md\n+++ /b.md\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n';
  assert.deepEqual(diffs({ patch: { text: patch } }), [{ type: 'diff', path: '/a.md', oldText: null, newText: 'one\ntwo' }, { type: 'diff', path: '/b.md', oldText: 'one\ntwo', newText: 'one\nthree' }]);
  assert.deepEqual(diffs({ patch: {} }), []);
});
