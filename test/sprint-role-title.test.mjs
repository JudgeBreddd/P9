// O172: a sprint's chats keep their role names. The agent's automatic title (session_info_update) renamed the lead and
// every worker after their first turn to the task's title, so the rows and the Sprint panel no longer said which chat
// is which role. A chat outside a sprint still takes the agent's title, and the user's rename still names any chat.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { daemon, http, authenticated, root } from './helpers.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const call = (instance, route, method = 'GET', body) => http({ socketPath: instance.credentials.socketPath, route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  .then((result) => ({ ...result, body: result.text ? JSON.parse(result.text) : null }));
const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
const events = async (instance, id) => (await call(instance, '/chat/events?after=0&only=' + id)).body.events;
const settle = async (check, what) => { for (let i = 0; i < 150; i += 1) { const got = await check(); if (got) return got; await new Promise((r) => setTimeout(r, 200)); } assert.fail('timed out: ' + what); };
const titled = async (instance, id) => (await events(instance, id)).some((e) => e.data?.sessionUpdate === 'session_info_update' || e.data?.update?.sessionUpdate === 'session_info_update');
const titleOf = async (instance, id) => (await call(instance, '/chat')).body.conversations.find((c) => c.id === id)?.title;

test('Sprint O172: the lead and a worker keep their role names after the agent titles them; a chat outside a sprint takes the title; the user\'s rename still wins', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  await call(instance, '/file-protection', 'POST', { on: false });
  const ws = instance.workspace, repo = path.join(ws, 'repo');
  fs.mkdirSync(repo); g(repo, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); g(repo, 'add', 'a.txt'); g(repo, 'commit', '-qm', 'a');
  const plain = (await call(instance, '/chat', 'POST', { provider: 'claude' })).body.conversation;
  await call(instance, `/chat/${plain}/prompt`, 'POST', { text: 'title Sales tax close' });
  await settle(async () => (await titleOf(instance, plain)) === 'Sales tax close', 'a chat outside a sprint takes the agent\'s title');

  const project = (await call(instance, '/projects', 'POST', { name: 'Fresh', work: { kind: 'new', parent: '', name: 'fresh' } })).body.project.id;
  const prep = (await call(instance, '/projects/' + project + '/sprints', 'POST', { title: 'test 1' })).body;
  const file = (name) => path.join(prep.folder, name);
  fs.writeFileSync(file('roles.json'), JSON.stringify({ folder: 'repo', roles: ['lead', 'review'].map((key) => ({ key, provider: 'claude', model: 'haiku', effort: 'low' })) }));
  fs.writeFileSync(file('roles/lead.work.md'), 'title Sales tax close');
  fs.writeFileSync(file('roles/review.work.md'), 'title Sales tax close review');
  const press = await call(instance, `/sprints/${prep.sprint}/start`, 'POST', {});
  assert.equal(press.status, 200, JSON.stringify(press.body));
  const lead = prep.sprint, review = press.body.chats.find((c) => c.key === 'review').chat;
  // Each agent sent its title (so the check below is not vacuous), and its turn ended.
  for (const id of [lead, review]) await settle(async () => (await titled(instance, id)) && (await events(instance, id)).some((e) => e.type === 'turn-end'), 'a titled turn from ' + id);
  assert.equal(await titleOf(instance, lead), 'test 1', 'the lead kept its sprint\'s name');
  assert.equal(await titleOf(instance, review), 'review', 'the worker kept its role key');

  const renamed = await call(instance, `/chat/${review}/rename`, 'POST', { title: 'Reviewer A' });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal(await titleOf(instance, review), 'Reviewer A', 'the user\'s rename names a sprint chat');
  console.log('PASS sprint role title');
});
