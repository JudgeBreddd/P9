// O265: a restart drops the agent's goal, and the goal line keeps showing it. The line's Set again sends the stored
// active goal back to the agent once per start (the agent reports it again); a stored clear is never set again; Clear
// removes the line and the agent's goal. Through the daemon's own route (POST /chat/:id/goal), the stand-in agent
// answering '/goal' as claude-agent-acp does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { restart } from './helpers.mjs';
import { start, call, agent, until, rows } from './delegate-helpers.mjs';

test('O265: Set again sends a stored active goal back once after a restart; a stored clear is not set again; Clear removes it', { timeout: 240000 }, async (t) => {
  let instance = await start(t);
  await call(instance, '/file-protection', 'POST', { on: false });
  const a = await agent(t, instance);
  const kid = (await a.tool('open_chat', { text: 'title Kid', title: 'Kid', key: 'kid' })).chat;
  await a.done(kid);
  const now = async () => (await call(instance, '/chat/events?after=0&wait=0')).body.cursor;
  const goalOf = async () => (await rows(instance)).find((c) => c.id === kid).goal;
  const goal = (action) => call(instance, `/chat/${kid}/goal`, 'POST', { action });
  const agentSaid = (objective, from) => until(instance, (e) => e.conversation === kid && e.type === 'update' && e.data?._meta?.jetbrains?.air
    && Object.hasOwn(e.data._meta.jetbrains.air, 'goal') && (objective === null ? e.data._meta.jetbrains.air.goal === null : e.data._meta.jetbrains.air.goal?.objective === objective), from);
  const again = async (name) => { instance.child.kill('SIGTERM'); await once(instance.child, 'exit'); instance = await restart(t, instance, name); };
  // Nothing stored: nothing to set again.
  assert.equal((await goal('set')).status, 409, 'a chat with no goal set one');
  assert.equal((await goal('bogus')).status, 400);
  let from = await now();
  await a.tool('send_chat', { chat: kid, text: 'goal {"objective":"ship B1","status":"active"}' });
  await until(instance, (e) => e.conversation === kid && e.data?.content?.text === 'goal sent', from);
  assert.deepEqual(await goalOf(), { objective: 'ship B1', status: 'active' });
  // The agent that said it still has it: no second set into the same run.
  const held = await goal('set');
  assert.deepEqual([held.status, held.body?.error ?? held.error], [409, 'goal-held'], 'set again into the run that has it');
  // After a restart the line still shows it, and Set again goes to the agent as '/goal ship B1' alone; the agent reports it.
  await again('state-2');
  assert.deepEqual(await goalOf(), { objective: 'ship B1', status: 'active' }, 'the restart lost the stored goal');
  from = await now();
  const sent = await goal('set');
  assert.equal(sent.status, 200, JSON.stringify(sent));
  const said = await agentSaid('ship B1', from);
  assert.ok(said.hit, 'the agent did not report the goal again');
  const user = (await call(instance, `/chat/events?after=${from}&only=${kid}`)).body.events.find((e) => e.type === 'user');
  assert.deepEqual([user?.data?.text, user?.data?.command], ['/goal ship B1', true], 'the goal went alone, as a command');
  await until(instance, (e) => e.conversation === kid && e.type === 'turn-end', from);
  assert.equal((await goal('set')).status, 409, 'once per start: a second set went too');
  // Clear: the line goes at once (P9 stores the clear) and the agent clears its own ('/goal clear').
  from = await now();
  const cleared = await goal('clear');
  assert.equal(cleared.status, 200, JSON.stringify(cleared));
  assert.equal(await goalOf(), null, 'Clear left the line');
  const user2 = await until(instance, (e) => e.conversation === kid && e.type === 'user' && e.data?.text === '/goal clear', from);
  assert.ok(user2.hit, 'the agent was not told to clear its goal');
  await until(instance, (e) => e.conversation === kid && e.type === 'turn-end', from);
  // A stored clear is not set again, after a restart too.
  await again('state-3');
  assert.equal(await goalOf(), null, 'a restart brought back a cleared goal');
  const none = await goal('set');
  assert.deepEqual([none.status, none.body?.error ?? none.error], [409, 'no-goal'], 'a stored clear was set again');
  console.log('PASS O265: set again once after a restart, the agent reports it; a clear is kept and not set again');
});
