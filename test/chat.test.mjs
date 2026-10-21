import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, readdir, mkdir, chmod, unlink, symlink, rename } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { request } from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { daemon, restart, http, authenticated, root } from './helpers.mjs';
import { formSpec } from '../apps/server/chat.mjs';
import { zElicitationSchema } from '../node_modules/@agentclientprotocol/sdk/dist/schema/zod.gen.js';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const userBus = process.env.XDG_RUNTIME_DIR && existsSync(path.join(process.env.XDG_RUNTIME_DIR, 'bus'))
  && spawnSync('systemctl', ['--user', 'show-environment'], { timeout: 1000, stdio: 'ignore' }).status === 0;
const start = (t, env = {}) => daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake], env }));
const call = (instance, route, method = 'GET', body, headers = {}) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
  body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (promise) => { const result = await promise; return { ...result, body: JSON.parse(result.text) }; };
async function create(instance, provider = 'claude') {
  const result = await json(call(instance, '/chat', 'POST', { provider }));
  assert.equal(result.status, 201, result.text);
  return result.body.conversation;
}
// Long-polls the event log until one event matches; returns it with everything seen so far.
async function until(instance, match, after = 0) {
  const seen = [];
  for (let i = 0; i < 40; i += 1) {
    const { body } = await json(call(instance, `/chat/events?after=${after}&wait=2000`));
    seen.push(...body.events);
    after = body.cursor;
    const hit = body.events.find(match);
    if (hit) return { hit, seen, cursor: after };
  }
  throw new Error('event-timeout: ' + JSON.stringify(seen.slice(-5)));
}
const said = (conversation, prefix) => (event) => event.conversation === conversation && event.type === 'update'
  && event.data.sessionUpdate === 'agent_message_chunk' && event.data.content.text.startsWith(prefix);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('a turn streams through the event log; reconnecting from any cursor gives the rest once, across a restart', async (t) => {
  const instance = await start(t);
  const id = await create(instance);
  assert.equal((await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'hello' })).status, 202);
  const { seen } = await until(instance, (event) => event.type === 'turn-end');
  assert.deepEqual(seen.map((event) => event.type).filter((type) => type !== 'update'), ['created', 'user', 'connected', 'config', 'turn-end']);
  assert.ok(seen.some(said(id, 'echo:hello')));
  const cursors = seen.map((event) => event.cursor);
  assert.deepEqual(cursors, [...new Set(cursors)].sort((a, b) => a - b));
  const middle = cursors[Math.floor(cursors.length / 2)];
  const tail = (await json(call(instance, `/chat/events?after=${middle}`))).body.events;
  assert.deepEqual(tail.map((event) => event.cursor), cursors.filter((cursor) => cursor > middle));
  // History is durable: a fresh daemon on the same home serves the same cursors, then resumes the adapter session.
  instance.child.kill('SIGTERM');
  await once(instance.child, 'exit');
  const second = await restart(t, instance, 'state-2');
  assert.deepEqual((await json(call(second, '/chat/events?after=0'))).body.events.map((event) => event.cursor).slice(0, cursors.length), cursors);
  assert.equal((await call(second, `/chat/${id}/prompt`, 'POST', { text: 'again' })).status, 202);
  const resumed = await until(second, (event) => event.type === 'turn-end', cursors.at(-1));
  assert.ok(resumed.seen.some((event) => event.type === 'resumed'));
  assert.ok(resumed.seen.some(said(id, 'echo:again')));
  console.log(`PASS chat events: ${cursors.length} events, reconnect from cursor ${middle} gave ${tail.length}, none twice; restart kept history and resumed`);
});

test('approvals and questions are answered only with options and fields the agent offered', async (t) => {
  const instance = await start(t);
  const id = await create(instance);
  await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'permission' });
  const { hit: approval, cursor } = await until(instance, (event) => event.type === 'approval');
  assert.deepEqual(approval.data.options.map((option) => option.optionId), ['allow', 'reject']);
  assert.equal((await call(instance, `/chat/${id}/answer`, 'POST', { request: approval.data.request, answer: { optionId: 'always' } })).status, 400);
  assert.equal((await call(instance, `/chat/${id}/answer`, 'POST', { request: randomUUID(), answer: { optionId: 'allow' } })).status, 404);
  assert.equal((await call(instance, `/chat/${id}/answer`, 'POST', { request: approval.data.request, answer: { optionId: 'allow' } })).status, 200);
  const done = await until(instance, (event) => event.type === 'turn-end', cursor);
  assert.ok(done.seen.some(said(id, 'permission:allow')));
  await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'ask' });
  const { hit: question, cursor: asked } = await until(instance, (event) => event.type === 'question', done.cursor);
  assert.equal((await call(instance, `/chat/${id}/answer`, 'POST', { request: question.data.request, answer: { action: 'accept', content: { shell: 'rm' } } })).status, 400);
  assert.equal((await call(instance, `/chat/${id}/answer`, 'POST', { request: question.data.request, answer: { action: 'accept', content: { colour: 'red' } } })).status, 200);
  const answered = await until(instance, (event) => event.type === 'turn-end', asked);
  assert.ok(answered.seen.some(said(id, 'ask:{"action":"accept","content":{"colour":"red"}}')));
  // One turn at a time; cancel ends it with the adapter's own stop reason.
  await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'slow' });
  await until(instance, said(id, 'working'), answered.cursor);
  assert.equal((await json(call(instance, `/chat/${id}/prompt`, 'POST', { text: 'second' }))).body.error, 'turn-running');
  assert.equal((await call(instance, `/chat/${id}/cancel`, 'POST')).status, 200);
  const cancelled = await until(instance, (event) => event.type === 'turn-end', answered.cursor);
  assert.equal(cancelled.hit.data.stopReason, 'cancelled');
  // Codex starts in Auto review, Codex's own default (contracts.md rule 2); the fake starts 'unset', so the daemon set it.
  const codex = await create(instance, 'codex');
  await call(instance, `/chat/${codex}/prompt`, 'POST', { text: 'mode' });
  assert.ok((await until(instance, said(codex, 'mode:'), cancelled.cursor)).hit.data.content.text === 'mode:agent');
  console.log('PASS chat answers: unknown option 400, unknown request 404, unknown field 400; allow and colour reached the agent; busy 409; cancel; codex agent (Auto review)');
});

