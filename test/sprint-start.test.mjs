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
  const { hit, cursor } = await until(instance, (e) => e.conversation === conversation && e.data?.content?.text?.startsWith('mcp:'));
  const [entry] = JSON.parse(hit.data.content.text.slice(4));
  const client = new Client({ name: 'p9-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env: Object.fromEntries(entry.env.map(({ name, value }) => [name, value])) }));
  t.after(() => client.close());
  const tool = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  return { conversation, client, tool, cursor };
}

test('Start sprint: one press makes every chat on exactly its row (lead included); a row P9 cannot start is refused by name before any chat; pressing again keeps what was made; the press is the approval record', { timeout: 300000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
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
  await save('roles.json', roles([lead, ...Array.from({ length: 6 }, (_, i) => ({ ...w2, key: 'x' + i }))]));
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
  assert.deepEqual({ ...listed.started, at: typeof listed.started.at }, { at: 'number', plan, by: 'owner' });
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

  // An agent's start_sprint: asked in its chat (Unrestricted too); rejected, nothing is made; allowed, its chat is the
  // lead's parent and the record says who.
  await call(instance, '/file-protection', 'POST', { on: false });
  await assert.rejects(a.client.callTool({ name: 'ownerStart', arguments: { sprint } }), /Unknown tool/, 'the owner\'s press is not a tool');
  const made = await a.tool('new_sprint', { title: 'S3' });
  assert.match(made.sprint, /^[0-9a-f-]{36}$/, JSON.stringify(made));
  fs.writeFileSync(path.join(made.folder, 'roles.json'), roles([lead, review]));
  fs.writeFileSync(path.join(made.folder, 'roles/lead.work.md'), 'config'); fs.writeFileSync(path.join(made.folder, 'roles/review.work.md'), 'config');
  const n3 = (await rows(instance)).length;
  let pending = a.tool('start_sprint', { sprint: made.sprint });
  let asked = await until(instance, (e) => e.conversation === a.conversation && e.type === 'approval', a.cursor);
  assert.match(asked.hit.data.toolCall.title, /^P9: start the sprint "S3": lead \(claude opus high\), review \(claude haiku low\)\. This is your approval of its plan/);
  await call(instance, `/chat/${a.conversation}/answer`, 'POST', { request: asked.hit.data.request, answer: { optionId: 'reject' } });
  assert.equal((await pending).error, 'not-allowed');
  assert.equal((await rows(instance)).length, n3, 'a rejected start made a chat');
  pending = a.tool('start_sprint', { sprint: made.sprint });
  asked = await until(instance, (e) => e.conversation === a.conversation && e.type === 'approval', asked.cursor);
  await call(instance, `/chat/${a.conversation}/answer`, 'POST', { request: asked.hit.data.request, answer: { optionId: 'allow' } });
  const byTool = await pending;
  assert.equal(byTool.error, undefined, JSON.stringify(byTool));
  assert.equal(byTool.started.by, a.conversation);
  assert.equal((await rows(instance)).find((r) => r.id === made.sprint).parent, a.conversation);
  for (const [row, c] of [[lead, byTool.chats[0]], [review, byTool.chats[1]]]) assert.match(await config(instance, c.chat), new RegExp(`^config:model=${row.model},effort=${row.effort},`));
  // A chat outside the project does not see the sprint.
  const out = await agent(t, instance, undefined);
  assert.equal((await out.tool('start_sprint', { sprint: s2.sprint })).error, 'unknown-sprint');
  console.log('PASS Start sprint: refusals by role and field with no chat, every chat on its row (lead, review, codex and claude workers), press again keeps all, halfway then rest, record ' + plan.slice(0, 12) + ', start_sprint asked');
});
