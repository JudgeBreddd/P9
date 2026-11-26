// O109 and O125 point 5: what waits for a turn's end.
// O109 rule: no held message is ever lost, whether the user or an agent sent it, including across a daemon restart.
// A message queued for a turn's end, then P9 stops before that end: after the restart it is delivered exactly once,
// under its own sender, and a second restart does not send it again.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { restart } from './helpers.mjs';
import { start, call, until, events, agent, pause, connect } from './delegate-helpers.mjs';
import { DatabaseSync } from 'node:sqlite';

test('O109: a message held for a turn\'s end survives a daemon restart and is delivered exactly once, under its own sender', { timeout: 240000 }, async (t) => {
  let instance = await start(t);
  await call(instance, '/file-protection', 'POST', { on: false });
  const a = await agent(t, instance);
  const made = await a.tool('open_chat', { text: 'gate', title: 'Target' });
  await until(instance, (event) => event.conversation === made.chat && event.data?.content?.text === 'gating');
  const mine = await call(instance, `/chat/${made.chat}/prompt`, 'POST', { text: 'held from the user', when: 'queue' });
  assert.equal(mine.status, 202, JSON.stringify(mine.body));
  assert.ok(mine.body.held, 'the user\'s message was not held: ' + JSON.stringify(mine.body));
  const theirs = await a.tool('send_chat', { chat: made.chat, text: 'held from the agent', when: 'queue' });
  assert.ok(theirs.held, 'the agent\'s message was not held: ' + JSON.stringify(theirs));
  const again = async (name) => { instance.child.kill('SIGTERM'); await once(instance.child, 'exit'); instance = await restart(t, instance, name); };
  const sent = async (text) => (await events(instance, made.chat)).filter((e) => e.type === 'user' && String(e.data?.text).includes(text));
  await again('state-2');
  for (let i = 0; i < 300 && ((await sent('held from the user')).length < 1 || (await sent('held from the agent')).length < 1); i += 1) await pause(100);
  const user = await sent('held from the user'), other = await sent('held from the agent');
  const trail = JSON.stringify((await events(instance, made.chat)).filter((e) => ['held', 'unheld', 'user', 'interrupted', 'turn-end'].includes(e.type)).map((e) => [e.type, e.data?.why ?? e.data?.reason ?? String(e.data?.text ?? '').slice(-40)]));
  assert.equal(user.length, 1, 'the user\'s held message after the restart: ' + trail);
  assert.equal(other.length, 1, 'the agent\'s held message after the restart: ' + trail);
  // Each under its own sender: the agent's line names its chat, and the user's text is never under that label.
  const text = (e) => String(e.data.text);
  const AGENT = `[P9: from another chat's agent, not from the user. Sender: "`;
  assert.ok(text(other[0]).includes(AGENT) && text(other[0]).includes(`(chat ${a.conversation})`) || other[0].data.from === a.conversation, 'the agent\'s message lost its sender: ' + JSON.stringify(other[0].data));
  assert.ok(user[0].data.from === undefined || user[0].data.from === null || text(user[0]).includes('[P9: from the user, in this chat.]'), 'the user\'s message went under another sender: ' + JSON.stringify(user[0].data));
  // Once: a second restart after it went sends nothing again.
  await again('state-3');
  await call(instance, '/chat');
  await pause(5000);
  assert.deepEqual([(await sent('held from the user')).length, (await sent('held from the agent')).length], [1, 1], 'a held message went twice');
  console.log('PASS O109 held across restart: the user\'s and the agent\'s held messages went once each after a SIGTERM restart, under their senders, and not again after a second restart');
});

// A2 step 3: an edit of a held message is in the restart copy: after a restart it goes once, with the edited words only.
test('A2 step 3: a queued message edited before a daemon restart goes once after it, with the edited words', { timeout: 240000 }, async (t) => {
  let instance = await start(t);
  await call(instance, '/file-protection', 'POST', { on: false });
  const a = await agent(t, instance);
  const made = await a.tool('open_chat', { text: 'gate', title: 'Target' });
  await until(instance, (event) => event.conversation === made.chat && event.data?.content?.text === 'gating');
  const mine = await call(instance, `/chat/${made.chat}/prompt`, 'POST', { text: 'held before the edit', when: 'queue' });
  assert.ok(mine.body.held, 'not held: ' + JSON.stringify(mine.body));
  const edit = await call(instance, `/chat/${made.chat}/held-text`, 'POST', { held: mine.body.held, text: 'held, then edited', was: 'held before the edit' });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  instance.child.kill('SIGTERM'); await once(instance.child, 'exit'); instance = await restart(t, instance, 'state-2');
  const sent = async (text) => (await events(instance, made.chat)).filter((e) => e.type === 'user' && String(e.data?.text).includes(text));
  for (let i = 0; i < 300 && (await sent('held, then edited')).length < 1; i += 1) await pause(100);
  await pause(3000);
  assert.deepEqual([(await sent('held, then edited')).length, (await sent('held before the edit')).length], [1, 0], 'after the restart: the edit once, the old words never');
  console.log('PASS A2 step 3 restart: an edited queued message went once after a SIGTERM restart, with the edited words');
});

