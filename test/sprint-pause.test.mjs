// Pause sprint / Resume (0.1.9 phase 4.5, S13; SECURITY.md § Pause sprint): while a sprint is paused its workers start no
// turn for what an agent or P9 sends them; each such message is kept, in order, across a restart, and Resume sends them
// in that order with their senders. A note passes, ask_chat is refused, the owner's own message goes through, the lead
// opens no worker, and at most 100 are kept.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { daemon, restart, http, authenticated, root } from './helpers.mjs';
import { Client } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const call = (instance, route, method = 'GET', body) => http({ socketPath: instance.credentials.socketPath, route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  .then((result) => { let body = null; try { body = result.text ? JSON.parse(result.text) : null; } catch { body = { text: result.text.slice(0, 80) }; } return { ...result, body }; });
const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rows = async (instance) => (await call(instance, '/chat')).body.conversations;
const events = async (instance, id) => (await call(instance, '/chat/events?after=0&only=' + id)).body.events;
const cursor = async (instance) => (await call(instance, '/chat/events?after=0&wait=0')).body.cursor;
async function until(instance, match, after = 0) {
  for (let i = 0; i < 40; i += 1) {
    const { body } = await call(instance, `/chat/events?after=${after}&wait=2000`);
    after = body.cursor;
    const hit = body.events.find(match);
    if (hit) return { hit, cursor: after };
  }
  throw new Error('event-timeout');
}
// The SDK client from the MCP entry a chat's agent was handed on its last "mcp" message.
async function attach(t, instance, conversation, after = 0) {
  const { hit } = await until(instance, (e) => e.conversation === conversation && e.data?.content?.text?.startsWith('mcp:'), after);
  const [entry] = JSON.parse(hit.data.content.text.slice(4));
  const client = new Client({ name: 'p9-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env: Object.fromEntries(entry.env.map(({ name, value }) => [name, value])) }));
  t.after(() => client.close());
  const tool = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  return { conversation, tool };
}

test('Pause sprint: a paused sprint\'s workers start no turn for what agents send; it is kept in order across a restart and Resume sends it with its senders; a note and the owner\'s own message go through; ask_chat and open_chat are refused; 100 at most', { timeout: 300000 }, async (t) => {
  let instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const ws = instance.workspace, repo = path.join(ws, 'repo');
  fs.mkdirSync(repo); g(repo, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); g(repo, 'add', 'a.txt'); g(repo, 'commit', '-qm', 'a');
  await call(instance, '/file-protection', 'POST', { on: false });
  const project = (await call(instance, '/projects', 'POST', { name: 'Fresh', work: { kind: 'new', parent: '', name: 'fresh' } })).body.project.id;
  // P9 learns Claude's models and efforts when it first runs.
  const first = (await call(instance, '/chat', 'POST', { provider: 'claude', project })).body.conversation;
  await call(instance, `/chat/${first}/prompt`, 'POST', { text: 'config' });
  await until(instance, (e) => e.conversation === first && e.data?.content?.text?.startsWith('config:'));

  // A started sprint: a lead and two workers, each sent "mcp" as its work so the test holds its tools.
  const prep = (await call(instance, '/projects/' + project + '/sprints', 'POST', { title: 'P1' })).body, sprint = prep.sprint;
  const row = (key, model, effort) => ({ key, provider: 'claude', model, effort });
  fs.writeFileSync(path.join(prep.folder, 'roles.json'), JSON.stringify({ folder: 'repo', roles: [row('lead', 'opus', 'high'), row('w1', 'haiku', 'low'), row('w2', 'haiku', 'low')] }));
  for (const key of ['lead', 'w1', 'w2']) fs.writeFileSync(path.join(prep.folder, `roles/${key}.work.md`), 'mcp');
  // Pause before Start: nothing to pause.
  assert.deepEqual([(await call(instance, `/sprints/${sprint}/pause`, 'POST', {})).status], [404], 'a sprint with no lead was paused');
  const press = await call(instance, `/sprints/${sprint}/start`, 'POST', {});
  assert.equal(press.status, 200, JSON.stringify(press.body));
  const id = Object.fromEntries(press.body.chats.map((c) => [c.key, c.chat]));
  const lead = await attach(t, instance, sprint), w1 = await attach(t, instance, id.w1), w2 = await attach(t, instance, id.w2);
  for (const w of [id.w1, id.w2]) for (;;) { if (!(await lead.tool('wait_chat', { chat: w })).timedOut) break; }
  // A note to an idle lead waits for its next message (a 'note' event); into a running turn it is a 'user' one.
  const told = (e, prefix) => e.conversation === sprint && ['note', 'user'].includes(e.type) && e.data.from === 'p9' && e.data.text?.startsWith(prefix);
  const notices = async (prefix) => (await events(instance, sprint)).filter((e) => told({ ...e, conversation: sprint }, prefix)).map((e) => e.data.text);
  const turns = async (chat, text, after) => (await events(instance, chat)).filter((e) => e.cursor > after && e.type === 'user' && e.data.text?.includes(text));

  // The owner's press, then what it is for: the lead's messages to a worker are kept, and no turn starts.
  let got = await call(instance, `/sprints/${sprint}/pause`, 'POST', {});
  let mark = await cursor(instance);
  for (const text of ['pause-one', 'pause-two']) {
    const sent = await lead.tool('send_chat', { chat: id.w1, text });
    assert.ok(sent.held, 'a paused sprint\'s worker took the lead\'s message: ' + JSON.stringify(sent));
  }
  // The press: desktop route, no fields, a sprint only; the lead hears of it once; the page and rows say Paused.
  assert.deepEqual([got.status, got.body], [200, { paused: true }]);
  assert.equal((await call(instance, `/sprints/${sprint}/pause`, 'POST', { by: 'x' })).status, 400, 'the press has no fields');
  assert.equal((await call(instance, `/sprints/${id.w1}/pause`, 'POST', {})).status, 404, 'a worker was paused as a sprint');
  assert.deepEqual((await call(instance, `/sprints/${sprint}/pause`, 'POST', {})).body, { paused: true, already: true });
  await until(instance, (e) => told(e, '[p9] The user paused'));
  assert.equal((await notices('[p9] The user paused')).length, 1, 'the lead was not told once');
  assert.equal((await call(instance, '/projects/' + project)).body.project.sprints.find((s) => s.lead === sprint).paused, true);
  const marked = Object.fromEntries((await rows(instance)).map((c) => [c.id, !!c.paused]));
  assert.deepEqual([marked[sprint], marked[id.w1], marked[id.w2], marked[first]], [true, true, true, false]);
  // O141 review 13: the lead sees it in list_chats (its usage watch settles no hold while paused).
  const listed = Object.fromEntries((await lead.tool('list_chats')).chats.map((c) => [c.id, c.paused]));
  assert.deepEqual([listed[id.w1], listed[id.w2]], [true, true], 'list_chats does not say the workers are paused');
  assert.equal((await w1.tool('pause_sprint')).error, 'not-a-sprint-lead');

  // A note passes (it starts nothing), a question from beside is refused, the lead opens no worker.
  assert.match((await lead.tool('send_chat', { chat: id.w1, text: 'a note', when: 'note' })).sent, /^as a note/);
  await call(instance, `/chat/${id.w1}/askable`, 'POST', { on: true });
  assert.equal((await w2.tool('ask_chat', { chat: id.w1, text: 'mode' })).error, 'sprint-paused');
  assert.equal((await lead.tool('open_chat', { text: 'x', key: 'paused-new' })).error, 'sprint-paused');
  assert.equal((await rows(instance)).length, 4, 'a chat was made while paused');
  await pause(1500);
  assert.deepEqual(await turns(id.w1, 'pause-', mark), [], 'a paused worker started a turn');
  assert.deepEqual((await events(instance, id.w1)).filter((e) => e.cursor > mark && e.type === 'held' && e.data.when === 'pause').map((e) => e.data.text), ['pause-one', 'pause-two']);
  // The owner's own message goes through.
  await call(instance, `/chat/${id.w1}/prompt`, 'POST', { text: 'owner-typed' });
  await until(instance, (e) => e.conversation === id.w1 && e.data?.content?.text?.includes('owner-typed'), mark);

  // O73 FIX1: the lead is renamed after it sent them; Resume still names it by the title it sent them under.
  const leadTitle = (await rows(instance)).find((c) => c.id === sprint).title;
  assert.equal((await call(instance, `/chat/${sprint}/rename`, 'POST', { title: 'Lead renamed' })).status, 200);

  // A restart keeps the pause and what it holds; nothing starts.
  instance.child.kill('SIGTERM'); await once(instance.child, 'exit');
  instance = await restart(t, instance, 'state-2');
  mark = await cursor(instance);
  await pause(2000);
  assert.equal((await rows(instance)).find((c) => c.id === id.w1).paused, true, 'the pause did not survive the restart');
  assert.deepEqual(await turns(id.w1, 'pause-', 0), [], 'a held message started a turn after the restart');

  // Resume: both, in order, each with its sender; the lead hears of it once; the marks go.
  got = await call(instance, `/sprints/${sprint}/resume`, 'POST', {});
  assert.deepEqual([got.status, got.body], [200, { paused: false, sent: 2 }]);
  await until(instance, (e) => e.conversation === id.w1 && e.data?.content?.text?.includes('pause-two'), mark);
  const sent = await turns(id.w1, 'pause-', mark);
  assert.deepEqual(sent.map((e) => [e.data.text.includes('pause-one') ? 'one' : 'two', e.data.from, e.data.fromTitle]), [['one', sprint, leadTitle], ['two', sprint, leadTitle]]);
  assert.notEqual(leadTitle, 'Lead renamed');
  await until(instance, (e) => told(e, '[p9] The user resumed'), mark);
  assert.deepEqual(await notices('[p9] The user resumed'), ['[p9] The user resumed this sprint. 2 kept messages sent in order.']);
  assert.equal((await rows(instance)).find((c) => c.id === id.w1).paused, undefined);
  assert.equal((await call(instance, '/projects/' + project)).body.project.sprints.find((s) => s.lead === sprint).paused, undefined);
  assert.deepEqual((await call(instance, `/sprints/${sprint}/resume`, 'POST', {})).body, { paused: false, already: true });

  // The lead's own tools from here (its old MCP client went with the restart).
  await call(instance, `/chat/${sprint}/prompt`, 'POST', { text: 'mcp' });
  let again = await attach(t, instance, sprint, mark);
  const isPaused = async () => !!(await rows(instance)).find((c) => c.id === sprint).paused;
  const approvals = async () => (await events(instance, sprint)).filter((e) => e.type === 'approval');
  const lock = async (on) => assert.equal((await call(instance, '/agent-lock', 'POST', { on })).status, 200);

  // The lock: an agent under it neither pauses nor resumes (the owner's press still does, above and below).
  await lock(true);
  assert.equal((await again.tool('pause_sprint')).error, 'agent-lock-on');
  await lock(false);
  assert.equal(await isPaused(), false, 'a locked agent paused its sprint');
  const lastMode = async (chat) => (await events(instance, chat)).filter((e) => e.type === 'mode').at(-1)?.data.name;
  mark = await cursor(instance);
  await call(instance, `/chat/${sprint}/prompt`, 'POST', { text: 'widened', mode: 'Auto' }); // the lock going off left it in Manual
  await until(instance, (e) => e.conversation === sprint && e.data?.content?.text?.includes('widened'), mark);

  // start_sprint makes no chat for a paused sprint: an added role, paused while the user is asked, then asked while paused.
  const rolesFile = path.join(prep.folder, 'roles.json'), plan = JSON.parse(fs.readFileSync(rolesFile, 'utf8'));
  fs.writeFileSync(rolesFile, JSON.stringify({ ...plan, roles: [...plan.roles, row('w3', 'haiku', 'low')] }));
  fs.writeFileSync(path.join(prep.folder, 'roles/w3.work.md'), 'mcp');
  const chatsBefore = (await rows(instance)).length, seen = (await approvals()).length;
  const starting = again.tool('start_sprint', { sprint });
  for (let i = 0; i < 100 && (await approvals()).length === seen; i += 1) await pause(100);
  const asked = (await approvals())[seen];
  assert.ok(asked, 'start_sprint did not ask');
  assert.deepEqual(await again.tool('pause_sprint'), { paused: true });
  await call(instance, `/chat/${sprint}/answer`, 'POST', { request: asked.data.request, answer: { optionId: 'allow' } });
  assert.equal((await starting).error, 'sprint-paused', 'a Pause during the question did not stop the start');
  assert.equal((await again.tool('start_sprint', { sprint })).error, 'sprint-paused');
  assert.equal((await approvals()).length, seen + 1, 'a paused sprint\'s start asked the user');
  assert.equal((await rows(instance)).length, chatsBefore, 'a paused sprint\'s start made a chat');

  // Kept while the lead runs in Auto; the lead is narrowed to Manual before Resume; the lock refuses resume_sprint.
  assert.equal(await lastMode(sprint), 'Auto');
  mark = await cursor(instance);
  for (const text of ['crash-one', 'crash-two', 'crash-three']) assert.ok((await again.tool('send_chat', { chat: id.w2, text })).held, text + ' was not kept');
  await lock(true);
  assert.equal((await again.tool('resume_sprint')).error, 'agent-lock-on');
  await lock(false);
  assert.equal(await isPaused(), true, 'a locked agent resumed its sprint');
  await call(instance, `/chat/${sprint}/prompt`, 'POST', { text: 'narrowed', mode: 'Manual' });
  await until(instance, (e) => e.conversation === sprint && e.data?.content?.text?.includes('narrowed'), mark);
  await pause(1000);
  assert.deepEqual(await turns(id.w2, 'crash-', mark), [], 'a locked resume_sprint sent what was kept');

  // A restart while Resume sends: the first message's agent never starts (hang-init), P9 stops dead, and the next start
  // sends the rest, each once, in the lead's mode now.
  const hang = path.join(instance.workspace, 'hang-init'); // every agent starts in the workspace; only w2's starts here
  instance.child.kill('SIGTERM'); await once(instance.child, 'exit');
  fs.writeFileSync(hang, '');
  instance = await restart(t, instance, 'state-3');
  mark = await cursor(instance);
  call(instance, `/sprints/${sprint}/resume`, 'POST', {}).catch(() => null);
  await until(instance, (e) => e.conversation === id.w2 && e.type === 'user' && e.data.text?.includes('crash-one'), mark);
  instance.child.kill('SIGKILL'); await once(instance.child, 'exit');
  fs.rmSync(hang);
  instance = await restart(t, instance, 'state-4');
  await until(instance, (e) => e.conversation === id.w2 && e.data?.content?.text?.includes('crash-three'), mark);
  await pause(1000);
  // O109 remainder: crash-one's user event was written but its agent never started, so P9 cannot know whether it got it:
  // it goes again, once, saying it may be a repeat (never lost, never a silent second copy).
  const went = await turns(id.w2, 'crash-', mark);
  // crash-two and crash-three may wait together behind it and go as one prompt: every name in each prompt counts.
  assert.deepEqual(went.flatMap((e) => e.data.text.match(/crash-\w+/g)), ['crash-one', 'crash-one', 'crash-two', 'crash-three'], 'a message was lost or sent twice');
  assert.ok(!went[0].data.repeat && went[1].data.repeat === true && went[1].data.text === went[0].data.text, 'the resent crash-one does not say it may be a repeat, or its text changed: ' + JSON.stringify(went.map((e) => [e.data.text, e.data.repeat])));
  const modes = (await events(instance, id.w2)).filter((e) => e.cursor > mark && e.type === 'mode').map((e) => e.data.name);
  assert.equal(modes.at(-1), 'Manual', 'a kept message ran wider than its sender is now: ' + JSON.stringify(modes));
  assert.equal(await isPaused(), false);

  // A restart while resumed messages wait in a running turn's queue (202 held, in memory only): they stay Resume's until
  // they reach the agent, so the next start sends them, each once, in order.
  mark = await cursor(instance);
  await call(instance, `/chat/${sprint}/prompt`, 'POST', { text: 'mcp' });
  again = await attach(t, instance, sprint, mark);
  assert.deepEqual(await again.tool('pause_sprint'), { paused: true });
  await call(instance, `/chat/${id.w2}/prompt`, 'POST', { text: 'slow' }); // the owner's own message goes through; its turn waits for a cancel
  await until(instance, (e) => e.conversation === id.w2 && e.type === 'user' && e.data.text === 'slow', mark);
  for (const text of ['queued-one', 'queued-two']) assert.ok((await again.tool('send_chat', { chat: id.w2, text })).held, text + ' was not kept');
  mark = await cursor(instance);
  call(instance, `/sprints/${sprint}/resume`, 'POST', {}).catch(() => null);
  for (const text of ['queued-one', 'queued-two']) await until(instance, (e) => e.conversation === id.w2 && e.type === 'held' && e.data.when === 'queue' && e.data.text?.includes(text), mark);
  instance.child.kill('SIGKILL'); await once(instance.child, 'exit');
  instance = await restart(t, instance, 'state-5');
  await until(instance, (e) => e.conversation === id.w2 && e.data?.content?.text?.includes('queued-two'), mark);
  await pause(1000);
  assert.deepEqual((await turns(id.w2, 'queued-', mark)).flatMap((e) => e.data.text.match(/queued-\w+/g)), ['queued-one', 'queued-two'], 'a message queued behind a running turn was lost or sent twice across a restart');

  // O109 FIX2 (Reviewer P2): a resend that may be a repeat, into a sprint paused again, keeps its label through the pause,
  // a crash just after the pause write and a restart while paused; Resume sends it once more, labelled, text unchanged.
  mark = await cursor(instance);
  await call(instance, `/chat/${sprint}/prompt`, 'POST', { text: 'mcp' });
  again = await attach(t, instance, sprint, mark);
  assert.deepEqual(await again.tool('pause_sprint'), { paused: true });
  assert.ok((await again.tool('send_chat', { chat: id.w2, text: 'replay-one' })).held, 'replay-one was not kept');
  instance.child.kill('SIGTERM'); await once(instance.child, 'exit');
  fs.writeFileSync(hang, '');
  instance = await restart(t, instance, 'state-6');
  mark = await cursor(instance);
  call(instance, `/sprints/${sprint}/resume`, 'POST', {}).catch(() => null);
  await until(instance, (e) => e.conversation === id.w2 && e.type === 'user' && e.data.text?.includes('replay-one'), mark);
  instance.child.kill('SIGKILL'); await once(instance.child, 'exit');
  fs.rmSync(hang);
  // Paused again while P9 is down, so the resend on the next start goes into the pause; and P9 dies just after that write.
  const ledgerFile = [path.join(instance.directory, 'p9-foundation/p9.db'), path.join(instance.directory, '.local/state/p9-foundation/p9.db')].find((f) => fs.existsSync(f));
  const ledger = new DatabaseSync(ledgerFile);
  ledger.prepare("INSERT INTO prefs (key, value) VALUES (?, '[]') ON CONFLICT(key) DO UPDATE SET value = '[]'").run('paused:' + sprint); ledger.close();
  const crashFile = path.join(instance.directory, 'crash-pause-write');
  fs.writeFileSync(crashFile, '');
  // The resend runs as P9 starts, so the crash can come before the start is done (daemon-exit): that is the crash.
  const crashed = await restart(t, instance, 'state-7').catch((e) => (/daemon-exit/.test(e.message) ? null : Promise.reject(e)));
  if (crashed) await Promise.race([once(crashed.child, 'exit'), pause(60000)]);
  assert.ok(!fs.existsSync(crashFile), 'the resend never reached the pause write');
  instance = await restart(t, instance, 'state-8');
  await pause(3000);
  const replays = async () => (await turns(id.w2, 'replay-one', mark)).map((e) => [e.data.text, e.data.repeat ?? false]);
  assert.equal((await replays()).length, 1, 'a paused sprint\'s worker was sent the resend: ' + JSON.stringify(await replays()));
  assert.equal(await isPaused(), true);
  call(instance, `/sprints/${sprint}/resume`, 'POST', {}).catch(() => null);
  for (let i = 0; i < 300 && (await replays()).length < 2; i += 1) await pause(100);
  await pause(3000);
  const [sent1, sent2, ...more] = await replays();
  assert.ok(sent2 && !more.length, 'replay-one was lost or sent more than twice: ' + JSON.stringify(await replays()));
  assert.ok(!sent1[1] && sent2[1] === true && sent2[0] === sent1[0], 'the resend through the pause lost its label, or its text changed: ' + JSON.stringify(await replays()));

  // O109 FIX2, rule 3b: what a turn's end drains into a sprint paused meanwhile leaves the turn's kept list in the same write
  // that pauses it, so a crash just after it sends it once on Resume, not twice.
  mark = await cursor(instance);
  await call(instance, `/chat/${sprint}/prompt`, 'POST', { text: 'mcp' });
  again = await attach(t, instance, sprint, mark);
  await call(instance, `/chat/${id.w2}/prompt`, 'POST', { text: 'gate' }); // the owner's own message: a turn that waits for 'go'
  await until(instance, (e) => e.conversation === id.w2 && e.data?.content?.text === 'gating', mark);
  assert.ok((await again.tool('send_chat', { chat: id.w2, text: 'drain-one', when: 'queue' })).held, 'drain-one was not held');
  assert.deepEqual(await again.tool('pause_sprint'), { paused: true });
  fs.writeFileSync(crashFile, '');
  fs.writeFileSync(path.join(instance.workspace, 'go'), '');
  await Promise.race([once(instance.child, 'exit'), pause(60000)]);
  assert.ok(!fs.existsSync(crashFile), 'the drain never reached the pause write');
  instance = await restart(t, instance, 'state-9');
  await pause(3000);
  const drained = async () => (await turns(id.w2, 'drain-one', mark)).length;
  assert.equal(await drained(), 0, 'a paused sprint\'s worker was sent the drained message');
  call(instance, `/sprints/${sprint}/resume`, 'POST', {}).catch(() => null);
  for (let i = 0; i < 300 && (await drained()) < 1; i += 1) await pause(100);
  await pause(3000);
  assert.equal(await drained(), 1, 'the drained message was lost or sent twice');

  // The cap: the lead's own pause (no note to itself), 100 kept, the 101st refused by name.
  mark = await cursor(instance);
  await call(instance, `/chat/${sprint}/prompt`, 'POST', { text: 'mcp' });
  again = await attach(t, instance, sprint, mark);
  assert.deepEqual(await again.tool('pause_sprint'), { paused: true });
  assert.equal((await notices('[p9] The user paused')).length, 1, 'the lead\'s own pause sent it a note');
  for (let i = 0; i < 100; i += 1) assert.ok((await again.tool('send_chat', { chat: id.w2, text: 'cap-' + i })).held, 'message ' + i + ' was not kept');
  got = await again.tool('send_chat', { chat: id.w2, text: 'cap-100' });
  assert.equal(got.reason ?? got.error, 'sprint-paused-full', JSON.stringify(got));
  console.log('PASS Pause sprint: held in order across a restart, resumed with senders; note and owner pass; ask_chat, open_chat, start_sprint refused; lock; senders\' mode now; a restart mid-Resume loses and repeats nothing, queued behind a running turn too; cap 100');
});

// O141 (review 14b): a lead holds one worker it started (pause_sprint with chat): P9 starts no turn for it on what agents
// send (kept, as under Pause), list_chats says held, the other worker goes on, and resume_sprint with chat delivers it.
test('Hold one worker: a held worker starts no turn for the lead\'s message, list_chats says held, its peer goes on, and release delivers what was kept', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const ws = instance.workspace, repo = path.join(ws, 'repo');
  fs.mkdirSync(repo); g(repo, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); g(repo, 'add', 'a.txt'); g(repo, 'commit', '-qm', 'a');
  await call(instance, '/file-protection', 'POST', { on: false });
  const project = (await call(instance, '/projects', 'POST', { name: 'Fresh', work: { kind: 'new', parent: '', name: 'fresh' } })).body.project.id;
  const first = (await call(instance, '/chat', 'POST', { provider: 'claude', project })).body.conversation;
  await call(instance, `/chat/${first}/prompt`, 'POST', { text: 'config' });
  await until(instance, (e) => e.conversation === first && e.data?.content?.text?.startsWith('config:'));
  const prep = (await call(instance, '/projects/' + project + '/sprints', 'POST', { title: 'P1' })).body, sprint = prep.sprint;
  const row = (key, model, effort) => ({ key, provider: 'claude', model, effort });
  fs.writeFileSync(path.join(prep.folder, 'roles.json'), JSON.stringify({ folder: 'repo', roles: [row('lead', 'opus', 'high'), row('w1', 'haiku', 'low'), row('w2', 'haiku', 'low')] }));
  for (const key of ['lead', 'w1', 'w2']) fs.writeFileSync(path.join(prep.folder, `roles/${key}.work.md`), 'mcp');
  const press = await call(instance, `/sprints/${sprint}/start`, 'POST', {});
  assert.equal(press.status, 200, JSON.stringify(press.body));
  const id = Object.fromEntries(press.body.chats.map((c) => [c.key, c.chat]));
  const lead = await attach(t, instance, sprint), w1 = await attach(t, instance, id.w1);
  for (const w of [id.w1, id.w2]) for (;;) { if (!(await lead.tool('wait_chat', { chat: w })).timedOut) break; }
  const turns = async (chat, text) => (await events(instance, chat)).filter((e) => e.type === 'user' && e.data.text?.includes(text));
  const listed = async () => Object.fromEntries((await lead.tool('list_chats')).chats.map((c) => [c.id, [c.held ?? false, c.paused ?? false]]));

  // Only the lead holds, and only a worker it started.
  assert.equal((await w1.tool('pause_sprint', { chat: id.w2 })).error, 'not-a-sprint-lead');
  assert.equal((await lead.tool('pause_sprint', { chat: first })).error, 'chat-not-found', 'a chat the lead did not start was held');
  assert.deepEqual(await lead.tool('pause_sprint', { chat: id.w1 }), { held: true });
  assert.deepEqual(await lead.tool('pause_sprint', { chat: id.w1 }), { held: true, already: true });
  let seen = await listed();
  assert.deepEqual([seen[id.w1], seen[id.w2]], [[true, false], [false, false]], 'list_chats: only w1 is held, and the sprint is not paused');

  // The lead's message to the held worker is kept and starts no turn; a note still arrives; the peer takes its message.
  const kept = await lead.tool('send_chat', { chat: id.w1, text: 'hold-one' });
  assert.ok(kept.held, 'the held worker took the lead\'s message: ' + JSON.stringify(kept));
  assert.equal(kept.sent, 'kept until its sprint resumes or its lead releases it');
  assert.match((await lead.tool('send_chat', { chat: id.w1, text: 'a note', when: 'note' })).sent, /^as a note/);
  assert.equal((await lead.tool('send_chat', { chat: id.w2, text: 'free-one' })).error, undefined);
  await until(instance, (e) => e.conversation === id.w2 && e.data?.content?.text?.includes('free-one'));
  await pause(1500);
  assert.deepEqual(await turns(id.w1, 'hold-one'), [], 'a held worker started a turn');

  // Release: what was kept goes out with its sender, and the flag goes.
  assert.deepEqual(await lead.tool('resume_sprint', { chat: id.w1 }), { held: false, sent: 1 });
  await until(instance, (e) => e.conversation === id.w1 && e.data?.content?.text?.includes('hold-one'));
  assert.deepEqual((await turns(id.w1, 'hold-one')).map((e) => e.data.from), [sprint]);
  seen = await listed();
  assert.deepEqual(seen[id.w1], [false, false], 'the released worker still says held');
  assert.deepEqual(await lead.tool('resume_sprint', { chat: id.w1 }), { held: false, already: true });

  // Close lets go of a held worker: nothing is kept for it after, and what it kept goes as Stop drops a queue.
  assert.deepEqual(await lead.tool('pause_sprint', { chat: id.w1 }), { held: true });
  assert.ok((await lead.tool('send_chat', { chat: id.w1, text: 'hold-two' })).held, 'hold-two was not kept');
  assert.equal((await call(instance, `/sprints/${sprint}/close`, 'POST', {})).status, 200);
  assert.equal((await rows(instance)).find((c) => c.id === id.w1).paused, undefined, 'Close left the worker held');
  assert.deepEqual((await events(instance, id.w1)).filter((e) => e.type === 'unheld' && e.data.text?.includes('hold-two')).map((e) => e.data.why), ['stopped']);
  console.log('PASS O141 hold one worker: kept while held, peer ran, note passed, release delivered in order with its sender; Close let go of it');
});
