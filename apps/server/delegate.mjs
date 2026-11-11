// A7 Delegate: the P9 MCP tools that let one chat's agent start and steer other chats (SECURITY.md § Delegate).
// The chat that calls open_chat is the parent, the chats it starts are its sub-agents, the group is a sprint.
// Everything here goes through chat.mjs's own create, prompt, stop and answer, so a sub-agent is an ordinary chat.
const ID = /^[0-9a-f-]{36}$/;
const KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// How wide a mode is, across both agents: 0 reads only, 1 asks before each action, 2 edits files, 3 acts with a
// reviewer, 4 acts unasked. A sub-agent's tier is never above its sender's.
const TIER = { claude: { Plan: 0, Manual: 1, 'Accept edits': 2, Auto: 3, 'Bypass permissions': 4 },
  codex: { 'Read-only': 0, 'Workspace access': 2, 'Auto review': 3, 'Full access': 4 } };
const WAIT_MS = 50_000; // ponytail: below both agents' MCP call limit as the spec read it; not measured against a real agent yet
const MAX_CHILDREN = 20, MAX_DEPTH = 3; // ponytail: a runaway guard, not a tuned limit
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;

export const DELEGATE_TOOLS = (input) => {
  const chat = { type: 'string', description: 'A chat ID from open_chat or list_chats.' };
  return [
    ['open_chat', 'Start a sub-agent: a new chat in your project that begins work on text. Left out, provider, model, effort, mode and folder are yours. mode may be narrower '
      + 'than yours, never wider. The same key from you returns the chat it made before instead of a second one. The user is asked first, except in Unrestricted mode. '
      + 'Returns the chat\'s ID and the folder it works in; follow it with wait_chat.',
    input({ text: { type: 'string', description: 'The first message: the whole task, since the sub-agent knows nothing of your chat.' },
      title: { type: 'string', maxLength: 120 }, key: { type: 'string', description: 'Your name for it: 1 to 64 of a-z 0-9 . _ -' },
      provider: { type: 'string', enum: ['claude', 'codex'] }, model: { type: 'string', description: 'A model that agent offers.' },
      effort: { type: 'string' }, mode: { type: 'string', description: 'Claude: Plan, Manual, Accept edits, Auto, Bypass permissions. Codex: Read-only, Workspace access, Auto review, Full access.' },
      folder: { type: 'string', description: 'Where it starts, relative to the workspace.' } }, ['text'])],
    ['send_chat', 'Send a message to a chat in your project or one you started. when: auto (the default: starts a turn, or goes into the running one), steer (into the running turn) '
      + 'or queue (after the running turn). It runs no wider than your own mode.',
    input({ chat, text: { type: 'string' }, when: { type: 'string', enum: ['auto', 'steer', 'queue'] } }, ['chat', 'text'])],
    ['wait_chat', 'Wait until a chat\'s turn ends, or it asks for an approval or an answer, or timeoutMs passes (default and most: ' + WAIT_MS + '). Returns state (working, idle, '
      + 'stopped or failed), ended, waiting (the open approval or question, or null), timedOut and last (the end of its newest reply). A timeout stops nothing: call it again.',
    input({ chat, timeoutMs: { type: 'integer', minimum: 0, maximum: WAIT_MS } }, ['chat'])],
    ['read_chat', 'Read a chat\'s messages after a cursor: what it was sent and what it replied, oldest first, with next for the following call. Without after, it starts at '
      + 'the newest message the chat was sent. view: activity adds each tool call as one line.',
    input({ chat, after: { type: 'integer', minimum: 0 }, view: { type: 'string', enum: ['messages', 'activity'] } }, ['chat'])],
    ['stop_chat', 'Interrupt the running turn of a chat you started, and of the chats it started. With close: true they are stopped altogether.',
      input({ chat, close: { type: 'boolean' } }, ['chat'])],
    ['list_chats', 'The chats you can reach: your project\'s and the ones you started. Each has id, title, provider, state, waiting, parent, key and preview.', input({})],
    ['answer_chat', 'Answer a question a chat you started is waiting on (wait_chat\'s waiting, kind question). An approval is the user\'s: it is refused.',
      input({ chat, request: { type: 'string', description: 'waiting.request from wait_chat.' },
        answer: { type: 'object', description: '{ "action": "accept", "content": { field: value } } with the fields of waiting.form, or { "action": "decline" }.' } }, ['chat', 'request', 'answer'])],
  ];
};