// O125 point 5: a lead busy in a turn (no steering, as Claude on ACP 2) while 4 workers end 10 turns each (40 end
// notes) and the coordinator queues a message and then replaces it. At the turn's end everything waiting goes as ONE
// prompt: each worker's newest note only (4), and only the coordinator's replacement (1).
test('O125 point 5: 40 notes from 4 workers and 2 coordinator messages, the second replacing the first, arrive as one prompt with 4 notes and 1 coordinator message', { timeout: 300000 }, async (t) => {
  const instance = await start(t, { P9_WAKE_AFTER_MS: '2000' });
  await call(instance, '/file-protection', 'POST', { on: false });
  const project = (await call(instance, '/projects', 'POST', { name: 'Fresh', work: { kind: 'new', parent: '', name: 'fresh' } })).body.project.id;
  const folder = path.join(instance.workspace, 'fresh');
  for (const dir of [instance.workspace, folder]) fs.writeFileSync(path.join(dir, 'no-steering'), ''); // the adapter's own cwd
  const lead = await agent(t, instance, { project }), coordinator = await agent(t, instance, { project });
  assert.equal((await call(instance, `/chat/${lead.conversation}/prompt`, 'POST', { text: 'gate' })).status, 202);
  await until(instance, (event) => event.conversation === lead.conversation && event.data?.content?.text === 'gating');
  // Each worker's turn ends one at a time, and the next turn waits until the lead holds a note for that end, so 40
  // notes really wait (two ends inside the 3 s end hold would merge into one note, O139).
  const turnEnds = async (chat) => (await events(instance, chat)).filter((e) => e.type === 'turn-end').length;
  const heldFor = async (title) => (await events(instance, lead.conversation)).filter((e) => e.type === 'held' && String(e.data?.text).includes(title)).length;
  const worker = async (k) => {
    const title = 'Worker' + k, word = (i) => `w${k}-turn-${String(i).padStart(2, '0')}`;
    const made = await lead.tool('open_chat', { text: word(1), title });
    for (let i = 1; i <= 10; i += 1) {
      if (i > 1) await lead.tool('send_chat', { chat: made.chat, text: word(i) });
      for (let n = 0; (await turnEnds(made.chat)) < i && n < 600; n += 1) await pause(100);
      for (let n = 0; (await heldFor(title)) < i && n < 600; n += 1) await pause(100);
      if ((await heldFor(title)) < i) {
        const lead_ = (await events(instance, lead.conversation)).filter((e) => ['held', 'unheld', 'user'].includes(e.type)).map((e) => [e.type, String(e.data?.text).slice(0, 60), e.data?.why]);
        assert.fail(`${title}: no note held for turn ${i}. Worker: ${JSON.stringify(made)} ${JSON.stringify((await events(instance, made.chat)).map((e) => e.type))}. Lead: ${JSON.stringify(lead_)}`);
      }
    }
  };
  await Promise.all([1, 2, 3, 4].map(worker));
  const first = await coordinator.tool('send_chat', { chat: lead.conversation, text: 'coordinator first wording', when: 'queue' });
  assert.ok(first.held, JSON.stringify(first));
  const second = await coordinator.tool('send_chat', { chat: lead.conversation, text: 'coordinator second wording', when: 'queue', replaces: first.held });
  assert.equal(second.replaced, first.held, JSON.stringify(second));
  const held = (await events(instance, lead.conversation)).filter((e) => e.type === 'held').length;
  assert.ok(held >= 42, 'fewer than 40 notes and 2 coordinator messages waited: ' + held);
  const mark = (await call(instance, '/chat/events?after=0')).body.cursor;
  for (const dir of [instance.workspace, folder]) fs.writeFileSync(path.join(dir, 'go'), '');
  for (let n = 0; (await events(instance, lead.conversation)).filter((e) => e.cursor > mark && e.type === 'turn-end').length < 2 && n < 600; n += 1) await pause(100);
  await pause(3000); // nothing more comes after the one prompt
  const prompts = (await events(instance, lead.conversation)).filter((e) => e.cursor > mark && e.type === 'user');
  const all = JSON.stringify(prompts.map((e) => e.data));
  assert.equal(prompts.length, 1, 'not one prompt: ' + all);
  const text = JSON.stringify(prompts[0].data);
  const count = (needle) => text.split(needle).length - 1;
  for (const k of [1, 2, 3, 4]) {
    assert.equal(count(`w${k}-turn-10`), 1, `Worker${k}'s newest note is not in the prompt once: ` + text);
    for (let i = 1; i < 10; i += 1) assert.equal(count(`w${k}-turn-0${i}`), 0, `an older note of Worker${k} went too: ` + text);
  }
  assert.equal(count('coordinator second wording'), 1, 'the coordinator\'s replacement is not in the prompt once: ' + text);
  assert.equal(count('coordinator first wording'), 0, 'the replaced coordinator message went too: ' + text);
  console.log(`PASS O125 point 5: ${held} held for the lead, one prompt at the turn's end with each worker's newest note and the coordinator's replacement only`);
});

