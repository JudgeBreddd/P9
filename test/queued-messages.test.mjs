// A user's messages sent while the agent worked never reached it (2026-10-24, release blocker): a coordinator's
// background tasks kept it working with no turn-end for 8 h, and P9 held them for that end. Real Electron, the real
// daemon and the fake agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, http, authenticated, root } from './helpers.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((result) => JSON.parse(result.text));
const events = async (instance, id) => {
  const all = [];
  for (let after = 0, page; (page = await call(instance, '/chat/events?after=' + after + '&only=' + id)).events.length; after = page.cursor) all.push(...page.events);
  return all;
};
const said = async (instance, id, type) => (await events(instance, id)).filter((e) => e.type === type);
const until = async (check, what, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 200))) if (await check()) return;
  assert.fail('timed out: ' + what);
};

async function setup(t, name, files = []) {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  for (const file of files) await writeFile(path.join(instance.workspace, file), '');
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-' + name + '-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const launch = async () => {
    const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
    const proc = app.process();
    t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
    const page = await app.firstWindow();
    await page.locator('#rChat').waitFor();
    return { app, page };
  };
  const id = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'hello' });
  const open = async (page) => {
    await page.locator('#rBots [data-bot="' + id + '"]').waitFor({ timeout: 15000 });
    await page.locator('#tabs .tab[data-id="' + id + '"]').click();
    const pane = page.locator('.pane[data-id="' + id + '"]');
    const send = async (text) => { await pane.locator('.composer textarea').click(); await page.keyboard.type(text); await page.keyboard.press('Enter'); };
    return { pane, send, queued: () => pane.locator('.queue .q span').allInnerTexts() };
  };
  const users = async () => (await said(instance, id, 'user')).map((e) => e.data.text);
  const agentSaid = async (text) => (await said(instance, id, 'update')).some((e) => e.data.content?.text === text);
  const ends = async () => (await said(instance, id, 'turn-end')).length;
  return { instance, id, launch, open, users, agentSaid, ends };
}

test('A message sent while the agent works on unprompted, with no turn-end, reaches it; one sent past its question declines it', { timeout: 120000 }, async (t) => {
  const { instance, id, launch, open, users, agentSaid, ends } = await setup(t, 'background');
  await until(async () => await ends() === 1, 'hello answered');
  let { app, page } = await launch(), chat = await open(page);
  // The turn ends, then the agent works on unprompted (each background task's report wakes it) and never reports an end.
  await chat.send('background');
  await until(async () => await ends() === 2 && (await said(instance, id, 'update')).some((e) => e.data.toolCallId === 'bg-1'), 'unprompted work started');
  await chat.send('first');
  await until(() => agentSaid('got:first'), 'first reached the unprompted work');
  // It asks meanwhile: the card says a message declines the question, and one does and reaches the agent.
  await chat.pane.locator('[data-question]').waitFor({ timeout: 15000 });
  assert.match(await chat.pane.locator('[data-question]').innerText(), /Sending a message declines this question/);
  await chat.send('second');
  await until(() => agentSaid('got:second'), 'second reached the agent past the question');
  assert.ok(await agentSaid('bg-ask:{"action":"cancel"}'), 'the agent saw the question declined');
  await until(async () => (await chat.pane.locator('[data-question]').count()) === 0, 'the question card went');
  assert.deepEqual([await users(), await chat.queued()], [['hello', 'background', 'first', 'second'], []]);
  // A window restart resends nothing.
  await app.close();
  ({ app, page } = await launch()); chat = await open(page);
  await page.waitForTimeout(3000);
  assert.deepEqual([await chat.queued(), (await users()).length], [[], 4]);
  console.log('PASS unprompted work: a message sent while the agent worked with no turn open reached it, one sent past its question declined it and reached it, nothing resent after a restart');
});

test('A message sent mid-turn goes into the turn (steered); one sent past an approval declines it', { timeout: 120000 }, async (t) => {
  const { instance, id, launch, open, users, agentSaid, ends } = await setup(t, 'steer');
  await until(async () => await ends() === 1, 'hello answered');
  const { page } = await launch(), chat = await open(page);
  await chat.send('slow');
  await chat.pane.getByText('working', { exact: true }).waitFor({ timeout: 15000 });
  await chat.send('mid');
  await until(() => agentSaid('got:mid'), 'mid reached the running turn');
  assert.deepEqual([await chat.queued(), await ends()], [[], 1], 'not queued, and the turn still runs');
  await call(instance, '/chat/' + id + '/cancel', 'POST');
  await until(async () => await ends() === 2, 'slow cancelled');
  await chat.send('permission');
  await chat.pane.locator('[data-approve]').first().waitFor({ timeout: 15000 });
  assert.match(await chat.pane.locator('.pending').innerText(), /Sending a message declines this/);
  await chat.send('instead');
  await until(() => agentSaid('got:instead'), 'instead reached the agent');
  assert.ok(await agentSaid('permission:cancelled'), 'the agent saw the approval cancelled');
  await until(async () => await ends() === 3, 'permission turn ended');
  assert.deepEqual([await users(), await chat.queued(), await page.locator('.toast', { hasText: 'turn-running' }).count()], [['hello', 'slow', 'mid', 'permission', 'instead'], [], 0]);
  console.log('PASS steering: a message mid-turn went into the turn, not behind it; one sent past an approval declined it and reached the agent');
});