export function createDelegate({ chat, allowed }) {
  const waiting = new Map(); // chat -> how many wait_chat calls are open on it
  const tierOf = (provider, mode) => TIER[provider]?.[mode];
  // The widest mode of provider at or under tier.
  const under = (provider, tier) => Object.entries(TIER[provider]).filter(([, t]) => t <= tier).sort((a, b) => b[1] - a[1])[0]?.[0];
  // The chats a caller started, directly or through one of them.
  const below = (family, id) => {
    const found = [];
    for (let level = [id], depth = 0; level.length && depth < 50; depth += 1) {
      level = family.filter((c) => c.parent && level.includes(c.parent) && !found.includes(c.id)).map((c) => c.id);
      found.push(...level);
    }
    return found;
  };
  // A target the caller may read and message: in its project, or started by it. Anything else does not exist to it.
  const reach = (caller, target, own = false) => {
    if (!ID.test(target ?? '') || target === caller) return null;
    const family = chat.family(), me = family.find((c) => c.id === caller), it = family.find((c) => c.id === target);
    if (!me || !it) return null;
    const mine = below(family, caller).includes(target);
    return mine || (!own && me.project && me.project === it.project) ? { mine, family } : null;
  };
  const lastLine = (reply) => reply.split('\n').map((line) => line.trim()).filter(Boolean).at(-1) ?? '';
  const stateOf = (info) => info.state === 'turn' || info.busy ? 'working' : ['idle', 'running'].includes(info.state) ? 'idle' : info.state === 'stopped' ? 'stopped' : info.state;
  // The mode a message from caller may run target in: the target's own, brought down to the caller's tier.
  const modeFor = (caller, target, asked) => {
    const mine = chat.info(caller), ceiling = tierOf(mine.provider, mine.mode);
    if (ceiling === undefined) return { error: 'mode-unknown', detail: 'Your own mode is not known yet; send again.' };
    const want = asked ?? (target.mode && tierOf(target.provider, target.mode) <= ceiling ? target.mode
      : target.provider === mine.provider ? mine.mode : under(target.provider, ceiling));
    const tier = tierOf(target.provider, want);
    if (tier === undefined) return { error: 'request-refused', detail: 'mode: one of ' + Object.keys(TIER[target.provider]).join(', ') };
    if (tier > ceiling) return { error: 'mode-escalation', detail: 'A sub-agent is never wider than you: your mode is ' + mine.mode + '.' };
    return { mode: want };
  };

  async function openChat(caller, args, signal) {
    if (chat.lock().on) return { error: 'agent-lock-on' };
    const me = chat.info(caller);
    if (!text(args.text, 100_000) || (args.title !== undefined && !text(args.title, 120)) || (args.key !== undefined && (typeof args.key !== 'string' || !KEY.test(args.key)))
        || (args.provider !== undefined && !Object.hasOwn(TIER, args.provider)) || (args.model !== undefined && !text(args.model, 200))
        || (args.effort !== undefined && !text(args.effort, 200)) || (args.folder !== undefined && typeof args.folder !== 'string')) return { error: 'request-refused' };
    const family = chat.family();
    const same = args.key !== undefined && family.find((c) => c.parent === caller && c.key === args.key);
    if (same) return { chat: same.id, existing: true, title: same.title, state: stateOf(chat.info(same.id)), folder: await chat.startFolder(same.id) };
    let depth = 0;
    for (let at = family.find((c) => c.id === caller); at?.parent && depth < 50; at = family.find((c) => c.id === at.parent)) depth += 1;
    if (depth >= MAX_DEPTH || family.filter((c) => c.parent === caller && !['stopped', 'moved'].includes(c.state)).length >= MAX_CHILDREN) {
      return { error: 'too-many-chats', detail: 'At most ' + MAX_CHILDREN + ' running sub-agents per chat, ' + MAX_DEPTH + ' levels deep.' };
    }
    const provider = args.provider ?? me.provider;
    const picked = modeFor(caller, { provider, mode: null }, args.mode);
    if (picked.error) return picked;
    // A profile chat's sub-agent stays on that profile and model (its model is fixed for the chat); otherwise the caller's model.
    const profile = provider === me.provider && me.profile && !me.profile.gone ? { profile: me.profile.id, model: args.model ?? me.profile.model } : null;
    const model = profile ? undefined : args.model ?? (provider === me.provider ? me.model ?? undefined : undefined);
    const effortId = (provider === me.provider && me.effort?.id) || chat.lists()[provider]?.pickers?.find((o) => o.category === 'thought_level')?.id;
    const effort = args.effort ?? (provider === me.provider ? me.effort?.value : undefined);
    if (args.effort !== undefined && !effortId) return { error: 'effort-unknown', detail: 'That agent\'s effort list is not known yet; leave effort out.' };
    const folder = args.folder ?? (me.folder.startsWith(':') ? undefined : me.folder); // ':…' is a project's own files: the project places the chat
    const title = args.title ?? args.text.trim().split('\n')[0].slice(0, 60);
    const ask = 'P9 Delegate: start a ' + (provider === 'claude' ? 'Claude' : 'Codex') + ' sub-agent "' + title + '" in mode ' + picked.mode
      + (args.folder ? ', folder ' + args.folder : '') + '. Its task: ' + args.text.slice(0, 600) + (args.text.length > 600 ? '…' : '');
    if (!await allowed(caller, { toolCallId: 'p9-mcp-' + crypto.randomUUID(), title: ask, kind: 'execute' }, signal)) return { error: 'not-allowed', detail: 'The user did not allow it.' };
    const made = await chat.create({ provider, title, ...(folder !== undefined && { folder }), ...(me.project && { project: me.project }), ...profile }, undefined, { parent: caller, key: args.key });
    if (made.status !== 201) return { error: made.error === 'key-taken' ? 'key-taken' : args.folder !== undefined ? 'folder-refused' : made.error ?? 'request-refused' };
    const sent = await chat.prompt(made.conversation, { text: args.text, mode: picked.mode, ...(model && { model }), ...(effort && effortId && { config: { [effortId]: effort } }) }, undefined, caller);
    if (sent.status !== 202) return { error: sent.error ?? 'chat-not-sendable', chat: made.conversation, detail: 'The chat was made, but the message was not sent; send_chat can try again.' };
    return { chat: made.conversation, title, provider, mode: picked.mode, folder: await chat.startFolder(made.conversation) };
  }

  async function sendChat(caller, args) {
    if (chat.lock().on) return { error: 'agent-lock-on' };
    if (!text(args.text, 100_000) || (args.when !== undefined && !['auto', 'steer', 'queue'].includes(args.when))) return { error: 'request-refused' };
    if (!reach(caller, args.chat)) return { error: 'chat-not-found' };
    const target = chat.info(args.chat), picked = modeFor(caller, target);
    if (picked.error) return picked;
    const sent = await chat.prompt(args.chat, { text: args.text, mode: picked.mode, ...(args.when && args.when !== 'auto' && { when: args.when }) }, undefined, caller);
    if (sent.status !== 202) return { error: 'chat-not-sendable', reason: sent.error, state: stateOf(chat.info(args.chat)) };
    return { chat: args.chat, sent: sent.held ? 'waiting for ' + (sent.when === 'queue' ? 'the turn to end' : 'its next step') : sent.steered ? 'into its running turn' : 'started a turn' };
  }

  async function waitChat(caller, args, signal) {
    if (!reach(caller, args.chat)) return { error: 'chat-not-found' };
    if (args.timeoutMs !== undefined && (!Number.isSafeInteger(args.timeoutMs) || args.timeoutMs < 0)) return { error: 'request-refused' };
    const until = Date.now() + Math.min(args.timeoutMs ?? WAIT_MS, WAIT_MS);
    waiting.set(args.chat, (waiting.get(args.chat) ?? 0) + 1);
    try {
      for (;;) {
        const info = chat.info(args.chat);
        if (!info) return { error: 'chat-not-found' };
        const ask = info.asks[0] ?? null, state = stateOf(info), left = until - Date.now();
        if (ask || state !== 'working' || left <= 0 || signal?.aborted) {
          return { chat: args.chat, state, ended: state !== 'working', waiting: ask, timedOut: state === 'working' && !ask, last: chat.reply(args.chat).slice(-400) };
        }
        await Promise.race([chat.changed(Math.min(left, 8000)), new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true }))]);
      }
    } finally {
      const n = waiting.get(args.chat) - 1;
      if (n > 0) waiting.set(args.chat, n); else waiting.delete(args.chat);
    }
  }

  async function readChat(caller, args) {
    if (!reach(caller, args.chat)) return { error: 'chat-not-found' };
    if ((args.after !== undefined && (!Number.isSafeInteger(args.after) || args.after < 0)) || (args.view !== undefined && !['messages', 'activity'].includes(args.view))) return { error: 'request-refused' };
    const from = args.after ?? Math.max(0, chat.info(args.chat).asked - 1);
    const page = await chat.events(from, 0, [args.chat]);
    const messages = [];
    let size = 0, next = from, more = false;
    for (const event of page.events) {
      const update = event.type === 'update' ? event.data : null;
      const said = event.type === 'user' ? { role: 'user', text: String(event.data.text ?? ''), ...(event.data.from && { from: event.data.from }) }
        : update?.sessionUpdate === 'agent_message_chunk' && typeof update.content?.text === 'string' ? { role: 'assistant', text: update.content.text }
          : update?.sessionUpdate === 'tool_call' && args.view === 'activity' ? { role: 'tool', text: String(update.title ?? update.kind ?? 'tool').slice(0, 300) } : null;
      if (said) {
        // ponytail: 20,000 characters or 60 messages a call; next carries on from the first one left out.
        if (size + said.text.length > 20_000 || messages.length >= 60) { more = true; break; }
        size += said.text.length;
        const run = messages.at(-1);
        if (said.role === 'assistant' && run?.role === 'assistant') run.text += said.text; else messages.push({ cursor: event.cursor, ...said });
      } else if (update?.sessionUpdate === 'tool_call' && messages.at(-1)?.role === 'assistant') messages.push({ cursor: event.cursor, role: 'break' });
      next = event.cursor;
    }
    if (!more && page.events.length < 500) next = Math.max(next, page.cursor);
    return { chat: args.chat, messages: messages.filter((m) => m.role !== 'break'), next, more: more || page.events.length >= 500 };
  }

  async function stopChat(caller, args) {
    const found = reach(caller, args.chat, true);
    if (!found) return { error: reach(caller, args.chat) ? 'not-a-descendant' : 'chat-not-found' };
    if (args.close !== undefined && typeof args.close !== 'boolean') return { error: 'request-refused' };
    // The chats it started first, deepest last in the list, so they end before the one that would restart them.
    const all = [...below(found.family, args.chat).reverse(), args.chat], stopped = [];
    for (const id of all) {
      const result = args.close ? await chat.stop(id) : await chat.cancel(id);
      if (result.status === 200) stopped.push(id);
      else if (args.close) return { error: 'stop-failed', chat: id, stopped };
    }
    return { chat: args.chat, action: args.close ? 'stopped' : 'interrupted', chats: stopped };
  }

  function listChats(caller) {
    const family = chat.family(), me = family.find((c) => c.id === caller), mine = below(family, caller);
    const rows = chat.list().filter((c) => c.id !== caller && !c.archived && (mine.includes(c.id) || (me?.project && c.project === me.project)));
    return { chats: rows.slice(0, 200).map((c) => ({ id: c.id, title: c.title, provider: c.provider, state: stateOf({ ...c, busy: false }), waiting: c.waiting,
      parent: c.parent ?? null, key: family.find((f) => f.id === c.id)?.key ?? null, yours: mine.includes(c.id), preview: c.preview })), ...(rows.length > 200 && { more: rows.length - 200 }) };
  }

  function answerChat(caller, args) {
    if (chat.lock().on) return { error: 'agent-lock-on' };
    if (!reach(caller, args.chat, true)) return { error: reach(caller, args.chat) ? 'not-a-descendant' : 'chat-not-found' };
    const ask = chat.info(args.chat).asks.find((a) => a.request === args.request);
    if (!ask) return { error: 'no-such-request' };
    if (ask.kind !== 'question') return { error: 'approval-is-the-users', detail: 'Only the user answers an approval; it is shown in that chat.' };
    const result = chat.answer(args.chat, { request: args.request, answer: args.answer }, caller);
    return result.status === 200 ? { chat: args.chat, action: 'answered' } : { error: result.error, ...(ask.form && { form: ask.form }) };
  }

  // When a sub-agent's turn ends and its parent is not in a wait_chat on it, the parent gets one line (SECURITY.md
  // § Delegate). Only a parent whose agent is running: an idle-since-start or stopped chat is never started by this.
  chat.settled((id, ok) => {
    const child = chat.info(id), parent = child?.parent && chat.info(child.parent);
    if (!parent || waiting.has(id) || !['running', 'turn'].includes(parent.state)) return;
    const line = '[p9] ' + child.title + (ok ? ' finished: ' + lastLine(chat.reply(id)).slice(0, 400) : ' failed; read_chat shows why.');
    chat.prompt(parent.id, { text: line, ...(parent.state === 'turn' && { when: 'steer' }) }, undefined, 'p9')
      .then((sent) => sent.status === 409 && chat.prompt(parent.id, { text: line, when: 'queue' }, undefined, 'p9')).catch(() => {});
  });

  return {
    open_chat: (args, caller, signal) => openChat(caller, args, signal),
    send_chat: (args, caller) => sendChat(caller, args),
    wait_chat: (args, caller, signal) => waitChat(caller, args, signal),
    read_chat: (args, caller) => readChat(caller, args),
    stop_chat: (args, caller) => stopChat(caller, args),
    list_chats: (args, caller) => listChats(caller),
    answer_chat: (args, caller) => answerChat(caller, args),
  };
}