// O109 FIX1 (Reviewer on 44c3a71): after a restart the first kept message ('gate') starts a turn that waits, so the second
// finds the chat busy and is held again under a new ID. Its 'user' event must name the ID the window showed it under
// before the restart too, and a crash just after that re-hold must not leave it to be sent twice.
async function busyReplay(t) {
  const instance = await start(t);
  await call(instance, '/file-protection', 'POST', { on: false });
  const a = await agent(t, instance), chat = a.conversation;
  assert.equal((await call(instance, `/chat/${chat}/prompt`, 'POST', { text: 'gate' })).status, 202);
  await until(instance, (e) => e.conversation === chat && e.data?.content?.text === 'gating');
  const first = await call(instance, `/chat/${chat}/prompt`, 'POST', { text: 'gate', when: 'queue' });
  const second = await call(instance, `/chat/${chat}/prompt`, 'POST', { text: 'second kept', when: 'queue' });
  assert.ok(first.body.held && second.body.held, 'not held: ' + JSON.stringify([first.body, second.body]));
  return { instance, chat, original: second.body.held };
}
const stopped = (child) => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, 'exit');

test('O109 FIX1: a replay that finds the chat busy is held again, and its user event names the ID it waited under before the restart', { timeout: 240000 }, async (t) => {
  let { instance, chat, original } = await busyReplay(t);
  instance.child.kill('SIGTERM'); await stopped(instance.child);
  instance = await restart(t, instance, 'state-2');
  const of = async (type) => (await events(instance, chat)).filter((e) => e.type === type && String(e.data?.text).includes('second kept'));
  for (let i = 0; i < 300 && (await of('held')).length < 2; i += 1) await pause(100);
  assert.equal((await of('held')).length, 2, 'the replay did not find the chat busy (held again): ' + JSON.stringify(await of('held')));
  fs.writeFileSync(path.join(instance.workspace, 'go'), '');
  for (let i = 0; i < 300 && (await of('user')).length < 1; i += 1) await pause(100);
  await pause(3000);
  const users = await of('user');
  assert.equal(users.length, 1, 'not sent once: ' + JSON.stringify(users.map((e) => e.data)));
  assert.ok(users[0].data.held?.includes(original), `its user event does not name ${original}, the ID the window shows: ` + JSON.stringify(users[0].data));
  console.log('PASS O109 FIX1 busy replay: held again, sent once, and its user event names its first ID');
});

test('O109 FIX1: P9 killed just after a busy replay is held again sends it once after the next start', { timeout: 240000 }, async (t) => {
  let { instance, chat } = await busyReplay(t);
  const hook = path.join(instance.directory, 'crash-after-replay-hold');
  fs.writeFileSync(hook, '');
  instance.child.kill('SIGTERM'); await stopped(instance.child);
  instance = await restart(t, instance, 'state-2');
  await stopped(instance.child); // the hook kills P9 once, just after hold() kept the replayed message
  assert.ok(!fs.existsSync(hook), 'the crash hook did not fire');
  instance = await restart(t, instance, 'state-3');
  fs.writeFileSync(path.join(instance.workspace, 'go'), '');
  const sent = async () => (await events(instance, chat)).filter((e) => e.type === 'user' && String(e.data?.text).includes('second kept'));
  for (let i = 0; i < 300 && (await sent()).length < 1; i += 1) await pause(100);
  await pause(5000);
  const trail = JSON.stringify((await events(instance, chat)).filter((e) => ['held', 'unheld', 'user', 'interrupted', 'turn-end'].includes(e.type)).map((e) => [e.type, e.data?.why ?? e.data?.reason ?? String(e.data?.text ?? '').slice(-30)]));
  assert.equal((await sent()).length, 1, 'the replayed message after a crash between its re-hold and its receipt: ' + trail);
  console.log('PASS O109 FIX1 crash: killed just after the re-hold, the message went once after the next start');
});

