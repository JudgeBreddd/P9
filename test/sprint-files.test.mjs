// The sprint's files (sprint spec D1, D3, D4; SECURITY.md § Sprint files): plan, rules, role files and notes in the
// sprint's folder, what reaches a worker, and the project page's edit route.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSprintFiles, MAX_FILE } from '../apps/server/sprint-files.mjs';
import { daemon, http, authenticated, root } from './helpers.mjs';
import { Client } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const LEAD = '0123abcd-0000-4000-8000-000000000001';

test('Sprint files: fixed names only, no links, whole writes, made once and never over an edit', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9-sf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'sprints'), files = createSprintFiles({ home });
  assert.equal(files.exists(LEAD), false);
  assert.equal(files.ensure(LEAD), path.join(home, LEAD));
  assert.match(files.read(LEAD, 'sprint.md'), /^# Plan\n\nGoal:[\s\S]*## Items[\s\S]*## What I will need from you/);
  const notes = files.ensureWorker(LEAD, 'w1');
  assert.equal(notes, path.join(home, LEAD, 'notes', 'w1.md'));
  assert.match(fs.readFileSync(notes, 'utf8'), /^## Now\nDoing:\nNext:\nBlocked on:\nNot yet checked:\n\n## Log\n$/);
  assert.equal(files.read(LEAD, 'roles/w1.instructions.md'), '');
  // Made once: an edit stays.
  assert.equal(files.write(LEAD, 'sprint.md', 'mine'), true);
  files.ensure(LEAD); files.ensureWorker(LEAD, 'w1');
  assert.equal(files.read(LEAD, 'sprint.md'), 'mine');
  assert.equal((fs.statSync(path.join(home, LEAD, 'sprint.md')).mode & 0o777), 0o600);
  assert.deepEqual(files.list(LEAD).map((f) => f.name), ['sprint.md', 'roles/w1.instructions.md', 'roles/w1.rules.md', 'notes/w1.md']);
  // Only the names on the list, under a chat ID.
  for (const name of ['../x.md', 'other.md', 'roles/W1.rules.md', 'roles/w1.md', 'notes/a/b.md', 'notes/.x.md', 'sprint.md/x', '/etc/passwd'])
    assert.equal(files.write(LEAD, name, 'x'), false, name);
  assert.equal(files.write('not-an-id', 'sprint.md', 'x'), false);
  assert.equal(files.write(LEAD, 'sprint.md', 'x'.repeat(MAX_FILE + 1)), false, 'over the cap');
  assert.equal(files.write(LEAD, 'sprint.md', 'bad \ud800'), false, 'not well formed');
  assert.deepEqual(fs.readdirSync(path.join(home, LEAD)).filter((f) => f.includes('p9-tmp')), [], 'no temp file left');
  // A link in place of a folder or a file is refused, read and write.
  const outside = path.join(dir, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'w2.md'), 'secret');
  fs.symlinkSync(outside, path.join(home, LEAD, 'roles-link'));
  fs.rmSync(path.join(home, LEAD, 'notes'), { recursive: true }); fs.symlinkSync(outside, path.join(home, LEAD, 'notes'));
  assert.equal(files.read(LEAD, 'notes/w2.md'), null);
  assert.equal(files.write(LEAD, 'notes/w2.md', 'x'), false);
  fs.symlinkSync(path.join(outside, 'w2.md'), path.join(home, LEAD, 'rules.md'));
  assert.equal(files.read(LEAD, 'rules.md'), null);
  assert.equal(files.write(LEAD, 'rules.md', 'x'), false);
  assert.equal(fs.readFileSync(path.join(outside, 'w2.md'), 'utf8'), 'secret');
  // No state folder: nothing.
  const none = createSprintFiles({ home: null });
  assert.equal(none.ensure(LEAD), null); assert.equal(none.write(LEAD, 'sprint.md', 'x'), false); assert.deepEqual(none.list(LEAD), []);
  console.log('PASS Sprint files module');
});

