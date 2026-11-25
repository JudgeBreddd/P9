// O125 point 1: a message from the same sender can replace an earlier one still waiting for the turn's end, by its ID.
// The old one leaves the queue marked replaced (never silently dropped), and only the new one goes as the next prompt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { daemon, http, authenticated, root } from './helpers.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const start = (t) => daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
const call = (instance, route, method = 'GET', body, op) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(op && { 'x-p9-op': op }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((result) => ({ status: result.status, body: JSON.parse(result.text) }));
const events = async (instance, id, after = 0) => {
  const seen = [];
  for (let page; (page = await call(instance, '/chat/events?after=' + after + '&only=' + id)).body.events.length; after = page.body.cursor) seen.push(...page.body.events);
  return seen;
};
const until = async (check, what, ms = 60000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 100))) {
    const hit = await check();
    if (hit) return hit;
  }
  assert.fail('timed out: ' + what);
};

test('O125 point 1: a queued message replaced by its ID from the same sender leaves the queue marked replaced, and only the new one goes as the next prompt', { timeout: 120000 }, async (t) => {
  const instance = await start(t);
  await call(instance, '/file-protection', 'POST', { on: false });
  const id = (await call(instance, '/chat', 'POST', { provider: 'claude' })).body.conversation;
  // The first turn holds until the file go exists (the fake agent's gate), so the messages below wait for its end.
  assert.equal((await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'gate' })).status, 202);
  await until(async () => (await events(instance, id)).some((e) => e.type === 'update' && e.data?.content?.text === 'gating'), 'gate turn started');
  const first = await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'first wording', when: 'queue' });
  assert.equal(first.status, 202, JSON.stringify(first.body));
  const second = await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'second wording', when: 'queue', replaces: first.body.held });
  assert.equal(second.status, 202, JSON.stringify(second.body));
  assert.equal(second.body.replaced, first.body.held, 'the replace is reported by the old message ID');
  const left = (await events(instance, id)).filter((e) => e.type === 'unheld' && e.data.id === first.body.held);
  assert.equal(left.length, 1, 'the replaced message is not silently dropped');
  assert.equal(left[0].data.why, 'replaced');
  // Release the gate: the next prompt carries only the new wording.
  await writeFile(path.join(instance.workspace, 'go'), '');
  const prompt = await until(async () => (await events(instance, id)).find((e) => e.type === 'user' && e.data?.text === 'second wording'), 'the replacement went out');
  const sentTexts = (await events(instance, id)).filter((e) => e.type === 'user').map((e) => e.data.text);
  assert.ok(prompt && !sentTexts.includes('first wording'), 'the replaced wording must not be sent: ' + JSON.stringify(sentTexts));
});

test('A2 step 3: a waiting message edited by its ID keeps its place and goes with the new text; one already sent cannot be edited; a stale editor is refused; taken back gives the edited words', { timeout: 120000 }, async (t) => {
  const instance = await start(t);
  await call(instance, '/file-protection', 'POST', { on: false });
  const id = (await call(instance, '/chat', 'POST', { provider: 'claude' })).body.conversation;
  assert.equal((await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'gate' })).status, 202);
  await until(async () => (await events(instance, id)).some((e) => e.type === 'update' && e.data?.content?.text === 'gating'), 'gate turn started');
  const first = await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'alpha wording', when: 'queue' });
  const second = await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'bravo wording', when: 'queue' });
  const third = await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'charlie wording', when: 'queue' });
  assert.equal(third.status, 202, JSON.stringify(third.body));
  const was = 'alpha wording';
  for (const bad of [{ held: first.body.held, text: '  ', was }, { held: first.body.held, was }, { held: first.body.held, text: 'x'.repeat(100_001), was }, { held: first.body.held, text: 'no was' }])
    assert.equal((await call(instance, '/chat/' + id + '/held-text', 'POST', bad)).status, 400, JSON.stringify(bad).slice(0, 80));
  assert.equal((await call(instance, '/chat/' + id + '/held-text', 'POST', { held: '00000000-0000-4000-8000-000000000000', text: 'x', was: 'x' })).status, 409);
  const op = crypto.randomUUID(), edit = await call(instance, '/chat/' + id + '/held-text', 'POST', { held: first.body.held, text: 'alpha edited', was }, op);
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  // Another window's editor opened on the old words: refused with the words now, never written over them.
  const stale = await call(instance, '/chat/' + id + '/held-text', 'POST', { held: first.body.held, text: 'alpha stale', was });
  assert.deepEqual([stale.status, stale.body.error, stale.body.text], [409, 'changed', 'alpha edited'], JSON.stringify(stale.body));
  // Taken back after an edit: the answer carries the edited words (the phone puts these in its box, not its older copy).
  assert.equal((await call(instance, '/chat/' + id + '/held-text', 'POST', { held: third.body.held, text: 'charlie edited', was: 'charlie wording' })).status, 200);
  const back = await call(instance, '/chat/' + id + '/unhold', 'POST', { held: third.body.held });
  assert.deepEqual([back.status, back.body.text], [200, 'charlie edited'], JSON.stringify(back.body));
  const seen = await events(instance, id);
  const saves = seen.filter((e) => e.type === 'held-text');
  assert.deepEqual(saves.map((e) => ({ id: e.data.id, text: e.data.text })), [{ id: first.body.held, text: 'alpha edited' }, { id: third.body.held, text: 'charlie edited' }]);
  assert.equal(saves[0].data.op, op, 'a save names its operation, so its window knows it from an equal save');
  assert.deepEqual(seen.filter((e) => e.type === 'unheld').map((e) => e.data.id), [third.body.held], 'an edit takes nothing out of the queue');
  await writeFile(path.join(instance.workspace, 'go'), '');
  await until(async () => (await events(instance, id)).some((e) => e.type === 'user' && /bravo wording/.test(e.data?.text)), 'the queue went out');
  const sent = (await events(instance, id)).filter((e) => e.type === 'user').map((e) => e.data.text).join('\n');
  assert.ok(!sent.includes('alpha wording') && !sent.includes('alpha stale') && !sent.includes('charlie') && sent.indexOf('alpha edited') >= 0 && sent.indexOf('alpha edited') < sent.indexOf('bravo wording'), 'the edit goes in its old place: ' + sent);
  assert.equal((await call(instance, '/chat/' + id + '/held-text', 'POST', { held: first.body.held, text: 'too late', was: 'alpha edited' })).status, 409, 'a message already sent is not edited');
});
