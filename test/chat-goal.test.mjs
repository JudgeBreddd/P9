// A2 step 5 (goal, server half): the goal an agent keeps reaches its parent in read_chat, list_chats and wait_chat, from
// the session_info_update _meta claude-agent-acp sends a client that declares the extension (the stand-in agent's
// 'goal <json>' sends the same); a chat with none has none, a clear removes it, junk is not a goal, a restart keeps it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { restart } from './helpers.mjs';
import { start, call, agent, connect, until, pause } from './delegate-helpers.mjs';

test('A2 goal: an agent\'s goal reaches read_chat, list_chats and wait_chat; none, cleared and junk give none; a restart keeps it', { timeout: 240000 }, async (t) => {
  let instance = await start(t);
  await call(instance, '/file-protection', 'POST', { on: false });
  let a = await agent(t, instance);
  const made = await a.tool('open_chat', { text: 'title Kid', title: 'Kid', key: 'kid' });
  const kid = made.chat;
  const goalIn = async () => {
    const read = await a.tool('read_chat', { chat: kid }), row = (await a.tool('list_chats')).chats.find((c) => c.id === kid), wait = await a.done(kid);
    return [read.goal, row.goal, wait.goal];
  };
  const now = async () => (await call(instance, '/chat/events?after=0&wait=0')).body.cursor;
  const tell = async (text) => { const from = await now(); await a.tool('send_chat', { chat: kid, text }); await until(instance, (e) => e.conversation === kid && e.data?.content?.text === 'goal sent', from); };
  await a.done(kid);
  // None yet, and a title-only session_info_update is not a goal.
  assert.deepEqual(await goalIn(), [undefined, undefined, undefined], 'a chat with no goal has none');
  // Set: only the objective (trimmed) and its status are given out.
  await tell('goal {"objective":"  ship B1  ","status":"active","iterations":2,"lastReason":"x","controlMethod":"_session/goal"}');
  const shipB1 = { objective: 'ship B1', status: 'active' };
  assert.deepEqual(await goalIn(), [shipB1, shipB1, shipB1]);
  // Junk is not a goal and leaves the last one; other _meta is not either.
  await tell('goal {"objective":5}');
  await tell('goal {"objective":"   "}');
  await tell('goal-raw {"jetbrains":{"air":{"version":1,"plan":"x"}}}');
  assert.deepEqual(await goalIn(), [shipB1, shipB1, shipB1], 'junk replaced the goal');
  // Cut to size; a status left out is active.
  await tell(`goal ${JSON.stringify({ objective: 'y'.repeat(3000), status: 'blocked'.repeat(10) })}`);
  assert.deepEqual((await goalIn())[0], { objective: 'y'.repeat(2000), status: 'blocked'.repeat(10).slice(0, 20) });
  await tell('goal {"objective":"merge #493","status":"paused"}');
  const merge = { objective: 'merge #493', status: 'paused' };
  assert.deepEqual(await goalIn(), [merge, merge, merge]);
  // A daemon restart keeps it: read back from the ledger, not memory, past junk said after it (the newest update read back).
  await tell('goal {"objective":7}');
  const again = async (name) => {
    instance.child.kill('SIGTERM'); await once(instance.child, 'exit');
    instance = await restart(t, instance, name);
    const cursor = await now();
    // O271: the restart may cut the kid mid-turn ('goal sent' can come before its turn end), and P9's restart line then
    // runs a turn on a; a plain 'mcp' that met it was steered in and never answered 'mcp:'. Queued, it waits for that turn.
    let asked;
    for (let i = 0; i < 100 && (asked = await call(instance, `/chat/${a.conversation}/prompt`, 'POST', { text: 'mcp', when: 'queue' })).status === 409; i += 1) await pause(100);
    assert.ok([200, 202].includes(asked.status), JSON.stringify([asked.status, asked.body]));
    a = await connect(t, instance, a.conversation, cursor);
  };
  await again('state-2');
  assert.deepEqual(await goalIn(), [merge, merge, merge], 'the restart lost the goal');
  // Cleared (null): none again, and still none after a restart (the stored null is read back, not the goal before it).
  await tell('goal null');
  assert.deepEqual(await goalIn(), [undefined, undefined, undefined], 'a cleared goal is still given');
  await again('state-3');
  assert.deepEqual(await goalIn(), [undefined, undefined, undefined], 'a restart brought back a cleared goal');
  // An update over the stored-event size (70 KB of other _meta): its set and its clear both still hold after a restart.
  const big = { objective: 'big set', status: 'active' };
  await tell('goal-pad {"objective":"big set"}');
  assert.deepEqual(await goalIn(), [big, big, big]);
  await again('state-4');
  assert.deepEqual(await goalIn(), [big, big, big], 'a restart lost an oversized update\'s goal');
  await tell('goal-pad null');
  assert.deepEqual(await goalIn(), [undefined, undefined, undefined], 'an oversized clear was not kept');
  await again('state-5');
  assert.deepEqual(await goalIn(), [undefined, undefined, undefined], 'a restart brought back the goal an oversized update cleared');
});
