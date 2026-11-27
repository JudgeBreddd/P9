// O246: a chat's mode belongs to each message's sender. The owner's pick changes only with the owner's own message; another
// chat's message, or P9's own, runs in its own mode for that turn, and the chat goes back to the owner's pick after it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { restart } from './helpers.mjs';
import { start, call, pause, until, events, connect, rows } from './delegate-helpers.mjs';

// modes.log (fake-acp-agent.mjs): one line per prompted turn, the mode it ran in and its text.
const turns = (instance) => { const file = path.join(instance.workspace, 'modes.log'); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []; };
// The pill's mode: the newest mode event the lock did not write.
const pill = async (instance, id) => (await events(instance, id)).filter((e) => e.type === 'mode' && !e.data.lock).at(-1)?.data.name;
const quiet = async (instance, id) => { for (let i = 0; i < 300; i += 1) { const row = (await rows(instance)).find((c) => c.id === id); if (row.state !== 'turn') return; await pause(100); } assert.fail('still in a turn'); };
const said = (instance, id, text, after) => until(instance, (event) => event.conversation === id && event.data?.content?.text === text, after);
const mark = async (instance) => (await call(instance, '/chat/events?after=0&wait=0')).body.cursor;
// A chat the owner made and sent 'mcp' in mode, with the MCP client its agent was handed.
async function owned(t, instance, mode, more = {}) {
  const { body: { conversation } } = await call(instance, '/chat', 'POST', { provider: 'claude', ...more });
  await call(instance, `/chat/${conversation}/prompt`, 'POST', { text: 'mcp', mode });
  return connect(t, instance, conversation);
}

// An Auto chat B, the worker K it opened, and the owner's pick of Bypass on K.
async function pair(t) {
  const instance = await start(t);
  await call(instance, '/file-protection', 'POST', { on: false }); // Unrestricted: open_chat and schedule_prompt ask nothing
  fs.writeFileSync(path.join(instance.workspace, 'modes.log'), '');
  const b = await owned(t, instance, 'Auto');
  const made = await b.tool('open_chat', { text: 'mcp', title: 'Kid' });
  assert.equal(made.mode, 'Auto', JSON.stringify(made));
  const k = await connect(t, instance, made.chat);
  await quiet(instance, made.chat);
  assert.equal(await pill(instance, made.chat), 'Auto', 'a worker\'s first turn sets its pick');
  const at = await mark(instance);
  await call(instance, `/chat/${made.chat}/prompt`, 'POST', { text: 'mode', mode: 'Bypass permissions' });
  await said(instance, made.chat, 'mode:bypassPermissions', at);
  await quiet(instance, made.chat);
  return { instance, b, k, made };
}

test('O246: a message from an Auto chat runs a Bypass chat in Auto for that turn only; the pill and the owner\'s next message stay Bypass', { timeout: 240000 }, async (t) => {
  const { instance, b, made } = await pair(t);
  let at;
  // The Auto chat messages it: that turn runs in Auto (never wider than its sender) and says so on its message.
  at = await mark(instance);
  assert.equal((await b.tool('send_chat', { chat: made.chat, text: 'mode' })).sent, 'started a turn');
  await said(instance, made.chat, 'mode:auto', at);
  await quiet(instance, made.chat);
  assert.equal(await pill(instance, made.chat), 'Bypass permissions', 'another chat\'s message changed the owner\'s pick');
  // The owner's next message, naming no mode (the phone's "as set"), runs in the owner's pick.
  at = await mark(instance);
  await call(instance, `/chat/${made.chat}/prompt`, 'POST', { text: 'mode' });
  await said(instance, made.chat, 'mode:bypassPermissions', at);
  await quiet(instance, made.chat);
  // The mode each turn ran in is its own record, written as the prompt went: the Auto chat's labelled (not the pick), the owner's not.
  const ran = (await events(instance, made.chat)).filter((e) => e.type === 'ran' && e.cursor > at - 1000).map((e) => [e.data.name, e.data.label ?? false]);
  assert.deepEqual(ran.slice(-2), [['Auto', true], ['Bypass permissions', false]], 'the turn run in another mode does not say so: ' + JSON.stringify(ran));
  console.log('PASS O246 sender mode: the Auto chat\'s turn ran in Auto and said so; the pill and the owner\'s next message stayed Bypass');
});

