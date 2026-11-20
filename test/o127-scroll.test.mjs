// O127: a reader scrolled up in a desktop chat stays on the same block at the same offset while tool calls start, update,
// finish and the agent's text streams. Real Electron with the sample data; the chat's events are set through the sample
// door (window.__sprint.set), which repaints through the same paint() a live batch does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from '@playwright/test';
import { shellReady } from './helpers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

test('O127: a scrolled-up desktop chat does not move while tool calls arrive, finish and text streams', { timeout: 120000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'p9-o127-'));
  const env = { ...process.env, P9_SAMPLE_DATA: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--user-data-dir=' + profile], env, timeout: 15000 });
  t.after(() => app.close());
  const page = await app.firstWindow({ timeout: 15000 });
  page.on('pageerror', e => console.log('PAGEERROR ' + e.message));
  await shellReady(page, { timeout: 15000 });
  await page.evaluate(() => window.__setup({ writable: false }));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 900));
  const id = 's-claude-2';
  await page.evaluate(id => document.querySelector('#navList .row[data-chat="' + id + '"]')?.click(), id);
  const pane = page.locator(`.pane[data-id="${id}"]`);
  await pane.locator('.hist').waitFor({ timeout: 5000 });
  // 260 steps (more than the 200 drawn), so every new event slides the drawn window. Event 100 is a tool still running
  // (drawn open, with output) above the reader; the reader reads 'reply 130.'.
  await page.evaluate(id => {
    const ev = [];
    for (let i = 0; i < 260; i++) ev.push(i % 3 === 0 ? { t: 'user', text: `msg ${i}.` } : i % 3 === 1 ? { t: 'agent', text: `reply ${i}.\n\nA second paragraph for ${i}.` }
      : { t: 'tool', title: `Read file${i}.txt`, status: 'completed', output: `out ${i}` });
    ev[100] = { t: 'tool', title: 'Bash long run', status: 'in_progress', output: Array.from({ length: 12 }, (_, k) => 'line ' + k).join('\n') };
    window.__o127 = ev; window.__sprint.set(id, { events: ev });
  }, id);
  await page.waitForFunction(() => [...document.querySelectorAll('.hist .col > *')].some(c => c.textContent.includes('reply 130.')), null, { timeout: 5000 });
  await pane.locator('.hist').evaluate(h => { h.style.scrollBehavior = 'auto'; const el = [...h.querySelectorAll(':scope > .col > *')].find(c => c.textContent.includes('reply 130.'));
    h.scrollTop += el.getBoundingClientRect().top - h.getBoundingClientRect().top - 100; });
  const offset = () => pane.locator('.hist').evaluate(h => { const el = [...h.querySelectorAll(':scope > .col > *')].find(c => c.textContent.includes('reply 130.'));
    return el ? Math.round(el.getBoundingClientRect().top - h.getBoundingClientRect().top) : null; });
  assert.equal(await offset(), 100, 'the reader starts at 100 px');
  const step = (fn, arg) => page.evaluate(([id, fn, arg]) => { new Function('ev', 'arg', fn)(window.__o127, arg); window.__sprint.set(id, { events: window.__o127 }); }, [id, fn, arg]);
  const steps = [
    ['a tool call starts', `ev.push({ t: 'tool', title: 'Bash npm test', status: 'in_progress' })`],
    ['its output arrives', `ev.at(-1).output = 'ok 1\\nok 2\\nok 3'`],
    ['it finishes', `ev.at(-1).status = 'completed'`],
    ['the running tool above the reader finishes and closes', `ev[100].status = 'completed'`],
    ['the agent starts a reply', `ev.push({ t: 'agent', text: 'Strea' })`],
    ['its text streams', `ev.at(-1).text += 'ming a longer reply.\\n\\nWith a second paragraph.'`],
    ['thirty more tool calls', `for (let i = 0; i < 30; i++) ev.push({ t: 'tool', title: 'Grep ' + i, status: 'completed', output: 'hit' })`],
    // review #377 FIX1: the list changes before the reader, so every drawn block's index shifts by one
    ['a step above the reader is removed', `ev.splice(120, 1)`],
    ['a step is added at the start (history loaded)', `ev.unshift({ t: 'user', text: 'an older message.' })`],
  ];
  // Scroll positions are whole pixels and block heights are not, so 'the same offset' is within 1 px (main moves it 78 px).
  const near = async (what) => { const o = await offset(); assert.ok(Math.abs(o - 100) <= 1, `the reader moved when ${what}: ${o} px, was 100`); };
  for (const [what, fn] of steps) { await step(fn); await near(what); }
  await pane.locator('textarea').click(); await page.keyboard.type('typing here');
  await near('typing in the box');
  // A block below the held one removed (reply 130 itself): the held block stays where it was on screen.
  const heldAt = () => pane.locator('.hist').evaluate(h => { const top = h.getBoundingClientRect().top;
    const el = [...h.querySelectorAll(':scope > .col > [data-at]')].find(c => c.getBoundingClientRect().bottom > top); return { y: el.getBoundingClientRect().top - top, text: el.textContent }; });
  const h0 = await heldAt();
  await step(`ev.splice(ev.findIndex(e => e.text?.startsWith('reply 130.')), 1)`);
  const h1 = await heldAt();
  assert.equal(h1.text, h0.text, 'the same block is first on screen');
  assert.ok(Math.abs(h1.y - h0.y) <= 1, `the held block moved when the block below it was removed: ${h1.y}, was ${h0.y}`);
  // The held block itself (the first one on screen) removed: nothing to hold, so the old pixel position stays (no jump, no error).
  const before = await pane.locator('.hist').evaluate(h => { const top = h.getBoundingClientRect().top;
    const el = [...h.querySelectorAll(':scope > .col > [data-at]')].find(c => c.getBoundingClientRect().bottom > top); return { top: h.scrollTop, at: +el.dataset.at, text: el.textContent }; });
  await step('ev.splice(arg, 1)', before.at);
  const after = await pane.locator('.hist').evaluate((h, text) => ({ top: h.scrollTop, still: [...h.querySelectorAll(':scope > .col > [data-at]')].some(c => c.textContent === text) }), before.text);
  assert.equal(after.still, false, `the held block is gone: ${before.text.slice(0, 60)}`);
  assert.ok(Math.abs(after.top - before.top) <= 1, `with its block gone the reader stays at the same scroll position: ${after.top}, was ${before.top}`);
  const shot = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT o127-reader-held ' + shot);
  // A reader at the bottom still follows the new steps.
  // instant: a repaint puts the pane's smooth scrolling back, and a smooth scroll would still be on its way
  await pane.locator('.hist').evaluate(h => h.scrollTo({ top: h.scrollHeight, behavior: 'instant' }));
  await step(`ev.push({ t: 'agent', text: 'The last reply.' })`);
  const gap = await pane.locator('.hist').evaluate(h => h.scrollHeight - h.scrollTop - h.clientHeight);
  assert.ok(gap < 24, `a reader at the bottom no longer follows: ${gap} px short`);
});
