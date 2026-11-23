// I3 worker window, part B (OPEN-ITEMS 6.5): what the owner can do to one chat from its Sprint View Details, with no lead
// in between: steer, a message after its turn, a note, stop its turn, restart it from its notes, ask it to send for review,
// copy its folder's path. The owner's note route (POST /chat/:id/note) against a real daemon, the markup statusHtml
// draws, and the page's listener driven with a stand-in document; test/projects-page.test.mjs presses it in the real page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { statusHtml } from '../apps/web/src/sprint-view.mjs';
import { start, call, events, rows, pause, until } from './delegate-helpers.mjs';

test('I3 buttons: the owner\'s note starts no turn, is drawn as the owner\'s, and reaches the agent with its next message', { timeout: 120000 }, async (t) => {
  const instance = await start(t);
  const { body: { conversation: id } } = await call(instance, '/chat', 'POST', { provider: 'claude' });
  const state = async () => (await rows(instance)).find((c) => c.id === id).state;
  const quiet = async () => { for (let i = 0; i < 100 && await state() === 'turn'; i += 1) await pause(100); assert.notEqual(await state(), 'turn'); };
  await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'mode' });
  await until(instance, (e) => e.conversation === id && e.data?.content?.text?.startsWith('mode:'));
  await quiet();
  const users = async () => (await events(instance, id)).filter((e) => e.type === 'user').length, before = await users();
  const noted = await call(instance, `/chat/${id}/note`, 'POST', { text: 'the plan changed: B1 is yours' });
  assert.deepEqual([noted.status, noted.body.noted], [202, true], JSON.stringify(noted.body));
  await pause(500);
  assert.notEqual(await state(), 'turn', 'the note started a turn');
  assert.equal(await users(), before, 'the note was recorded as a message');
  assert.deepEqual((await events(instance, id)).filter((e) => e.type === 'note').map((e) => [e.data.text, e.data.from, e.data.fromTitle]),
    [['the plan changed: B1 is yours', 'user', 'You, from the Sprint View']], 'drawn as the owner\'s, not as a deleted chat\'s');
  // The next message carries it to the agent (the stand-in echoes what it was given).
  const cursor = (await call(instance, '/chat/events?after=0&wait=0')).body.cursor;
  await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'go on' });
  const { hit } = await until(instance, (e) => e.conversation === id && e.data?.content?.text?.startsWith('echo:'), cursor);
  assert.match(hit.data.content.text, /the plan changed: B1 is yours/);
  // Text only, 1 to 20000 characters, for a chat that exists.
  for (const body of [{ text: 'x'.repeat(20001) }, { text: '   ' }, { text: 'x', when: 'queue' }, { text: 5 }, {}])
    assert.equal((await call(instance, `/chat/${id}/note`, 'POST', body)).status, 400, JSON.stringify(body).slice(0, 40));
  assert.equal((await call(instance, '/chat/00000000-0000-4000-8000-000000000000/note', 'POST', { text: 'x' })).status, 404);
});

const esc = (v) => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const w = (chat, more) => ({ chat, key: chat, title: chat, provider: 'fake', profile: null, model: 'm', effort: 'e', state: 'idle', folder: '/w/' + chat, work: null, look: null, ...more });
const s = (workers, closed = null) => ({ sprint: { id: 'L' }, closed, workers, items: [], done: { merged: 0, ticked: 0, total: 0 }, spent: null, scripts: { running: 0, additional: 0, waiting: 0 } });
const row = (html, chat) => html.split('<li data-key="').find((x) => x.startsWith(chat + '"')) ?? '';
const acts = (r) => [...r.matchAll(/data-sv-act="([a-z]+)"/g)].map((m) => m[1]);

test('I3 buttons: an open sprint\'s Details has each press; a stopped chat only Copy path, with why; a closed record none', () => {
  const html = statusHtml(s([w('a'), w('b', { state: 'stopped' }), w('c', { folder: null })]), esc), a = row(html, 'a'), b = row(html, 'b');
  assert.deepEqual(acts(a), ['steer', 'queue', 'note', 'stop', 'restart', 'review', 'copy']);
  assert.match(a, /data-sv-act="restart"[^>]*data-notes="notes\/a\.md"/);
  assert.match(a, /data-sv-act="copy"[^>]*data-path="\/w\/a"/);
  assert.match(a, /<textarea[^>]*data-sv-msg/);
  assert.match(a, /Moving an item to another chat is not here/);
  // A stopped chat holds no place: a message from here would start it past the place limit (only send_chat checks it).
  assert.deepEqual(acts(b), ['copy']);
  assert.doesNotMatch(b, /data-sv-msg/);
  assert.match(b, /data-sv-stopped>Stopped: it holds no worker place/);
  assert.deepEqual(acts(row(html, 'c')), ['steer', 'queue', 'note', 'stop', 'restart', 'review'], 'no folder, no Copy path');
  assert.doesNotMatch(statusHtml(s([w('a')], { at: 1, by: 'owner' }), esc), /data-sv-act|data-sv-msg/);
});

