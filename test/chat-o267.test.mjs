// #540 review 12: a prompt's start that ends without a turn (a device revoked during its settings, a setting that timed
// out) leaves through one exit, which sends an Interrupt held meanwhile; and a setting that timed out cannot land after
// the next prompt's own. In process, as auth-races.test.mjs, so the revoke is exact.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { openLedger } from '../apps/server/ledger.mjs';
import { authority } from '../apps/server/authority.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function setup(t, name, warm = true) {
  const { createChat } = await import('../apps/server/chat.mjs');
  const { createLifecycle } = await import('../apps/server/lifecycle.mjs');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-' + name + '-'));
  const chat = createChat({ ledger: openLedger(path.join(dir, 'ledger.db')), workspace: dir, adapterOverride: path.join(import.meta.dirname, 'fake-acp-agent.mjs'),
    instance: name + '-' + process.pid, lifecycle: createLifecycle() });
  t.after(() => chat.shutdown());
  const id = (await chat.create({ provider: 'claude' })).conversation;
  const seen = [];
  let cursor = 0;
  // Every event of this chat so far, read until one matches (or 20 s pass).
  const until = async (match, what) => {
    for (const end = Date.now() + 20000; Date.now() < end;) {
      const page = await chat.events(cursor, 500);
      cursor = page.cursor; seen.push(...page.events.filter((e) => e.conversation === id));
      if (seen.some(match)) return seen;
    }
    assert.fail('timed out: ' + what + ' ' + JSON.stringify(seen.map((e) => e.type + (e.data?.text ? ':' + e.data.text : ''))));
  };
  const started = async () => { for (const end = Date.now() + 10000; !existsSync(path.join(dir, 'config-started'));) { assert.ok(Date.now() < end, 'the setting never started'); await pause(50); } };
  if (warm) {
    assert.equal((await chat.prompt(id, { text: 'warm up', model: 'opus' })).status, 202);
    await until((e) => e.type === 'turn-end', 'warm-up turn');
  }
  return { chat, dir, id, seen, until, started };
}
const echoed = (text) => (e) => e.type === 'update' && typeof e.data?.content?.text === 'string' && e.data.content.text.startsWith('echo:') && e.data.content.text.includes(text);

test('O267 review 12: a desktop Interrupt held while a phone\'s start is revoked goes; the phone\'s prompt does not', async (t) => {
  const { chat, dir, id, seen, until, started } = await setup(t, 'o267-revoke');
  await writeFile(path.join(dir, 'slow-config'), '');
  let live = true;
  const phone = authority.run(() => live, () => chat.prompt(id, { text: 'from the phone', model: 'haiku' }));
  await started();
  const now = await chat.prompt(id, { text: 'desktop cut in', when: 'now' });
  assert.equal(now.status, 202, JSON.stringify(now));
  assert.ok(now.held, 'held for the starting turn: ' + JSON.stringify(now));
  live = false; // the phone is revoked while its model is being set
  await assert.rejects(phone, /session-ended/);
  await unlink(path.join(dir, 'slow-config'));
  await until(echoed('desktop cut in'), 'the desktop Interrupt reached the agent');
  await until((e, i, all) => e.type === 'turn-end' && all.findIndex(echoed('desktop cut in')) < i, 'its turn ended');
  assert.ok(!seen.some(echoed('from the phone')), 'the revoked phone\'s prompt never reached the agent');
  console.log('PASS O267 review 12 revoke: the held desktop Interrupt went and its turn ended; the revoked phone\'s prompt was never sent');
});

test('O267 review 12: a model set that timed out cannot land after the held Interrupt\'s own', async (t) => {
  const { chat, dir, id, until, started } = await setup(t, 'o267-late');
  await writeFile(path.join(dir, 'sets.log'), '');
  await writeFile(path.join(dir, 'slow-config'), '7000'); // past the 5 s wait
  const doomed = chat.prompt(id, { text: 'on haiku', model: 'haiku' });
  await started();
  await unlink(path.join(dir, 'slow-config')); // the next set answers at once
  const now = await chat.prompt(id, { text: 'back on opus', when: 'now', model: 'opus' });
  assert.equal(now.status, 202, JSON.stringify(now));
  assert.ok(now.held, JSON.stringify(now));
  assert.equal((await doomed).status, 500, 'the haiku set timed out');
  await until(echoed('back on opus'), 'the Interrupt reached the agent');
  const sets = async () => (await readFile(path.join(dir, 'sets.log'), 'utf8')).split('\n').filter((l) => l.includes(' model='));
  for (const end = Date.now() + 10000; !(await sets()).some((l) => l.endsWith('=haiku'));) { assert.ok(Date.now() < end, 'the late haiku set never landed'); await pause(200); }
  await pause(500);
  const order = await sets();
  assert.ok(order.at(-1).endsWith('model=opus'), 'the chat is left on the Interrupt\'s model: ' + JSON.stringify(order));
  console.log('PASS O267 review 12 late set: ' + JSON.stringify(order) + ', the late set landed first and the Interrupt\'s model last');
});