// O109 remainder: P9 killed at each other point of a kept message's way. A crash-<point> file in the test home makes
// chat.mjs SIGKILL itself once there. Whatever the point, after the next start the agent gets the message, and gets it
// once; where P9 cannot know whether the agent already had it, the second copy says so (REPEAT).
const REPEAT = '[P9: P9 restarted while this message was being sent, so it may have reached you already.]';
async function crashCase(t, point, text, send) {
  let instance = await start(t);
  await call(instance, '/file-protection', 'POST', { on: false });
  const a = await agent(t, instance), chat = a.conversation;
  fs.writeFileSync(path.join(instance.workspace, 'log-prompts'), ''); // the fake agent logs every prompt and steer it takes
  fs.writeFileSync(path.join(instance.directory, 'crash-' + point), '');
  await send(instance, chat);
  await stopped(instance.child);
  assert.ok(!fs.existsSync(path.join(instance.directory, 'crash-' + point)), `the ${point} crash did not fire`);
  instance = await restart(t, instance, 'state-2');
  fs.writeFileSync(path.join(instance.workspace, 'go'), '');
  const read = (file) => { try { return fs.readFileSync(path.join(instance.workspace, file), 'utf8').split('\n').filter((line) => line.includes(text)); } catch { return []; } };
  const got = () => [...read('steers.log'), ...read('prompts.log')];
  for (let i = 0; i < 300 && got().length < 1; i += 1) await pause(100);
  await pause(5000);
  const trail = JSON.stringify((await events(instance, chat)).filter((e) => ['held', 'unheld', 'user', 'interrupted', 'turn-end'].includes(e.type)).map((e) => [e.type, e.data?.why ?? e.data?.reason ?? String(e.data?.text ?? '').slice(-40)]));
  return { got: got(), trail, instance, chat };
}
const gated = async (instance, chat) => {
  assert.equal((await call(instance, `/chat/${chat}/prompt`, 'POST', { text: 'gate' })).status, 202);
  await until(instance, (e) => e.conversation === chat && e.data?.content?.text === 'gating');
};
const queue = (instance, chat, body) => call(instance, `/chat/${chat}/prompt`, 'POST', { when: 'queue', ...body }).catch(() => ({}));
// Once, or twice with the second saying it may be a repeat: never lost, never a silent second copy.
const once_ = (got, trail, what) => {
  assert.ok(got.length >= 1, `${what}: the agent never got it: ` + trail);
  assert.ok(got.length === 1 || (got.length === 2 && got[1].includes(REPEAT)), `${what}: the agent got it ${got.length} times: ` + JSON.stringify(got) + ' ' + trail);
};

test('O109 crash points: killed just after its held event, a queued message still reaches the agent once', { timeout: 240000 }, async (t) => {
  const { got, trail } = await crashCase(t, 'held-event', 'kept past the held event', async (instance, chat) => { await gated(instance, chat); await queue(instance, chat, { text: 'kept past the held event' }); });
  once_(got, trail, 'held event');
  console.log('PASS O109 crash held-event: ' + got.length);
});

test('O109 crash points: killed after the hold is written, before the turn ends, a queued message reaches the agent once', { timeout: 240000 }, async (t) => {
  const { got, trail } = await crashCase(t, 'hold-write', 'kept past the hold write', async (instance, chat) => { await gated(instance, chat); await queue(instance, chat, { text: 'kept past the hold write' }); });
  assert.equal(got.length, 1, 'not once: ' + JSON.stringify(got) + ' ' + trail);
  console.log('PASS O109 crash hold-write: once');
});

test('O109 crash points: killed mid drain, after the first prompt\'s user event, both queued messages reach the agent once', { timeout: 240000 }, async (t) => {
  let second = [];
  const { got, trail, instance } = await crashCase(t, 'user-event', 'first of the drain', async (instance, chat) => {
    await gated(instance, chat);
    // Two modes: two prompts at the turn's end, so the crash falls between them.
    await queue(instance, chat, { text: 'first of the drain', mode: 'Plan' });
    await queue(instance, chat, { text: 'second of the drain', mode: 'Manual' });
    fs.writeFileSync(path.join(instance.workspace, 'go'), '');
  });
  second = fs.readFileSync(path.join(instance.workspace, 'prompts.log'), 'utf8').split('\n').filter((line) => line.includes('second of the drain'));
  once_(got, trail, 'the first of the drain');
  assert.equal(second.length, 1, 'the second of the drain: ' + JSON.stringify(second) + ' ' + trail);
  console.log('PASS O109 crash mid drain: first ' + got.length + ', second once');
});

test('O109 crash points: killed after the agent took a held steer, before P9 recorded it, it is not sent again silently', { timeout: 240000 }, async (t) => {
  const { got, trail } = await crashCase(t, 'steer-taken', 'steered past a crash', async (instance, chat) => {
    assert.equal((await call(instance, `/chat/${chat}/prompt`, 'POST', { text: 'tools 2' })).status, 202);
    await until(instance, (e) => e.conversation === chat && e.type === 'update' && e.data.sessionUpdate === 'tool_call');
    const held = await call(instance, `/chat/${chat}/prompt`, 'POST', { text: 'steered past a crash', when: 'steer' }).catch(() => ({}));
    assert.ok(held.body?.held, 'not held for the tool step: ' + JSON.stringify(held.body));
  });
  once_(got, trail, 'held steer');
  console.log('PASS O109 crash steer-taken: ' + got.length);
});

