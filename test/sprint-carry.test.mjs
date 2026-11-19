// O193: P9 carries a sprint item from ready to the merge. Each wake goes to the item's one next actor, once per
// (worker, item, state, commit); a restart and a dropped event are caught; a paused sprint gets only what it got before.
// createDelegate over a stub chat: the persisted records live in `store`, so a new createDelegate is a P9 restart.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// O188's 10-minute check, shortened (honoured only under a test home); read when delegate.mjs loads.
process.env.P9_TEST_HOME ||= tmpdir();
process.env.P9_WAKE_AFTER_MS = '200';
const { createDelegate } = await import('../apps/server/delegate.mjs');
const { decide } = await import('../apps/server/carry.mjs');

const lead = '00000000-0000-0000-0000-00000000000a';
const worker = '00000000-0000-0000-0000-00000000000b';
const reviewer = '00000000-0000-0000-0000-00000000000c';
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

// The worker's commits are on a branch, not on main: a commit already on main is a stale record.
function repo(t) {
  const folder = mkdtempSync(join(tmpdir(), 'p9-carry-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const g = (...a) => execFileSync('git', ['-C', folder, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...a], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', folder]);
  g('commit', '--allow-empty', '-qm', 'base'); g('checkout', '-qb', 'work');
  return { folder, commit: (m) => { g('commit', '--allow-empty', '-qm', m); return g('rev-parse', 'HEAD'); }, merge: () => { g('checkout', '-q', 'main'); g('merge', '-q', '--ff-only', 'work'); g('checkout', '-q', 'work'); } };
}

function world(t, { paused = false, withReviewer = true, started = true } = {}) {
  const { folder, commit, merge } = repo(t);
  const store = new Map([[worker, { task: { item: 'B1', doneMeans: 'done', checks: ['test'] } }]]);
  const states = new Map([[lead, 'running'], [worker, 'running'], [reviewer, 'running']]);
  const family = [{ id: lead, project: 'p', title: 'Lead' }, { id: worker, parent: lead, key: 'w1', project: 'p', title: 'Kid' },
    ...(withReviewer ? [{ id: reviewer, parent: lead, key: 'review', project: 'p', title: 'Rev' }] : [])];
  const prompts = [], notes = [], refused = [], archived = new Set(), taskTurn = new Set();
  let refuse = 0; // the next `refuse` prompts are refused (a lifecycle 503), and logged in `refused`
  const make = () => {
    const settled = [];
    let ready;
    const restarted = new Promise((resolve) => { ready = resolve; });
    const chat = {
      lock: () => ({ on: false }), list: () => family.map((c) => ({ ...c, archived: archived.has(c.id) })), family: () => family,
      info: (id) => { const c = family.find((x) => x.id === id); return c && { provider: 'claude', mode: 'Auto', ...c, state: states.get(id) }; },
      activeTaskTurn: (id) => (states.get(id) === 'turn' || taskTurn.has(id) ? 'turn-1' : null),
      sprint: (id) => store.get(id) ?? {}, setSprint: (id, patch) => store.set(id, { ...(store.get(id) ?? {}), ...patch }),
      startFolder: async () => folder, gauge: () => ({}), pin: () => {}, turnEnded: () => {}, acts: () => 0, reply: () => 'done for now',
      note: async (id, text) => { notes.push([id, text]); }, prompt: async (id, body) => { if (refuse > 0) { refuse -= 1; refused.push([id, body.text]); return { status: 503, error: 'restarting' }; } prompts.push([id, body.text]); return { status: 202 }; },
      settled: (hook) => { settled.push(hook); }, restarted: () => restarted,
      projects: { started: (id) => (started && id === lead ? { plan: 'hash', at: 1 } : null), closed: () => null }, paused: () => paused,
    };
    const tools = createDelegate({ chat });
    return { tools, end: async (id, how) => { for (const hook of settled) hook(id, true, how); await settle(); }, boot: async () => { ready({ chats: [], storm: false }); await settle(); } };
  };
  const ready = async (p9, c, row) => { states.set(worker, 'turn'); const out = await p9.tools.ready({ commit: c, results: [{ check: 'test', result: 'passed' }], weakest: 'none', ...(row && { row }) }, worker); states.set(worker, 'running'); assert.ok(out.ready, JSON.stringify(out)); await settle(); };
  const verdict = async (p9, c, result) => { states.set(reviewer, 'turn'); const out = p9.tools.verdict({ chat: worker, commit: c, result, note: 'see the test' }, reviewer); states.set(reviewer, 'running'); assert.ok(out.verdict, JSON.stringify(out)); await settle(); };
  const who = { [lead]: 'lead', [worker]: 'worker', [reviewer]: 'reviewer' };
  return { make, store, states, commit, merge, prompts, notes, ready, verdict, family, archived, taskTurn, refused, refuse: (n) => { refuse = n; }, order: () => prompts.map(([id]) => who[id]) };
}

