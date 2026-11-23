// O233: a closed folder sprint's page, the part that shows its copy's change and takes the owner's yes (sprint-view.mjs).
// Each state the status route can answer draws its own box; only a change with files to save gets the button.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPress, statusHtml } from '../apps/web/src/sprint-view.mjs';

const esc = (v) => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const id = '55555555-5555-4555-8555-555555555555';
const closed = (copy) => ({ sprint: { id, title: 'Folder' }, closed: { at: 1, by: 'owner' }, done: { merged: 0, ticked: 0, total: 1 }, running_ms: 1000,
  items: [{ id: 'A1', text: 'A1: edit', role: 'lead', ticked: false, review: null }], phases: [], workers: [], scripts: { running: 0, additional: 0, waiting: 0 }, copy });
const box = (html) => html.match(/<div data-sv-copy="(\w+)">/)?.[1] ?? null;
const waiting = { applied: false, source: '/srv/solo', changes: [{ path: 'a<b>.txt', status: 'M' }], left: [], shown: 'd1', unnamed: 1 };

test('Sprint View copy: each answer draws its own box, and only a change with files gets the yes', () => {
  const w = statusHtml(closed(waiting), esc);
  assert.equal(box(w), 'waiting');
  assert.match(w, /changed <code>a&lt;b&gt;.txt<\/code>/, 'a path is escaped');
  assert.match(w, /data-pj="spapply" data-lead="5{8}-[^"]+" data-shown="d1">Yes, save to my folder</);
  assert.match(w, /has 1 commit since the sprint started that no review names/);
  // A press out: the button is disabled, so a second press sends nothing.
  assert.match(statusHtml(closed(waiting), esc, { closing: true }), /data-shown="d1" disabled>Saving…</);
  assert.match(statusHtml(closed(waiting), esc, { said: 'Not saved: changed-since-shown' }), /data-sv-apply-said role="status">Not saved: changed-since-shown</);
  // Nothing changed in the copy: no button, nothing to say yes to.
  const none = statusHtml(closed({ ...waiting, changes: [], unnamed: 0 }), esc);
  assert.deepEqual([box(none), none.includes('spapply'), none.includes('data-sv-unnamed')], ['waiting', false, false]);
  // The preview refused (no copy, unreadable): said, no button.
  const refused = statusHtml(closed({ applied: false, refused: 'copy-unreadable' }), esc);
  assert.deepEqual([box(refused), /P9 cannot show it: copy-unreadable\./.test(refused), refused.includes('spapply')], ['refused', true, false]);
  // Applied but its result not known yet (pending): the record's lines, no lists claimed.
  const pending = statusHtml(closed({ applied: true, pending: true, lines: ['The apply has not finished.'] }), esc);
  assert.deepEqual([box(pending), pending.includes('The apply has not finished.'), pending.includes('<h3>Written</h3>'), pending.includes('spapply')], ['applied', true, false, false]);
  const done = statusHtml(closed({ applied: true, lines: [], written: ['a.txt'], rolledBack: [], left: [{ path: 'b.txt', reason: 'newer' }] }), esc);
  assert.deepEqual([box(done), done.includes('<code>a.txt</code>'), /<code>b.txt<\/code>: newer/.test(done), done.includes('Rolled back')], ['applied', true, true, false]);
  // A sprint with no copy (a repository with a remote) shows no box; an open sprint shows none either.
  assert.equal(box(statusHtml(closed(null), esc)), null);
  assert.equal(box(statusHtml({ ...closed(waiting), closed: null }, esc)), null);
});

test('Sprint View copy: the yes says why it was not saved, also when the call itself throws', async (t) => {
  t.after(() => { delete globalThis.window; });
  const b = { dataset: { lead: id, shown: 'd1' } }, sent = [];
  globalThis.window = { p9: { mission: async (action, body) => { sent.push([action, body]); return { status: 200, body: {} }; } } };
  assert.equal(await applyPress(b), '');
  assert.deepEqual(sent, [['sprintApply', { id, shown: 'd1' }]]);
  globalThis.window.p9.mission = async () => ({ status: 409, body: { refused: 'sprint-running' } });
  assert.equal(await applyPress(b), 'Not saved: sprint-running');
  globalThis.window.p9.mission = () => { throw new Error('no mission'); };
  assert.equal(await applyPress(b), 'Not saved: no mission', 'a call that throws at once is said, not left as Saving…');
  globalThis.window = {};
  assert.match(await applyPress(b), /^Not saved: \S/, 'no bridge at all (the phone) is said, not thrown');
});
