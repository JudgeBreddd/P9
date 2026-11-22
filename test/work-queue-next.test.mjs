// Work Queue row (OPEN-ITEMS "The work queue", left part): the Sprint View row of a worker with no item taken said only
// "No item taken yet"; it now names the next item of its queue, the one ready would report:
// the first not passed, as ready (delegate.mjs) and the card (chat-view itemLine) pick it: an item merged without a pass
// (mergedNow proves any review commit that landed, fix or queued too) is still next. The status (sprint_status and the
// page) carries it as work.next; null when every item passed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHooks } from '../apps/server/sprint-hooks.mjs';
import { statusHtml } from '../apps/web/src/sprint-view.mjs';

const esc = (v) => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const id = '55555555-5555-4555-8555-555555555555', c1 = '66666666-6666-4666-8666-666666666666';
const plan = '# Plan\n\n- [ ] a1: first. Role: w1.\n- [ ] b1: second <b>. Role: w1.\n- [ ] c1: third. Role: w1.\n- [ ] P1v: the owner looks. Role: w1.\n';
const passed = { state: 'passed', commit: 'a'.repeat(40), at: 1 };
// queue: chat.queue's answer for a started worker (null: the status counts the plan's own lines, as for the lead).
const status = (reviews, queue = null, gauge = () => null) => {
  const chat = { lock: () => ({ on: false }), info: (c) => (c === id ? { title: 'S', provider: 'fake' } : c === c1 ? { title: 'w1', provider: 'fake', parent: id } : null),
    family: () => [{ id }, { id: c1, parent: id, key: 'w1' }], list: () => [{ id }, { id: c1 }], gauge, startFolder: async () => '.',
    sprint: (c) => (c === c1 ? { reviews } : {}), ...(queue && { queue: (c) => (c === c1 ? queue : null) }),
    scriptLibrary: () => [], allowScripts: () => false, mergedNow: async () => undefined,
    sprintFiles: { exists: (c) => c === id, read: (c, name) => (name === 'sprint.md' ? plan : null), folderOf: () => '.', log: () => {} },
    projects: { started: () => ({ at: 1, by: 'owner', plan: null, scripts: [] }), closed: () => null, prepOf: () => null, record: async () => null, merge: () => true } };
  return createHooks({ chat, usage: () => null, stateOf: () => 'idle', rolesOf: () => ({ error: 'none' }), allowed: async () => true }).status(id, id);
};
const w1 = (got) => got.workers.find((w) => w.key === 'w1');
// The w1 row's item line (the lead's row comes first).
const item = (html) => /data-sv-worker="w1"[^]*?<span class="sv-item">([^<]*)<\/span>/.exec(html)?.[1];

test('Work Queue next item: the Sprint View row names the worker\'s next queued item, as ready would pick it', async () => {
  // The plan's own lines (no started queue): a1 merged, b1 open, so b1 is next; the owner's v line is never a worker's.
  let got = await status({ a1: { ...passed, merged: true } });
  assert.deepEqual(w1(got).work, { done: 1, total: 3, next: 'b1: second <b>. Role: w1.' }, JSON.stringify(got.workers));
  assert.equal(item(statusHtml(got, esc)), 'Next: b1: second &lt;b&gt;. Role: w1.', 'escaped, the id once');
  // a1 passed but not merged: the worker is done with it (the lead merges), so b1 is still next.
  got = await status({ a1: passed });
  assert.equal(w1(got).work.next, 'b1: second <b>. Role: w1.');
  // Every item passed: nothing left to take; the row says so instead of "No item taken yet".
  got = await status({ a1: passed, b1: passed, c1: { ...passed, merged: true } });
  assert.deepEqual(w1(got).work, { done: 1, total: 3, next: null });
  assert.equal(item(statusHtml(got, esc)), 'All its items passed review');
  // Merged without a pass (Reviewer, #425 round 1): a fix round's commit landed, mergedNow marked it merged; ready still
  // reports a1, so the row names a1, not b1.
  got = await status({ a1: { state: 'fix', commit: 'a'.repeat(40), fixes: 1, merged: true } });
  assert.deepEqual(w1(got).work, { done: 1, total: 3, next: 'a1: first. Role: w1.' });
  assert.equal(item(statusHtml(got, esc)), 'Next: a1: first. Role: w1.');
  // A started worker's queue (chat.queue): the same rule on its rows' state.
  const rows = [{ id: 'a1', text: 'a1: first. Role: w1.', state: 'passed', merged: false }, { id: 'b1', text: 'b1: second. Role: w1.', state: 'queued', merged: true }, { id: 'c1', text: 'c1: third. Role: w1.', state: 'todo', merged: false }];
  got = await status({}, { done: 1, total: 3, items: rows });
  assert.deepEqual(w1(got).work, { done: 1, total: 3, next: 'b1: second. Role: w1.' });
  // A worker on a task: its task's item, as before; a record saved before work.next: "No item taken yet", as before.
  const row = { key: 'w1', chat: c1, title: 'w1', state: 'idle', work: { done: 0, total: 2, next: 'b1: second. Role: w1.' } };
  assert.equal(item(statusHtml({ ...got, workers: [{ ...row, task: { item: 'a1: first. Role: w1.' } }] }, esc)), 'a1: first. Role: w1.');
  assert.equal(item(statusHtml({ ...got, workers: [{ ...row, work: { done: 0, total: 2 } }] }, esc)), 'No item taken yet');
  console.log('PASS Work Queue next item: plan lines and a started queue both name the first item not passed, merged or not, as ready does; all passed says so; a task and an old record show as before');
});

// Phase 5.5 "Per-worker usage and a limit on the card" (spec I3, tokens used): a worker's row shows what that chat has
// used (the status answer's spent per worker, as list_chats has it), in the words of the sprint's own Used line. A chat
// with nothing reported shows nothing; a field it did not report counts as 0, never "NaN".
test('Per-worker usage: the Sprint View row shows the tokens that worker used; nothing when none were reported', async () => {
  const got = await status({}, null, (c) => (c === c1 ? { context: null, spent: { inputTokens: 1200, outputTokens: 300, costUsd: 0.5 } } : null));
  const html = statusHtml(got, esc), main = (k) => new RegExp(`data-sv-worker="${k}"[^]*?<span class="sv-main">([^]*?)</span></span>`).exec(html)?.[1];
  assert.match(main('w1'), /1\.2K in · 300 out · 0 cached · \$0\.50/, html);
  assert.doesNotMatch(main('lead'), / in · /, 'the lead reported nothing: no usage on its row');
});
