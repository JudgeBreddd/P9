// The sprint's files (sprint spec D1, D3, D4; SECURITY.md § Sprint files): plan, rules, role files and notes in the
// sprint's folder, what reaches a worker, and the project page's edit route.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { createSprintFiles, hashOf, MAX_FILE } from '../apps/server/sprint-files.mjs';
import { daemon, restart, http, authenticated, root } from './helpers.mjs';
import { Client } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const LEAD = '0123abcd-0000-4000-8000-000000000001';

test('Sprint files: fixed names only, no links, whole writes, made once and never over an edit', { timeout: 10000 }, (t) => {
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
  assert.deepEqual(files.list(LEAD).map((f) => f.hash), files.list(LEAD).map((f) => hashOf(f.text)), 'each listed file names its hash');
  // A worker without a key: notes under its chat ID, no role files.
  const id = '0123abcd-0000-4000-8000-0000000000aa';
  assert.equal(files.ensureWorker(LEAD, id, false), path.join(home, LEAD, 'notes', id + '.md'));
  assert.equal(files.read(LEAD, `roles/${id}.instructions.md`), null);
  // Only the names on the list, under a chat ID.
  for (const name of ['../x.md', 'other.md', 'roles/W1.rules.md', 'roles/w1.md', 'notes/a/b.md', 'notes/.x.md', 'sprint.md/x', '/etc/passwd'])
    assert.equal(files.write(LEAD, name, 'x'), false, name);
  assert.equal(files.write('not-an-id', 'sprint.md', 'x'), false);
  assert.equal(files.write(LEAD, 'sprint.md', 'x'.repeat(MAX_FILE + 1)), false, 'over the cap');
  assert.equal(files.write(LEAD, 'sprint.md', 'bad \ud800'), false, 'not well formed');
  assert.deepEqual(fs.readdirSync(path.join(home, LEAD)).filter((f) => f.includes('p9-tmp')), [], 'no temp file left');
  // The project page's save names the hash it opened (a known SHA-256): a file changed or deleted since is not replaced.
  assert.equal(hashOf('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(files.write(LEAD, 'sprint.md', 'page', hashOf('old')), 'changed');
  assert.equal(files.read(LEAD, 'sprint.md'), 'mine');
  assert.equal(files.write(LEAD, 'sprint.md', 'page', ''), 'changed', "'' is for a file that is not there");
  assert.equal(files.write(LEAD, 'rules.md', 'made again', ''), true);
  assert.equal(files.read(LEAD, 'rules.md'), 'made again'); fs.rmSync(path.join(home, LEAD, 'rules.md'));
  // A writer that lands after the first check, while the save writes its temp file: still not replaced.
  const real = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', function (file, ...rest) {
    real.call(fs, file, ...rest);
    if (String(file).includes('.p9-tmp-')) real.call(fs, path.join(home, LEAD, 'sprint.md'), 'the lead\'s edit');
  });
  syncBuiltinESMExports();
  try { assert.equal(files.write(LEAD, 'sprint.md', 'page', hashOf('mine')), 'changed'); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(files.read(LEAD, 'sprint.md'), "the lead's edit");
  assert.deepEqual(fs.readdirSync(path.join(home, LEAD)).filter((f) => f.includes('p9-tmp')), [], 'its temp file removed');
  assert.equal(files.write(LEAD, 'sprint.md', 'mine', hashOf("the lead's edit")), true);
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
  // wait_chat returns after its own wait with timedOut; asked again until the chat is done, for at most 60 s.
  const done = async (chat) => {
    for (const end = Date.now() + 60000; Date.now() < end;) { const got = await tool('wait_chat', { chat }); if (!got.timedOut) return got; }
    assert.fail(`chat ${chat} was not done within 60 s`);
  };
  return { conversation, tool, done };
}
// The lead again after a daemon restart: its next message starts its agent anew, with an MCP entry for this daemon.
async function reconnect(t, instance, conversation) {
  const before = (await call(instance, '/chat/events?after=0')).body.cursor;
  await call(instance, `/chat/${conversation}/prompt`, 'POST', { text: 'mcp' });
  let after = before, hit;
  for (let i = 0; i < 40 && !hit; i += 1) {
    const { body } = await call(instance, `/chat/events?after=${after}&wait=2000`);
    after = body.cursor; hit = body.events.find((e) => e.conversation === conversation && e.data?.content?.text?.startsWith('mcp:'));
  }
  assert.ok(hit, 'the lead got its MCP entry after the restart');
  const [entry] = JSON.parse(hit.data.content.text.slice(4));
  const client = new Client({ name: 'p9-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env: Object.fromEntries(entry.env.map(({ name, value }) => [name, value])) }));
  t.after(() => client.close());
  return async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
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
  // A worker with no key: its notes under its chat ID, and their path with its first message; no role files.
  const third = await a.tool('open_chat', { text: 'yo', title: 'Three' });
  await a.done(third.chat);
  assert.ok(fs.existsSync(file(`notes/${third.chat}.md`)), 'the unkeyed worker has a notes file');
  assert.ok(!fs.existsSync(file(`roles/${third.chat}.instructions.md`)));
  assert.equal(log().length, 4);
  assert.ok(log()[3].includes(`notes file is ${file(`notes/${third.chat}.md`)}.`) && !log()[3].includes('Role one rule') && !log()[3].includes('your instructions'), log()[3]);
  // The project page lists the lead's sprint with its files, and edits one.
  const view = (await call(instance, `/projects/${project}`)).body.project;
  const sp = view.sprints.find((s) => s.lead === a.conversation);
  assert.ok(sp, JSON.stringify(view.sprints));
  assert.ok(['sprint.md', 'rules.md', 'notes/w1.md', 'roles/w2.instructions.md'].every((n) => sp.files.some((f) => f.name === n)), JSON.stringify(sp.files.map((f) => f.name)));
  const opened = sp.files.find((f) => f.name === 'sprint.md');
  assert.equal(opened.hash, hashOf(opened.text));
  assert.equal((await call(instance, `/projects/${project}/sprint-file`, 'POST', { lead: a.conversation, name: 'sprint.md', text: 'x' })).status, 400, 'a save names the file it opened');
  // Someone else's edit between open and save (here the lead's agent, through the file): the save is refused, theirs stays.
  fs.writeFileSync(file('sprint.md'), '# Plan\n\nGoal: the lead\'s.');
  const late = await call(instance, `/projects/${project}/sprint-file`, 'POST', { lead: a.conversation, name: 'sprint.md', text: '# Plan\n\nGoal: docs.', hash: opened.hash });
  assert.equal(late.status, 409); assert.equal(late.body.error, 'sprint-file-changed');
  assert.equal(fs.readFileSync(file('sprint.md'), 'utf8'), '# Plan\n\nGoal: the lead\'s.');
  const now = late.body.files.find((f) => f.name === 'sprint.md');
  assert.equal(now.text, '# Plan\n\nGoal: the lead\'s.');
  // Saved against the file as it is now: replaced.
  const edit = await call(instance, `/projects/${project}/sprint-file`, 'POST', { lead: a.conversation, name: 'sprint.md', text: '# Plan\n\nGoal: docs.', hash: now.hash });
  assert.equal(edit.status, 200);
  assert.equal(fs.readFileSync(file('sprint.md'), 'utf8'), '# Plan\n\nGoal: docs.');
  assert.equal((await call(instance, `/projects/${project}/sprint-file`, 'POST', { lead: a.conversation, name: '../x.md', text: 'x', hash: now.hash })).status, 400);
  assert.equal((await call(instance, `/projects/${project}/sprint-file`, 'POST', { lead: a.conversation, name: 'sprint.md', text: 'x', hash: now.hash, more: 1 })).status, 400);
  // The lead must be in this project: another project's page cannot reach it.
  fs.mkdirSync(path.join(instance.workspace, 'other'));
  const other = (await call(instance, '/projects', 'POST', { name: 'Other', work: { kind: 'linked', folder: 'other' } })).body.project.id;
  assert.equal((await call(instance, `/projects/${other}/sprint-file`, 'POST', { lead: a.conversation, name: 'sprint.md', text: 'x', hash: hashOf('# Plan\n\nGoal: docs.') })).status, 404);
  assert.deepEqual((await call(instance, `/projects/${other}`)).body.project.sprints, []);
  assert.equal(fs.readFileSync(file('sprint.md'), 'utf8'), '# Plan\n\nGoal: docs.');
  console.log('PASS Sprint files through the daemon');
});

test('Sprint files: a worker\'s instructions and notes path wait for a message that reaches it, through a failed start, a retry and a daemon restart', { timeout: 180000 }, async (t) => {
  let instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  await call(instance, '/delegation', 'POST', { start: 'agent', max: 20, workers: [] });
  await call(instance, '/file-protection', 'POST', { on: false });
  const a = await agent(t, instance);
  const logFile = path.join(instance.workspace, 'rules.log'), refuse = path.join(instance.workspace, 'signed-out');
  const log = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  // The stand-in refuses new sessions while signed-out is in its folder: the worker's start fails, and so does a retry.
  fs.writeFileSync(refuse, '');
  const first = await a.tool('open_chat', { text: 'hello', title: 'One', key: 'w1' });
  assert.ok(first.error && first.chat, JSON.stringify(first));
  assert.ok((await a.tool('send_chat', { chat: first.chat, text: 'again' })).error, 'the retry started while still refused');
  assert.equal(log().length, 0, 'nothing reached the worker');
  fs.rmSync(refuse);
  assert.equal((await a.tool('send_chat', { chat: first.chat, text: 'third' })).error, undefined);
  assert.equal((await a.done(first.chat)).last, 'echo:third');
  assert.equal(log().length, 1);
  assert.match(log()[0], /\]\n\n\[P9: your notes file is [^\n]*notes[\\/]w1\.md\. /);
  // Once delivered, not again.
  await a.tool('send_chat', { chat: first.chat, text: 'fourth' });
  assert.equal((await a.done(first.chat)).last, 'echo:fourth');
  assert.ok(!log()[1].includes('notes file'), log()[1]);
  // A failed start, then P9 restarts before any message reaches the worker: the block is still sent after.
  fs.writeFileSync(refuse, '');
  const second = await a.tool('open_chat', { text: 'hi', title: 'Two', key: 'w2' });
  assert.ok(second.error && second.chat, JSON.stringify(second));
  instance.child.kill('SIGTERM'); await once(instance.child, 'exit');
  instance = await restart(t, instance, 'state-2');
  fs.rmSync(refuse);
  const tool = await reconnect(t, instance, a.conversation);
  assert.equal((await tool('send_chat', { chat: second.chat, text: 'after' })).error, undefined);
  for (const end = Date.now() + 60000; log().length < 3 && Date.now() < end;) await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(log().length, 3);
  assert.match(log()[2], /\]\n\n\[P9: your notes file is [^\n]*notes[\\/]w2\.md\. /);
  console.log('PASS Sprint files start block: kept through a failed start, a retry and a restart; sent once');
});

test('Sprint files: after a compaction the worker is told its notes path again, once per compaction; a worker\'s notes read through its chat', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  await call(instance, '/delegation', 'POST', { start: 'agent', max: 20, workers: [] });
  await call(instance, '/file-protection', 'POST', { on: false });
  const a = await agent(t, instance);
  const logFile = path.join(instance.workspace, 'rules.log');
  const log = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const w = await a.tool('open_chat', { text: 'hello', title: 'One', key: 'w1' });
  await a.done(w.chat);
  assert.equal(log().length, 1);
  const told = (entry) => /\[P9: your notes file is [^\n]*notes[\\/]w1\.md\. /.test(entry);
  const send = async (text) => { await a.tool('send_chat', { chat: w.chat, text }); await a.done(w.chat); };
  await send('plain');
  assert.equal(log().length, 2); assert.ok(!told(log()[1]), 'no compaction: no second telling');
  // A compaction as the real adapters report it (a tool call and its update, one id): the next message carries the line, once.
  await send('squeeze');
  assert.equal(log().length, 3); assert.ok(!told(log()[2]), 'the message of the compacting turn was built before it');
  await send('after');
  assert.equal(log().length, 4); assert.ok(told(log()[3]), log()[3]);
  await send('again');
  assert.equal(log().length, 5); assert.ok(!told(log()[4]), 'told once for one compaction');
  // A second compaction, reported as a compaction_update (in progress, then completed: one compaction): told once more.
  await send('squeezeu');
  await send('after two');
  assert.ok(told(log()[6]), log()[6]);
  await send('and one more');
  assert.ok(!told(log()[7]));
  assert.equal(log().length, 8);
  // Not a worker: the lead's own compaction tells nothing and its notes route has nothing.
  await call(instance, `/chat/${a.conversation}/prompt`, 'POST', { text: 'squeeze' });
  assert.equal((await call(instance, `/chat/${a.conversation}/notes`)).status, 404);
  // The window reads the worker's notes as they are now; the path comes from the chat, not the request.
  const sprint = w.sprint;
  assert.equal(fs.existsSync(path.join(sprint, 'notes/w1.md')), true);
  fs.writeFileSync(path.join(sprint, 'notes/w1.md'), '## Now\nDoing: reading\n');
  const got = await call(instance, `/chat/${w.chat}/notes`);
  assert.equal(got.status, 200); assert.deepEqual(got.body, { name: 'notes/w1.md', text: '## Now\nDoing: reading\n' });
  fs.writeFileSync(path.join(sprint, 'notes/w1.md'), 'changed');
  assert.equal((await call(instance, `/chat/${w.chat}/notes`)).body.text, 'changed');
  assert.equal((await call(instance, '/chat/not-an-id/notes')).status, 404);
  fs.rmSync(path.join(sprint, 'notes/w1.md'));
  assert.equal((await call(instance, `/chat/${w.chat}/notes`)).status, 404);
  console.log('PASS Sprint files: notes path again after a compaction, notes read through the chat');
});

test('Sprint files: O215 a compaction inside the turn that carries the start block tells the notes path again with the next message', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  await call(instance, '/delegation', 'POST', { start: 'agent', max: 20, workers: [] });
  await call(instance, '/file-protection', 'POST', { on: false });
  const a = await agent(t, instance);
  const logFile = path.join(instance.workspace, 'rules.log');
  const log = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const told = (entry) => /\[P9: your notes file is [^\n]*notes[\\/]w1\.md\. /.test(entry);
  // The first message carries the start block, and its own turn compacts: the agent may have lost the line it just read,
  // so the next message from the lead tells it again (main: the turn's end deleted the line the compaction asked for).
  const w = await a.tool('open_chat', { text: 'squeeze', title: 'One', key: 'w1' });
  await a.done(w.chat);
  assert.equal(log().length, 1); assert.ok(told(log()[0]), log()[0]);
  const send = async (text) => { await a.tool('send_chat', { chat: w.chat, text }); await a.done(w.chat); };
  await send('after');
  assert.equal(log().length, 2); assert.ok(told(log()[1]), 'told again after the compaction: ' + log()[1]);
  await send('again');
  assert.equal(log().length, 3); assert.ok(!told(log()[2]), 'told once for one compaction');
  console.log('PASS Sprint files O215: compaction in the start turn tells the notes path again, once');
});

test('Sprint files: O215 a start turn that compacts and then fails keeps its start block, notes line once, for the next message', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  await call(instance, '/delegation', 'POST', { start: 'agent', max: 20, workers: [] });
  await call(instance, '/file-protection', 'POST', { on: false });
  const a = await agent(t, instance);
  const logFile = path.join(instance.workspace, 'rules.log');
  const log = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const times = (entry) => entry.split('[P9: your notes file is ').length - 1;
  // The failed turn did not deliver its block: the next message carries it whole, the notes line once (the line the
  // compaction asked for is in it already).
  const w = await a.tool('open_chat', { text: 'squeezefail', title: 'One', key: 'w1' });
  await a.done(w.chat);
  const send = async (text) => { await a.tool('send_chat', { chat: w.chat, text }); await a.done(w.chat); };
  await send('after');
  assert.equal(times(log().at(-1)), 1, 'the next message: ' + log().at(-1));
  await send('again');
  assert.equal(times(log().at(-1)), 0, 'told again with no new compaction: ' + log().at(-1));
  console.log('PASS Sprint files O215: a start turn that compacted and failed kept its block, notes line once');
});

test('Sprint files: a chat with no parent is not told a notes path', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  await call(instance, '/delegation', 'POST', { start: 'agent', max: 20, workers: [] });
  await call(instance, '/file-protection', 'POST', { on: false });
  const a = await agent(t, instance);
  const w = await a.tool('open_chat', { text: 'hello', title: 'One', key: 'w1' });
  await a.done(w.chat);
  // The lead has no parent. Even with a file where its own ID would put one, its notes route has nothing, before and after a compaction.
  fs.writeFileSync(path.join(w.sprint, `notes/${a.conversation}.md`), '## Now\nDoing: not a worker\n');
  assert.equal((await call(instance, `/chat/${a.conversation}/notes`)).status, 404);
  await call(instance, `/chat/${a.conversation}/prompt`, 'POST', { text: 'squeeze' });
  assert.equal((await call(instance, `/chat/${a.conversation}/notes`)).status, 404);
  assert.equal((await call(instance, `/chat/${w.chat}/notes`)).status, 200, 'its worker still reads its own');
  console.log('PASS Sprint files: a chat with no parent is not told a notes path');
});

test('Sprint files: notes path told once per compaction, not with every message after it', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  await call(instance, '/delegation', 'POST', { start: 'agent', max: 20, workers: [] });
  await call(instance, '/file-protection', 'POST', { on: false });
  const a = await agent(t, instance);
  const logFile = path.join(instance.workspace, 'rules.log');
  const log = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const told = (entry) => /\[P9: your notes file is [^\n]*notes[\\/]w1\.md\. /.test(entry);
  const w = await a.tool('open_chat', { text: 'hello', title: 'One', key: 'w1' });
  await a.done(w.chat);
  const send = async (text) => { await a.tool('send_chat', { chat: w.chat, text }); await a.done(w.chat); };
  await send('squeeze9');
  await send('after');
  assert.equal(log().length, 3); assert.ok(told(log()[2]), log()[2]);
  // The same compaction reported again (id sq9) is the same compaction: nothing more is told.
  await send('squeeze9');
  await send('after again');
  assert.equal(log().length, 5); assert.ok(!told(log()[4]), log()[4]);
  console.log('PASS Sprint files: notes path told once per compaction');
});

test('Sprint files: a prompt that failed after its session started keeps the start block for the next message', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  await call(instance, '/delegation', 'POST', { start: 'agent', max: 20, workers: [] });
  await call(instance, '/file-protection', 'POST', { on: false });
  const a = await agent(t, instance);
  const logFile = path.join(instance.workspace, 'rules.log');
  const log = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const carried = (key) => log().filter((l) => new RegExp(`notes file is [^\\n]*notes[\\\\/]${key}\\.md\\. `).test(l)).length;
  // The session started and the prompt went out, but it failed (the stand-in answers auth-required): sent again next time.
  const first = await a.tool('open_chat', { text: 'auth-required', title: 'One', key: 'w1' });
  assert.equal(first.error, undefined, JSON.stringify(first));
  await a.done(first.chat);
  assert.equal(carried('w1'), 1, 'the failed prompt carried it');
  await a.tool('send_chat', { chat: first.chat, text: 'next' });
  assert.equal((await a.done(first.chat)).last, 'echo:next');
  assert.equal(carried('w1'), 2, 'the message after the failed one carried it again');
  await a.tool('send_chat', { chat: first.chat, text: 'third' });
  assert.equal((await a.done(first.chat)).last, 'echo:third');
  assert.equal(carried('w1'), 2, 'confirmed: not again');
  console.log('PASS Sprint files start block: kept after a failed prompt, then sent once');
});

