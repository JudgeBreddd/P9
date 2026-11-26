// O267 (moved out of composer.test.mjs: its waits alone run about 4 minutes, 244 s measured, and CI stops a file at 600 s). Same setup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, http, authenticated, root, watchStartup, waitStartup } from './helpers.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((result) => ({ status: result.status, ...JSON.parse(result.text) }));
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

// One chat with the given agent, answered "hello" once, and a window on it.
async function setup(t, name, { provider = 'claude', files = [], env: extra = {} } = {}) {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  for (const file of files) await writeFile(path.join(instance.workspace, file), '');
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-' + name + '-')), 'profile');
  const env = { ...process.env, ...extra }; delete env.ELECTRON_RUN_AS_NODE;
  const id = (await call(instance, '/chat', 'POST', { provider })).conversation;
  await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'hello' });
  const agentSaid = async (text) => (await said(instance, id, 'update')).some((e) => e.data.content?.text === text);
  await until(() => agentSaid('echo:hello'), 'hello answered');
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow(), watch = watchStartup(page);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  // O71: timed out on CI 3 times (11-20, 11-21), the O58 (l) shape; a timeout prints the page's stage.
  await waitStartup(page, watch, page.locator('#navList .rowwrap[data-live] .row[data-chat="' + id + '"]'), { what: name + ' row live', chat: id, timeout: 15000 });
  await page.locator('#nav .row[data-chat="' + id + '"]').click();
  const pane = page.locator('.pane[data-id="' + id + '"]');
  const type = async (text) => { await pane.locator('.composer textarea').click(); await page.keyboard.type(text); };
  const send = async (text) => { await type(text); await page.keyboard.press('Enter'); };
  return { app, instance, id, page, pane, type, send, agentSaid, errors };
}

const started = (instance, id, tool) => until(async () => (await said(instance, id, 'update')).some((e) => e.data.toolCallId === tool), tool + ' started');
const users = async (instance, id) => (await said(instance, id, 'user')).map((e) => e.data.text);

