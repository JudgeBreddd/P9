// O164 part (3) (Role: owner on a v line): a plan line whose id ends in v is the owner's, whatever role it names, and is never a worker's — it is absent
// from every worker's queue and ring, counts nowhere a merge is counted, and shows as the owner's own queue and ring
// in the status the page and sprint_status share. The owner's click closes it: P9 records the click (no merge involved,
// no review), and the plan's box stays a say-so. Real daemon, real routes, the fake agent for the lead and worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { daemon, http, authenticated, root } from './helpers.mjs';
import { statusHtml, closePress } from '../apps/web/src/sprint-view.mjs';
import { projectRoutes } from '../apps/desktop/project-routes.mjs';

const call = (instance, route, method = 'GET', body) => http({ socketPath: instance.credentials.socketPath, route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  .then((result) => ({ ...result, body: result.text ? JSON.parse(result.text) : null }));
const esc = (v) => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

test('sprint-owner-v: a v line carries Role: owner, is the owner\'s own queue and ring, closes on the owner\'s click, and is never a worker\'s', { timeout: 240000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', path.join(root, 'test/fake-acp-agent.mjs')] }));
  await call(instance, '/delegation', 'POST', { start: 'agent', max: 5, workers: [] });
  await call(instance, '/file-protection', 'POST', { on: false });
  const events = async (id) => (await call(instance, '/chat/events?after=0&only=' + id)).body.events;
  // P9 reads a provider's model list when one of its chats opens; Start refuses a role whose model it has not seen.
  const warm = (await call(instance, '/chat', 'POST', { provider: 'claude' })).body.conversation;
  await call(instance, `/chat/${warm}/prompt`, 'POST', { text: 'config' });
  for (let i = 0; i < 150 && !(await events(warm)).some((e) => e.data?.content?.text?.startsWith('config:')); i += 1) await new Promise((r) => setTimeout(r, 200));
  // The roles' folder: a git repo in the workspace, so a worker's worktree can be cut from it.
  const repo = path.join(instance.workspace, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'a']);
  const project = (await call(instance, '/projects', 'POST', { name: 'Owned', work: { kind: 'new', parent: '', name: 'owned' } })).body.project.id;
  const s = (await call(instance, '/projects/' + project + '/sprints', 'POST', { title: 'The owner\'s line' })).body, sprint = s.sprint;
  // Three lines: two the worker owns and a v line (its id ends in v). The v line names w1 as its role on purpose: its
  // id makes it the owner's anyway, so it must not reach w1's queue.
  const plan = '# Plan\n\n- [ ] a1: the first piece. Role: w1.\n- [ ] O1v: the owner\'s own check. Role: w1.\n- [ ] a2: the second piece. Role: w1.\n';
  fs.writeFileSync(path.join(s.folder, 'sprint.md'), plan);
  fs.writeFileSync(path.join(s.folder, 'roles.json'), JSON.stringify({ folder: 'repo', roles: [{ key: 'lead', provider: 'claude', model: 'haiku', effort: 'low' }] }));
  fs.writeFileSync(path.join(s.folder, 'roles/lead.work.md'), 'mcp');
  fs.writeFileSync(path.join(s.folder, 'hooks.json'), JSON.stringify({ scripts: [] }));
  const row = async () => (await call(instance, '/projects/' + project)).body.project.sprints.find((x) => x.lead === sprint);
  const started = await call(instance, `/sprints/${sprint}/start`, 'POST', { hooks: (await row()).files.find((f) => f.name === 'hooks.json').hash });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  // The worker's role is added after Start (as the close flow does), so its chat is opened by the lead, not by Start.
  fs.writeFileSync(path.join(s.folder, 'roles.json'), JSON.stringify({ folder: 'repo', roles: [{ key: 'lead', provider: 'claude', model: 'haiku', effort: 'low' }, { key: 'w1', provider: 'claude', model: 'haiku', effort: 'low' }] }));

  // One worker chat, so its queue and ring exist for the v line to stay out of.
  let hit; for (let i = 0; i < 150 && !hit; i += 1) { hit = (await events(sprint)).find((e) => e.data?.content?.text?.startsWith('mcp:')); if (!hit) await new Promise((r) => setTimeout(r, 200)); }
  assert.ok(hit, 'no mcp reply from the lead');
  const { Client } = await import('../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
  const { StdioClientTransport } = await import('../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
  const open = async (conversation) => { let entry;
    for (let i = 0; i < 150 && !entry; i += 1) { entry = (await events(conversation)).find((e) => e.data?.content?.text?.startsWith('mcp:')); if (!entry) await new Promise((r) => setTimeout(r, 200)); }
    const [one] = JSON.parse(entry.data.content.text.slice(4));
    const client = new Client({ name: 'p9-test', version: '1' });
    await client.connect(new StdioClientTransport({ command: one.command, args: one.args, env: Object.fromEntries(one.env.map(({ name, value }) => [name, value])) }));
    t.after(() => client.close());
    return { tool: async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text) }; };
  const L = await open(sprint);
  const made = await L.tool('open_chat', { text: 'mcp', key: 'w1' });
  assert.ok(made.chat && !made.error, JSON.stringify(made));
  await open(made.chat);

  // The status: the v line is the owner's own, absent from the worker's queue and from every merged count.
  const first = (await call(instance, `/sprints/${sprint}/status`)).body;
  assert.equal(first.error, undefined, JSON.stringify(first));
  const w1 = first.workers.find((w) => w.key === 'w1');
  assert.deepEqual(w1.work, { done: 0, total: 2, next: 'a1: the first piece. Role: w1.' }, 'the worker\'s queue holds its two lines, never the owner\'s');
  const listed = (await call(instance, '/chat')).body.conversations.find((c) => c.id === made.chat);
  assert.deepEqual(listed.queue, { done: 0, total: 2, items: [{ id: 'a1', text: 'a1: the first piece. Role: w1.', state: 'todo', fixes: 0, merged: false }, { id: 'a2', text: 'a2: the second piece. Role: w1.', state: 'todo', fixes: 0, merged: false }] }, 'the chat list\'s queue too: the v line appears in no worker queue');
  assert.deepEqual(first.owner, { done: 0, total: 1, items: [{ id: 'O1v', text: 'O1v: the owner\'s own check. Role: w1.', ticked: false, done: false }] }, String(JSON.stringify(first.owner)));
  assert.equal(first.items.find((i) => i.id === 'O1v').role, 'owner', 'the v line carries Role: owner');
  assert.deepEqual(first.done, { merged: 0, ticked: 0, unproven: 0, total: 2 }, 'the merged counts exclude the owner\'s line; the plan has no tick yet');

  // The render: the owner's own ring and a Close button; the plan list holds only the workers' lines.
  const page1 = statusHtml(first, esc);
  assert.match(page1, /aria-label="0 of 1 of your items closed"/);
  assert.match(page1, /Your items/);
  assert.ok(page1.includes('data-pj="spclose" data-lead="' + sprint + '" data-item="O1v"'), 'the Close button names the v line');
  assert.ok(!page1.includes('data-sv-item="O1v" data-review'), 'the owner\'s line is not drawn as a plan item');
  assert.match(page1, /0 of 2 items merged/, 'the sprint\'s ring counts only the workers\' lines');

  // The owner's click closes it: P9 records the click, and nothing else moves.
  // The press itself: the page's Close button through closePress and the window's route table, as the shell sends it.
  const routes = projectRoutes((v) => /^[0-9a-f-]{36}$/.test(v ?? ''));
  const sent = [], press = async (action, body) => { sent.push(action); const [method, route, data] = routes[action](body); return call(instance, route, method, data); };
  const button = { dataset: { lead: sprint, item: 'O1v' } };
  const said = await closePress(button, async () => assert.fail('an owner line asks no confirm'), press, () => assert.fail('an owner line is not a sprint close'));
  assert.deepEqual([said, sent], ['', ['ownerDone']], 'the press closed the line and sent only ownerDone');
  const second = (await call(instance, `/sprints/${sprint}/status`)).body;
  assert.equal(second.owner.done, 1, JSON.stringify(second.owner));
  assert.equal(second.owner.items[0].done, true);
  assert.deepEqual(second.done, { merged: 0, ticked: 0, unproven: 0, total: 2 }, 'the click changed no merged count');
  assert.equal(second.workers.find((w) => w.key === 'w1').work.total, 2, 'the worker\'s queue did not move');
  assert.equal(fs.readFileSync(path.join(s.folder, 'sprint.md'), 'utf8'), plan, 'the plan\'s box is untouched: the click is not a tick');
  const page2 = statusHtml(second, esc);
  assert.match(page2, /aria-label="1 of 1 of your items closed"/);
  assert.match(page2, /Closed by you/);
  assert.ok(!page2.includes('data-item="O1v"'), 'a closed item has no button');
  // A second click on the same line changes nothing and says so.
  assert.deepEqual([(await call(instance, `/sprints/${sprint}/owner-done`, 'POST', { item: 'O1v' })).status, 200], [200, 200]);

  // Refusals: a worker's line, a line nobody owns, an unknown sprint, a bad body.
  const theirs = await call(instance, `/sprints/${sprint}/owner-done`, 'POST', { item: 'a1' });
  assert.deepEqual([theirs.status, theirs.body.error], [422, 'not-the-owners']);
  assert.equal(await closePress({ dataset: { lead: sprint, item: 'a1' } }, null, press, null), 'Not closed: Only a plan line with Role: owner closes on your click.', 'a refused press says why');
  assert.equal((await call(instance, `/sprints/${sprint}/owner-done`, 'POST', { item: 'no-such-line' })).status, 422);
  assert.equal((await call(instance, '/sprints/00000000-0000-4000-8000-000000000000/owner-done', 'POST', { item: 'O1v' })).status, 404);
  assert.equal((await call(instance, `/sprints/${sprint}/owner-done`, 'POST', {})).status, 400);

  // A closed sprint keeps its record: a click after Close is refused and changes nothing.
  const closing = await call(instance, `/sprints/${sprint}/close`, 'POST', {});
  assert.equal(closing.status, 200, JSON.stringify(closing.body));
  const late = await call(instance, `/sprints/${sprint}/owner-done`, 'POST', { item: 'O1v' });
  assert.deepEqual([late.status, late.body.error], [409, 'sprint-closed']);

  console.log('PASS sprint-owner-v: a Role: owner line showed as the owner\'s own 0 of 1 queue and ring, stayed out of the worker\'s 0 of 2 queue and every merged count, and closed to 1 of 1 on the owner\'s click (the plan\'s box untouched, no merge involved); a worker\'s line, an unknown line and a bad body were refused');
});
