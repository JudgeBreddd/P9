import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { remoteDaemon } from './helpers.mjs';
import { phone } from './phone-c16-helpers.mjs';

// F4 (0.1.9 phase 4): what the phone's own code costs on a slow phone (CPU 4x slower, no network throttle, so the
// network does not hide it). Logged as one "P9_F4 <json>" line; the asserts only check that each step happened.
//   load      reload to the first chat screen ('p9-chat-painted'), ms, and the app's JS bytes read before it
//   live      main-thread task time (ms, CDP TaskDuration) while 26,400 events of six chats arrive with one chat open
//   tick      task time per poll afterwards: one new message at a time in the open chat, five times, median
//   type      median ms of one keystroke in the chat box, with those events held
//   open      median ms from a tap on a chat in the list to its last message drawn
const CHATS = 6, LIVE_TURNS = 200, CHUNKS = 20, CPU = 4;
const id = (c) => '00000000-0000-4000-8000-0000000007' + String(c).padStart(2, '0');
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

function insert(server, turns, tag) {
  const db = new DatabaseSync(path.join(server.directory, '.local', 'state', 'p9-foundation', 'p9.db'));
  const event = db.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)');
  const text = 'A long answer line that a real agent writes, with some detail in it. '.repeat(4);
  db.exec('BEGIN');
  for (let i = 0; i < turns; i++) for (let c = CHATS - 1; c >= 0; c--) {
    event.run(id(c), 'user', JSON.stringify({ text: tag + ' question ' + i }), Date.now());
    for (let k = 0; k < CHUNKS; k++) event.run(id(c), 'update', JSON.stringify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }), Date.now());
    event.run(id(c), 'turn-end', JSON.stringify({ stopReason: 'end_turn' }), Date.now());
  }
  db.exec('COMMIT'); db.close();
}

test('F4 phone cost: load, live events, typing, opening a chat (numbers in the log)', { timeout: 600000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  const db = new DatabaseSync(path.join(server.directory, '.local', 'state', 'p9-foundation', 'p9.db'));
  const chat = db.prepare('INSERT INTO conversations (id, provider, title, state, created) VALUES (?, ?, ?, ?, ?)');
  for (let c = 0; c < CHATS; c++) chat.run(id(c), 'claude', 'Chat ' + c, 'idle', Date.now() - c);
  db.close();
  insert(server, 10, 'old');
  const { page } = await phone(t, server);
  await page.waitForFunction(() => performance.getEntriesByName('p9-chat-painted').length, null, { timeout: 30000 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });

  // load: a reload, chat 0 last shown.
  await page.goto(server.origin + '/phone/#chat=' + id(0)); await page.waitForSelector('#events article', { timeout: 30000 });
  await page.click('[data-back]'); await page.waitForSelector('#chatList [data-chat]', { timeout: 30000 });
  await page.reload({ timeout: 120000 });
  await page.waitForFunction(() => performance.getEntriesByName('p9-chat-painted').length, null, { timeout: 120000 });
  const load = await page.evaluate(() => { const painted = performance.getEntriesByName('p9-chat-painted')[0].startTime;
    const early = performance.getEntriesByType('resource').filter((e) => new URL(e.name).pathname.startsWith('/_astro/') && e.name.endsWith('.js') && e.startTime < painted);
    return { ms: Math.round(painted), jsKb: Math.round(early.reduce((s, e) => s + e.decodedBodySize, 0) / 1024) }; });

  // live: chat 0 open, 7,200 events arrive; the last one is chat 0's, so its text on screen means all are held.
  await page.goto(server.origin + '/phone/#chat=' + id(0)); await page.waitForSelector('#events article', { timeout: 30000 });
  await cdp.send('Performance.enable');
  const task = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value])).TaskDuration * 1000;
  const shown = (text, timeout = 300000) => page.waitForFunction((last) => document.querySelector('#events')?.textContent.includes(last), text, { timeout, polling: 250 });
  let t0 = await task();
  const started = Date.now();
  insert(server, LIVE_TURNS, 'live');
  await shown('live question ' + (LIVE_TURNS - 1));
  const live = { wallMs: Date.now() - started, taskMs: Math.round(await task() - t0) };
  const ticks = [];
  for (let k = 0; k < 5; k++) {
    await page.waitForTimeout(500); t0 = await task();
    const db = new DatabaseSync(path.join(server.directory, '.local', 'state', 'p9-foundation', 'p9.db'));
    db.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)').run(id(0), 'user', JSON.stringify({ text: 'tick message ' + k }), Date.now()); db.close();
    await shown('tick message ' + k, 30000);
    ticks.push(Math.round(await task() - t0));
  }
  const tick = { medianMs: median(ticks), all: ticks };

  // type: 40 keystrokes in the box, each timed to the end of its handlers.
  const keys = await page.evaluate(() => { const box = document.querySelector('#prompt'), out = [];
    for (let i = 0; i < 40; i++) { const t0 = performance.now(); box.value += 'x'; box.dispatchEvent(new Event('input', { bubbles: true })); out.push(performance.now() - t0); }
    box.value = ''; box.dispatchEvent(new Event('input', { bubbles: true })); return out; });
  const type = { medianMs: Math.round(median(keys) * 100) / 100 };

  // open: back to the list, tap chats 1 to 5, each to its last question drawn.
  const opens = [];
  for (let c = 1; c < CHATS; c++) {
    await page.click('[data-back]'); await page.waitForSelector('#chatList [data-chat="' + id(c) + '"]', { timeout: 30000 });
    const t0 = Date.now();
    await page.click('[data-chat="' + id(c) + '"]');
    await page.waitForFunction((last) => document.querySelector('#events')?.textContent.includes(last), 'live question ' + (LIVE_TURNS - 1), { timeout: 60000, polling: 50 });
    opens.push(Date.now() - t0);
  }
  const open = { medianMs: median(opens), all: opens };
  const held = await page.evaluate(() => document.querySelectorAll('#events article').length);
  console.log('P9_F4 ' + JSON.stringify({ cpu: CPU, events: CHATS * (LIVE_TURNS + 10) * (CHUNKS + 2), load, live, tick, type, open, articles: held }));
  assert.ok(load.ms > 0 && live.taskMs >= 0 && ticks.length === 5 && keys.length === 40 && opens.length === CHATS - 1);
});