test('Sprint files: a steer still unconfirmed when its turn ends keeps the next message from sending the start block again', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  await call(instance, '/delegation', 'POST', { start: 'agent', max: 20, workers: [] });
  await call(instance, '/file-protection', 'POST', { on: false });
  const a = await agent(t, instance);
  const logFile = path.join(instance.workspace, 'rules.log');
  const log = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const carried = (key) => log().filter((l) => new RegExp(`notes file is [^\\n]*notes[\\\\/]${key}\\.md\\. `).test(l)).length;
  // A steer that carries it is confirmed only after the turn ended (slow-steering: 6 s, past P9's 5 s wait). The parent's
  // next message, sent meanwhile, leaves it out; the late confirmation clears it. Delivered once.
  fs.writeFileSync(path.join(instance.workspace, 'signed-out'), '');
  const second = await a.tool('open_chat', { text: 'hi', title: 'Two', key: 'w2' });
  assert.ok(second.error && second.chat, JSON.stringify(second));
  fs.rmSync(path.join(instance.workspace, 'signed-out'));
  fs.writeFileSync(path.join(instance.workspace, 'slow-steering'), '');
  assert.equal((await call(instance, `/chat/${second.chat}/prompt`, 'POST', { text: 'late' })).status, 202, 'the user\'s message: no start block');
  const steered = await a.tool('send_chat', { chat: second.chat, text: 'steered' });
  assert.equal(steered.sent, 'into its running turn', JSON.stringify(steered));
  assert.equal(carried('w2'), 1, 'the steer carried it');
  await a.tool('send_chat', { chat: second.chat, text: 'meanwhile' });
  // The steer's text lands at 6 s and is echoed by whichever turn runs next, so only the start of each answer is fixed.
  assert.match((await a.done(second.chat)).last, /^echo:meanwhile/);
  await new Promise((resolve) => setTimeout(resolve, 2000)); // past the steer's late confirmation
  fs.rmSync(path.join(instance.workspace, 'slow-steering'));
  await a.tool('send_chat', { chat: second.chat, text: 'after' });
  assert.match((await a.done(second.chat)).last, /^echo:after/);
  assert.equal(carried('w2'), 1, 'delivered once: ' + JSON.stringify(log().slice(-3)));
  console.log('PASS Sprint files start block: once across a late-confirmed steer');
});

