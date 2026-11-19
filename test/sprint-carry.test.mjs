// O193: P9 carries a sprint item from ready to the merge. Each wake goes to the item's one next actor, once per
// (worker, item, state, commit); a restart and a dropped event are caught; outside a sprint nothing new is sent.
// createDelegate over a stub chat: the persisted records live in `store`, so a new createDelegate is a P9 restart.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDelegate } from '../apps/server/delegate.mjs';

const lead = '00000000-0000-0000-0000-00000000000a';
const worker = '00000000-0000-0000-0000-00000000000b';
const reviewer = '00000000-0000-0000-0000-00000000000c';

function repo(t) {
  const folder = mkdtempSync(join(tmpdir(), 'p9-carry-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '-b', 'main', folder]);
  const commit = (m) => { execFileSync('git', ['-C', folder, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', m]); return execFileSync('git', ['-C', folder, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); };
  return { folder, commit };
}

// sprint: whether the lead has a started, open sprint. withReviewer: whether a review chat is under the lead.
function world(t, { sprint = true, withReviewer = true } = {}) {
  const { folder, commit } = repo(t);
  const store = new Map([[worker, { task: { item: 'B1', doneMeans: 'done', checks: ['test'] } }]]);
  const states = new Map([[lead, 'running'], [worker, 'running'], [reviewer, 'running']]);
  const family = [{ id: lead, project: 'p', title: 'Lead' }, { id: worker, parent: lead, key: 'w1', project: 'p', title: 'Kid' },
    ...(withReviewer ? [{ id: reviewer, parent: lead, key: 'review', project: 'p', title: 'Rev' }] : [])];
  const prompts = [], notes = [];
  let restart = { chats: [], storm: false };
  const make = () => {
    let settled = [], ready;
    const restarted = new Promise((resolve) => { ready = resolve; });
    const chat = {
      lock: () => ({ on: false }), list: () => [], family: () => family,
      info: (id) => { const c = family.find((x) => x.id === id); return c && { ...c, state: states.get(id) }; },
      activeTaskTurn: (id) => (states.get(id) === 'turn' ? 'turn-1' : null),
      sprint: (id) => store.get(id) ?? {}, setSprint: (id, patch) => store.set(id, { ...(store.get(id) ?? {}), ...patch }),
      startFolder: async () => folder, gauge: () => ({}), pin: () => {}, turnEnded: () => {}, acts: () => 0, reply: () => '',
      note: async (id, text) => { notes.push([id, text]); }, prompt: async (id, body) => { prompts.push([id, body.text]); return { status: 202 }; },
      settled: (hook) => { settled.push(hook); }, restarted: () => restarted,
      projects: { started: (id) => (sprint && id === lead ? { plan: 'hash' } : null), closed: () => null }, paused: () => false,
    };
    const tools = createDelegate({ chat });
    return { tools, end: (id) => { for (const hook of settled) hook(id, true); }, boot: () => { ready(restart); return restarted.then(() => new Promise((r) => setImmediate(r))); } };
  };
  const ready = async (p9, c) => { states.set(worker, 'turn'); const out = await p9.tools.ready({ commit: c, results: [{ check: 'test', result: 'passed' }], weakest: 'none' }, worker); states.set(worker, 'running'); assert.ok(out.ready, JSON.stringify(out)); return out; };
  const verdict = (p9, c, result) => { states.set(reviewer, 'turn'); const out = p9.tools.verdict({ chat: worker, commit: c, result, note: 'see the test' }, reviewer); states.set(reviewer, 'running'); assert.ok(out.verdict, JSON.stringify(out)); };
  const who = { [lead]: 'lead', [worker]: 'worker', [reviewer]: 'reviewer' };
  return { make, store, states, commit, prompts, notes, ready, verdict, order: () => prompts.map(([id]) => who[id]), setRestart: (r) => { restart = r; } };
}

test('O193: an item\'s whole life (ready, fix, ready, pass) wakes reviewer, worker, reviewer, lead, in that order, and nothing else', { timeout: 20000 }, async (t) => {
  const w = world(t), p9 = w.make();
  await p9.boot();
  const c1 = w.commit('one');
  await w.ready(p9, c1); p9.end(worker);
  w.verdict(p9, c1, 'fix'); p9.end(reviewer);
  const c2 = w.commit('two');
  await w.ready(p9, c2); p9.end(worker);
  w.verdict(p9, c2, 'pass'); p9.end(reviewer);
  p9.end(lead); p9.end(worker); p9.end(reviewer); // later turn ends wake nobody again
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(w.order(), ['reviewer', 'worker', 'reviewer', 'lead'], JSON.stringify(w.prompts));
  assert.equal(w.prompts[3][1], `[p9] B1 by Kid passed at ${c2}: merge it.`);
  assert.match(w.prompts[1][1], new RegExp(`^\\[p9\\] B1: the reviewer asked for a fix \\(fix 1\\) at ${c1}: see the test$`));
  assert.ok(w.notes.some(([id, text]) => id === worker && text.includes('passed review')), 'the worker hears of the pass as a note');
});

test('O193: a P9 restart between ready and verdict still wakes the reviewer, once', { timeout: 20000 }, async (t) => {
  const w = world(t), first = w.make();
  await first.boot();
  w.states.set(reviewer, 'turn'); // busy at ready: no wake yet
  const c1 = w.commit('one');
  await w.ready(first, c1);
  assert.deepEqual(w.order(), []);
  w.states.set(reviewer, 'stopped'); // P9 restarts: the reviewer's turn and its end are lost
  const second = w.make();
  await second.boot();
  assert.deepEqual(w.order(), ['reviewer']);
  const third = w.make(); // another restart: the wake is recorded, so not sent again; the lead is told once instead
  await third.boot();
  await w.make().boot();
  assert.deepEqual(w.order(), ['reviewer', 'lead']);
  assert.match(w.prompts[1][1], /Rev ended its turn on B1 at .* without acting on it/);
});

test('O193: a dropped event is caught on the next event for that sprint; a reviewer ending with no verdict tells the lead once', { timeout: 20000 }, async (t) => {
  const w = world(t), p9 = w.make();
  await p9.boot();
  w.states.set(reviewer, 'turn');
  const c1 = w.commit('one');
  await w.ready(p9, c1);
  w.states.set(reviewer, 'running'); // its turn ended, but that event never came
  assert.deepEqual(w.order(), []);
  p9.end(lead); // the next event for the sprint, from another chat
  assert.deepEqual(w.order(), ['reviewer']);
  p9.end(reviewer); // woken, ended, no verdict
  p9.end(reviewer);
  assert.deepEqual(w.order(), ['reviewer', 'lead']);
});

test('O193: ready with no reviewer tells the lead; a pair outside a sprint gets only what it got before', { timeout: 20000 }, async (t) => {
  const lone = world(t, { withReviewer: false }), p9 = lone.make();
  await p9.boot();
  await lone.ready(p9, lone.commit('one'));
  assert.deepEqual(lone.order(), ['lead']);
  assert.match(lone.prompts[0][1], /no reviewer can take it/);

  const out = world(t, { sprint: false }), plain = out.make();
  await plain.boot();
  const c1 = out.commit('one');
  await out.ready(plain, c1); plain.end(worker);
  out.verdict(plain, c1, 'fix'); plain.end(reviewer);
  const c2 = out.commit('two');
  await out.ready(plain, c2); plain.end(worker);
  out.verdict(plain, c2, 'pass'); plain.end(reviewer); plain.end(lead);
  await out.make().boot();
  assert.deepEqual(out.order(), ['reviewer', 'worker', 'reviewer', 'worker'], 'today\'s prompts: the ready line, the fix and the pass to the worker');
  assert.equal(out.store.get(lead)?.carry, undefined, 'nothing is recorded outside a sprint');
});
