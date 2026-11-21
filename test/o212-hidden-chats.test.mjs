// O212: the Projects and Archived pages hide #chats with display:none. A paint while hidden reads a 0-height pane, which
// looked like a reader at the bottom; coming back then put the reader at the bottom (or on the wrong block). Real Electron
// with the sample data; events go through the sample door (window.__sprint.set), which paints through the same paint().
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from '@playwright/test';
import { shellReady } from './helpers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

test('O212: a chat read scrolled up keeps its place through the Archived page, with and without steps arriving while hidden', { timeout: 120000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'p9-o212-'));
  const env = { ...process.env, P9_SAMPLE_DATA: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--user-data-dir=' + profile], env, timeout: 15000 });
  t.after(() => app.close());
  const page = await app.firstWindow({ timeout: 15000 });
  page.on('pageerror', e => console.log('PAGEERROR ' + e.message));
  await shellReady(page, { timeout: 15000 });
  await page.evaluate(() => window.__setup({ writable: false }));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 900));
  // One archived chat, so the panel shows Archived (a page that hides #chats like a project's page, with no daemon needed).
  await page.evaluate(() => window.__sprint.add({ ...structuredClone(window.p9.sample.sessions[0]), id: 's-o212-old', title: 'Old chat', archived: true, sent: true, events: [] }));
  const id = 's-claude-2', open = () => page.evaluate(id => document.querySelector('#navList .row[data-chat="' + id + '"]').click(), id);
  await open();
  const pane = page.locator(`#chats .pane[data-id="${id}"]`);
  await pane.locator('.hist').waitFor({ timeout: 5000 });
  // 260 steps, more than the 200 drawn, so each new step slides the drawn window (as in a live chat).
  await page.evaluate(id => {
    const ev = [];
    for (let i = 0; i < 260; i++) ev.push(i % 2 ? { t: 'agent', text: `reply ${i}.\n\nA second paragraph for ${i}.` } : { t: 'user', text: `msg ${i}.` });
    window.__o212 = ev; window.__sprint.set(id, { events: ev });
  }, id);
  await page.waitForFunction(() => [...document.querySelectorAll('#chats .hist .col > *')].some(c => c.textContent.includes('reply 131.')), null, { timeout: 5000 });
  await pane.locator('.hist').evaluate(h => { h.style.scrollBehavior = 'auto'; const el = [...h.querySelectorAll(':scope > .col > *')].find(c => c.textContent.includes('reply 131.'));
    h.scrollTo({ top: h.scrollTop + el.getBoundingClientRect().top - h.getBoundingClientRect().top - 100, behavior: 'instant' }); });
  const offset = () => pane.locator('.hist').evaluate(h => { const el = [...h.querySelectorAll(':scope > .col > *')].find(c => c.textContent.includes('reply 131.'));
    return el && h.clientHeight ? Math.round(el.getBoundingClientRect().top - h.getBoundingClientRect().top) : null; });
  const push = n => page.evaluate(([id, n]) => { for (let i = 0; i < n; i++) window.__o212.push({ t: 'tool', title: 'Glob ' + i, status: 'completed', output: 'hit' }); window.__sprint.set(id, { events: window.__o212 }); }, [id, n]);
  let o;
  await push(1); // painted once since the reader scrolled up
  o = await offset();
  assert.ok(o !== null && Math.abs(o - 100) <= 1, `the reader starts at 100 px: ${o}`);
  const archived = async () => { await page.locator('#navList [data-archived]').click(); await page.locator('#projPage h1', { hasText: 'Archived' }).waitFor({ timeout: 5000 }); assert.ok(await page.locator('#chats').isHidden(), 'the Archived page hides the chats'); };
  const back = async () => { await open(); await page.locator('#chats').waitFor({ state: 'visible', timeout: 5000 }); };
  // 1. There and back with nothing arriving meanwhile: the paint on coming back must not take the pane for a reader at the top or the bottom.
  await archived(); await back();
  o = await offset();
  assert.ok(o !== null && Math.abs(o - 100) <= 1, `back from Archived the reader is where they were: ${o} px, was 100`);
  // 2. Steps arrive while the chats are hidden (each one paints the hidden pane).
  await archived(); await push(3); await push(3); await back();
  o = await offset();
  assert.ok(o !== null && Math.abs(o - 100) <= 1, `steps that arrived while hidden do not move the reader: ${o} px, was 100`);
  // 3. And the next step after coming back.
  await push(1);
  o = await offset();
  assert.ok(o !== null && Math.abs(o - 100) <= 1, `a step after coming back keeps the reader: ${o} px, was 100`);
  // 4. A reader who was following the bottom still follows it after the trip.
  await pane.locator('.hist').evaluate(h => h.scrollTo({ top: h.scrollHeight, behavior: 'instant' })); await push(1);
  await archived(); await push(3); await back();
  const gap = await pane.locator('.hist').evaluate(h => h.scrollHeight - h.scrollTop - h.clientHeight);
  assert.ok(gap < 24, `a reader at the bottom is still at the bottom: ${gap} px short`);
});