test('O193: an item\'s whole life (ready, fix, ready, pass) wakes reviewer, worker, reviewer, then worker (next item) and lead, and nothing else', { timeout: 30000 }, async (t) => {
  const w = world(t), p9 = w.make();
  await p9.boot();
  const c1 = w.commit('one');
  await w.ready(p9, c1); await p9.end(worker);
  await w.verdict(p9, c1, 'fix'); await p9.end(reviewer);
  const c2 = w.commit('two');
  await w.ready(p9, c2); await p9.end(worker);
  await w.verdict(p9, c2, 'pass'); await p9.end(reviewer);
  await p9.end(lead); await p9.end(reviewer); // later ends wake nobody again
  assert.deepEqual(w.order(), ['reviewer', 'worker', 'reviewer', 'worker', 'lead'], JSON.stringify(w.prompts));
  assert.equal(w.prompts[3][1], `[p9] B1 passed review at ${c2}. Start your next item.`);
  assert.equal(w.prompts[4][1], `[p9] B1 by Kid passed at ${c2}: merge it.`);
  assert.equal(w.prompts[1][1], `[p9] B1: the reviewer asked for a fix (fix 1) at ${c1}: see the test`);
  w.merge(); // merged: the passed record is stale, and a restart wakes nobody
  await w.make().boot();
  assert.equal(w.prompts.length, 5);
});

test('O193: a P9 restart between ready and verdict still wakes the reviewer, once', { timeout: 30000 }, async (t) => {
  const w = world(t), first = w.make();
  await first.boot();
  w.states.set(reviewer, 'turn'); // busy at ready: no wake yet
  await w.ready(first, w.commit('one'));
  assert.deepEqual(w.order(), []);
  w.states.set(reviewer, 'stopped'); // P9 restarts: the reviewer's turn and its end are lost
  await w.make().boot();
  assert.deepEqual(w.order(), ['reviewer']);
  await w.make().boot(); // the wake is kept, so not sent again; the lead is told once instead
  await w.make().boot();
  assert.deepEqual(w.order(), ['reviewer', 'lead']);
  assert.match(w.prompts[1][1], /Rev ended its turn on B1 at .* without acting on it/);
});

test('O193: a dropped event is caught on the next event for that sprint; a reviewer ending with no verdict tells the lead once', { timeout: 30000 }, async (t) => {
  const w = world(t), p9 = w.make();
  await p9.boot();
  w.states.set(reviewer, 'turn');
  await w.ready(p9, w.commit('one'));
  w.states.set(reviewer, 'running'); // its turn ended, but that event never came
  assert.deepEqual(w.order(), []);
  await p9.end(lead); // the next event for the sprint, from another chat
  assert.deepEqual(w.order(), ['reviewer']);
  await p9.end(reviewer); // woken, ended: a single end is often mid-work, so nothing yet
  assert.deepEqual(w.order(), ['reviewer']);
  await settle(3600); // still stopped after END_HOLD_MS and the shortened 10-minute check, no verdict: the lead is told
  await p9.end(reviewer); await settle(3600);
  assert.deepEqual(w.order(), ['reviewer', 'lead']);
});