test('An agent slow to answer steering (6 s, past the 5 s wait): the message reaches it once and is not queued; a late refusal shows a notice with the text', { timeout: 120000 }, async (t) => {
  const { instance, id, launch, open, users, agentSaid, ends } = await setup(t, 'slow-steer', ['slow-steering']);
  await until(async () => await ends() === 1, 'hello answered');
  const { page } = await launch(), chat = await open(page);
  await chat.send('slow');
  await chat.pane.getByText('working', { exact: true }).waitFor({ timeout: 15000 });
  await chat.send('mid');
  const got = async () => (await said(instance, id, 'update')).filter((e) => e.data.content?.text === 'got:mid').length;
  await until(async () => await got() === 1, 'mid reached the running turn');
  assert.deepEqual(await chat.queued(), [], 'not queued');
  // A queued copy would go at the turn's end: end it and wait past the window's 1 s retry.
  await call(instance, '/chat/' + id + '/cancel', 'POST');
  await until(async () => await ends() === 2, 'slow cancelled');
  await page.waitForTimeout(3000);
  assert.deepEqual([await got(), await users(), await chat.queued()], [1, ['hello', 'slow', 'mid'], []]);
  assert.equal((await said(instance, id, 'user')).at(-1).data.unconfirmed, true, 'shown as sent, unconfirmed');
  assert.equal((await said(instance, id, 'steer-lost')).length, 0, 'no lost-message notice: it landed');
  // The agent refuses the steering request after 6 s: the window says so with the text, so it never vanishes silently.
  await writeFile(path.join(instance.workspace, 'steering-refuses'), '');
  await chat.send('slow');
  await until(async () => (await users()).length === 4, 'second slow turn started');
  await until(async () => await chat.pane.getByText('working', { exact: true }).count() === 2, 'second slow turn working');
  await chat.send('late');
  await chat.pane.locator('.notice', { hasText: 'This message may not have reached the agent: late' }).waitFor({ timeout: 15000 });
  assert.deepEqual([(await said(instance, id, 'steer-lost')).map((e) => e.data.text), await agentSaid('got:late'), await chat.queued()], [['late'], false, []]);
  await page.locator('#rBots [data-bot="' + id + '"][data-busy]').waitFor({ timeout: 5000 }); // the turn still shows as running
  console.log('PASS slow steering: an answer after 6 s delivered the message once, not queued and sent again at the turn end; a refusal after 6 s showed a notice with the text');
});

test('An agent that cannot take a message mid-turn: it waits queued, is kept across a window restart, and goes when the turn ends', { timeout: 120000 }, async (t) => {
  const { instance, id, launch, open, users, ends } = await setup(t, 'kept', ['no-steering']);
  await until(async () => await ends() === 1, 'hello answered');
  let { app, page } = await launch(), chat = await open(page);
  await chat.send('slow');
  await chat.pane.getByText('working', { exact: true }).waitFor({ timeout: 15000 });
  await chat.send('first');
  await until(async () => (await chat.queued()).length === 1, 'first queued');
  await chat.send('second');
  assert.deepEqual(await chat.queued(), ['Queued: first', 'Queued: second']);
  await app.close();
  ({ app, page } = await launch()); chat = await open(page);
  await chat.pane.getByText('working', { exact: true }).waitFor({ timeout: 15000 });
  await page.waitForTimeout(2000);
  assert.deepEqual(await chat.queued(), ['Queued: first', 'Queued: second'], 'queued messages kept across the restart');
  assert.equal(await chat.pane.locator('.queue [data-qdel]').count(), 2);
  await call(instance, '/chat/' + id + '/cancel', 'POST');
  await until(async () => await ends() === 4, 'first and second sent after the turn ended, one turn each');
  assert.deepEqual(await users(), ['hello', 'slow', 'first', 'second']);
  await until(async () => (await chat.queued()).length === 0, 'queue empty');
  await app.close();
  ({ app, page } = await launch()); chat = await open(page);
  await page.waitForTimeout(3000);
  assert.deepEqual([await chat.queued(), (await users()).length], [[], 4]);
  console.log('PASS kept queue: without steering, 2 messages queued behind a turn were kept across a restart and sent when it ended; nothing resent after another restart');
});

