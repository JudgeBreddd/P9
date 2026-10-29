// v0.1.6 c23: the desktop polish items (D1, D14, D2, D11, D12, D6), in the real Electron shell with sample data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, chromium } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));

async function launch(t) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'p9-c23-'));
  const env = { ...process.env, P9_SAMPLE_DATA: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--user-data-dir=' + profile], env, timeout: 15000 });
  t.after(() => app.close());
  const page = await app.firstWindow({ timeout: 15000 });
  await page.locator('#cards .card').first().waitFor({ timeout: 15000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 900));
  // The window's native children (Dev Focus's editor view first), in window pixels (zoom 1).
  const native = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.map(c => ({ ...c.getBounds(), visible: c.getVisible(), url: c.webContents.getURL() })));
  // page.screenshot leaves out native views: stack each view's own picture at its bounds, in order (side-panel.test.mjs).
  // live: a toast's fade-out run to its end (animations: 'disabled') removes the toast, so its pictures keep the animations.
  const shot = async (name, withViews = false, live = false) => {
    let png = await page.screenshot(live ? {} : { animations: 'disabled' });
    if (withViews) {
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
  };
  return { app, page, native, shot };
}
const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test('D1: a toast shows its whole message; a click opens it with where to start, and the toast stays', { timeout: 90000 }, async (t) => {
  const { page, shot } = await launch(t);
  await page.evaluate(() => document.documentElement.style.setProperty('--toast-life', '600s'));
  const txt = 'Could not save plan-for-the-long-weekend.md: no permission to write it. Your text is still here.';
  await page.evaluate((txt) => {
    window.__toast({ kind: 'not saved', txt, level: 'bad', start: 'Your text is still in the editor, so nothing is lost. Fix the reason above (it names the file and why), then press Ctrl S again.' }, true);
    window.__toast({ kind: 'not attached', txt: 'holiday-photo-from-the-lake.heic: PNG, JPEG, GIF or WebP only.', level: 'warn' }, true);
  }, txt);
  await page.locator('#toasts .toast', { hasText: 'holiday-photo' }).waitFor({ timeout: 5000 });
  for (const toast of await page.locator('#toasts .toast .truncate').all()) {
    assert.deepEqual(await toast.evaluate((el) => [getComputedStyle(el).whiteSpace, el.scrollWidth <= el.clientWidth]), ['normal', true], 'the whole message shows');
  }
  await shot('c23-d1-toasts', false, true);
  await page.locator('#toasts .toast', { hasText: 'plan-for-the-long-weekend' }).click();
  await page.locator('#mdl[open] #mdlBody', { hasText: txt }).waitFor({ timeout: 5000 });
  assert.match(await page.locator('#mdlBody .start').innerText(), /^Where to start: Your text is still in the editor/);
  assert.equal(await page.locator('#toasts .toast', { hasText: 'plan-for-the-long-weekend' }).count(), 1, 'the toast does not vanish on click');
  assert.doesNotMatch(await page.locator('#mdlBody').innerText(), /In the real app/, 'no sample-only line on a real failure');
  await shot('c23-d1-panel', false, true);
  await page.click('#mdlFoot [data-dismiss]');
  // A done toast is not added to the bell's list by opening it.
  assert.equal(await page.locator('#mdl[open]').count(), 0);
  console.log('PASS D1');
});

