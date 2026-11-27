// O274: the small daemon fixes the O267b reviews left (#559, #560, #562), one test each, on the real daemon and the fake agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { restart } from './helpers.mjs';
import { start, call, agent, until, events, pause } from './delegate-helpers.mjs';

const dbOf = (instance) => new DatabaseSync(path.join(instance.directory, '.local/state/p9-foundation/p9.db'), { timeout: 5000 });
// A plain chat that has answered once, then P9 stopped: the ledger is free to plant rows in.
async function stopped(t) {
  const instance = await start(t);
  const { body: { conversation: id } } = await call(instance, '/chat', 'POST', { provider: 'claude' });
  await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'hello' });
  await until(instance, (event) => event.conversation === id && event.type === 'turn-end');
  instance.child.kill('SIGTERM'); await once(instance.child, 'exit');
  return { instance, id };
}
const plant = (instance, chat, list) => { const db = dbOf(instance); db.prepare('INSERT OR REPLACE INTO prefs (key, value) VALUES (?, ?)').run('resuming:' + chat, JSON.stringify(list)); db.close(); };

// #559 r1: a model change whose config has no effort picker left the old effort on the worker row (sprint_status) and in list_chats.
test('O274: a config with no effort picker clears the effort list_chats and the worker row show', { timeout: 120000 }, async (t) => {
  const instance = await start(t);
  await call(instance, '/file-protection', 'POST', { on: false });
  const a = await agent(t, instance);
  const made = await a.tool('open_chat', { text: 'hello', title: 'Worker' });
  await a.done(made.chat);
  const effort = async () => (await a.tool('list_chats')).chats.find((c) => c.id === made.chat).effort;
  assert.equal(await effort(), 'medium', 'the effort it started on (the gauge is now kept)');
  fs.writeFileSync(path.join(path.resolve(instance.workspace, made.folder), 'no-effort'), ''); // its next config has no effort picker
  assert.equal((await call(instance, `/chat/${made.chat}/prompt`, 'POST', { text: 'on haiku', model: 'haiku' })).status, 202);
  await a.done(made.chat);
  const config = (await events(instance, made.chat)).filter((e) => e.type === 'config').at(-1);
  assert.ok(Array.isArray(config.data.pickers) && !config.data.pickers.some((o) => o.category === 'thought_level'), 'the newest config has no effort picker');
  assert.equal(await effort(), null, 'no effort shown for a model that has none');
});

// #560 r3: a message handed back unsent gives its text back once, not once per ID it waited under (a resumed one has two).
test('O274: a resumed message refused after a restart is handed back once, every ID it waited under retired', { timeout: 120000 }, async (t) => {
  const { instance, id } = await stopped(t);
  plant(instance, id, [{ id: 'q-now', chat: id, from: null, fromTitle: null, mixed: null, queued: 'q-now', prior: ['q-before'], body: { text: 'resumed once', mode: 'bogus' } }]);
  const second = await restart(t, instance, 'o274-once');
  let back = [];
  for (let i = 0; i < 100 && back.length < 2; i += 1) { back = (await events(second, id)).filter((e) => e.type === 'unheld' && e.data.text === 'resumed once'); await pause(100); }
  await pause(500); // nothing more after the two
  back = (await events(second, id)).filter((e) => e.type === 'unheld' && e.data.text === 'resumed once');
  assert.deepEqual(back.map((e) => [e.data.id, Boolean(e.data.again)]), [['q-now', false], ['q-before', true]], JSON.stringify(back.map((e) => e.data)));
  assert.deepEqual(back[0].data.was, ['q-before'], 'the first names the earlier ID, for the files sent under it');
});

// #562 r1: a joined prompt kept from before O246 (mixed) that waits behind a turn is a sender of its own: the user's
// message queued after it neither joins it nor runs under it.
test('O274: a kept joined prompt (mixed) waiting behind a turn goes alone, apart from the user\'s queued message', { timeout: 120000 }, async (t) => {
  const { instance, id } = await stopped(t);
  fs.writeFileSync(path.join(instance.workspace, 'log-prompts'), '');
  plant(instance, id, [
    { id: 'q-gate', chat: id, from: null, fromTitle: null, mixed: null, queued: 'q-gate', body: { text: 'gate' } },
    { id: 'q-mixed', chat: id, from: null, fromTitle: null, mixed: [randomUUID(), null], queued: 'q-mixed', body: { text: 'joined before' } }]);
  const second = await restart(t, instance, 'o274-mixed');
  const prompts = () => (fs.existsSync(path.join(instance.workspace, 'prompts.log')) ? fs.readFileSync(path.join(instance.workspace, 'prompts.log'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((blocks) => !blocks.some((block) => block.startsWith('[p9] '))) : []);
  // The gate turn runs and the kept prompt waits behind it (held), then the user's message queues after it.
  for (let i = 0; i < 150 && !(await events(second, id)).some((e) => e.type === 'held' && e.data.text === 'joined before'); i += 1) await pause(100);
  assert.equal((await call(second, `/chat/${id}/prompt`, 'POST', { text: 'mine', when: 'queue' })).status, 202);
  fs.writeFileSync(path.join(instance.workspace, 'go'), '');
  for (let i = 0; i < 300 && !prompts().some((b) => b.join('').includes('mine')); i += 1) await pause(100);
  const texts = prompts().map((b) => b.join('')).filter((x) => /joined before|mine/.test(x));
  assert.equal(texts.length, 2, 'two prompts, not one joined: ' + JSON.stringify(texts));
  assert.ok(texts[0].includes('joined before') && !texts[0].includes('mine') && texts[1].endsWith('mine') && !texts[1].includes('joined before'), JSON.stringify(texts));
});

// #562 r2: another chat's text is quoted before the size check, so one near the cap can go over it: refused by name.
test('O274: an agent\'s message the quoting pushes over 100,000 characters is refused as text-too-long', { timeout: 120000 }, async (t) => {
  const instance = await start(t);
  await call(instance, '/file-protection', 'POST', { on: false });
  const a = await agent(t, instance);
  const made = await a.tool('open_chat', { text: 'hello', title: 'Target' });
  await a.done(made.chat);
  const text = '[P9:'.repeat(10) + 'x'.repeat(100_000 - 40); // the cap exactly, as sent
  const sent = await a.tool('send_chat', { chat: made.chat, text });
  assert.equal(sent.reason, 'text-too-long', JSON.stringify(sent));
  assert.equal((await a.tool('send_chat', { chat: made.chat, text: 'x'.repeat(100_000) })).error, undefined, 'the cap itself, with nothing to quote, still goes');
});
