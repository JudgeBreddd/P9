// O140: prompts the daemon sends at a time (schedule_prompt, list_schedules, remove_schedule). Split from
// delegate.test.mjs by O195, so neither file nears CI's per-file limit; the setup is delegate-helpers.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { restart } from './helpers.mjs';
import { start, call, pause, until, events, agent, connect, rows } from './delegate-helpers.mjs';

// O140: prompts the daemon sends at a time. Real minutes: the first run is 2 s out, then every minute, with a SIGTERM
// restart between the first and second run, so the second and third come from what the restarted daemon read back.
test('O140: a scheduled prompt fires at its time and every minute, across a daemon restart; a once prompt fires once and is gone; paused, it stops', { timeout: 300000 }, async (t) => {
  let instance = await start(t);
  await call(instance, '/file-protection', 'POST', { on: false });
  let a = await agent(t, instance);
  const soon = (s) => new Date(Date.now() + s * 1000).toISOString();
  const sent = async (word) => (await events(instance, a.conversation)).filter((e) => e.type === 'user' && e.data.text?.endsWith('\n\n' + word)).length;
  const reach = async (word, n, seconds) => { for (let i = 0; (await sent(word)) < n && i < seconds * 10; i += 1) await pause(100); return sent(word); };
  const tick = await a.tool('schedule_prompt', { text: 'tick', at: soon(2), every: 1 });
  assert.equal(tick.action, 'scheduled', JSON.stringify(tick));
  const single = await a.tool('schedule_prompt', { text: 'single', at: soon(30) });
  assert.equal(single.once, true, JSON.stringify(single));
  assert.equal((await a.tool('schedule_prompt', { text: 'x' })).error, 'request-refused', 'a schedule with no time was taken');
  assert.equal(await reach('tick', 1, 30), 1, 'the first run did not go');
  const first = (await events(instance, a.conversation)).find((e) => e.type === 'user' && e.data.text?.endsWith('\n\ntick'));
  assert.match(first.data.text, /^\[P9: your scheduled prompt .* not a message from the user\.\]/);
  instance.child.kill('SIGTERM');
  await once(instance.child, 'exit');
  instance = await restart(t, instance, 'state-2');
  assert.equal(await reach('tick', 3, 160), 3, 'after the restart the recurring prompt did not go twice more');
  assert.equal(await sent('single'), 1, 'the once prompt did not go exactly once');
  // Its old MCP client went with the restart: a new one from a fresh 'mcp' message.
  const fresh = (await call(instance, '/chat/events?after=0')).body.cursor;
  await call(instance, `/chat/${a.conversation}/prompt`, 'POST', { text: 'mcp' });
  a = await connect(t, instance, a.conversation, fresh);
  const kept = (await a.tool('list_schedules')).schedules;
  assert.deepEqual(kept.map((s) => [s.id, s.everyMinutes, s.paused]), [[tick.id, 1, false]], 'the once prompt is still listed, or the recurring one is gone');
  assert.match(kept[0].last, / sent$/);
  const paused = await a.tool('schedule_prompt', { id: tick.id, paused: true });
  assert.equal(paused.paused, true, JSON.stringify(paused));
  const wait = Date.parse(paused.nextRun) + 5000 - Date.now();
  await pause(Math.max(0, wait));
  assert.equal(await sent('tick'), 3, 'a paused prompt went');
  assert.equal((await a.tool('remove_schedule', { id: tick.id })).action, 'removed');
  assert.deepEqual((await a.tool('list_schedules')).schedules, []);
  console.log('PASS O140: tick went 3 times across a SIGTERM restart, the once prompt once and then off the list, nothing while paused; waited ' + Math.round(wait / 1000) + ' s past its next run');
});