// Threat model row 15's Required cases 1-2 (desktop side; case 3's phone half is in phone.test.mjs).
test('agent lock: no-write mode for new and running sessions, permission requests rejected by the daemon, kept across a restart', async (t) => {
  const instance = await start(t);
  const lock = (body) => json(call(instance, '/agent-lock', 'POST', body));
  assert.deepEqual((await json(call(instance, '/agent-lock'))).body, { on: false });
  for (const bad of [{}, { on: 'yes' }, { on: true, extra: 1 }, [true]]) assert.equal((await lock(bad)).status, 400, JSON.stringify(bad));
  const before = await create(instance, 'codex');
  await call(instance, `/chat/${before}/prompt`, 'POST', { text: 'mode' });
  let at = (await until(instance, said(before, 'mode:agent'))).cursor;
  // An approval already waiting when the lock turns on is rejected, not left for Builder.
  const waiting = await create(instance);
  await call(instance, `/chat/${waiting}/prompt`, 'POST', { text: 'permission' });
  at = (await until(instance, (event) => event.type === 'approval' && event.conversation === waiting, at)).cursor;
  assert.deepEqual((await lock({ on: true })).body, { on: true });
  at = (await until(instance, said(waiting, 'permission:reject'), at)).cursor;
  await call(instance, `/chat/${before}/prompt`, 'POST', { text: 'mode' });
  const switched = await until(instance, said(before, 'mode:'), at);
  assert.equal(switched.hit.data.content.text, 'mode:read-only');
  at = switched.cursor;
  const after = await create(instance);
  await call(instance, `/chat/${after}/prompt`, 'POST', { text: 'mode' });
  const planned = await until(instance, said(after, 'mode:'), at);
  assert.equal(planned.hit.data.content.text, 'mode:plan');
  await until(instance, (event) => event.type === 'turn-end' && event.conversation === after, at);
  await call(instance, `/chat/${after}/prompt`, 'POST', { text: 'permission' });
  const rejected = await until(instance, said(after, 'permission:'), planned.cursor);
  assert.equal(rejected.hit.data.content.text, 'permission:reject');
  assert.ok(!rejected.seen.some((event) => event.type === 'approval' && event.conversation === after), 'a locked request reached the screen');
  assert.ok(rejected.seen.some((event) => event.type === 'lock-rejected' && event.conversation === after));
  // A restart keeps the lock.
  instance.child.kill('SIGTERM');
  await once(instance.child, 'exit');
  const second = await restart(t, instance, 'state-2');
  assert.deepEqual((await json(call(second, '/agent-lock'))).body, { on: true });
  const fresh = await create(second);
  await call(second, `/chat/${fresh}/prompt`, 'POST', { text: 'mode' });
  let cursor = (await until(second, said(fresh, 'mode:plan'))).cursor;
  await until(second, (event) => event.type === 'turn-end' && event.conversation === fresh, cursor - 1);
  // Off again: the normal mode comes back and a request reaches the screen.
  assert.deepEqual((await json(call(second, '/agent-lock', 'POST', { on: false }))).body, { on: false });
  await call(second, `/chat/${fresh}/prompt`, 'POST', { text: 'mode' });
  cursor = (await until(second, said(fresh, 'mode:default'), cursor)).cursor;
  await until(second, (event) => event.type === 'turn-end' && event.conversation === fresh, cursor - 1);
  await call(second, `/chat/${fresh}/prompt`, 'POST', { text: 'permission' });
  await until(second, (event) => event.type === 'approval' && event.conversation === fresh, cursor);
  console.log('PASS agent lock: bad bodies 400; running codex read-only, new claude plan, waiting and new approvals rejected unseen; kept across restart; off restores default and approvals');
});

// Builder, 2026-10-17: the chat said Auto but Claude asked before every command; the picker never reached the agent.
test('mode picker: each prompt sets the picked mode, unknown modes refused, the lock still wins', async (t) => {
  const instance = await start(t);
  let at = 0;
  const modeAfter = async (id, mode) => {
    assert.equal((await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'mode', mode })).status, 202, mode);
    const hit = await until(instance, said(id, 'mode:'), at);
    at = (await until(instance, (event) => event.type === 'turn-end' && event.conversation === id, hit.cursor - 1)).cursor;
    return hit.hit.data.content.text;
  };
  const claude = await create(instance), codex = await create(instance, 'codex');
  assert.equal(await modeAfter(claude, 'Auto'), 'mode:auto');
  assert.equal(await modeAfter(claude, 'Plan'), 'mode:plan');
  assert.equal(await modeAfter(claude, 'Manual'), 'mode:default');
  assert.equal(await modeAfter(claude, 'Accept edits'), 'mode:acceptEdits');
  assert.equal(await modeAfter(claude, 'Bypass permissions'), 'mode:bypassPermissions', 'threat model row 25');
  assert.equal(await modeAfter(codex, 'Read-only'), 'mode:read-only');
  assert.equal(await modeAfter(codex, 'Workspace access'), 'mode:workspace-write');
  assert.equal(await modeAfter(codex, 'Auto review'), 'mode:agent', 'contracts.md rule 2');
  assert.equal(await modeAfter(codex, 'Full access'), 'mode:agent-full-access', 'threat model row 25');
  for (const [id, mode] of [[claude, 'bypassPermissions'], [claude, 'auto'], [codex, 'Auto'], [codex, 'agent'], [codex, 'workspace-write'], [claude, 'Full access'], [claude, 'toString']])
    assert.equal((await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'mode', mode })).status, 400, mode);
  assert.deepEqual((await json(call(instance, '/agent-lock', 'POST', { on: true }))).body, { on: true });
  assert.equal(await modeAfter(claude, 'Bypass permissions'), 'mode:plan', 'the lock wins over bypass');
  assert.equal(await modeAfter(codex, 'Full access'), 'mode:read-only', 'the lock wins over Full access');
  console.log('PASS mode picker: Claude 5 and Codex 4 modes reach the agent by its own ids, 7 unknown modes 400, lock wins over bypass and Full access');
});

test('a signed-out agent says how to sign in, not just "Authentication required" (GitHub issue #4)', async (t) => {
  const instance = await start(t);
  for (const [provider, want] of [['claude', /^Claude Code is not signed in on this computer\. .*run claude and log in/], ['codex', /^Codex is not signed in on this computer\. .*run codex login/]]) {
    const id = await create(instance, provider);
    assert.equal((await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'auth-required' })).status, 202, provider);
    const { hit } = await until(instance, (event) => event.type === 'error' && event.conversation === id);
    assert.match(hit.data.message, want, provider);
  }
  console.log('PASS signed out: Claude and Codex authRequired errors become sign-in steps');
});