test('Sprint files: a key shaped like a chat ID is refused, so two workers never share a notes file', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  await call(instance, '/delegation', 'POST', { start: 'agent', max: 20, workers: [] });
  await call(instance, '/file-protection', 'POST', { on: false });
  const a = await agent(t, instance);
  // A key shaped like a chat ID would share an unkeyed worker's notes/<chat ID>.md: refused, nothing made.
  const alias0 = await a.tool('open_chat', { text: 'yo', title: 'Unkeyed' });
  await a.done(alias0.chat);
  assert.ok(fs.existsSync(path.join(alias0.sprint, 'notes', alias0.chat + '.md')));
  const alias = await a.tool('open_chat', { text: 'x', title: 'Alias', key: alias0.chat });
  assert.equal(alias.error, 'request-refused', JSON.stringify(alias));
  assert.ok(!(await a.tool('list_chats')).chats.some((c) => c.title === 'Alias'), 'no second worker made');
  console.log('PASS Sprint files: chat-ID keys refused');
});

test('Sprint files: O82 send_chat key re-keys a reused worker, so that message and the next carry the new role\'s rules', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  await call(instance, '/delegation', 'POST', { start: 'agent', max: 20, workers: [] });
  await call(instance, '/file-protection', 'POST', { on: false });
  const a = await agent(t, instance);
  // A worker from an earlier phase, keyed for the reviewer's role.
  const old = await a.tool('open_chat', { text: 'hello', title: 'Phone', key: 'review' });
  assert.equal(old.error, undefined, JSON.stringify(old));
  await a.done(old.chat);
  const file = (name) => path.join(old.sprint, name);
  fs.writeFileSync(file('roles/review.rules.md'), 'You never push.');
  fs.mkdirSync(file('roles'), { recursive: true }); fs.writeFileSync(file('roles/phone.rules.md'), 'Phone builds and pushes.');
  const logFile = path.join(instance.workspace, 'rules.log');
  const last = () => JSON.parse(fs.readFileSync(logFile, 'utf8').trim().split('\n').at(-1));
  // Refused: a key with a note, and a key shaped badly; neither changes the key.
  assert.equal((await a.tool('send_chat', { chat: old.chat, text: 'x', when: 'note', key: 'phone' })).error, 'request-refused');
  assert.equal((await a.tool('send_chat', { chat: old.chat, text: 'x', key: 'Phone!' })).error, 'request-refused');
  assert.equal((await a.tool('list_chats')).chats.find((c) => c.id === old.chat).key, 'review');
  // A message the chat refuses (over the length limit once the notice is added) leaves the old key, so a retry still tells.
  assert.equal((await a.tool('send_chat', { chat: old.chat, text: 'x'.repeat(100_000), key: 'phone' })).error, 'chat-not-sendable');
  assert.equal((await a.tool('list_chats')).chats.find((c) => c.id === old.chat).key, 'review');
  // Re-keyed: this message carries the phone rules, not the reviewer's, and tells the worker where its notes are.
  const sent = await a.tool('send_chat', { chat: old.chat, text: 'go', key: 'phone' });
  assert.equal(sent.error, undefined, JSON.stringify(sent));
  const got = await a.done(old.chat);
  assert.ok(last().includes('Phone builds and pushes.') && !last().includes('You never push.'), last());
  assert.match(got.last, /^echo:\[P9: your role key is now phone: [^\]]*notes\/phone\.md\. Your notes so far are in notes\/review\.md\.\]\n\ngo$/);
  assert.ok(fs.existsSync(file('notes/phone.md')) && fs.existsSync(file('notes/review.md')), 'new notes made, old notes kept');
  assert.equal((await a.tool('list_chats')).chats.find((c) => c.id === old.chat).key, 'phone');
  // The next plain message keeps the new role.
  await a.tool('send_chat', { chat: old.chat, text: 'again' });
  assert.equal((await a.done(old.chat)).last, 'echo:again');
  assert.ok(last().includes('Phone builds and pushes.') && !last().includes('You never push.'), last());
  // A key another of the lead's workers holds is refused.
  const other = await a.tool('open_chat', { text: 'hi', title: 'Other', key: 'daemon' });
  await a.done(other.chat);
  assert.equal((await a.tool('send_chat', { chat: old.chat, text: 'x', key: 'daemon' })).error, 'key-taken');
  console.log('PASS O82: re-keyed worker got the new role\'s rules on that message and the next; note, bad key and taken key refused');
});

