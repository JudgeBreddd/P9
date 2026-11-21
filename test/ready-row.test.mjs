// O196: a sprint worker whose role key has no line in sprint.md (its rows live in the lead's own list) got
// {"error":"no-task"} from ready even with a row id, so the Reviewer's verdict had no ready to land on. The row it
// names is now its task. A refusal says which of lead (parent) or task is missing.
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
const until = async (check) => { for (let i = 0; i < 150; i += 1) { if (await check()) return; await new Promise((r) => setTimeout(r, 200)); } throw new Error('timed out'); };
async function attach(t, instance, conversation) {
  let hit;
  await until(async () => (hit = (await call(instance, `/chat/events?after=0&only=${conversation}`)).body.events.find((e) => e.data?.content?.text?.startsWith('mcp:'))));
  const [entry] = JSON.parse(hit.data.content.text.slice(4));
  const client = new Client({ name: 'p9-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env: Object.fromEntries(entry.env.map(({ name, value }) => [name, value])) }));
  t.after(() => client.close());
  return async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
}

test('O196: a sprint worker with a role key and no sprint.md line is queued by ready with its row id, its report card is pinned in its lead (O224), and the verdict lands', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const ws = instance.workspace;
  await call(instance, '/file-protection', 'POST', { on: false });
  // A chat the owner opened (no lead): its ready names the missing lead. It also teaches P9 Claude's lists before the press.
  const solo = (await call(instance, '/chat', 'POST', { provider: 'claude' })).body.conversation;
  await call(instance, `/chat/${solo}/prompt`, 'POST', { text: 'mcp' });
  const S = await attach(t, instance, solo);

  const repo = path.join(ws, 'repo');
  fs.mkdirSync(repo); g(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); g(repo, 'add', 'a.txt'); g(repo, 'commit', '-qm', 'a');
  const project = (await call(instance, '/projects', 'POST', { name: 'Fresh', work: { kind: 'new', parent: '', name: 'fresh' } })).body.project.id;
  const s = (await call(instance, '/projects/' + project + '/sprints', 'POST', { title: 'Rows' })).body;
  // sprint.md names another role's line only: w2's rows are kept in the lead's own list, as tonight's sprint does.
  fs.writeFileSync(path.join(s.folder, 'sprint.md'), '# Plan\n\n- [ ] A1: the first thing. Role: w1\n');
  const role = (key) => ({ key, provider: 'claude', model: 'haiku', effort: 'low' });
  fs.writeFileSync(path.join(s.folder, 'roles.json'), JSON.stringify({ folder: 'repo', roles: [role('lead'), role('review'), role('w1'), role('w2')] }));
  for (const key of ['lead', 'review', 'w1', 'w2']) fs.writeFileSync(path.join(s.folder, `roles/${key}.work.md`), 'mcp');
  const press = await call(instance, `/sprints/${s.sprint}/start`, 'POST', {});
  assert.equal(press.status, 200, JSON.stringify(press.body));
  const w2 = press.body.chats.find((c) => c.key === 'w2').chat;

  const folder = path.join(path.dirname(s.folder), s.sprint, 'workers', 'w2');
  fs.writeFileSync(path.join(folder, 'b.txt'), 'b\n'); g(folder, 'add', 'b.txt'); g(folder, 'commit', '-qm', 'b');
  const head = g(folder, 'rev-parse', 'HEAD');
  const W = await attach(t, instance, w2);
  const R = await attach(t, instance, press.body.chats.find((c) => c.key === 'review').chat);
  const report = { commit: head, results: [{ check: 'unit', result: 'pass' }], weakest: 'none' };

  await call(instance, `/chat/${w2}/prompt`, 'POST', { text: 'late' }); // the fake agent's long turn: ready is called inside a turn
  const ready = await W('ready', { ...report, row: 'O7' });
  assert.equal(ready.ready?.item, 'O7', JSON.stringify(ready));
  assert.equal(ready.ready.commit, head);
  // O224: its report card is pinned in its lead's chat when the turn ends. It has no open_chat task, and P9 pinned a card
  // only for a worker with one, so no sprint worker's report reached its lead.
  const lead = (await call(instance, '/chat')).body.conversations?.find((c) => c.id === w2)?.parent ?? s.sprint;
  let pinned;
  await until(async () => (pinned = (await call(instance, `/chat/events?after=0&only=${lead}`)).body.events.find((e) => e.type === 'card' && e.data?.id === 'ready-' + w2)));
  assert.match(pinned.data.text, /### O7/);
  assert.ok(pinned.data.text.includes(head), pinned.data.text);
  const verdict = await R('verdict', { chat: w2, commit: head, result: 'pass', note: 'ok' });
  assert.equal(verdict.verdict?.result, 'pass', JSON.stringify(verdict));
  assert.deepEqual([verdict.review?.state, verdict.review?.fixes], ['passed', 0], JSON.stringify(verdict));
  // Refusals name what is missing: with no row and no sprint.md line, the task; a chat with no lead, the parent.
  const bare = await W('ready', report);
  assert.deepEqual([bare.error, bare.missing], ['no-task', 'task'], 'with no row and no sprint.md line: ' + JSON.stringify(bare));
  assert.match(bare.detail, /row/, 'the refusal says to name the row');
  await call(instance, `/chat/${solo}/prompt`, 'POST', { text: 'late' });
  const lone = await S('ready', { ...report, row: 'O7' });
  assert.deepEqual([lone.error, lone.missing], ['no-task', 'parent'], JSON.stringify(lone));
  console.log('PASS O196: w2 with row O7 queued; verdict pass landed; w2 without row refused (missing task); lone chat refused (missing parent)');
});
