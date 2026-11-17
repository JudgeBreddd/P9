// #266 FIX1 (O140): schedules.run reads each due prompt again just before it is sent, so one paused, changed or removed
// while an earlier one is still being sent goes as it is now, or not at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchedules } from '../apps/server/schedules.mjs';

test('O140 FIX1 schedules: a prompt changed, paused or removed while an earlier one is being sent goes as it is now, or not at all', async () => {
  const sent = [];
  let hold, held = new Promise((resolve) => { hold = resolve; });
  const fire = async (row) => { sent.push(row.text); if (row.text === 'first') await held; return { sent: true }; };
  const s = createSchedules({ db: new DatabaseSync(':memory:'), fire });
  const past = (ms) => new Date(Date.now() - ms).toISOString();
  s.save('o', { text: 'first', at: past(4000) }, 'o');
  const second = s.save('o', { text: 'old', at: past(3000) }, 'o');
  const third = s.save('o', { text: 'gone', at: past(2000) }, 'o');
  const fourth = s.save('o', { text: 'stopped', at: past(1000) }, 'o');
  for (let i = 0; !sent.length && i < 100; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(sent, ['first']);
  assert.equal(s.save('o', { id: second.id, text: 'new' }).action, 'changed');
  assert.equal(s.remove('o', third.id).action, 'removed');
  assert.equal(s.save('o', { id: fourth.id, paused: true }).paused, true);
  hold();
  for (let i = 0; sent.length < 2 && i < 100; i += 1) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 100));
  s.stop();
  assert.deepEqual(sent, ['first', 'new'], 'a prompt read before the first was sent went as it was then');
  assert.deepEqual(s.list('o').map((x) => [x.text, x.paused]), [['stopped', true]]);
  console.log('PASS O140 FIX1 schedules: ' + JSON.stringify(sent));
});
