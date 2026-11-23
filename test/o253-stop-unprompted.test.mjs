import test from 'node:test';
import assert from 'node:assert/strict';
import { start, call, pause, until, events } from './delegate-helpers.mjs';

// O253 review round 1: the phone shows Stop on a run nobody prompted, so the daemon's cancel must take it. Before, it
// answered 409 no-turn (cancel needed a prompted turn). Now the agent is told to cancel and the run ends once.
test('O253: Stop on a run nobody prompted cancels it and ends it once', { timeout: 120000 }, async (t) => {
  const instance = await start(t);
  const chat = (await call(instance, '/chat', 'POST', { provider: 'claude', title: 'Unprompted stop' })).body.conversation;
  assert.equal((await call(instance, `/chat/${chat}/prompt`, 'POST', { text: 'background quiet' })).status, 202);
  await until(instance, (e) => e.conversation === chat && e.type === 'update' && e.data.toolCallId === 'bg-2');
  const listed = async () => (await call(instance, '/chat')).body.conversations.find((c) => c.id === chat);
  assert.equal((await listed()).unprompted, true, 'the list does not say a run nobody prompted is open (a phone row not loaded shows idle)');
  const stopped = await call(instance, `/chat/${chat}/cancel`, 'POST', {});
  assert.equal(stopped.status, 200, 'Stop on the unprompted run was refused: ' + JSON.stringify(stopped.body));
  const ends = (await events(instance, chat)).filter((e) => e.type === 'turn-end' && e.data.unprompted && e.data.stopReason === 'cancelled');
  assert.equal(ends.length, 1, 'the unprompted run did not end once at Stop');
  assert.equal((await listed()).unprompted, undefined, 'the list still says the stopped run is open');
  const steps = () => events(instance, chat).then((all) => all.filter((e) => /^bg-/.test(e.data?.toolCallId ?? '')).length);
  const before = await steps(); await pause(1500);
  assert.ok(await steps() <= before + 1, 'the agent kept working after Stop');
  assert.equal((await call(instance, `/chat/${chat}/cancel`, 'POST', {})).status, 409, 'a second Stop found a run still open');
});

// O253 review round 2: a run nobody prompted can ask a question. Stop declines it, so the agent's wait ends and nothing is
// left open on the daemon; before, the turn-end hid the card while the agent waited on it.
test('O253: Stop on a run nobody prompted that asked a question declines the question', { timeout: 120000 }, async (t) => {
  const instance = await start(t);
  const chat = (await call(instance, '/chat', 'POST', { provider: 'claude', title: 'Unprompted question' })).body.conversation;
  assert.equal((await call(instance, `/chat/${chat}/prompt`, 'POST', { text: 'background' })).status, 202);
  await until(instance, (e) => e.conversation === chat && e.type === 'question');
  assert.equal((await call(instance, `/chat/${chat}/cancel`, 'POST', {})).status, 200);
  await until(instance, (e) => e.conversation === chat && e.type === 'update' && e.data.content?.text === 'bg-ask:{"action":"cancel"}');
  const ends = (await events(instance, chat)).filter((e) => e.type === 'turn-end' && e.data.unprompted && e.data.stopReason === 'cancelled');
  assert.equal(ends.length, 1, 'the unprompted run did not end once at Stop');
});
