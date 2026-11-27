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
// env: test-home switches createChat reads once (P9_SHELL_START_MS, P9_SET_CAP_MS), set for this chat only.
async function setup(t, name, warm = true, env = {}) {
  const { createChat } = await import('../apps/server/chat.mjs');
  const { createLifecycle } = await import('../apps/server/lifecycle.mjs');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-' + name + '-'));
  const keys = Object.keys(env).length ? { P9_TEST_HOME: dir, ...env } : {};
  Object.assign(process.env, keys);
  const chat = createChat({ ledger: openLedger(path.join(dir, 'ledger.db')), workspace: dir, adapterOverride: path.join(import.meta.dirname, 'fake-acp-agent.mjs'),
    instance: name + '-' + process.pid, lifecycle: createLifecycle() });
  for (const key of Object.keys(keys)) delete process.env[key];
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

// #540 review 14
test('O267 review 14: an Interrupt held while a start sets its model is handed back when the chat is closed', async (t) => {
  const { chat, dir, id, until, started } = await setup(t, 'o267-close');
  await writeFile(path.join(dir, 'slow-config'), '3000');
  const first = chat.prompt(id, { text: 'on haiku', model: 'haiku' });
  await started(); // the adapter is ready and the start is setting its model
  const now = await chat.prompt(id, { text: 'cut in', when: 'now' });
  assert.equal(now.status, 202, JSON.stringify(now));
  assert.ok(now.held, JSON.stringify(now));
  assert.equal((await chat.stop(id, { close: true })).status, 200);
  assert.notEqual((await first).status, 202, 'the closed start sent nothing');
  const back = await until((e) => e.type === 'unheld' && e.data?.id === now.held, 'the held Interrupt was handed back');
  assert.ok(!back.some(echoed('cut in')), 'and never sent');
  console.log('PASS O267 review 14 close: the held Interrupt came back as ' + back.find((e) => e.type === 'unheld' && e.data?.id === now.held).data.why);
});

test('O267 review 14: a message waiting on a late setting when the chat is stopped is refused, not answered 202', async (t) => {
  const { chat, dir, id, seen, started } = await setup(t, 'o267-stopwait');
  await writeFile(path.join(dir, 'slow-config'), '7000'); // past the 5 s wait
  const doomed = chat.prompt(id, { text: 'on haiku', model: 'haiku' });
  await started();
  await unlink(path.join(dir, 'slow-config'));
  assert.equal((await doomed).status, 500, 'the haiku set timed out');
  const waiting = chat.prompt(id, { text: 'no picks' }); // waits for the haiku set still on its way
  await pause(300);
  assert.equal((await chat.stop(id)).status, 200);
  const r = await waiting;
  assert.equal(r.status, 409, 'refused after the Stop: ' + JSON.stringify(r));
  assert.ok(!seen.some(echoed('no picks')), 'nothing reached the agent');
  console.log('PASS O267 review 14 stop: the waiting message got ' + r.status + ' ' + r.error + ' after the Stop');
});

// O267b (#540 reviews 14 to 16): the last step before a prompt goes, and a setting that never answers.
const lines = async (file) => (existsSync(file) ? (await readFile(file, 'utf8')).split('\n').filter(Boolean) : []);
test('O267b: a Stop while the start snapshot runs sends no prompt', async (t) => {
  const { chat, dir, id, until } = await setup(t, 'o267b-stop', true, { P9_SHELL_START_MS: '400' });
  await writeFile(path.join(dir, 'calls.log'), '');
  await writeFile(path.join(dir, 'slow-close'), ''); // the Stop holds the connection open 800 ms, past the snapshot's end
  const r = await chat.prompt(id, { text: 'after the stop' });
  assert.equal(r.status, 202, JSON.stringify(r));
  assert.equal((await chat.stop(id)).status, 200);
  await until((e) => e.type === 'stopped', 'stopped');
  await pause(300);
  assert.deepEqual((await lines(path.join(dir, 'calls.log'))).filter((l) => l.endsWith(' prompt')), [], 'the prompt never reached the adapter');
  console.log('PASS O267b stop: a Stop during the start snapshot sent no prompt');
});

// Review round 4: past the cap a mode set not answered retires the session, lock on or off. An unlock the adapter never
// answers (the lock is off by then) stops the chat with a line saying why; the next prompt starts a clean adapter.
test('O267b: a mode set the adapter never answers retires the session at the cap, lock off', { timeout: 60000 }, async (t) => {
  const { chat, dir, id, seen, until, started } = await setup(t, 'o267b-hang', true, { P9_SET_CAP_MS: '8000' });
  assert.equal((await chat.setLock({ on: true })).on, true);
  await writeFile(path.join(dir, 'slow-config'), '600000'); // never answers in this test
  const unlock = chat.setLock({ on: false });
  await started();
  await unlink(path.join(dir, 'slow-config'));
  assert.equal((await unlock).on, false);
  await until((e) => e.type === 'error' && /did not answer a setting/.test(e.data?.message), 'the cap retired the session');
  await until((e) => e.type === 'stopped', 'stopped');
  const r = await chat.prompt(id, { text: 'after the hang' });
  assert.equal(r.status, 202, 'not refused for good: ' + JSON.stringify(r));
  await until(echoed('after the hang'), 'a clean adapter answered');
  console.log('PASS O267b cap: the hung unlock retired the session; the next prompt ran');
});

test('O267b: an Interrupt held while a start sets its model is handed back when the adapter exits', async (t) => {
  const { chat, dir, id, until, started } = await setup(t, 'o267b-exit');
  await writeFile(path.join(dir, 'slow-config'), '4000');
  const first = chat.prompt(id, { text: 'on haiku', model: 'haiku' });
  await started();
  const now = await chat.prompt(id, { text: 'cut in', when: 'now' });
  assert.equal(now.status, 202, JSON.stringify(now));
  assert.ok(now.held, JSON.stringify(now));
  await writeFile(path.join(dir, 'exit-config'), ''); // the adapter exits mid-setting
  assert.notEqual((await first).status, 202, 'the start sent nothing');
  const back = await until((e) => e.type === 'unheld' && e.data?.id === now.held, 'the held Interrupt was handed back');
  assert.equal(back.find((e) => e.type === 'unheld' && e.data?.id === now.held).data.why, 'stopped');
  assert.ok(!back.some(echoed('cut in')), 'and never sent');
  console.log('PASS O267b exit: the held Interrupt came back as stopped when the adapter exited during the start');
});

test('O267b: a handed-back message another chat sent says who sent it', async (t) => {
  const { chat, dir, id, until, started } = await setup(t, 'o267b-from');
  const other = (await chat.create({ provider: 'claude' })).conversation;
  await writeFile(path.join(dir, 'slow-config'), '3000');
  const first = chat.prompt(id, { text: 'on haiku', model: 'haiku' });
  await started();
  const now = await chat.prompt(id, { text: 'from another chat', when: 'now' }, undefined, other);
  assert.equal(now.status, 202, JSON.stringify(now));
  assert.equal((await chat.stop(id, { close: true })).status, 200);
  await first;
  const back = (await until((e) => e.type === 'unheld' && e.data?.id === now.held, 'handed back')).find((e) => e.type === 'unheld' && e.data?.id === now.held);
  assert.deepEqual([back.data.why, back.data.from], ['stopped', other], 'the window and phone can tell it is not the user\'s');
  console.log('PASS O267b from: the handed-back message carried from ' + back.data.from);
});

test('O267b: an Interrupt held while a start sets its model is handed back when the adapter exits slowly', async (t) => {
  const { chat, dir, id, until, started } = await setup(t, 'o267b-slowexit');
  await writeFile(path.join(dir, 'slow-config'), '4000');
  const first = chat.prompt(id, { text: 'on haiku', model: 'haiku' });
  await started();
  const now = await chat.prompt(id, { text: 'cut in', when: 'now' });
  assert.ok(now.held, JSON.stringify(now));
  await writeFile(path.join(dir, 'exit-config'), 'late'); // its output closes 600 ms before it exits
  assert.notEqual((await first).status, 202);
  const back = await until((e) => e.type === 'unheld' && e.data?.id === now.held, 'handed back');
  assert.equal(back.find((e) => e.type === 'unheld' && e.data?.id === now.held).data.why, 'stopped');
  assert.ok(!back.some(echoed('cut in')) && !back.some((e) => e.type === 'user' && e.data?.text === 'cut in'), 'and never sent');
  console.log('PASS O267b slow exit: the held Interrupt came back as stopped');
});

test('O267b: a prompt whose Stop came during its note read does not take a newer prompt\'s claim as its own', { timeout: 60000 }, async (t) => {
  const { chat, id, seen, until } = await setup(t, 'o267b-claim', true, { P9_NOTE_MS: '3000' });
  const older = chat.prompt(id, { text: 'the older one' });
  await pause(500);
  assert.equal((await chat.stop(id)).status, 200);
  const newer = chat.prompt(id, { text: 'the newer one' }); // claims the chat while the older one still reads its note
  const late = await older;
  assert.deepEqual([late.status, late.error], [409, 'stopping'], JSON.stringify(late));
  assert.equal((await newer).status, 202);
  await until(echoed('the newer one'), 'the newer prompt went');
  assert.ok(!seen.some(echoed('the older one')), 'the older one never went');
  console.log('PASS O267b claim: the older prompt got 409 ' + late.error + '; only the newer one went');
});

test('O267b: a phone revoked during the start snapshot sends nothing', async (t) => {
  const { chat, dir, id, until } = await setup(t, 'o267b-revoked', true, { P9_SHELL_START_MS: '1500' });
  await writeFile(path.join(dir, 'calls.log'), '');
  let live = true;
  const r = await authority.run(() => live, () => chat.prompt(id, { text: 'from the phone' }));
  assert.equal(r.status, 202, JSON.stringify(r));
  live = false; // revoked while the snapshot runs
  await until((e) => e.type === 'error' && /signed out/.test(e.data?.message), 'nothing was sent');
  // Review round 2 finding 3: after its 202 the box is empty, so the text comes back (the phone reads it after sign-in).
  const back = (await until((e) => e.type === 'unheld' && e.data?.id === r.turn, 'handed back')).find((e) => e.type === 'unheld' && e.data?.id === r.turn);
  assert.deepEqual([back.data.text, back.data.why], ['from the phone', 'stopped']);
  assert.deepEqual((await lines(path.join(dir, 'calls.log'))).filter((l) => l.endsWith(' prompt')), []);
  console.log('PASS O267b revoked: the revoked phone\'s prompt never reached the agent');
});

// Review round 4: another chat's message from a revoked device is handed back (its from) and the chat still gets the
// error line, which ends the turn in the window and the phone.
test('O267b: another chat\'s message revoked during the start snapshot is handed back and ends the turn', async (t) => {
  const { chat, dir, id, until } = await setup(t, 'o267b-revoked-from', true, { P9_SHELL_START_MS: '1500' });
  const other = (await chat.create({ provider: 'claude' })).conversation;
  await writeFile(path.join(dir, 'calls.log'), '');
  let live = true;
  const r = await authority.run(() => live, () => chat.prompt(id, { text: 'from the other chat' }, undefined, other));
  assert.equal(r.status, 202, JSON.stringify(r));
  live = false;
  const back = (await until((e) => e.type === 'unheld' && e.data?.id === r.turn, 'handed back')).find((e) => e.type === 'unheld' && e.data?.id === r.turn);
  assert.deepEqual([back.data.text, back.data.why, back.data.from], ['from the other chat', 'stopped', other]);
  const error = (await until((e) => e.type === 'error' && /signed out/.test(e.data?.message), 'the error line')).find((e) => e.type === 'error' && /signed out/.test(e.data?.message));
  assert.equal(error.data.ends, true, 'it ends the turn');
  assert.deepEqual((await lines(path.join(dir, 'calls.log'))).filter((l) => l.endsWith(' prompt')), []);
  console.log('PASS O267b revoked from: unheld with from, an ending error line, nothing sent');
});

// O273: the agent lock is set through the one per-session chain of settings. The three cases below fail without it.
const said = (text) => (e) => e.type === 'update' && e.data?.content?.text === text;

// Case 1: two toggles overlap. The older one's set fails (the adapter refuses the writable mode); the newer lock's own
// set, behind it on the chain, decides. The chat is not stopped, and its next prompt runs in the no-write mode.
test('O273: an older lock toggle whose set fails does not stop a chat a newer lock is switching', async (t) => {
  const { chat, dir, id, seen, until } = await setup(t, 'o273-toggles');
  assert.equal((await chat.setLock({ on: true })).on, true);
  await writeFile(path.join(dir, 'fail-mode'), 'default');
  const both = await Promise.all([chat.setLock({ on: false }), chat.setLock({ on: true })]);
  assert.deepEqual(both.map((b) => b.on), [true, true]);
  await unlink(path.join(dir, 'fail-mode'));
  assert.equal((await chat.prompt(id, { text: 'mode' })).status, 202);
  await until(said('mode:plan'), 'the prompt ran in the no-write mode');
  assert.ok(!seen.some((e) => e.type === 'stopped'), 'the older unlock\'s failure stopped the chat');
  console.log('PASS O273 toggles: the older unlock failed, the newer lock decided, the chat ran on in plan');
});

// Case 2: an adapter that answers a set without naming the mode. P9 does not take the no-write mode as set: the lock
// stops the live chat, and a start under the lock sends no prompt.
test('O273: a no-write mode the adapter does not name is not taken as set', async (t) => {
  const { chat, dir, id, seen, until } = await setup(t, 'o273-quiet');
  await writeFile(path.join(dir, 'quiet-config'), '');
  await writeFile(path.join(dir, 'calls.log'), '');
  assert.equal((await chat.setLock({ on: true })).on, true);
  const r = await chat.prompt(id, { text: 'after the lock' });
  assert.deepEqual((await lines(path.join(dir, 'calls.log'))).filter((l) => l.endsWith(' prompt')), [], 'a prompt went to an agent that never confirmed its no-write mode');
  assert.notEqual(r.status, 202, JSON.stringify(r));
  await until((e) => e.type === 'stopped', 'the unconfirmed lock stopped the chat');
  assert.ok(!seen.some(echoed('after the lock')));
  console.log('PASS O273 quiet: the unconfirmed lock stopped the chat; the start under it got ' + r.status + ' and sent nothing');
});

// Case 3: a model set the adapter does not answer. Past the cap the session is retired, as for a mode set, so a later
// set (here the lock's) never goes while it is open and its late answer cannot land after the lock.
test('O273: a model set not answered past the cap retires the session, so a lock\'s set never goes behind it', { timeout: 60000 }, async (t) => {
  const { chat, dir, id, until, started } = await setup(t, 'o273-late-model', true, { P9_SET_CAP_MS: '2500' });
  await writeFile(path.join(dir, 'overlaps.log'), '');
  await writeFile(path.join(dir, 'hang-model'), '');
  const first = chat.prompt(id, { text: 'on haiku', model: 'haiku' });
  await started();
  await pause(3500); // past the cap
  assert.equal((await chat.setLock({ on: true })).on, true);
  await unlink(path.join(dir, 'hang-model')); // the model set answers now, late
  const r = await first;
  await pause(300);
  assert.equal(await readFile(path.join(dir, 'overlaps.log'), 'utf8'), '', 'a set went to the adapter while the model set was open');
  assert.notEqual(r.status, 202, JSON.stringify(r));
  await until((e) => e.type === 'error' && /did not answer a setting/.test(e.data?.message), 'the cap retired the session');
  await until((e) => e.type === 'stopped', 'stopped');
  assert.equal((await chat.prompt(id, { text: 'mode' })).status, 202);
  await until(said('mode:plan'), 'a clean adapter ran in the no-write mode');
  console.log('PASS O273 late model: the cap retired the session; no set overlapped; the next prompt ran in plan');
});

// O273 round 2: the cap frees the chain as it stops the session; a set queued behind the unanswered one (here the lock's,
// queued before the cap fires) is never sent to the adapter being stopped.
test('O273: a set queued before the cap fires is not sent to the session the cap is stopping', { timeout: 60000 }, async (t) => {
  const { chat, dir, id, until, started } = await setup(t, 'o273-cap-queued', true, { P9_SET_CAP_MS: '2500' });
  await writeFile(path.join(dir, 'overlaps.log'), '');
  await writeFile(path.join(dir, 'hang-model'), '');
  const first = chat.prompt(id, { text: 'on haiku', model: 'haiku' });
  await started();
  const lock = chat.setLock({ on: true }); // queued behind the model set, with a budget longer than the cap
  await until((e) => e.type === 'error' && /did not answer a setting/.test(e.data?.message), 'the cap retired the session');
  await pause(500);
  await unlink(path.join(dir, 'hang-model'));
  await Promise.allSettled([first, lock]);
  await until((e) => e.type === 'stopped', 'stopped');
  assert.equal(await readFile(path.join(dir, 'overlaps.log'), 'utf8'), '', 'the queued set went to the adapter being stopped');
  assert.equal((await chat.prompt(id, { text: 'mode' })).status, 202);
  await until(said('mode:plan'), 'a clean adapter ran in the no-write mode');
  console.log('PASS O273 cap queued: the queued lock set was never sent to the stopping adapter; the next prompt ran in plan');
});

// O275: the agent lock is taken at one barrier. No prompt or steer goes while a setting is unanswered (a set added while
// it waits included), nor while the lock is on and the agent has not confirmed its no-write mode; a message a stop or a
// failed lock caught after its 202 is handed back, not lost. hang-mode holds a mode set; order.log lists sets, prompts and
// steers in the order the agent saw them.
const order = (dir) => lines(path.join(dir, 'order.log'));
const sent = (verb, text) => (l) => l.startsWith(verb + ' ') && l.includes(text);
const prompted = async (dir) => (await order(dir)).filter((l) => l.startsWith('prompt '));
const unheldOf = (seen, turn) => seen.filter((e) => e.type === 'unheld' && e.data?.id === turn);

test('O275 T1: a lock pressed during the start snapshot is answered before the prompt goes', async (t) => {
  const { chat, dir, id, until } = await setup(t, 'o275-t1', true, { P9_SHELL_START_MS: '1500' });
  await writeFile(path.join(dir, 'order.log'), '');
  const r = await chat.prompt(id, { text: 'mode' });
  assert.equal(r.status, 202, JSON.stringify(r));
  await writeFile(path.join(dir, 'hang-mode'), 'plan');
  const lock = chat.setLock({ on: true }); // during the snapshot; its set hangs
  await pause(2500); // past the snapshot
  assert.deepEqual(await prompted(dir), [], 'the prompt went before the agent answered the lock');
  await unlink(path.join(dir, 'hang-mode'));
  await until(said('mode:plan'), 'the prompt ran in the no-write mode');
  assert.equal((await lock).on, true);
  const log = await order(dir);
  assert.ok(log.indexOf('set mode=plan') >= 0 && log.indexOf('set mode=plan') < log.findIndex((l) => l.startsWith('prompt ')), JSON.stringify(log));
  console.log('PASS O275 T1: the prompt waited for the lock\'s answer and ran in plan');
});

test('O275 T1b: lock toggles added while the barrier waits are waited for too', async (t) => {
  const { chat, dir, id, until } = await setup(t, 'o275-t1b', true, { P9_SHELL_START_MS: '1500' });
  await writeFile(path.join(dir, 'order.log'), '');
  const r = await chat.prompt(id, { text: 'mode' });
  assert.equal(r.status, 202, JSON.stringify(r));
  await writeFile(path.join(dir, 'hang-mode'), 'plan');
  const toggles = [chat.setLock({ on: true })]; // during the snapshot; its set hangs
  await pause(2200); // past the snapshot: the barrier waits on that set
  await writeFile(path.join(dir, 'slow-config'), '600'); // each set then takes 600 ms
  // Added while the barrier waits, so one that read the chain once would wake after the first and go.
  toggles.push(chat.setLock({ on: false }));
  await pause(100); toggles.push(chat.setLock({ on: true }));
  await pause(200);
  await unlink(path.join(dir, 'hang-mode'));
  await until(said('mode:plan'), 'the prompt ran in the no-write mode');
  await Promise.all(toggles);
  const log = await order(dir), sets = log.flatMap((l, i) => (l.startsWith('set mode=') ? [i] : []));
  assert.equal(sets.length, 3, JSON.stringify(log));
  assert.ok(sets.at(-1) < log.findIndex((l) => l.startsWith('prompt ')), 'the prompt went before the last toggle was answered: ' + JSON.stringify(log));
  console.log('PASS O275 T1b: the prompt went after all three toggles were answered, two of them added while it waited');
});

// Behaviour change: a steer no longer waits for a setting (a Stop could miss it while it waited). Refused at once, the
// message is held and goes as the turn's next prompt, which meets the barrier.
test('O275 T2: a message during an unanswered lock is not steered; it goes as the next prompt, after the lock', async (t) => {
  const { chat, dir, id, until } = await setup(t, 'o275-t2');
  await writeFile(path.join(dir, 'order.log'), '');
  assert.equal((await chat.prompt(id, { text: 'gate' })).status, 202);
  await until(said('gating'), 'the turn is running');
  await writeFile(path.join(dir, 'hang-mode'), 'plan');
  const lock = chat.setLock({ on: true });
  await pause(200);
  const s = await chat.prompt(id, { text: 'nudge' }); // answered at once: nothing waits
  assert.equal(s.status, 202, JSON.stringify(s));
  assert.ok(s.held, 'held for the turn\'s end: ' + JSON.stringify(s));
  await unlink(path.join(dir, 'hang-mode'));
  await lock;
  await writeFile(path.join(dir, 'go'), '');
  await until(echoed('nudge'), 'the held message went as the next prompt');
  const log = await order(dir);
  assert.ok(!log.some((l) => l.startsWith('steer ')), 'steered: ' + JSON.stringify(log));
  assert.ok(log.indexOf('set mode=plan') >= 0 && log.indexOf('set mode=plan') < log.findIndex(sent('prompt', 'nudge')), JSON.stringify(log));
  console.log('PASS O275 T2: no steer; the message went as the next prompt, after the lock was answered');
});

test('O275 T2b: a lock never answered sends no steer; the sender gets the message back once', { timeout: 60000 }, async (t) => {
  const { chat, dir, id, seen, until } = await setup(t, 'o275-t2b');
  await writeFile(path.join(dir, 'order.log'), '');
  assert.equal((await chat.prompt(id, { text: 'gate' })).status, 202);
  await until(said('gating'), 'the turn is running');
  await writeFile(path.join(dir, 'hang-mode'), 'plan');
  const lock = chat.setLock({ on: true });
  await pause(200);
  const s = await chat.prompt(id, { text: 'nudge' });
  assert.ok(s.held, JSON.stringify(s));
  await lock;
  await until((e) => e.type === 'stopped', 'the unanswered lock stopped the chat');
  await until((e) => e.type === 'unheld' && e.data?.text === 'nudge', 'the text came back');
  await unlink(path.join(dir, 'hang-mode'));
  await pause(1000);
  await until(() => true, 'read the events since');
  assert.ok(!(await order(dir)).some((l) => l.startsWith('steer ') || sent('prompt', 'nudge')(l)), 'sent to an agent that never answered the lock');
  const back = seen.filter((e) => e.type === 'unheld' && e.data?.text === 'nudge');
  assert.equal(back.length, 1, JSON.stringify(back));
  assert.equal(back[0].data.id, s.held, 'the held row it came back to');
  console.log('PASS O275 T2b: no steer; the text came back once (' + back[0].data.why + ')');
});

test('O275 T3: a lock refused during the start snapshot hands back the current and the held message once each', async (t) => {
  const { chat, dir, id, seen, until } = await setup(t, 'o275-t3', true, { P9_SHELL_START_MS: '1500' });
  await writeFile(path.join(dir, 'calls.log'), '');
  const r = await chat.prompt(id, { text: 'first' });
  assert.equal(r.status, 202, JSON.stringify(r));
  const h = await chat.prompt(id, { text: 'second', when: 'queue' });
  assert.ok(h.held, JSON.stringify(h));
  await writeFile(path.join(dir, 'fail-mode'), 'plan');
  await chat.setLock({ on: true });
  await until((e) => e.type === 'stopped', 'the refused lock stopped the chat');
  await until((e) => e.type === 'unheld' && e.data?.id === r.turn, 'the current message handed back');
  await pause(1500);
  await until(() => true, 'read the events since');
  assert.equal(unheldOf(seen, r.turn).length, 1, JSON.stringify(unheldOf(seen, r.turn)));
  assert.equal(unheldOf(seen, r.turn)[0].data.text, 'first');
  assert.equal(seen.filter((e) => e.type === 'unheld' && e.data?.text === 'second').length, 1, 'the held one once');
  assert.deepEqual((await lines(path.join(dir, 'calls.log'))).filter((l) => l.endsWith(' prompt')), []);
  console.log('PASS O275 T3: both messages handed back once each; no prompt');
});

test('O275 T3b: a lock the agent answers without naming the mode hands the message back', async (t) => {
  const { chat, dir, id, seen, until } = await setup(t, 'o275-t3b', true, { P9_SHELL_START_MS: '1500' });
  await writeFile(path.join(dir, 'calls.log'), '');
  const r = await chat.prompt(id, { text: 'first' });
  assert.equal(r.status, 202, JSON.stringify(r));
  await writeFile(path.join(dir, 'quiet-config'), '');
  await chat.setLock({ on: true });
  await until((e) => e.type === 'unheld' && e.data?.id === r.turn, 'handed back');
  await pause(1500);
  await until(() => true, 'read the events since');
  assert.equal(unheldOf(seen, r.turn).length, 1);
  assert.deepEqual((await lines(path.join(dir, 'calls.log'))).filter((l) => l.endsWith(' prompt')), []);
  console.log('PASS O275 T3b: the unconfirmed lock handed the message back; no prompt');
});

test('O275 T3c: a lock refused after the snapshot ended, while the barrier waits, sends nothing and hands back', async (t) => {
  const { chat, dir, id, seen, until } = await setup(t, 'o275-t3c', true, { P9_SHELL_START_MS: '1500' });
  await writeFile(path.join(dir, 'calls.log'), '');
  const r = await chat.prompt(id, { text: 'first' });
  assert.equal(r.status, 202, JSON.stringify(r));
  await writeFile(path.join(dir, 'fail-mode'), 'plan');
  await writeFile(path.join(dir, 'hang-mode'), 'plan');
  const lock = chat.setLock({ on: true });
  await pause(2500); // past the snapshot
  await unlink(path.join(dir, 'hang-mode')); // the set is refused now
  await lock;
  await until((e) => e.type === 'unheld' && e.data?.id === r.turn, 'handed back');
  await pause(1000);
  await until(() => true, 'read the events since');
  assert.equal(unheldOf(seen, r.turn).length, 1);
  assert.deepEqual((await lines(path.join(dir, 'calls.log'))).filter((l) => l.endsWith(' prompt')), []);
  console.log('PASS O275 T3c: the late refusal sent nothing and handed the message back');
});

test('O275 T3d: a lock never answered through a long snapshot hands the message back', { timeout: 60000 }, async (t) => {
  const { chat, dir, id, seen, until } = await setup(t, 'o275-t3d', true, { P9_SHELL_START_MS: '6000' });
  await writeFile(path.join(dir, 'calls.log'), '');
  const r = await chat.prompt(id, { text: 'first' });
  assert.equal(r.status, 202, JSON.stringify(r));
  await writeFile(path.join(dir, 'hang-mode'), 'plan');
  await chat.setLock({ on: true }); // gives up at 5 s and stops the chat, before the snapshot ends
  await until((e) => e.type === 'unheld' && e.data?.id === r.turn, 'handed back');
  await unlink(path.join(dir, 'hang-mode'));
  await pause(1000);
  await until(() => true, 'read the events since');
  assert.equal(unheldOf(seen, r.turn).length, 1);
  assert.deepEqual((await lines(path.join(dir, 'calls.log'))).filter((l) => l.endsWith(' prompt')), []);
  console.log('PASS O275 T3d: the stopped chat handed the message back; no prompt');
});

// Behaviour change, not a fix: an unlock still unanswered 5 s after the snapshot now holds the prompt (main sent it in
// the no-write mode); the message comes back with a line saying why.
test('O275 T4: an unlock not answered within the barrier\'s wait hands the message back', { timeout: 60000 }, async (t) => {
  const { chat, dir, id, seen, until } = await setup(t, 'o275-t4', true, { P9_SHELL_START_MS: '1500' });
  assert.equal((await chat.setLock({ on: true })).on, true);
  await writeFile(path.join(dir, 'calls.log'), '');
  const r = await chat.prompt(id, { text: 'first' });
  assert.equal(r.status, 202, JSON.stringify(r));
  await writeFile(path.join(dir, 'hang-mode'), 'default');
  const unlock = chat.setLock({ on: false });
  await until((e) => e.type === 'error' && /has not answered/.test(e.data?.message), 'the line saying why');
  assert.equal(unheldOf(seen, r.turn).length, 1);
  assert.deepEqual((await lines(path.join(dir, 'calls.log'))).filter((l) => l.endsWith(' prompt')), []);
  await unlink(path.join(dir, 'hang-mode'));
  await unlock;
  console.log('PASS O275 T4: the unanswered unlock held the prompt; the message came back with its line');
});

// The setting stays hung through the Stop: the Stop's end does not wait for it (the barrier's wait is cut short when the
// lock's own 5 s give-up stops the chat), and the Stop button's start is cancelled, not handed back (MC-15, as on main).
test('O275: Stop wins admission: a Stop while the barrier waits on a hung set ends the turn cancelled, nothing sent', { timeout: 60000 }, async (t) => {
  const { chat, dir, id, seen, until } = await setup(t, 'o275-stop-wins', true, { P9_SHELL_START_MS: '1500' });
  await writeFile(path.join(dir, 'calls.log'), '');
  const r = await chat.prompt(id, { text: 'first' });
  assert.equal(r.status, 202, JSON.stringify(r));
  await writeFile(path.join(dir, 'hang-mode'), 'plan');
  const lock = chat.setLock({ on: true });
  await pause(2000); // past the snapshot: the barrier waits
  assert.equal((await chat.cancel(id)).status, 200);
  await until((e) => e.type === 'turn-end' && e.data?.stopReason === 'cancelled', 'the turn ended cancelled, the set still hung');
  await pause(500);
  await until(() => true, 'read the events since');
  assert.equal(seen.filter((e) => e.type === 'turn-end').length, 2, 'the warm-up\'s end and this one, once');
  assert.equal(unheldOf(seen, r.turn).length, 0, 'a Stop is not a hand-back');
  assert.deepEqual((await lines(path.join(dir, 'calls.log'))).filter((l) => l.endsWith(' prompt')), []);
  await unlink(path.join(dir, 'hang-mode'));
  await lock;
  console.log('PASS O275 Stop wins admission: cancelled with the set hung, not handed back, nothing sent');
});

test('O275: a chat stopped while the barrier waits on a hung set hands the message back once, nothing sent', async (t) => {
  const { chat, dir, id, seen, until } = await setup(t, 'o275-stop-close', true, { P9_SHELL_START_MS: '1500' });
  await writeFile(path.join(dir, 'calls.log'), '');
  const r = await chat.prompt(id, { text: 'first' });
  assert.equal(r.status, 202, JSON.stringify(r));
  await writeFile(path.join(dir, 'hang-mode'), 'plan');
  const lock = chat.setLock({ on: true });
  await pause(2000); // past the snapshot: the barrier waits
  assert.equal((await chat.stop(id)).status, 200);
  await until((e) => e.type === 'unheld' && e.data?.id === r.turn, 'handed back, the set still hung');
  await pause(500);
  await until(() => true, 'read the events since');
  assert.equal(unheldOf(seen, r.turn).length, 1, JSON.stringify(unheldOf(seen, r.turn)));
  assert.equal(unheldOf(seen, r.turn)[0].data.text, 'first');
  assert.deepEqual((await lines(path.join(dir, 'calls.log'))).filter((l) => l.endsWith(' prompt')), []);
  await unlink(path.join(dir, 'hang-mode'));
  await lock;
  console.log('PASS O275 stop while waiting: handed back once with its text, nothing sent');
});

// A guard, green on main too: once the prompt went, a stop is not a "never sent".
test('O275: invocation wins Stop: a stop after the prompt went hands nothing back and sends nothing again', async (t) => {
  const { chat, dir, id, seen, until } = await setup(t, 'o275-invoked');
  await writeFile(path.join(dir, 'calls.log'), '');
  const r = await chat.prompt(id, { text: 'gate' });
  assert.equal(r.status, 202, JSON.stringify(r));
  await until(said('gating'), 'the prompt reached the agent');
  assert.equal((await chat.stop(id)).status, 200);
  await until((e) => e.type === 'stopped', 'stopped');
  await pause(500);
  await until(() => true, 'read the events since');
  assert.equal(unheldOf(seen, r.turn).length, 0, 'a sent prompt was handed back as never sent');
  assert.equal((await lines(path.join(dir, 'calls.log'))).filter((l) => l.endsWith(' prompt')).length, 1);
  console.log('PASS O275 invocation wins Stop: no hand-back, one prompt');
});

const toolAt = (status) => (e) => e.type === 'update' && e.data?.toolCallId === 'tool-1' && e.data?.status === status;

test('O275 T5: a held steer refused while a set is unanswered, then Stop, starts no new turn', { timeout: 60000 }, async (t) => {
  const { chat, dir, id, seen, until } = await setup(t, 'o275-t5');
  await writeFile(path.join(dir, 'order.log'), '');
  assert.equal((await chat.prompt(id, { text: 'tools 2' })).status, 202);
  await until(toolAt('in_progress'), 'a tool is running');
  const h = await chat.prompt(id, { text: 'nudge' });
  assert.equal(h.when, 'steer', JSON.stringify(h)); // held for the tool's end
  await writeFile(path.join(dir, 'hang-mode'), 'plan');
  const lock = chat.setLock({ on: true });
  await until(toolAt('completed'), 'the tool ended: the held steer is tried while the lock is unanswered');
  await pause(200);
  assert.equal((await chat.cancel(id)).status, 200);
  await until((e) => e.type === 'turn-end' && e.data?.stopReason === 'cancelled', 'the turn ended cancelled');
  await unlink(path.join(dir, 'hang-mode'));
  await lock;
  await pause(1500);
  await until(() => true, 'read the events since');
  const log = await order(dir);
  assert.ok(!log.some((l) => sent('prompt', 'nudge')(l) || sent('steer', 'nudge')(l)), 'the held message went after the Stop: ' + JSON.stringify(log));
  assert.equal(seen.filter((e) => e.type === 'unheld' && e.data?.text === 'nudge').length, 1, 'handed back once');
  console.log('PASS O275 T5: no new turn after the Stop; the held message came back once');
});

test('O275 T6: a read-only prompt is not sent in a wider mode after a lock and unlock during its snapshot', { timeout: 60000 }, async (t) => {
  const { chat, dir, id, seen, until } = await setup(t, 'o275-t6', true, { P9_SHELL_START_MS: '1500' });
  await writeFile(path.join(dir, 'order.log'), '');
  const r = await chat.prompt(id, { text: 'mode', mode: 'Plan' });
  assert.equal(r.status, 202, JSON.stringify(r));
  assert.equal((await chat.setLock({ on: true })).on, true); // another window, during the snapshot
  await writeFile(path.join(dir, 'hang-mode'), 'default');
  const unlock = chat.setLock({ on: false }); // its set is unanswered when the snapshot ends
  await pause(2500);
  await unlink(path.join(dir, 'hang-mode'));
  await unlock;
  await until((e, i, all) => (e.type === 'unheld' && e.data?.id === r.turn) || all.filter((x) => x.type === 'turn-end').length >= 2, 'handed back or ran');
  await pause(500);
  await until(() => true, 'read the events since');
  const log = await order(dir);
  assert.ok(!log.some((l) => l.startsWith('prompt ')), 'the read-only prompt went in a wider mode: ' + JSON.stringify(log));
  assert.equal(unheldOf(seen, r.turn).length, 1, JSON.stringify(unheldOf(seen, r.turn)));
  assert.equal(unheldOf(seen, r.turn)[0].data.text, 'mode');
  console.log('PASS O275 T6: not sent after the unlock; handed back once');
});

test('O275 T7: a held steer out when Stop came is handed back, not sent as a new turn', { timeout: 60000 }, async (t) => {
  const { chat, dir, id, seen, until } = await setup(t, 'o275-t7');
  await writeFile(path.join(dir, 'order.log'), '');
  assert.equal((await chat.prompt(id, { text: 'tools 2' })).status, 202);
  await until(toolAt('in_progress'), 'a tool is running');
  const h = await chat.prompt(id, { text: 'nudge' });
  assert.equal(h.when, 'steer', JSON.stringify(h));
  await writeFile(path.join(dir, 'steer-wait'), '1500'); // the agent answers the steer only after the turn ended
  await until(toolAt('completed'), 'the tool ended: the held steer is out');
  await pause(300);
  assert.equal((await chat.cancel(id)).status, 200);
  await until((e) => e.type === 'turn-end' && e.data?.stopReason === 'cancelled', 'the turn ended cancelled');
  await pause(2500);
  await until(() => true, 'read the events since');
  const log = await order(dir);
  assert.ok(log.some(sent('steer', 'nudge')), 'the steer was out: ' + JSON.stringify(log));
  assert.ok(!log.some(sent('prompt', 'nudge')), 'the held message went as a new turn after the Stop: ' + JSON.stringify(log));
  assert.equal(seen.filter((e) => e.type === 'unheld' && e.data?.text === 'nudge').length, 1, 'handed back once');
  console.log('PASS O275 T7: the refused steer came back once; no turn after the Stop');
});

const ends = (n) => (e, i, all) => all.filter((x) => x.type === 'turn-end').length >= n;

// Round 3: an agent can keep the permissions a turn started with (Codex does), so a confirmed lock is not enough to steer.
test('O275 T8: a steer after the lock is confirmed is not sent into a turn begun unlocked; it runs at that turn\'s end', async (t) => {
  const { chat, dir, id, until } = await setup(t, 'o275-t8');
  await writeFile(path.join(dir, 'order.log'), '');
  assert.equal((await chat.prompt(id, { text: 'gate' })).status, 202);
  await until(said('gating'), 'the turn is running, begun unlocked');
  assert.equal((await chat.setLock({ on: true })).on, true); // confirmed while the turn runs
  const s = await chat.prompt(id, { text: 'nudge' });
  assert.equal(s.status, 202, JSON.stringify(s));
  await writeFile(path.join(dir, 'go'), '');
  await until(echoed('nudge'), 'the message ran as the next prompt');
  const log = await order(dir);
  assert.ok(!log.some(sent('steer', 'nudge')), 'steered into the turn begun unlocked: ' + JSON.stringify(log));
  assert.ok(log.lastIndexOf('set mode=plan') >= 0 && log.lastIndexOf('set mode=plan') < log.findIndex(sent('prompt', 'nudge')), JSON.stringify(log));
  console.log('PASS O275 T8: no steer under the lock; the message ran as the next prompt, in the no-write mode');
});

test('O275 T9: a held steer refused after its turn was stopped and a new one began is handed back, not run at that turn\'s end', { timeout: 60000 }, async (t) => {
  const { chat, dir, id, seen, until } = await setup(t, 'o275-t9');
  await writeFile(path.join(dir, 'order.log'), '');
  assert.equal((await chat.prompt(id, { text: 'tools 2' })).status, 202);
  await until(toolAt('in_progress'), 'a tool is running');
  const h = await chat.prompt(id, { text: 'nudge' });
  assert.equal(h.when, 'steer', JSON.stringify(h));
  await writeFile(path.join(dir, 'steer-wait'), '2500'); // the agent refuses the steer only after turn B began
  await writeFile(path.join(dir, 'steering-refuses'), '');
  await until(toolAt('completed'), 'the tool ended: the held steer is out');
  await pause(200);
  assert.equal((await chat.cancel(id)).status, 200);
  await until((e) => e.type === 'turn-end' && e.data?.stopReason === 'cancelled', 'turn A ended cancelled');
  assert.equal((await chat.prompt(id, { text: 'gate' })).status, 202); // turn B, before A's steer is refused
  await until(said('gating'), 'turn B is running');
  await pause(2500); // the refusal came back during B
  await writeFile(path.join(dir, 'go'), '');
  await until(ends(3), 'turn B ended');
  await pause(1500);
  await until(() => true, 'read the events since');
  const log = await order(dir);
  assert.ok(log.some(sent('steer', 'nudge')), 'the steer was out: ' + JSON.stringify(log));
  assert.ok(!log.some(sent('prompt', 'nudge')), 'the stopped turn\'s message ran at turn B\'s end: ' + JSON.stringify(log));
  assert.equal(seen.filter((e) => e.type === 'unheld' && e.data?.text === 'nudge').length, 1, 'handed back once');
  console.log('PASS O275 T9: handed back once; nothing ran at turn B\'s end');
});

test('O275 T10: a batch of two senders stopped before it went hands each message back to its own sender', async (t) => {
  const { chat, dir, id, seen, until } = await setup(t, 'o275-t10', true, { P9_SHELL_START_MS: '1500' });
  const other = (await chat.create({ provider: 'claude' })).conversation;
  await writeFile(path.join(dir, 'calls.log'), '');
  assert.equal((await chat.prompt(id, { text: 'gate' })).status, 202);
  await until(said('gating'), 'the turn is running');
  const mine = await chat.prompt(id, { text: 'mine', when: 'queue' });
  const theirs = await chat.prompt(id, { text: 'theirs', when: 'queue' }, undefined, other);
  assert.ok(mine.held && theirs.held, JSON.stringify([mine, theirs]));
  await writeFile(path.join(dir, 'go'), '');
  await until(ends(2), 'the turn ended: the two go as one prompt, in its start snapshot');
  await pause(300);
  assert.equal((await chat.stop(id)).status, 200);
  await until((e) => e.type === 'unheld', 'handed back');
  await pause(500);
  await until(() => true, 'read the events since');
  const back = seen.filter((e) => e.type === 'unheld');
  assert.deepEqual(back.filter((e) => !e.data.from).map((e) => e.data.text), ['mine'], 'the owner\'s box gets only the owner\'s text: ' + JSON.stringify(back.map((e) => e.data)));
  assert.deepEqual(back.filter((e) => e.data.from).map((e) => [e.data.text, e.data.from]), [['theirs', other]]);
  assert.equal((await lines(path.join(dir, 'calls.log'))).filter((l) => l.endsWith(' prompt')).length, 1, 'the batch was sent');
  console.log('PASS O275 T10: each message went back to its own sender, nothing sent');
});