// Through the daemon, as the delegate tests do.
const fake = path.join(root, 'test/fake-acp-agent.mjs');
const call = (instance, route, method = 'GET', body) => http({ socketPath: instance.credentials.socketPath, route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  .then((result) => ({ ...result, body: result.text ? JSON.parse(result.text) : null }));
async function agent(t, instance, more = {}) {
  const { body: { conversation } } = await call(instance, '/chat', 'POST', { provider: 'claude', ...more });
  await call(instance, `/chat/${conversation}/prompt`, 'POST', { text: 'mcp' });
  let after = 0, hit;
  for (let i = 0; i < 40 && !hit; i += 1) {
    const { body } = await call(instance, `/chat/events?after=${after}&wait=2000`);
    after = body.cursor; hit = body.events.find((e) => e.conversation === conversation && e.data?.content?.text?.startsWith('mcp:'));
  }
  assert.ok(hit, 'the chat got its MCP entry');
  const [entry] = JSON.parse(hit.data.content.text.slice(4));
  const client = new Client({ name: 'p9-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env: Object.fromEntries(entry.env.map(({ name, value }) => [name, value])) }));
  t.after(() => client.close());
  const tool = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  const done = async (chat) => { for (;;) { const got = await tool('wait_chat', { chat }); if (!got.timedOut) return got; } };
  return { conversation, tool, done };
}

test('Sprint files: open_chat makes the plan and a keyed worker\'s files; rules.md is the sprint rules; instructions and the notes path ride once; role rules with every lead message; the project page edits them', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  await call(instance, '/delegation', 'POST', { start: 'agent', max: 20, workers: [] });
  await call(instance, '/file-protection', 'POST', { on: false });
  fs.mkdirSync(path.join(instance.workspace, 'site'));
  const project = (await call(instance, '/projects', 'POST', { name: 'Site', work: { kind: 'linked', folder: 'site' } })).body.project.id;
  const a = await agent(t, instance, { project });
  // The first worker: the sprint folder and its plan; a keyed worker's role files and notes.
  const first = await a.tool('open_chat', { text: 'hello', title: 'One', key: 'w1' });
  assert.equal(first.error, undefined, JSON.stringify(first));
  assert.match(first.sprint, new RegExp(`[\\\\/]sprints[\\\\/]${a.conversation}$`));
  const sprint = first.sprint, file = (name) => path.join(sprint, name);
  assert.match(fs.readFileSync(file('sprint.md'), 'utf8'), /^# Plan/);
  for (const name of ['roles/w1.instructions.md', 'roles/w1.rules.md', 'notes/w1.md']) assert.ok(fs.existsSync(file(name)), name);
  await a.done(first.chat);
  // The stand-in writes each P9 rules block it got to rules.log in its own working folder, the workspace: one log for all.
  const logFile = path.join(instance.workspace, 'rules.log');
  const log = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  // No instructions yet: the first message carried the rules and the notes path, after them, and the agent saw only "hello".
  assert.equal(log().length, 1);
  assert.match(log()[0], /^\[P9: sprint rules[\s\S]*\]\n\n\[P9: your notes file is [^\n]*notes[\\/]w1\.md\. Keep its Now block current/);
  assert.ok(!log()[0].includes('your instructions'));
  assert.equal((await a.done(first.chat)).last, 'echo:hello');
  // set_rules writes rules.md; an edit of rules.md is what the next message carries, with this worker's role rules.
  await a.tool('set_rules', { rules: 'Only touch docs.' });
  assert.equal(fs.readFileSync(file('rules.md'), 'utf8'), 'Only touch docs.');
  fs.writeFileSync(file('rules.md'), 'Edited rules.'); fs.writeFileSync(file('roles/w1.rules.md'), 'Role one rule.');
  assert.equal((await a.tool('set_rules')).rules, 'Edited rules.');
  await a.tool('send_chat', { chat: first.chat, text: 'second' });
  assert.equal((await a.done(first.chat)).last, 'echo:second');
  assert.equal(log().length, 2);
  assert.ok(log()[1].includes('\nEdited rules.\n\nRole one rule.]') && !log()[1].includes('notes file'), log()[1]);
  // A second keyed worker with instructions written before it starts (by the lead, through the file): sent once, first.
  fs.mkdirSync(file('roles'), { recursive: true }); fs.writeFileSync(file('roles/w2.instructions.md'), 'You review docs only.');
  const second = await a.tool('open_chat', { text: 'hi', title: 'Two', key: 'w2' });
  await a.done(second.chat);
  assert.equal(log().length, 3);
  assert.match(log()[2], /\]\n\n\[P9: your instructions, from your sprint's roles\/w2\.instructions\.md\.\nYou review docs only\.\]\n\n\[P9: your notes file is /);
  assert.equal((await a.done(second.chat)).last, 'echo:hi');
  // A worker with no key: the plan is there, no role files, no notes block.
  const third = await a.tool('open_chat', { text: 'yo', title: 'Three' });
  await a.done(third.chat);
  assert.equal(log().length, 4);
  assert.ok(!log()[3].includes('notes file') && !log()[3].includes('Role one rule'), log()[3]);
  // The project page lists the lead's sprint with its files, and edits one.
  const view = (await call(instance, `/projects/${project}`)).body.project;
  const sp = view.sprints.find((s) => s.lead === a.conversation);
  assert.ok(sp, JSON.stringify(view.sprints));
  assert.ok(['sprint.md', 'rules.md', 'notes/w1.md', 'roles/w2.instructions.md'].every((n) => sp.files.some((f) => f.name === n)), JSON.stringify(sp.files.map((f) => f.name)));
  const edit = await call(instance, `/projects/${project}/sprint-file`, 'POST', { lead: a.conversation, name: 'sprint.md', text: '# Plan\n\nGoal: docs.' });
  assert.equal(edit.status, 200);
  assert.equal(fs.readFileSync(file('sprint.md'), 'utf8'), '# Plan\n\nGoal: docs.');
  assert.equal((await call(instance, `/projects/${project}/sprint-file`, 'POST', { lead: a.conversation, name: '../x.md', text: 'x' })).status, 400);
  assert.equal((await call(instance, `/projects/${project}/sprint-file`, 'POST', { lead: a.conversation, name: 'sprint.md', text: 'x', more: 1 })).status, 400);
  // The lead must be in this project: another project's page cannot reach it.
  fs.mkdirSync(path.join(instance.workspace, 'other'));
  const other = (await call(instance, '/projects', 'POST', { name: 'Other', work: { kind: 'linked', folder: 'other' } })).body.project.id;
  assert.equal((await call(instance, `/projects/${other}/sprint-file`, 'POST', { lead: a.conversation, name: 'sprint.md', text: 'x' })).status, 404);
  assert.deepEqual((await call(instance, `/projects/${other}`)).body.project.sprints, []);
  assert.equal(fs.readFileSync(file('sprint.md'), 'utf8'), '# Plan\n\nGoal: docs.');
  console.log('PASS Sprint files through the daemon');
});
