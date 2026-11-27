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

// O273 round 2: the barrier is right before the prompt goes. A lock pressed while the start snapshot is taken (the prompt
// already answered 202, in the writable mode) holds the prompt until the agent confirms the no-write mode.
test('O273: a lock pressed during the start snapshot holds the prompt until the agent confirms the no-write mode', { timeout: 60000 }, async (t) => {
  const { chat, dir, id, until } = await setup(t, 'o273-snapshot', true, { P9_SHELL_START_MS: '1500' });
  await writeFile(path.join(dir, 'calls.log'), '');
  await writeFile(path.join(dir, 'hang-mode'), ''); // the lock's set stays unanswered past the snapshot
  assert.equal((await chat.prompt(id, { text: 'mode' })).status, 202);
  const lock = chat.setLock({ on: true });
  await pause(2500); // the snapshot is done; the lock's set is not answered yet
  assert.deepEqual((await lines(path.join(dir, 'calls.log'))).filter((l) => l.endsWith(' prompt')), [], 'the prompt went before the agent confirmed the lock');
  await unlink(path.join(dir, 'hang-mode'));
  assert.equal((await lock).on, true);
  await until(said('mode:plan'), 'the prompt ran in the no-write mode');
  console.log('PASS O273 snapshot: the lock pressed during the snapshot was answered before the prompt went; it ran in plan');
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