// Renderer main-thread time from Chromium's own counters (seconds), and a CPU profile's top self-time functions.
async function measure(page, ms, work = async () => page.waitForTimeout(ms)) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable'); await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const a = await metrics(), start = Date.now();
  await cdp.send('Profiler.start'); await work(); const { profile } = await cdp.send('Profiler.stop');
  const b = await metrics(), wall = (Date.now() - start) / 1000;
  await cdp.detach();
  const self = new Map(), dt = (profile.endTime - profile.startTime) / 1000 / profile.samples.length;
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  for (const sample of profile.samples) { const f = byId.get(sample).callFrame, key = (f.functionName || '(anonymous)') + ' ' + path.basename(f.url || '') + ':' + (f.lineNumber + 1); self.set(key, (self.get(key) || 0) + dt); }
  const top = [...self].filter(([k]) => !k.startsWith('(idle)') && !k.startsWith('(program)')).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, v]) => k + ' ' + Math.round(v) + ' ms');
  const d = (k) => +(b[k] - a[k]).toFixed(3);
  return { wall: +wall.toFixed(2), task: d('TaskDuration'), script: d('ScriptDuration'), layout: d('LayoutDuration'), style: d('RecalcStyleDuration'), busy: Math.round(100 * d('TaskDuration') / wall) + '%', top };
}

test('Profile: main-thread time idle, with a question open, while a 2,100-event turn streams, and at that length with a question open and unprompted work', { timeout: 300000 }, async (t) => {
  const { instance, id, launch, open, ends } = await setup(t, 'profile');
  await until(async () => await ends() === 1, 'hello answered');
  const { page } = await launch(), chat = await open(page);
  const ask = async () => { await chat.send('ask-later'); await chat.pane.locator('[data-question]').waitFor({ timeout: 15000 }); };
  const out = {};
  out.idle = await measure(page, 10000);
  await ask();
  // The halo ring is one child turned by transform: hidden from readers, cannot catch clicks, still there after the pane re-renders.
  const ring = () => chat.pane.locator('[data-question]').evaluate(f => { const h = f.querySelectorAll(':scope > .halo'); return { n: h.length, hidden: h[0]?.getAttribute('aria-hidden'), events: h[0] && getComputedStyle(h[0]).pointerEvents, spin: h[0]?.firstElementChild.getAnimations().map(a => a.animationName), after: getComputedStyle(f, '::after').content }; });
  const want = { n: 1, hidden: 'true', events: 'none', spin: ['eh-halo-spin'], after: 'none' };
  assert.deepEqual(await ring(), want, 'the question card has one hidden, click-through ring that turns');
  out.pendingQuestion = await measure(page, 10000);
  assert.deepEqual(await ring(), want, 'the ring survives the card being re-rendered');
  await chat.pane.locator('[data-decline]').click();
  await until(async () => await ends() === 2, 'declined');
  out.stream = await measure(page, 0, async () => { await chat.send('stream 700'); await until(async () => await ends() === 3, 'stream turn ended', 120000); await page.locator('#rBots [data-bot="' + id + '"]:not([data-busy])').waitFor({ timeout: 30000 }); });
  out.events = (await events(instance, id)).length;
  out.after = await measure(page, 10000);
  out.oneTurnAtLength = await measure(page, 0, async () => { await chat.send('one more'); await until(async () => await ends() === 4, 'one more ended'); });
  // Try 2 for the freeze (2026-10-24: 2 h 46 min of CPU over 8 h with a question open most of that time, and work
  // with no turn open): the same two states, at this length.
  await ask();
  out.pendingAtLength = await measure(page, 10000);
  await chat.pane.locator('[data-decline]').click();
  await until(async () => await ends() === 5, 'declined at length');
  await chat.send('background quiet');
  await until(async () => await ends() === 6, 'unprompted work started');
  out.unpromptedAtLength = await measure(page, 10000);
  console.log('PROFILE ' + JSON.stringify(out, null, 1));
  if (process.env.P9_EVIDENCE) { await mkdir(process.env.P9_EVIDENCE, { recursive: true }); await writeFile(path.join(process.env.P9_EVIDENCE, 'profile.json'), JSON.stringify(out, null, 1)); }
  // Limits: twice the worst seen (pendingQuestion 0.9 to 1.07 s, pendingAtLength 1.1 to 1.34 s, reports/c5.md "Lost messages
  // and freeze"), still under the 35% a user's renderer used for 8 h.
  // ponytail: GitHub's runners have no GPU and their raster time swings 0.74 to 4.4 s on the same code, so the time limits
  // hold only in the dev space (one machine, run before every merge); CI still runs the flow and logs PROFILE.
  if (process.env.GITHUB_ACTIONS) return;
  assert.ok(out.pendingQuestion.task < 2, 'a pending question costs under 20% of the main thread: ' + out.pendingQuestion.task + ' s');
  assert.ok(out.pendingAtLength.task < 3, 'a pending question in a 2,100-event chat costs under 30%: ' + out.pendingAtLength.task + ' s');
  assert.ok(out.after.task < 1, 'an idle 2,100-event chat costs under 10%: ' + out.after.task + ' s');
});