test('O246: an owner message queued beside a P9 line runs in the owner\'s pick, as its own turn', { timeout: 240000 }, async (t) => {
  const { instance, b, k, made } = await pair(t);
  let at;
  // Queued together behind an Auto turn: a P9 line (the worker's own scheduled prompt) and the owner's message. Each runs in its
  // own sender's mode: P9's in the mode the chat's last turn ran in (that Auto turn), the owner's in the owner's pick.
  const before = turns(instance).length;
  assert.equal((await b.tool('send_chat', { chat: made.chat, text: 'tools 3' })).sent, 'started a turn');
  at = await mark(instance);
  const scheduled = await k.tool('schedule_prompt', { text: 'tick', at: new Date(Date.now() + 1000).toISOString() });
  assert.equal(scheduled.action, 'scheduled', JSON.stringify(scheduled));
  await until(instance, (e) => e.conversation === made.chat && e.type === 'held' && String(e.data.text).includes('scheduled prompt'), at);
  const mine = await call(instance, `/chat/${made.chat}/prompt`, 'POST', { text: 'mode', when: 'queue' });
  assert.equal(mine.status, 202);
  assert.ok(mine.body.held, 'the owner\'s message did not wait for the Auto turn: ' + JSON.stringify(mine.body));
  // Until the owner's text has run (alone or joined), then the chat is idle.
  for (let i = 0; i < 300 && !turns(instance).slice(before).some((x) => x.text.endsWith('mode')); i += 1) await pause(100);
  await quiet(instance, made.chat);
  const after = turns(instance).slice(before);
  assert.deepEqual(after.map((x) => [x.mode, x.text.endsWith('tick') ? 'tick' : x.text]), [['auto', 'tools 3'], ['auto', 'tick'], ['bypassPermissions', 'mode']], JSON.stringify(after));
  assert.equal(await pill(instance, made.chat), 'Bypass permissions');
  console.log('PASS O246 queued together: the P9 line ran in Auto, the owner\'s message in the owner\'s Bypass, as two turns');
});

test('O246: a restart notice runs in the mode the chat\'s last turn ran in (Bypass for one, Auto for the other), whatever Settings > New chats start in say', { timeout: 240000 }, async (t) => {
  let instance = await start(t);
  await call(instance, '/file-protection', 'POST', { on: false });
  fs.writeFileSync(path.join(instance.workspace, 'modes.log'), '');
  assert.equal((await call(instance, '/start-defaults', 'POST', { set: { claude: { mode: 'Plan' } } })).status, 200);
  // One: the owner's Bypass chat, its last turn the owner's own.
  const one = await owned(t, instance, 'Bypass permissions');
  await quiet(instance, one.conversation);
  // Two: also the owner's Bypass pick, but its last turn was an Auto chat's message (one in its project), so it ran in Auto.
  const project = (await call(instance, '/projects', 'POST', { name: 'Fresh', work: { kind: 'new', parent: '', name: 'fresh' } })).body.project.id;
  const two = await owned(t, instance, 'Bypass permissions', { project }), other = await owned(t, instance, 'Auto', { project });
  await quiet(instance, two.conversation);
  await quiet(instance, other.conversation);
  const sent = await other.tool('send_chat', { chat: two.conversation, text: 'hello' });
  assert.equal(sent.sent, 'started a turn', JSON.stringify(sent));
  await quiet(instance, two.conversation);
  assert.equal(turns(instance).filter((x) => x.text.endsWith('hello')).at(-1)?.mode, 'auto');
  // Each has a worker cut mid-turn by the restart.
  const kids = [await one.tool('open_chat', { text: 'slow', title: 'Busy one' }), await two.tool('open_chat', { text: 'slow', title: 'Busy two' })];
  for (const kid of kids) await until(instance, (event) => event.conversation === kid.chat && event.type === 'user');
  const at = await mark(instance);
  instance.child.kill('SIGTERM');
  await once(instance.child, 'exit');
  instance = await restart(t, instance, 'state-2');
  const lines = ['one', 'two'].map((n) => `[p9] P9 restarted. Interrupted mid-turn: Busy ${n}. Not resent.`);
  for (const [chat, line] of [[one.conversation, lines[0]], [two.conversation, lines[1]]]) await said(instance, chat, 'echo:' + line, at);
  const ran = lines.map((line) => turns(instance).filter((x) => x.text === line).map((x) => x.mode));
  assert.deepEqual(ran, [['bypassPermissions'], ['auto']], JSON.stringify(ran));
  assert.deepEqual([await pill(instance, one.conversation), await pill(instance, two.conversation)], ['Bypass permissions', 'Bypass permissions'], 'a notice changed the owner\'s pick');
  console.log('PASS O246 restart notice: one (last turn Bypass) ran it in Bypass, two (last turn Auto) in Auto, with Settings on Plan; both pills stayed Bypass');
});

// Round 2 (review findings 1, 2, 3, 5). Each asserts the mode the fake agent was prompted in (modes.log) or the chat's record of it.
const ranSince = (instance, before) => turns(instance).slice(before).map((x) => x.mode);

