// Test-only ACP agent, ported from agent-first-workspace's _engine/fake-acp-agent.ts. The prompt text picks the
// behaviour: "permission" asks for approval, "ask" sends a form question ("ask-later" after 2 s of work, "ask-text" a free-text one), "stream <n>" streams 3n updates, "background" ends
// its turn and works on unprompted without end, asking once ("background quiet" never); messages steered (_session/steering, off with a no-steering file, and as Claude asked for ACP 2) or prompted
// into it come back as "got:<text>" at its next step, "ask-strict" one with required, integer,
// multi-select, pattern and format fields (some limits null) and optional choices, "ask-object" one with a nested
// object P9 cannot render, "slow" waits for cancel, "crash" exits, "auth-required" fails the turn signed out, "detach" starts a setsid sleeper and replies with its
// pid, "env" replies with its environment's names (never values), "mcp" with the MCP servers P9 handed it, "config" with its model and settings, "probe <port> <host> <script>" runs the phase 10 credential probe, anything else is echoed. A file named slow-init in
// the working directory stalls initialize for 10 s, hang-init never answers it; slow-close stalls session/close for 2 s.
// "tools <n>" runs n tool calls of 3 s each (10 s with a slow-tools file, 40 s with slower-tools too; a cancel ends them), "tool-open" one that never completes before the turn ends, "tool-last" one
// that completes as the turn ends. Each steer is appended to steers.log; as Codex, one past the turn starts a turn of its
// own (startedNewTurn) that answers "got:<text>" and reports no end. "limits <n>" ends the turn, then reports context and plan use at n% a second later.
import { Readable, Writable } from 'node:stream';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import * as acp from '../apps/server/acp.mjs';

// Run as the adapter's login CLI (threat model row 31): records its arguments in fake-login-argv, prints the URL in
// fake-login-url (else a claude.com one) and a paste prompt, and records each stdin line in fake-login-code; "done" exits 0.
if (process.argv.includes('--cli') || process.argv[3] === 'cli') {
  writeFileSync('fake-login-argv', JSON.stringify(process.argv.slice(2)));
  const url = existsSync('fake-login-url') ? readFileSync('fake-login-url', 'utf8').trim() : 'https://claude.com/cai/oauth/authorize?fake=1';
  // Codex's device sign-in (D8), as codex 0.159 prints it, with the code in fake-login-device; "unsupported" is a codex
  // without the flag, which exits 2 naming it.
  if (process.argv.includes('--device-auth')) {
    const code = existsSync('fake-login-device') ? readFileSync('fake-login-device', 'utf8').trim() : 'ABCD-12345';
    if (code === 'unsupported') { process.stderr.write("error: unexpected argument '--device-auth' found\n"); process.exit(2); }
    process.stdout.write('Follow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   \x1b[94m'
      + (existsSync('fake-login-url') ? url : 'https://auth.openai.com/codex/device') + '\x1b[0m\n\n2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94m' + code + '\x1b[0m\n');
    setInterval(() => {}, 60000); // waits, as codex polls OpenAI, until Stop
    await new Promise(() => {});
  }
  process.stdout.write("Opening the browser to sign in\nIf the browser didn't open, visit: " + url + '\nPaste code here if prompted > ');
  let buffer = '';
  process.stdin.setEncoding('utf8').on('data', (chunk) => {
    buffer += chunk;
    for (let end; (end = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(end + 1)) {
      appendFileSync('fake-login-code', JSON.stringify(buffer.slice(0, end)) + '\n');
      // O187: the window refreshes once right after the code send; that this exit can be recorded only after that
      // refresh — leaving Retry to the next 10 s poll — is the source-supported hypothesis for two CI timeouts, not
      // an observed order. The gate is a timed slow-exit stress case for that shape, not a proof of it.
      if (buffer.slice(0, end) === 'done') {
        if (existsSync('login-exit-slow')) { setTimeout(() => process.exit(0), 12000); return; }
        process.exit(0);
      }
    }
  });
  await new Promise(() => {});
}

const cancelled = new Set();
// Messages that reach a running turn (a steer) or the unprompted work ("background"): answered at its next step.
const turns = new Set(), background = new Set(), inbox = new Map();
const deliver = (sessionId, text) => new Promise((done) => { if (!inbox.has(sessionId)) inbox.set(sessionId, []); inbox.get(sessionId).push({ text, done }); });
const take = async (sessionId, say) => { for (const m of inbox.get(sessionId)?.splice(0) ?? []) { await say('got:' + m.text); m.done(); } };
// A7: P9's sprint rules block is not the message: it goes to rules.log (one JSON string a line) and the commands below never see it.
const SPRINT = '[P9: sprint rules';
const FROM = '[P9: from another chat';
const NOTE = '[P9: a note from another chat'; // P9's parked end notes (O188) arrive as '[p9] <title> ended its turn: ...\n\n' blocks and are not the message either; // a note's sender line; a note that waited is one block, line and text // the sender label, to from.log the same way
const sprintRules = (prompt) => { for (const block of prompt) if (block.type === 'text') { if (block.text.startsWith(SPRINT)) appendFileSync('rules.log', JSON.stringify(block.text) + '\n'); if (block.text.startsWith(FROM)) appendFileSync('from.log', JSON.stringify(block.text) + '\n'); if (CUTS.some((c) => block.text.startsWith(c))) appendFileSync('cut.log', JSON.stringify(block.text) + '\n'); } };
// O171: a start block with no rules block before it (a lead started from the Setup page gets it with P9's message).
const START = ['[P9: your instructions', '[P9: you lead this sprint', '[P9: your notes file'];
const LINES = ['[P9: from the user, in this chat.]\n\n', '[P9: a line from P9 itself, not from the user.]\n\n']; // a sender line as its own block (O109)
// O231: what cut a call short (a steer, a restart, stop_chat) is P9's line, not the message: it goes to cut.log the same way.
const CUTS = ['[P9: this message was steered', '[P9: your last turn was cut short'];
const textOf = (prompt) => prompt.filter((block) => !(block.type === 'text' && (CUTS.some((c) => block.text.startsWith(c)) || block.text.startsWith(SPRINT) || block.text.startsWith(FROM) || block.text.startsWith(NOTE) || (block.text.startsWith('[p9] ') && block.text.includes(' ended its turn: ') && block.text.endsWith('\n\n')) || START.some((s) => block.text.startsWith(s)) || LINES.includes(block.text)))).map((block) => (block.type === 'text' ? block.text : block.type === 'image' ? '[image ' + block.mimeType + ' ' + Buffer.from(block.data, 'base64').length + ']' : block.type === 'resource_link' ? '[file ' + block.name + ' ' + block.uri + ']' : '')).join('');
// A real w x h RGB PNG as base64 (a red-green gradient), like the image an agent makes.
const png = (w, h) => {
  const chunk = (type, data) => { const head = Buffer.alloc(4), tail = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type), data]);
    head.writeUInt32BE(data.length); tail.writeUInt32BE(crc32(body)); return Buffer.concat([head, body, tail]); };
  const raw = Buffer.alloc((w * 3 + 1) * h), ihdr = Buffer.alloc(13);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) raw.set([Math.floor(x * 255 / w), Math.floor(y * 255 / h), 200], y * (w * 3 + 1) + 1 + x * 3);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
};
let squeezes = 0, mode = 'unset', model = process.env.ANTHROPIC_MODEL ?? 'default', cwd = '', mcpServers = null, folder = '';
// claude-home (Send to server, D14): a transcript where Claude Code keeps one, <home>/.claude/projects/<folder>/<id>.jsonl,
// and a resume only of a session whose transcript is there (claude-agent-acp's findTranscript searches every folder).
// The home is the test's (XDG_STATE_HOME, which the daemon passes on); never HOME, so a test cannot write a real one.
const projects = () => existsSync('claude-home') && process.env.XDG_STATE_HOME ? path.join(process.env.XDG_STATE_HOME, '.claude', 'projects') : null;
// As codex, the same marker keeps a rollout where Codex does, <home>/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl,
// and resumes only a session whose rollout is there (item 10).
const rollouts = () => projects() && path.join(process.env.XDG_STATE_HOME, '.codex', 'sessions');
const transcript = (sessionId) => {
  if (process.argv[2] === 'codex') {
    const root = rollouts();
    if (!root || !existsSync(root)) return null;
    for (const entry of readdirSync(root, { recursive: true })) if (String(entry).endsWith('-' + sessionId + '.jsonl')) return path.join(root, String(entry));
    return null;
  }
  const root = projects();
  for (const dir of root && existsSync(root) ? readdirSync(root) : []) if (existsSync(path.join(root, dir, sessionId + '.jsonl'))) return path.join(root, dir, sessionId + '.jsonl');
  return null;
};
// As codex, the plan collaboration switch too (codex-acp's collaboration_mode; P9's Codex Plan mode, 0.1.8).
const picked = { effort: 'medium', fast: 'off', ...(process.argv[2] === 'codex' && { collaboration_mode: 'default' }), sandbox: 'on' };
// O47: models.json in the workspace replaces the model list ([{ value, name }]), read at every report; calls.log, when it
// exists, gets one line per session opened and per prompt; signed-out refuses every new session.
const listedModels = () => { try { return JSON.parse(readFileSync('models.json', 'utf8')); } catch { return null; } };
// O48, like the real Claude adapter: ANTHROPIC_MODEL in its own environment is the model it starts on and
// ANTHROPIC_CUSTOM_MODEL_OPTION one more row in its list; such a process answers only a session that brings a key in
// _meta.claudeCode.options.env (new and resume). profile.log, when it exists, gets one line per session opened: the
// names it saw, a hash of the key, and whether the key was anywhere in its environment or command line.
const custom = process.env.ANTHROPIC_CUSTOM_MODEL_OPTION;
// O190: like claude-agent-acp 0.106.0, it sends a raw SDK result as '_claude/sdkMessage' only when the session asked for it
// (_meta.claudeCode.emitRawSDKMessages, new and resume), filtered by type and origin as the adapter's shouldEmitRawMessage.
let rawAsked = false;
const rawWanted = (message) => rawAsked === true || (Array.isArray(rawAsked) && rawAsked.some((f) => f.type === message.type && (f.subtype === undefined || f.subtype === message.subtype) && (f.origin === undefined || f.origin === message.origin?.kind)));
const provider = (what, params) => {
  if (existsSync('dirs.log')) appendFileSync('dirs.log', JSON.stringify({ what, dirs: params.additionalDirectories ?? null }) + '\n'); // A2 step 1
  rawAsked = params._meta?.claudeCode?.emitRawSDKMessages ?? false;
  const env = params._meta?.claudeCode?.options?.env, key = env?.ANTHROPIC_AUTH_TOKEN;
  if (existsSync('profile.log')) appendFileSync('profile.log', JSON.stringify({ agent: process.argv[2], what, model: process.env.ANTHROPIC_MODEL ?? null, custom: custom ?? null,
    names: Object.keys(process.env).filter((name) => name.startsWith('ANTHROPIC_')).sort(), baseUrl: env?.ANTHROPIC_BASE_URL ?? null,
    keyHash: key ? createHash('sha256').update(key).digest('hex') : null,
    keyOutside: !!key && [...Object.values(process.env), ...process.argv].some((value) => String(value).includes(key)) }) + '\n');
  if (custom && !key) throw acp.RequestError.authRequired();
  if (key === 'wrong-key') throw acp.RequestError.authRequired();
};
const called = (what) => { if (existsSync('calls.log')) appendFileSync('calls.log', process.argv[2] + ' ' + what + '\n'); };
const configOptions = () => [{ id: 'mode', name: 'Mode', type: 'select', currentValue: mode,
  options: [{ value: 'agent', name: 'Agent' }, { value: 'workspace-write', name: 'Workspace write' }] },
  // PD-1: no-model in the workspace: a model list with no current model (P9's model: null for the chat).
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: existsSync('no-model') ? null : model,
    options: [...(listedModels() ?? [{ value: 'default', name: 'Default (recommended)' }, { group: 'more', name: 'More', options: [{ value: 'opus', name: 'Opus' }, { value: 'haiku', name: 'Haiku' }] }]), ...(custom ? [{ value: custom, name: 'Custom model' }] : [])] },
  // Like the real adapters: effort and fast mode; sandbox is a mode-category switch P9 must never offer (threat model row 22).
  { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: picked.effort, options: ['low', 'medium', 'high'].map((value) => ({ value, name: value[0].toUpperCase() + value.slice(1) })) },
  { id: 'fast', name: 'Fast mode', category: 'model_config', type: 'select', currentValue: picked.fast, options: [{ value: 'on', name: 'On' }, { value: 'off', name: 'Off' }] },
  ...(process.argv[2] === 'codex' ? [{ id: 'collaboration_mode', name: 'Collaboration mode', category: 'collaboration_mode', type: 'select', currentValue: picked.collaboration_mode, options: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' }] }] : []),
  { id: 'sandbox', name: 'Sandbox', category: 'mode', type: 'select', currentValue: picked.sandbox, options: [{ value: 'on', name: 'On' }, { value: 'off', name: 'Off' }] }];
// Like both real adapters: the slash command list arrives as an update just after the session starts.
const commands = (sessionId) => connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'available_commands_update',
  availableCommands: [{ name: 'compact', description: 'Clear history but keep a summary' }, { name: 'context', description: 'Show context use' }, { name: 'review', description: 'Review the changes' }] } });

