// O125 point 1: a message from the same sender can replace an earlier one still waiting for the turn's end, by its ID.
// The old one leaves the queue marked replaced (never silently dropped), and only the new one goes as the next prompt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { daemon, http, authenticated, root } from './helpers.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const start = (t) => daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
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

test('A2 step 3: a waiting message edited by its ID keeps its place and goes with the new text; one already sent cannot be edited', { timeout: 120000 }, async (t) => {
  const instance = await start(t);
  await call(instance, '/file-protection', 'POST', { on: false });
  const id = (await call(instance, '/chat', 'POST', { provider: 'claude' })).body.conversation;
  assert.equal((await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'gate' })).status, 202);
  await until(async () => (await events(instance, id)).some((e) => e.type === 'update' && e.data?.content?.text === 'gating'), 'gate turn started');
  const first = await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'alpha wording', when: 'queue' });
  const second = await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'bravo wording', when: 'queue' });
  assert.equal(second.status, 202, JSON.stringify(second.body));
  for (const bad of [{ held: first.body.held, text: '  ' }, { held: first.body.held }, { held: first.body.held, text: 'x'.repeat(100_001) }])
    assert.equal((await call(instance, '/chat/' + id + '/held-text', 'POST', bad)).status, 400, JSON.stringify(bad).slice(0, 80));
  assert.equal((await call(instance, '/chat/' + id + '/held-text', 'POST', { held: '00000000-0000-4000-8000-000000000000', text: 'x' })).status, 409);
  const edit = await call(instance, '/chat/' + id + '/held-text', 'POST', { held: first.body.held, text: 'alpha edited' });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  const seen = await events(instance, id);
  assert.deepEqual(seen.filter((e) => e.type === 'held-text').map((e) => e.data), [{ id: first.body.held, text: 'alpha edited' }]);
  assert.equal(seen.filter((e) => e.type === 'unheld').length, 0, 'an edit takes nothing out of the queue');
  await writeFile(path.join(instance.workspace, 'go'), '');
  await until(async () => (await events(instance, id)).some((e) => e.type === 'user' && /bravo wording/.test(e.data?.text)), 'the queue went out');
  const sent = (await events(instance, id)).filter((e) => e.type === 'user').map((e) => e.data.text).join('\n');
  assert.ok(!sent.includes('alpha wording') && sent.indexOf('alpha edited') >= 0 && sent.indexOf('alpha edited') < sent.indexOf('bravo wording'), 'the edit goes in its old place: ' + sent);
  assert.equal((await call(instance, '/chat/' + id + '/held-text', 'POST', { held: first.body.held, text: 'too late' })).status, 409, 'a message already sent is not edited');
});