test('O246 r2: an owner "as set" message queued behind a wider kept message runs in the owner\'s pick, not joined into the wider turn', { timeout: 240000 }, async (t) => {
  const instance = await start(t);
  await call(instance, '/file-protection', 'POST', { on: false });
  fs.writeFileSync(path.join(instance.workspace, 'modes.log'), '');
  const b = await owned(t, instance, 'Bypass permissions');
  const made = await b.tool('open_chat', { text: 'mcp', title: 'Kid' });
  assert.ok(made.chat, JSON.stringify(made));
  await quiet(instance, made.chat);
  // The owner's Bypass turn runs; the Bypass chat queues a message (stamped Bypass); the owner's Manual message goes now.
  let at = await mark(instance);
  await call(instance, `/chat/${made.chat}/prompt`, 'POST', { text: 'slow', mode: 'Bypass permissions' });
  await said(instance, made.chat, 'working', at);
  assert.match((await b.tool('send_chat', { chat: made.chat, text: 'mode', when: 'queue' })).sent, /waiting/);
  await call(instance, `/chat/${made.chat}/prompt`, 'POST', { text: 'gate', mode: 'Manual', when: 'now' });
  await said(instance, made.chat, 'gating', at);
  const before = turns(instance).length;
  // The owner's "as set" (no mode named), queued while the Manual turn runs: the owner's pick is Manual now.
  assert.equal((await call(instance, `/chat/${made.chat}/prompt`, 'POST', { text: 'mode', when: 'queue' })).status, 202);
  fs.writeFileSync(path.join(instance.workspace, 'go'), '');
  for (let i = 0; i < 300 && turns(instance).length < before + 2; i += 1) await pause(100);
  await quiet(instance, made.chat);
  assert.deepEqual(ranSince(instance, before), ['bypassPermissions', 'default'], 'the owner\'s message ran in another sender\'s wider mode: ' + JSON.stringify(turns(instance).slice(before)));
  console.log('PASS O246 r2 finding 1: the kept Bypass message ran alone, the owner\'s "as set" ran in the owner\'s Manual');
});

test('O246 r2: the owner\'s named mode joined with a P9 line is the owner\'s pick; the lock going off is not', { timeout: 240000 }, async (t) => {
  const { instance, b, k, made } = await pair(t);
  // Behind an Auto turn: a P9 line (Auto, the last turn's mode) and the owner's message naming Auto join as one prompt.
  assert.equal((await b.tool('send_chat', { chat: made.chat, text: 'tools 3' })).sent, 'started a turn');
  let at = await mark(instance);
  assert.equal((await k.tool('schedule_prompt', { text: 'tick', at: new Date(Date.now() + 1000).toISOString() })).action, 'scheduled');
  await until(instance, (e) => e.conversation === made.chat && e.type === 'held' && String(e.data.text).includes('scheduled prompt'), at);
  assert.ok((await call(instance, `/chat/${made.chat}/prompt`, 'POST', { text: 'echo', mode: 'Auto', when: 'queue' })).body.held);
  for (let i = 0; i < 300 && !turns(instance).some((x) => x.text.endsWith('echo')); i += 1) await pause(100);
  await quiet(instance, made.chat);
  assert.equal(await pill(instance, made.chat), 'Auto', 'the owner\'s named Auto, joined with a P9 line, was not kept as the pick');
  let before = turns(instance).length;
  at = await mark(instance);
  await call(instance, `/chat/${made.chat}/prompt`, 'POST', { text: 'mode' });
  await said(instance, made.chat, 'mode:auto', at);
  await quiet(instance, made.chat);
  assert.deepEqual(ranSince(instance, before), ['auto']);
  // The owner picks Bypass; the lock goes on and off (the unlock puts the start mode back): "as set" is still Bypass.
  at = await mark(instance);
  await call(instance, `/chat/${made.chat}/prompt`, 'POST', { text: 'mode', mode: 'Bypass permissions' });
  await said(instance, made.chat, 'mode:bypassPermissions', at);
  await quiet(instance, made.chat);
  for (const on of [true, false]) assert.equal((await call(instance, '/agent-lock', 'POST', { on })).status, 200);
  await pause(500);
  before = turns(instance).length;
  at = await mark(instance);
  await call(instance, `/chat/${made.chat}/prompt`, 'POST', { text: 'mode' });
  await said(instance, made.chat, 'mode:bypassPermissions', at);
  await quiet(instance, made.chat);
  assert.deepEqual(ranSince(instance, before), ['bypassPermissions'], 'the lock going off became the owner\'s pick');
  console.log('PASS O246 r2 finding 2: a joined owner pick was kept (Auto); the unlock did not replace the pick (Bypass)');
});