test('O193: a worker still stopped after its end with no ready and nothing sent to the lead wakes the lead once', { timeout: 30000 }, async (t) => {
  const w = world(t), p9 = w.make();
  await p9.boot();
  await p9.end(worker); await settle(3600); // END_HOLD_MS, then the shortened 10-minute check
  assert.deepEqual(w.order(), ['lead']);
  assert.equal(w.prompts[0][1], '[p9] Kid ended its turn with no ready and nothing queued for you.');
  const sent = await p9.tools.send_chat({ chat: lead, text: 'B1 is up', when: 'queue' }, worker); // a message to the lead
  assert.ok(!sent?.error, JSON.stringify(sent));
  w.prompts.length = 0;
  await p9.end(worker); await settle(3600);
  assert.equal(w.prompts.filter(([, s]) => s.includes('no ready')).length, 0, JSON.stringify(w.prompts));
});

test('O193: ready with no reviewer tells the lead; a paused sprint gets only what it got before', { timeout: 30000 }, async (t) => {
  const lone = world(t, { withReviewer: false }), p9 = lone.make();
  await p9.boot();
  await lone.ready(p9, lone.commit('one'));
  assert.deepEqual(lone.order(), ['lead']);
  assert.match(lone.prompts[0][1], /no reviewer can take it/);

  const held = world(t, { paused: true }), plain = held.make();
  await plain.boot();
  const c1 = held.commit('one');
  await held.ready(plain, c1); await plain.end(worker);
  await held.verdict(plain, c1, 'fix'); await plain.end(reviewer);
  const c2 = held.commit('two');
  await held.ready(plain, c2);
  await held.verdict(plain, c2, 'pass'); await plain.end(lead);
  await held.make().boot();
  assert.deepEqual(held.order(), ['reviewer', 'worker', 'reviewer', 'worker'], 'today\'s prompts: the ready line, the fix and the pass to the worker');
  assert.equal(held.store.get(lead)?.carry, undefined, 'nothing is recorded in a paused sprint');
});

test('O193: a run P9 never prompted that ends with no ready and nothing sent to the lead wakes the lead at its end, once', { timeout: 30000 }, async (t) => {
  const w = world(t), p9 = w.make();
  await p9.boot();
  w.states.set(lead, 'stopped'); // O188's 10-minute path never prompts a stopped parent; the run's end does
  await p9.end(worker); await settle(3600);
  assert.deepEqual(w.order(), [], 'a prompted turn\'s end waits for the 10-minute check');
  await p9.end(worker, 'unprompted'); await settle(3600);
  assert.deepEqual(w.order(), ['lead']);
  assert.equal(w.prompts[0][1], '[p9] Kid ended its turn with no ready and nothing queued for you.');
  w.states.set(lead, 'running'); // both paths look at the same end: still one wake
  await p9.end(worker, 'unprompted'); await settle(3600);
  assert.equal(w.order().length, 2, JSON.stringify(w.prompts));
});

test('O193: ready names the plan row, so two rows from one worker are two review records and two reviews', { timeout: 30000 }, async (t) => {
  const w = world(t), p9 = w.make();
  await p9.boot();
  const c1 = w.commit('one');
  await w.ready(p9, c1, 'O1'); await w.verdict(p9, c1, 'pass');
  const c2 = w.commit('two');
  await w.ready(p9, c2, 'O2');
  assert.deepEqual(Object.keys(w.store.get(worker).reviews).sort(), ['O1', 'O2']);
  assert.deepEqual(w.order(), ['reviewer', 'worker', 'lead', 'reviewer'], JSON.stringify(w.prompts));
  assert.match(w.prompts[3][1], /^\[p9\] Ready for review: O2, by Kid/);
  w.states.set(worker, 'turn');
  const bad = await p9.tools.ready({ commit: c2, results: [{ check: 'test', result: 'passed' }], weakest: 'none', row: 'O 3; rm' }, worker);
  assert.equal(bad.error, 'request-refused');
});

