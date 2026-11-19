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
import { start, call, until, events, agent, pause } from './delegate-helpers.mjs';

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