// #266 FIX1: a worker's own scheduled prompt is P9's, so a paused sprint keeps it for Resume (S13); and a stopped worker
// woken by one takes a place under Workers per chat, so at the limit it starts nothing.
test('O140 FIX1: a worker\'s scheduled prompt waits while its sprint is paused and goes on Resume; a stopped worker\'s at Workers per chat starts nothing', { timeout: 200000 }, async (t) => {
  const instance = await start(t);
  await call(instance, '/file-protection', 'POST', { on: false });
  const a = await agent(t, instance);
  const made = await a.tool('open_chat', { text: 'mcp', key: 'w' }), w = await connect(t, instance, made.chat);
  await a.done(made.chat);
  const soon = (s) => new Date(Date.now() + s * 1000).toISOString();
  const turns = async (word) => (await events(instance, made.chat)).filter((e) => e.type === 'user' && e.data.text?.endsWith('\n\n' + word));
  assert.deepEqual(await a.tool('pause_sprint'), { paused: true });
  const wake = await w.tool('schedule_prompt', { text: 'wake', at: soon(2) });
  const cap = await w.tool('schedule_prompt', { text: 'cap', at: soon(90) }); // after the stop below; its client goes with it
  assert.deepEqual([wake.action, cap.action], ['scheduled', 'scheduled'], JSON.stringify([wake, cap]));
  await pause(6000);
  assert.deepEqual(await turns('wake'), [], 'a paused sprint\'s worker started a turn for its scheduled prompt');
  assert.ok((await events(instance, made.chat)).some((e) => e.type === 'held' && e.data.when === 'pause' && e.data.text.endsWith('\n\nwake')), 'it was not kept for Resume');
  assert.equal((await a.tool('resume_sprint')).sent, 1);
  await until(instance, (e) => e.conversation === made.chat && e.type === 'user' && e.data.text?.endsWith('\n\nwake'));
  await a.done(made.chat);
  // The worker is closed (stopped) and brought back from the archive; another takes the one place Workers per chat leaves.
  const other = await a.tool('open_chat', { text: 'hello', key: 'other' });
  await a.done(other.chat);
  assert.deepEqual((await a.tool('stop_chat', { chat: made.chat, close: true })).archived, [made.chat]);
  assert.equal((await a.tool('archive_chat', { chat: made.chat, archived: false })).action, 'unarchived'); // O132: closed is archived; back first
  await call(instance, '/delegation', 'POST', { start: 'agent', max: 1, workers: [] });
  assert.equal((await rows(instance)).find((c) => c.id === made.chat).state, 'stopped');
  assert.ok(Date.now() < Date.parse(cap.nextRun), 'the set-up ran past cap\'s time, so it went before the worker stopped');
  await pause(Math.max(0, Date.parse(cap.nextRun) + 6000 - Date.now()));
  assert.deepEqual(await turns('cap'), [], 'a stopped worker\'s scheduled prompt started it past Workers per chat');
  assert.equal((await rows(instance)).find((c) => c.id === made.chat).state, 'stopped');
  console.log('PASS O140 FIX1: wake kept while paused and sent on Resume; cap at Workers per chat 1 started nothing');
});

// O140, the other-chat path: a schedule aimed at another chat goes as the owner's send_chat with when: queue. A busy
// target keeps it until its turn ends; a once prompt goes once and leaves the owner's list.
test('O140 other chat: a once prompt scheduled to a busy chat waits for its turn to end, arrives once from its owner, and is gone', { timeout: 120000 }, async (t) => {
  const instance = await start(t);
  await call(instance, '/file-protection', 'POST', { on: false });
  const a = await agent(t, instance);
  const made = await a.tool('open_chat', { text: 'tools 3', title: 'Busy' }); // three 3 s tool calls: a turn of about 9 s
  const busy = await until(instance, (e) => e.conversation === made.chat && e.type === 'update' && e.data.sessionUpdate === 'tool_call');
  const later = await a.tool('schedule_prompt', { chat: made.chat, text: 'later', at: new Date(Date.now() + 2000).toISOString() });
  assert.deepEqual([later.action, later.chat, later.once], ['scheduled', made.chat, true], JSON.stringify(later));
  const held = await until(instance, (e) => e.conversation === made.chat && e.type === 'held' && e.data.text?.endsWith('later'), busy.cursor);
  assert.equal(held.hit.data.when, 'queue', JSON.stringify(held.hit.data));
  await until(instance, (e) => e.conversation === made.chat && e.type === 'user' && e.data.text?.endsWith('later'), held.cursor);
  await a.done(made.chat);
  await pause(3000); // nothing more comes for a once prompt
  const all = await events(instance, made.chat);
  const got = all.filter((e) => e.type === 'user' && e.data.text?.endsWith('later'));
  assert.equal(got.length, 1, 'the once prompt did not arrive exactly once');
  const at = all.indexOf(got[0]), heldAt = all.findIndex((e) => e.type === 'held' && e.data.text?.endsWith('later'));
  const ends = (from, to) => all.slice(from, to).filter((e) => e.type === 'turn-end').length;
  assert.equal(ends(0, heldAt), 0, 'it was held after the busy turn had already ended, so the test did not show the wait');
  assert.equal(ends(heldAt, at), 1, 'it did not wait for the running turn to end');
  assert.equal(got[0].data.from, a.conversation, 'it did not come from the chat that scheduled it');
  assert.deepEqual((await a.tool('list_schedules')).schedules, [], 'the once prompt is still listed');
  console.log('PASS O140 other chat: held while busy (when ' + held.hit.data.when + '), sent after its turn end, once, from its owner; list empty');
});

