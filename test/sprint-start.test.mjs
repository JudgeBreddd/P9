// Start sprint (0.1.9 phase 4.5 daemon-1; SECURITY.md § Start sprint): one press makes the lead's chat and every chat
// under it, each on exactly its roles.json row's provider, model and effort; a value P9 cannot start is refused by name
// before any chat is made; pressing again keeps what was made; the press is the approval record.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { daemon, http, authenticated, root } from './helpers.mjs';
import { Client } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const call = (instance, route, method = 'GET', body) => http({ socketPath: instance.credentials.socketPath, route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  .then((result) => ({ ...result, body: result.text ? JSON.parse(result.text) : null }));
const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
const rows = async (instance) => (await call(instance, '/chat')).body.conversations;
const events = async (instance, id) => (await call(instance, '/chat/events?after=0&only=' + id)).body.events;
// The agent's reply to "config": its model and settings, as the fake agent reports them.
async function config(instance, id) {
  for (let i = 0; i < 100; i += 1) {
    const hit = (await events(instance, id)).find((e) => e.data?.content?.text?.startsWith('config:'));
    if (hit) return hit.data.content.text;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('no config reply from ' + id);
}
async function until(instance, match, after = 0) {
  for (let i = 0; i < 40; i += 1) {
    const { body } = await call(instance, `/chat/events?after=${after}&wait=2000`);
    after = body.cursor;
    const hit = body.events.find(match);
    if (hit) return { hit, cursor: after };
  }
  throw new Error('event-timeout');
}
// A chat the user made in the project, and the SDK client from the MCP entry its agent was handed.
async function agent(t, instance, project) {
  const { body: { conversation } } = await call(instance, '/chat', 'POST', { provider: 'claude', project });
  await call(instance, `/chat/${conversation}/prompt`, 'POST', { text: 'mcp' });
  return attach(t, instance, conversation);
}
// The same for a chat already sent "mcp" (a worker whose task was that word).
async function attach(t, instance, conversation) {
  const { hit, cursor } = await until(instance, (e) => e.conversation === conversation && e.data?.content?.text?.startsWith('mcp:'));
  const [entry] = JSON.parse(hit.data.content.text.slice(4));
  const client = new Client({ name: 'p9-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env: Object.fromEntries(entry.env.map(({ name, value }) => [name, value])) }));
  t.after(() => client.close());
  const tool = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  return { conversation, client, tool, cursor };
}

test('Start sprint: one press makes every chat on exactly its row (lead included); a row P9 cannot start is refused by name before any chat; pressing again keeps what was made; the press is the approval record', { timeout: 300000 }, async (t) => {
  // profile.log in the workspace: the fake agent writes there each start's provider settings (a hash, never the key).
  const instance = await daemon(t, undefined, false, async ({ workspace }) => { fs.writeFileSync(path.join(workspace, 'profile.log'), ''); return { args: ['--acp-override', fake] }; });
  const seen = () => fs.readFileSync(path.join(instance.workspace, 'profile.log'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const ws = instance.workspace;
  const repo = path.join(ws, 'repo');
  fs.mkdirSync(repo); g(repo, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); g(repo, 'add', 'a.txt'); g(repo, 'commit', '-qm', 'a');
  fs.mkdirSync(path.join(ws, 'plain'));
  const project = (await call(instance, '/projects', 'POST', { name: 'Fresh', work: { kind: 'new', parent: '', name: 'fresh' } })).body.project.id;
  // Settings > Delegation stays on Ask me first: the press is the yes, so no chat is asked about.
  assert.equal((await call(instance, '/delegation')).body.start, 'ask');
  // P9 learns each agent's model and effort lists when it first runs: one chat of each.
  const a = await agent(t, instance, project);
  const codex = (await call(instance, '/chat', 'POST', { provider: 'codex' })).body.conversation;
  await call(instance, `/chat/${codex}/prompt`, 'POST', { text: 'config' });
  await config(instance, codex);
  const before = (await rows(instance)).length;

  // A prep: a sprint folder before any of its chats, listed on the project page.
  assert.equal((await call(instance, '/projects/' + project + '/sprints', 'POST', { title: 'S1', extra: 1 })).status, 400);
  assert.equal((await call(instance, '/projects/00000000-0000-4000-8000-000000000000/sprints', 'POST', { title: 'S1' })).status, 404);
  const prep = await call(instance, '/projects/' + project + '/sprints', 'POST', { title: 'S1' });
  assert.equal(prep.status, 201, JSON.stringify(prep.body));
  const sprint = prep.body.sprint;
  assert.deepEqual(prep.body.files.map((f) => f.name), ['sprint.md', 'roles.json', 'roles/lead.instructions.md', 'roles/lead.rules.md', 'roles/lead.work.md', 'roles/review.instructions.md', 'roles/review.rules.md', 'roles/review.work.md']);
  let listed = (await call(instance, '/projects/' + project)).body.project.sprints.find((s) => s.lead === sprint);
  assert.equal(listed.prep, true); assert.equal(listed.title, 'S1'); assert.equal(listed.started, undefined);
  // The empty rows P9 made are refused by name: nothing is swapped for a default.
  let press = await call(instance, `/sprints/${sprint}/start`, 'POST', {});
  assert.equal(press.status, 400); assert.equal(press.body.error, 'role-refused'); assert.equal(press.body.role, 'lead'); assert.equal(press.body.field, 'provider');

  // The files, through the project page's route (it works on a prep).
  const save = async (name, text) => {
    const file = (await call(instance, '/projects/' + project)).body.project.sprints.find((s) => s.lead === sprint).files.find((f) => f.name === name);
    const got = await call(instance, '/projects/' + project + '/sprint-file', 'POST', { lead: sprint, name, text, hash: file?.hash ?? '' });
    assert.equal(got.status, 200, name + ' ' + JSON.stringify(got.body));
  };
  const lead = { key: 'lead', provider: 'claude', model: 'opus', effort: 'high' };
  const review = { key: 'review', provider: 'claude', model: 'haiku', effort: 'low' };
  const w1 = { key: 'w1', provider: 'codex', model: 'haiku', effort: 'medium' };
  const w2 = { key: 'w2', provider: 'claude', model: 'default', effort: 'low' };
  const roles = (list, folder = 'repo') => JSON.stringify({ folder, roles: list });
  for (const key of ['lead', 'review', 'w1', 'w2']) await save(`roles/${key}.work.md`, 'config');

  // Every refusal names the role and the field, and makes no chat.
  const refusals = [
    [[lead, { ...w1, model: 'gpt-9' }], 'w1', 'model'],
    [[lead, { ...w1, effort: 'max' }], 'w1', 'effort'],
    [[{ ...lead, provider: 'gemini' }, w1], 'lead', 'provider'],
    [[lead, { ...w2, provider: 'profile:nope' }], 'w2', 'provider'],
    [[lead, { ...w2, model: '' }], 'w2', 'model'],
    [[lead, { ...w2, mode: 'Fly' }], 'w2', 'mode'],
    [[lead, { ...w2, extra: 1 }], 'w2', 'key'],
    [[w1, w2], 'lead', 'key'],
    [[lead, w1, { ...w2, key: 'w1' }], 'w1', 'key'],
  ];
  for (const [list, role, field] of refusals) {
    await save('roles.json', roles(list));
    press = await call(instance, `/sprints/${sprint}/start`, 'POST', {});
    assert.equal(press.status, 400, JSON.stringify(list));
    assert.deepEqual([press.body.error, press.body.role, press.body.field], ['role-refused', role, field], JSON.stringify(press.body));
    assert.match(press.body.detail, new RegExp('^Role ' + role + ', ' + field));
  }
  await save('roles.json', roles([lead, ...Array.from({ length: 21 }, (_, i) => ({ ...w2, key: 'x' + i }))]));
  press = await call(instance, `/sprints/${sprint}/start`, 'POST', {});
  assert.deepEqual([press.status, press.body.error], [400, 'too-many-roles']);
  assert.equal((await rows(instance)).length, before, 'a refused press made a chat');
  assert.equal(fs.existsSync(path.join(path.dirname(prep.body.folder), sprint, 'workers')), false, 'a refused press made a worker folder');
  assert.equal((await call(instance, `/sprints/${sprint}/start`, 'POST', { by: 'x' })).status, 400, 'the press has no fields');
  assert.equal((await call(instance, '/sprints/00000000-0000-4000-8000-000000000000/start', 'POST', {})).status, 404);

  // The press: the lead takes the sprint's id; each chat under it is on exactly its row.
  const text = roles([lead, review, w1, w2]);
  await save('roles.json', text);
  press = await call(instance, `/sprints/${sprint}/start`, 'POST', {});
  assert.equal(press.status, 200, JSON.stringify(press.body));
  assert.equal(press.body.lead, sprint);
  assert.deepEqual(press.body.chats.map((c) => [c.key, c.provider, c.model, c.effort, c.existing]),
    [['lead', 'claude', 'opus', 'high', false], ['review', 'claude', 'haiku', 'low', false], ['w1', 'codex', 'haiku', 'medium', false], ['w2', 'claude', 'default', 'low', false]]);
  const all = await rows(instance);
  for (const [row, c] of [[lead, press.body.chats[0]], [review, press.body.chats[1]], [w1, press.body.chats[2]], [w2, press.body.chats[3]]]) {
    const got = all.find((r) => r.id === c.chat);
    assert.equal(got.provider, row.provider, row.key + ' provider');
    assert.equal(got.parent ?? null, row.key === 'lead' ? null : sprint, row.key + ' parent');
    assert.match(await config(instance, c.chat), new RegExp(`^config:model=${row.model},effort=${row.effort},`), row.key + ' did not start on its row');
    assert.equal((await events(instance, c.chat)).filter((e) => e.type === 'approval').length, 0, row.key + ' was asked about');
  }
  assert.equal(all.length, before + 4);
  const workers = path.join(path.dirname(prep.body.folder), sprint, 'workers');
  assert.equal(g(path.join(workers, 'w1'), 'branch', '--show-current'), 'sprint/' + sprint.slice(0, 8) + '/w1');
  assert.equal(fs.existsSync(path.join(workers, 'review')), false, 'the reviewer has no worktree');
  // The approval record: when, by whom, and the plan's hash as it was pressed.
  const plan = createHash('sha256').update(fs.readFileSync(path.join(prep.body.folder, 'sprint.md'), 'utf8') + '\0' + text).digest('hex');
  listed = (await call(instance, '/projects/' + project)).body.project.sprints.find((s) => s.lead === sprint);
  assert.equal(listed.prep, false);
  // O171 (framing): and the hash of each Setup file whose text reaches chats (here the role files, made empty).
  const { files, ...record } = listed.started, EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  assert.deepEqual({ ...record, at: typeof record.at }, { at: 'number', plan, by: 'owner', scripts: [] });
  assert.deepEqual(files, Object.fromEntries(['roles/lead.instructions.md', 'roles/lead.rules.md', 'roles/review.instructions.md', 'roles/review.rules.md'].map((n) => [n, EMPTY])));
  assert.deepEqual(press.body.started, listed.started);

  // Pressing again: everything is kept, nothing is made or sent again.
  const sent = (await events(instance, press.body.chats[3].chat)).filter((e) => e.type === 'user').length;
  const again = await call(instance, `/sprints/${sprint}/start`, 'POST', {});
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual(again.body.chats.map((c) => [c.key, c.chat, c.existing]), press.body.chats.map((c) => [c.key, c.chat, true]));
  assert.equal((await rows(instance)).length, before + 4);
  assert.equal((await events(instance, press.body.chats[3].chat)).filter((e) => e.type === 'user').length, sent, 'a kept chat was sent its work again');

  // A failure halfway (the folder is not a repository): the lead is made, the worker is not. Fixed, the next press
  // keeps the lead and makes the rest.
  const s2 = (await call(instance, '/projects/' + project + '/sprints', 'POST', { title: 'S2' })).body;
  const folder2 = s2.folder, write2 = (name, body) => fs.writeFileSync(path.join(folder2, name), body);
  write2('roles.json', roles([lead, w2], 'plain')); write2('roles/lead.work.md', 'config');
  write2('roles/w2.work.md', 'config');
  const half = await call(instance, `/sprints/${s2.sprint}/start`, 'POST', {});
  assert.notEqual(half.status, 200, JSON.stringify(half.body));
  assert.equal(half.body.role, 'w2', JSON.stringify(half.body));
  assert.deepEqual(half.body.chats.map((c) => c.key), ['lead']);
  const count = (await rows(instance)).length;
  write2('roles.json', roles([lead, w2]));
  const rest = await call(instance, `/sprints/${s2.sprint}/start`, 'POST', {});
  assert.equal(rest.status, 200, JSON.stringify(rest.body));
  assert.deepEqual(rest.body.chats.map((c) => [c.key, c.existing]), [['lead', true], ['w2', false]]);
  assert.equal((await rows(instance)).length, count + 1);
  assert.match(await config(instance, rest.body.chats[1].chat), /^config:model=default,effort=low,/);
  assert.equal((await events(instance, s2.sprint)).filter((e) => e.type === 'user' && e.data?.text === 'config').length, 1, 'the lead was sent its work again');
  // A chat made whose first message never reached its agent (its agent could not start): the next press sends it, once.
  const w3 = { key: 'w3', provider: 'codex', model: 'opus', effort: 'high' };
  write2('roles.json', roles([lead, w2, w3])); write2('roles/w3.work.md', 'config');
  fs.writeFileSync(path.join(ws, 'signed-out'), '');
  const stuck = await call(instance, `/sprints/${s2.sprint}/start`, 'POST', {});
  fs.rmSync(path.join(ws, 'signed-out'));
  assert.notEqual(stuck.status, 200, JSON.stringify(stuck.body));
  assert.equal(stuck.body.role, 'w3', JSON.stringify(stuck.body));
  const w3chat = (await rows(instance)).find((r) => r.parent === s2.sprint && r.title === 'w3');
  assert.ok(w3chat, 'the chat was made before its agent failed to start');
  const sentW2 = (await events(instance, rest.body.chats[1].chat)).filter((e) => e.type === 'user').length;
  const resumed = await call(instance, `/sprints/${s2.sprint}/start`, 'POST', {});
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  assert.deepEqual(resumed.body.chats.map((c) => [c.key, c.existing, c.sent ?? false]), [['lead', true, false], ['w2', true, false], ['w3', true, true]]);
  assert.equal(resumed.body.chats[2].chat, w3chat.id);
  assert.match(await config(instance, w3chat.id), /^config:model=opus,effort=high,/, 'the kept chat was not started on its row');
  assert.equal((await events(instance, rest.body.chats[1].chat)).filter((e) => e.type === 'user').length, sentW2, 'a chat that got its work was sent it again');
  assert.equal((await call(instance, `/sprints/${s2.sprint}/start`, 'POST', {})).body.chats.filter((c) => c.sent).length, 0, 'a delivered chat was sent its work again');

  // A row naming claude is never run on a provider profile: not Settings > Delegation's rows, not the lead's own.
  const { profile } = (await call(instance, '/profiles', 'POST', { name: 'Far Cloud', baseUrl: 'https://models.example.test/api/', models: ['glm-5.3', 'kimi-k3:cloud'], key: 'sk-profile-test-0f3a9c71d2e84b56' })).body;
  const far = { agent: 'profile:' + profile.id, model: 'kimi-k3:cloud', effort: '' };
  await call(instance, '/delegation', 'POST', { start: 'ask', max: 5, workers: [far, far, far, far, far] });
  const s5 = (await call(instance, '/projects/' + project + '/sprints', 'POST', { title: 'S5' })).body;
  const plead = { key: 'lead', provider: 'profile:' + profile.id, model: 'glm-5.3', effort: 'low' }, builtin = { key: 'b', provider: 'claude', model: 'opus', effort: 'high' };
  fs.writeFileSync(path.join(s5.folder, 'roles.json'), roles([plead, builtin]));
  fs.writeFileSync(path.join(s5.folder, 'roles/lead.work.md'), 'config'); fs.writeFileSync(path.join(s5.folder, 'roles/b.work.md'), 'config');
  const starts = seen().length;
  const p5 = await call(instance, `/sprints/${s5.sprint}/start`, 'POST', {});
  assert.equal(p5.status, 200, JSON.stringify(p5.body));
  assert.deepEqual(p5.body.chats.map((c) => [c.key, c.provider, c.model]), [['lead', 'profile:' + profile.id, 'glm-5.3'], ['b', 'claude', 'opus']]);
  assert.match(await config(instance, p5.body.chats[1].chat), /^config:model=opus,effort=high,/, 'the built-in row did not start on its row');
  const [leadStart, bStart, ...more5] = seen().slice(starts);
  assert.deepEqual(more5, [], 'one agent start per chat');
  assert.deepEqual([leadStart.model, leadStart.baseUrl], ['glm-5.3', 'https://models.example.test/api'], 'the profile lead was not on its profile');
  assert.equal(bStart.baseUrl ?? null, null, 'a row naming claude ran on a provider profile');
  await call(instance, '/delegation', 'POST', { start: 'ask', max: 5, workers: [] });

  // An agent's start_sprint: asked in its chat (Unrestricted too); rejected, nothing is made; allowed, its chat is the
  // lead's parent and the record says who.
  await call(instance, '/file-protection', 'POST', { on: false });
  await assert.rejects(a.client.callTool({ name: 'ownerStart', arguments: { sprint } }), /Unknown tool/, 'the owner\'s press is not a tool');
  const made = await a.tool('new_sprint', { title: 'S3' });
  assert.match(made.sprint, /^[0-9a-f-]{36}$/, JSON.stringify(made));
  fs.writeFileSync(path.join(made.folder, 'roles.json'), roles([lead, review]));
  fs.writeFileSync(path.join(made.folder, 'roles/lead.work.md'), 'config'); fs.writeFileSync(path.join(made.folder, 'roles/review.work.md'), 'config');
  const n3 = (await rows(instance)).length;
  // S19: the sprint's scripts are in the question the user answers (a point P9 does not fire yet, so nothing runs here).
  const tidy = { name: 'tidy', command: 'node tidy.mjs', point: 'after-close' };
  fs.writeFileSync(path.join(made.folder, 'hooks.json'), JSON.stringify({ scripts: [tidy] }));
  let pending = a.tool('start_sprint', { sprint: made.sprint });
  let asked = await until(instance, (e) => e.conversation === a.conversation && e.type === 'approval', a.cursor);
  assert.match(asked.hit.data.toolCall.title, /^P9: start the sprint "S3": lead \(claude opus high\), review \(claude haiku low\)\. This is your approval of its plan/);
  assert.match(asked.hit.data.toolCall.title, /It also approves this script, which P9 will run as you, outside every agent's mode: .*tidy.*node tidy\.mjs/);
  await call(instance, `/chat/${a.conversation}/answer`, 'POST', { request: asked.hit.data.request, answer: { optionId: 'reject' } });
  assert.equal((await pending).error, 'not-allowed');
  assert.equal((await rows(instance)).length, n3, 'a rejected start made a chat');
  // The lead takes a place under Workers per chat from before the user is asked: with one place left, a second start at
  // the same time is refused.
  const s4 = await a.tool('new_sprint', { title: 'S4' });
  fs.writeFileSync(path.join(s4.folder, 'roles.json'), roles([lead])); fs.writeFileSync(path.join(s4.folder, 'roles/lead.work.md'), 'config');
  await call(instance, '/delegation', 'POST', { start: 'ask', max: 1, workers: [] });
  pending = a.tool('start_sprint', { sprint: made.sprint });
  asked = await until(instance, (e) => e.conversation === a.conversation && e.type === 'approval', asked.cursor);
  assert.equal((await a.tool('start_sprint', { sprint: s4.sprint })).error, 'too-many-chats', 'two starts at once took the last place together');
  await call(instance, `/chat/${a.conversation}/answer`, 'POST', { request: asked.hit.data.request, answer: { optionId: 'allow' } });
  const byTool = await pending;
  assert.equal(byTool.error, undefined, JSON.stringify(byTool));
  assert.equal(byTool.started.by, a.conversation);
  assert.deepEqual(byTool.started.scripts, [{ ...tidy, blocking: false }]);
  // hooks.json changed while the user was asked: the yes was to another file, so nothing is approved or run.
  pending = a.tool('start_sprint', { sprint: made.sprint });
  asked = await until(instance, (e) => e.conversation === a.conversation && e.type === 'approval', asked.cursor);
  fs.writeFileSync(path.join(made.folder, 'hooks.json'), JSON.stringify({ scripts: [{ name: 'swap', command: 'node swap.mjs', point: 'before-new-worker', blocking: true }] }));
  await call(instance, `/chat/${a.conversation}/answer`, 'POST', { request: asked.hit.data.request, answer: { optionId: 'allow' } });
  assert.equal((await pending).error, 'scripts-changed');
  const scr = await a.tool('sprint_scripts', { sprint: made.sprint });
  assert.deepEqual([scr.approved?.scripts.map((x) => x.name), scr.file.scripts?.map((x) => x.name), scr.pending], [['tidy'], ['swap'], true], JSON.stringify(scr));
  fs.writeFileSync(path.join(made.folder, 'hooks.json'), JSON.stringify({ scripts: [tidy] }));
  console.log('PASS S19 agent start: the question lists the scripts; a file changed during the question is refused');
  assert.equal((await rows(instance)).find((r) => r.id === made.sprint).parent, a.conversation);
  for (const [row, c] of [[lead, byTool.chats[0]], [review, byTool.chats[1]]]) assert.match(await config(instance, c.chat), new RegExp(`^config:model=${row.model},effort=${row.effort},`));
  // Delegation turned Off while the user is asked: Allow makes nothing.
  await call(instance, '/delegation', 'POST', { start: 'ask', max: 5, workers: [] });
  const n4 = (await rows(instance)).length;
  pending = a.tool('start_sprint', { sprint: s4.sprint });
  asked = await until(instance, (e) => e.conversation === a.conversation && e.type === 'approval', asked.cursor);
  // O96: a worker's turn ending meanwhile sends a P9 note ('[p9] ... ended its turn', O188: a note event, not a prompt); it is not the user's answer, so the approval stays open.
  await call(instance, `/chat/${byTool.chats[0].chat}/prompt`, 'POST', { text: 'x' });
  await until(instance, (e) => e.conversation === a.conversation && ['user', 'note'].includes(e.type) && e.data?.text?.startsWith('[p9]'), asked.cursor);
  await call(instance, '/delegation', 'POST', { start: 'off', max: 5, workers: [] });
  await call(instance, `/chat/${a.conversation}/answer`, 'POST', { request: asked.hit.data.request, answer: { optionId: 'allow' } });
  const offReply = await pending;
  assert.equal(offReply.error, 'delegate-off', 'Delegation turned Off while the user was asked: ' + JSON.stringify(offReply) + ' events in a: ' + JSON.stringify((await call(instance, `/chat/events?after=${asked.cursor}&only=${a.conversation}`)).body.events.map((e) => [e.type, e.data?.text?.slice(0, 80) ?? e.data?.answer ?? null])));
  assert.equal((await rows(instance)).length, n4);
  // Workers per chat lowered while the user is asked (one child running, 2 -> 1): Allow makes nothing.
  await call(instance, '/delegation', 'POST', { start: 'ask', max: 2, workers: [] });
  pending = a.tool('start_sprint', { sprint: s4.sprint });
  asked = await until(instance, (e) => e.conversation === a.conversation && e.type === 'approval', asked.cursor);
  await call(instance, '/delegation', 'POST', { start: 'ask', max: 1, workers: [] });
  await call(instance, `/chat/${a.conversation}/answer`, 'POST', { request: asked.hit.data.request, answer: { optionId: 'allow' } });
  assert.equal((await pending).error, 'too-many-chats', 'a limit lowered while the user was asked still made the lead');
  assert.equal((await rows(instance)).length, n4);
  await call(instance, '/delegation', 'POST', { start: 'agent', max: 5, workers: [] });
  // 3 levels deep: a chat 2 deep cannot start a sprint with chats under its lead (they would be 4 deep).
  const k1 = await a.tool('open_chat', { text: 'mcp', title: 'k1', key: 'k1' });
  const c1 = await attach(t, instance, k1.chat);
  const k2 = await c1.tool('open_chat', { text: 'mcp', title: 'k2', key: 'k2' });
  const c2 = await attach(t, instance, k2.chat);
  const s6 = await c2.tool('new_sprint', { title: 'S6' });
  assert.match(s6.sprint ?? '', /^[0-9a-f-]{36}$/, JSON.stringify(s6));
  fs.writeFileSync(path.join(s6.folder, 'roles.json'), roles([lead, review]));
  const n6 = (await rows(instance)).length;
  assert.equal((await c2.tool('start_sprint', { sprint: s6.sprint })).error, 'too-many-chats', 'a lead\'s chats would be 4 levels deep');
  assert.equal((await rows(instance)).length, n6);
  // A chat outside the project does not see the sprint.
  const out = await agent(t, instance, undefined);
  assert.equal((await out.tool('start_sprint', { sprint: s2.sprint })).error, 'unknown-sprint');
  console.log('PASS Start sprint: refusals by role and field with no chat, every chat on its row (lead, review, codex and claude workers), press again keeps all, halfway then rest, an undelivered first message sent on the next press, claude row never on a profile, record ' + plan.slice(0, 12) + ', start_sprint asked with its place held, Off and a lower limit after the ask, 3 levels');
});

test('Sprint roles: a worker the lead opens for a role starts on its roles.json row and is named for it, whatever Settings > Delegation says; a value the row does not start is refused by field', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const project = (await call(instance, '/projects', 'POST', { name: 'Fresh', work: { kind: 'new', parent: '', name: 'fresh' } })).body.project.id;
  await call(instance, '/file-protection', 'POST', { on: false });
  // P9 learns Claude's model and effort lists when it first runs.
  const first = (await call(instance, '/chat', 'POST', { provider: 'claude' })).body.conversation;
  await call(instance, `/chat/${first}/prompt`, 'POST', { text: 'config' });
  await config(instance, first);
  const s = (await call(instance, '/projects/' + project + '/sprints', 'POST', { title: 'Roles' })).body;
  const write = (name, body) => fs.writeFileSync(path.join(s.folder, name), body);
  const lead = { key: 'lead', provider: 'claude', model: 'opus', effort: 'high' };
  write('roles.json', JSON.stringify({ roles: [lead] })); write('roles/lead.work.md', 'mcp');
  const press = await call(instance, `/sprints/${s.sprint}/start`, 'POST', {});
  assert.equal(press.status, 200, JSON.stringify(press.body));
  const L = await attach(t, instance, s.sprint);
  // Every Settings > Delegation row on opus/high; the plan's roles on haiku/low.
  const opus = { agent: 'claude', model: 'opus', effort: 'high' };
  assert.equal((await call(instance, '/delegation', 'POST', { start: 'agent', max: 5, workers: Array(5).fill(opus) })).status, 200);
  write('roles.json', JSON.stringify({ roles: [lead, { key: 'phone', provider: 'claude', model: 'haiku', effort: 'low' }, { key: 'window', provider: 'claude', model: 'haiku', effort: 'low' }] }));
  const count = (await rows(instance)).length;
  // A value the role's row does not start: refused by field, whatever Delegation allows; nothing made.
  const wide = await L.tool('open_chat', { text: 'config', key: 'window', model: 'opus' });
  assert.deepEqual([wide.error, wide.role, wide.field], ['role-refused', 'window', 'model'], JSON.stringify(wide));
  const low = await L.tool('open_chat', { text: 'config', key: 'window', effort: 'high' });
  assert.deepEqual([low.error, low.field], ['role-refused', 'effort'], JSON.stringify(low));
  assert.equal((await rows(instance)).length, count, 'a refused role made a chat');
  // The role's row decides and names the chat, even with another title given.
  const made = await L.tool('open_chat', { text: 'config', key: 'phone', title: 'Something else' });
  assert.equal(made.error, undefined, JSON.stringify(made));
  assert.match(await config(instance, made.chat), /^config:model=haiku,effort=low,/, 'the role\'s worker did not start on its roles.json row');
  assert.equal((await rows(instance)).find((r) => r.id === made.chat).title, 'phone', 'the role\'s worker is not named for its role');
  // Its own values named are what the row starts: allowed.
  const same = await L.tool('open_chat', { text: 'config', key: 'window', model: 'haiku', effort: 'low' });
  assert.match(await config(instance, same.chat), /^config:model=haiku,effort=low,/);
  // FIX1 (#225): a role on a provider profile is named as its row writes it, profile:<id>; another profile, or another
  // agent, is refused by field and makes nothing.
  const post = async (name) => (await call(instance, '/profiles', 'POST', { name, baseUrl: 'https://models.example.test/api/', models: ['glm-5.3'], key: 'sk-profile-test-0f3a9c71d2e84b56' })).body.profile.id;
  const mineId = await post('Far Cloud'), otherId = await post('Other Cloud');
  write('roles.json', JSON.stringify({ roles: [lead, { key: 'far', provider: 'profile:' + mineId, model: 'glm-5.3', effort: 'low' }] }));
  const atFar = (await rows(instance)).length;
  const foreign = await L.tool('open_chat', { text: 'config', key: 'far', provider: 'profile:' + otherId });
  assert.deepEqual([foreign.error, foreign.role, foreign.field], ['role-refused', 'far', 'provider'], JSON.stringify(foreign));
  assert.match(foreign.detail, new RegExp('row starts \\(profile:' + mineId + '\\)'), foreign.detail);
  assert.equal((await L.tool('open_chat', { text: 'config', key: 'far', provider: 'codex' })).field, 'provider');
  assert.equal((await rows(instance)).length, atFar, 'a role named on another profile made a chat');
  const farRole = await L.tool('open_chat', { text: 'config', key: 'far', provider: 'profile:' + mineId, model: 'glm-5.3' });
  assert.equal(farRole.error, undefined, 'a profile role named as its own row writes it was refused: ' + JSON.stringify(farRole));
  assert.equal((await rows(instance)).find((r) => r.id === farRole.chat).title, 'far');
  await L.tool('wait_chat', { chat: farRole.chat });
  assert.equal((await L.tool('stop_chat', { chat: farRole.chat, close: true })).error, undefined);
  console.log('PASS Sprint roles FIX1: a profile role opened when named profile:<its id>; another profile and another agent were refused on provider with no chat');
  // Workers come only from role rows: no key, a key with no row, a row P9 cannot start, a broken or missing roles.json
  // are refused before anything is made, and take no worker place (the lead has one place left; a role row takes it).
  assert.equal((await call(instance, '/delegation', 'POST', { start: 'agent', max: 3, workers: Array(3).fill(opus) })).status, 200);
  const before = (await rows(instance)).length;
  const keyless = await L.tool('open_chat', { text: 'config' });
  assert.deepEqual([keyless.error, keyless.field], ['role-refused', 'key'], JSON.stringify(keyless));
  const late = await L.tool('open_chat', { text: 'config', key: 'late' });
  assert.deepEqual([late.error, late.role, late.field], ['role-refused', 'late', 'key'], JSON.stringify(late));
  assert.match(late.detail, /role row first: add it in Sprint Setup/);
  const roles = [lead, { key: 'phone', provider: 'claude', model: 'haiku', effort: 'low' }, { key: 'window', provider: 'claude', model: 'haiku', effort: 'low' }];
  write('roles.json', JSON.stringify({ roles: [...roles, { key: 'bad', provider: 'claude', model: 'nope', effort: 'low' }] }));
  const bad = await L.tool('open_chat', { text: 'config', key: 'bad' });
  assert.deepEqual([bad.error, bad.role, bad.field], ['role-refused', 'bad', 'model'], JSON.stringify(bad));
  write('roles.json', '{ "roles": [');
  const broken = await L.tool('open_chat', { text: 'config', key: 'late' });
  assert.deepEqual([broken.error, broken.field], ['role-refused', 'roles.json'], JSON.stringify(broken));
  fs.unlinkSync(path.join(s.folder, 'roles.json'));
  const missing = await L.tool('open_chat', { text: 'config', key: 'late' });
  assert.deepEqual([missing.error, missing.field], ['role-refused', 'roles.json'], JSON.stringify(missing));
  assert.match(missing.detail, /roles\.json in .* is missing/);
  assert.equal((await rows(instance)).length, before, 'a refused sprint worker made a chat');
  write('roles.json', JSON.stringify({ roles: [...roles, { key: 'late', provider: 'claude', model: 'haiku', effort: 'low' }] }));
  const added = await L.tool('open_chat', { text: 'config', key: 'late' });
  assert.equal(added.error, undefined, 'a refusal took a worker place: ' + JSON.stringify(added));
  assert.match(await config(instance, added.chat), /^config:model=haiku,effort=low,/);
  // A plain chat (no sprint made by New sprint, no roles.json) is unchanged: its keyed worker starts on its Delegation row.
  await call(instance, `/chat/${first}/prompt`, 'POST', { text: 'mcp' });
  const plain = await (await attach(t, instance, first)).tool('open_chat', { text: 'config', key: 'late' });
  assert.equal(plain.error, undefined, JSON.stringify(plain));
  assert.match(await config(instance, plain.chat), /^config:model=opus,effort=high,/, 'a plain chat\'s worker did not start on its Delegation row');
  console.log('PASS Sprint roles: phone and window started on their roles.json row (haiku/low) under Delegation rows of opus/high, named for the role; opus and high for window were refused by field with nothing made; no key, a key with no row, a bad row, a broken and a missing roles.json were refused with nothing made and no place taken; a plain chat\'s worker took its Delegation row');
});

// O174: a sprint's chats are not Delegation's. Off, Workers per chat and the Delegation rows do not apply to Start sprint
// or to a sprint lead's workers (only the runaway guards do); a plain chat's workers keep all three.
test('Sprint O174: Start and a sprint lead\'s workers go ahead under Delegation Off and past Workers per chat, on their role rows; a plain chat beside it keeps Off, its limit and its rows', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const project = (await call(instance, '/projects', 'POST', { name: 'Fresh', work: { kind: 'new', parent: '', name: 'fresh' } })).body.project.id;
  await call(instance, '/file-protection', 'POST', { on: false });
  const first = (await call(instance, '/chat', 'POST', { provider: 'claude' })).body.conversation;
  await call(instance, `/chat/${first}/prompt`, 'POST', { text: 'config' });
  await config(instance, first);
  const s = (await call(instance, '/projects/' + project + '/sprints', 'POST', { title: 'Beside' })).body;
  const write = (name, body) => fs.writeFileSync(path.join(s.folder, name), body);
  const row = (key) => ({ key, provider: 'claude', model: 'haiku', effort: 'low' });
  write('roles.json', JSON.stringify({ roles: [row('lead'), row('review')] })); write('roles/lead.work.md', 'mcp');
  // Delegation Off: the user's press still starts the sprint, every chat on its row.
  assert.equal((await call(instance, '/delegation', 'POST', { start: 'off', max: 1, workers: [] })).status, 200);
  const press = await call(instance, `/sprints/${s.sprint}/start`, 'POST', {});
  assert.equal(press.status, 200, 'Start was refused under Delegation Off: ' + JSON.stringify(press.body));
  assert.deepEqual(press.body.chats.map((c) => [c.key, c.model, c.effort, c.existing]), [['lead', 'haiku', 'low', false], ['review', 'haiku', 'low', false]]);
  const L = await attach(t, instance, s.sprint);
  write('roles.json', JSON.stringify({ roles: ['lead', 'review', 'w1', 'w2', 'w3'].map(row) }));
  // A role added mid-sprint, opened by the lead while Off.
  const w1 = await L.tool('open_chat', { text: 'config', key: 'w1' });
  assert.equal(w1.error, undefined, 'Off refused the sprint lead\'s worker: ' + JSON.stringify(w1));
  assert.match(await config(instance, w1.chat), /^config:model=haiku,effort=low,/);
  // Workers per chat 1 on an opus/high row: the lead (review and w1 already running) still opens w2 on its own row.
  const opus = { agent: 'claude', model: 'opus', effort: 'high' };
  assert.equal((await call(instance, '/delegation', 'POST', { start: 'agent', max: 1, workers: [opus] })).status, 200);
  const w2 = await L.tool('open_chat', { text: 'config', key: 'w2' });
  assert.equal(w2.error, undefined, 'Workers per chat refused the sprint lead\'s worker: ' + JSON.stringify(w2));
  assert.match(await config(instance, w2.chat), /^config:model=haiku,effort=low,/, 'the sprint\'s worker took a Delegation row');
  // A plain chat beside it: its worker takes Delegation's row; a second one is over its Workers per chat.
  await call(instance, `/chat/${first}/prompt`, 'POST', { text: 'mcp' });
  const P = await attach(t, instance, first);
  const d1 = await P.tool('open_chat', { text: 'config' });
  assert.equal(d1.error, undefined, JSON.stringify(d1));
  assert.match(await config(instance, d1.chat), /^config:model=opus,effort=high,/, 'the plain chat\'s worker did not take its Delegation row');
  const d2 = await P.tool('open_chat', { text: 'config' });
  assert.equal(d2.error, 'too-many-chats', 'a plain chat passed Workers per chat: ' + JSON.stringify(d2));
  // Off again: the plain chat is refused, the sprint lead is not.
  assert.equal((await P.tool('stop_chat', { chat: d1.chat, close: true })).error, undefined);
  assert.equal((await call(instance, '/delegation', 'POST', { start: 'off', max: 1, workers: [opus] })).status, 200);
  assert.equal((await P.tool('open_chat', { text: 'config' })).error, 'delegate-off');
  const w3 = await L.tool('open_chat', { text: 'config', key: 'w3' });
  assert.equal(w3.error, undefined, 'Off refused the sprint lead\'s worker: ' + JSON.stringify(w3));
  console.log('PASS Sprint O174: Start and w1 under Off, w2 past Workers per chat 1, all on haiku/low; the plain chat took opus/high, its second worker was too-many-chats and Off refused it; w3 opened under Off');
});

// O174 FIX1: a sprint lead is a chat with a Start record, which only Start writes (the user's press, or the user's yes to
// an agent's start_sprint). A roles.json is a file an agent can write: set_rules makes the chat's own sprint folder and
// sprint_setup_save writes the file there, asking nobody. A plain chat, and a worker, that write their own are still
// Delegation's: Off refuses them, Workers per chat counts them. The file only tightens: workers from its rows.
test('Sprint O174 FIX1: a plain chat or a worker that writes its own roles.json is not a sprint lead: Off and Workers per chat still refuse it', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  await call(instance, '/file-protection', 'POST', { on: false });
  const first = (await call(instance, '/chat', 'POST', { provider: 'claude' })).body.conversation;
  await call(instance, `/chat/${first}/prompt`, 'POST', { text: 'config' });
  await config(instance, first);
  await call(instance, `/chat/${first}/prompt`, 'POST', { text: 'mcp' });
  const P = await attach(t, instance, first);
  const row = (key) => ({ key, provider: 'claude', model: 'haiku', effort: 'low' });
  const opus = { agent: 'claude', model: 'opus', effort: 'high' };
  const promote = async (A) => {
    assert.equal((await A.tool('set_rules', { rules: 'Mine.' })).error, undefined);
    const saved = await A.tool('sprint_setup_save', { name: 'roles.json', text: JSON.stringify({ roles: ['lead', 'w1', 'w2'].map(row) }), hash: '' });
    assert.equal(saved.error, undefined, 'the chat could not write its own roles.json: ' + JSON.stringify(saved));
  };
  await promote(P);
  assert.equal((await call(instance, '/delegation', 'POST', { start: 'off', max: 1, workers: [opus] })).status, 200);
  const off = await P.tool('open_chat', { text: 'config', key: 'w1' });
  assert.equal(off.error, 'delegate-off', 'a plain chat\'s own roles.json made it a sprint lead under Off: ' + JSON.stringify(off));
  assert.equal((await call(instance, '/delegation', 'POST', { start: 'agent', max: 1, workers: [opus] })).status, 200);
  // The file still narrows: no key, no worker.
  assert.equal((await P.tool('open_chat', { text: 'config' })).error, 'role-refused');
  const d1 = await P.tool('open_chat', { text: 'mcp', key: 'w1' });
  assert.equal(d1.error, undefined, JSON.stringify(d1));
  const d2 = await P.tool('open_chat', { text: 'config', key: 'w2' });
  assert.equal(d2.error, 'too-many-chats', 'a plain chat\'s own roles.json took it past Workers per chat: ' + JSON.stringify(d2));
  assert.match(d2.detail, /Settings > Delegation/);
  // A worker that writes its own: the same.
  const W = await attach(t, instance, d1.chat);
  await promote(W);
  assert.equal((await call(instance, '/delegation', 'POST', { start: 'off', max: 1, workers: [opus] })).status, 200);
  const woff = await W.tool('open_chat', { text: 'config', key: 'w1' });
  assert.equal(woff.error, 'delegate-off', 'a worker\'s own roles.json made it a sprint lead under Off: ' + JSON.stringify(woff));
  assert.equal((await call(instance, '/delegation', 'POST', { start: 'agent', max: 1, workers: [opus] })).status, 200);
  const k1 = await W.tool('open_chat', { text: 'config', key: 'w1' });
  assert.equal(k1.error, undefined, JSON.stringify(k1));
  const k2 = await W.tool('open_chat', { text: 'config', key: 'w2' });
  assert.equal(k2.error, 'too-many-chats', 'a worker\'s own roles.json took it past Workers per chat: ' + JSON.stringify(k2));
  console.log('PASS Sprint O174 FIX1: own roles.json, plain chat and worker: Off refused, Workers per chat refused the second, no key role-refused');
});

// O174 FIX1: what a sprint lead skips is Delegation; the runaway guards still hold on that path: 20 running workers
// (two calls at once included: each holds a place while it starts) and 3 levels deep.
test('Sprint O174 FIX1: a sprint lead past Delegation still stops at 20 running workers, two calls at once included, and at 3 levels deep', { timeout: 300000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const project = (await call(instance, '/projects', 'POST', { name: 'Fresh', work: { kind: 'new', parent: '', name: 'fresh' } })).body.project.id;
  await call(instance, '/file-protection', 'POST', { on: false });
  const first = (await call(instance, '/chat', 'POST', { provider: 'claude' })).body.conversation;
  await call(instance, `/chat/${first}/prompt`, 'POST', { text: 'config' });
  await config(instance, first);
  const row = (key) => ({ key, provider: 'claude', model: 'haiku', effort: 'low' });
  const opus = { agent: 'claude', model: 'opus', effort: 'high' };
  // 20 running: the press makes 19 under the lead (Off, Workers per chat 1: neither applies to the sprint).
  const s = (await call(instance, '/projects/' + project + '/sprints', 'POST', { title: 'Wide' })).body;
  const write = (name, body) => fs.writeFileSync(path.join(s.folder, name), body);
  const keys = Array.from({ length: 19 }, (_, i) => 'x' + i);
  // Each role but review gets its own worker folder, cloned from the plan's repository.
  const repo = path.join(instance.workspace, 'repo');
  fs.mkdirSync(repo); g(repo, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); g(repo, 'add', 'a.txt'); g(repo, 'commit', '-qm', 'a');
  write('roles.json', JSON.stringify({ folder: 'repo', roles: ['lead', ...keys].map(row) })); write('roles/lead.work.md', 'mcp');
  assert.equal((await call(instance, '/delegation', 'POST', { start: 'off', max: 1, workers: [opus] })).status, 200);
  // 19 worker folders take longer than call's 10 s.
  const press = await http({ socketPath: instance.credentials.socketPath, route: `/sprints/${s.sprint}/start`, method: 'POST', timeout: 180000,
    headers: { ...authenticated(instance.credentials), 'content-type': 'application/json' }, body: '{}' }).then((r) => ({ status: r.status, body: JSON.parse(r.text) }));
  assert.equal(press.status, 200, JSON.stringify(press.body));
  assert.equal(press.body.chats.length, 20);
  const L = await attach(t, instance, s.sprint);
  write('roles.json', JSON.stringify({ folder: 'repo', roles: ['lead', ...keys, 'y0', 'y1', 'y2'].map(row) }));
  // Two at once with 19 running: one place is left, so exactly one starts; the other is refused while the first holds it.
  const both = await Promise.all([L.tool('open_chat', { text: 'config', key: 'y0' }), L.tool('open_chat', { text: 'config', key: 'y1' })]);
  assert.deepEqual(both.map((r) => r.error ?? 'ok').sort(), ['ok', 'too-many-chats'], 'two calls at once passed 20: ' + JSON.stringify(both));
  assert.match(both.find((r) => r.error).detail, /At most 20 running workers per sprint chat, 3 levels deep/);
  const third = await L.tool('open_chat', { text: 'config', key: 'y2' });
  assert.equal(third.error, 'too-many-chats', 'a 21st worker started: ' + JSON.stringify(third));
  assert.equal((await rows(instance)).filter((c) => c.parent === s.sprint && !['stopped', 'moved'].includes(c.state)).length, 20);
  // 3 deep: a chain of plain workers, then the user's Start press makes the one at depth 3 a sprint lead.
  assert.equal((await call(instance, '/delegation', 'POST', { start: 'agent', max: 5, workers: Array(5).fill(opus) })).status, 200);
  // In the project, as a sprint's chats are.
  let at = await agent(t, instance, project), id;
  for (let depth = 1; depth <= 3; depth += 1) {
    const made = await at.tool('open_chat', { text: 'mcp' });
    assert.equal(made.error, undefined, 'depth ' + depth + ': ' + JSON.stringify(made));
    id = made.chat; at = await attach(t, instance, id);
  }
  assert.equal((await at.tool('set_rules', { rules: 'Deep.' })).error, undefined);
  assert.equal((await at.tool('sprint_setup_save', { name: 'roles.json', text: JSON.stringify({ roles: [row('lead')] }), hash: '' })).error, undefined);
  const deep = await call(instance, `/sprints/${id}/start`, 'POST', {});
  assert.equal(deep.status, 200, JSON.stringify(deep.body));
  const files = (await at.tool('sprint_setup')).files;
  assert.equal((await at.tool('sprint_setup_save', { name: 'roles.json', text: JSON.stringify({ roles: ['lead', 'z'].map(row) }), hash: files.find((f) => f.name === 'roles.json').hash })).error, undefined);
  // Off: a plain chat would get delegate-off; this lead skips Off and stops at the depth guard.
  assert.equal((await call(instance, '/delegation', 'POST', { start: 'off', max: 5, workers: Array(5).fill(opus) })).status, 200);
  const tooDeep = await at.tool('open_chat', { text: 'config', key: 'z' });
  assert.equal(tooDeep.error, 'too-many-chats', 'a sprint lead 3 deep started a worker: ' + JSON.stringify(tooDeep));
  console.log('PASS Sprint O174 FIX1: 20 running held (two at once: one started, one refused; a 21st refused) and a lead 3 deep refused under Off');
});

// O174 (found in its FIX1): a chat with no project can be a lead (set_rules makes its sprint folder). The user's
// Start press on it starts it as one in a project would, never a 500 from reading a New sprint record it never had.
test('Sprint O174 no project: a Start press on a chat with no project but its own roles.json starts it, not a 500', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  await call(instance, '/file-protection', 'POST', { on: false });
  const first = (await call(instance, '/chat', 'POST', { provider: 'claude' })).body.conversation;
  await call(instance, `/chat/${first}/prompt`, 'POST', { text: 'config' });
  await config(instance, first);
  await call(instance, `/chat/${first}/prompt`, 'POST', { text: 'mcp' });
  const P = await attach(t, instance, first);
  assert.equal((await rows(instance)).find((c) => c.id === first).project ?? null, null, 'the chat has a project');
  const row = (key) => ({ key, provider: 'claude', model: 'haiku', effort: 'low' });
  assert.equal((await P.tool('set_rules', { rules: 'Mine.' })).error, undefined);
  assert.equal((await P.tool('sprint_setup_save', { name: 'roles.json', text: JSON.stringify({ roles: [row('lead')] }), hash: '' })).error, undefined);
  const press = await call(instance, `/sprints/${first}/start`, 'POST', {});
  assert.notEqual(press.status, 500, 'a Start press on a chat with no project: ' + JSON.stringify(press.body));
  assert.equal(press.status, 200, JSON.stringify(press.body));
  assert.equal(press.body.error, undefined);
  // Started: a second press is the same sprint again, and an unknown id is still refused by name.
  assert.equal((await call(instance, `/sprints/${first}/start`, 'POST', {})).status, 200);
  const unknown = await call(instance, `/sprints/00000000-0000-4000-8000-000000000000/start`, 'POST', {});
  assert.deepEqual([unknown.status, unknown.body.error], [404, 'unknown-sprint']);
  console.log('PASS Sprint O174 no project: Start press on a no-project chat starts it (200), a second press too, unknown id 404');
});

test('O137 FIX1: under Unrestricted a role whose first message failed is sent on the next Start in Auto, or in the Settings default mode, not in its Bypass lead\'s mode', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async ({ workspace }) => { fs.writeFileSync(path.join(workspace, 'profile.log'), ''); return { args: ['--acp-override', fake] }; });
  const project = (await call(instance, '/projects', 'POST', { name: 'Fresh', work: { kind: 'new', parent: '', name: 'fresh' } })).body.project.id;
  await call(instance, '/file-protection', 'POST', { on: false }); // Unrestricted
  const first = (await call(instance, '/chat', 'POST', { provider: 'claude' })).body.conversation;
  await call(instance, `/chat/${first}/prompt`, 'POST', { text: 'config' });
  await config(instance, first);
  const s = (await call(instance, '/projects/' + project + '/sprints', 'POST', { title: 'Retry' })).body;
  const write = (name, body) => fs.writeFileSync(path.join(s.folder, name), body);
  const lead = { key: 'lead', provider: 'claude', model: 'haiku', effort: 'low', mode: 'Bypass permissions' }, review = { key: 'review', provider: 'claude', model: 'haiku', effort: 'low' };
  write('roles.json', JSON.stringify({ roles: [lead] })); write('roles/lead.work.md', 'config'); write('roles/review.work.md', 'config');
  assert.equal((await call(instance, `/sprints/${s.sprint}/start`, 'POST', {})).status, 200);
  const modeOf = async (id) => (await events(instance, id)).filter((e) => e.type === 'mode').at(-1)?.data.name;
  await config(instance, s.sprint);
  assert.equal(await modeOf(s.sprint), 'Bypass permissions', 'the lead runs in Bypass');
  // The role is made, but its agent cannot start: its first message is not delivered.
  write('roles.json', JSON.stringify({ roles: [lead, review] }));
  fs.writeFileSync(path.join(instance.workspace, 'signed-out'), '');
  const stuck = await call(instance, `/sprints/${s.sprint}/start`, 'POST', {});
  fs.rmSync(path.join(instance.workspace, 'signed-out'));
  assert.equal(stuck.body.role, 'review', JSON.stringify(stuck.body));
  const kid = (await rows(instance)).find((r) => r.parent === s.sprint && r.title === 'review');
  assert.ok(kid, 'the role\'s chat was made before its agent failed to start');
  const retry = await call(instance, `/sprints/${s.sprint}/start`, 'POST', {});
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.deepEqual(retry.body.chats.map((c) => [c.key, c.sent ?? false]), [['lead', false], ['review', true]]);
  await config(instance, kid.id);
  assert.equal(await modeOf(kid.id), 'Auto', 'the retried role took its Bypass lead\'s mode, not Auto');
  console.log('PASS O137 FIX1: a role whose first message failed is sent on the next Start in Auto under Unrestricted, not its Bypass lead\'s mode');
});