test('D14: the terminal is never under a panel: floating above a full side panel, and docked in Dev Focus beside the editor view', { timeout: 90000 }, async (t) => {
  const { page, native, shot } = await launch(t);
  await page.click('#rDev');
  await page.keyboard.press('Control+Backquote');
  await page.locator('#dock:not([hidden])').waitFor({ timeout: 5000 });
  // Dev Focus docks the terminal only: the editor view is drawn above the page, so a floating terminal went behind it.
  assert.equal(await page.locator('#dock.float').count(), 0, 'docked in Dev Focus');
  assert.equal(await page.locator('#dFloat').isVisible(), false, 'no float button in Dev Focus');
  let dock, view;
  const deadline = Date.now() + 5000;
  do {
    await page.waitForTimeout(150);
    dock = await page.locator('#dock').boundingBox();
    view = (await native()).find((c) => c.url.startsWith('p9://dev'));
  } while ((!view?.visible || overlap(dock, view)) && Date.now() < deadline);
  assert.ok(view?.visible, 'the editor view shows');
  assert.ok(!overlap(dock, view), 'the editor view keeps clear of the docked terminal: ' + JSON.stringify({ dock, view }));
  await shot('c23-d14-dev', true);
  // Chat Focus with the side panel full: the floating terminal is on top of it.
  await page.click('#rChat');
  await page.evaluate(() => window.__side.open('artifact', { title: 'Editor', mode: 'full', render: (b) => { b.textContent = 'editor'; } }));
  await page.waitForFunction(() => document.querySelector('.stage')?.dataset.sideMode === 'full', null, { timeout: 5000 });
  if (await page.locator('#dock[hidden]').count()) await page.keyboard.press('Control+Backquote');
  if (!(await page.locator('#dock.float').count())) await page.click('#dFloat');
  const box = await page.locator('#dock').boundingBox();
  assert.equal(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('#dock'), [box.x + 20, box.y + box.height / 2]), true, 'the terminal is above the full side panel');
  await shot('c23-d14-chat-full');
  console.log('PASS D14');
});

test('D2: a dragged pet keeps its place beside the message box when a side panel moves the box', { timeout: 90000 }, async (t) => {
  const { page, shot } = await launch(t);
  const pane = page.locator('#chats .pane').first(), pet = pane.locator('canvas.pet'), box = pane.locator('.composer');
  await pet.waitFor({ timeout: 10000 });
  const from = async () => { const p = await pet.boundingBox(), b = await box.boundingBox(); return [p.x + p.width / 2 - b.x, p.y + p.height / 2 - b.y, b.x]; };
  // The pet may still be settling into its spot when the page first shows it: grab it again until the drag is saved.
  const saved = () => page.waitForFunction(() => Object.values(JSON.parse(localStorage.getItem('p9-pet-spots') || '{}')).some((spot) => Array.isArray(spot.box)), null, { timeout: 4000 }).then(() => true, () => false);
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(500);
    const p = await pet.boundingBox(), b = await box.boundingBox();
    await page.mouse.move(p.x + p.width / 2, p.y + p.height / 2); await page.mouse.down();
    await page.mouse.move(b.x + 60, b.y - 40, { steps: 5 }); await page.mouse.up();
    if (await saved()) break;
    assert.ok(i < 3, 'the drag is saved');
  }
  const before = await from();
  await page.evaluate(() => window.__side.open('artifact', { title: 'Editor', render: (b) => { b.textContent = 'editor'; } }));
  await page.waitForFunction(() => !!document.querySelector('.stage')?.dataset.side, null, { timeout: 5000 });
  await page.waitForTimeout(400);
  const after = await from();
  assert.notEqual(after[2], before[2], 'the side panel moved the message box');
  assert.ok(Math.abs(after[0] - before[0]) <= 2 && Math.abs(after[1] - before[1]) <= 2, 'the pet moved with the box: ' + JSON.stringify({ before, after }));
  await shot('c23-d2-pet-with-panel');
  console.log('PASS D2');
});

test('D11: a Dev Focus that could not start keeps one editor view while the layout moves (no new view to flash)', { timeout: 90000 }, async (t) => {
  const { app, page } = await launch(t);
  await page.click('#rDev');
  const view = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.map((c) => ({ id: c.webContents.id, url: c.webContents.getURL(), visible: c.getVisible() }))[0]); // the editor view is the first child (dev.test.mjs)
  let first; const deadline = Date.now() + 10000;
  while (!(first = await view())?.visible && Date.now() < deadline) await page.waitForTimeout(150);
  await page.waitForTimeout(800); // the failed start has finished
  first = await view();
  for (const width of [1300, 1200, 1350, 1400]) {
    await app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0].setContentSize(w, 900), width);
    await page.waitForTimeout(250);
  }
  const last = await view();
  assert.deepEqual([last.id, last.visible], [first.id, true], 'the same view, moved');
  // Coming back to Dev Focus still tries again (a new view).
  await page.click('#rChat'); await page.waitForTimeout(200); await page.click('#rDev');
  const again = Date.now() + 5000; let next;
  while ((!(next = await view()) || next.id === first.id) && Date.now() < again) await page.waitForTimeout(150);
  assert.notEqual(next.id, first.id, 'back in Dev Focus, it tries again');
  console.log('PASS D11');
});

