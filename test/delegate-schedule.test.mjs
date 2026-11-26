// O140: prompts the daemon sends at a time (schedule_prompt, list_schedules, remove_schedule). Split from
// delegate.test.mjs by O195, so neither file nears CI's per-file limit; the setup is delegate-helpers.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
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


// O141: the lead's usage watch is its own scheduled prompt (sprint-files.mjs LEAD). Closing the sprint pauses every schedule
// its chats own, so a closed sprint's lead or worker is never woken by one; the schedules stay listed, paused.
// Review 2: a schedule due while Close is under way (here a blocking before-close script holds it 7 s, under the test's 10 s request limit), the worker's own or
// one a chat elsewhere in the project set for it, is not sent; nor can that chat set or turn one back on for it afterwards.
test('O141: closing a sprint pauses its chats\' scheduled prompts, so a closed lead and worker are not woken', { timeout: 180000 }, async (t) => {
  const instance = await start(t);
  await call(instance, '/file-protection', 'POST', { on: false });
  // A started sprint (Start refuses a model P9 has not seen, so one chat reads the model list first), its lead on 'mcp'.
  const warm = (await call(instance, '/chat', 'POST', { provider: 'claude' })).body.conversation;
  await call(instance, `/chat/${warm}/prompt`, 'POST', { text: 'config' });
  await until(instance, (e) => e.conversation === warm && e.data?.content?.text?.startsWith('config:'));
  const repo = path.join(instance.workspace, 'repo'); mkdirSync(repo);
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']); writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  execFileSync('git', ['-C', repo, 'add', '-A']); execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'a']);
  const project = (await call(instance, '/projects', 'POST', { name: 'Watch', work: { kind: 'new', parent: '', name: 'watch' } })).body.project.id;
  const sp = (await call(instance, '/projects/' + project + '/sprints', 'POST', { title: 'Watch' })).body, sprint = sp.sprint;
  const role = (key) => ({ key, provider: 'claude', model: 'haiku', effort: 'low' });
  writeFileSync(path.join(sp.folder, 'sprint.md'), '# Plan\n\n- [ ] a1: the piece. Role: w1.\n');
  writeFileSync(path.join(sp.folder, 'roles.json'), JSON.stringify({ folder: 'repo', roles: [role('lead')] }));
  writeFileSync(path.join(sp.folder, 'roles/lead.work.md'), 'mcp');
  const wait = path.join(instance.workspace, 'wait.mjs'); writeFileSync(wait, 'setTimeout(() => {}, 7000);');
  writeFileSync(path.join(sp.folder, 'hooks.json'), JSON.stringify({ scripts: [{ name: 'wait', command: process.execPath + ' ' + wait, point: 'before-close', blocking: true }] }));
  const hooks = (await call(instance, '/projects/' + project)).body.project.sprints.find((x) => x.lead === sprint).files.find((f) => f.name === 'hooks.json').hash;
  const started = await call(instance, `/sprints/${sprint}/start`, 'POST', { hooks }); assert.equal(started.status, 200, JSON.stringify(started));
  writeFileSync(path.join(sp.folder, 'roles.json'), JSON.stringify({ folder: 'repo', roles: ['lead', 'w1'].map(role) }));
  const L = await connect(t, instance, sprint);
  const made = await L.tool('open_chat', { text: 'mcp', key: 'w1' }); assert.ok(made.chat && !made.error, JSON.stringify(made));
  await L.done(made.chat);
  const w = await connect(t, instance, made.chat);
  const soon = (s) => new Date(Date.now() + s * 1000).toISOString();
  const o = await agent(t, instance, { project }); // a chat elsewhere in the same project
  const watch = await L.tool('schedule_prompt', { text: 'watch', at: soon(30), every: 10 });
  const wake = await w.tool('schedule_prompt', { text: 'wake', at: soon(30) });
  const later = await o.tool('schedule_prompt', { chat: made.chat, text: 'later', at: soon(300), paused: true });
  const began = Date.now();
  const early = await w.tool('schedule_prompt', { text: 'early', at: soon(3) }), nudge = await o.tool('schedule_prompt', { chat: made.chat, text: 'nudge', at: soon(3), every: 1 });
  assert.deepEqual([watch, wake, later, early, nudge].map((x) => x.action), Array(5).fill('scheduled'), JSON.stringify([watch, wake, later, early, nudge]));
  const closed = await call(instance, `/sprints/${sprint}/close`, 'POST', {});
  assert.equal(closed.status, 200, JSON.stringify(closed));
  assert.ok(Date.now() - began > 6000 && Date.now() < Date.parse(watch.nextRun), 'Close did not span the early schedules\' time, or ran past the others\'');
  await pause(Math.max(0, Date.parse(watch.nextRun) + 8000 - Date.now()));
  const got = async (id, word) => (await events(instance, id)).filter((e) => e.type === 'user' && e.data.text?.endsWith('\n\n' + word));
  assert.deepEqual(await got(sprint, 'watch'), [], 'a closed sprint\'s lead was woken by its schedule');
  assert.deepEqual(await got(made.chat, 'wake'), [], 'a closed sprint\'s worker was woken by its schedule');
  assert.deepEqual(await got(made.chat, 'early'), [], 'a schedule due during Close woke the worker');
  assert.deepEqual(await got(made.chat, 'nudge'), [], 'another chat\'s schedule woke a closed sprint\'s worker');
  assert.equal((await o.tool('schedule_prompt', { chat: made.chat, text: 'again', at: soon(60) })).error, 'sprint-closed', 'a new schedule for a closed sprint\'s worker was taken');
  assert.equal((await o.tool('schedule_prompt', { id: later.id, paused: false })).error, 'sprint-closed', 'a schedule for a closed sprint\'s worker was turned back on');
  assert.match((await o.tool('list_schedules')).schedules.find((x) => x.id === nudge.id).last, /not sent: sprint-closed/);
  // Kept, paused (read from the store: a closed chat's own tools are refused).
  const db = new DatabaseSync(path.join(instance.directory, '.local', 'state', 'p9-foundation', 'p9.db'), { timeout: 5000 }); t.after(() => db.close());
  assert.deepEqual(db.prepare("SELECT owner, paused FROM schedules WHERE text IN ('watch', 'wake') ORDER BY owner = ? DESC").all(sprint).map((r) => [r.owner, r.paused]), [[sprint, 1], [made.chat, 1]]);
  console.log('PASS O141: close paused the lead\'s and the worker\'s schedules; neither woke');
});