test('agent images: kept with their own data only; SVG, remote, bad alphabet, oversized and a fifth image stored as notes (threat model row 26)', async (t) => {
  const instance = await start(t);
  const id = await create(instance, 'codex');
  assert.equal((await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'images hostile' })).status, 202);
  const { hit } = await until(instance, (event) => event.conversation === id && event.type === 'update' && event.data.toolCallId === 'bad-1');
  const shown = hit.data.content.map(({ content }) => content.type === 'image' ? Object.keys(content).join() + ':' + content.mimeType + ':' + content.data.length : content.text.trim().slice(0, 16));
  const note = '[image not shown';
  assert.deepEqual(shown, ['type,mimeType,data:image/png:' + hit.data.content[0].content.data.length, note, note, note, note, ...Array(3).fill(shown[0]), note]);
  assert.ok(hit.data.content[0].content.data.length > 50 && !JSON.stringify(hit.data).includes('example.com'));
  console.log('PASS agent images: 4 PNGs kept as sent, SVG, remote-only, bad alphabet, 8 MiB+ and the fifth image each a note, no address kept');
});

test('agent images from disk: an opened image file named only by its path is read and kept; a non-image, too big, a folder, a FIFO and a relative path stay links (threat model row 27)', async (t) => {
  const instance = await start(t);
  const id = await create(instance, 'codex');
  assert.equal((await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'images from disk' })).status, 202);
  const { hit } = await until(instance, (event) => event.conversation === id && event.type === 'update' && event.data.toolCallId === 'view-1');
  const { hit: chunk } = await until(instance, (event) => event.conversation === id && event.type === 'update' && event.data.content?.type === 'image' && !event.data.toolCallId);
  const shown = hit.data.content.map(({ content }) => content.type === 'image' ? Object.keys(content).join() + ':' + content.mimeType : content.type);
  assert.deepEqual(shown, ['type,mimeType,data:image/png', 'type,mimeType,data:image/png', ...Array(5).fill('resource_link')]);
  const file = await readFile(hit.data.title.slice('View Image '.length));
  assert.equal(hit.data.content[0].content.data, file.toString('base64'), 'the file\'s own bytes');
  assert.equal(chunk.data.content.data, file.toString('base64'), 'a reply\'s link to the image too');
  assert.ok(!JSON.stringify(hit.data).includes('hunter2'), 'the non-image file is never read into the chat');
  console.log('PASS agent images from disk: path and file:// read as PNG, reply link read, fake.png, 6 MiB+, folder, FIFO and relative path left as links');
});

// Builder, 2026-10-19: "When creating a new chat, a dropdown with what folder i want to open the chat in would be great."
// Threat model row 24: the folder is checked like a file path, kept, and checked again at every start.
test('chat folder: the agent starts and resumes in it; outside, linked, locked or file paths are refused', async (t) => {
  const instance = await start(t);
  await mkdir(path.join(instance.workspace, 'proj/sub'), { recursive: true });
  await mkdir(path.join(instance.workspace, '_private'));
  await symlink(instance.directory, path.join(instance.workspace, 'out'));
  const cwdAfter = async (id, after) => {
    assert.equal((await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'cwd' })).status, 202);
    const hit = await until(instance, said(id, 'cwd:'), after);
    return { text: hit.hit.data.content.text, cursor: (await until(instance, (e) => e.type === 'turn-end' && e.conversation === id, hit.cursor - 1)).cursor };
  };
  const made = await json(call(instance, '/chat', 'POST', { provider: 'claude', folder: 'proj/sub' }));
  assert.equal(made.status, 201, made.text);
  const id = made.body.conversation;
  const first = await cwdAfter(id, 0);
  assert.equal(first.text, 'cwd:new:' + path.join(instance.workspace, 'proj/sub'));
  assert.equal((await call(instance, `/chat/${id}/stop`, 'POST')).status, 200);
  const again = await cwdAfter(id, first.cursor);
  assert.equal(again.text, 'cwd:resume:' + path.join(instance.workspace, 'proj/sub'), 'a resumed chat keeps its folder');
  assert.equal((await json(call(instance, '/chat'))).body.conversations.find((c) => c.id === id).folder, 'proj/sub');
  const plain = await create(instance);
  assert.equal((await cwdAfter(plain, again.cursor)).text, 'cwd:new:' + instance.workspace, 'no folder is the workspace');
  for (const folder of ['../', '..', path.join(instance.workspace, 'proj'), 'out', 'note.txt', '_private', 'proj/../_private', 'nope', 7])
    assert.equal((await call(instance, '/chat', 'POST', { provider: 'claude', folder })).status, 400, JSON.stringify(folder));
  // A folder swapped for a link after the chat was made: the next start refuses it.
  assert.equal((await call(instance, `/chat/${id}/stop`, 'POST')).status, 200);
  await rename(path.join(instance.workspace, 'proj'), path.join(instance.workspace, 'proj-moved'));
  await symlink(path.join(instance.workspace, 'proj-moved'), path.join(instance.workspace, 'proj'));
  assert.equal((await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'cwd' })).status, 502);
  console.log('PASS chat folder: new and resumed session start in proj/sub, no folder = workspace, 9 bad folders 400, a folder swapped for a link refused at start');
});

