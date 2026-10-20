// Test-only ACP agent, ported from agent-first-workspace's _engine/fake-acp-agent.ts. The prompt text picks the
// behaviour: "permission" asks for approval, "ask" sends a form question, "ask-strict" one with required, integer,
// multi-select, pattern and format fields (some limits null) and optional choices, "ask-object" one with a nested
// object P9 cannot render, "slow" waits for cancel, "crash" exits, "detach" starts a setsid sleeper and replies with its
// pid, "env" replies with its environment's names (never values), "config" with its model and settings, "probe <port> <host> <script>" runs the phase 10 credential probe, anything else is echoed. A file named slow-init in
// the working directory stalls initialize for 10 s, hang-init never answers it; slow-close stalls session/close for 2 s.
import { Readable, Writable } from 'node:stream';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import * as acp from '@agentclientprotocol/sdk';

const cancelled = new Set();
// A real w x h RGB PNG as base64 (a red-green gradient), like the image an agent makes.
const png = (w, h) => {
  const chunk = (type, data) => { const head = Buffer.alloc(4), tail = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type), data]);
    head.writeUInt32BE(data.length); tail.writeUInt32BE(crc32(body)); return Buffer.concat([head, body, tail]); };
  const raw = Buffer.alloc((w * 3 + 1) * h), ihdr = Buffer.alloc(13);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) raw.set([Math.floor(x * 255 / w), Math.floor(y * 255 / h), 200], y * (w * 3 + 1) + 1 + x * 3);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
};
let mode = 'unset', model = 'default', cwd = '';
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
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { promptCapabilities: { image: !existsSync('no-images') }, sessionCapabilities: { resume: {}, close: {} } } };
  },
  async authenticate() { return {}; },
  async newSession(params) { cwd = 'new:' + params.cwd; const sessionId = `fake-${process.argv[2]}-${process.pid}-${Date.now()}`; commands(sessionId); return { sessionId, configOptions: configOptions() }; },
  async resumeSession(params) {
    if (!params.sessionId.startsWith('fake-')) throw new Error('unknown session');
    cwd = 'resume:' + params.cwd;
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
    const { sessionId } = params;
    const text = params.prompt.map((block) => (block.type === 'text' ? block.text : block.type === 'image' ? '[image ' + block.mimeType + ' ' + Buffer.from(block.data, 'base64').length + ']' : '')).join('');
    const say = (reply) => connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } } });
    if (text === 'crash') process.exit(3);
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
    // Both real adapters name a chat this way after a turn; the padding checks P9 tidies the name.
    if (text.startsWith('title ')) { await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'session_info_update', title: text.slice(6) } }); return { stopReason: 'end_turn' }; }
    if (text === 'cwd') { await say('cwd:' + cwd); return { stopReason: 'end_turn' }; }
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
    // A reply that lands well after the prompt was accepted, so a client must keep listening to see it.
    if (text === 'late') { await new Promise((resolve) => setTimeout(resolve, 1500)); await say('late reply'); return { stopReason: 'end_turn' }; }
    if (text === 'slow') {
      cancelled.delete(sessionId);
      await say('working');
      while (!cancelled.has(sessionId)) await new Promise((resolve) => setTimeout(resolve, 20));
      return { stopReason: 'cancelled' };
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
