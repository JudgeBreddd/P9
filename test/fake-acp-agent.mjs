// Test-only ACP agent, ported from agent-first-workspace's _engine/fake-acp-agent.ts. The prompt text picks the
// behaviour: "permission" asks for approval, "ask" sends a form question ("ask-later" after 2 s of work, "ask-text" a free-text one), "stream <n>" streams 3n updates, "background" ends
// its turn and works on unprompted without end, asking once ("background quiet" never); messages steered (_session/steering, off with a no-steering file) or prompted
// into it come back as "got:<text>" at its next step, "ask-strict" one with required, integer,
// multi-select, pattern and format fields (some limits null) and optional choices, "ask-object" one with a nested
// object P9 cannot render, "slow" waits for cancel, "crash" exits, "auth-required" fails the turn signed out, "detach" starts a setsid sleeper and replies with its
// pid, "env" replies with its environment's names (never values), "mcp" with the MCP servers P9 handed it, "config" with its model and settings, "probe <port> <host> <script>" runs the phase 10 credential probe, anything else is echoed. A file named slow-init in
// the working directory stalls initialize for 10 s, hang-init never answers it; slow-close stalls session/close for 2 s.
// "tools <n>" runs n tool calls of 3 s each (10 s with a slow-tools file; a cancel ends them), "tool-open" one that never completes before the turn ends, "tool-last" one
// that completes as the turn ends. Each steer is appended to steers.log; as Codex, one past the turn starts a turn of its
// own (startedNewTurn) that answers "got:<text>" and reports no end. "limits <n>" ends the turn, then reports context and plan use at n% a second later.
import { Readable, Writable } from 'node:stream';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import * as acp from '@agentclientprotocol/sdk';

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
      if (buffer.slice(0, end) === 'done') process.exit(0);
    }
  });
  await new Promise(() => {});
}

const cancelled = new Set();
// Messages that reach a running turn (a steer) or the unprompted work ("background"): answered at its next step.
const turns = new Set(), background = new Set(), inbox = new Map();
const deliver = (sessionId, text) => new Promise((done) => { if (!inbox.has(sessionId)) inbox.set(sessionId, []); inbox.get(sessionId).push({ text, done }); });
const take = async (sessionId, say) => { for (const m of inbox.get(sessionId)?.splice(0) ?? []) { await say('got:' + m.text); m.done(); } };
const textOf = (prompt) => prompt.map((block) => (block.type === 'text' ? block.text : block.type === 'image' ? '[image ' + block.mimeType + ' ' + Buffer.from(block.data, 'base64').length + ']' : '')).join('');
// A real w x h RGB PNG as base64 (a red-green gradient), like the image an agent makes.
const png = (w, h) => {
  const chunk = (type, data) => { const head = Buffer.alloc(4), tail = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type), data]);
    head.writeUInt32BE(data.length); tail.writeUInt32BE(crc32(body)); return Buffer.concat([head, body, tail]); };
  const raw = Buffer.alloc((w * 3 + 1) * h), ihdr = Buffer.alloc(13);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) raw.set([Math.floor(x * 255 / w), Math.floor(y * 255 / h), 200], y * (w * 3 + 1) + 1 + x * 3);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
};
let mode = 'unset', model = 'default', cwd = '', mcpServers = null, folder = '';
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
const picked = { effort: 'medium', fast: 'off', sandbox: 'on' };
const configOptions = () => [{ id: 'mode', name: 'Mode', type: 'select', currentValue: mode,
  options: [{ value: 'agent', name: 'Agent' }, { value: 'workspace-write', name: 'Workspace write' }] },
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model,
    options: [{ value: 'default', name: 'Default (recommended)' }, { group: 'more', name: 'More', options: [{ value: 'opus', name: 'Opus' }, { value: 'haiku', name: 'Haiku' }] }] },
  // Like the real adapters: effort and fast mode; sandbox is a mode-category switch P9 must never offer (threat model row 22).
  { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: picked.effort, options: ['low', 'medium', 'high'].map((value) => ({ value, name: value[0].toUpperCase() + value.slice(1) })) },
  { id: 'fast', name: 'Fast mode', category: 'model_config', type: 'select', currentValue: picked.fast, options: [{ value: 'on', name: 'On' }, { value: 'off', name: 'Off' }] },
  { id: 'sandbox', name: 'Sandbox', category: 'mode', type: 'select', currentValue: picked.sandbox, options: [{ value: 'on', name: 'On' }, { value: 'off', name: 'Off' }] }];
