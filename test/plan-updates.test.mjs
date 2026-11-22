// Live plan updates: an agent sends its plan again each time a step moves on (ACP: each plan update replaces the last).
// The ledger keeps every update in order; the desktop strip and the phone show only the latest, live and after a
// reload; the phone's tail read brings the latest plan even when it is older than the window. The real daemon and the
// fake agent ("plan step <n>"); the strip in real Electron, the phone in Chromium.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { remoteDaemon, root } from './helpers.mjs';
import { phone } from './phone-c16-helpers.mjs';
import { openLedger } from '../apps/server/ledger.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, what, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await wait(200)) if (await check()) return;
  assert.fail('timed out: ' + what);
};
const STEPS = ['Read the chat ledger', 'Write the plan test', 'Check it on the phone'];
// The strip's lines after "plan step n": done ✓, in progress ▸, pending ○.
const shown = (n) => STEPS.map((step, i) => (i < n - 1 || n === 3 ? '✓' : i === n - 1 ? '▸' : '○') + step);

test('live plan: three plan updates are kept in order; the desktop strip and the phone show the latest each time, and after a reload', { timeout: 180000 }, async (t) => {
  const server = await remoteDaemon(t, { args: ['--acp-override', path.join(root, 'test/fake-acp-agent.mjs')] });
  const events = async (id) => (await server.desk('/chat/events?after=0&only=' + id)).body.events;
  const plans = async (id) => (await events(id)).filter((e) => e.type === 'update' && e.data.sessionUpdate === 'plan');
  const id = (await server.desk('/chat', 'POST', { provider: 'claude' })).body.conversation;
  await server.desk('/chat/' + id + '/prompt', 'POST', { text: 'hello' });
  await until(async () => (await events(id)).some((e) => e.type === 'connected'), 'connected');

  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-plan-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', server.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), wait(15000)]); proc.kill(); });
  const desk = await app.firstWindow();
  const errors = [];
  desk.on('pageerror', (error) => errors.push(error.message));
  await desk.locator('#nav .row[data-chat="' + id + '"]').click({ timeout: 15000 });
  const pane = desk.locator('.pane[data-id="' + id + '"]');
  const strip = pane.locator('.bottom .pinned');

  const { page } = await phone(t, server);
  await page.waitForSelector('h1:text("Chats")');
  await page.goto(server.origin + '/phone/#chat=' + id);
  await page.waitForSelector('#prompt', { state: 'visible', timeout: 15000 });

  const lines = async (locator) => locator.allTextContents();
  for (const n of [1, 2, 3]) {
    await server.desk('/chat/' + id + '/prompt', 'POST', { text: 'plan step ' + n });
    await until(async () => JSON.stringify(await lines(strip.locator('.plan li'))) === JSON.stringify(shown(n)), 'desktop strip at step ' + n);
    await until(async () => JSON.stringify(await lines(page.locator('#pinned .plan li'))) === JSON.stringify(shown(n)), 'phone strip at step ' + n);
    assert.equal(await strip.locator('.plan').count(), 1, 'one plan on the desktop at step ' + n);
    assert.equal(await pane.locator('.hist .plan').count(), 0, 'no plan left in the desktop history at step ' + n);
    assert.equal(await page.locator('#pinned .plan').count(), 1, 'one plan on the phone at step ' + n);
  }

  // The ledger keeps all three, in the order sent.
  const kept = await plans(id);
  assert.equal(kept.length, 3);
  assert.deepEqual(kept.map((e) => e.data.entries.map((entry) => entry.status)),
    [['in_progress', 'pending', 'pending'], ['completed', 'in_progress', 'pending'], ['completed', 'completed', 'completed']]);
  assert.ok(kept[0].cursor < kept[1].cursor && kept[1].cursor < kept[2].cursor);

  // A reload reads the chat again from the ledger: the latest plan, once.
  await page.reload();
  await page.waitForSelector('#pinned .plan li', { state: 'attached', timeout: 15000 });
  assert.deepEqual(await lines(page.locator('#pinned .plan li')), shown(3));
  assert.equal(await page.locator('#pinned .plan').count(), 1);
  await desk.reload();
  await desk.locator('#nav .row[data-chat="' + id + '"]').click({ timeout: 15000 });
  await until(async () => JSON.stringify(await lines(strip.locator('.plan li'))) === JSON.stringify(shown(3)), 'desktop strip after a reload');
  assert.equal(await strip.locator('.plan').count(), 1);
  assert.deepEqual(errors, []);
  console.log('PASS live plan: 3 updates kept in order; desktop strip and phone show the latest at each step and after a reload');
});

// The phone's tail read (ledger.tail) leaves older events out but brings the chat's latest plan along: with the three
// plan updates older than the window, only the newest comes back.
test('live plan: the tail read keeps the latest of three plan updates when they are older than the window', () => {
  const CHAT = '00000000-0000-4000-8000-0000000000e1';
  const ledger = openLedger(':memory:'), add = (type, data) => ledger.append(CHAT, type, data);
  add('user', { text: 'plan' });
  for (const n of [1, 2, 3]) add('update', { sessionUpdate: 'plan', entries: STEPS.map((content, i) => ({ content, status: shown(n)[i][0] })) });
  add('turn-end', { stopReason: 'end_turn' });
  for (let i = 0; i < 5; i++) {
    add('user', { text: 'more ' + i });
    add('update', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok ' + i } });
    add('turn-end', { stopReason: 'end_turn' });
  }
  const tail = ledger.tail([CHAT], undefined, 2);
  assert.ok(tail.more[CHAT] > 0, 'older events are left out');
  const plans = tail.events.filter((e) => e.type === 'update' && e.data.sessionUpdate === 'plan');
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0].data.entries.map((entry) => entry.status), ['✓', '✓', '✓']);
});