// O267: a send whose retry gets outcome-unknown (a remote's first try still in flight) asks again with the same operation
// ID until the daemon answers, so its own answer settles it (a held one keeps its files the normal way); an identical
// message from elsewhere does not count as it. Never answered: back in the box, saying it may still have arrived.
// Review 7: it asks until the send cap (10 minutes; 65 s here, P9_SEND_CAP_MS), so one that lands late is delivered once.
test('O267: a send with an unknown outcome asks again with its own operation ID, then goes back in the box unsure', { timeout: 420000 }, async (t) => {
  const { app, instance, id, page, pane, send, errors } = await setup(t, 'o267-unknown', { files: ['slow-tools'], env: { P9_SEND_CAP_MS: '65000' } });
  const composer = pane.locator('.composer textarea');
  // 'landed': the daemon's first two answers are lost in flight, the third try is the one it runs. 'lost': never answered.
  // 'held': the daemon runs the first try (held mid-turn) but its answer is lost; the second meets a dropped link (503);
  // the third gets the daemon's own answer replayed (202 with its held ID).
  await app.evaluate(({ ipcMain }) => { const h = ipcMain._invokeHandlers.get('p9:chat'); ipcMain.removeHandler('p9:chat'); globalThis.o267 = [];
    ipcMain.handle('p9:chat', async (e, ...args) => { const text = args[0] === 'prompt' && args[1]?.text; if (!['landed', 'lost', 'held', 'stalled', 'late', 'dropped', 'dropped once', 'long work', 'long again', 'slow cut'].includes(text)) return h(e, ...args);
      globalThis.o267.push([text, args[1].op, JSON.stringify(args[1])]);
      const n = globalThis.o267.filter(([x]) => x === text).length;
      if (text === 'held') { if (n === 1) { await h(e, ...args); return { status: 409, body: { error: 'outcome-unknown', operation: args[1].op } }; } if (n === 2) return { status: 503, body: { error: 'daemon-unavailable' } }; globalThis.o267replayed = await h(e, ...args); return globalThis.o267replayed; }
      if (text === 'landed' && n >= 3) return h(e, ...args);
      // Review 9: 'dropped': the daemon takes the first try but the link drops before its answer (503, unsure: it went out), and drops again on
      // the second; the third gets its own answer replayed. 'long work': its turn starts, its answer never comes until told.
      if (text === 'dropped') { if (n === 1) await h(e, ...args); return n <= 2 ? { status: 503, body: { error: 'daemon-unavailable', unsure: true } } : h(e, ...args); }
      // Review 10: 'dropped once': the first try goes out but its link drops (unsure); the retry meets nothing listening (a plain
      // 503, never sent); the third gets the first try's answer replayed.
      if (text === 'dropped once') { if (n === 1) { await h(e, ...args); return { status: 503, body: { error: 'daemon-unavailable', unsure: true } }; } return n === 2 ? { status: 503, body: { error: 'daemon-unavailable' } } : h(e, ...args); }
      if (text === 'long work') { if (n === 1) void h(e, ...args); if (globalThis.o267settle) return h(e, ...args); }
      // Review 11: 'long again' is 'long work' again, answered once o267settle2; 'slow cut' (an Interrupt) waits on its link until o267cutgo.
      if (text === 'long again') { if (n === 1) void h(e, ...args); if (globalThis.o267settle2) { globalThis.o267long2 = true; return h(e, ...args); } }
      if (text === 'slow cut') { await new Promise((res) => { globalThis.o267cutgo = res; }); return h(e, ...args); }
      // Round 4: 'lost' stalls its tries from 50 s on (a bridge prompt can wait 90 s): the send still ends unsure at the cap.
      // Round 5: 'stalled' never answers its first try: the cap counts from it too.
      // Review 7: 'late' lands at 62 s, past the old 60 s deadline and inside the cap.
      if (text === 'late') { await new Promise((res) => setTimeout(res, 62000)); return h(e, ...args); }
      if (text === 'stalled') { globalThis.o267stalled = Date.now(); await new Promise(() => {}); }
      if (text === 'lost') { globalThis.o267lost ??= Date.now(); if (Date.now() - globalThis.o267lost > 50000) await new Promise(() => {}); }
      return { status: 409, body: { error: 'outcome-unknown', operation: args[1]?.op } }; }); });
  const rows = pane.locator('.queue [data-held]');
  await send('tools 2');
  await started(instance, id, 'tool-1');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10000 }), pane.locator('[data-attach]').click()]);
  await chooser.setFiles([{ name: 'held.txt', mimeType: 'text/plain', buffer: Buffer.from('held') }]);
  await pane.locator('.attach .att-file', { hasText: 'held.txt' }).waitFor({ timeout: 10000 });
  await send('held');
  await until(async () => (await app.evaluate(() => globalThis.o267replayed?.status)) === 202, 'the third try got the daemon\'s own answer', 15000);
  assert.ok((await app.evaluate(() => globalThis.o267replayed.body?.held)), 'a held ID in the replayed answer');
  assert.equal(new Set(await app.evaluate(() => globalThis.o267.filter(([x]) => x === 'held').map(([, op]) => op))).size, 1, 'one operation across the lost answer and the dropped link');
  await until(async () => (await rows.filter({ hasText: 'held' }).count()) === 1, 'held once', 5000);
  assert.equal(await pane.locator('.attach').count(), 0, 'its file went with it');
  await rows.filter({ hasText: 'held' }).locator('[data-unhold]:not([data-now])').click();
  await until(async () => (await composer.inputValue()) === 'held' && (await pane.locator('.attach .att-file', { hasText: 'held.txt' }).count()) === 1, 'Take back gives the message its file back', 10000);
  await pane.locator('.attach [data-unattach]').click(); await composer.fill('');
  await until(async () => (await pane.locator('.working').count()) === 0, 'the tool turn ended', 30000);
  assert.equal((await users(instance, id)).filter((u) => u === 'held').length, 0, 'taken back, never sent');
  await send('landed');
  // The same words from another device while this one waits: a message of its own, not this send's answer.
  const other = await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'landed' }); assert.equal(other.status, 202, JSON.stringify(other.body));
  await until(async () => (await users(instance, id)).filter((u) => u === 'landed').length === 2, 'both arrived, once each', 20000);
  const ops = await app.evaluate(() => globalThis.o267.filter(([x]) => x === 'landed').map(([, op]) => op));
  assert.equal(ops.length, 3); assert.equal(new Set(ops).size, 1, 'each try is the same operation');
  assert.equal(await composer.inputValue(), '', 'a message that arrived does not come back');
  assert.equal(await page.locator('#toasts .toast', { hasText: 'not sure' }).count(), 0, 'its own answer settled it, with no unsure line');
  await until(async () => (await pane.locator('.working').count()) === 0, 'those turns ended', 20000);
  await send('lost');
  await page.waitForTimeout(5000);
  assert.equal(await composer.inputValue(), '', 'not back in the box while P9 may still be running it');
  await until(async () => (await composer.inputValue()) === 'lost', 'back in the box once P9 never answered', 80000);
  assert.ok(Date.now() - (await app.evaluate(() => globalThis.o267lost)) < 71000, 'by the cap, though its last try stalled');
  await page.locator('#toasts .toast', { hasText: 'Still not sure your message arrived' }).waitFor({ timeout: 5000 });
  assert.equal(new Set(await app.evaluate(() => globalThis.o267.filter(([x]) => x === 'lost').map(([, op]) => op))).size, 1, 'one operation throughout');
  assert.equal((await users(instance, id)).filter((u) => u === 'lost').length, 0);
  await composer.fill(''); await send('stalled');
  await until(async () => (await composer.inputValue()) === 'stalled', 'back in the box though its first try never answered', 80000);
  const waited = Date.now() - (await app.evaluate(() => globalThis.o267stalled));
  assert.ok(waited < 69000, `by the cap from the first try (${waited} ms)`);
  assert.equal((await app.evaluate(() => globalThis.o267.filter(([x]) => x === 'stalled').length)), 1, 'one try: it never answered');
  // Review 7: an answer at 62 s is still this send's own: delivered once, never back in the box, and a send made meanwhile
  // waits in the chat's line behind it, so it goes after it.
  await composer.fill(''); await send('late');
  await page.waitForTimeout(2000); await send('behind');
  await until(async () => (await users(instance, id)).includes('behind'), 'the send behind it went', 90000);
  const order = await users(instance, id);
  assert.equal(order.filter((u) => u === 'late').length, 1, 'the late send arrived once');
  assert.ok(order.lastIndexOf('late') < order.indexOf('behind'), 'and before the send made behind it');
  assert.equal(await app.evaluate(() => globalThis.o267.filter(([x]) => x === 'late').length), 1, 'one try: its own answer came');
  assert.equal(await composer.inputValue(), '', 'a late answer does not put it back in the box');
  assert.equal(await page.locator('#toasts .toast', { hasText: 'operation-reused' }).count(), 0, 'no reused-ID refusal');
  // Review 9: two dropped links before any outcome-unknown are unsure too: it keeps asking and arrives once, not back in the box.
  await until(async () => (await pane.locator('.working').count()) === 0, 'the late turns ended', 30000);
  await send('dropped');
  await until(async () => (await users(instance, id)).includes('dropped') && (await app.evaluate(() => globalThis.o267.filter(([x]) => x === 'dropped').length)) === 3, 'its third try got its own answer', 20000);
  await page.waitForTimeout(1000);
  assert.equal(await composer.inputValue(), '', 'not put back in the box after the dropped links');
  assert.equal((await users(instance, id)).filter((u) => u === 'dropped').length, 1, 'arrived once');
  assert.equal(new Set(await app.evaluate(() => globalThis.o267.filter(([x]) => x === 'dropped').map(([, op]) => op))).size, 1, 'one operation');
  await until(async () => (await pane.locator('.working').count()) === 0, 'its turn ended', 30000);
  // Review 10: an unsure first try stays unsure when the retry meets nothing listening: it keeps asking, never back in the box.
  await send('dropped once');
  await until(async () => (await users(instance, id)).includes('dropped once') && (await app.evaluate(() => globalThis.o267.filter(([x]) => x === 'dropped once').length)) === 3, 'its third try got the first try\'s answer', 20000);
  await page.waitForTimeout(1000);
  assert.equal(await composer.inputValue(), '', 'not put back in the box after an unsure try and a plain 503');
  assert.equal((await users(instance, id)).filter((u) => u === 'dropped once').length, 1, 'arrived once');
  await until(async () => (await pane.locator('.working').count()) === 0, 'its turn ended', 30000);
  // Review 9: Interrupt and send does not wait behind a send whose answer never came: the running turn stops and the new
  // message goes long before the cap. Then the first send's answer comes, and it stays sent.
  await send('long work');
  await until(async () => (await users(instance, id)).includes('long work') && (await pane.locator('.working').count()) === 1, 'the long turn runs, its answer not back', 20000);
  await page.waitForTimeout(1500);
  // Review 10: a send made behind the unanswered one waits for it, so the Interrupt goes first; it still goes once, after it.
  await send('wait behind');
  await composer.fill('cut in'); const cut = Date.now(); await composer.press('Control+Enter');
  await until(async () => (await users(instance, id)).includes('cut in'), 'the interrupt went while the first send was unanswered', 20000);
  assert.ok(Date.now() - cut < 20000, 'well before the cap');
  await app.evaluate(() => { globalThis.o267settle = true; });
  await until(async () => (await pane.locator('.working').count()) === 0, 'the cut-in turn ended', 30000);
  await page.waitForTimeout(2500);
  assert.equal((await users(instance, id)).filter((u) => u === 'long work').length, 1, 'the first send arrived once');
  await until(async () => (await users(instance, id)).includes('wait behind'), 'the send behind it went once it was answered', 20000);
  await until(async () => (await pane.locator('.working').count()) === 0, 'its turn ended', 30000);
  const after = await users(instance, id);
  assert.equal(after.filter((u) => u === 'wait behind').length, 1, 'the send behind it arrived once');
  assert.ok(after.indexOf('cut in') < after.indexOf('wait behind'), 'after the Interrupt: ' + JSON.stringify(after.slice(-4)));
  // Review 11: the answer it waits for comes while the Interrupt is still on its way: it still goes after the Interrupt.
  await send('long again');
  await until(async () => (await users(instance, id)).includes('long again') && (await pane.locator('.working').count()) === 1, 'the second long turn runs', 20000);
  await send('behind again');
  await composer.fill('slow cut'); await composer.press('Control+Enter');
  await until(async () => app.evaluate(() => !!globalThis.o267cutgo), 'the Interrupt is on its way', 10000);
  await app.evaluate(() => { globalThis.o267settle2 = true; });
  await until(async () => app.evaluate(() => !!globalThis.o267long2), 'the long send got its answer', 20000);
  await page.waitForTimeout(3000);
  assert.ok(!(await users(instance, id)).includes('behind again'), 'it waits for the Interrupt still on its way');
  await app.evaluate(() => globalThis.o267cutgo());
  await until(async () => (await users(instance, id)).includes('behind again'), 'it went after the Interrupt', 30000);
  await until(async () => (await pane.locator('.working').count()) === 0, 'its turn ended', 30000);
  const again = await users(instance, id);
  assert.deepEqual(['slow cut', 'behind again'].map((u) => again.filter((x) => x === u).length), [1, 1], 'each once');
  assert.ok(again.indexOf('slow cut') < again.indexOf('behind again'), 'after the Interrupt: ' + JSON.stringify(again.slice(-4)));
  assert.equal(await composer.inputValue(), '', 'and its late answer does not put it back in the box');
  assert.equal(await page.locator('#toasts .toast', { hasText: 'not sure' }).count(), 0, 'no unsure line');
  assert.deepEqual(errors, [], 'no page errors');
  console.log('PASS O267: an unknown outcome asks again with its own ID; an unsure first try stays unsure; a send behind an unanswered one goes once, after an Interrupt; identical words elsewhere do not settle it; a late answer is its own; never answered by the cap, back in the box unsure; dropped links stay unsure; an interrupt does not wait behind an unanswered send');
});

// A2 step 7: Ctrl+S in the message box saves its text as a draft and empties the box; Ctrl+S in an empty box, or Drafts,
// lists them, newest first; one picked goes back in the box and leaves the list; its x deletes it; Esc closes the list.
