// Test-only agent that speaks ACP v2 (0.1.9 O52), as raw JSON-RPC lines: every message shape here is copied from
// recorded traffic of codex-acp 2.6.0 and claude-agent-acp 0.106.0, so apps/server/acp-v2.mjs is tested against what
// the real agents send and not against its own idea of v2. The prompt text picks the behaviour: "slow" works until
// cancelled, "fail" ends the turn with an error, anything else runs an edit that asks first, a command, a plan and a
// notice. A set_config_option without v2's `type` is refused. Files in the working directory: v1-only answers
// initialize with protocol 1 (and then speaks v1), refuse-v2 answers a v2 initialize with an error.
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const update = (sessionId, body) => send({ method: 'session/update', params: { sessionId, update: body } });
const text = (prompt) => prompt.map((block) => block.text ?? '').join('');
const usage = { totalTokens: 120, inputTokens: 100, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 20, thoughtTokens: 0 };
let v2 = false, mode = 'agent', model = 'default', next = 0, sessionId = 'fake-v2-' + process.pid + '-' + Date.now();
const asked = new Map(), cancels = new Map();
const ask = (method, params) => new Promise((resolve) => { asked.set('a' + (next += 1), resolve); send({ id: 'a' + next, method, params }); });
const key = () => (v2 ? 'configId' : 'id');
const configOptions = () => [{ [key()]: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: mode,
  options: ['read-only', 'workspace-write', 'agent', 'agent-full-access'].map((value) => ({ value, name: value })) },
  { [key()]: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model, options: [{ value: 'default', name: 'Default' }, { value: 'opus', name: 'Opus' }] }];
const patch = 'diff --git /w/notes.md /w/notes.md\n--- /w/notes.md\n+++ /w/notes.md\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n';

async function turn(id, params) {
  const said = text(params.prompt), chunk = (reply) => update(sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'msg_1', content: { type: 'text', text: reply } });
  if (!v2) { chunk('v1:' + said); return send({ id, result: { stopReason: 'end_turn', usage } }); }
  update(sessionId, { sessionUpdate: 'state_update', state: 'running' });
  update(sessionId, { sessionUpdate: 'session_info_update', _meta: { codex: { threadStatus: { type: 'active', activeFlags: [] } } } });
  update(sessionId, { sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: said } });
  send({ id, result: { messageId: 'u1' } });
  if (said === 'slow') {
    chunk('working');
    await new Promise((resolve) => cancels.set(sessionId, resolve));
    return update(sessionId, { sessionUpdate: 'state_update', state: 'idle', stopReason: 'cancelled', _meta: { quota: { token_count: null } } });
  }
  if (said === 'fail') return update(sessionId, { sessionUpdate: 'state_update', state: 'idle', stopReason: 'error', error: { code: -32000, message: 'Authentication required' } });
  if (said === 'mode') chunk('mode:' + mode + ' model:' + model);
  else {
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'exec-1', kind: 'edit', title: 'Editing files', status: 'in_progress',
      content: [{ type: 'diff', changes: [{ operation: 'modify', path: '/w/notes.md' }], patch: { format: 'git_patch', text: patch }, _meta: { kind: 'update' } }] });
    update(sessionId, { sessionUpdate: 'state_update', state: 'requires_action' });
    const answer = await ask('session/request_permission', { sessionId, title: 'Make edits?', description: 'The agent wants to change notes.md',
      subject: { type: 'tool_call', toolCall: { toolCallId: 'exec-1', title: 'Edit files', locations: [{ path: '/w/notes.md' }], kind: 'edit', status: 'pending' } },
      options: [{ optionId: 'allow_once', name: 'Yes, proceed', kind: 'allow_once' }, { optionId: 'cancel', name: 'No', kind: 'reject_once' }] });
    update(sessionId, { sessionUpdate: 'state_update', state: 'running' });
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'exec-1', status: answer?.outcome?.optionId === 'allow_once' ? 'completed' : 'failed' });
    update(sessionId, { sessionUpdate: 'terminal_update', terminalId: 'exec-2', command: 'cat notes.md', cwd: '/w' });
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'exec-2', kind: 'execute', title: 'cat notes.md', status: 'in_progress',
      rawInput: { command: 'cat notes.md', cwd: '/w' }, content: [{ type: 'terminal', terminalId: 'exec-2' }] });
    update(sessionId, { sessionUpdate: 'terminal_update', terminalId: 'exec-2', output: { data: Buffer.from('one\nthree\n').toString('base64') }, exitStatus: { exitCode: 0, signal: null } });
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'exec-2', status: 'completed' });
    update(sessionId, { sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'p1', entries: [{ content: 'Check the file', priority: 'medium', status: 'completed' }] } });
    update(sessionId, { sessionUpdate: 'notice', severity: 'warning', title: 'A setting was ignored.' });
    chunk('permission:' + (answer?.outcome?.optionId ?? answer?.outcome?.outcome));
  }
  update(sessionId, { sessionUpdate: 'session_info_update', _meta: { codex: { threadStatus: { type: 'idle' } } } });
  update(sessionId, { sessionUpdate: 'session_info_update', title: 'Notes edit' });
  update(sessionId, { sessionUpdate: 'state_update', state: 'idle', usage, _meta: { quota: { token_count: usage } } });
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params, result } = JSON.parse(line);
  if (!method) return asked.get(id)?.(result);
  const fail = (code, message) => send({ id, error: { code, message } });
  switch (method) {
    case 'initialize':
      if (params.protocolVersion >= 2 && existsSync('refuse-v2')) return fail(-32602, 'Invalid params: protocolVersion');
      if (params.protocolVersion < 2 || existsSync('v1-only')) return send({ id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true }, sessionCapabilities: { resume: {}, close: {} } } } });
      if (!params.info?.name || !params.capabilities) return fail(-32602, 'Invalid params: info');
      v2 = true;
      return send({ id, result: { protocolVersion: 2, info: { name: 'fake-v2', title: 'Fake', version: '0' }, capabilities: { session: { prompt: { image: true, embeddedContext: true } } }, _meta: { steering: { supported: true } } } });
    case 'session/new': case 'session/resume':
      if (method === 'session/resume') sessionId = params.sessionId;
      send({ id, result: { ...(method === 'session/new' && { sessionId }), configOptions: configOptions() } });
      if (!v2) return;
      // The account's email: must never reach P9's ledger.
      send({ method: 'auth/status_update', params: { status: { type: 'authenticated', email: 'person@example.com' } } });
      send({ method: '_auth/status_update', params: { email: 'person@example.com' } });
      if (method === 'session/resume') update(sessionId, { sessionUpdate: 'state_update', state: 'idle' }); // both real agents do, with no turn
      return;
    case 'session/set_config_option':
      if (v2 && params.type !== 'id' && params.type !== 'boolean') return fail(-32602, 'Invalid params: type');
      if (params.configId === 'mode') mode = params.value; else if (params.configId === 'model') model = params.value; else return fail(-32602, 'Invalid params: configId');
      send({ id, result: { configOptions: configOptions() } });
      return update(params.sessionId, { sessionUpdate: 'config_option_update', configOptions: configOptions() });
    case 'session/prompt': return void turn(id, params);
    case 'session/cancel': return cancels.get(params.sessionId)?.();
    case 'session/close': return send({ id, result: {} });
    default: if (id !== undefined) fail(-32601, 'Method not found: ' + method);
  }
});
