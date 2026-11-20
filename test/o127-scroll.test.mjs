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
    // O127 rest: more new steps than the 200 drawn, so the drawn window would slide past the reader's block
    ['250 more tool calls (more than the drawn window)', `for (let i = 0; i < 250; i++) ev.push({ t: 'tool', title: 'Glob ' + i, status: 'completed', output: 'hit' })`],
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
  // The window grew to keep the reader's block; following the bottom again puts it back to 200 blocks drawn.
  assert.equal(await pane.locator('.hist .col > [data-at]').count(), 200, 'back at the bottom, the drawn window is 200 steps again');
  // CI #390 fix: up is judged against where the last paint left the scroll. A small scroll up just after the chat followed a
  // long new reply still counts as reading up, so 250 new steps keep that reply drawn where it was.
  await step(`ev.push({ t: 'agent', text: Array.from({ length: 40 }, (_, k) => 'long reply paragraph ' + k + '.').join('\\n\\n') })`);
  await pane.locator('.hist').evaluate(h => h.scrollTo({ top: h.scrollTop - 150, behavior: 'instant' }));
  const longAt = () => pane.locator('.hist').evaluate(h => { const el = [...h.querySelectorAll(':scope > .col > *')].find(c => c.textContent.includes('long reply paragraph 0.'));
    return el ? Math.round(el.getBoundingClientRect().top - h.getBoundingClientRect().top) : null; });
  const l0 = await longAt();
  await step(`for (let i = 0; i < 250; i++) ev.push({ t: 'tool', title: 'Step ' + i, status: 'completed', output: 'hit' })`);
  const l1 = await longAt();
  assert.ok(l1 !== null && Math.abs(l1 - l0) <= 1, `a small scroll up after the chat followed holds the long reply: ${l1} px, was ${l0}`);
  await pane.locator('.hist').evaluate(h => h.scrollTo({ top: h.scrollHeight, behavior: 'instant' }));
  await step(`ev.push({ t: 'agent', text: 'Back down.' })`);
  // Show earlier pressed while the window is grown keeps the larger window: the user asked for it.
  await pane.locator('.hist').evaluate(h => h.scrollTo({ top: 0, behavior: 'instant' }));
  await step(`for (let i = 0; i < 250; i++) ev.push({ t: 'tool', title: 'Find ' + i, status: 'completed', output: 'hit' })`);
  const grown = await pane.locator('.hist .col > [data-at]').count();
  assert.ok(grown > 200, `the window grew to keep the top block: ${grown} drawn`);
  await pane.locator('[data-earlier]').click();
  await page.waitForFunction(([id, n]) => document.querySelectorAll(`.pane[data-id="${id}"] .hist .col > [data-at]`).length > n, [id, grown], { timeout: 5000 });
  await pane.locator('.hist').evaluate(h => h.scrollTo({ top: h.scrollHeight, behavior: 'instant' }));
  await step(`ev.push({ t: 'agent', text: 'After Show earlier.' })`);
  assert.ok(await pane.locator('.hist .col > [data-at]').count() > grown, 'following the bottom after Show earlier keeps the window the user asked for');
  // FIX2 (review of the CI fix): a newly drawn pane had no view record until its next paint, so content growing below the
  // reader before that paint (an image loading) read as reading up. A fresh pane, content grows below it with no repaint
  // in between, then 250 steps arrive: the reader never scrolled, so 200 steps stay drawn.
  const id2 = 's-codex-1', pane2 = page.locator(`.pane[data-id="${id2}"]`);
  await page.evaluate(id2 => { window.__o127b = Array.from({ length: 30 }, (_, i) => ({ t: 'agent', text: `fresh ${i}.` })); }, id2);
  await page.evaluate(id2 => { const s = window.__o127b; window.__sprint.set(id2, { events: s }); document.querySelector('#navList .row[data-chat="' + id2 + '"]')?.click(); }, id2);
  await pane2.locator('.hist .col > [data-at]').last().waitFor({ timeout: 5000 });
  await page.evaluate(() => document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))));
  // The browser's scroll anchoring follows content appended below a reader at the bottom (run 164346: scrollTop 1208 -> 1822),
  // but not an image growing in place, which is what CI hit. Anchoring off stands in for that.
  const gap2 = await pane2.locator('.hist').evaluate(h => { h.style.overflowAnchor = 'none'; const d = document.createElement('div'); d.style.height = '600px'; h.querySelector(':scope > .col').append(d);
    return h.scrollHeight - h.scrollTop - h.clientHeight; });
  assert.ok(gap2 > 24, `content grown below the fresh pane leaves the reader short of the bottom: ${gap2} px`);
  await page.evaluate(id2 => { for (let i = 0; i < 250; i++) window.__o127b.push({ t: 'tool', title: 'Late ' + i, status: 'completed', output: 'hit' }); window.__sprint.set(id2, { events: window.__o127b }); }, id2);
  assert.equal(await pane2.locator('.hist .col > [data-at]').count(), 200, 'a fresh pane whose content grew below the reader still draws 200 steps');
});