// The page's listener, with a stand-in document and held answers. A second copy of the module (its own per-chat state),
// so the markup test above sees none of this.
const on = {}, sent = [], answers = [];
const live = async () => {
  globalThis.document = { addEventListener: (t, f) => { (on[t] ??= []).push(f); } };
  globalThis.window = { p9: { chat: (what, body) => { sent.push([what, body]); return new Promise((r) => { answers.push(r); }); } } };
  return import('../apps/web/src/sprint-view.mjs?buttons');
};
const page = (chat) => {
  const said = { textContent: '' }, ta = { value: '', disabled: false }, btns = {};
  const box = { querySelector: (q) => (q === '[data-sv-msg]' ? ta : q === '[data-sv-asaid]' ? said : null), querySelectorAll: () => [...Object.values(btns).filter((b) => b.dataset.svAct !== 'copy'), ta] };
  const li = { dataset: { key: chat }, querySelector: (q) => (q === '[data-sv-acts]' ? box : q === '[data-sv-msg]' ? ta : null) };
  ta.closest = (q) => (q === '[data-sv-msg]' ? ta : q === 'li[data-key]' ? li : null);
  const btn = (act) => (btns[act] ??= { dataset: { svAct: act }, disabled: false, closest(q) { return q === '[data-sv-act]' ? this : q === 'li[data-key]' ? li : null; } });
  ['steer', 'queue', 'note', 'stop', 'restart', 'review', 'copy'].forEach((a) => btn(a));
  return { said, ta, btn, type: (x) => { ta.value = x; on.input.forEach((h) => h({ target: ta })); }, press: (act, more) => { Object.assign(btn(act).dataset, more); on.click.forEach((h) => h({ target: btn(act) })); } };
};
const settle = () => new Promise((r) => setTimeout(r, 0));
const answer = async (status, body = {}) => { answers.shift()({ status, body }); await settle(); await settle(); };

test('I3 buttons: each press sends its route; nothing goes without text; one send at a time; the text stays on a refusal', async () => {
  await live();
  try {
    const p = page('c1');
    p.press('note');
    assert.deepEqual([sent.length, p.said.textContent], [0, 'Write a message first.']);
    p.type('look at B1');
    p.press('steer');
    assert.deepEqual(sent.at(-1), ['prompt', { id: 'c1', text: 'look at B1', when: 'steer' }]);
    assert.equal(p.btn('queue').disabled, true, 'locked while a send is out');
    p.press('queue');
    assert.equal(sent.length, 1, 'a second press while one is out sent');
    await answer(409, { error: 'turn-running' });
    assert.deepEqual([p.said.textContent, p.ta.value, p.btn('queue').disabled], ['Not sent: turn-running.', 'look at B1', false], 'a refusal keeps the text');
    p.press('queue');
    assert.deepEqual(sent.at(-1), ['prompt', { id: 'c1', text: 'look at B1', when: 'queue' }]);
    await answer(202, { held: 'h1', when: 'queue' });
    assert.deepEqual([p.said.textContent, p.ta.value], ['Sent: it gets it when its running turn ends.', ''], 'sent: the text is cleared');
    p.type('B1 moved to docs');
    p.press('note');
    assert.deepEqual(sent.at(-1), ['note', { id: 'c1', text: 'B1 moved to docs' }]);
    await answer(202, { noted: true });
    assert.equal(p.said.textContent, 'Noted: it reads it with its next message.');
    p.press('review');
    assert.equal(sent.at(-1)[0], 'prompt');
    assert.equal(sent.at(-1)[1].when, 'queue');
    assert.match(sent.at(-1)[1].text, /call ready with your row id/);
    await answer(202, { turn: 't' });
    assert.equal(p.said.textContent, 'Sent: it started a turn.');
  } finally { sent.length = 0; answers.length = 0; }
});

test('I3 buttons: Stop is its turn\'s cancel; Restart cancels, then queues "read your notes", and goes on when no turn ran', async () => {
  await live();
  try {
    const p = page('c2');
    p.press('stop');
    assert.deepEqual(sent.at(-1), ['cancel', { id: 'c2' }]);
    await answer(409, { error: 'no-turn' });
    assert.equal(p.said.textContent, 'It has no turn running.');
    const restart = async (cancelled) => {
      const n = sent.length;
      p.press('restart', { notes: 'notes/c2.md' });
      assert.deepEqual(sent.at(-1), ['cancel', { id: 'c2' }]);
      await answer(...cancelled);
      return sent.slice(n + 1);
    };
    for (const cancelled of [[200, { ok: true }], [409, { error: 'no-turn' }]]) {
      const after = await restart(cancelled);
      assert.equal(after.length, 1, 'no message after the cancel');
      assert.equal(after[0][1].when, 'queue');
      assert.match(after[0][1].text, /read notes\/c2\.md in the sprint folder first, then carry on/);
      await answer(202, { turn: 't' });
      assert.equal(p.said.textContent, 'Restarted: its turn stopped and it reads its notes next.');
    }
    // A cancel refused for another reason sends no message: the turn may still be running.
    assert.deepEqual(await restart([409, { error: 'moving' }]), []);
    assert.equal(p.said.textContent, 'Not sent: moving.');
  } finally { sent.length = 0; answers.length = 0; }
});

test('I3 buttons: the text and a send going out are kept per chat across the 5 s redraw', async () => {
  const v = await live();
  try {
    const p = page('c3');
    p.type('half typed <b>');
    p.press('steer');
    const r = row(v.statusHtml(s([w('c3'), w('c4')]), esc), 'c3');
    assert.match(r, /<textarea[^>]*disabled[^>]*>half typed &lt;b&gt;<\/textarea>/);
    assert.match(r, /data-sv-act="note"[^>]*disabled/);
    assert.doesNotMatch(r.match(/<button[^>]*data-sv-act="copy"[^>]*>/)[0], /disabled/, 'Copy path is never locked');
    assert.match(r, /data-sv-asaid role="status">Sending…</);
    assert.doesNotMatch(row(v.statusHtml(s([w('c3'), w('c4')]), esc), 'c4'), /disabled|half typed/, 'another chat keeps its own');
    await answer(202, { steered: true });
    assert.match(row(v.statusHtml(s([w('c3')]), esc), 'c3'), /data-sv-msg[^>]*><\/textarea>[^]*Sent into its running turn\./);
  } finally { sent.length = 0; answers.length = 0; }
});