test('O109 crash points: killed just after a replacement\'s held event, the replacement reaches the agent once and the replaced one never', { timeout: 240000 }, async (t) => {
  const { got, trail, instance } = await crashCase(t, 'held-event', 'second wording', async (instance, chat) => {
    await gated(instance, chat);
    // The first is kept with no crash file in place; the replacement then crashes P9 just after its held event.
    fs.renameSync(path.join(instance.directory, 'crash-held-event'), path.join(instance.directory, 'crash-later'));
    const first = await queue(instance, chat, { text: 'first wording' });
    assert.ok(first.body?.held, JSON.stringify(first.body));
    fs.renameSync(path.join(instance.directory, 'crash-later'), path.join(instance.directory, 'crash-held-event'));
    await queue(instance, chat, { text: 'second wording', replaces: first.body.held });
  });
  once_(got, trail, 'the replacement');
  const old = fs.readFileSync(path.join(instance.workspace, 'prompts.log'), 'utf8').split('\n').filter((line) => line.includes('first wording'));
  assert.equal(old.length, 0, 'the replaced message went: ' + JSON.stringify(old));
  console.log('PASS O109 crash replace: replacement ' + got.length + ', replaced 0');
});

test('O109 FIX1: a full-limit message that may be a repeat is sent whole with the label beside it, across two crashes', { timeout: 300000 }, async (t) => {
  let instance = await start(t);
  await call(instance, '/file-protection', 'POST', { on: false });
  const a = await agent(t, instance), chat = a.conversation;
  fs.writeFileSync(path.join(instance.workspace, 'log-prompts'), '');
  const mark = 'full limit kept ', text = mark + 'x'.repeat(100_000 - mark.length); // MAX_TEXT exactly
  fs.writeFileSync(path.join(instance.directory, 'crash-user-event'), '');
  await gated(instance, chat);
  assert.ok((await queue(instance, chat, { text })).body?.held, 'not held');
  fs.writeFileSync(path.join(instance.workspace, 'go'), '');
  await stopped(instance.child);
  // The resend after the first crash crashes P9 at the same point again: still unsure, it goes again after the next start.
  fs.writeFileSync(path.join(instance.directory, 'crash-user-event'), '');
  // The resend runs as P9 starts, so the second crash can come before the start is done (daemon-exit): that is the crash.
  const second = await restart(t, instance, 'state-2').catch((e) => (/daemon-exit/.test(e.message) ? null : Promise.reject(e)));
  let lost = '[]';
  if (second) {
    // Bounded: if the resend is refused before its user event, P9 never reaches the crash point and keeps running.
    await Promise.race([stopped(second.child), pause(60000)]);
    lost = JSON.stringify((await events(second, chat).catch(() => [])).filter((e) => e.type === 'unheld').map((e) => e.data?.why));
    instance = second;
  }
  assert.ok(!fs.existsSync(path.join(instance.directory, 'crash-user-event')), 'the resend never reached its user event (unheld: ' + lost + ')');
  instance = await restart(t, instance, 'state-3');
  const got = () => { try { return fs.readFileSync(path.join(instance.workspace, 'prompts.log'), 'utf8').split('\n').filter((l) => l.includes(mark)).map((l) => JSON.parse(l)); } catch { return []; } };
  for (let i = 0; i < 300 && got().length < 1; i += 1) await pause(100);
  await pause(3000);
  const trail = JSON.stringify((await events(instance, chat)).filter((e) => ['held', 'unheld', 'user', 'interrupted'].includes(e.type)).map((e) => [e.type, e.data?.why ?? e.data?.reason ?? String(e.data?.text ?? '').length, e.data?.repeat ?? '']));
  assert.equal(got().length, 1, 'the agent got it ' + got().length + ' times: ' + trail);
  const [blocks] = got();
  assert.ok(blocks.some((b) => b.startsWith(REPEAT)), 'no repeat label: ' + JSON.stringify(blocks.map((b) => b.slice(0, 60))));
  assert.ok(blocks.includes(text), 'the user\'s text was not sent whole: ' + JSON.stringify(blocks.map((b) => b.length)));
  const users = (await events(instance, chat)).filter((e) => e.type === 'user' && String(e.data?.text).startsWith(mark));
  assert.equal(users.at(-1).data.text, text, 'the shown text is not the user\'s'); assert.equal(users.at(-1).data.repeat, true, 'the last user event does not say repeat: ' + trail);
  assert.equal((await events(instance, chat)).filter((e) => e.type === 'unheld').length, 0, 'it was dropped: ' + trail);
  console.log('PASS O109 FIX1 full limit: once, labelled, ' + text.length + ' chars');
});