// #540 review 13
test('O267 review 13: an Interrupt while the adapter is still starting is refused, not held where a failed start strands it', async (t) => {
  const { chat, dir, id, until } = await setup(t, 'o267-init', false);
  await writeFile(path.join(dir, 'slow-init'), ''); // initialize answers after 10 s
  const first = chat.prompt(id, { text: 'first' });
  await until((e) => e.type === 'user', 'the first prompt started the adapter'); // connect has registered the session
  const now = await chat.prompt(id, { text: 'cut in', when: 'now' });
  await writeFile(path.join(dir, 'signed-out'), ''); // and then the start fails
  assert.equal(now.status, 409, 'refused while the adapter starts: ' + JSON.stringify(now));
  assert.ok((await first).status >= 400, 'the start failed');
  console.log('PASS O267 review 13 init: an Interrupt during the adapter\'s start was refused (' + now.status + '), so a failed start leaves nothing held');
});

test('O267 review 13: a message that names no setting waits for a timed-out one still on its way', async (t) => {
  const { chat, dir, id, until, started } = await setup(t, 'o267-bare');
  await writeFile(path.join(dir, 'sets.log'), '');
  await writeFile(path.join(dir, 'slow-config'), '7000'); // past the 5 s wait
  const doomed = chat.prompt(id, { text: 'on haiku', model: 'haiku' });
  await started();
  await unlink(path.join(dir, 'slow-config'));
  const now = await chat.prompt(id, { text: 'no setting named', when: 'now' });
  assert.equal(now.status, 202, JSON.stringify(now));
  assert.ok(now.held, JSON.stringify(now));
  assert.equal((await doomed).status, 500, 'the haiku set timed out');
  await until(echoed('no setting named'), 'the Interrupt reached the agent');
  const log = await readFile(path.join(dir, 'sets.log'), 'utf8');
  assert.ok(log.includes(' model=haiku'), 'the late set landed before the turn, not during it: ' + JSON.stringify(log));
  console.log('PASS O267 review 13 bare: the Interrupt\'s turn began after the late set landed: ' + JSON.stringify(log));
});

test('O267 review 13: a setting whose caller gave up before its turn on the chain is never sent', async (t) => {
  const { chat, dir, id, seen, until, started } = await setup(t, 'o267-skip');
  await writeFile(path.join(dir, 'sets.log'), '');
  await writeFile(path.join(dir, 'slow-config'), '12000'); // holds the chain past the Interrupt's own 5 s wait too
  const doomed = chat.prompt(id, { text: 'on haiku', model: 'haiku' });
  await started();
  await unlink(path.join(dir, 'slow-config'));
  const now = await chat.prompt(id, { text: 'back on opus', when: 'now', model: 'opus' });
  assert.equal(now.status, 202, JSON.stringify(now));
  assert.equal((await doomed).status, 500, 'the haiku set timed out');
  const failed = (e) => e.type === 'error' && /model could not be set/.test(e.data?.message ?? '');
  await until(() => seen.filter(failed).length >= 2, 'the Interrupt\'s own model set timed out, still waiting behind the slow one');
  const sets = async () => (await readFile(path.join(dir, 'sets.log'), 'utf8')).split('\n').filter((l) => l.includes(' model='));
  for (const end = Date.now() + 10000; !(await sets()).some((l) => l.endsWith('=haiku'));) { assert.ok(Date.now() < end, 'the slow haiku set never landed'); await pause(200); }
  await pause(1000);
  const order = await sets();
  assert.deepEqual(order.map((l) => l.split(' model=')[1]), ['haiku'], 'the given-up opus set was never sent: ' + JSON.stringify(order));
  assert.ok(!seen.some(echoed('back on opus')), 'nor its prompt');
  console.log('PASS O267 review 13 skip: ' + JSON.stringify(order) + ', the opus set whose caller gave up was skipped');
});
