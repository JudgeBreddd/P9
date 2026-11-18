// O164 (done means merged): P9 counts a sprint item done only when its PR's head is reachable from the main line (or
// P9 recorded the merge), from P9's own evidence — never the plan's box, the OPEN-ITEMS box or the Reviewer's passed,
// which comes before the merge. Today the work queue's ring counts the Reviewer's passed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
async function attach(t, instance, conversation) {
  const events = (await call(instance, `/chat/events?after=0&only=${conversation}`)).body.events;
  const hit = events.find((e) => e.data?.content?.text?.startsWith('mcp:'));
  assert.ok(hit, 'no mcp reply from ' + conversation);
  const [entry] = JSON.parse(hit.data.content.text.slice(4));
  const client = new Client({ name: 'p9-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env: Object.fromEntries(entry.env.map(({ name, value }) => [name, value])) }));
  t.after(() => client.close());
  const tool = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  return { conversation, tool };
}

test('O164 done means merged: the worker\'s ring counts a merged item only — a passed-but-unmerged item stays 0/3, a ticked box with no merge moves nothing, the merge moves it to 1/3', { timeout: 300000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const ws = instance.workspace;
  await call(instance, '/file-protection', 'POST', { on: false });
  // P9 learns Claude's model and effort lists when it first runs: one chat before the press.
  const first = (await call(instance, '/chat', 'POST', { provider: 'claude' })).body.conversation;
  await call(instance, `/chat/${first}/prompt`, 'POST', { text: 'config' });
  for (let i = 0; i < 100; i += 1) { if ((await call(instance, `/chat/events?after=0&only=${first}`)).body.events.some((e) => e.data?.content?.text?.startsWith('config:'))) break; await new Promise((r) => setTimeout(r, 200)); }

  // A repository with a real remote, as a hosted one: the sprint's clone fetches its main line from it.
  const repo = path.join(ws, 'repo'), remote = path.join(ws, 'remote.git');
  fs.mkdirSync(repo); g(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); g(repo, 'add', 'a.txt'); g(repo, 'commit', '-qm', 'a');
  g(ws, 'init', '-q', '--bare', '-b', 'main', remote);
  g(repo, 'push', '-q', remote, 'main'); // the remote holds the main line before the sprint clones it
  g(repo, 'remote', 'add', 'origin', remote);

  const project = (await call(instance, '/projects', 'POST', { name: 'Fresh', work: { kind: 'new', parent: '', name: 'fresh' } })).body.project.id;
  const s = (await call(instance, '/projects/' + project + '/sprints', 'POST', { title: 'Merged' })).body;
  // Three worker lines and one owner's own: the owner's line is never the worker's, and is counted nowhere a merge is
  // counted (done.total holds the three worker lines) — it closes on the owner's click instead (O164 part (3)).
  const plan = (tick) => `# Plan\n\n- [${tick}] A1: the first thing. Role: w1\n- [ ] A2: the second thing. Role: w1\n- [ ] A3: the third thing. Role: w1\n- [ ] O9v: the owner's own look. Role: owner.\n`;
  fs.writeFileSync(path.join(s.folder, 'sprint.md'), plan(' '));
  const row = (key) => ({ key, provider: 'claude', model: 'haiku', effort: 'low' });
  fs.writeFileSync(path.join(s.folder, 'roles.json'), JSON.stringify({ folder: 'repo', roles: [row('lead'), row('review'), row('w1')] }));
  for (const key of ['lead', 'review', 'w1']) fs.writeFileSync(path.join(s.folder, `roles/${key}.work.md`), 'mcp');
  const press = await call(instance, `/sprints/${s.sprint}/start`, 'POST', {});
  assert.equal(press.status, 200, JSON.stringify(press.body));
  const w1 = press.body.chats.find((c) => c.key === 'w1').chat;
  const queue = async () => (await rows(instance)).find((r) => r.id === w1).queue;
  const status = async () => (await call(instance, `/sprints/${s.sprint}/status`)).body;

  // The worker's ring: three items, none done.
  let q = await queue();
  assert.deepEqual([q.done, q.total, q.items.map((i) => i.id)], [0, 3, ['A1', 'A2', 'A3']], JSON.stringify(q));

  // The worker reports its first item and the reviewer passes it: a pass is a review, not a merge.
  const folder = path.join(path.dirname(s.folder), s.sprint, 'workers', 'w1');
  fs.writeFileSync(path.join(folder, 'b.txt'), 'b\n'); g(folder, 'add', 'b.txt'); g(folder, 'commit', '-qm', 'b');
  const head = g(folder, 'rev-parse', 'HEAD');
  const W = await attach(t, instance, w1);
  const R = await attach(t, instance, press.body.chats.find((c) => c.key === 'review').chat);
  await call(instance, `/chat/${w1}/prompt`, 'POST', { text: 'late' }); // the fake agent's long turn: ready is called inside a turn
  const ready = await W.tool('ready', { commit: head, results: [{ check: 'unit', result: 'pass' }], weakest: 'none' });
  assert.ok(ready.ready, JSON.stringify(ready));
  const verdict = await R.tool('verdict', { chat: w1, commit: head, result: 'pass', note: 'ok' });
  assert.equal(verdict.verdict?.result, 'pass', JSON.stringify(verdict));

  // Passed but not merged: the ring's own record counts no pass as done (no look has run yet).
  q = await queue();
  assert.deepEqual([q.done, q.total, q.items.find((i) => i.id === 'A1').merged], [0, 3, false], JSON.stringify(q));

  // Ticking the plan's box moves nothing: a box is a say-so, done is P9's own evidence. One look (a status read) runs
  // the fetch; a second read within the 30 s window runs no new one — the evidence already recorded answers.
  fs.writeFileSync(path.join(s.folder, 'sprint.md'), plan('x'));
  const clone = path.join(path.dirname(s.folder), s.sprint, 'clone');
  const fetchHead = path.join(clone, '.git', 'FETCH_HEAD');
  let st = await status();
  assert.equal(st.items.find((i) => i.id === 'A1').review.state, 'passed', JSON.stringify(st.items.find((i) => i.id === 'A1')));
  assert.deepEqual(st.done, { merged: 0, ticked: 1, unproven: 0, total: 3 }, JSON.stringify(st.done));
  assert.deepEqual(st.workers.find((w) => w.key === 'w1').work, { done: 0, total: 3 }, JSON.stringify(st.workers));
  const fetched = fs.statSync(fetchHead).mtimeMs;
  st = await status();
  assert.deepEqual(st.done, { merged: 0, ticked: 1, unproven: 0, total: 3 }, 'the second read within the window answered from the recorded evidence');
  assert.equal(fs.statSync(fetchHead).mtimeMs, fetched, 'two status reads within 30 s ran one fetch');
  assert.deepEqual([st.workers.find((w) => w.key === 'w1').work.done, (await queue()).done], [0, 0]);

  // The merge: the reviewed head reaches the remote's main line, and P9's own look records it. The look waits out the
  // 30 s fetch window (a read sooner would answer from the record and miss it).
  g(clone, 'push', '-q', 'origin', 'sprint/' + s.sprint.slice(0, 8) + '/w1:main');
  await new Promise((resolve) => setTimeout(resolve, 31_000));
  st = await status();
  assert.equal(st.items.find((i) => i.id === 'A1').review.merged, true, JSON.stringify(st.items.find((i) => i.id === 'A1')));
  assert.deepEqual(st.done, { merged: 1, ticked: 1, unproven: 0, total: 3 }, JSON.stringify(st.done));
  assert.deepEqual(st.workers.find((w) => w.key === 'w1').work, { done: 1, total: 3 }, JSON.stringify(st.workers));
  q = await queue();
  assert.deepEqual([q.done, q.total, q.items.find((i) => i.id === 'A1').merged], [1, 3, true], JSON.stringify(q));
  // The second item, passed by nobody, stays open; P9's own record holds the first between looks.
  st = await status();
  assert.equal(st.done.merged, 1);
  console.log('PASS O164 done means merged: passed-but-unmerged 0/3, a tick moved nothing, the merge moved the ring to 1/3 (the pass and the review stay recorded; two reads in the window ran one fetch)');
});
