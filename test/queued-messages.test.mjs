// A user's messages sent while the agent worked never reached it (2026-10-24, release blocker): a coordinator's
// background tasks kept it working with no turn-end for 8 h, and P9 held them for that end. Real Electron, the real
// daemon and the fake agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
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
  const launch = async (other = '', state = instance.state) => { // other: a second window, with its own profile; state: another way in (slowLink)
    const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', state, '--user-data-dir=' + profile + other], env, chromiumSandbox: true, timeout: 20000 });
    const proc = app.process();
    t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
    const page = await app.firstWindow();
    await page.locator('#rChat').waitFor();
    return { app, page };
  };
  const id = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'hello' });
  const open = async (page) => {
    await page.locator('#navList .rowwrap[data-live] .row[data-chat="' + id + '"]').waitFor({ timeout: 15000 });
    await page.locator('#nav .row[data-chat="' + id + '"]').click();
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

// phone-3 (the desktop showed "You chose: reject", "You chose: exit-plan-bypass"): the line after an
// answer holds the button's own words, as the phone does, never its internal id.
test('phone-3: after an approval the desktop says the button the user chose, in its own words', { timeout: 120000 }, async (t) => {
  const { launch, open, agentSaid, ends } = await setup(t, 'chose');
  await until(async () => await ends() === 1, 'hello answered');
  const { page } = await launch(), chat = await open(page);
  await chat.send('permission');
  await chat.pane.locator('[data-approve="allow"]').click({ timeout: 15000 });
  await until(() => agentSaid('permission:allow'), 'the agent got the answer');
  const line = chat.pane.locator('.notice', { hasText: 'You chose' });
  await line.waitFor({ timeout: 15000 });
  assert.equal(await line.innerText(), 'You chose: Allow');
  await line.scrollIntoViewIfNeeded(); await page.waitForTimeout(300);
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT desktop-you-chose ' + (await page.screenshot()).toString('base64'));
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
  await page.locator('#navList .row[data-chat="' + id + '"] [data-busy]').waitFor({ timeout: 5000 }); // the turn still shows as running
  console.log('PASS slow steering: an answer after 6 s delivered the message once, not queued and sent again at the turn end; a refusal after 6 s showed a notice with the text');
});

// O255: they wait in the daemon's hold, so the turn's end sends them as one prompt (as it does every held message).
test('An agent that cannot take a message mid-turn: it waits queued, is kept across a window restart, and goes when the turn ends', { timeout: 120000 }, async (t) => {
  const { id, launch, open, users, ends } = await setup(t, 'kept', ['no-steering']);
  await until(async () => await ends() === 1, 'hello answered');
  let { app, page } = await launch(), chat = await open(page);
  await chat.send('tools 8'); // 8 tool calls of 3 s: a turn that ends by itself
  await page.locator('#navList .row[data-chat="' + id + '"] [data-busy]').waitFor({ timeout: 15000 });
  await chat.send('first');
  await until(async () => (await chat.queued()).length === 1, 'first queued');
  await chat.send('second');
  // The strip is the daemon's hold now (O255), so it shows after the daemon's answer.
  await until(async () => (await chat.queued()).length === 2, 'second queued');
  assert.deepEqual(await chat.queued(), ['Queued: first', 'Queued: second']);
  await app.close();
  ({ app, page } = await launch()); chat = await open(page);
  await page.locator('#navList .row[data-chat="' + id + '"] [data-busy]').waitFor({ state: 'attached', timeout: 15000 }); // the open chat's row hides it
  await until(async () => (await chat.queued()).length === 2, 'both queued after the restart');
  assert.deepEqual(await chat.queued(), ['Queued: first', 'Queued: second'], 'queued messages kept across the restart');
  assert.equal(await chat.pane.locator('.queue [data-unhold]:not([data-now])').count(), 2);
  // O125 (4): each keeps when it was queued, also across the restart, so the strip names the oldest wait.
  assert.equal(await chat.pane.locator('.queue > summary').innerText(), '2 queued, oldest waiting <1 min');
  await until(async () => await ends() === 3, 'first and second sent after the turn ended', 45000);
  assert.deepEqual(await users(), ['hello', 'tools 8', 'first\n\nsecond']);
  await until(async () => (await chat.queued()).length === 0, 'queue empty');
  await app.close();
  ({ app, page } = await launch()); chat = await open(page);
  await page.waitForTimeout(3000);
  assert.deepEqual([await chat.queued(), (await users()).length], [[], 3]);
  console.log('PASS kept queue: without steering, 2 messages queued behind a turn were kept across a restart and sent when it ended; nothing resent after another restart');
});

// O255, O256: a message sent while a turn runs waits in the daemon, the one list every window draws. A second window sees it,
// a reload keeps it, send now and order hold across windows, and each goes with the files attached when it was sent, not
// with what the box holds at the turn's end. Fails on main: the window kept these in its own queue as text only, so the files
// went back into the box (and out with whichever message was sent next), and a second window saw nothing queued.
test('O255: queued messages wait in the daemon: a second window sees them, a reload keeps them, each goes with its own files', { timeout: 150000 }, async (t) => {
  const { instance, id, launch, open, users, ends } = await setup(t, 'o255', ['no-steering']);
  await until(async () => await ends() === 1, 'hello answered');
  const attach = async (page, pane, name) => {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10000 }), pane.locator('[data-attach]').click()]);
    await chooser.setFiles([{ name, mimeType: 'text/plain', buffer: Buffer.from(name) }]);
    await pane.locator('.attach .att-file', { hasText: name }).waitFor({ timeout: 10000 });
  };
  const a = await launch();
  let chatA = await open(a.page);
  await chatA.send('tools 8'); // 8 tool calls of 3 s: a turn that ends by itself
  await a.page.locator('#navList .row[data-chat="' + id + '"] [data-busy]').waitFor({ timeout: 15000 });
  await attach(a.page, chatA.pane, 'one.txt'); await chatA.send('first');
  await until(async () => (await chatA.queued()).length === 1, 'first queued');
  await attach(a.page, chatA.pane, 'two.txt'); await chatA.send('second');
  await until(async () => (await chatA.queued()).length === 2, 'second queued');
  assert.equal(await chatA.pane.locator('.attach').count(), 0, 'each file went with its message: none is back in the box');
  // Take back (the x): the message and its own file come back into the box; the box is then emptied for what follows.
  await attach(a.page, chatA.pane, 'three.txt'); await chatA.send('third');
  await until(async () => (await chatA.queued()).length === 3, 'third queued');
  await chatA.pane.locator('.queue [data-held]', { hasText: 'third' }).locator('[data-unhold]:not([data-now])').click();
  // Its file comes back from the held entry (carry) or, when the prompt's 202 comes after the take-back, from that answer.
  const box = async () => JSON.stringify([await chatA.pane.locator('.composer textarea').inputValue(), (await chatA.pane.locator('.attach .att-file').allInnerTexts()).map((x) => x.split('\n')[0])]);
  await until(async () => (await chatA.queued()).length === 2 && await box() === JSON.stringify(['third', ['three.txt']]), 'take-back gives the message its file back');
  await chatA.pane.locator('.attach [data-unattach]').click(); await chatA.pane.locator('.composer textarea').fill('');
  const b = await launch('-b'), chatB = await open(b.page);
  await until(async () => (await chatB.queued()).length === 2, 'the second window shows both queued');
  await a.page.reload(); await a.page.locator('#rChat').waitFor(); chatA = await open(a.page);
  await until(async () => (await chatA.queued()).length === 2, 'both still queued after a reload');
  assert.deepEqual(await chatA.queued(), ['Queued: first', 'Queued: second']);
  await attach(a.page, chatA.pane, 'draft.txt'); // a later draft's file, not sent
  // Send now from the other window: the turn stops, second goes alone, and first follows at that turn's end.
  await chatB.pane.locator('.queue [data-held]', { hasText: 'second' }).locator('[data-now]').click();
  await until(async () => (await users()).length === 4, 'second sent now, first after it', 30000);
  const sent = (await said(instance, id, 'user')).slice(2).map((e) => [e.data.text, (e.data.files ?? []).map((f) => f.name)]);
  assert.deepEqual(sent, [['second', ['two.txt']], ['first', ['one.txt']]]);
  await until(async () => (await chatA.queued()).length === 0 && (await chatB.queued()).length === 0, 'both strips empty');
  assert.deepEqual((await chatA.pane.locator('.attach .att-file').allInnerTexts()).map((x) => x.split('\n')[0]), ['draft.txt'], 'the unsent draft keeps its file');
  console.log('PASS O255: 2 messages with a file each, queued in the daemon, seen by a second window and after a reload; send now from the other window sent second then first, each with its own file');
});

