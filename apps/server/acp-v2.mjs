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
//   MCP servers      each names its transport type                  -> 'stdio' added where v1 leaves it off
//   tool calls       only tool_call_update; the first one creates   -> the first one per id becomes tool_call
//   diffs            a git patch                                    -> one diff per file: its hunks and whether it is new (O222: no text copy)
//   permission       title + subject                                -> toolCall
//   plan_update, notice                                             -> plan, the warning line's message chunk (O221)
//   command output   terminal_update, base64, id = the tool call's;  -> the tool call's text content (its last 20,000 chars)
//                    streamed as terminal_output_chunk pieces          (O219: each new piece once, marked _meta['p9/append'])
//   its exit         exitStatus {exitCode, signal}                  -> O220: if not 0 or a signal, a tool_call_update with _meta['p9/exit']
//   the prompt's echo, running/requires_action states, session_info_update with only _meta (Codex's thread status,
//   about eight a turn), sign-in status: dropped. P9 writes the user's message itself, and the sign-in notices
//   carry the account's email, which must not reach the ledger or a log.
//
// Why each v1 shape is kept (O121 part 4c): the readers that need it, outside this file (file:line on 0.1.9).
//   tool_call            the first update of a tool. 8 files: chat.mjs 262 671 1175 (where a run starts, a
//                        compaction, tool steps), ledger.mjs 251 (block starts), memory.mjs 120 182 270 (SQL on
//                        $.sessionUpdate), telemetry.mjs 100, delegate.mjs 1043 1052, move.mjs 120 123,
//                        web chat-view.mjs 1007 1017, phone.ts 412 562
//   agent_message_chunk  the reply text. 7 files: chat.mjs 259-286 (SQL: the reply, minus the Warning: lines) 370,
//                        ledger.mjs 250, memory.mjs 108 109 120 (SQL: $.content.text, $.messageId) 174,
//                        telemetry.mjs 99, delegate.mjs 1042, web chat-view.mjs 1013, phone.ts 405 561
//   stopReason reply     the turn's end. chat.mjs 1780 writes it into the ledger's turn-end event, read by 5 files:
//                        chat.mjs 1804-1812, ledger.mjs 149 (SQL), telemetry.mjs 108, web chat-view.mjs 1043, phone.ts 445
//   plan                 the plan strip: web chat-view.mjs 1023, phone.ts 411
//   agentCapabilities    chat.mjs 1214 (session.capabilities), read at 1280 (session close) and
//                        1334 1382 1752 (image prompts)
// Why the readers do not read the v2 kinds themselves (part 4d, deferred): the ledger's old rows are v1, so every
// reader above would read both shapes forever, or every old row would be migrated. Either is large, touches the
// SQL in chat.mjs, ledger.mjs and memory.mjs, and changes nothing the user sees; this one file keeps v2 in one place.

const DROPPED_UPDATES = new Set(['user_message', 'user_message_chunk']);
const OUTPUT_CHARS = 20000, OUTPUT_LIVE_CHARS = 2000, OUTPUT_EVERY_MS = 1000;
// The last n UTF-16 units of a text, never starting with half a surrogate pair.
const tail = (text, n) => { const t = text.slice(-n); return /^[\uDC00-\uDFFF]/.test(t) ? t.slice(1) : t; };
const DROPPED_NOTIFICATIONS = new Set(['auth/status_update', '_auth/status_update']);

const options = (list) => Array.isArray(list) ? list.map(({ configId, ...rest }) => (configId === undefined ? rest : { id: configId, ...rest })) : list;
const withOptions = (value) => (value && Array.isArray(value.configOptions) ? { ...value, configOptions: options(value.configOptions) } : value);

