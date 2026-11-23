import test from 'node:test';
import assert from 'node:assert/strict';
import { start, call, until, events, agent } from './delegate-helpers.mjs';

// O252: the turn reads as running from its user event, but its prompt reaches the agent only after the start snapshot
// (MC-15, up to 3 s). A steer sent in that window met an agent with no turn (promptRequired) and was refused, so it waited
// for the turn's end. The snapshot is slowed here (P9_SHELL_START_MS) so the window is wide enough to hit every time.
test('O252: a steer sent while the turn start snapshot runs joins the turn', { timeout: 120000 }, async (t) => {
  const instance = await start(t, { P9_SHELL_START_MS: '2500' });
  await call(instance, '/file-protection', 'POST', { on: false });
  const a = await agent(t, instance);
  const made = await a.tool('open_chat', { text: 'tools 2', title: 'Steer at start' });
  await until(instance, (e) => e.conversation === made.chat && e.type === 'user' && e.data.text?.endsWith('tools 2'));
  const sent = await a.tool('send_chat', { chat: made.chat, text: 'nudge', when: 'steer' });
  assert.ok(['into its running turn', 'waiting for its next step'].includes(sent.sent), 'the steer was not taken into the turn: ' + JSON.stringify(sent));
  await until(instance, (e) => e.conversation === made.chat && e.type === 'turn-end');
  const mine = await events(instance, made.chat), at = (test) => mine.findIndex(test);
  const steered = at((e) => e.type === 'user' && e.data.text?.endsWith('nudge') && e.data.steered === true);
  const answered = at((e) => e.data?.content?.text === 'got:nudge'), end = at((e) => e.type === 'turn-end');
  assert.ok(steered >= 0 && answered > steered && answered < end, 'not answered inside the turn: ' + JSON.stringify({ steered, answered, end }));
  await a.tool('stop_chat', { chat: made.chat });
});
