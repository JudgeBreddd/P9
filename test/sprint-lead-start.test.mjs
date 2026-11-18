// O171: a sprint started from the Setup page (no parent chat). The lead's first prompt carries its
// roles/lead.instructions.md and its sprint folder, as each chat under it carries its own instructions.
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
const settle = async (check) => { for (let i = 0; i < 100; i += 1) { const got = await check(); if (got) return got; await new Promise((r) => setTimeout(r, 200)); } return check(); };
// Every prompt the fake agent was sent in a folder holding log-prompts, as lists of text blocks.
const prompts = (dirs) => dirs.flatMap((d) => (fs.existsSync(path.join(d, 'prompts.log')) ? fs.readFileSync(path.join(d, 'prompts.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []));

test('Sprint O171: a lead started from the Setup page gets its instructions and its sprint folder with its first prompt; the reviewer gets its own', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const ws = instance.workspace, repo = path.join(ws, 'repo');
  fs.mkdirSync(repo); g(repo, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); g(repo, 'add', 'a.txt'); g(repo, 'commit', '-qm', 'a');
  const project = (await call(instance, '/projects', 'POST', { name: 'Fresh', work: { kind: 'new', parent: '', name: 'fresh' } })).body.project.id;
  // P9 learns Claude's model and effort lists when it first runs.
  const first = (await call(instance, '/chat', 'POST', { provider: 'claude' })).body.conversation;
  await call(instance, `/chat/${first}/prompt`, 'POST', { text: 'config' });
  assert.ok(await settle(async () => (await events(instance, first)).some((e) => e.data?.content?.text?.startsWith('config:'))), 'no config reply');
  const dirs = [ws, path.join(ws, 'fresh')];
  for (const d of dirs) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'log-prompts'), ''); }

  const prep = await call(instance, '/projects/' + project + '/sprints', 'POST', { title: 'S1' });
  assert.equal(prep.status, 201, JSON.stringify(prep.body));
  const sprint = prep.body.sprint;
  const save = async (name, text) => {
    const file = (await call(instance, '/projects/' + project)).body.project.sprints.find((s) => s.lead === sprint).files.find((f) => f.name === name);
    const got = await call(instance, '/projects/' + project + '/sprint-file', 'POST', { lead: sprint, name, text, hash: file?.hash ?? '' });
    assert.equal(got.status, 200, name + ' ' + JSON.stringify(got.body));
  };
  await save('roles.json', JSON.stringify({ folder: 'repo', roles: [{ key: 'lead', provider: 'claude', model: 'opus', effort: 'high' }, { key: 'review', provider: 'claude', model: 'haiku', effort: 'low' }] }));
  await save('roles/lead.instructions.md', 'Print LEAD-LINE-O171 first.');
  await save('roles/review.instructions.md', 'Print REVIEW-LINE-O171 first.');

  // The owner's press: no caller, so the lead has no parent and its first message is P9's.
  const press = await call(instance, `/sprints/${sprint}/start`, 'POST', {});
  assert.equal(press.status, 200, JSON.stringify(press.body));
  const review = press.body.chats.find((c) => c.key === 'review').chat;
  const firstUser = async (id) => settle(async () => (await events(instance, id)).find((e) => e.type === 'user'));
  const leadUser = await firstUser(sprint), reviewUser = await firstUser(review);
  assert.equal(leadUser.data.from, 'p9');
  assert.match(leadUser.data.rules ?? '', /^[0-9a-f]{12}$/, 'the lead\'s first message carried no start block');
  assert.match(reviewUser.data.rules ?? '', /^[0-9a-f]{12}$/, 'the reviewer\'s first message carried no start block');

  // What the lead's agent was sent: its instructions and the sprint's own folder, in its first prompt.
  const leadPrompt = await settle(() => prompts(dirs).find((p) => p.some((b) => b.includes('you lead this sprint'))));
  assert.ok(leadPrompt, 'the lead\'s agent was never sent its start block');
  const joined = leadPrompt.join('');
  // O171 framing: a Setup file at Start is framed as approved by the user, with its writer named.
  assert.match(joined, /\[P9: your instructions, approved by the user when they started this sprint: roles\/lead\.instructions\.md, written by the user\.\nPrint LEAD-LINE-O171 first\.\]/);
  assert.ok(joined.includes(`Its folder: ${prep.body.folder}.`), 'the sprint folder is not named: ' + joined.slice(0, 400));
  assert.ok(fs.existsSync(path.join(prep.body.folder, 'sprint.md')), 'sprint.md is not in the folder the lead is told');
  assert.ok(!joined.includes('sprint rules from the chat that started you'), 'a lead with no parent got parent rules');
  // Sent once: the block left prefs when the turn ended, so the lead's next message does not carry it again.
  await settle(async () => (await events(instance, sprint)).some((e) => e.type === 'turn-end'));
  await call(instance, `/chat/${sprint}/prompt`, 'POST', { text: 'again' });
  const again = await settle(() => prompts(dirs).find((p) => p.some((b) => b.includes('again'))));
  assert.ok(again && !again.join('').includes('LEAD-LINE-O171'), 'the start block was sent twice');
});