// O73 FIX1 (Reviewer): a message from another chat's agent names that chat by the title it had when it sent the message, not
// by its title when P9 got round to sending it: through a turn's queue, a restart's resend, a parked note kept over a
// restart, and a sender deleted before its queued message went.
test('O73 FIX1: a waiting message keeps the title its sender had when it sent it, through a rename, a restart, a parked note and a delete', { timeout: 300000 }, async (t) => {
  let instance = await start(t);
  await call(instance, '/file-protection', 'POST', { on: false });
  let a = await agent(t, instance, { title: 'First' });
  const made = await a.tool('open_chat', { text: 'gate', title: 'Target' });
  await until(instance, (e) => e.conversation === made.chat && e.data?.content?.text === 'gating');
  const go = () => path.join(instance.workspace, 'go');
  const rename = async (title) => assert.equal((await call(instance, `/chat/${a.conversation}/rename`, 'POST', { title })).status, 200);
  const sentAs = async (text) => {
    for (let i = 0; i < 300; i += 1) {
      const e = (await events(instance, made.chat)).find((x) => x.type === 'user' && String(x.data?.text).includes(text));
      if (e) return e.data;
      await pause(100);
    }
    assert.fail(`never sent: ${text}: ` + JSON.stringify((await events(instance, made.chat)).filter((e) => ['held', 'unheld', 'user'].includes(e.type)).map((e) => [e.type, e.data?.why, String(e.data?.text).slice(-30)])));
  };
  const gate = async () => {
    const mark = (await call(instance, '/chat/events?after=0&wait=0')).body.cursor;
    await call(instance, `/chat/${made.chat}/prompt`, 'POST', { text: 'gate' });
    await until(instance, (e) => e.conversation === made.chat && e.data?.content?.text === 'gating', mark);
  };
  const ended = async () => { for (let i = 0; i < 200 && (await call(instance, '/chat')).body.conversations.find((c) => c.id === made.chat).state === 'turn'; i += 1) await pause(100); fs.rmSync(go(), { force: true }); };
  const again = async (name) => {
    instance.child.kill('SIGTERM'); await once(instance.child, 'exit'); instance = await restart(t, instance, name);
    const fresh = (await call(instance, '/chat/events?after=0')).body.cursor;
    // P9's own restart line may be running a turn on the sender: the 'mcp' message is sent once that turn is over.
    let asked;
    for (let i = 0; i < 100 && (asked = await call(instance, `/chat/${a.conversation}/prompt`, 'POST', { text: 'mcp' })).status === 409; i += 1) await pause(100);
    assert.ok([200, 202].includes(asked.status), JSON.stringify([asked.status, asked.body]));
    a = await connect(t, instance, a.conversation, fresh);
  };

  // A turn's queue: sent under First, the sender renamed before the turn ends.
  assert.ok((await a.tool('send_chat', { chat: made.chat, text: 'queued one', when: 'queue' })).held);
  await rename('Second');
  fs.writeFileSync(go(), '');
  assert.equal((await sentAs('queued one')).fromTitle, 'First');
  await ended();

  // A restart's resend: sent under Second, renamed, then P9 restarts mid-turn and sends it again.
  await gate();
  assert.ok((await a.tool('send_chat', { chat: made.chat, text: 'queued two', when: 'queue' })).held);
  await rename('Third');
  await again('state-2');
  assert.equal((await sentAs('queued two')).fromTitle, 'Second');
  await ended();

  // A parked note kept over a restart: sent under Third, renamed; after the restart a second note rewrites the kept list.
  assert.match((await a.tool('send_chat', { chat: made.chat, text: 'note one', when: 'note' })).sent, /with its next message/);
  await rename('Fourth');
  await again('state-3');
  assert.match((await a.tool('send_chat', { chat: made.chat, text: 'note two', when: 'note' })).sent, /with its next message/);
  const db = new DatabaseSync(path.join(instance.directory, '.local', 'state', 'p9-foundation', 'p9.db'), { timeout: 5000 });
  let parked;
  try { parked = JSON.parse(db.prepare('SELECT value FROM prefs WHERE key = ?').get('parked:' + made.chat).value); } finally { db.close(); }
  assert.deepEqual(parked.map((n) => [n.text, n.fromTitle]), [['note one', 'Third'], ['note two', 'Fourth']]);

  // A delete: sent under Fourth, then the sender is deleted before the turn ends.
  await gate();
  assert.ok((await a.tool('send_chat', { chat: made.chat, text: 'queued three', when: 'queue' })).held);
  assert.equal((await call(instance, `/chat/${a.conversation}/delete`, 'POST', {})).status, 200);
  fs.writeFileSync(go(), '');
  assert.equal((await sentAs('queued three')).fromTitle, 'Fourth');
});