test('Standing merge H2: the sprints there the first time this version runs keep merge; one made after starts off; only setMerge changes it, not on a closed sprint', { timeout: 10000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9-sf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { createProjects } = await import('../apps/server/projects.mjs');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL)'); // as ledger.mjs makes it
  const sprintFiles = createSprintFiles({ home: path.join(dir, 'sprints') }), open = () => createProjects({ home: path.join(dir, 'projects'), sprintFiles, db, row: () => null });
  const OLD = LEAD, CLOSED = '0123abcd-0000-4000-8000-000000000002', NEW = '0123abcd-0000-4000-8000-000000000003', LATER = '0123abcd-0000-4000-8000-000000000004';
  sprintFiles.ensure(OLD); sprintFiles.ensure(CLOSED);
  fs.writeFileSync(path.join(dir, 'sprints', 'notes.txt'), ''); // not a sprint folder: never recorded
  let projects = open();
  assert.deepEqual([projects.merge(OLD), projects.merge(CLOSED)], [true, true], 'a sprint made before this version lost its merge');
  sprintFiles.ensure(NEW);
  assert.equal(projects.merge(NEW), false, 'a sprint made after started with merge on');
  assert.deepEqual(projects.setMerge(NEW, true), { status: 200, merge: true }); assert.equal(projects.merge(NEW), true);
  assert.deepEqual(projects.setMerge(NEW, false), { status: 200, merge: false }); assert.equal(projects.merge(NEW), false);
  assert.equal(projects.setMerge(NEW, 'true').status, 400); assert.equal(projects.setMerge(LATER, true).status, 404); assert.equal(projects.setMerge('../x', true).status, 404);
  db.prepare('INSERT INTO prefs (key, value) VALUES (?, ?)').run('sprint-close:' + CLOSED, JSON.stringify({ at: 1, by: 'owner' }));
  assert.deepEqual(projects.setMerge(CLOSED, false), { status: 409, error: 'sprint-closed' }); assert.equal(projects.merge(CLOSED), true);
  // P9 starts again: the record is made once, so a sprint made since is not taken for an old one; the owner's off stays off.
  sprintFiles.ensure(LATER); projects.setMerge(OLD, false); projects = open();
  assert.deepEqual([projects.merge(OLD), projects.merge(NEW), projects.merge(LATER), projects.merge(CLOSED)], [false, false, false, true]);
  assert.equal(projects.merge(undefined), false);
  console.log('PASS H2: old sprints kept merge, new ones started off, setMerge turned it on and off, refused a bad value, an unknown and a closed sprint; a restart recorded nothing again');
});