test('O246 r2: a stopped worker\'s mode is the mode its last turn ran in; a narrower lead\'s queued message to a wider turn waits, then runs in the lead\'s mode', { timeout: 240000 }, async (t) => {
  const instance = await start(t);
  await call(instance, '/file-protection', 'POST', { on: false });
  const repo = path.join(instance.workspace, 'repo'), g = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: repo });
  fs.mkdirSync(repo); g('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); g('add', 'a.txt'); g('commit', '-qm', 'a');
  const project = (await call(instance, '/projects', 'POST', { name: 'Fresh', work: { kind: 'new', parent: '', name: 'fresh' } })).body.project.id;
  const first = (await call(instance, '/chat', 'POST', { provider: 'claude', project })).body.conversation; // P9 learns Claude's models
  await call(instance, `/chat/${first}/prompt`, 'POST', { text: 'config' });
  await until(instance, (e) => e.conversation === first && e.data?.content?.text?.startsWith('config:'));
  const prep = (await call(instance, '/projects/' + project + '/sprints', 'POST', { title: 'P1' })).body, sprint = prep.sprint;
  fs.writeFileSync(path.join(prep.folder, 'roles.json'), JSON.stringify({ folder: 'repo', roles: [['lead', 'opus', 'high'], ['w1', 'haiku', 'low']].map(([key, model, effort]) => ({ key, provider: 'claude', model, effort })) }));
  for (const key of ['lead', 'w1']) fs.writeFileSync(path.join(prep.folder, `roles/${key}.work.md`), 'mcp');
  const press = await call(instance, `/sprints/${sprint}/start`, 'POST', {});
  assert.equal(press.status, 200, JSON.stringify(press.body));
  const w1 = press.body.chats.find((c) => c.key === 'w1').chat, lead = await connect(t, instance, sprint);
  for (;;) { if (!(await lead.tool('wait_chat', { chat: w1 })).timedOut) break; }
  const log = path.join(instance.workspace, 'modes.log'); // every agent process starts in the workspace (the session's cwd is the worktree)
  fs.writeFileSync(log, '');
  const ran = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  // The lead narrowed to Manual; the owner picks Bypass on the worker.
  let at = await mark(instance);
  await call(instance, `/chat/${sprint}/prompt`, 'POST', { text: 'mode', mode: 'Manual' });
  await said(instance, sprint, 'mode:default', at);
  await quiet(instance, sprint);
  await call(instance, `/chat/${w1}/prompt`, 'POST', { text: 'mode', mode: 'Bypass permissions' });
  await said(instance, w1, 'mode:bypassPermissions', at);
  await quiet(instance, w1);
  // Finding 3: the lead's message runs in Manual; stopped, the worker's mode is the one its last turn ran in, not the pick.
  at = await mark(instance);
  assert.equal((await lead.tool('send_chat', { chat: w1, text: 'mode' })).sent, 'started a turn');
  await said(instance, w1, 'mode:default', at);
  await quiet(instance, w1);
  assert.equal((await call(instance, `/chat/${w1}/stop`, 'POST', {})).status, 200);
  for (let i = 0; i < 100 && (await rows(instance)).find((c) => c.id === w1).state !== 'stopped'; i += 1) await pause(100);
  const shown = (await call(instance, `/sprints/${sprint}/status`)).body.workers.find((w) => w.key === 'w1');
  assert.equal(shown.mode, 'Manual', 'a stopped worker\'s mode widened to the owner\'s pick: ' + JSON.stringify(shown.mode));
  // Finding 5: the owner's Bypass turn runs; a steer from the lead would join it (still refused), a queued message only waits.
  at = await mark(instance);
  await call(instance, `/chat/${w1}/prompt`, 'POST', { text: 'gate', mode: 'Bypass permissions' });
  await said(instance, w1, 'gating', at);
  const before = ran().length;
  assert.equal((await lead.tool('send_chat', { chat: w1, text: 'mode', when: 'steer' })).error, 'mode-escalation');
  const queued = await lead.tool('send_chat', { chat: w1, text: 'mode', when: 'queue' });
  assert.ok(queued.held, 'a queued message to a wider turn was refused: ' + JSON.stringify(queued));
  fs.writeFileSync(path.join(path.dirname(log), 'go'), '');
  await said(instance, w1, 'mode:default', at);
  await quiet(instance, w1);
  assert.deepEqual(ran().slice(before).map((x) => x.mode), ['default'], 'the lead\'s message ran wider than the lead: ' + JSON.stringify(ran().slice(before)));
  console.log('PASS O246 r2 findings 3 and 5: the queued message waited and ran in Manual; the stopped worker reads Manual');
});