// O255 round 4: an explicit steer that picks another mode goes into the turn when the agent can steer (the turn keeps
// its mode), and when it cannot, it waits and the next turn runs in the mode it picked, not the old, wider one.
test('O255: a steer with a new mode goes in when the agent steers, and otherwise waits and runs in that mode', { timeout: 120000 }, async (t) => {
  const instance = await start(t);
  await call(instance, '/file-protection', 'POST', { on: false });
  const go = path.join(instance.workspace, 'go'), held = async (chat, text) => (await events(instance, chat)).filter((e) => e.type === 'held' && String(e.data?.text).includes(text));
  const gated = async (chat) => { const { cursor } = (await call(instance, '/chat/events?after=0')).body; assert.equal((await call(instance, `/chat/${chat}/prompt`, 'POST', { text: 'gate' })).status, 202); await until(instance, (e) => e.conversation === chat && e.data?.content?.text === 'gating', cursor); };
  const steers = await agent(t, instance);
  await gated(steers.conversation);
  // The window's mid-turn pick (next): the steer goes into this turn.
  const nudge = await call(instance, `/chat/${steers.conversation}/prompt`, 'POST', { text: 'nudge in plan', when: 'steer', mode: 'Plan', next: true });
  assert.ok(nudge.status < 300, JSON.stringify(nudge));
  assert.deepEqual((await held(steers.conversation, 'nudge in plan')).filter((e) => e.data.when === 'queue'), [], 'a steer that picks a mode was queued for a new turn instead of steered in');
  const now = async () => (await call(instance, '/chat/events?after=0')).body.cursor;
  let c = await now(); fs.writeFileSync(go, ''); await until(instance, (e) => e.conversation === steers.conversation && e.type === 'turn-end', c); fs.rmSync(go);
  const first = await events(instance, steers.conversation), gate = first.findIndex((e) => e.type === 'user' && e.data?.text === 'gate'), end = first.findIndex((e, i) => i > gate && e.type === 'turn-end');
  assert.ok(first.findIndex((e) => e.type === 'user' && String(e.data?.text).includes('nudge in plan')) > -1 && first.findIndex((e) => e.type === 'user' && String(e.data?.text).includes('nudge in plan')) < end, 'the steer was not delivered in the running turn: ' + JSON.stringify(first.map((e) => e.type)));
  // The phone's mode pick (mode, no next) still waits for the turn's end, which sets it.
  await gated(steers.conversation);
  const phone = await call(instance, `/chat/${steers.conversation}/prompt`, 'POST', { text: 'phone in plan', when: 'steer', mode: 'Plan' });
  assert.equal(phone.status, 202, JSON.stringify(phone));
  assert.equal((await held(steers.conversation, 'phone in plan')).at(-1)?.data?.when, 'queue', 'the phone picked Plan mid-turn and it went into the wider turn');
  c = await now(); fs.writeFileSync(go, ''); await until(instance, (e) => e.conversation === steers.conversation && e.type === 'user' && String(e.data?.text).includes('phone in plan'), c);
  // Its turn runs in Plan and the agent answers it.
  let after = [], at = -1;
  for (let i = 0; i < 100; i += 1) { after = await events(instance, steers.conversation); at = after.findIndex((e) => e.type === 'user' && String(e.data?.text).includes('phone in plan')); if (after.slice(at).some((e) => e.type === 'turn-end')) break; await pause(100); }
  fs.rmSync(go);
  assert.ok(at >= 0 && after.slice(at).some((e) => e.type === 'turn-end'), 'the phone message\'s turn did not end');
  assert.equal(after.filter((e) => e.type === 'mode').at(-1)?.data?.name, 'Plan', 'the phone message did not run in Plan');
  assert.ok(after.slice(at).some((e) => String(e.data?.content?.text).includes('echo:phone in plan')), 'the agent did not answer the phone message');
  fs.writeFileSync(path.join(instance.workspace, 'no-steering'), '');
  const waits = await agent(t, instance);
  await gated(waits.conversation);
  const later = await call(instance, `/chat/${waits.conversation}/prompt`, 'POST', { text: 'later in plan', when: 'steer', mode: 'Plan', next: true });
  assert.equal(later.status, 202, 'no steering: it waits for the turn end ' + JSON.stringify(later));
  fs.writeFileSync(go, '');
  await until(instance, (e) => e.conversation === waits.conversation && e.type === 'user' && String(e.data?.text).includes('later in plan'));
  const lastMode = async () => (await events(instance, waits.conversation)).filter((e) => e.type === 'mode').at(-1)?.data?.name;
  for (let i = 0; i < 100 && (await lastMode()) !== 'Plan'; i += 1) await pause(100);
  const mine = await events(instance, waits.conversation);
  assert.equal(await lastMode(), 'Plan', 'the waiting steer ran in the old mode: ' + JSON.stringify(mine.filter((e) => ['mode', 'user', 'held', 'turn-end'].includes(e.type)).map((e) => [e.type, e.data?.name ?? String(e.data?.text ?? '').slice(0, 30)])));
  console.log('PASS O255 steer mode: a next pick steered in, a phone mode pick waited; without steering it waited and the next turn ran in Plan');
});

