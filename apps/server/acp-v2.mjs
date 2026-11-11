// ACP v2 spoken as v1 (0.1.9 O52). P9's chat code, ledger, window, phone, telemetry and memory all read ACP v1
// shapes. When an agent answers `initialize` with protocol version 2, this wraps the connection's message stream and
// rewrites each message, so everything above it keeps seeing v1. An agent that answers 1 passes through untouched:
// that is the per-agent fallback. Every rule here comes from real traffic of claude-agent-acp 0.106.0 and
// codex-acp 2.6.0 (contracts.md, "ACP v2").
//
// What v2 does differently, and what this does about it:
//   initialize       reply has info/capabilities                    -> agentInfo/agentCapabilities
//   config options   named by configId; a set needs a type          -> id; type added
//   session/prompt   answers at once with a messageId; the turn     -> the v1 reply is held until that idle and carries
//                    ends with a state_update 'idle'                   its stopReason and usage
//   tool calls       only tool_call_update; the first one creates   -> the first one per id becomes tool_call
//   diffs            a git patch                                    -> path/oldText/newText, one per file
//   permission       title + subject                                -> toolCall
//   plan_update, notice                                             -> plan, a 'Warning: ' message chunk
//   command output   terminal_update, base64, id = the tool call's   -> the tool call's text content (its last 20,000 chars)
//   the prompt's echo, running/requires_action states, session_info_update with only _meta (Codex's thread status,
//   about eight a turn), sign-in status: dropped. P9 writes the user's message itself, and the sign-in notices
//   carry the account's email, which must not reach the ledger or a log.

const DROPPED_UPDATES = new Set(['user_message', 'user_message_chunk', 'terminal_output_chunk']);
const DROPPED_NOTIFICATIONS = new Set(['auth/status_update', '_auth/status_update']);

const options = (list) => Array.isArray(list) ? list.map(({ configId, ...rest }) => (configId === undefined ? rest : { id: configId, ...rest })) : list;
const withOptions = (value) => (value && Array.isArray(value.configOptions) ? { ...value, configOptions: options(value.configOptions) } : value);

// One v1 diff per file in a git patch. v1 diffs hold text, not hunks: old is the patch's context and removed lines,
// new its context and added lines, which is what the v1 adapters sent for an edit (the changed part, not the file).
export function diffs(item) {
  const text = item?.patch?.text;
  if (typeof text !== 'string') return [];
  const out = [];
  let file;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) { out.push(file = { type: 'diff', path: '', old: [], new: [], added: false }); continue; }
    if (!file) continue;
    if (line.startsWith('--- ')) { if (line.slice(4) === '/dev/null') file.added = true; else file.path = line.slice(4); }
    else if (line.startsWith('+++ ')) { if (line.slice(4) !== '/dev/null') file.path = line.slice(4); }
    else if (line.startsWith('+')) file.new.push(line.slice(1));
    else if (line.startsWith('-')) file.old.push(line.slice(1));
    else if (line.startsWith(' ')) { file.old.push(line.slice(1)); file.new.push(line.slice(1)); }
  }
  return out.filter((f) => f.path).map((f) => ({ type: 'diff', path: f.path, oldText: f.added ? null : f.old.join('\n'), newText: f.new.join('\n') }));
}
const content = (list) => Array.isArray(list) ? list.flatMap((item) => (item?.type === 'diff' && item.patch ? diffs(item) : [item])) : list;
const tool = (call) => (call && Array.isArray(call.content) ? { ...call, content: content(call.content) } : call);