test('Sprint files: a save\'s reply lists the file as it wrote it, so a writer landing right after the rename is refused at the next save, not replaced (O93)', { timeout: 10000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9-sf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { createProjects } = await import('../apps/server/projects.mjs');
  const PROJECT = '0123abcd-0000-4000-8000-0000000000aa', home = path.join(dir, 'projects'), sprintFiles = createSprintFiles({ home: path.join(dir, 'sprints') });
  fs.mkdirSync(path.join(home, PROJECT), { recursive: true });
  fs.writeFileSync(path.join(home, PROJECT, 'project.json'), JSON.stringify({ id: PROJECT, name: 'Site', work: { kind: 'p9' } }));
  const projects = createProjects({ home, sprintFiles, row: (id) => (id === LEAD ? { project: PROJECT } : null) });
  sprintFiles.ensure(LEAD);
  const file = path.join(dir, 'sprints', LEAD, 'sprint.md'), opened = sprintFiles.list(LEAD).find((f) => f.name === 'sprint.md');
  // The lead's agent writes sprint.md just after the page's save renamed its text into place, before the reply's list.
  // The save's text reaches the file by a rename or a link from its temp file; the lead writes right after either.
  for (const name of ['renameSync', 'linkSync']) {
    const real = fs[name];
    t.mock.method(fs, name, (from, to) => { real.call(fs, from, to); if (String(from).includes('.p9-tmp-')) fs.writeFileSync(file, 'the lead\'s edit'); });
  }
  syncBuiltinESMExports();
  let saved;
  try { saved = await projects.sprintFile(PROJECT, { lead: LEAD, name: 'sprint.md', text: 'mine', hash: opened.hash }); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(saved.status, 200);
  const base = saved.files.find((f) => f.name === 'sprint.md');
  assert.deepEqual([base.text, base.hash], ['mine', hashOf('mine')], 'the reply is what the page saved, not the lead\'s text');
  // The page types on from its own text: that save names its own write and is refused; the lead's text stays.
  const next = await projects.sprintFile(PROJECT, { lead: LEAD, name: 'sprint.md', text: 'mine and more', hash: base.hash });
  assert.equal(next.status, 409); assert.equal(next.error, 'sprint-file-changed');
  assert.equal(fs.readFileSync(file, 'utf8'), 'the lead\'s edit');
  console.log('PASS O93 save reply is the saved text');
});

test('Sprint files: a lead write landing between the save\'s last check and its swap is kept, and the save gets a conflict (O97)', { timeout: 10000 }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9-sf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = createSprintFiles({ home: dir }), folder = path.join(dir, LEAD), file = path.join(folder, 'sprint.md');
  files.ensure(LEAD); files.write(LEAD, 'notes/w1.md', 'notes');
  // Forced: the lead's agent writes the file just before the save's text arrives there, by whatever step (rename or link)
  // takes it from the temp file: after every check the save makes.
  const lead = (target, text) => {
    for (const name of ['renameSync', 'linkSync']) {
      const real = fs[name];
      t.mock.method(fs, name, (from, to) => { if (String(from).includes('.p9-tmp-')) fs.writeFileSync(target, text); return real.call(fs, from, to); });
    }
    syncBuiltinESMExports();
  };
  const save = (name, text, hash) => { try { return files.write(LEAD, name, text, hash); } finally { t.mock.restoreAll(); syncBuiltinESMExports(); } };
  lead(file, "the lead's edit");
  const got = save('sprint.md', 'page', hashOf(files.read(LEAD, 'sprint.md')));
  assert.deepEqual([got, files.read(LEAD, 'sprint.md')], ['changed', "the lead's edit"], `the save returned ${got} and left: ${files.read(LEAD, 'sprint.md')}`);
  // The same for a file the page makes again ('' = must not exist).
  const notes = path.join(folder, 'notes', 'w2.md');
  lead(notes, "the worker's notes");
  const made = save('notes/w2.md', 'page', '');
  assert.deepEqual([made, files.read(LEAD, 'notes/w2.md')], ['changed', "the worker's notes"], `the save returned ${made} and left: ${files.read(LEAD, 'notes/w2.md')}`);
  // Rollback (review FIX1): the save's text is linked in, then a write through a handle opened before the swap changes
  // the old file, and another writer replaces the file at its name before the save takes its text back. The newer
  // writer's file stays: the rollback removes only the save's own file.
  const realLink = fs.linkSync;
  t.mock.method(fs, 'linkSync', (from, to) => {
    realLink.call(fs, from, to);
    if (!String(from).includes('.p9-tmp-')) return;
    const aside = fs.readdirSync(folder).find((f) => f.startsWith('sprint.md.p9-old-'));
    fs.writeFileSync(path.join(folder, aside), 'through an old handle');
    fs.writeFileSync(file + '.other', "the worker's newer file"); fs.renameSync(file + '.other', file);
  });
  syncBuiltinESMExports();
  const back = save('sprint.md', 'page', hashOf("the lead's edit"));
  assert.deepEqual([back, files.read(LEAD, 'sprint.md')], ['changed', "the worker's newer file"], `the save returned ${back} and left: ${files.read(LEAD, 'sprint.md')}`);
  // Nothing in the way: the save lands, and no temp or aside file is left.
  assert.equal(files.write(LEAD, 'sprint.md', 'page', hashOf("the worker's newer file")), true);
  assert.equal(files.read(LEAD, 'sprint.md'), 'page');
  // Deleted after the save's check, just before it sets the file aside: a conflict (409 with the files as they are now),
  // not a refused request.
  const realRename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => { if (String(to).includes('.p9-old-')) fs.unlinkSync(from); return realRename.call(fs, from, to); });
  syncBuiltinESMExports();
  const gone = save('sprint.md', 'more', hashOf('page'));
  assert.deepEqual([gone, files.read(LEAD, 'sprint.md')], ['changed', null], `deleted meanwhile: the save returned ${gone}`);
  const left = [...fs.readdirSync(folder), ...fs.readdirSync(path.join(folder, 'notes'))].filter((f) => f.includes('.p9-'));
  assert.deepEqual(left, [], 'no temp or aside files left');
  console.log('PASS O97 guarded swap');
});

