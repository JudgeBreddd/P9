// O231: the CLI ends a call it cuts short with "The user doesn't want to take this action right now. STOP ...", whoever
// cut it. A steer, a P9 restart and another chat's stop_chat are not the user, so the agent's next text says what cut it;
// the user's own Stop adds nothing. The stand-in agent writes those P9 lines to cut.log (test/fake-acp-agent.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { restart } from './helpers.mjs';
import { start, call, until, pause, agent } from './delegate-helpers.mjs';

const WORDS = '"The user doesn\'t want to take this action right now. STOP what you are doing and wait for the user"';
const cuts = (dir) => { try { return fs.readFileSync(path.join(dir, 'cut.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const echoed = (instance, id, text, after) => until(instance, (e) => e.conversation === id && e.data?.content?.text === 'echo:' + text, after);
const cursor = async (instance) => (await call(instance, '/chat/events?after=0')).body.cursor;

test('O231 steer: a message steered into a running turn says it is what cut a call short, not a stop from the user', { timeout: 120000 }, async (t) => {
  const instance = await start(t);
  await call(instance, '/file-protection', 'POST', { on: false });
  const a = await agent(t, instance);
  const made = await a.tool('open_chat', { text: 'slow', title: 'Worker' });
  const dir = path.resolve(instance.workspace, made.folder ?? '.');
  await until(instance, (e) => e.conversation === made.chat && e.type === 'user');
  const sent = await a.tool('send_chat', { chat: made.chat, text: 'change of plan', when: 'steer' });
  assert.ok(!sent.error, JSON.stringify(sent));
  for (let i = 0; i < 100 && !fs.readFileSync(path.join(dir, 'steers.log'), { flag: 'a+' }).toString().includes('change of plan'); i += 1) await pause(100);
  const lines = cuts(dir);
  assert.equal(lines.length, 1, 'the steer carried no line saying what cut the call: ' + JSON.stringify(lines));
  assert.ok(lines[0].startsWith('[P9: this message was steered into your running turn.') && lines[0].includes(WORDS) && lines[0].includes('not a stop from the user'), lines[0]);
  console.log('PASS O231 steer line');
});

test('O231 stop_chat: the next prompt after another chat interrupted the turn names that chat, once; the user\'s own Stop adds nothing', { timeout: 120000 }, async (t) => {
  const instance = await start(t);
  await call(instance, '/file-protection', 'POST', { on: false });
  const a = await agent(t, instance);
  const made = await a.tool('open_chat', { text: 'slow', title: 'Worker' });
  const dir = path.resolve(instance.workspace, made.folder ?? '.');
  await until(instance, (e) => e.conversation === made.chat && e.type === 'user');
  assert.equal((await a.tool('stop_chat', { chat: made.chat })).action, 'interrupted');
  await until(instance, (e) => e.conversation === made.chat && e.type === 'turn-end');
  let mark = await cursor(instance);
  assert.ok(!(await a.tool('send_chat', { chat: made.chat, text: 'after stop' })).error);
  await echoed(instance, made.chat, 'after stop', mark);
  const lines = cuts(dir);
  assert.equal(lines.length, 1, 'the prompt after stop_chat carried no line saying what cut the turn: ' + JSON.stringify(lines));
  assert.ok(lines[0].startsWith('[P9: your last turn was cut short by stop_chat from another chat\'s agent, "') && lines[0].includes(`(chat ${a.conversation}), not by the user.`) && lines[0].includes(WORDS), lines[0]);
  // Once: the prompt after that has none.
  mark = await cursor(instance);
  assert.ok(!(await a.tool('send_chat', { chat: made.chat, text: 'second' })).error);
  await echoed(instance, made.chat, 'second', mark);
  assert.equal(cuts(dir).length, 1, 'the line went twice');
  // The user's Stop: their own, so the next prompt says nothing about it.
  mark = await cursor(instance);
  assert.equal((await call(instance, `/chat/${made.chat}/prompt`, 'POST', { text: 'slow' })).status, 202);
  await until(instance, (e) => e.conversation === made.chat && e.type === 'user', mark);
  assert.equal((await call(instance, `/chat/${made.chat}/cancel`, 'POST', {})).status, 200);
  await until(instance, (e) => e.conversation === made.chat && e.type === 'turn-end', mark);
  mark = await cursor(instance);
  assert.equal((await call(instance, `/chat/${made.chat}/prompt`, 'POST', { text: 'after my stop' })).status, 202);
  await echoed(instance, made.chat, 'after my stop', mark);
  assert.equal(cuts(dir).length, 1, 'the user\'s own Stop was said to be someone else\'s: ' + JSON.stringify(cuts(dir)));
  console.log('PASS O231 stop_chat line, once; none for the user\'s Stop');
});

test('O231 restart: a chat a P9 restart cut mid-turn is told so with its next prompt, even after a second restart, once', { timeout: 240000 }, async (t) => {
  let instance = await start(t);
  await call(instance, '/file-protection', 'POST', { on: false });
  const a = await agent(t, instance);
  const made = await a.tool('open_chat', { text: 'slow', title: 'Worker' });
  const dir = path.resolve(instance.workspace, made.folder ?? '.');
  await until(instance, (e) => e.conversation === made.chat && e.type === 'user');
  const again = async (name) => { instance.child.kill('SIGTERM'); await once(instance.child, 'exit'); instance = await restart(t, instance, name); };
  await again('state-2');
  await again('state-3'); // the chat was idle at this one: what cut it is still said
  await call(instance, '/chat');
  let mark = await cursor(instance);
  assert.equal((await call(instance, `/chat/${made.chat}/prompt`, 'POST', { text: 'back' })).status, 202);
  await echoed(instance, made.chat, 'back', mark);
  const lines = cuts(dir);
  assert.equal(lines.length, 1, 'the prompt after the restart carried no line saying what cut the turn: ' + JSON.stringify(lines));
  assert.ok(lines[0].startsWith('[P9: your last turn was cut short by a P9 restart, not by the user.') && lines[0].includes(WORDS), lines[0]);
  mark = await cursor(instance);
  assert.equal((await call(instance, `/chat/${made.chat}/prompt`, 'POST', { text: 'again' })).status, 202);
  await echoed(instance, made.chat, 'again', mark);
  assert.equal(cuts(dir).length, 1, 'the line went twice');
  console.log('PASS O231 restart line, kept across a second restart, once');
});

test('O231 failed prompt: a prompt that failed after taking the restart line leaves it for the next one', { timeout: 240000 }, async (t) => {
  let instance = await start(t);
  await call(instance, '/file-protection', 'POST', { on: false });
  const a = await agent(t, instance);
  const made = await a.tool('open_chat', { text: 'slow', title: 'Worker' });
  const dir = path.resolve(instance.workspace, made.folder ?? '.');
  await until(instance, (e) => e.conversation === made.chat && e.type === 'user');
  instance.child.kill('SIGTERM'); await once(instance.child, 'exit'); instance = await restart(t, instance, 'state-2');
  await call(instance, '/chat');
  let mark = await cursor(instance);
  assert.equal((await call(instance, `/chat/${made.chat}/prompt`, 'POST', { text: 'auth-required' })).status, 202);
  await until(instance, (e) => e.conversation === made.chat && e.type === 'error', mark);
  mark = await cursor(instance);
  assert.equal((await call(instance, `/chat/${made.chat}/prompt`, 'POST', { text: 'back' })).status, 202);
  await echoed(instance, made.chat, 'back', mark);
  const lines = cuts(dir);
  assert.ok(lines.length === 2 && lines.every((l) => l.startsWith('[P9: your last turn was cut short by a P9 restart, not by the user.')), 'the failed prompt used up the line: ' + JSON.stringify(lines));
  console.log('PASS O231 failed prompt keeps the line');
});