// O255 round 8: Plan picked mid-turn in a Codex chat and then taken back. The message sent with Plan picked and the one sent
// after the pick was taken back (it leaves the plan switch out) are not joined, and the second does not run in Plan.
test('O255: in a Codex chat, a message sent after a Plan pick was taken back does not join or run in Plan with the one sent before', { timeout: 120000 }, async (t) => {
  const instance = await start(t);
  await call(instance, '/file-protection', 'POST', { on: false });
  const go = path.join(instance.workspace, 'go');
  const { conversation: chat } = await agent(t, instance, { provider: 'codex' });
  let c = (await call(instance, '/chat/events?after=0')).body.cursor;
  assert.equal((await call(instance, `/chat/${chat}/prompt`, 'POST', { text: 'gate' })).status, 202);
  await until(instance, (e) => e.conversation === chat && e.data?.content?.text === 'gating', c);
  const mode = (await events(instance, chat)).filter((e) => e.type === 'mode').at(-1)?.data?.name;
  for (const body of [{ text: 'config', when: 'queue', mode, next: true, config: { collaboration_mode: 'plan' } }, { text: 'config', when: 'queue', mode, next: false }]) {
    const r = await call(instance, `/chat/${chat}/prompt`, 'POST', body); assert.equal(r.status, 202, JSON.stringify(r));
  }
  fs.writeFileSync(go, '');
  let said = [];
  for (let i = 0; i < 150 && said.length < 2; i += 1) { said = (await events(instance, chat)).filter((e) => /collaboration_mode=/.test(String(e.data?.content?.text))).map((e) => e.data.content.text.match(/collaboration_mode=(\w+)/)[1]); await pause(100); }
  fs.rmSync(go);
  assert.deepEqual(said, ['plan', 'default'], 'the two were joined, or the second ran in Plan');
  console.log('PASS O255 codex plan taken back: the message sent with Plan ran in Plan, the one sent after it was taken back ran with Plan off, as two turns');
});

// O141 review 9: the tools a sprint lead's usage watch leans on (sprint-files.mjs LEAD). list_chats names the plan a worker
// spends; a hold sent as steer to a worker deep in a turn waits with a held ID, and the carry-on sent with replaces takes
// its place, so only the carry-on reaches the worker; read_chat from the cursor kept just before the hold, asked again on a
// later watch, has the worker's whole reply, though the first read came before any of it.
test('O141 review 9: a worker\'s plan in list_chats; a hold still waiting is replaced by the carry-on; a reply is read whole from the kept cursor', { timeout: 120000 }, async (t) => {
  const instance = await start(t);
  await call(instance, '/file-protection', 'POST', { on: false });
  const project = (await call(instance, '/projects', 'POST', { name: 'Fresh', work: { kind: 'new', parent: '', name: 'fresh' } })).body.project.id;
  const folder = path.join(instance.workspace, 'fresh');
  for (const dir of [instance.workspace, folder]) fs.writeFileSync(path.join(dir, 'no-steering'), '');
  const lead = await agent(t, instance, { project });
  const made = await lead.tool('open_chat', { text: 'gate', title: 'Worker' });
  await until(instance, (e) => e.conversation === made.chat && e.data?.content?.text === 'gating');
  assert.equal((await lead.tool('list_chats')).chats.find((c) => c.id === made.chat)?.plan, 'claude', 'a Claude worker does not name the plan it spends');
  const kept = (await lead.tool('read_chat', { chat: made.chat })).next;
  const hold = await lead.tool('send_chat', { chat: made.chat, text: 'Finish the step you are on, reply Holding for usage', when: 'steer' });
  assert.ok(hold.held, 'the hold did not wait: ' + JSON.stringify(hold));
  const back = await lead.tool('send_chat', { chat: made.chat, text: 'Usage is back: carry on', when: 'steer', replaces: hold.held });
  assert.equal(back.replaced, hold.held, JSON.stringify(back));
  const read = async () => JSON.stringify(await lead.tool('read_chat', { chat: made.chat, after: kept }));
  assert.doesNotMatch(await read(), /carry on/, 'the first watch: no reply yet');
  for (const dir of [instance.workspace, folder]) fs.writeFileSync(path.join(dir, 'go'), '');
  for (let n = 0; (await events(instance, made.chat)).filter((e) => e.type === 'turn-end').length < 2 && n < 600; n += 1) await pause(100);
  const late = await read();
  assert.match(late, /gated/, 'the later watch from the kept cursor lost the end of the turn: ' + late);
  assert.match(late, /Usage is back: carry on/, 'the carry-on or its echo is missing: ' + late);
  assert.doesNotMatch(late, /Holding for usage/, 'the replaced hold still reached the worker: ' + late);
  console.log('PASS O141 review 9: list_chats named the plan; the waiting hold was replaced by the carry-on; the later watch read the whole reply from the kept cursor');
});