let steering = true;
// O194: like claude-agent-acp 0.106.0, it marks a run it starts with no prompt only for a client that advertises asyncTasks.
let asyncTasks = false;
let air = false; // A2 step 5: the client declared the _meta extension (claude-agent-acp's isAirClient)
const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const connection = acp.connectAgent(stream, {
  async initialize(params) {
    // As Claude asked for ACP 2 it offers no steering, like claude-agent-acp 0.106.0 (test/real-adapter-steering.test.mjs).
    // ponytail: it still answers protocol 1 and speaks v1; only the steering offer follows the version P9 asked for.
    steering = !existsSync('no-steering') && !(process.argv[2] === 'claude' && params?.protocolVersion >= 2);
    const declared = params?.clientCapabilities?._meta?.jetbrains?.air;
    air = Boolean(declared && typeof declared === 'object' && !Array.isArray(declared));
    asyncTasks = declared?.version >= 1 && Array.isArray(declared.capabilities) && declared.capabilities.includes('asyncTasks');
    if (existsSync('hang-init')) await new Promise(() => {});
    if (existsSync('slow-init')) await new Promise((resolve) => setTimeout(resolve, 10000));
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { promptCapabilities: { image: !existsSync('no-images') }, sessionCapabilities: { resume: {}, close: {} } },
      ...(steering && { _meta: { steering: { supported: true } } }) };
  },
  // Like claude-agent-acp 0.88's _session/steering with idleBehavior promptRequired.
  async extMethod(method, params) {
    if (method !== '_session/steering' || !steering) throw acp.RequestError.methodNotFound(method);
    sprintRules(params.prompt);
    appendFileSync('steers.log', textOf(params.prompt) + '\n');
    if (!turns.has(params.sessionId) && process.argv[2] === 'codex') {
      const text = textOf(params.prompt);
      setTimeout(() => connection.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'got:' + text } } }), 300);
      return { outcome: 'startedNewTurn' };
    }
    if (!turns.has(params.sessionId)) return { outcome: 'promptRequired', reason: 'noRunningTurn' };
    if (existsSync('slow-steering')) await new Promise((resolve) => setTimeout(resolve, 6000)); // past chat.mjs's 5 s wait
    if (existsSync('steering-refuses')) throw new Error('steering refused');
    deliver(params.sessionId, textOf(params.prompt));
    return { outcome: 'injected' };
  },
  async authenticate() { return {}; },
  async newSession(params) {
    if (existsSync('signed-out')) throw acp.RequestError.authRequired();
    if (existsSync('slow-lists')) await new Promise((resolve) => setTimeout(resolve, Number(readFileSync('slow-lists', 'utf8')) || 2500)); // the file may say how long, in ms
    provider('new', params);
    called('new');
    cwd = 'new:' + params.cwd; folder = params.cwd; mcpServers = params.mcpServers; const sessionId = existsSync('uuid-sessions') ? randomUUID() : `fake-${process.argv[2]}-${process.pid}-${Date.now()}`;
    if (projects() && process.argv[2] === 'codex') {
      const now = new Date().toISOString(), dir = path.join(rollouts(), now.slice(0, 4), now.slice(5, 7), now.slice(8, 10));
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'rollout-' + now.slice(0, 19).replace(/:/g, '-') + '-' + sessionId + '.jsonl'), JSON.stringify({ type: 'session_meta', cwd: params.cwd, sessionId }) + '\n');
    } else if (projects()) {
      const dir = path.join(projects(), params.cwd.replace(/[^a-zA-Z0-9]/g, '-'));
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, sessionId + '.jsonl'), JSON.stringify({ type: 'session', cwd: params.cwd, sessionId }) + '\n');
    }
    commands(sessionId); return { sessionId, configOptions: configOptions() };
  },
  async resumeSession(params) {
    // uuid-sessions: IDs shaped like the real Claude adapter's (Hand off types one into a shell, so it takes only those).
    if (!params.sessionId.startsWith('fake-') && !existsSync('uuid-sessions')) throw new Error('unknown session');
    if (projects() && !transcript(params.sessionId)) throw new Error('No conversation found with session ID: ' + params.sessionId);
    provider('resume', params);
    cwd = 'resume:' + params.cwd; folder = params.cwd;
    if (existsSync(path.join(folder, 'refuse-resume-settings'))) mode = 'default';
    mcpServers = params.mcpServers;
    commands(params.sessionId);
    return { configOptions: configOptions() };
  },
  async closeSession() { if (existsSync('slow-close')) await new Promise((resolve) => setTimeout(resolve, 2000)); return {}; },
  async setSessionConfigOption(params) {
    // Refuses putting the chat's old settings back; P9's own safe start mode (Manual) still goes through, since P9 fails the
    // start rather than run a Claude chat in the adapter's auto.
    if (cwd.startsWith('resume:') && existsSync(path.join(folder, 'refuse-resume-settings')) && !(params.configId === 'mode' && params.value === 'default')) throw new Error('restore refused');
    if (existsSync('sets.log')) appendFileSync('sets.log', cwd.split(':')[0] + ' ' + params.configId + '=' + params.value + '\n'); // O39: every setting P9 sets, and whether the session was new or resumed
    if (params.configId === 'model') { if (!(listedModels()?.map((m) => m.value) ?? ['default', 'opus', 'haiku']).includes(params.value)) throw new Error('unknown model'); model = params.value; }
    else if (Object.hasOwn(picked, params.configId)) { picked[params.configId] = String(params.value); } else mode = String(params.value);
    return { configOptions: configOptions() };
  },
  async cancel(params) { cancelled.add(params.sessionId); },
  async prompt(params) {
    called('prompt');
    const { sessionId } = params, say = (reply) => connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } } });
    // Like Claude Code's prompt queue: a prompt during the unprompted work is taken in at its next step.
    if (background.has(sessionId)) { await deliver(sessionId, textOf(params.prompt)); return { stopReason: 'end_turn' }; }
    turns.add(sessionId);
    const file = transcript(sessionId);
    if (file) appendFileSync(file, JSON.stringify({ type: 'user', text: textOf(params.prompt) }) + '\n');
    try { return await this.turn(params); } finally { await take(sessionId, say); turns.delete(sessionId); }
  },
  async turn(params) {
    const { sessionId } = params;
    sprintRules(params.prompt);
    // Every prompt's text blocks, only for a test that put log-prompts in the folder (a chat folder's listing stays its own).
    if (existsSync('log-prompts')) appendFileSync('prompts.log', JSON.stringify(params.prompt.filter((block) => block.type === 'text').map((block) => block.text)) + '\n');
    const text = textOf(params.prompt);
    const say = (reply) => connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } } });
    for (const block of params.prompt) if (block.type === 'text' && block.text.startsWith(NOTE) && block.text.includes(']\n\n')) await say('note:' + block.text.slice(block.text.indexOf(']\n\n') + 3).trim());
    if (text === 'crash') process.exit(3);
    if (text === 'auth-required') throw acp.RequestError.authRequired();
    // A2 step 1: the agent edits a file sent with the message, in place, as its own Edit tool would (the file's link is its real path).
    if (params.prompt.some((block) => block.type === 'text' && block.text === 'edit attached')) {
      const links = params.prompt.filter((block) => block.type === 'resource_link');
      for (const link of links) appendFileSync(fileURLToPath(link.uri), ' edited by the agent');
      await say('edited:' + links.map((link) => link.name + '=' + link.uri).join(','));
      return { stopReason: 'end_turn' };
    }
    // codex-acp 2.1.1 to a client that takes no notices: its warnings arrive as whole reply chunks, then the reply.
    if (text === 'codex warning') {
      await say('Warning: Falling back from WebSockets to HTTPS transport. stream disconnected before completion: websocket closed by server before response.completed\n\n');
      await say('Warning: Some new thing the agent program says\n\n');
      await say('Glad she turned out just how you wanted!');
      return { stopReason: 'end_turn' };
    }
    // O249: a busy chat as a real one is: each step a tool call whose result is a ~400 KB screenshot (base64 'A's: any
    // base64 passes the image check), then a fresh slash-command list of ~70 KB, as the adapters resend it.
    const heavy = /^heavy (\d+)$/.exec(text);
    if (heavy) {
      for (let i = 0; i < Number(heavy[1]); i += 1) {
        await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'heavy-' + i, title: 'Read shot' + i + '.png', kind: 'read', status: 'completed',
          content: [{ type: 'content', content: { type: 'image', mimeType: 'image/png', data: 'A'.repeat(400000) } }] } });
        await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: Array.from({ length: 300 }, (_, j) => ({ name: 'cmd' + j, description: 'x'.repeat(220) })) } });
      }
      // Last, a tool whose output holds the same words as a command list's kind, nested: it is a tool call, not a list.
      await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'heavy-decoy', title: 'grep', kind: 'search', status: 'completed', rawOutput: { sessionUpdate: 'available_commands_update' } } });
      await say('heavy done'); return { stopReason: 'end_turn' };
    }
    // Images the way the real adapters send them (threat model row 26): Codex's image generation as a finished tool call
    // with the image (and its saved path as uri), Claude's image in a reply, and an image known only by its address.
    if (text === 'images') {
      const image = (w, h, extra = {}) => ({ type: 'image', mimeType: 'image/png', data: png(w, h), ...extra });
      await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'gen-1', title: 'Image generation', kind: 'other', status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'Revised prompt: a gradient' } }, { type: 'content', content: image(320, 200, { uri: '/tmp/never-read.png' }) }] } });
      await say('Here is the picture.');
      await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'agent_message_chunk', content: image(120, 90) } });
      await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: '', mimeType: '', uri: 'https://example.com/tracker.png' } } });
      return { stopReason: 'end_turn' };
    }
    // An image made mid-build: three tool calls in a row (the phone folds them into one row), the middle one an image.
    if (text === 'images in steps') {
      for (const [i, content] of [[1, []], [2, [{ type: 'content', content: { type: 'image', mimeType: 'image/png', data: png(200, 100) } }]], [3, []]]) {
        await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'build-' + i, title: 'Build step ' + i, kind: 'other', status: 'completed', content } });
      }
      await say('Built.');
      return { stopReason: 'end_turn' };
    }
    // Codex's view_image as codex-acp 2.1.1 sends it: only the opened file's path, as a resource_link (threat model row 27).
    if (text === 'images from disk') {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'p9-view-')), at = (name) => path.join(dir, name);
      writeFileSync(at('shot.png'), Buffer.from(png(64, 48), 'base64'));
      writeFileSync(at('fake.png'), 'secret=hunter2 is not an image');
      writeFileSync(at('big.png'), Buffer.concat([Buffer.from(png(2, 2), 'base64'), Buffer.alloc(6 * 1024 * 1024)]));
      mkdirSync(at('dir.png')); execFileSync('mkfifo', [at('pipe.png')]);
      const link = (uri) => ({ type: 'content', content: { type: 'resource_link', name: uri, uri } });
      await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'view-1', title: 'View Image ' + at('shot.png'), name: 'view_image', kind: 'read', status: 'completed',
        content: [at('shot.png'), pathToFileURL(at('shot.png')).href, at('fake.png'), at('big.png'), at('dir.png'), at('pipe.png'), 'shot.png'].map(link) } });
      await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'resource_link', name: 'shot.png', uri: at('shot.png') } } });
      return { stopReason: 'end_turn' };
    }
    // A long chat: 250 steps, then one reply.
    if (text === 'many steps') {
      for (let i = 1; i <= 250; i++) await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'step-' + i, title: 'Step ' + i, kind: 'read', status: 'completed' } });
      await say('All steps done.');
      return { stopReason: 'end_turn' };
    }
    if (text === 'images hostile') {
      const ok = { type: 'image', mimeType: 'image/png', data: png(2, 2) };
      await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'bad-1', title: 'Images', status: 'completed', content: [
        ok, { type: 'image', mimeType: 'image/svg+xml', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>').toString('base64') },
        { type: 'image', mimeType: 'image/png', data: '', uri: 'https://example.com/x.png' }, { type: 'image', mimeType: 'image/png', data: 'AAAA" onerror="x' },
        { type: 'image', mimeType: 'image/png', data: 'A'.repeat(8 * 1024 * 1024 + 4) }, ok, ok, ok, ok].map((content) => ({ type: 'content', content })) } });
      return { stopReason: 'end_turn' };
    }
    if (text === 'mode') { await say('mode:' + mode); return { stopReason: 'end_turn' }; }
    // O130: a helper agent's settings, as claude-agent-acp sends them (ledger 596371/596374): one model each, only the first
    // tagged with the helper's tool call. The session itself stays on its model.
    if (text === 'helper') {
      const one = (id, value, extra = {}) => ({ id, name: id, type: 'select', currentValue: value, options: [{ value, name: value }], ...extra });
      for (const [configOptions, _meta] of [[[one('agent', 'web-fetch')]], [[one('model', 'haiku', { category: 'model' })], { claudeCode: { parentToolUseId: 'toolu_helper' } }],
        [[one('mode', 'agent'), one('model', 'haiku', { category: 'model' }), one('effort', 'medium', { category: 'thought_level' }), one('agent', 'web-fetch')]]])
        await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'config_option_update', configOptions, ...(_meta && { _meta }) } });
      await say('helper done'); return { stopReason: 'end_turn' };
    }
    if (text === 'model') { await say('model:' + model); return { stopReason: 'end_turn' }; }
    if (text === 'plan') {
      await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'plan', entries: [['completed', 'Read the chat ledger'], ['in_progress', 'Pin the plan above the composer'],
        ['pending', 'Check it on the phone']].map(([status, content]) => ({ status, content, priority: 'medium' })) } });
      return { stopReason: 'end_turn' };
    }
    // "plan step <n>": the same three steps sent again as work moves on (step n in progress, the ones before it done; 3 = all
    // done), as a real agent re-sends its whole plan on each change (ACP: each plan update replaces the last).
    const step = /^plan step ([123])$/.exec(text);
    if (step) {
      const n = +step[1];
      await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'plan', entries: ['Read the chat ledger', 'Write the plan test', 'Check it on the phone']
        .map((content, i) => ({ content, priority: 'medium', status: i < n - 1 || n === 3 ? 'completed' : i === n - 1 ? 'in_progress' : 'pending' })) } });
      return { stopReason: 'end_turn' };
    }
    // Both real adapters name a chat this way after a turn; the padding checks P9 tidies the name.
    // A2 step 5: like claude-agent-acp's publishGoal, a goal snapshot (JSON, or null) in session_info_update _meta, only
    // to a client that declares the _meta extension; 'goal-raw <json>' sends the _meta as given.
    // 'goal-pad <json>' sends the goal with 70 KB of other _meta, so the update is over P9's stored-event size.
    if (text.startsWith('goal ') || text.startsWith('goal-raw ') || text.startsWith('goal-pad ')) {
      const raw = text.startsWith('goal-raw '), pad = text.startsWith('goal-pad '), value = JSON.parse(text.slice(text.indexOf(' ') + 1));
      const meta = raw ? value : { jetbrains: { air: { version: 1, goal: value } }, ...(pad ? { pad: 'x'.repeat(70000) } : {}) };
      if (air) await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'session_info_update', _meta: meta } });
      await say('goal sent'); return { stopReason: 'end_turn' };
    }
    if (text.startsWith('title ')) { await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'session_info_update', title: text.slice(6) } }); return { stopReason: 'end_turn' }; }
    if (text === 'cwd') { await say('cwd:' + cwd); return { stopReason: 'end_turn' }; }
    // A chat's notes kept for its next message go in front of it (chat.mjs parked): 'mcp' as the last block still answers.
    if (text === 'mcp' || params.prompt.at(-1)?.text === 'mcp') { await say('mcp:' + JSON.stringify(mcpServers)); return { stopReason: 'end_turn' }; }
    if (text.startsWith('probe ')) {
      // Phase 10: try whatever credentials this agent can see against the remote port (test/credential-probe.mjs).
      const [, port, host, probe, ...rest] = text.split(' ');
      const child = spawn(process.execPath, [probe, port, host, ...rest], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      await new Promise((resolve) => child.once('exit', resolve));
      await say(out.trim());
      return { stopReason: 'end_turn' };
    }
    if (text === 'config') { await say('config:' + Object.entries({ model, ...picked }).map(([k, v]) => k + '=' + v).join(',')); return { stopReason: 'end_turn' }; }
    if (text === 'env') { await say('env:' + Object.keys(process.env).sort().join(',')); return { stopReason: 'end_turn' }; }
    if (text === 'detach') {
      const child = process.platform === 'win32'
        ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 300000)'], { detached: true, stdio: 'ignore' })
        : spawn('setsid', ['sleep', '300'], { stdio: 'ignore' });
      child.unref();
      await new Promise((resolve) => setTimeout(resolve, 200));
      await say('detach:' + child.pid);
      return { stopReason: 'end_turn' };
    }
    // daemon-10: both adapters run a slash command only from the prompt's first text block (claude-agent-acp
    // promptToClaude, codex-acp parseCommand). "/compact" alone compacts: context 600 -> 10. Behind a label it is words.
    if (params.prompt.length === 1 && params.prompt[0].type === 'text' && params.prompt[0].text.trim() === '/compact') {
      await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'compact-cmd', title: 'Compact conversation', kind: 'think', status: 'completed' } });
      await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'usage_update', used: 10, size: 1000 } });
      return { stopReason: 'end_turn' };
    }
    if (text === '/compact') { await say('words:/compact'); return { stopReason: 'end_turn' }; }
    // "fill <n>": the context grows to n tokens.
    if (/^fill \d+$/.test(text)) { await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'usage_update', used: Number(text.slice(5)), size: 1000 } }); await say('filled'); return { stopReason: 'end_turn' }; }
    // Claude Code after a compaction: the prompt ends, then the agent works on with no prompt open, and only that turn's
    // usage_update with a cost says it stopped.
    if (text === 'compact') {
      setTimeout(async () => {
        await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'compact-1', title: 'Compact conversation', kind: 'think', status: 'completed' } });
        await say('after compact');
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'usage_update', used: 10, size: 1000, cost: { amount: 0.01, currency: 'USD' } } });
      }, 1500);
      return { stopReason: 'end_turn' };
    }
    // O139, as P9's history shows Claude Code after a turn: the prompt ends, 0.5 s later the compaction (tool call, then a
    // usage_update with the cost so far), then "compactgo" works on unprompted and ends on a usage_update with a higher
    // cost; "compactstop" is a compaction that failed: nothing more comes.
    // "compactquick": the run after the compaction ends 1 s later, inside P9's 3 s hold of the end line.
    if (text === 'compactgo' || text === 'compactstop' || text === 'compactquick') {
      setTimeout(async () => {
        const cost = (amount) => connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'usage_update', used: 10, size: 1000, cost: { amount, currency: 'USD' } } });
        await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'compact-' + text, title: 'Compact conversation', kind: 'think', status: 'completed' } });
        await cost(1);
        if (text === 'compactstop') return;
        await say('working after the compaction');
        await new Promise((resolve) => setTimeout(resolve, text === 'compactquick' ? 1000 : 6000));
        await say(', then done');
        await cost(2);
      }, 500);
      return { stopReason: 'end_turn' };
    }
    // "squeeze": a compaction inside the turn, as P9 sees it from the real adapters (the "Compact conversation" tool call and its
    // update, one id) or, for "squeezeu", as a compaction_update (in progress, then completed); a number after it is the id.
    const squeeze = /^squeeze(u?)(\d*)/.exec(text);
    if (squeeze) {
      const id = 'sq' + (squeeze[2] || ++squeezes);
      if (squeeze[1]) for (const status of ['in_progress', 'completed']) await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'compaction_update', compactionId: id, status } });
      else { await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call', toolCallId: id, title: 'Compact conversation', kind: 'think', status: 'in_progress' } });
        await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed' } }); }
      if (text.endsWith('fail')) throw acp.RequestError.authRequired(); // O215 "squeezefail": the turn fails after it compacts
    }
    // O190 "compact-usage": a /compact turn as claude-agent-acp 0.106.0 answers it (seen live): the reply's usage is all 0,
    // its _meta.quota.model_usage holds what the compaction spent, here on two models.
    if (text === 'compact-usage') {
      await say('compacted');
      const row = (model, inputTokens, cachedInputTokens, cachedWriteTokens, outputTokens) => ({ model, token_count: { totalTokens: inputTokens + cachedInputTokens + cachedWriteTokens + outputTokens, inputTokens, cachedInputTokens, cachedWriteTokens, outputTokens, reasoningOutputTokens: 0 } });
      const zero = { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0, totalTokens: 0 };
      return { stopReason: 'end_turn', usage: zero, _meta: { quota: { token_count: { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cachedWriteTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }, model_usage: [row('claude-haiku-5-5', 2242, 33491, 81, 692), row('claude-sonnet-5-5', 8, 100, 0, 8)] } } };
    }
    // "spend <n>": a turn that cost n dollars and n thousand input tokens, as the real adapters report it (O35's usage test).
    const spend = /^spend (\d+)/.exec(text);
    if (spend) {
      const n = Number(spend[1]);
      await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'usage_update', used: 10, size: 1000, cost: { amount: n, currency: 'USD' } } });
      await say('spent ' + n);
      return { stopReason: 'end_turn', usage: { inputTokens: n * 1000, outputTokens: n * 100, cachedReadTokens: n * 10, totalTokens: n * 1110 } };
    }
    // "limits <n>": the turn ends at once; a second later, with no prompt open, the agent reports its context and plan
    // use at n%. As Claude it carries the adapter's _claude/rateLimit window figures (a fraction); Codex has none (its
    // limits are in its session log).
    if (text.startsWith('limits ')) {
      const n = Number(text.slice(7));
      setTimeout(() => connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'usage_update', used: n * 10, size: 1000,
        ...(process.argv[2] === 'codex' ? {} : { _meta: { '_claude/rateLimit': { status: 'allowed', unifiedWindows: {
          five_hour: { utilization: n / 100, resetsAt: new Date(Date.now() + 3 * 3600000).toISOString() },
          seven_day: { utilization: n / 100, resetsAt: new Date(Date.now() + 72 * 3600000).toISOString() } } } } }) } }), 1000);
      return { stopReason: 'end_turn' };
    }
    // A reply that lands well after the prompt was accepted, so a client must keep listening to see it.
    // claude-home: what the transcript holds (the messages before this one), and whether P9 said the chat moved.
    if (text.endsWith('recall') && transcript(sessionId)) {
      const lines = readFileSync(transcript(sessionId), 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((line) => line.type === 'user').slice(0, -1);
      await say('recall:' + lines.map((line) => line.text).join('|') + (text.startsWith('[P9: this chat moved') ? ' +note' : ''));
      return { stopReason: 'end_turn' };
    }
    // An edit the way Claude's adapter reports one: kind edit, with the file's absolute path in locations.
    if (text.startsWith('edit ')) {
      const file = path.join(folder, text.slice(5));
      writeFileSync(file, 'edited by the agent\n');
      await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'edit-' + Date.now(), title: 'Write ' + text.slice(5), kind: 'edit', status: 'completed', locations: [{ path: file }] } });
      await say('edited');
      return { stopReason: 'end_turn' };
    }
    // "long work": a prompted turn that works on its own until cancelled, a step every 300 ms, as an unattended agent does.
    if (text === 'long work') {
      cancelled.delete(sessionId);
      for (let i = 1; !cancelled.has(sessionId); i++) {
        await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'lw-' + i, title: 'Step ' + i, kind: 'execute', status: 'completed' } });
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      return { stopReason: 'cancelled' };
    }
    // A reply the adapter sends again whole: the first under its own message id, the second under a new one.
    if (text === 'twice') {
      const piece = (messageId, reply) => connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text: reply } } });
      const long = 'x'.repeat(150), tail = 'y'.repeat(150);
      await piece('m1', 'one '); await piece('m1', 'two');
      await piece('m2', long); await piece('m2', tail);
      await piece('m1', 'one two'); await piece('r1', long + tail); // the two copies
      await piece('r1', long + tail); await piece('r1', 'more'); // what follows a copy under its new id is a reply, and is kept
      await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'agent_message_chunk', messageId: 'r2', content: { type: 'resource_link', uri: 'file:///nowhere/notes.txt', name: 'notes.txt' } } });
      await piece('r2', long + tail); // a reply that opened with a link: its text is not a first piece
      await piece('m3', 'end'); await piece('m4', 'end'); // one piece, said twice: two replies
      await piece('m5', 'al'); await piece('m5', 'pha'); await piece('m6', 'so '); await piece('m6', 'alpha'); // a short piece that equals an earlier reply
      await piece('m7', long); await piece('m7', tail); await piece('m7', long + tail); // a reply that repeats itself while it streams
      await piece('m8', 'sh'); await piece('m8', 'ort');
      await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'completed' } });
      await piece('m8', 'short'); // the newest reply, short, again under its own id after a compaction
      return { stopReason: 'end_turn' };
    }
    if (text === 'late-crash') { await new Promise((resolve) => setTimeout(resolve, 1500)); process.exit(3); } // O224: a turn that fails, not ends
    // DUP-1 (c): the copy comes after the turn has ended, as seen on the server (a turn-end, then the whole reply again).
    if (text === 'twice late') {
      const piece = (messageId, reply) => connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text: reply } } });
      const long = 'p'.repeat(150), tail = 'q'.repeat(150);
      await piece('L1', long); await piece('L1', tail);
      setTimeout(async () => { await piece('L1', long + tail); await piece('L2', long + tail); }, 300);
      return { stopReason: 'end_turn' };
    }
    // DUP-1 (a)/(b): claude-agent-acp's result fallback. A turn's result that reports no output tokens ends it, and the
    // adapter forwards the result text, the reply the agent already streamed, whole under a new id: after the turn-end
    // (twice short, as the server's ledger shows it) or before it (twice early, as the adapter's source orders it). Then
    // the same words once more under S2, a reply of their own, and the marker 'twice: end'. said again: the agent says its
    // streamed words again at once as a new reply of its own (the API's own kind of id, not the result's uuid).
    if (text === 'twice short' || text === 'twice early' || text === 'said again') {
      const piece = (messageId, reply) => connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text: reply } } });
      const copy = () => piece('5b0e5d55-ffc2-4f6b-9a39-2d0c0f3c6b11', 'Done, merged.');
      const rest = async () => { await piece('S2', 'Done, merged.'); await piece('M', 'twice: end'); };
      if (text === 'said again') { await piece('S1', 'Done, '); await piece('S1', 'merged.'); await piece('R1', 'Done, merged.'); await piece('M2', 'twice: end'); }
      else {
        await piece('S1', 'Done, '); await piece('S1', 'merged.');
        if (text === 'twice early') { await copy(); setTimeout(rest, 300); } else setTimeout(async () => { await copy(); await rest(); }, 300);
      }
      return { stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0, totalTokens: 0 } };
    }
    // DUP-1 review 3: a command's own output, which the adapter sends under a uuid too, saying what the last reply said.
    if (text === 'command result') {
      await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'agent_message_chunk', messageId: '0c6a4f0e-3d4b-4b8e-9a51-7c2e1f9d3a20', content: { type: 'text', text: 'Done, merged.' } } });
      await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'agent_message_chunk', messageId: 'M3', content: { type: 'text', text: 'twice: end' } } });
      return { stopReason: 'end_turn' };
    }
    if (text === 'late') { await new Promise((resolve) => setTimeout(resolve, 1500)); await say('late reply'); return { stopReason: 'end_turn' }; }
    // Works until a file named go is in its folder, then ends on its own: messages queued meanwhile go when it ends.
    if (text === 'gate') { await say('gating'); while (!existsSync('go')) await new Promise((resolve) => setTimeout(resolve, 20)); await say('gated'); return { stopReason: 'end_turn' }; }
    // Review round 8 (O249): a turn that fails after a while, with no end of its own (the daemon's prompt-error path).
    if (text === 'slow fail') { await say('working'); await new Promise((resolve) => setTimeout(resolve, 4000)); throw new Error('slow fail'); }
    if (text === 'slow') {
      cancelled.delete(sessionId);
      await say('working');
      while (!cancelled.has(sessionId)) { await take(sessionId, say); await new Promise((resolve) => setTimeout(resolve, 20)); }
      return { stopReason: 'cancelled' };
    }
    // A coordinator's background tasks (2026-10-24): each report wakes the agent with no prompt, so after this turn ends
    // it works on with no end and no closing usage_update, and asks once on its tenth step ("background quiet" never asks).
    // O188 FIX1: "bg-tool" ends its turn, then on its own starts one tool call a second later and completes it 1.5 s after.
    // O192: "bg-run" ends its turn; 4 s later (after the end hold) Claude Code-style it is resumed with no prompt (a
    // background task finished): one tool call, a closing line, then nothing more, and no end of its own.
    if (text === 'bg-run') {
      setTimeout(async () => {
        await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'resume-1', title: 'Resumed tool', kind: 'execute', status: 'in_progress' } });
        await new Promise((resolve) => setTimeout(resolve, 500));
        await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'resume-1', status: 'completed' } });
        await say('bg-run done');
      }, 4000);
      await say('bg-run reply');
      return { stopReason: 'end_turn' };
    }
    // O194: "bg-marked" is "bg-run" with the adapter's marks (only for a client that advertises asyncTasks): its unprompted
    // run opens with an async_task_spawned of taskType 'turn' and ends with that task's async_task_state_update. A background
    // command's own task starts and ends inside the run and is not the run's end.
    // O190: "bg-usage [origin]" is "bg-marked" whose unprompted run ends with a result of its own (origin task-notification
    // unless one is named, 7 in,
    // 3 out, 500 cache read, 20 cache write), sent raw only if asked; its prompted turn's reply carries 10 in, 5 out, 900 cache read.
    const usage = /^bg-usage( [a-z-]+)?$/.test(text), origin = text.split(' ')[1] ?? 'task-notification';
    if (text === 'bg-marked' || usage) {
      const task = (update) => asyncTasks && connection.sessionUpdate({ sessionId, update });
      const result = (message) => rawWanted(message) && connection.extNotification('_claude/sdkMessage', { sessionId, message });
      setTimeout(async () => {
        await task({ sessionUpdate: 'async_task_spawned', asyncTaskId: 'autonomous-turn-1', name: 'Claude is working', taskType: 'turn', description: 'A background task finished.', showInTranscript: false, canStop: true });
        await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'resume-1', title: 'Resumed tool', kind: 'execute', status: 'in_progress' } });
        await task({ sessionUpdate: 'async_task_spawned', asyncTaskId: 'bash-1', name: 'sleep 1', taskType: 'local_bash', description: 'sleep 1', showInTranscript: true, canStop: true, toolCallId: 'resume-1' });
        await new Promise((resolve) => setTimeout(resolve, 500));
        await task({ sessionUpdate: 'async_task_state_update', asyncTaskId: 'bash-1', state: 'completed' });
        await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'resume-1', status: 'completed' } });
        await say(text + ' done');
        if (usage) {
          await result({ type: 'result', subtype: 'success', origin: { kind: origin }, usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 500, cache_creation_input_tokens: 20 } });
          await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'usage_update', used: 20, size: 1000, cost: { amount: 0.9, currency: 'USD' } } });
        }
        await task({ sessionUpdate: 'async_task_state_update', asyncTaskId: 'autonomous-turn-1', state: 'completed' });
      }, 4000);
      await say(text + ' reply');
      if (usage) {
        // The prompted turn's own result: no origin, so a client filtering on origins never gets it raw.
        await result({ type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } });
        await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'usage_update', used: 10, size: 1000, cost: { amount: 0.5, currency: 'USD' } } });
        return { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 900, cachedWriteTokens: 0, totalTokens: 915 } };
      }
      return { stopReason: 'end_turn' };
    }
    // O194 FIX1: "bg-lost-mark" is "bg-marked" whose end mark never comes; "bg-late-mark" sends it 12 s after its last line.
    if (text === 'bg-lost-mark' || text === 'bg-late-mark') {
      const task = (update) => asyncTasks && connection.sessionUpdate({ sessionId, update });
      setTimeout(async () => {
        await task({ sessionUpdate: 'async_task_spawned', asyncTaskId: 'autonomous-turn-1', name: 'Claude is working', taskType: 'turn', description: 'A background task finished.', showInTranscript: false, canStop: true });
        await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'resume-1', title: 'Resumed tool', kind: 'execute', status: 'in_progress' } });
        await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'resume-1', status: 'completed' } });
        await say(text + ' done');
        if (text === 'bg-late-mark') setTimeout(() => task({ sessionUpdate: 'async_task_state_update', asyncTaskId: 'autonomous-turn-1', state: 'completed' }), 12000);
      }, 4000);
      await say(text + ' reply');
      return { stopReason: 'end_turn' };
    }
    // O192 FIX1: "bg-compact" is resumed with no prompt 4 s after its end (a reply), and 200 ms later compacts; the
    // compaction ends (a higher cost) well before that reply's quiet time is up. Then nothing more.
    if (text === 'bg-compact') {
      setTimeout(async () => {
        const cost = (amount) => connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'usage_update', used: 10, size: 1000, cost: { amount, currency: 'USD' } } });
        await say('bg-compact done');
        await new Promise((resolve) => setTimeout(resolve, 200));
        await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'compact-bg', title: 'Compact conversation', kind: 'think', status: 'completed' } });
        await cost(1);
        await new Promise((resolve) => setTimeout(resolve, 300));
        await cost(2);
      }, 4000);
      await say('bg-compact reply');
      return { stopReason: 'end_turn' };
    }
    if (text === 'bg-tool') {
      setTimeout(async () => {
        await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'late-1', title: 'Late tool', kind: 'execute', status: 'in_progress' } });
        setTimeout(() => connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'late-1', status: 'completed' } }), 1500);
      }, 1000);
      await say('bg-tool reply');
      return { stopReason: 'end_turn' };
    }
    if (text === 'background' || text === 'background quiet') {
      background.add(sessionId);
      cancelled.delete(sessionId);
      setTimeout(async () => {
        for (let i = 1; !cancelled.has(sessionId); i++) { // O253: a Stop ends the unprompted run
          await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'bg-' + i, title: 'Background task ' + i, kind: 'execute', status: 'completed' } });
          await take(sessionId, say);
          if (i === 10 && text === 'background') await say('bg-ask:' + JSON.stringify(await connection.createElicitation({ sessionId, mode: 'form', message: 'Keep going?',
            requestedSchema: { type: 'object', properties: { go: { type: 'boolean' } } } })));
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }, 1000);
      return { stopReason: 'end_turn' };
    }
    if (text === 'effect-slow') {
      cancelled.delete(sessionId);
      appendFileSync('phase9-side-effects', 'executed\n');
      await say('effect:1');
      while (!cancelled.has(sessionId)) await new Promise((resolve) => setTimeout(resolve, 20));
      return { stopReason: 'cancelled' };
    }
    if (text === 'permission') {
      const result = await connection.requestPermission({ sessionId,
        toolCall: { toolCallId: 'call-1', title: 'Write marker', kind: 'edit', status: 'pending' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }] });
      await say('permission:' + (result.outcome.outcome === 'selected' ? result.outcome.optionId : 'cancelled'));
      return { stopReason: 'end_turn' };
    }
    // plan decline: Claude's plan approval in its real shape (ledger, adapter 0.106.0), then the failure it gave after "No, keep
    // planning" in phone-1 (2026-11-15). It fails whatever the answer, so a test can show only the decline is turned into a cancel.
    // The turn's teardown races the decline message's steering (whichever stdio read comes first), as the real adapter's prompt
    // failing right after the approval's cancel does. Two gate files force each interleaving, so a test can run both on purpose:
    if (text === 'plan decline') {
      // The teardown wins: the turn is gone before the approval is even answered, so the decline message's steering —
      // which can only be sent after that answer — reads no turn and answers promptRequired (the 409 shape).
      if (existsSync('plan-decline-ends-first')) turns.delete(sessionId);
      await connection.requestPermission({ sessionId, toolCall: { toolCallId: 'plan-1', kind: 'switch_mode', title: 'Approve Plan', status: 'pending' },
        options: [{ optionId: 'exit-plan-default', name: 'Yes, manually approve edits', kind: 'allow_once' }, { optionId: 'exit-plan-bypass', name: 'Yes, and bypass permissions', kind: 'allow_always' },
          { optionId: 'reject', name: 'No, keep planning', kind: 'reject_once' }] });
      // The steering wins: hold the turn open until the decline message is delivered into it, then fail the prompt as before.
      if (existsSync('plan-decline-waits-for-steer'))
        while (((inbox.get(sessionId)?.length) ?? 0) === 0) await new Promise((resolve) => setTimeout(resolve, 5));
      throw acp.RequestError.internalError(undefined, '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use');
    }
    // plan approve: Claude's plan approval as adapter 0.106.0 sends it (ledger, phone-2, 2026-11-13): an empty "Approve Plan"
    // call, the plan in its update, then the approval carrying the plan again.
    if (text === 'plan approve') {
      const plan = [{ type: 'content', content: { type: 'text', text: '# Ship the phone plan\n\n## Steps\n\n1. Show the plan on the approval\n2. Keep the choices below it' } }];
      await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'plan-2', title: 'Approve Plan', kind: 'switch_mode', status: 'pending', content: [] } });
      await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'plan-2', content: plan } });
      const result = await connection.requestPermission({ sessionId, toolCall: { toolCallId: 'plan-2', kind: 'switch_mode', title: 'Approve Plan', status: 'pending', content: plan },
        options: [{ optionId: 'exit-plan-default', name: 'Yes, manually approve edits', kind: 'allow_once' }, { optionId: 'reject', name: 'No, keep planning', kind: 'reject_once' }] });
      await say('plan:' + (result.outcome.outcome === 'selected' ? result.outcome.optionId : 'cancelled'));
      return { stopReason: 'end_turn' };
    }
    // perm-json <toolCall>: a permission request in claude-agent-acp's real shape (0.88.0 and 0.104.1 alike) (its options as recorded in
    // test/fixtures/acp/claude.json), for step 1d's own-project reads.
    if (text.startsWith('perm-json ')) {
      const result = await connection.requestPermission({ sessionId, toolCall: { toolCallId: 'perm-' + Date.now(), status: 'pending', ...JSON.parse(text.slice(10)) },
        options: [{ optionId: 'allow-once', name: 'Yes', kind: 'allow_once' }, { optionId: 'allow-with-updates', name: 'Yes, allow reading from this folder during this session', kind: 'allow_always' },
          { optionId: 'reject', name: 'No', kind: 'reject_once' }] });
      await say('permission:' + (result.outcome.outcome === 'selected' ? result.outcome.optionId : 'cancelled'));
      return { stopReason: 'end_turn' };
    }
    if (text === 'ask') {
      const result = await connection.createElicitation({ sessionId, mode: 'form', message: 'Pick a colour',
        requestedSchema: { type: 'object', properties: { colour: { type: 'string', enum: ['red', 'blue'] } } } });
      await say('ask:' + JSON.stringify(result));
      return { stopReason: 'end_turn' };
    }
    // A free-text answer, like AskUserQuestion's "Other" box.
    if (text === 'ask-text') {
      const result = await connection.createElicitation({ sessionId, mode: 'form', message: 'Name it',
        requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } });
      await say('ask:' + JSON.stringify(result));
      return { stopReason: 'end_turn' };
    }
    // Works for 2 s, then asks: messages sent meanwhile queue, and the question keeps the turn from ending.
    if (text === 'ask-later') {
      await say('working');
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const result = await connection.createElicitation({ sessionId, mode: 'form', message: 'Pick a colour',
        requestedSchema: { type: 'object', properties: { colour: { type: 'string', enum: ['red', 'blue'] } } } });
      await say('ask:' + JSON.stringify(result));
      return { stopReason: 'end_turn' };
    }
    // Tool calls that take a while, so a message sent meanwhile waits for one to end (CP1, CP8).
    if (text === 'diff and code') { // one line changed (a long one) in a 9-line file, then a reply with a code block
      const old = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n';
      await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'edit-1', title: 'Edit notes.md', kind: 'edit', status: 'completed',
        content: [{ type: 'diff', path: 'notes.md', oldText: old, newText: old.replace('five', 'FIVE' + ' long'.repeat(60)) }] } });
      await say('Run this:\n\n```sh\nnpm test\n```');
      return { stopReason: 'end_turn' };
    }
    // O222: a Codex (ACP v2) edit as acp-v2.mjs stores it: the lines once, in _meta.hunks, and _meta.added; no old text.
    // O121 part 4b: a v2 rename and a v2 delete, as acp-v2.mjs stores them.
    // #423 FIX1: a v2 delete reported while the call runs, then a status-only completion (no content), then a later update
    // with content for another file only: the deleted mark must outlive both.
    if (text === 'v2 delete then done') {
      const upd = (u) => connection.sessionUpdate({ sessionId, update: { toolCallId: 'edit-v2d', ...u } });
      await upd({ sessionUpdate: 'tool_call', title: 'Edit files', kind: 'edit', status: 'in_progress', content: [
        { type: 'diff', path: 'gone.md', newText: '', _meta: { added: false, deleted: true, hunks: [{ old: 1, new: 0, rows: [['del', 'x']] }] } }] });
      await upd({ sessionUpdate: 'tool_call_update', status: 'completed' });
      await upd({ sessionUpdate: 'tool_call_update', content: [{ type: 'diff', path: 'other.md', newText: '', _meta: { added: false, hunks: [{ old: 1, new: 1, rows: [['del', 'a'], ['add', 'b']] }] } }] });
      await say('v2 delete done');
      return { stopReason: 'end_turn' };
    }
    if (text === 'v2 kinds') {
      await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'edit-v2k', title: 'Edit files', kind: 'edit', status: 'completed', content: [
        { type: 'diff', path: 'moved.md', newText: '', _meta: { added: false, from: 'was.md', hunks: [{ old: 1, new: 1, rows: [['del', 'a'], ['add', 'b']] }] } },
        { type: 'diff', path: 'gone.md', newText: '', _meta: { added: false, deleted: true, hunks: [{ old: 1, new: 0, rows: [['del', 'x']] }] } }] } });
      await say('v2 kinds done');
      return { stopReason: 'end_turn' };
    }
    // MC-15 (shell-edits.test.mjs): files changed with no edit call (as a shell would), next to ones the agent's own
    // edit calls name: tool.md through a finished Edit (left out of Shell edits), failed.md through a failed one (still counted).
    if (text === 'shell writes' || text === 'shell many' || text === 'shell big' || text === 'shell tc' || text === 'shell outside' || text === 'shell deep' || text === 'shell odd') {
      const at = (f) => path.join(folder, f);
      if (text === 'shell tc') { writeFileSync(at('a.tc'), 'changed tc\n'); writeFileSync(at('note.txt'), 'note\n'); }
      else if (text === 'shell outside') { writeFileSync(at('in.txt'), 'inside\n'); writeFileSync(path.join(folder, '..', 'sib.txt'), 'SECRET-SIB\n'); writeFileSync(path.join(folder, '..', '..', 'outside.txt'), 'SECRET-OUT\n'); }
      else if (text === 'shell deep') {
        const deep = path.join(folder, ...Array.from({ length: 3 }, (_, i) => String(i).repeat(200)));
        mkdirSync(deep, { recursive: true });
        for (let i = 0; i < 40; i++) writeFileSync(path.join(deep, 'f-' + String(i).padStart(2, '0') + '-' + 'n'.repeat(150) + '.txt'), Array.from({ length: 12 }, (_, j) => 'row ' + j + ' ' + 'y'.repeat(60)).join('\n') + '\n');
      }
      else if (text === 'shell odd') { writeFileSync(at('plain.txt'), 'plain\n'); writeFileSync(at('o"dd\nfilter.evil.clean=x.txt'), 'odd\n'); writeFileSync(at('f.txt'), 'changed in the turn\n'); }
      else if (text === 'shell many') for (let i = 0; i < 45; i++) writeFileSync(at('many-' + String(i).padStart(2, '0') + '.txt'), 'n' + i + '\n');
      else if (text === 'shell big') writeFileSync(at('big.txt'), Array.from({ length: 6000 }, (_, i) => 'line ' + i + ' ' + 'x'.repeat(20)).join('\n') + '\n');
      else {
        writeFileSync(at('a.txt'), 'one\nTWO\nthree\n');
        writeFileSync(at('new.md'), 'fresh\n');
        rmSync(at('gone.txt'));
        renameSync(at('old.txt'), at('moved.txt'));
        writeFileSync(at('bin.dat'), Buffer.from([0, 1, 2, 3, 0, 255]));
        writeFileSync(at('sp ace.txt'), 'spaced again\n');
        writeFileSync(at('predirty.txt'), 'before turn\nin turn\n');
        writeFileSync(at('tool.md'), 'by the tool\n');
        await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'shell-edit-ok', title: 'Write tool.md', kind: 'edit', status: 'in_progress', locations: [{ path: at('tool.md') }] } });
        await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'shell-edit-ok', status: 'completed', content: [{ type: 'diff', path: at('tool.md'), oldText: null, newText: 'by the tool\n' }] } });
        await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'shell-edit-failed', title: 'Edit failed.md', kind: 'edit', status: 'failed', rawInput: { file_path: 'failed.md' } } });
        writeFileSync(at('failed.md'), 'by the shell after all\n');
      }
      await say('shell done');
    }
    // MC-13, MC-14: one file created then edited, one edited twice, one created, deleted and written again.
    if (text === 'mc13 writes') {
      const edit = (id, title, content) => connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call', toolCallId: id, title, kind: 'edit', status: 'completed', content } });
      await edit('mc-1', 'Write new.md', [{ type: 'diff', path: 'new.md', oldText: '', newText: 'a\nb\nc\n' }]);
      await edit('mc-2', 'Edit new.md', [{ type: 'diff', path: 'new.md', oldText: 'a\nb\nc\n', newText: 'a\nB\nc\n' }]);
      await edit('mc-3', 'Write redo.md', [{ type: 'diff', path: 'redo.md', newText: '', _meta: { added: true, hunks: [{ old: 0, new: 1, rows: [['add', 'x']] }] } }]);
      await edit('mc-4', 'Delete redo.md', [{ type: 'diff', path: 'redo.md', newText: '', _meta: { added: false, deleted: true, hunks: [{ old: 1, new: 0, rows: [['del', 'x']] }] } }]);
      await edit('mc-5', 'Write redo.md', [{ type: 'diff', path: 'redo.md', newText: '', _meta: { added: true, hunks: [{ old: 0, new: 2, rows: [['add', 'y'], ['add', 'z']] }] } }]);
      await edit('mc-6', 'Edit notes.md', [{ type: 'diff', path: 'notes.md', oldText: 'x\ny\n', newText: 'x\nY\n' }]);
      await edit('mc-7', 'Edit notes.md', [{ type: 'diff', path: 'notes.md', oldText: 'x\nY\n', newText: 'x\nY\nz\n' }]);
      await edit('mc-8', 'Edit redo.md', [{ type: 'diff', path: 'redo.md', newText: '', _meta: { added: false, hunks: [{ old: 2, new: 2, rows: [['del', 'y'], ['add', 'Y'], ['ctx', 'z']] }] } }]);
      // A failed write is not a change: it adds no lines and no edit to notes.md.
      await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'mc-9', title: 'Edit notes.md', kind: 'edit', status: 'failed', content: [{ type: 'diff', path: 'notes.md', oldText: 'x\nY\nz\n', newText: 'q\n' }] } });
      await say('mc13 done');
      return { stopReason: 'end_turn' };
    }
    if (text === 'v2 diff') {
      await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'edit-v2', title: 'Edit kept.md', kind: 'edit', status: 'completed', content: [
        { type: 'diff', path: 'kept.md', newText: '', _meta: { added: false, hunks: [{ old: 3, new: 3, rows: [['ctx', 'two'], ['del', 'old line'], ['add', 'new line']] }] } },
        { type: 'diff', path: 'fresh.md', newText: '', _meta: { added: true, hunks: [{ old: 0, new: 1, rows: [['add', 'hello']] }] } }] } });
      await say('v2 edited');
      return { stopReason: 'end_turn' };
    }
    if (text.startsWith('tools ') || text === 'tool-open' || text === 'tool-last') {
      const n = text.startsWith('tools ') ? Number(text.slice(6)) : 1, ms = existsSync('slow-tools') ? (existsSync('slower-tools') ? 40000 : 10000) : 3000;
      cancelled.delete(sessionId);
      for (let i = 1; i <= n; i++) {
        await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'tool-' + i, title: 'Run tool ' + i, kind: 'execute', status: 'in_progress' } });
        for (const end = Date.now() + ms; Date.now() < end && !cancelled.has(sessionId);) await new Promise((resolve) => setTimeout(resolve, 20));
        if (cancelled.has(sessionId)) return { stopReason: 'cancelled' };
        if (text === 'tool-open') break;
        await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-' + i, status: 'completed' } });
        if (text === 'tool-last') return { stopReason: 'end_turn' };
        await new Promise((resolve) => setTimeout(resolve, 300));
        await take(sessionId, say);
      }
      await say('tools done');
      return { stopReason: 'end_turn' };
    }
    // A long streamed turn: n tool calls, each updated once, with a reply chunk after each (3n events, 21 per 10 ms).
    if (text.startsWith('stream ')) {
      const n = Number(text.slice(7));
      for (let i = 1; i <= n; i++) {
        await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'run-' + i, title: 'Read file ' + i, kind: 'read', status: 'in_progress' } });
        await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'run-' + i, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'line '.repeat(40) + i } }] } });
        await say('step ' + i + ' done. ');
        if (i % 7 === 0) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return { stopReason: 'end_turn' };
    }
    // "drip <n> <ms>": a reply streamed the way a real agent writes it, n chunks of about 60 characters, ms apart, with a
    // tool call (started, then completed) after every tenth chunk.
    if (text.startsWith('drip ')) {
      const [n, ms] = text.slice(5).split(' ').map(Number);
      for (let i = 1; i <= n; i++) {
        await say('Chunk ' + i + ' of the reply, with **some** markdown and `code` in it. ' + (i % 5 ? '' : '\n\n'));
        if (i % 10 === 0) {
          await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'drip-' + i, title: 'Read file ' + i, kind: 'read', status: 'in_progress' } });
          await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'drip-' + i, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'line '.repeat(40) + i } }] } });
        }
        await new Promise((resolve) => setTimeout(resolve, ms));
      }
      return { stopReason: 'end_turn' };
    }
    if (text === 'ask-strict') {
      const result = await connection.createElicitation({ sessionId, mode: 'form', message: 'Order', requestedSchema: { type: 'object',
        properties: { colour: { type: 'string', enum: ['red', 'blue'] }, count: { type: 'integer', minimum: 1, maximum: 5 },
          tags: { type: 'array', minItems: null, maxItems: null, items: { type: 'string', enum: ['a', 'b'] } },
          code: { type: 'string', pattern: '^(a+)+$', minLength: null, maxLength: null }, mail: { type: 'string', format: 'email' },
          size: { type: 'string', title: 'Size', oneOf: [{ const: 's', title: 'Small' }, { const: 'l', title: 'Large' }] },
          extras: { type: 'array', minItems: 1, items: { anyOf: [{ const: 'x', title: 'Extra X' }, { const: 'y', title: 'Extra Y' }] } } },
        required: ['colour', 'count'] } });
      await say('ask:' + JSON.stringify(result));
      return { stopReason: 'end_turn' };
    }
    if (text === 'ask-object') {
      const result = await connection.createElicitation({ sessionId, mode: 'form', message: 'Address', requestedSchema: { type: 'object',
        properties: { name: { type: 'string' }, address: { type: 'object', properties: { city: { type: 'string' } } } } } });
      await say('ask:' + JSON.stringify(result));
      return { stopReason: 'end_turn' };
    }
    await say('echo:' + text);
    return { stopReason: 'end_turn' };
  },
});
