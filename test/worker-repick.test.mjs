// I3 worker window (OPEN-ITEMS 5.5): each chat's Sprint View row has Model or effort, which moves it to another model or
// effort from its next turn as a message the owner sends it. Here the markup statusHtml draws from the status answer and
// the shell's agent lists; test/projects-page.test.mjs presses it in the real page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { statusHtml } from '../apps/web/src/sprint-view.mjs';

const esc = (v) => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const effort = { id: 'effort', category: 'thought_level', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] };
const o = { names: { fake: 'Fake', other: 'Other' }, pickerKind: (p) => (p.category === 'thought_level' ? 'effort' : ''),
  lastModels: { fake: { options: [{ value: 'default', name: 'Default' }, { group: 'more', name: 'More', options: [{ value: 'opus', name: 'Opus' }] }] }, claude: { options: [{ value: 'sonnet', name: 'Sonnet' }] } },
  lastPickers: { fake: [effort], claude: [effort] } };
const w = (chat, more) => ({ chat, key: chat, title: chat, provider: 'fake', profile: null, model: 'default', effort: 'medium', state: 'idle', work: null, ...more });
const s = (workers, closed = null) => ({ sprint: { id: 'L' }, closed, workers, items: [], done: { merged: 0, ticked: 0, total: 0 }, spent: null, scripts: { running: 0, additional: 0, waiting: 0 } });
const row = (html, chat) => new RegExp(`<li data-key="${chat}">([^]*?)</li>`).exec(html)?.[1] ?? '';
const opts = (r, kind) => [...(new RegExp(`data-sv-r="${kind}"[^>]*>([^]*?)</select>`).exec(r)?.[1] ?? '').matchAll(/<option value="([^"]*)"( selected)?/g)].map((m) => m[1] + (m[2] ? '*' : ''));

test('I3 worker window: each chat row has Model or effort, with its agent\'s lists and what it runs on picked', () => {
  const html = statusHtml(s([w('a'), w('b', { profile: 'p1', effort: 'low' }), w('c', { provider: 'other' }), w('d', { model: 'gone', effort: 'odd' })]), esc, {}, o), a = row(html, 'a');
  assert.match(a, /data-sv-pick aria-expanded="false"[^>]*>Model or effort</);
  assert.match(a, /data-sv-repick hidden/, 'closed until pressed');
  assert.deepEqual([opts(a, 'model'), opts(a, 'effort')], [['default*', 'opus'], ['medium*', 'low', 'high']], 'grouped models flattened; an effort not in the list still shows, picked');
  assert.match(a, /data-sv-r="effort" data-now="medium" data-id="effort"/, 'the config id the pick is sent under');
  // A provider profile chat keeps its model (SECURITY.md § Delegate, I3): effort only.
  assert.deepEqual([opts(row(html, 'b'), 'model'), opts(row(html, 'b'), 'effort')], [[], ['low*', 'high']]);
  // An agent with no lists yet says how to get them, and has nothing to send.
  assert.match(row(html, 'c'), /Start one Other chat first/); assert.doesNotMatch(row(html, 'c'), /data-sv-apply/);
  assert.deepEqual(opts(row(html, 'd'), 'model'), ['gone*', 'default', 'opus']);
});

test('I3 worker window: a closed sprint\'s record, and a caller with no lists, draw no control', () => {
  assert.doesNotMatch(statusHtml(s([w('a')], { at: 1, by: 'owner' }), esc, {}, o), /data-sv-pick/);
  assert.doesNotMatch(statusHtml(s([w('a')]), esc), /data-sv-pick/);
});

// Review fix 1: the page's listeners, driven with a stand-in document and a held prompt answer. A second copy of the module
// (its own picks) so the tests above see none of this.
const on = {}, sent = []; let answer;
const live = async () => {
  globalThis.document = { addEventListener: (t, f) => { (on[t] ??= []).push(f); } };
  globalThis.window = { p9: { chat: (what, body) => { sent.push([what, body]); return new Promise((r) => { answer = r; }); } } };
  return import('../apps/web/src/sprint-view.mjs?fix1');
};
const page = (chat, now) => {
  const said = { textContent: '' }, sel = { dataset: { svR: 'effort', now, id: 'effort' }, value: now || 'low', disabled: false };
  const f = { hidden: false, querySelector: (q) => (q === '[data-sv-said]' ? said : q === '[data-sv-r="effort"]' ? sel : null), querySelectorAll: () => [sel] };
  const li = { dataset: { key: chat }, querySelector: () => f };
  const b = { dataset: {}, disabled: false, closest: (q) => (q === 'li[data-key]' ? li : q.includes('data-sv-apply') ? b : null) };
  sel.closest = (q) => (q === '[data-sv-r]' ? sel : li);
  return { said, sel, b, pick: (x) => { sel.value = x; on.change.forEach((h) => h({ target: sel })); }, send: () => on.click.forEach((h) => h({ target: b })) };
};
test('I3 worker window: with no current value known, Send without a pick sends nothing (not the first option)', async () => {
  await live();
  try {
    const u = page('u', '');
    u.send();
    assert.deepEqual([sent.length, u.said.textContent], [0, 'Pick another model or effort first.']);
  } finally { sent.length = 0; }
});

test('I3 worker window: picks are locked while a send is out and kept locked through the redraw, so the 202 loses no newer pick', async () => {
  const v = await live();
  const draw = (chat, effort) => row(v.statusHtml(s([w(chat, { effort })]), esc, {}, o), chat);
  try {
    const a = page('a', 'medium');
    a.pick('high'); a.send();
    assert.equal(sent.length, 1); assert.deepEqual(sent[0][1].config, { effort: 'high' });
    assert.deepEqual([a.sel.disabled, a.b.disabled], [true, true], 'a pick changed while its send is out would be lost by the 202');
    assert.match(draw('a', 'medium'), /data-sv-r="effort" data-now="medium" data-id="effort" disabled[^]*value="high" selected[^]*data-sv-apply disabled/);
    answer({ status: 202 }); await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual([a.sel.disabled, a.b.disabled, a.said.textContent], [false, false, 'Sent: high from its next turn.']);
    assert.match(draw('a', 'high'), /data-now="high" data-id="effort" aria-label[^]*value="high" selected/);
  } finally { delete globalThis.document; delete globalThis.window; }
});
