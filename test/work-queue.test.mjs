// daemon-2 (phase 4.5): the work queue and the review trail. A role's items in the plan are its queue; ready reports
// the first not yet passed and wakes the reviewer; verdicts count fixes and flag the third; P9 alone writes the trail.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDelegate } from '../apps/server/delegate.mjs';
import { createSprintFiles, itemsOf } from '../apps/server/sprint-files.mjs';

const lead = '00000000-0000-0000-0000-000000000001', worker = '00000000-0000-0000-0000-000000000002';
const reviewer = '00000000-0000-0000-0000-000000000003', other = '00000000-0000-0000-0000-000000000004';

const PLAN = `# Plan

## Items
- [ ] daemon-1: "Start sprint: one press". Checks: each row's Test. Role: daemon. Its button is window's.
- [x] window-1: "The Delegate window". Role: window.
- [ ] daemon-2: "The work queue". Role: daemon. The card part is window's: each role has one.
- [ ] B3: a fix; done means it works; checks unit; role daemon; depends on B1
- [ ] stray line that names no role
`;

test('Work queue: the plan\'s items for a role, in order, ids before the colon; ticks and other roles left out', () => {
  assert.deepEqual(itemsOf(PLAN, 'daemon').map((i) => i.id), ['daemon-1', 'daemon-2', 'B3']);
  assert.deepEqual(itemsOf(PLAN, 'window').map((i) => i.id), ['window-1']);
  assert.deepEqual(itemsOf(PLAN, 'has'), [], '"each role has one" named a role');
  assert.deepEqual(itemsOf(null, 'daemon'), []);
  console.log('PASS Work queue: items by role');
});

test('Work queue: ready takes the first item not passed, wakes the reviewer, verdicts count fixes, the third asks for a larger model, P9 alone writes the trail', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'p9-queue-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const folder = join(home, 'work');
  execFileSync('git', ['init', '-q', '-b', 'main', folder]);
  const commit = (m) => { execFileSync('git', ['-C', folder, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '--allow-empty', '-qm', m]); return execFileSync('git', ['-C', folder, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); };
  const files = createSprintFiles({ home: join(home, 'sprints') });
  files.ensure(lead);
  assert.equal(files.write(lead, 'sprint.md', PLAN), true);
  const family = [{ id: lead }, { id: worker, parent: lead, key: 'daemon', title: 'Daemon' }, { id: reviewer, parent: lead, key: 'review', title: 'Reviewer' }, { id: other, parent: lead, key: 'window', title: 'Window' }].map((c) => ({ ...c, project: 'p' }));
  const states = new Map(), sent = [];
  const sprintOf = (id) => states.get(id) ?? {};
  const chat = { lock: () => ({ on: false }), info: (id) => ({ ...family.find((c) => c.id === id), state: 'turn' }), activeTaskTurn: () => 'turn-1',
    startFolder: async () => folder, family: () => family, list: () => family, sprint: sprintOf, setSprint: (id, patch) => states.set(id, { ...sprintOf(id), ...patch }),
    sprintFiles: files, prompt: async (id, body, _, from) => { sent.push([id, body.text, body.when, from]); return { status: 202 }; },
    // As chat.mjs queueOf: the role's items with P9's own review state.
    queue: (id) => { const c = family.find((x) => x.id === id); const items = itemsOf(files.read(lead, 'sprint.md'), c.key).map((i) => ({ ...i, state: sprintOf(id).reviews?.[i.id]?.state ?? 'todo' })); return items.length ? { items } : null; },
    gauge: () => ({}), note: async () => {}, pin: () => {}, turnEnded: () => {}, settled: () => {}, restarted: async () => ({ chats: [], storm: false }) };
  const tools = createDelegate({ chat });
  const report = { commit: 'x', results: [{ check: 'unit', result: 'pass' }], weakest: 'none' };

  // ready with no task: the first item of its queue; checks are its own (1 to 20).
  assert.equal((await tools.ready({ ...report, results: [] }, worker)).error, 'request-refused');
  const c1 = commit('one');
  const r1 = await tools.ready(report, worker);
  assert.equal(r1.ready?.item, 'daemon-1', JSON.stringify(r1));
  assert.equal(r1.queued, reviewer);
  assert.deepEqual(sent.at(-1).slice(0, 2), [reviewer, `[p9] Ready for review: daemon-1, by Daemon (chat ${worker}), commit ${c1}. Read its report, then call verdict with that chat and commit.`]);
  assert.equal(sent.at(-1)[2], 'queue');
  // Not passed yet: ready again is the same item, never the next one.
  assert.equal((await tools.ready(report, worker)).ready.item, 'daemon-1');

  // Three fixes: each counted from the verdict, the worker told, and at the third the lead asked for a larger model.
  for (const n of [1, 2, 3]) {
    const at = commit('fix ' + n);
    assert.equal((await tools.ready(report, worker)).ready.item, 'daemon-1');
    const v = tools.verdict({ chat: worker, commit: at, result: 'fix', note: 'finding ' + n }, reviewer);
    assert.deepEqual([v.review.state, v.review.fixes, v.review.larger ?? false], ['fix', n, n === 3]);
    assert.deepEqual(sent.find((s) => s[0] === worker && s[1].includes('finding ' + n)).slice(1, 3), [`[p9] daemon-1: the reviewer asked for a fix (fix ${n}) at ${at}: finding ${n}`, 'queue']);
  }
  assert.deepEqual(sent.filter((s) => s[0] === lead).map((s) => s[1]), ['[p9] daemon-1 by Daemon got its third fix: give the correction to a larger model (Opus or Fable).']);
  const c2 = commit('passed');
  await tools.ready(report, worker);
  assert.equal(tools.verdict({ chat: worker, commit: c2, result: 'pass', note: 'ok' }, reviewer).review.state, 'passed');
  assert.equal(sprintOf(worker).reviews['daemon-1'].fixes, 3, 'a pass reset the fix count');
  assert.match(sent.at(-1)[1], /^\[p9\] daemon-1 passed review at [0-9a-f]+\. Start your next item\.$/);
  // Passed: the next ready is the next item; a new message to the worker (which clears ready) keeps the record.
  states.set(worker, { ...sprintOf(worker), ready: null, verdict: null });
  commit('two');
  assert.equal((await tools.ready(report, worker)).ready.item, 'daemon-2');
  assert.equal(sprintOf(worker).reviews['daemon-1'].state, 'passed');

  // The trail: one file, P9 its only writer; the project page's save is refused.
  const trail = files.read(lead, 'review-trail.md');
  assert.match(trail, /^# Review trail/);
  assert.match(trail, /\| daemon-1 \| Daemon \| [0-9a-f]{40} \| passed \| 3 \| yes \|/);
  assert.match(trail, /\| daemon-2 \| Daemon \| [0-9a-f]{40} \| queued \| 0 \|  \|/);
  assert.equal(files.write(lead, 'review-trail.md', 'mine'), false, 'another writer replaced the trail');
  assert.equal(readFileSync(files.fileOf(lead, 'review-trail.md'), 'utf8'), trail);
  assert.ok(files.list(lead).some((f) => f.name === 'review-trail.md'), 'the project page does not list the trail');
  console.log('PASS Work queue: ready from the queue, reviewer woken, fix count from verdicts, third fix flagged, trail P9-only');
});
