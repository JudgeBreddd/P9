// Window speed while streaming, and window memory after 20 turns (phase 4, window-1). Measures only; it asserts that the
// turns ended, never a time, so the same file runs unchanged before and after a change. Logs one line,
// "P9_WINDOW <json>": frame intervals and main-thread time while a 2,100-event turn bursts and a 400-chunk reply drips in the shown chat, and the
// renderer's JS heap after a forced garbage collection, after 20 turns in that chat and again once it is off screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, http, authenticated, root } from './helpers.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((result) => JSON.parse(result.text));
const ends = async (instance, id) => {
  let n = 0;
  for (let after = 0, page; (page = await call(instance, '/chat/events?after=' + after + '&only=' + id)).events.length; after = page.cursor) n += page.events.filter((e) => e.type === 'turn-end').length;
  return n;
};
const until = async (check, what, ms = 30000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 200))) if (await check()) return;
  assert.fail('timed out: ' + what);
};
const pct = (list, p) => { const s = [...list].sort((a, b) => a - b); return s.length ? +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1) : 0; };

test('Window speed: frames while a turn bursts and while one drips, heap after 20 turns and with that chat off screen', { timeout: 600000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const chats = [];
  for (let i = 0; i < 3; i++) {
    const id = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
    await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'hello' });
    chats.push(id);
  }
  for (const id of chats) await until(async () => await ends(instance, id) === 1, 'hello answered');
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-window-speed-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#rChat').waitFor();
  const show = async (id) => {
    await page.locator('#navList .rowwrap[data-live] .row[data-chat="' + id + '"]').waitFor({ timeout: 15000 });
    await page.locator('#nav .row[data-chat="' + id + '"]').click();
    await page.locator('.pane[data-id="' + id + '"] .composer textarea').waitFor();
  };
  const send = async (id, text) => { await page.locator('.pane[data-id="' + id + '"] .composer textarea').click(); await page.keyboard.type(text); await page.keyboard.press('Enter'); };
  const idle = (id) => page.locator('#navList .rowwrap[data-live]:not(:has([data-busy])) .row[data-chat="' + id + '"]').waitFor({ timeout: 60000 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const heap = async () => { for (let i = 0; i < 3; i++) await cdp.send('HeapProfiler.collectGarbage'); return +((await metrics()).JSHeapUsedSize / 1048576).toFixed(2); };
  const [a, b, c] = chats, out = {};

  // Frames: every requestAnimationFrame interval in the window while a turn streams, to its last chunk on screen.
  const frames = async (n, text, last) => {
    await page.evaluate(() => { window.__stop = false; window.__frames = []; let at = performance.now(); const tick = (now) => { window.__frames.push(now - at); at = now; if (!window.__stop) requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
    const m0 = await metrics(), start = Date.now();
    await send(a, text);
    await until(async () => await ends(instance, a) === n, text + ' ended', 240000);
    await page.locator('.pane[data-id="' + a + '"]').getByText(last).first().waitFor({ timeout: 60000 });
    const wall = (Date.now() - start) / 1000, m1 = await metrics();
    const f = await page.evaluate(() => { window.__stop = true; return window.__frames.slice(1); });
    const d = (k) => +(m1[k] - m0[k]).toFixed(3);
    await idle(a);
    return { wall: +wall.toFixed(2), frames: f.length, p50: pct(f, 0.5), p95: pct(f, 0.95), max: pct(f, 1), long: f.filter((x) => x > 50).length,
      task: d('TaskDuration'), script: d('ScriptDuration'), layout: d('LayoutDuration'), style: d('RecalcStyleDuration') };
  };
  await show(a);
  out.burst = await frames(2, 'stream 700', 'step 700 done.'); // 2,100 events as fast as the agent sends them
  out.drip = await frames(3, 'drip 400 25', 'Chunk 400 of the reply'); // 400 chunks 25 ms apart and 40 tool calls

  // Memory: 18 more turns in the same chat (20 with the two above), then the heap; then two other chats take both tabs.
  for (let i = 3; i <= 20; i++) { await send(a, 'stream 30'); await until(async () => await ends(instance, a) === i + 1, 'turn ' + i, 60000); await idle(a); }
  out.heapShown = await heap();
  await show(b); await show(c);
  await page.waitForTimeout(2000);
  out.heapOff = await heap();
  await cdp.detach();
  console.log('P9_WINDOW ' + JSON.stringify(out));
  assert.equal(await ends(instance, a), 21, 'all 20 turns ended');
});