test('model picker and slash commands: the agent\'s own models and commands reach the window, a prompt picks only an offered model', async (t) => {
  const instance = await start(t);
  const id = await create(instance);
  const turn = async (body, from) => {
    assert.equal((await call(instance, `/chat/${id}/prompt`, 'POST', body)).status, 202, JSON.stringify(body));
    return until(instance, (event) => event.type === 'turn-end' && event.conversation === id, from);
  };
  const first = await turn({ text: 'model' }, 0);
  const config = await until(instance, (event) => event.type === 'config' && event.conversation === id, 0);
  assert.deepEqual(config.hit.data.model, { current: 'default', options: [{ value: 'default', name: 'Default (recommended)' }, { value: 'opus', name: 'Opus' }, { value: 'haiku', name: 'Haiku' }] }, 'grouped options flattened');
  const listed = await until(instance, (event) => event.type === 'update' && event.conversation === id && event.data.sessionUpdate === 'available_commands_update', 0);
  assert.deepEqual(listed.hit.data.availableCommands.map((c) => c.name), ['compact', 'context', 'review']);
  const picked = await turn({ text: 'model', model: 'opus' }, first.cursor);
  assert.equal((await until(instance, said(id, 'model:'), first.cursor)).hit.data.content.text, 'model:opus');
  assert.equal((await until(instance, (event) => event.type === 'config' && event.conversation === id && event.data.model.current === 'opus', first.cursor)).hit.data.model.current, 'opus');
  for (const model of ['sonnet-not-offered', '', 'x'.repeat(201), 7]) assert.equal((await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'model', model })).status, 400, String(model));
  await turn({ text: 'model' }, picked.cursor);
  assert.equal((await until(instance, said(id, 'model:'), picked.cursor)).hit.data.content.text, 'model:opus', 'a refused model changed nothing');
  console.log('PASS model picker: 3 models listed (group flattened), opus set and kept, 4 bad models 400; 3 slash commands listed');
});

test('chat name: the title the agent sends is tidied, listed and kept across a restart', async (t) => {
  // Builder, 2026-10-19: "have the tabs at the top for each chat show the chats name."
  const instance = await start(t);
  const id = await create(instance);
  assert.equal((await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'title   Fix the\n  login bug ' })).status, 202);
  await until(instance, (event) => event.type === 'turn-end' && event.conversation === id);
  const title = async (at) => (await json(call(at, '/chat'))).body.conversations.find((c) => c.id === id).title;
  assert.equal(await title(instance), 'Fix the login bug');
  instance.child.kill('SIGTERM');
  await once(instance.child, 'exit');
  assert.equal(await title(await restart(t, instance, 'state-2')), 'Fix the login bug', 'kept across a restart');
  console.log('PASS chat name: "Fix the login bug" from a padded agent title, kept across a restart');
});

test('setting pickers: effort and fast mode reach the window, a mode-category option never does, a prompt sets only offered values', async (t) => {
  const instance = await start(t);
  const id = await create(instance);
  const turn = async (body, from) => {
    assert.equal((await call(instance, `/chat/${id}/prompt`, 'POST', body)).status, 202, JSON.stringify(body));
    return until(instance, (event) => event.type === 'turn-end' && event.conversation === id, from);
  };
  const first = await turn({ text: 'config' }, 0);
  const config = await until(instance, (event) => event.type === 'config' && event.conversation === id, 0);
  assert.deepEqual(config.hit.data.pickers.map((p) => [p.id, p.name, p.current, p.options.map((o) => o.value).join('/')]),
    [['effort', 'Effort', 'medium', 'low/medium/high'], ['fast', 'Fast mode', 'off', 'on/off']], 'sandbox (category mode) is not offered');
  const picked = await turn({ text: 'config', config: { effort: 'high', fast: 'on' } }, first.cursor);
  assert.equal((await until(instance, said(id, 'config:'), first.cursor)).hit.data.content.text, 'config:model=default,effort=high,fast=on,sandbox=on');
  assert.equal((await until(instance, (event) => event.type === 'config' && event.conversation === id && event.data.pickers[0].current === 'high' && event.data.pickers[1].current === 'on', first.cursor)).hit.data.pickers.length, 2);
  const bad = [{ sandbox: 'off' }, { effort: 'max' }, { mode: 'workspace-write' }, { effort: 7 }, { effort: '' }, ['effort', 'low'], 'effort', Object.fromEntries('abcdefg'.split('').map((k) => [k, 'x']))];
  for (const config of bad) assert.equal((await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'config', config })).status, 400, JSON.stringify(config));
  await turn({ text: 'config' }, picked.cursor);
  assert.equal((await until(instance, said(id, 'config:'), picked.cursor)).hit.data.content.text, 'config:model=default,effort=high,fast=on,sandbox=on', 'a refused setting changed nothing');
  console.log('PASS setting pickers: effort + fast listed, sandbox hidden, high/on set and kept, 8 bad settings 400');
});

test('images: a photo reaches the agent as an image block; bad types, encodings, counts, sizes and image-free agents refused (threat model row 20)', async (t) => {
  const instance = await start(t);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', bytes = Buffer.from(png, 'base64').length;
  const id = await create(instance);
  assert.equal((await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'look', images: [{ mimeType: 'image/png', data: png }] })).status, 202);
  const { hit, seen } = await until(instance, said(id, 'echo:'));
  assert.equal(hit.data.content.text, `echo:look[image image/png ${bytes}]`);
  assert.deepEqual(seen.find((event) => event.type === 'user').data, { text: 'look', images: 1 }, 'the event keeps the count, not the image');
  let at = (await until(instance, (event) => event.type === 'turn-end' && event.conversation === id, hit.cursor - 1)).cursor;
  // A photo alone is a message too.
  assert.equal((await call(instance, `/chat/${id}/prompt`, 'POST', { text: '', images: [{ mimeType: 'image/png', data: png }] })).status, 202);
  assert.equal((await until(instance, said(id, 'echo:'), at)).hit.data.content.text, `echo:[image image/png ${bytes}]`);
  at = (await until(instance, (event) => event.type === 'turn-end' && event.conversation === id, at)).cursor;
  const image = { mimeType: 'image/png', data: png };
  for (const [why, images] of [['svg', [{ mimeType: 'image/svg+xml', data: png }]], ['not base64', [{ mimeType: 'image/png', data: '<script>' }]], ['five', Array(5).fill(image)],
    ['over 2 MiB', [{ mimeType: 'image/png', data: 'A'.repeat(2 * 1024 * 1024 + 4) }]], ['not a list', image], ['empty data', [{ mimeType: 'image/png', data: '' }]], ['no text, no image', []]])
    assert.equal((await call(instance, `/chat/${id}/prompt`, 'POST', { text: '', images })).status, 400, why);
  // An agent that does not report image support gets no image.
  await writeFile(path.join(instance.workspace, 'no-images'), '');
  const plain = await create(instance);
  const refused = await json(call(instance, `/chat/${plain}/prompt`, 'POST', { text: 'look', images: [image] }));
  assert.deepEqual([refused.status, refused.body.error], [400, 'images-unsupported']);
  assert.equal((await call(instance, `/chat/${plain}/prompt`, 'POST', { text: 'words' })).status, 202, 'the conversation still takes text');
  console.log('PASS images: PNG delivered as an image block, photo-only message, 7 bad requests 400, image-free agent refused');
});