// O141 review 3: Close stops every chat of its sprint, but a prompt already on its way (a schedule sent just before Close)
// reads the project note before it connects an agent. A Stop during that read wins: nothing starts. The read is slowed
// (P9_NOTE_MS) so the Stop lands inside it every time.
test('O141: a Stop while a prompt reads its project note wins, so a prompt already on its way does not start after Close', { timeout: 120000 }, async (t) => {
  const instance = await start(t, { P9_NOTE_MS: '2500' });
  const chat = (await call(instance, '/chat', 'POST', { provider: 'codex', title: 'Stopped while starting' })).body.conversation;
  const prompting = call(instance, `/chat/${chat}/prompt`, 'POST', { text: 'hello' });
  await pause(800);
  const stopped = await call(instance, `/chat/${chat}/stop`, 'POST', {});
  assert.equal(stopped.status, 200, JSON.stringify(stopped));
  const sent = await prompting;
  assert.equal(sent.body?.error ?? sent.body?.reason, 'stopping', 'a prompt starting through a Stop was taken: ' + JSON.stringify(sent));
  await pause(1500);
  const types = (await events(instance, chat)).map((e) => e.type);
  assert.ok(!types.includes('user') && !types.includes('turn-end'), 'the prompt ran after Stop: ' + JSON.stringify(types));
});
