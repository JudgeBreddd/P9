// The side panel (specs/side-panel.md, v0.1.6 chunk 12): the shared drag helper, the panel's slots, width, narrow mode, where it
// puts Dev Focus's native editor view, the cards overlay above that view, and the Dev Focus layout (chat beside the editor, swap,
// on/off). The phone's full sheet is in phone-shell.test.mjs; the editable file modal is in file-edit.test.mjs.
// The shell runs in real Electron with the test sample data; the editor and cards views are read from the window's native
// children (window.p9 is frozen and cannot be stubbed). The dev space keeps no files: pictures go out in the log as
// "P9_SHOT <name> <base64>" and are written to P9_SCREENSHOTS when that is set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, chromium } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));
const near = (a, b, why) => assert.ok(Math.abs(a - b) <= 1.5, why + ': ' + a + ' vs ' + b);

async function launch(t) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'p9-side-'));
  const env = { ...process.env, P9_SAMPLE_DATA: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--user-data-dir=' + profile], env });
  t.after(() => app.close());
  const page = await app.firstWindow();
  await page.locator('#cards .card').first().waitFor();
  const size = (w, h) => app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0].setContentSize(width, height), [w, h]);
  await size(1400, 900);
  const reset = async () => { await size(1400, 900); await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1)); await page.evaluate(() => localStorage.clear()); await page.goto('p9://app/'); await page.locator('#cards .card').first().waitFor(); await page.waitForFunction(() => !!window.__side); };
  // The window's native children (Dev Focus's editor view, then the cards overlay), in window pixels.
  const native = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.map(c => ({ ...c.getBounds(), visible: c.getVisible(), url: c.webContents.getURL() })));
  const box = async sel => page.locator(sel).boundingBox();
  const shot = async (name, withViews = false) => {
    let png;
    if (!withViews) png = await page.screenshot({ animations: 'disabled' });
    else { // page.screenshot leaves out native views: stack each view's own picture at its bounds, in order, in a plain page
      const layers = await app.evaluate(async ({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0], out = [{ b: { x: 0, y: 0, ...win.getContentBounds() }, png: (await win.webContents.capturePage()).toPNG().toString('base64') }];
        for (const c of win.contentView.children) if (c.getVisible()) out.push({ b: c.getBounds(), png: (await c.webContents.capturePage()).toPNG().toString('base64') });
        return out;
      });
      const browser = await chromium.launch(), p = await browser.newPage({ viewport: { width: layers[0].b.width, height: layers[0].b.height } });
      await p.setContent('<body style="margin:0;background:#000">' + layers.map(l => `<img style="position:absolute;left:${l.b.x}px;top:${l.b.y}px;width:${l.b.width}px;height:${l.b.height}px" src="data:image/png;base64,${l.png}">`).join(''));
      png = await p.screenshot(); await browser.close();
    }
    if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png.toString('base64'));
    if (process.env.P9_SCREENSHOTS) { await mkdir(process.env.P9_SCREENSHOTS, { recursive: true }); await writeFile(path.join(process.env.P9_SCREENSHOTS, name + '.png'), png); }
  };
  const frames = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const drag = async (from, dx, { hold = false, steps = 8 } = {}) => {
    await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(from.x + dx, from.y, { steps });
    await new Promise(r => setTimeout(r, 250)); await frames(); // pointermove is delivered once per frame, the last ones after the CDP call returns: read the layout after them
    if (!hold) { await page.mouse.up(); await frames(); }
  };
  return { app, page, reset, native, box, shot, drag, size, frames };
}
const mid = b => ({ x: b.x + b.width / 2, y: b.y + 250 });