test('operation IDs: required, replayed once finished, refused when reused, outcome unknown after a crash', async (t) => {
  const instance = await start(t);
  assert.equal((await call(instance, '/chat', 'POST', { provider: 'claude' }, { 'x-p9-op': '' })).status, 428);
  const op = randomUUID();
  const first = await json(call(instance, '/chat', 'POST', { provider: 'claude' }, { 'x-p9-op': op }));
  const again = await json(call(instance, '/chat', 'POST', { provider: 'claude' }, { 'x-p9-op': op }));
  assert.equal(again.status, 201);
  assert.equal(again.headers['x-p9-replayed'], '1');
  assert.deepEqual(again.body, first.body);
  assert.equal((await json(call(instance, '/chat', 'POST', { provider: 'codex' }, { 'x-p9-op': op }))).body.error, 'operation-reused');
  // The client gives up after sending; the side effect happens once and the retry gets its reply.
  const lost = randomUUID();
  await new Promise((resolve) => {
    const req = request({ socketPath: path.join(instance.state, 'daemon.sock'), path: '/chat', method: 'POST',
      headers: { ...authenticated(instance.credentials), 'content-type': 'application/json', 'x-p9-op': lost } });
    req.on('error', () => resolve());
    req.on('close', resolve);
    req.end(JSON.stringify({ provider: 'codex', title: 'lost' }), () => setImmediate(() => req.destroy()));
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const retried = await json(call(instance, '/chat', 'POST', { provider: 'codex', title: 'lost' }, { 'x-p9-op': lost }));
  assert.equal(retried.status, 201);
  assert.equal(retried.headers['x-p9-replayed'], '1');
  const titles = (await json(call(instance, '/chat'))).body.conversations.map((conversation) => conversation.title);
  assert.deepEqual(titles, ['Claude', 'lost']);
  // The daemon dies mid-operation: the retry is told the outcome is unknown, never re-run; the turn is interrupted.
  await writeFile(path.join(instance.workspace, 'slow-init'), '');
  const crashed = randomUUID();
  const pending = call(instance, `/chat/${first.body.conversation}/prompt`, 'POST', { text: 'hello' }, { 'x-p9-op': crashed }).catch((error) => error);
  await new Promise((resolve) => setTimeout(resolve, 500));
  instance.child.kill('SIGKILL');
  await once(instance.child, 'exit');
  await pending;
  const second = await restart(t, instance, 'state-2');
  const unknown = await json(call(second, `/chat/${first.body.conversation}/prompt`, 'POST', { text: 'hello' }, { 'x-p9-op': crashed }));
  assert.equal(unknown.status, 409);
  assert.equal(unknown.body.error, 'outcome-unknown');
  const events = (await json(call(second, '/chat/events?after=0'))).body.events;
  assert.equal(events.filter((event) => event.type === 'user').length, 1);
  assert.equal(events.at(-1).type, 'interrupted');
  console.log('PASS operation IDs: 428 without, replay with x-p9-replayed, reuse 409, lost reply replayed once, SIGKILL mid-prompt gives outcome-unknown and interrupted');
});

test('agents see only allowlisted environment names, in a new session and a resumed one', async (t) => {
  const instance = await start(t, { P9_SENTINEL_TOKEN: 'sentinel', OPENAI_API_KEY: 'sentinel', LANG: 'C.UTF-8' });
  const id = await create(instance, 'codex');
  await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'env' });
  const first = await until(instance, said(id, 'env:'));
  const fresh = first.hit.data.content.text.slice(4).split(',');
  assert.equal((await call(instance, `/chat/${id}/stop`, 'POST')).status, 200);
  await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'env' });
  const resumed = await until(instance, said(id, 'env:'), first.cursor);
  assert.ok(resumed.seen.some((event) => event.type === 'resumed'));
  for (const names of [fresh, resumed.hit.data.content.text.slice(4).split(',')]) {
    assert.ok(names.includes('LANG') && names.includes('PATH'), names.join(','));
    assert.ok(!names.includes('P9_SENTINEL_TOKEN') && !names.includes('OPENAI_API_KEY') && !names.includes('P9_TEST_HOME'), names.join(','));
  }
  // Every process the server starts goes through childEnv.
  for (const file of (await readdir(path.join(root, 'apps/server'))).filter((name) => name.endsWith('.mjs'))) {
    const source = await readFile(path.join(root, 'apps/server', file), 'utf8');
    for (const line of source.split('\n').filter((text) => /\bspawn(Sync)?\(/.test(text) && !/^\s*\/\//.test(text))) {
      const call = source.slice(source.indexOf(line), source.indexOf(line) + 400);
      assert.match(call.slice(0, call.indexOf(');') + 2), /env: childEnv\(\)/, `${file}: ${line}`);
    }
  }
  // Locale names pass by category, not by pattern.
  const { childEnv } = await import('../apps/server/child-env.mjs');
  assert.deepEqual(Object.keys(childEnv({ LC_TIME: 'C', LC_ALL: 'C', LC_SECRET_TOKEN: 'sentinel' })), ['LC_TIME', 'LC_ALL']);
  console.log(`PASS child env: agent saw ${fresh.length} names (no sentinel, no API key), same after resume; every server spawn passes childEnv`);
});

test('Stop ends everything the session started, setsid children included, inside 5 s', { skip: !userBus && 'no systemd user bus' }, async (t) => {
  const instance = await start(t, { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS });
  const units = () => execFileSync('systemctl', ['--user', 'list-units', '--plain', '--no-legend', 'p9-chat-*'], { encoding: 'utf8' });
  const before = new Set(units().split('\n').map((row) => row.split(' ')[0]));
  const id = await create(instance);
  await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'detach' });
  const pid = Number((await until(instance, said(id, 'detach:'))).hit.data.content.text.slice(7));
  assert.ok(alive(pid), 'setsid child running');
  // Only scopes this test started count: the live daemon may be running a chat of Builder's at the same time.
  const ours = () => units().split('\n').filter((row) => / loaded active/.test(row)).map((row) => row.split(' ')[0]).filter((name) => !before.has(name));
  assert.ok(ours().length > 0, 'the chat runs in its own scope');
  const began = Date.now();
  const stopped = await json(call(instance, `/chat/${id}/stop`, 'POST'));
  const took = Date.now() - began;
  assert.equal(stopped.body.result, 'stopped');
  assert.ok(took < 5000, `stop took ${took} ms`);
  assert.ok(!alive(pid), 'setsid child survived Stop');
  assert.deepEqual(ours(), [], 'a scope this chat started is still active');
  console.log(`PASS stop: scope stopped in ${took} ms, setsid child ${pid} gone`);
});