// O255, the row's slow link: the window reaches the daemon through a link that sends each request on at BPS bytes a second
// (as a tunnel does), so a send with a 2 MB file takes about 3 s to arrive and a short one sent right after it arrives
// at once. The window sends a chat's prompts one at a time, so the short one cannot pass it: they wait, and go, in the
// order typed. (Over the local socket a 5 MB send arrives first anyway, so this needs the link.)
const BPS = 1_000_000;
async function slowLink(to, at, t) {
  const server = net.createServer((client) => {
    const up = net.connect(to); let tail = Promise.resolve();
    client.on('data', (c) => { tail = tail.then(() => new Promise((r) => setTimeout(r, c.length * 1000 / BPS))).then(() => up.destroyed || up.write(c)); });
    client.on('end', () => { tail = tail.then(() => up.end()); });
    up.pipe(client);
    const end = () => { client.destroy(); up.destroy(); }; client.on('error', end); up.on('error', end); up.on('close', end);
  });
  await new Promise((r) => server.listen(at, r)); t.after(() => server.close());
}
test('O255: two sends in a row keep their order over a slow link when the first carries a big file', { timeout: 150000 }, async (t) => {
  const { instance, id, launch, open, users, ends } = await setup(t, 'o255-order', ['no-steering']);
  await until(async () => await ends() === 1, 'hello answered');
  const slow = await mkdtemp(path.join(os.tmpdir(), 'p9-slow-')), sock = path.join(slow, 'daemon.sock');
  const creds = JSON.parse(await readFile(path.join(instance.state, 'desktop.json'), 'utf8'));
  await writeFile(path.join(slow, 'desktop.json'), JSON.stringify({ ...creds, socketPath: sock }), { mode: 0o600 });
  await slowLink(path.join(instance.state, 'daemon.sock'), sock, t);
  const { page } = await launch('', slow), chat = await open(page);
  await chat.send('tools 8'); // 8 tool calls of 3 s: a turn that ends by itself
  await page.locator('#navList .row[data-chat="' + id + '"] [data-busy]').waitFor({ timeout: 15000 });
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10000 }), chat.pane.locator('[data-attach]').click()]);
  await chooser.setFiles([{ name: 'big.txt', mimeType: 'text/plain', buffer: Buffer.alloc(2 * 1024 * 1024, 'x') }]);
  await chat.pane.locator('.attach .att-file', { hasText: 'big.txt' }).waitFor({ timeout: 10000 });
  await chat.send('big'); await chat.send('small'); // no wait between them
  await until(async () => (await chat.queued()).length === 2, 'both queued', 30000);
  assert.deepEqual(await chat.queued(), ['Queued: big', 'Queued: small']);
  await until(async () => await ends() === 3, 'the turn ended and both went', 60000);
  assert.deepEqual((await users()).slice(2), ['big\n\nsmall']);
  console.log('PASS O255 order: over a slow link, a 2 MB send then a short one right after it waited and went in the order typed');
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
  out.stream = await measure(page, 0, async () => { await chat.send('stream 700'); await until(async () => await ends() === 3, 'stream turn ended', 120000); await page.locator('#navList .rowwrap[data-live]:not(:has([data-busy])) .row[data-chat="' + id + '"]').waitFor({ timeout: 30000 }); });
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