export function v1Stream(stream) {
  let v2 = false;
  let initId;
  const sent = new Map(); // request id -> what its reply needs: { prompt: sessionId } or { config: true }
  const turns = new Map(); // sessionId -> { id, live }: the held v1 prompt request; live once the agent took it
  const tools = new Set(); // sessionId + toolCallId already announced as a tool_call

  function toAgent(message) {
    if (message.method === 'initialize' && message.params?.protocolVersion >= 2) {
      initId = message.id;
      const { clientInfo, clientCapabilities } = message.params;
      // Both versions' fields: an agent that only knows v1 answers 1 and reads its own.
      return { ...message, params: { ...message.params, info: clientInfo ?? { name: 'p9', version: '0' },
        capabilities: { ...(clientCapabilities?.elicitation && { elicitation: clientCapabilities.elicitation }) } } };
    }
    if (!v2 || message.id === undefined || !message.method) return message;
    const params = message.params ?? {};
    if (message.method === 'session/prompt') { sent.set(message.id, { prompt: params.sessionId }); turns.set(params.sessionId, { id: message.id, live: false }); }
    else if (message.method === 'session/new' || message.method === 'session/resume') sent.set(message.id, { config: true });
    else if (message.method === 'session/set_config_option') {
      sent.set(message.id, { config: true });
      if (params.type === undefined) return { ...message, params: { ...params, type: typeof params.value === 'boolean' ? 'boolean' : 'id' } };
    }
    return message;
  }

  function update(sessionId, u) {
    const kind = u?.sessionUpdate;
    if (DROPPED_UPDATES.has(kind)) return [];
    if (kind === 'state_update') {
      const turn = turns.get(sessionId);
      if (u.state === 'running') { if (turn) turn.live = true; return []; }
      // An idle with no prompt taken is not a turn's end: both agents send one after session/resume.
      if (u.state !== 'idle' || !turn?.live) return [];
      turns.delete(sessionId);
      if (u.stopReason === 'error') return [{ jsonrpc: '2.0', id: turn.id, error: { code: u.error?.code ?? -32603, message: String(u.error?.message ?? 'The agent reported an error'), ...(u.error?.data !== undefined && { data: u.error.data }) } }];
      return [{ jsonrpc: '2.0', id: turn.id, result: { stopReason: u.stopReason ?? 'end_turn', ...(u.usage && { usage: u.usage }), ...(u._meta && { _meta: u._meta }) } }];
    }
    if (kind === 'session_info_update' && !Object.keys(u).some((k) => k !== 'sessionUpdate' && k !== '_meta')) return [];
    if (kind === 'terminal_update') {
      // Both agents use the tool call's id as the terminal's. The output is the whole text so far, not a piece.
      if (typeof u.output?.data !== 'string' || !tools.has(sessionId + '\n' + u.terminalId)) return [];
      const text = Buffer.from(u.output.data, 'base64').toString('utf8').slice(-20000);
      return [{ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: u.terminalId, content: [{ type: 'content', content: { type: 'text', text } }] } } }];
    }
    let next = u;
    if (kind === 'tool_call_update') {
      const key = sessionId + '\n' + u.toolCallId;
      next = tool(u);
      if (!tools.has(key)) { tools.add(key); next = { title: String(u.name ?? 'Tool'), status: 'pending', ...next, sessionUpdate: 'tool_call' }; }
    } else if (kind === 'tool_call_content_chunk') next = { sessionUpdate: 'tool_call_update', toolCallId: u.toolCallId, content: content([u.content]) };
    else if (kind === 'config_option_update') next = withOptions(u);
    else if (kind === 'plan_update') { if (u.plan?.type !== 'items') return []; next = { sessionUpdate: 'plan', entries: u.plan.items ?? u.plan.entries ?? [] }; }
    else if (kind === 'notice') next = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: (u.severity === 'error' ? 'Error: ' : 'Warning: ') + u.title + (u.description ? '\n' + u.description : '') } };
    else if (kind === 'agent_message' || kind === 'agent_thought') {
      return (u.content ?? []).map((block) => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: kind + '_chunk', messageId: u.messageId, content: block } } }));
    }
    return [{ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: next } }];
  }

  function toClient(message) {
    if (initId !== undefined && message.id === initId && !message.method) {
      initId = undefined;
      const r = message.result;
      if (!(r?.protocolVersion >= 2)) return [message];
      v2 = true;
      const session = r.capabilities?.session ?? {};
      // close, resume and list are v2's baseline, so v2 does not list them; v1 code asks before closing.
      return [{ ...message, result: { protocolVersion: r.protocolVersion, agentInfo: r.info, authMethods: r.authMethods ?? [], ...(r._meta && { _meta: r._meta }),
        agentCapabilities: { promptCapabilities: { image: !!session.prompt?.image, embeddedContext: !!session.prompt?.embeddedContext, audio: !!session.prompt?.audio },
          mcpCapabilities: { http: !!session.mcp?.http, sse: !!session.mcp?.sse }, sessionCapabilities: { close: {}, resume: {}, list: {} },
          ...(r.capabilities?._meta && { _meta: r.capabilities._meta }) } } }];
    }
    if (!v2) return [message];
    if (message.id !== undefined && !message.method) {
      const was = sent.get(message.id);
      sent.delete(message.id);
      if (was?.prompt !== undefined) {
        const turn = turns.get(was.prompt);
        if (message.error) { if (turn?.id === message.id) turns.delete(was.prompt); return [message]; }
        if (turn?.id === message.id) turn.live = true;
        return []; // the v1 reply comes with the idle
      }
      return [was?.config && message.result ? { ...message, result: withOptions(message.result) } : message];
    }
    if (DROPPED_NOTIFICATIONS.has(message.method)) return [];
    if (message.method === 'session/update') return update(message.params?.sessionId, message.params?.update);
    if (message.method === 'session/request_permission') {
      const { title, description, subject, ...rest } = message.params ?? {};
      const call = subject?.type === 'tool_call' && subject.toolCall ? tool(subject.toolCall)
        : { toolCallId: subject?.toolCallId ?? 'permission-' + message.id, kind: subject?.type === 'command' ? 'execute' : 'other', status: 'pending',
          ...(subject?.type === 'command' && { rawInput: { command: subject.command, cwd: subject.cwd } }) };
      return [{ ...message, params: { ...rest, toolCall: { ...call, title: subject?.type === 'command' ? subject.command : (call.title ?? title), ...(description && { _meta: { ...call._meta, description } }) } } }];
    }
    return [message];
  }

  const out = new TransformStream({ transform: (message, controller) => controller.enqueue(toAgent(message)) });
  const back = new TransformStream({ transform: (message, controller) => { for (const m of toClient(message)) controller.enqueue(m); } });
  out.readable.pipeTo(stream.writable).catch(() => {});
  stream.readable.pipeTo(back.writable).catch(() => {});
  return { readable: back.readable, writable: out.writable, version: () => (v2 ? 2 : 1) };
}