test('form answers must fit the offered schema: enum, required, integer range, multi-select options', async (t) => {
  const instance = await start(t);
  const id = await create(instance);
  await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'ask-strict' });
  const { hit: question, cursor } = await until(instance, (event) => event.type === 'question');
  const answer = (content) => call(instance, `/chat/${id}/answer`, 'POST', { request: question.data.request, answer: { action: 'accept', content } });
  // The daemon's form is what the UI renders: optional choices are marked optional, pattern and format are hints only.
  const fields = Object.fromEntries(question.data.form.fields.map((field) => [field.key, field]));
  assert.deepEqual([fields.colour.kind, fields.colour.required, fields.size.kind, fields.size.required, fields.extras.kind, fields.extras.min], ['choice', true, 'choice', false, 'multi', 1]);
  assert.match(fields.code.hint, /pattern/);
  for (const content of [{ colour: 'run-anyway', count: 1 }, { colour: 'red' }, { colour: 'red', count: 2.5 }, { colour: 'red', count: 9 },
    { colour: 'red', count: '2' }, { colour: 'red', count: 2, tags: ['c'] }, { colour: 'red', count: 2, tags: 'a' }, { colour: 'red', count: 2, tags: ['a', 'a'] },
    { colour: 'red', count: 2, size: 'm' }, { colour: 'red', count: 2, extras: [] }, { colour: 'red', count: 2, other: 'x' }])
    assert.equal((await answer(content)).status, 400, JSON.stringify(content));
  // A catastrophic pattern (^(a+)+$ on 32 a's and a !) is never run, so the answer returns at once; the agent checks it.
  const began = Date.now();
  const content = { colour: 'blue', count: 2, tags: [], code: 'a'.repeat(32) + '!', mail: 'not-an-address' };
  assert.equal((await answer(content)).status, 200);
  const took = Date.now() - began;
  assert.ok(took < 1000, `answer took ${took} ms`);
  const done = await until(instance, (event) => event.type === 'turn-end', cursor);
  assert.ok(done.seen.some(said(id, 'ask:' + JSON.stringify({ action: 'accept', content }))));
  console.log(`PASS form answers: unoffered enum, missing required, non-integer, out of range, string number, unknown or repeated tag, unoffered optional choice, empty minItems array, unknown field all 400; optional fields left out; agent pattern not run (${took} ms); the answer reached the agent unchanged`);
});

test('the form compiler refuses every schema outside its profile', () => {
  const form = (properties, extra = {}) => formSpec({ type: 'object', properties, ...extra });
  const name = { type: 'string' };
  assert.ok(form({ name }), 'baseline compiles');
  // ACP's types make null the same as absent for required, metadata and limits.
  // Every nullable or metadata field ACP allows, parsed by the pinned SDK first, as it arrives in production.
  const meta = { _meta: null };
  const acp = zElicitationSchema.parse({ type: 'object', required: null, title: null, description: null, ...meta, properties: {
    name: { type: 'string', title: null, description: null, pattern: null, format: null, minLength: null, maxLength: null, default: null, enum: null, ...meta },
    pick: { type: 'string', oneOf: [{ const: 'a', title: 'A', description: null, ...meta }], ...meta },
    tags: { type: 'array', minItems: null, maxItems: null, default: null, items: { anyOf: [{ const: 'x', title: 'X', description: 'an x', _meta: {} }], ...meta }, ...meta },
    plain: { type: 'array', items: { type: 'string', enum: ['p'], ...meta } },
    n: { type: 'number', minimum: null, maximum: null, default: null, ...meta }, ok: { type: 'boolean', default: null, ...meta } } });
  assert.equal(formSpec(acp)?.fields.length, 6, 'ACP-valid nullable schema compiles');
  // Length bounds beside choices: only the choices inside them are offered.
  const bounded = formSpec(zElicitationSchema.parse({ type: 'object', properties: { colour: { type: 'string', enum: ['red', 'blue', 'green'], minLength: 3, maxLength: 4 } } }));
  assert.deepEqual(bounded?.fields[0].options, [['red', 'red'], ['blue', 'blue']]);
  // enum and oneOf together offer the values in both, with oneOf's titles; lengths count code points.
  const both = formSpec(zElicitationSchema.parse({ type: 'object', properties: { colour: { type: 'string', enum: ['red', 'blue'], oneOf: [{ const: 'red', title: 'Red' }, { const: 'green', title: 'Green' }] },
    icon: { type: 'string', enum: ['💙'], minLength: 1, maxLength: 1 } } }));
  assert.deepEqual(both?.fields.map((f) => f.options), [[['red', 'Red']], [['💙', '💙']]]);
  // A multi-select may offer '' (its checkboxes are indexed); a single choice may not.
  assert.deepEqual(formSpec(zElicitationSchema.parse({ type: 'object', required: ['t'], properties: { t: { type: 'array', minItems: 1, items: { type: 'string', enum: [''] } } } }))?.fields[0].options, [['', '']]);
  const refused = {
    'root minProperties': form({ name }, { minProperties: 1 }), 'root additionalProperties': form({ name }, { additionalProperties: false }),
    'required not array': form({ name }, { required: 'name' }), 'required unknown key': form({ name }, { required: ['other'] }),
    'required repeated': form({ name }, { required: ['name', 'name'] }), 'negative minLength': form({ name: { type: 'string', minLength: -1 } }),
    'fractional minItems': form({ t: { type: 'array', minItems: 1.5, items: { enum: ['a'] } } }), 'reversed range': form({ n: { type: 'integer', minimum: 5, maximum: 1 } }),
    'reversed length': form({ name: { type: 'string', minLength: 3, maxLength: 1 } }), 'enum not array': form({ c: { type: 'string', enum: 'a' } }),
    'empty enum': form({ c: { type: 'string', enum: [] } }), 'enum and oneOf share nothing': form({ c: { type: 'string', enum: ['a'], oneOf: [{ const: 'b', title: 'B' }] } }),
    'number enum': form({ c: { type: 'number', enum: [1, 2] } }), 'minLength on number': form({ n: { type: 'number', minLength: 1 } }),
    'non-string title': form({ name: { type: 'string', title: 5 } }), 'nested object': form({ o: { type: 'object', properties: {} } }),
    'unknown key': form({ name: { type: 'string', $ref: '#/x' } }), 'repeated choice': form({ c: { type: 'string', enum: ['a', 'a'] } }),
    'root title number': form({ name }, { title: 5 }), 'no choice inside bounds': form({ c: { type: 'string', enum: ['a'], minLength: 2 } }),
    'empty-string enum': form({ c: { type: 'string', enum: ['', 'auto'] } }), 'empty-string const': form({ c: { type: 'string', oneOf: [{ const: '' }] } }),
  };
  const compiled = Object.entries(refused).filter(([, spec]) => spec !== null).map(([label]) => label);
  assert.deepEqual(compiled, []);
  console.log(`PASS form compiler: ${Object.keys(refused).length} out-of-profile schemas all refused`);
});