// Review round 8 (O249): a turn that ends in an error has no turn-end after it. A message queued behind it went only with the
// next turn or a click; it goes at the error now, as at a turn end.
test('A message queued behind a turn that fails goes when the failure comes', { timeout: 120000 }, async (t) => {
  const { instance, id, launch, open, users, ends } = await setup(t, 'failq', ['no-steering']);
  await until(async () => await ends() === 1, 'hello answered');
  const { page } = await launch(), chat = await open(page);
  await chat.send('slow fail');
  await chat.pane.getByText('working', { exact: true }).waitFor({ timeout: 15000 });
  await chat.send('first');
  await until(async () => (await chat.queued()).length === 1, 'first queued');
  await until(async () => (await said(instance, id, 'error')).length === 1, 'the turn failed');
  await until(async () => (await users()).includes('first'), 'first sent after the failure', 10000);
  await until(async () => (await chat.queued()).length === 0, 'queue empty');
  assert.deepEqual(await users(), ['hello', 'slow fail', 'first']);
  console.log('PASS failed turn: the message queued behind a turn that ended in an error went at the error');
});

// A2 step 3: the pencil on a queued message edits it where it waits: it keeps its place, and goes with the new words.
// An edit still open when its message goes is not lost: it lands in the box, with a notice that the message went as it was.
test('A2 step 3: a queued message edited in place keeps its place and goes edited; an edit open when it goes lands in the box; the main box sends its own words meanwhile', { timeout: 150000 }, async (t) => {
  const { instance, id, launch, open, users, ends } = await setup(t, 'a2-edit', ['no-steering']);
  await until(async () => await ends() === 1, 'hello answered');
  const { page } = await launch(); let chat = await open(page);
  await chat.send('tools 8');
  await page.locator('#navList .row[data-chat="' + id + '"] [data-busy]').waitFor({ timeout: 15000 });
  await chat.send('first'); await until(async () => (await chat.queued()).length === 1, 'first queued');
  await chat.send('second'); await until(async () => (await chat.queued()).length === 2, 'second queued');
  const row = (text) => chat.pane.locator('.queue [data-held]', { hasText: text });
  await row('first').locator('[data-hedit]').click();
  let editor = chat.pane.locator('.queue textarea[name="heldEdit"]');
  assert.equal(await editor.inputValue(), 'first', 'the editor opens with the message');
  assert.equal(await chat.pane.locator('.queue [data-hedit]').count(), 0, 'one edit at a time: no other pencil while it is open');
  await editor.fill('never saved'); await editor.press('Escape');
  assert.deepEqual(await chat.queued(), ['Queued: first', 'Queued: second'], 'Esc leaves it as it was');
  assert.equal(await page.locator('#navList .row[data-chat="' + id + '"] [data-busy]').count(), 1, 'Esc in the editor does not stop the turn');
  await row('first').locator('[data-hedit]').click();
  await editor.fill('first, edited'); await editor.press('Enter');
  await until(async () => JSON.stringify(await chat.queued()) === JSON.stringify(['Queued: first, edited', 'Queued: second']), 'the edit shows in its place');
  await page.reload(); await page.locator('#rChat').waitFor(); chat = await open(page); editor = chat.pane.locator('.queue textarea[name="heldEdit"]');
  await until(async () => JSON.stringify(await chat.queued()) === JSON.stringify(['Queued: first, edited', 'Queued: second']), 'a reload keeps the edit');
  // Another window saves the second one while this editor is open and untouched: the editor follows; typing then is kept.
  const second = await row('second').getAttribute('data-held');
  await row('second').locator('[data-hedit]').click();
  await call(instance, '/chat/' + id + '/held-text', 'POST', { held: second, text: 'second, from elsewhere', was: 'second' });
  await until(async () => await editor.inputValue() === 'second, from elsewhere', 'an untouched editor follows another window\'s save');
  await editor.fill('second, still typing');
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT a2-queue-edit ' + (await chat.pane.locator('.bottom').screenshot({ type: 'png' })).toString('base64'));
  // The main box with an edit open: its Enter sends the box's own words, and leaves the open edit as typed.
  await chat.send('third');
  await until(async () => (await chat.queued()).includes('Queued: third'), 'the box\'s words queued');
  assert.equal(await editor.inputValue(), 'second, still typing', 'the main box leaves the open edit alone');
  assert.equal(await chat.pane.locator('.composer textarea').inputValue(), '', 'the box sent its own words');
  // The turn ends with the second one's edit still open: it goes as saved, and the unsaved words come into the box.
  await until(async () => (await users()).slice(2).join('\n').includes('third'), 'the queue went out', 40000);
  assert.deepEqual((await users()).slice(2).join('\n').split('\n').filter((l) => /first|second|third/.test(l)), ['first, edited', 'second, from elsewhere', 'third']);
  await until(async () => await chat.pane.locator('.composer textarea').inputValue() === 'second, still typing', 'the open edit lands in the box');
  assert.equal(await chat.pane.locator('.queue').count(), 0);
  console.log('PASS A2 step 3: an edit keeps its place and goes edited; an edit open when its message went came into the box');
});