// One v1 diff per file in a git patch. O222: its lines are kept once, in _meta.hunks, and _meta.added says the file is new
// (the window's created mark, composer.mjs diffCreated). newText is '' only because the SDK's v1 diff schema requires a
// string; no oldText. Before O222 a diff also carried old/new text, so every line was stored twice.
// O121 part 2: each file keeps its hunks in _meta.hunks (the SDK drops a diff's other unknown fields; { old, new, rows }: start lines and ['ctx'|'add'|'del', text] rows), so the
// chat shows each hunk with its line numbers. A hunk's lines are counted from its @@ header, so a removed line that reads
// "-- x" or an added "++ x" is content, never a ---/+++ file line.
export function diffs(item) {
  const text = item?.patch?.text;
  if (typeof text !== 'string') return [];
  const out = [];
  let file, hunk, left = 0, right = 0;
  for (const line of text.split('\n')) {
    if (hunk && (left > 0 || right > 0)) {
      const sign = line[0], body = line.slice(1);
      if (sign === '+' && right > 0) { hunk.rows.push(['add', body]); right -= 1; continue; }
      if (sign === '-' && left > 0) { hunk.rows.push(['del', body]); left -= 1; continue; }
      if ((sign === ' ' || line === '') && left > 0 && right > 0) { hunk.rows.push(['ctx', body]); left -= 1; right -= 1; continue; }
    }
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    if (line.startsWith('diff --git ')) { out.push(file = { path: '', added: false, hunks: [] }); hunk = null; continue; }
    if (!file) continue;
    const at = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (at) { file.hunks.push(hunk = { old: +at[1], new: +at[3], rows: [] }); left = at[2] === undefined ? 1 : +at[2]; right = at[4] === undefined ? 1 : +at[4]; }
    else if (line.startsWith('--- ')) { if (line.slice(4) === '/dev/null') file.added = true; else file.path = line.slice(4); }
    else if (line.startsWith('+++ ')) { if (line.slice(4) !== '/dev/null') file.path = line.slice(4); }
    else if (line.startsWith('rename to ')) file.path = line.slice(10);
  }
  return out.filter((f) => f.path).map((f) => ({ type: 'diff', path: f.path, newText: '', _meta: { added: f.added, hunks: f.hunks } }));
}
const content = (list) => Array.isArray(list) ? list.flatMap((item) => (item?.type === 'diff' && item.patch ? diffs(item) : [item])) : list;
const tool = (call) => (call && Array.isArray(call.content) ? { ...call, content: content(call.content) } : call);

