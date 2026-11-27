// O246: a chat's mode belongs to each message's sender. The owner's pick changes only with the owner's own message; another
// chat's message, or P9's own, runs in its own mode for that turn, and the chat goes back to the owner's pick after it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
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
  const sent = (await events(instance, made.chat)).filter((e) => e.type === 'user' && e.data.from === b.conversation).at(-1);
  assert.equal(sent.data.ranIn, 'Auto', 'the turn run in another mode does not say so');
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