// Like both real adapters: the slash command list arrives as an update just after the session starts.
const commands = (sessionId) => connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'available_commands_update',
  availableCommands: [{ name: 'compact', description: 'Clear history but keep a summary' }, { name: 'context', description: 'Show context use' }, { name: 'review', description: 'Review the changes' }] } });

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const connection = new acp.AgentSideConnection(() => ({
  async initialize() {
    if (existsSync('hang-init')) await new Promise(() => {});
    if (existsSync('slow-init')) await new Promise((resolve) => setTimeout(resolve, 10000));
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { promptCapabilities: { image: !existsSync('no-images') }, sessionCapabilities: { resume: {}, close: {} } },
      ...(!existsSync('no-steering') && { _meta: { steering: { supported: true } } }) };
  },
  // Like claude-agent-acp 0.88's _session/steering with idleBehavior promptRequired.
  async extMethod(method, params) {
    if (method !== '_session/steering' || existsSync('no-steering')) throw acp.RequestError.methodNotFound(method);
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
    cwd = 'resume:' + params.cwd; folder = params.cwd;
    mcpServers = params.mcpServers;
    commands(params.sessionId);
    return { configOptions: configOptions() };
  },
  async closeSession() { if (existsSync('slow-close')) await new Promise((resolve) => setTimeout(resolve, 2000)); return {}; },
  async setSessionConfigOption(params) {
    if (params.configId === 'model') { if (!['default', 'opus', 'haiku'].includes(params.value)) throw new Error('unknown model'); model = params.value; }
    else if (Object.hasOwn(picked, params.configId)) { picked[params.configId] = String(params.value); } else mode = String(params.value);
    return { configOptions: configOptions() };
  },
  async cancel(params) { cancelled.add(params.sessionId); },
  async prompt(params) {
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
    const text = textOf(params.prompt);
    const say = (reply) => connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } } });
    if (text === 'crash') process.exit(3);
    if (text === 'auth-required') throw acp.RequestError.authRequired();
    // codex-acp 2.1.1 to a client that takes no notices: its warnings arrive as whole reply chunks, then the reply.
    if (text === 'codex warning') {
      await say('Warning: Falling back from WebSockets to HTTPS transport. stream disconnected before completion: websocket closed by server before response.completed\n\n');
      await say('Warning: Some new thing the agent program says\n\n');
      await say('Glad she turned out just how you wanted!');
      return { stopReason: 'end_turn' };
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
    if (text === 'model') { await say('model:' + model); return { stopReason: 'end_turn' }; }
    if (text === 'plan') {
      await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'plan', entries: [['completed', 'Read the chat ledger'], ['in_progress', 'Pin the plan above the composer'],
        ['pending', 'Check it on the phone']].map(([status, content]) => ({ status, content, priority: 'medium' })) } });
      return { stopReason: 'end_turn' };
    }
    // Both real adapters name a chat this way after a turn; the padding checks P9 tidies the name.
    if (text.startsWith('title ')) { await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'session_info_update', title: text.slice(6) } }); return { stopReason: 'end_turn' }; }
    if (text === 'cwd') { await say('cwd:' + cwd); return { stopReason: 'end_turn' }; }
    if (text === 'mcp') { await say('mcp:' + JSON.stringify(mcpServers)); return { stopReason: 'end_turn' }; }
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
    if (text === 'late') { await new Promise((resolve) => setTimeout(resolve, 1500)); await say('late reply'); return { stopReason: 'end_turn' }; }
    if (text === 'slow') {
      cancelled.delete(sessionId);
      await say('working');
      while (!cancelled.has(sessionId)) { await take(sessionId, say); await new Promise((resolve) => setTimeout(resolve, 20)); }
      return { stopReason: 'cancelled' };
    }
    // A coordinator's background tasks (2026-10-24): each report wakes the agent with no prompt, so after this turn ends
    // it works on with no end and no closing usage_update, and asks once on its tenth step ("background quiet" never asks).
    if (text === 'background' || text === 'background quiet') {
      background.add(sessionId);
      setTimeout(async () => {
        for (let i = 1; ; i++) {
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
    if (text.startsWith('tools ') || text === 'tool-open' || text === 'tool-last') {
      const n = text.startsWith('tools ') ? Number(text.slice(6)) : 1, ms = existsSync('slow-tools') ? 10000 : 3000;
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
}), stream);