test('O193 FIX1: a refused wake is not spent: the next event for the sprint sends it', { timeout: 30000 }, async (t) => {
  const w = world(t), p9 = w.make();
  await p9.boot();
  w.refuse(1); // P9 is restarting when the ready comes: the reviewer's wake is refused
  await w.ready(p9, w.commit('one'));
  assert.equal(w.refused.length, 1, JSON.stringify(w.refused));
  assert.deepEqual(w.order(), []);
  await p9.end(lead); // the next event: the wake goes now
  assert.deepEqual(w.order(), ['reviewer'], JSON.stringify(w.prompts));
  await p9.end(lead); // and once only
  assert.deepEqual(w.order(), ['reviewer']);
});

test('O193 FIX1: with no sprint Start, a reviewer added after P9 started still gets the first ready', { timeout: 30000 }, async (t) => {
  const w = world(t, { withReviewer: false, started: false }), p9 = w.make();
  await p9.boot(); // no Start record and no reviewer: not a sprint yet
  w.family.push({ id: reviewer, parent: lead, key: 'review', project: 'p', title: 'Rev' });
  await w.ready(p9, w.commit('one'));
  assert.deepEqual(w.order(), ['reviewer'], JSON.stringify(w.prompts));
});

test('O193 FIX1: an unprompted run\'s end wakes nobody while O188 would not: the lead archived or waiting on it, a task turn running', { timeout: 30000 }, async (t) => {
  const w = world(t), p9 = w.make();
  await p9.boot();
  w.taskTurn.add(worker); // a prompted turn of the worker is still its task turn
  await p9.end(worker, 'unprompted'); await settle(3600);
  assert.deepEqual(w.order(), [], JSON.stringify(w.prompts));
  w.taskTurn.delete(worker); w.archived.add(lead);
  await p9.end(worker, 'unprompted'); await settle(3600);
  assert.deepEqual(w.order(), [], JSON.stringify(w.prompts));
  w.archived.delete(lead);
  await p9.end(worker, 'unprompted'); await settle(3600); // with both gone, it wakes as before
  assert.deepEqual(w.order(), ['lead']);
});

test('O193 decide: a record whose commit is on main, or queued before the sprint started, wakes nobody', () => {
  const base = { lead: { id: 'L', busy: false }, started: 100, reviewer: { id: 'R', title: 'Rev', busy: false }, woken: {} };
  const one = (r) => decide({ ...base, workers: [{ id: 'W', title: 'Kid', reviews: { B1: r } }] }, { type: 'end' });
  assert.equal(one({ state: 'queued', commit: 'c', at: 50 }).length, 0);
  assert.equal(one({ state: 'passed', commit: 'c', at: 150, onMain: true }).length, 0);
  assert.deepEqual(one({ state: 'queued', commit: 'c', at: 150 }).map((w) => [w.chat, w.key]), [['R', 'W:B1:queued:c']]);
  assert.equal(one({ state: 'queued', commit: 'c', at: 150, open: false }).length, 0, 'no longer an open PR head');
  const old = { id: 'W', title: 'Kid', reviews: { B1: { state: 'passed', commit: 'abcdef0123', at: 50 }, B2: { state: 'fix', commit: 'c', at: 150, onMain: true } } };
  const listed = decide({ ...base, first: true, workers: [old] }, { type: 'end' });
  assert.deepEqual(listed.map((x) => [x.chat, x.key]), [['L', 'stale']], 'the first carry lists the stale records to the lead, once');
  assert.match(listed[0].text, /Kid B1 \(passed at abcdef0\); Kid B2 \(fix at c\)/);
  assert.equal(decide({ ...base, workers: [old] }, { type: 'end' }).length, 0, 'later carries do not list them');
  assert.equal(decide({ ...base, woken: { 'W:B1:queued:c': 1 }, workers: [{ id: 'W', title: 'Kid', reviews: { B1: { state: 'queued', commit: 'c', at: 150 } } }] }, { type: 'end', chat: 'W' }).length, 0, 'another chat\'s end tells nobody');
});