test('side panel: the drag bar, slots, narrow mode, the editor view beside it, swap, toggle, cards over the view, the Chat split bar (A/B)', { timeout: 240000 }, async (t) => {
  const { app, page, reset, native, box, shot, drag, size, frames } = await launch(t);
  const goDev = async () => { await page.click('#rDev'); await page.locator('#side').waitFor(); await page.waitForFunction(() => window.__side.current()?.slot === 'dan-chat'); };

  await t.test('1. dragBar: the bar drags the panel, the width survives a reload, ArrowLeft adds 24, a drag past the end stops at the end', async () => {
    await reset(); await goDev();
    const stage = (await box('.stage')).width, w0 = (await box('#side')).width;
    near(w0, stage / 2, 'Dev Focus starts about half and half');
    const bar = await box('#side .handle-v');
    await drag(mid(bar), -100, { hold: true });
    near((await box('#side')).width, w0 + 100, 'dragged 100 px left');
    await shot('side-drag-midway', true);
    await page.mouse.up();
    const w1 = (await box('#side')).width;
    await page.reload(); await page.waitForFunction(() => !!window.__side); await goDev();
    near((await box('#side')).width, w1, 'the width after a reload');
    await page.locator('#side .handle-v').focus(); await page.keyboard.press('ArrowLeft');
    near((await box('#side')).width, w1 + 24, 'ArrowLeft adds 24 px');
    const bar2 = await box('#side .handle-v');
    await drag(mid(bar2), -2000);
    near((await box('#side')).width, Math.min(stage * .7, stage - 480), 'a drag past the end stops at the end (the editor keeps 480)');
    await drag(mid(await box('#side .handle-v')), 3000);
    near((await box('#side')).width, 280, 'and at the other end it stops at 280');
  });

  await t.test('1b. the terminal grip still drags with the same numbers (120 px up to 70% of the window)', async () => {
    await reset(); await goDev();
    await page.click('#rTerm'); await page.locator('#dock').waitFor({ state: 'visible' });
    const grip = await box('#grip'), h0 = (await box('#dock')).height;
    await page.mouse.move(grip.x + 40, grip.y + 2); await page.mouse.down(); await page.mouse.move(grip.x + 40, grip.y - 98, { steps: 6 }); await new Promise(r => setTimeout(r, 250)); await frames(); await page.mouse.up();
    near((await box('#dock')).height, h0 + 100, 'the dock grew 100 px');
    await page.mouse.move(grip.x + 40, grip.y - 98); await page.mouse.down(); await page.mouse.move(grip.x + 40, grip.y + 2000, { steps: 6 }); await new Promise(r => setTimeout(r, 250)); await frames(); await page.mouse.up();
    near((await box('#dock')).height, 120, 'and stops at 120 px');
    await page.click('#rTerm');
  });

  await t.test('2. slots: opening artifact while dan-chat shows calls its onClose once and shows only artifact', async () => {
    await reset(); await goDev();
    const log = await page.evaluate(() => {
      const log = []; const side = window.__side;
      side.open('dan-chat', { title: 'Chat', render: b => { b.textContent = 'chat'; }, onClose: why => log.push('chat:' + why) });
      side.open('artifact', { title: 'Artifact', render: b => { b.textContent = 'artifact'; }, onClose: why => log.push('artifact:' + why) });
      side.close('dan-chat'); // not the owner's slot: a no-op
      return { log: [...log], now: side.current(), slot: document.querySelector('#side').dataset.slot, text: document.querySelector('#sideBody').textContent };
    });
    assert.deepEqual(log.log, ['chat:replaced']);
    assert.equal(log.slot, 'artifact'); assert.equal(log.text, 'artifact'); assert.deepEqual(log.now, { slot: 'artifact', mode: 'panel' });
  });

  await t.test('3. Dev Focus: the editor view ends 8 px or more left of the panel, and the cards do not make it narrower', async () => {
    await reset(); await goDev();
    await page.waitForFunction(() => document.querySelector('#side').getBoundingClientRect().width > 0);
    const side = await box('#side'), [view] = await native();
    assert.match(view.url, /^p9:\/\/dev/, 'the first native child is the editor view: ' + view.url);
    assert.ok(view.visible && view.width > 100, 'the editor view is shown');
    assert.ok(view.x + view.width <= side.x - 8 + 0.5, `the view ends at ${view.x + view.width}, the panel starts at ${side.x}`);
    const fdev = await box('#fDev');
    near(view.x + view.width, side.x - 8, 'and no further left than that (no card column kept free)');
    assert.ok(fdev.x + fdev.width <= side.x + 1, 'the Dev pane is left of the panel');
  });

  await t.test('4. narrow: at 700 px the panel covers the stage and Escape goes back', async () => {
    await reset(); await goDev();
    // The window's minWidth is 720 and the panel goes full under 720 CSS px: zoom in 1.25x (the page is then 576 px wide).
    t.after(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1)).catch(() => {})); // the app may already be closed
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(720, 800); w.webContents.setZoomFactor(1.25); });
    await page.evaluate(() => window.__side.open('artifact', { title: 'Artifact', mode: 'panel', render: b => { b.textContent = 'artifact'; } }));
    await page.waitForFunction(() => document.querySelector('.stage').dataset.sideMode === 'full');
    const stage = await box('.stage'), side = await box('#side');
    near(side.x, stage.x, 'left edges'); near(side.width, stage.width, 'widths'); near(side.height, stage.height - ((await box('#dock').catch(() => null))?.height ?? 0), 'heights');
    const [view] = await native();
    assert.equal(view.visible, false, 'the editor view steps aside while the panel is full');
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.webContents.setZoomFactor(1); w.setContentSize(1400, 900); });
    await page.waitForFunction(() => document.querySelector('.stage').dataset.sideMode === 'panel');
  });

  await t.test('5. Dev Focus layout: the chat is beside the editor on the right, its tab dragged across swaps them, and the swap is kept', async () => {
    await reset(); await goDev();
    assert.equal(await page.locator('.stage').getAttribute('data-side'), 'right');
    const s0 = await box('#side'), f0 = await box('#fDev');
    assert.ok(s0.x > f0.x, 'the chat is right of the editor');
    await shot('dev-chat-right', true);
    const tab = await box('#side .stab');
    await drag({ x: tab.x + tab.width / 2, y: tab.y + tab.height / 2 }, -(s0.x - f0.x) / 2 - 150);
    await page.waitForFunction(() => document.querySelector('.stage').dataset.side === 'left');
    const s1 = await box('#side'), f1 = await box('#fDev'), [view] = await native();
    assert.ok(s1.x < f1.x, 'the chat is left of the editor now');
    assert.ok(view.x >= s1.x + s1.width + 8 - 0.5, `the editor view starts at ${view.x}, right of the panel's end ${s1.x + s1.width} + 8`);
    await shot('dev-chat-left', true);
    await page.reload(); await page.waitForFunction(() => !!window.__side); await goDev();
    assert.equal(await page.locator('.stage').getAttribute('data-side'), 'left', 'the swap is kept');
    // The editor's own tab brings it back.
    const et = await box('#devTab .stab'), bar = await box('#side .handle-v');
    await drag({ x: et.x + et.width / 2, y: et.y + et.height / 2 }, 150);
    assert.equal(await page.locator('.stage').getAttribute('data-side'), 'left', 'dragging the editor tab further from the panel changes nothing');
    await drag({ x: et.x + et.width / 2, y: et.y + et.height / 2 }, -(et.x - bar.x) - 150);
    await page.waitForFunction(() => document.querySelector('.stage').dataset.side === 'right');
  });

  await t.test('6. the chat can be turned off and on: the editor takes the width, the choice is kept', async () => {
    await reset(); await goDev();
    await page.click('#sideToggle');
    await page.waitForFunction(() => document.querySelector('#side').hidden);
    assert.equal(await page.locator('#sideToggle').getAttribute('aria-pressed'), 'false');
    const stage = await box('.stage'), f = await box('#fDev'), [view] = await native();
    near(f.width, stage.width, 'the editor pane has the whole stage'); near(view.x + view.width, stage.x + stage.width, 'and so does the editor view');
    await page.reload(); await page.waitForFunction(() => !!window.__side); await page.click('#rDev');
    assert.equal(await page.locator('#side').isHidden(), true, 'off stays off after a reload');
    await page.click('#sideToggle'); await page.locator('#side').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#sideToggle').getAttribute('aria-pressed'), 'true');
    assert.ok(await page.locator('#sideChats .pane').count() === 1, 'the chat is in it');
    await page.click('#rChat'); assert.equal(await page.locator('#side').isHidden(), true, 'Chat Focus has no side chat');
  });

  await t.test('7. cards float over the Dev view in their own overlay view and never resize a pane', async () => {
    await reset(); await page.click('#rDev'); await page.locator('#side').waitFor();
    await page.waitForFunction(() => document.querySelector('#cards .card'));
    await page.waitForFunction(() => true);
    const views = async () => { for (let i = 0; i < 40; i++) { const v = await native(); if (v.length === 2 && v[1].visible && v[1].height > 20) return v; await new Promise(r => setTimeout(r, 150)); } return native(); };
    const [dev, cards] = await views();
    assert.match(cards.url, /^p9:\/\/cards/); assert.ok(cards.visible && cards.height > 20 && cards.width > 100, 'the overlay is shown: ' + JSON.stringify(cards));
    const stage = await box('.stage');
    assert.ok(cards.x + cards.width <= stage.x + stage.width + 1 && cards.y >= stage.y, 'inside the stage');
    const side = await box('#side'), over = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
    assert.ok(over(cards, dev) || over(cards, side), 'the cards are drawn over a pane (the stack is at the stage right: over the chat panel)');
    near(dev.x + dev.width, side.x - 8, 'the editor view is as wide as without cards');
    assert.ok(await page.locator('#cards').evaluate(c => getComputedStyle(c).visibility === 'hidden'), 'the page keeps its own stack hidden, so nothing is drawn twice');
    await shot('cards-over-dev', true);
    // A click in the overlay reaches the shell: the x snoozes the card.
    const n = await page.locator('#cards .card').count();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children[1].webContents.executeJavaScript("document.querySelector('.x').click()"));
    await page.waitForFunction(count => document.querySelectorAll('#cards .card').length === count - 1, n);
    const drawn = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children[1].webContents.executeJavaScript("document.querySelectorAll('.card').length"));
    assert.equal(drawn, n - 1, 'the overlay drew the shorter list');
    // Other focuses: the overlay hides, the page's own cards show again.
    await page.click('#rChat'); await page.waitForFunction(() => document.querySelector('#cards').checkVisibility({ visibilityProperty: true }));
    assert.equal((await native())[1]?.visible ?? false, false);
  });

  await t.test('8. Chat Focus: the split bar drags (and ArrowRight adds 24), and the pane beside keeps room', async () => {
    await reset(); await page.click('#rSplit');
    await page.waitForFunction(() => document.querySelector('#chats').dataset.split === 'true');
    await shot('chat-split-opened');
    const panes = () => page.locator('#chats > .pane').evaluateAll(p => p.map(x => Math.round(x.getBoundingClientRect().width)));
    const [l0, r0] = await panes(), bar = await box('#chats .handle-v');
    await drag(mid(bar), 120, { hold: true });
    const [l1, r1] = await panes();
    near(l1, l0 + 120, 'the left chat grew 120 px'); near(r1, r0 - 120, 'the right one gave it');
    await shot('chat-split-midway');
    await page.mouse.up();
    await page.locator('#chats .handle-v').focus(); await page.keyboard.press('ArrowRight');
    near((await panes())[0], l1 + 24, 'ArrowRight adds 24 px');
    await drag(mid(await box('#chats .handle-v')), 3000);
    assert.ok((await panes())[1] >= 279, 'the right chat keeps 280 px: ' + (await panes())[1]);
  });

  await t.test('10. Chat Focus full: the artifact ends above the chat text box, which is visible and takes typing (desktop and phone width)', async () => {
    await reset();
    const [minW, minH] = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getMinimumSize());
    t.after(() => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setMinimumSize(w, h), [minW, minH]).catch(() => {}));
    for (const [name, w, h] of [['desktop', 1400, 900], ['phone', 390, 844]]) {
      await app.evaluate(({ BrowserWindow }, [w, h]) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(1, 1); win.setContentSize(w, h); }, [w, h]);
      const extras = page.locator('#chats > .pane').first().locator('.pinned .plan, .meters');
      assert.equal(await extras.count(), 2, name + ': the sample chat has a plan card and meters (so the hidden check below is not empty)');
      assert.ok(await extras.first().isVisible() && await extras.last().isVisible(), name + ': both show before the artifact opens');
      await page.evaluate(() => window.__side.open('artifact', { title: 'Artifact', mode: 'full', render: b => { b.textContent = 'artifact'; } }));
      await page.waitForFunction(() => document.querySelector('.stage').dataset.sideMode === 'full');
      await frames();
      assert.equal((await extras.evaluateAll(l => l.filter(e => e.checkVisibility({ visibilityProperty: true })).length)), 0, name + ': full mode hides the plan card and the meters');
      const ta = page.locator('#chats > .pane textarea').first();
      assert.ok(await ta.isVisible(), name + ': the text box is visible under the full-screen artifact');
      assert.ok(await ta.evaluate(el => { const r = el.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el; }), name + ': nothing covers the text box');
      const side = await box('#side'), tb = await ta.boundingBox();
      assert.ok(side.y + side.height <= tb.y + 1, `${name}: the artifact ends at ${side.y + side.height}, the text box starts at ${tb.y}`);
      assert.ok(side.height > 100, name + ': the artifact still has room: ' + side.height);
      assert.ok(tb.y - (side.y + side.height) <= 20, `${name}: only the text box sits below the artifact (gap ${tb.y - (side.y + side.height)} px)`);
      await ta.click(); await page.keyboard.type('still typing');
      assert.equal(await ta.inputValue(), 'still typing', name + ': the box takes typing');
      await shot(name + '-chat-full');
      await ta.fill(''); await page.evaluate(() => window.__side.close('artifact'));
    }
    // Two chats side by side: both boxes show and the artifact ends above them.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 900));
    await page.click('#rSplit'); await page.waitForFunction(() => document.querySelector('#chats').dataset.split === 'true');
    await page.evaluate(() => window.__side.open('artifact', { title: 'Artifact', mode: 'full', render: b => { b.textContent = 'artifact'; } }));
    await page.waitForFunction(() => document.querySelector('.stage').dataset.sideMode === 'full'); await frames();
    const boxes = page.locator('#chats > .pane textarea'), tops = [], side = await box('#side');
    assert.equal(await boxes.count(), 2, 'split: two chats');
    for (let i = 0; i < 2; i++) { assert.ok(await boxes.nth(i).isVisible(), 'split: text box ' + i + ' is visible'); tops.push((await boxes.nth(i).boundingBox()).y); }
    assert.ok(side.y + side.height <= Math.min(...tops) + 1, `split: the artifact ends at ${side.y + side.height}, the first text box starts at ${Math.min(...tops)}`);
    await shot('split-chat-full');
  });

  await t.test('9. what the overlay view costs: this reports the memory of its renderer', async () => {
    await reset();
    const metrics = () => app.evaluate(({ app }) => app.getAppMetrics().map(m => ({ pid: m.pid, type: m.type, name: m.name ?? '', ws: m.memory.workingSetSize, priv: m.memory.privateBytes ?? 0 })));
    const sum = list => list.reduce((a, m) => a + m.ws, 0);
    await page.click('#rDev'); await page.locator('#side').waitFor();
    // cards snoozed: the editor view exists, the overlay does not
    for (let i = 0; i < 5 && await page.locator('#cards .card').count(); i++) { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children[1]?.webContents.executeJavaScript("document.querySelector('.x')?.click()")); await new Promise(r => setTimeout(r, 400)); }
    await new Promise(r => setTimeout(r, 2500));
    const before = await metrics(), pids = new Set(before.map(m => m.pid));
    await page.reload(); await page.click('#rDev'); // the cards come back with the page, so the overlay is made
    for (let i = 0; i < 40 && (await native()).length < 2; i++) await new Promise(r => setTimeout(r, 150));
    await new Promise(r => setTimeout(r, 2500));
    const after = await metrics(), added = after.filter(m => !pids.has(m.pid));
    console.log('P9_MEM before ' + JSON.stringify({ processes: before.length, workingSetKB: sum(before) }) + ' after ' + JSON.stringify({ processes: after.length, workingSetKB: sum(after) })
      + ' new processes ' + JSON.stringify(added) + ' delta workingSetKB ' + (sum(after) - sum(before)));
    assert.ok(after.length >= before.length, 'the overlay adds a process, never removes one');
  });
});