test('Sprint files: a save on a disk without hard links is refused before anything moves; one that cannot place it throws and puts the old file back, or keeps it aside and names it (O97 link error)', { timeout: 10000 }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9-sf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = createSprintFiles({ home: dir }), folder = path.join(dir, LEAD), file = path.join(folder, 'sprint.md');
  files.ensure(LEAD); files.write(LEAD, 'sprint.md', 'old');
  const real = { linkSync: fs.linkSync }, fail = (code) => Object.assign(new Error(code), { code });
  const mock = (name, fn) => t.mock.method(fs, name, (from, to, ...rest) => fn(String(from), () => real[name].call(fs, from, to, ...rest)));
  const save = (text, hash) => {
    syncBuiltinESMExports();
    try { return { got: files.write(LEAD, 'sprint.md', text, hash) }; } catch (error) { return { thrown: error.code, message: error.message }; } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  };
  const now = () => files.read(LEAD, 'sprint.md');
  // No hard links on this disk: the save is refused and the file is untouched.
  mock('linkSync', () => { throw fail('EPERM'); });
  let r = save('page', hashOf('old'));
  assert.deepEqual([r.got, now()], ['no-links', 'old'], `no links: ${JSON.stringify(r)}, left: ${now()}`);
  files.write(LEAD, 'sprint.md', 'page');
  // Links work, but placing the save's text fails (a full disk): it throws, and the old file is back at its name.
  mock('linkSync', (from, go) => { if (from.includes('.p9-tmp-')) throw fail('ENOSPC'); return go(); });
  r = save('more', hashOf('page'));
  assert.deepEqual([r.thrown, now()], ['ENOSPC', 'page'], `the save's placing failing: ${JSON.stringify(r)}, left: ${now()}`);
  // Nothing can put it back: it stays aside with its bytes, and the error names where.
  mock('linkSync', (from, go) => { if (!from.includes('.p9-link-')) throw fail('ENOSPC'); return go(); });
  r = save('more', hashOf('page'));
  const kept = fs.readdirSync(folder).filter((f) => f.includes('.p9-old-'));
  assert.equal(kept.length, 1, `kept aside: ${kept}, ${JSON.stringify(r)}`);
  assert.ok(r.message?.includes(kept[0]), `the error names it: ${JSON.stringify(r)}`);
  assert.equal(fs.readFileSync(path.join(folder, kept[0]), 'utf8'), 'page');
  fs.renameSync(path.join(folder, kept[0]), file);
  assert.deepEqual(fs.readdirSync(folder).filter((f) => f.includes('.p9-')), [], 'no temp or aside files left');
  console.log('PASS O97 link error');
});