test('a form P9 cannot render faithfully offers only Decline', async (t) => {
  const instance = await start(t);
  const id = await create(instance);
  await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'ask-object' });
  const { hit: question, cursor } = await until(instance, (event) => event.type === 'question');
  assert.equal(question.data.form, null);
  const answer = (value) => call(instance, `/chat/${id}/answer`, 'POST', { request: question.data.request, answer: value });
  assert.equal((await answer({ action: 'accept', content: { name: 'x' } })).status, 400);
  assert.equal((await answer({ action: 'decline' })).status, 200);
  const done = await until(instance, (event) => event.type === 'turn-end', cursor);
  assert.ok(done.seen.some(said(id, 'ask:{"action":"decline"}')));
  console.log('PASS unsupported form: nested object gives no form; accept 400, decline reached the agent');
});

test('Stop refuses a prompt sent while it runs, so no replacement adapter outlives it', async (t) => {
  const instance = await start(t);
  const id = await create(instance);
  await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'hello' });
  const { cursor } = await until(instance, (event) => event.type === 'turn-end');
  await writeFile(path.join(instance.workspace, 'slow-close'), '');
  const stopping = json(call(instance, `/chat/${id}/stop`, 'POST'));
  await new Promise((resolve) => setTimeout(resolve, 100));
  // A second Stop (its own operation ID) must not mark the row stopped while the first still cleans up.
  const second = json(call(instance, `/chat/${id}/stop`, 'POST'));
  await new Promise((resolve) => setTimeout(resolve, 200));
  const during = await json(call(instance, `/chat/${id}/prompt`, 'POST', { text: 'again' }));
  assert.equal(during.status, 409);
  assert.equal(during.body.error, 'stopping');
  assert.equal((await stopping).body.result, 'stopped');
  assert.equal((await second).body.result, 'stopped');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const after = (await json(call(instance, `/chat/events?after=${cursor}`))).body.events.map((event) => event.type);
  assert.deepEqual(after, ['stopped'], after.join(','));
  assert.equal((await json(call(instance, '/chat'))).body.conversations[0].state, 'stopped');
  console.log('PASS stop race: a second Stop shared the first; prompt during Stop got 409 stopping; one stopped event; no replacement adapter');
});

test('Stop during a slow adapter start ends it; the waiting prompt gets 409 and the conversation reopens', async (t) => {
  const instance = await start(t);
  const id = await create(instance);
  await writeFile(path.join(instance.workspace, 'slow-init'), '');
  const prompting = json(call(instance, `/chat/${id}/prompt`, 'POST', { text: 'hello' }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const stopped = await json(call(instance, `/chat/${id}/stop`, 'POST'));
  assert.equal(stopped.body.result, 'stopped');
  const prompted = await prompting;
  assert.equal(prompted.status, 409);
  assert.equal(prompted.body.error, 'stopping');
  const events = (await json(call(instance, '/chat/events?after=0'))).body.events.filter((event) => event.conversation === id).map((event) => event.type);
  assert.ok(!events.includes('connected'), events.join(','));
  await unlink(path.join(instance.workspace, 'slow-init'));
  assert.equal((await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'hello' })).status, 202);
  await until(instance, said(id, 'echo:hello'));
  console.log('PASS stop mid-start: Stop stopped the starting adapter; waiting prompt 409 stopping; never connected; next prompt ran');
});

test('a failed scope query makes Stop report cleanup-failed, never stopped', async (t) => {
  const instance = await daemon(t, undefined, false, async ({ directory }) => {
    const bin = path.join(directory, 'bin'), runtime = path.join(directory, 'runtime');
    await mkdir(bin);
    await mkdir(runtime, { mode: 0o700 });
    await writeFile(path.join(runtime, 'bus'), '');
    // systemd-run runs the command unscoped; systemctl fails with no output, as with a dead user bus.
    await writeFile(path.join(bin, 'systemd-run'), '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n');
    await writeFile(path.join(bin, 'systemctl'), '#!/bin/sh\nexit 1\n');
    await chmod(path.join(bin, 'systemd-run'), 0o755);
    await chmod(path.join(bin, 'systemctl'), 0o755);
    return { args: ['--acp-override', fake], path: `${bin}:${process.env.PATH}`, env: { XDG_RUNTIME_DIR: runtime } };
  });
  const id = await create(instance);
  await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'hello' });
  const { cursor } = await until(instance, (event) => event.type === 'turn-end');
  const stopped = await json(call(instance, `/chat/${id}/stop`, 'POST'));
  assert.equal(stopped.status, 500);
  assert.equal(stopped.body.result, 'cleanup-failed');
  // The row keeps the real outcome: a new prompt is refused and no second adapter starts beside the unconfirmed one.
  assert.equal((await json(call(instance, '/chat'))).body.conversations[0].state, 'cleanup-failed');
  const again = await json(call(instance, `/chat/${id}/prompt`, 'POST', { text: 'hello' }));
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'cleanup-failed');
  // A later Stop retries the same adapter; it still cannot confirm, so the conversation stays closed.
  assert.equal((await json(call(instance, `/chat/${id}/stop`, 'POST'))).body.result, 'cleanup-failed');
  const after = (await json(call(instance, `/chat/events?after=${cursor}`))).body.events.map((event) => event.type);
  assert.ok(!after.includes('connected') && !after.includes('user'), after.join(','));
  console.log('PASS scope query failure: Stop answered 500 cleanup-failed; row cleanup-failed; prompt 409 with no new adapter; retry still refused');
});

