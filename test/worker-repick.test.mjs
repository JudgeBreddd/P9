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