test('Sprint files: a writer making the file while a failed save puts the old one back keeps its text (O97 restore race)', { timeout: 10000 }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9-sf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = createSprintFiles({ home: dir }), folder = path.join(dir, LEAD), file = path.join(folder, 'sprint.md');
  files.ensure(LEAD); files.write(LEAD, 'sprint.md', 'old');
  const fail = (code) => Object.assign(new Error(code), { code });
  // Forced: the save's own text cannot be placed (a full disk), and the worker writes the file just before the link that
  // puts the old file back from aside: after any check that the name is free.
  const real = fs.linkSync;
  t.mock.method(fs, 'linkSync', (from, to) => {
    if (String(from).includes('.p9-tmp-')) throw fail('ENOSPC');
    if (String(from).includes('.p9-old-')) fs.writeFileSync(file, "the worker's newer file");
    return real.call(fs, from, to);
  });
  syncBuiltinESMExports();
  let thrown = null;
  try { files.write(LEAD, 'sprint.md', 'page', hashOf('old')); } catch (error) { thrown = error.code; } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.deepEqual([!!thrown, files.read(LEAD, 'sprint.md')], [true, "the worker's newer file"], `threw ${thrown}, left: ${files.read(LEAD, 'sprint.md')}`);
  assert.deepEqual(fs.readdirSync(folder).filter((f) => f.includes('.p9-')), [], 'no temp or aside files left');
  console.log('PASS O97 restore race');
});