test('operation IDs older than a week are refused after a restart, never run again', async (t) => {
  const instance = await start(t);
  const op = randomUUID();
  assert.equal((await call(instance, '/chat', 'POST', { provider: 'claude' }, { 'x-p9-op': op })).status, 201);
  instance.child.kill('SIGTERM');
  await once(instance.child, 'exit');
  const db = new DatabaseSync(path.join(instance.directory, '.local/state/p9-foundation/p9.db'));
  db.prepare('UPDATE operations SET at = ? WHERE id = ?').run(Date.now() - 8 * 24 * 3600 * 1000, op);
  db.close();
  const second = await restart(t, instance, 'state-2');
  const retried = await json(call(second, '/chat', 'POST', { provider: 'claude' }, { 'x-p9-op': op }));
  assert.equal(retried.status, 409);
  assert.equal(retried.body.error, 'operation-expired');
  assert.equal((await json(call(second, '/chat'))).body.conversations.length, 1);
  console.log('PASS operation expiry: an 8-day-old ID got 409 operation-expired after restart; still one conversation');
});

test('daemon shutdown with a long poll open stops the agent scope and exits cleanly inside 2 s', { skip: !userBus && 'no systemd user bus' }, async (t) => {
  const instance = await start(t, { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS });
  const id = await create(instance);
  await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'detach' });
  const pid = Number((await until(instance, said(id, 'detach:'))).hit.data.content.text.slice(7));
  await until(instance, (event) => event.type === 'turn-end');
  const latest = (await json(call(instance, '/chat/events?after=0'))).body.cursor;
  const poll = call(instance, `/chat/events?after=${latest}&wait=8000`).catch((error) => error);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const began = Date.now();
  instance.child.kill('SIGTERM');
  const [code] = await once(instance.child, 'exit');
  const took = Date.now() - began;
  await poll;
  assert.equal(code, 0);
  assert.ok(took < 2000, `shutdown took ${took} ms`);
  assert.ok(!alive(pid), 'setsid child survived shutdown');
  console.log(`PASS shutdown: exit 0 in ${took} ms with a long poll open; setsid child ${pid} gone`);
});

// A daemon killed outright with a setsid child still running in its agent's scope.
async function crashed(t) {
  const instance = await start(t, { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS });
  const id = await create(instance);
  await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'detach' });
  const pid = Number((await until(instance, said(id, 'detach:'))).hit.data.content.text.slice(7));
  await until(instance, (event) => event.type === 'turn-end');
  instance.child.kill('SIGKILL');
  await once(instance.child, 'exit');
  assert.ok(alive(pid), 'setsid child should outlive a SIGKILLed daemon');
  return { instance, id, pid };
}
const chatUnits = () => execFileSync('systemctl', ['--user', 'list-units', '--plain', '--no-legend', 'p9-chat-*'], { encoding: 'utf8' }).trim();

test('after a crash, a Stop and a prompt sent during startup recovery never leave an adapter behind a stopped row', { skip: !userBus && 'no systemd user bus' }, async (t) => {
  const { instance, id, pid } = await crashed(t);
  const second = await restart(t, instance, 'state-2');
  const [stopped, prompted] = await Promise.all([json(call(second, `/chat/${id}/stop`, 'POST')), json(call(second, `/chat/${id}/prompt`, 'POST', { text: 'hello' }))]);
  assert.equal(stopped.body.result, 'stopped');
  assert.ok(!alive(pid), 'setsid child survived recovery');
  await new Promise((resolve) => setTimeout(resolve, 500));
  const state = (await json(call(second, '/chat'))).body.conversations[0].state;
  // Either order is fine; what must never happen is a stopped row with an adapter scope still running.
  if (state === 'stopped') assert.equal(chatUnits(), '', 'row stopped but a chat scope runs');
  else assert.equal(prompted.status, 202, `state ${state} with prompt ${prompted.status}`);
  console.log(`PASS recovery race: Stop stopped, crashed daemon's child ${pid} gone; prompt ${prompted.status}; final state ${state} consistent`);
});

test('after a crash, shutdown during startup recovery waits for the sweep', { skip: !userBus && 'no systemd user bus' }, async (t) => {
  const { instance, pid } = await crashed(t);
  const second = await restart(t, instance, 'state-2');
  second.child.kill('SIGTERM');
  const [code, signal] = await once(second.child, 'exit');
  assert.equal(code, 0, `daemon exit signal ${signal}`);
  assert.ok(!alive(pid), 'setsid child survived a shutdown during recovery');
  console.log(`PASS shutdown during recovery: exit 0; crashed daemon's child ${pid} gone`);
});

test('daemon shutdown during a slow Stop waits for that Stop, so its setsid child is gone at exit', { skip: !userBus && 'no systemd user bus' }, async (t) => {
  const instance = await start(t, { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS });
  const id = await create(instance);
  await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'detach' });
  const pid = Number((await until(instance, said(id, 'detach:'))).hit.data.content.text.slice(7));
  await until(instance, (event) => event.type === 'turn-end');
  await writeFile(path.join(instance.workspace, 'slow-close'), '');
  // The Stop takes the session out of the live map at once and then waits on session/close.
  const stopping = call(instance, `/chat/${id}/stop`, 'POST').catch((error) => error);
  await new Promise((resolve) => setTimeout(resolve, 150));
  instance.child.kill('SIGTERM');
  const [code] = await once(instance.child, 'exit');
  await stopping;
  assert.equal(code, 0);
  assert.ok(!alive(pid), 'setsid child survived a shutdown during Stop');
  console.log(`PASS shutdown during Stop: exit 0 after the Stop's cleanup; setsid child ${pid} gone`);
});

test('an adapter that never answers the handshake fails its start and cannot hold Stop All', async (t) => {
  const instance = await start(t);
  const id = await create(instance, 'claude');
  await writeFile(path.join(instance.workspace, 'hang-init'), '');
  const began = Date.now();
  const slow = (route, body) => json(http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method: 'POST', timeout: 60_000,
    headers: { ...authenticated(instance.credentials), 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  const prompt = slow(`/chat/${id}/prompt`, { text: 'hello' });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const stop = slow('/stop-all', {});
  assert.equal((await prompt).status, 502);
  assert.equal((await stop).status, 200);
  assert.ok(Date.now() - began < 55_000, 'start held the barrier past its limit');
  console.log('PASS hung adapter handshake: start refused 502 after the limit, Stop All finished');
});