test('D12: the brand mark is the P9 icon in every theme', { timeout: 90000 }, async (t) => {
  const { page, shot } = await launch(t);
  for (const theme of ['event-horizon-prime', 'daylight', 'redline', 'ascii']) {
    await page.click('#themeBtn'); await page.click('[data-theme-pick="' + theme + '"]');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
    const mark = await page.locator('#brandBtn svg.p9mark').evaluate((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height), el.querySelector('rect').getAttribute('fill'), el.querySelector('circle').getAttribute('stroke'), getComputedStyle(el).backgroundImage]; });
    assert.deepEqual(mark, [20, 20, '#080b10', '#6ee7f2', 'none'], theme);
    assert.equal(await page.locator('#brandBtn .mark').count(), 0, 'no old square');
    if (theme === 'event-horizon-prime' || theme === 'daylight') await shot('c23-d12-' + theme, false, true);
  }
  console.log('PASS D12');
});

test('D6: Settings is wide, its sections sit side by side, and a page selector shows one section at a time', { timeout: 90000 }, async (t) => {
  const { page, shot } = await launch(t);
  for (const theme of ['event-horizon-prime', 'daylight']) {
    await page.click('#themeBtn'); await page.click('[data-theme-pick="' + theme + '"]'); await page.keyboard.press('Escape');
    await page.click('#setBtn'); await page.locator('#setDlg[open] .set-pages').waitFor({ timeout: 10000 }); await page.waitForTimeout(400);
    assert.ok((await page.locator('#setDlg').boundingBox()).width > 1000, 'wider than the old 560px');
    const boxes = await page.locator('#setBody>.set-group').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y)]; }));
    assert.ok(new Set(boxes.map((b) => b[0])).size >= 2, 'sections in more than one column: ' + JSON.stringify(boxes));
    assert.match(await page.locator('#setBody>.set-group>legend').first().innerText(), /^General\b/);
    await shot('c23-d6-settings-' + theme);
    await page.keyboard.press('Escape'); await page.locator('#setDlg').waitFor({ state: 'hidden', timeout: 5000 });
  }
  await page.click('#setBtn'); await page.locator('#setDlg[open] .set-pages').waitFor({ timeout: 10000 });
  await page.click('[data-set-page="Focus modes"]');
  await page.locator('[data-set-page="Focus modes"][aria-pressed="true"]').waitFor({ timeout: 5000 });
  assert.equal(await page.locator('#setBody>.set-group:visible').count(), 1, 'one page shown');
  assert.match(await page.locator('#setBody>.set-group:visible legend').first().innerText(), /^Focus modes/);
  await page.locator('#setBody input[type=checkbox]:visible').first().click(); // a save re-renders: the page stays
  await page.waitForTimeout(400);
  assert.equal(await page.locator('[data-set-page="Focus modes"]').getAttribute('aria-pressed'), 'true', 'the page stays after a save');
  await shot('c23-d6-settings-page');
  await page.click('[data-set-page="All"]');
  assert.ok(await page.locator('#setBody>.set-group:visible').count() >= 5, 'All shows every section');
  console.log('PASS D6');
});

test('K11: the Mission page makes room for the cards; no card covers a Mission panel', { timeout: 90000 }, async (t) => {
  const { page, shot } = await launch(t);
  for (const theme of ['event-horizon-prime', 'daylight']) {
    await page.click('#themeBtn'); await page.click('[data-theme-pick="' + theme + '"]'); await page.keyboard.press('Escape');
    await page.click('#rMission'); await page.locator('#fMission [data-panel]').first().waitFor({ timeout: 10000 });
    await page.locator('#cards .card').first().waitFor({ timeout: 10000 }); await page.waitForTimeout(300);
    const cards = await page.locator('#cards .card').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()));
    const panels = await page.locator('#fMission [data-panel]').evaluateAll((els) => els.map((e) => ({ name: e.dataset.panel, ...e.getBoundingClientRect().toJSON() })));
    assert.ok(cards.length > 0 && panels.length > 0);
    for (const p of panels) for (const c of cards) assert.ok(!overlap(p, c), theme + ': a card covers the ' + p.name + ' panel');
    await shot('c23-k11-mission-' + theme);
  }
  console.log('PASS K11');
});