test('Sprint files: an edit written through a handle opened before the save is kept with a conflict up to the save\'s last recheck; after it, as for any whole-file write, it reaches no name (O101)', { timeout: 10000 }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9-sf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = createSprintFiles({ home: dir }), folder = path.join(dir, LEAD), file = path.join(folder, 'sprint.md');
  files.ensure(LEAD);
  // A writer (an agent's own editor) opened sprint.md before the page's save, and writes through that handle at one step.
  const run = (step, expect = true) => {
    files.write(LEAD, 'sprint.md', 'old');
    const fd = fs.openSync(file, 'r+'), theirs = () => { fs.ftruncateSync(fd, 0); fs.writeSync(fd, 'theirs', 0); };
    const real = { renameSync: fs.renameSync, linkSync: fs.linkSync };
    // before: just after the save set the file aside; placed: just after the save's text was linked in at the name.
    if (step === 'before') t.mock.method(fs, 'renameSync', (from, to) => { real.renameSync.call(fs, from, to); if (String(to).includes('.p9-old-')) theirs(); });
    if (step === 'placed') t.mock.method(fs, 'linkSync', (from, to) => { real.linkSync.call(fs, from, to); if (String(from).includes('.p9-tmp-') && String(to) === file) theirs(); });
    syncBuiltinESMExports();
    let got;
    try { got = files.write(LEAD, 'sprint.md', 'page', expect ? hashOf('old') : undefined); } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    if (step === 'after') theirs();
    fs.closeSync(fd);
    return [got, files.read(LEAD, 'sprint.md')];
  };
  // Up to the last recheck: theirs stays at the name and the save is a conflict (409: the page keeps its own text).
  assert.deepEqual(run('before'), ['changed', 'theirs'], 'written just after the save set the file aside');
  assert.deepEqual(run('placed'), ['changed', 'theirs'], 'written just after the save placed its text');
  // After the save's last step the handle points at a file that has no name any more: the same for the guarded save as
  // for a plain whole-file write (temp file and rename, as every writer's own atomic save does). No check of P9's can
  // see a write that lands after its last read of the file; only a lock every writer takes could, and agents take none.
  assert.deepEqual(run('after'), [true, 'page'], 'guarded save, written after its last recheck');
  assert.deepEqual(run('after', false), [true, 'page'], 'plain whole-file write, written after it');
  assert.deepEqual(fs.readdirSync(folder).filter((f) => f.includes('.p9-')), [], 'no temp or aside files left');
  console.log('PASS O101 pre-opened handle');
});

test('Sprint files: on a disk without hard links a reader outside P9 never sees a half-written file while a save places it (O100)', { timeout: 10000 }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9-sf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = createSprintFiles({ home: dir }), folder = path.join(dir, LEAD);
  files.ensure(LEAD); files.write(LEAD, 'sprint.md', 'old');
  const fail = (code) => Object.assign(new Error(code), { code });
  const whole = 'page '.repeat(400);
  // Forced: every link fails, and a copy of the save's text writes it in two halves; between them a reader (an agent's
  // own read of the file, which no lock of P9's reaches) reads the file's name.
  const seen = [];
  const save = (name, expect) => {
    const file = path.join(folder, name), real = fs.copyFileSync;
    t.mock.method(fs, 'linkSync', () => { throw fail('EPERM'); });
    t.mock.method(fs, 'copyFileSync', (from, to, mode) => {
      if (!String(from).includes('.p9-tmp-')) return real.call(fs, from, to, mode);
      const bytes = fs.readFileSync(from), fd = fs.openSync(to, mode & fs.constants.COPYFILE_EXCL ? 'wx' : 'w');
      try {
        fs.writeSync(fd, bytes, 0, bytes.length >> 1);
        try { seen.push([name, fs.readFileSync(file, 'utf8')]); } catch (error) { seen.push([name, error.code]); }
        fs.writeSync(fd, bytes, bytes.length >> 1);
      } finally { fs.closeSync(fd); }
    });
    syncBuiltinESMExports();
    try { return files.write(LEAD, name, whole, expect); } catch (error) { return error.code; } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  };
  const results = [save('sprint.md', hashOf('old')), save('notes/new.md', '')];
  const half = seen.filter(([name, text]) => ![name === 'sprint.md' ? 'old' : 'ENOENT', 'ENOENT', whole].includes(text));
  assert.deepEqual(half.map(([name, text]) => [name, text.length]), [], `a reader saw a half-written file: ${JSON.stringify({ results, seen: seen.map(([n, x]) => [n, x.length]) })}`);
  for (const name of ['sprint.md', 'notes/new.md']) assert.ok([whole, null, 'old'].includes(files.read(LEAD, name)), `${name} is whole after the save: ${files.read(LEAD, name)?.length}`);
  // Nothing can be placed whole there, so the save is refused, saying why, and the files are as they were.
  assert.deepEqual([results, files.read(LEAD, 'sprint.md'), files.read(LEAD, 'notes/new.md')], [['no-links', 'no-links'], 'old', null], `refused: ${JSON.stringify(results)}`);
  assert.deepEqual(fs.readdirSync(folder).filter((f) => f.includes('.p9-')), [], 'no temp or aside files left');
  console.log('PASS O100 no half file', JSON.stringify(results));
});
