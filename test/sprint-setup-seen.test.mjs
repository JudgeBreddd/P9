import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { daemon, http, authenticated, root } from './helpers.mjs';
import { Client } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { hashOf } from '../apps/server/sprint-files.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const call = (instance, route, method = 'GET', body) => http({ socketPath: instance.credentials.socketPath, route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  .then((result) => ({ ...result, body: result.text ? JSON.parse(result.text) : null }));
const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
const events = async (instance, id) => (await call(instance, '/chat/events?after=0&only=' + id)).body.events;
const settle = async (check, what) => { for (let i = 0; i < 150; i += 1) { const got = await check(); if (got) return got; await new Promise((r) => setTimeout(r, 200)); } assert.fail('timed out: ' + what); };
async function attach(t, instance, conversation) {
  const hit = await settle(async () => (await events(instance, conversation)).find((e) => e.data?.content?.text?.startsWith('mcp:')), 'mcp reply from ' + conversation);
  const [entry] = JSON.parse(hit.data.content.text.slice(4));
  const client = new Client({ name: 'p9-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env: Object.fromEntries(entry.env.map(({ name, value }) => [name, value])) }));
  t.after(() => client.close());
  return async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
}
import { randomUUID } from 'node:crypto';

// H2 part B (Sprint Setup row, "each field the agent filled is marked as the agent's until the owner has seen it"): a
// Setup file shows "Written by <writer> · not seen" (the project's sprint files: unseen) until the owner has seen that
// text: the owner's own save, the Seen press (POST /sprints/:id/seen, refused for a file changed since), Start's approval,
// or New sprint's own files.
test('Sprint Setup H2 part B: an agent tool write marks a Setup file, the owner save and a Seen press clear it, a later agent write marks it again', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  await call(instance, '/delegation', 'POST', { start: 'agent', max: 20, workers: [] });
  await call(instance, '/file-protection', 'POST', { on: false });
  const ws = instance.workspace, repo = path.join(ws, 'repo');
  fs.mkdirSync(repo); g(repo, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); g(repo, 'add', 'a.txt'); g(repo, 'commit', '-qm', 'a');
  const first = (await call(instance, '/chat', 'POST', { provider: 'claude' })).body.conversation;
  await call(instance, `/chat/${first}/prompt`, 'POST', { text: 'config' });
  await settle(async () => (await events(instance, first)).some((e) => e.data?.content?.text?.startsWith('config:')), 'config reply');
  const project = (await call(instance, '/projects', 'POST', { name: 'Fresh', work: { kind: 'new', parent: '', name: 'fresh' } })).body.project.id;
  const planner = (await call(instance, '/chat', 'POST', { provider: 'claude', project })).body.conversation;
  await call(instance, `/chat/${planner}/prompt`, 'POST', { text: 'mcp' });
  const agent = await attach(t, instance, planner);

  const prep = await call(instance, '/projects/' + project + '/sprints', 'POST', { title: 'S1' });
  assert.equal(prep.status, 201, JSON.stringify(prep.body));
  const sprint = prep.body.sprint, file = (name) => path.join(prep.body.folder, name), hashIn = (name) => hashOf(fs.readFileSync(file(name), 'utf8'));
  const marks = async () => Object.fromEntries((await call(instance, '/projects/' + project)).body.project.sprints.find((s) => s.lead === sprint).files.filter((f) => f.unseen).map((f) => [f.name, f.unseen]));
  const save = async (name, text) => { const got = await call(instance, '/projects/' + project + '/sprint-file', 'POST', { lead: sprint, name, text, hash: fs.existsSync(file(name)) ? hashIn(name) : '' }); assert.equal(got.status, 200, name + ' ' + JSON.stringify(got.body)); };
  const write = async (name, text) => { const got = await agent('sprint_setup_save', { sprint, name, text, hash: fs.existsSync(file(name)) ? hashIn(name) : '' }); assert.equal(got.error, undefined, name + ' ' + JSON.stringify(got)); };
  const seen = (body, at = sprint) => call(instance, `/sprints/${at}/seen`, 'POST', body);
  const AGENT = /^an agent: claude/, plan = fs.readFileSync(file('sprint.md'), 'utf8');

  assert.deepEqual(await marks(), {}, 'the files the owner\'s New sprint made are marked');
  await write('sprint.md', '# Plan\n\nGoal: AGENT\n');
  assert.match((await marks())['sprint.md'] ?? '', AGENT, 'an agent tool write did not mark the file');
  await save('sprint.md', '# Plan\n\nGoal: OWNER\n');
  assert.deepEqual(await marks(), {}, 'the owner\'s own save left the file marked');

  await write('sprint.md', '# Plan\n\nGoal: AGENT AGAIN\n');
  assert.match((await marks())['sprint.md'] ?? '', AGENT, 'an agent write after the owner\'s save did not mark it again');
  // A Seen press for the text the owner saw before the agent's write is refused and the mark stays.
  let got = await seen({ name: 'sprint.md', hash: hashOf('# Plan\n\nGoal: OWNER\n') });
  assert.equal(got.status, 409, JSON.stringify(got.body));
  assert.equal(got.body.error, 'sprint-file-changed');
  assert.match(got.body.files.find((f) => f.name === 'sprint.md').unseen ?? '', AGENT);
  got = await seen({ name: 'sprint.md', hash: hashIn('sprint.md') });
  assert.equal(got.status, 200, JSON.stringify(got.body));
  assert.equal(got.body.files.find((f) => f.name === 'sprint.md').unseen, undefined, 'the Seen reply still marks it');
  assert.deepEqual(await marks(), {}, 'a Seen press left the file marked');
  await write('sprint.md', '# Plan\n\nGoal: AGENT THIRD\n');
  assert.match((await marks())['sprint.md'] ?? '', AGENT, 'an agent write after a Seen press did not mark it again');
  got = await seen({ name: 'sprint.md', hash: hashIn('sprint.md') });
  assert.equal(got.status, 200, JSON.stringify(got.body));

  // A role row through sprint_setup_save (roles.json) is the agent's too.
  await agent('sprint_setup_save', { sprint, role: { key: 'w1', provider: 'claude', model: 'haiku', effort: 'low' }, hash: hashIn('roles.json') }).then((r) => assert.equal(r.error, undefined, JSON.stringify(r)));
  assert.match((await marks())['roles.json'] ?? '', AGENT, 'an agent\'s role row did not mark roles.json');

  // Changed outside P9's Setup tools: marked with no agent named. Blank text is not marked.
  fs.writeFileSync(file('rules.md'), 'SHELL RULES\n');
  fs.writeFileSync(file('roles/review.work.md'), '  \n');
  fs.writeFileSync(file('sprint.md'), plan); // P9's own empty plan, as a lead's first worker makes it: nobody wrote it
  assert.deepEqual(await marks(), { 'roles.json': (await marks())['roles.json'], 'rules.md': 'someone outside P9\'s Setup tools' }, 'outside write, blank file or P9\'s empty plan');

  // Refused: other keys, a name that is not a Setup file, an unknown sprint.
  for (const [body, at, status] of [[{ name: 'rules.md', hash: hashIn('rules.md'), x: 1 }, sprint, 400], [{ name: 'rules.md' }, sprint, 400],
    [{ name: 'notes/lead.md', hash: '' }, sprint, 400], [{ name: 'hooks.log', hash: '' }, sprint, 400], [{ name: 'rules.md', hash: hashIn('rules.md') }, randomUUID(), 404]]) {
    got = await seen(body, at);
    assert.equal(got.status, status, JSON.stringify([body, got.body]));
  }
  assert.equal((await marks())['rules.md'], 'someone outside P9\'s Setup tools', 'a refused Seen press cleared the mark');

  // Start approves the text it sends: rules.md (outside) is no longer marked; the owner's roles.json save clears its own.
  await save('roles.json', JSON.stringify({ folder: 'repo', roles: ['lead', 'review'].map((key) => ({ key, provider: 'claude', model: 'haiku', effort: 'low' })) }));
  await save('roles/lead.work.md', 'mcp');
  const press = await call(instance, `/sprints/${sprint}/start`, 'POST', {});
  assert.equal(press.status, 200, JSON.stringify(press.body));
  assert.deepEqual(await marks(), {}, 'Start\'s approved text still marked');

  // A script the agent adds: hooks.json is the agent's until seen.
  got = await agent('sprint_script_save', { sprint, name: 'n', command: 'true', point: 'sprint-start' });
  assert.equal(got.error, undefined, JSON.stringify(got));
  assert.match((await marks())['hooks.json'] ?? '', AGENT, 'an agent\'s script did not mark hooks.json');
});