export function v1Stream(stream) {
  let v2 = false;
  let initId;
  const sent = new Map(); // request id -> what its reply needs: { prompt: sessionId } or { config: true }
  const turns = new Map(); // sessionId -> { id, live }: the held v1 prompt request; live once the agent took it
  const tools = new Set(); // sessionId + toolCallId already announced as a tool_call
  // O121 part 3, O219: each running command's output not yet shown, by sessionId + terminalId (the tool call's id):
  // { text, skipped, whole, decoder, at, held, timer }. codex-acp 2.6.0 streams it as pieces; each shown update is a
  // ledger row, so it holds only the new text, marked _meta['p9/append'] for the window and phone to add to the tool's
  // text (an hour of printing writes its output once, not the whole text each second). A piece shows at once only a
  // second after the last one shown; one held shows a second after that one (timer), or at the exit, the tool call's
  // end or the turn's end, whichever comes first. At most the last 2,000 characters a second are kept ('…' marks the
  // cut). The decoder keeps a character split across two pieces whole. A terminal_update's output is the whole text
  // (whole): it shows as a replacing update, unmarked. Forgotten at the exit, the tool call's end and the idle.
  const outputs = new Map();
  // O220: a command that failed (exit code not 0) or was killed (signal) says so on its tool call: a tool_call_update with
  // only _meta['p9/exit'] {exitCode, signal}, after the output its exit flushed. A command that ends before its tool call
  // is announced keeps its last output and its exit here (by sessionId + terminalId, the messages to send) for the
  // announcement; the idle forgets them. Only a whole number and a string of at most 32 characters are passed on (the
  // window and phone check again, exitTag in helpers.mjs).
  const early = new Map();
  const failure = (x) => {
    const exitCode = Number.isSafeInteger(x?.exitCode) ? x.exitCode : null, signal = typeof x?.signal === 'string' && x.signal ? x.signal.slice(0, 32) : null;
    return exitCode || signal ? { exitCode, signal } : null;
  };
  const exitRow = (sessionId, toolCallId, exit) => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId, _meta: { 'p9/exit': exit } } } });
  let emit = () => {}; // sends a message to P9 between the agent's messages (the held output's timer)
  const forget = (key, o) => { clearTimeout(o.timer); outputs.delete(key); };
  const pending = (o) => { o.held = o.text !== '' || o.skipped || o.whole !== null; };
  const shown = (sessionId, terminalId, o) => {
    const cut = o.skipped ? '…\n' : '', whole = o.whole;
    clearTimeout(o.timer); o.timer = null;
    const text = whole === null ? cut + o.text : tail(whole + cut + o.text, OUTPUT_CHARS);
    o.at = Date.now(); o.held = false; o.text = ''; o.skipped = false; o.whole = null;
    return { jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: terminalId,
      content: [{ type: 'content', content: { type: 'text', text } }], ...(whole === null && { _meta: { 'p9/append': true } }) } } };
  };
  // The end of a command's output: the decoder's last bytes join what is held, and the command is forgotten.
  const ended = (key, o) => { o.text += o.decoder.decode(); pending(o); forget(key, o); };
  // What is held of a session's commands (one tool call's when id is given), shown now; at an end, forgotten too.
  const flush = (sessionId, id, end) => [...outputs].flatMap(([key, o]) => {
    const [s, terminalId] = key.split('\n');
    if (s !== sessionId || (id !== undefined && terminalId !== id)) return [];
    if (end) ended(key, o);
    return o.held && tools.has(key) ? [shown(sessionId, terminalId, o)] : [];
  });

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
    else if (message.method === 'session/new' || message.method === 'session/resume') {
      sent.set(message.id, { config: true });
      // v2 names each MCP server's transport; v1 leaves it off a stdio one. Without it codex-acp 2.6.0 refuses the session.
      if (Array.isArray(params.mcpServers)) return { ...message, params: { ...params, mcpServers: params.mcpServers.map((server) => (server.type ? server : { ...server, type: 'stdio' })) } };
    }
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
      if (u.state !== 'idle') return [];
      const held = flush(sessionId, undefined, true);
      for (const key of early.keys()) if (key.startsWith(sessionId + '\n')) early.delete(key);
      if (!turn?.live) return held;
      turns.delete(sessionId);
      if (u.stopReason === 'error') return [...held, { jsonrpc: '2.0', id: turn.id, error: { code: u.error?.code ?? -32603, message: String(u.error?.message ?? 'The agent reported an error'), ...(u.error?.data !== undefined && { data: u.error.data }) } }];
      return [...held, { jsonrpc: '2.0', id: turn.id, result: { stopReason: u.stopReason ?? 'end_turn', ...(u.usage && { usage: u.usage }), ...(u._meta && { _meta: u._meta }) } }];
    }
    if (kind === 'session_info_update' && !Object.keys(u).some((k) => k !== 'sessionUpdate' && k !== '_meta')) return [];
    if (kind === 'terminal_update' || kind === 'terminal_output_chunk') {
      // Both agents use the tool call's id as the terminal's. A terminal_update's output is the whole text so far; a
      // chunk is the next piece of it.
      if (typeof u.terminalId !== 'string') return [];
      const key = sessionId + '\n' + u.terminalId, data = kind === 'terminal_update' ? u.output?.data : u.data, end = kind === 'terminal_update' && u.exitStatus;
      let o = outputs.get(key);
      if (typeof data === 'string') {
        if (!o) outputs.set(key, o = { text: '', skipped: false, whole: null, decoder: new TextDecoder(), at: 0, held: false });
        const piece = Buffer.from(data, 'base64');
        if (kind === 'terminal_update') { o.decoder = new TextDecoder(); o.whole = tail(o.decoder.decode(piece, { stream: true }), OUTPUT_CHARS); o.text = ''; o.skipped = false; }
        else {
          o.text += o.decoder.decode(piece, { stream: true });
          if (o.text.length > OUTPUT_LIVE_CHARS) { o.text = tail(o.text, OUTPUT_LIVE_CHARS); o.skipped = true; }
        }
        pending(o);
      }
      if (end && o) ended(key, o);
      const failed = end && failure(u.exitStatus), told = failed ? [exitRow(sessionId, u.terminalId, failed)] : [];
      if (end && !tools.has(key)) { const held = [...(o?.held ? [shown(sessionId, u.terminalId, o)] : []), ...told]; if (held.length) early.set(key, held); return []; }
      if (!o?.held || !tools.has(key)) return told;
      const wait = OUTPUT_EVERY_MS - (Date.now() - o.at);
      if (end || wait <= 0) return [shown(sessionId, u.terminalId, o), ...told];
      o.timer ??= setTimeout(() => { if (outputs.get(key) === o && o.held) emit(shown(sessionId, u.terminalId, o)); }, wait);
      o.timer.unref?.();
      return [];
    }
    let next = u, before = [], after = [];
    if (kind === 'tool_call_update') {
      const key = sessionId + '\n' + u.toolCallId, end = u.status === 'completed' || u.status === 'failed';
      next = tool(u);
      // Output that came before its tool call was announced shows right after the announcement.
      if (!tools.has(key)) { tools.add(key); next = { title: String(u.name ?? 'Tool'), status: 'pending', ...next, sessionUpdate: 'tool_call' }; after = flush(sessionId, u.toolCallId, end);
        const held = early.get(key); if (held) { early.delete(key); after.push(...held); } }
      else if (end) before = flush(sessionId, u.toolCallId, true);
    } else if (kind === 'tool_call_content_chunk') next = { sessionUpdate: 'tool_call_update', toolCallId: u.toolCallId, content: content([u.content]) };
    else if (kind === 'config_option_update') next = withOptions(u);
    else if (kind === 'plan_update') { if (u.plan?.type !== 'items') return []; next = { sessionUpdate: 'plan', entries: u.plan.items ?? u.plan.entries ?? [] }; }
    else if (kind === 'notice') {
      // O221: exactly the shape the window and phone draw as the warning line and the chat list leaves out of the
      // preview (agentWarning, helpers.mjs); any other shape read as words of the reply. A blank notice is dropped.
      const text = [u.title, u.description].map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean).join('\n');
      if (!text) return [];
      next = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Warning: ' + (u.severity === 'error' ? 'Error: ' : '') + text + '\n\n' } };
    }
    else if (kind === 'agent_message' || kind === 'agent_thought') {
      return (u.content ?? []).map((block) => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: kind + '_chunk', messageId: u.messageId, content: block } } }));
    }
    return [...before, { jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: next } }, ...after];
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
        if (turn?.id !== message.id) return [];
        turn.live = true;
        // The v1 reply comes with the idle. O214: this reply says the agent took the message into its thread now, which
        // v1 has no word for; told as a notification of P9's own, so a restart before the idle does not send it again.
        return [{ jsonrpc: '2.0', method: '_p9/prompt_taken', params: { sessionId: was.prompt } }];
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
  const back = new TransformStream({
    start: (controller) => { emit = (m) => { try { controller.enqueue(m); } catch { /* the stream has closed */ } }; },
    transform: (message, controller) => { for (const m of toClient(message)) controller.enqueue(m); },
    flush: () => { for (const [key, o] of outputs) forget(key, o); },
  });
  out.readable.pipeTo(stream.writable).catch(() => {});
  stream.readable.pipeTo(back.writable).catch(() => {});
  return { readable: back.readable, writable: out.writable, version: () => (v2 ? 2 : 1) };
}
