import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));
test('Phase 4 round 1 shell regressions in actual Electron', { timeout: 60000 }, async t => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'p9-round1-'));
  const env = { ...process.env, P9_SAMPLE_DATA: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--user-data-dir=' + profile], env, chromiumSandbox: true });
  try {
    const page = await app.firstWindow();
    await page.locator('#cards .card').first().waitFor();
    const screenshot = async name => {
      if (!process.env.P9_SCREENSHOTS) return;
      await mkdir(process.env.P9_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.P9_SCREENSHOTS, name + '.png'), animations: 'disabled' });
    };
    const reset = async () => { await page.goto('p9://app/'); await page.locator('#cards .card').first().waitFor(); };
    await t.test('reviews resume survives an unrelated explorer modal', async () => {
      await reset();
      const reviews = page.locator('#cards [data-key^="reviews:"] .open');
      await reviews.click(); await page.locator('#mdlBody .mlist button').first().click();
      const title = await page.locator('#mdlT').innerText();
      await page.click('#mdlX'); await page.click('#rFiles'); await page.click('#tree [data-file="plan.md"]');
      await page.click('#mdlX'); await reviews.click();
      assert.equal(await page.locator('#mdlT').innerText(), title);
      assert.equal(await page.locator('#mdlBody [data-answer]').count(), 1);
      await screenshot('round1-review-resume');
    });
    await t.test('streaming in Dev preserves the Chat draft selection without taking focus', async () => {
      await reset(); await page.clock.install();
      await page.click('#chats [data-approve="allow_once"]');
      const ta = page.locator('#chats textarea');
      await ta.fill('preserve this draft selection'); await ta.evaluate(el => el.setSelectionRange(3, 12));
      await page.clock.runFor(550);
      await page.click('#rDev'); await page.click('#devTree [data-file="plan.md"]'); await page.locator('#devEd').focus();
      await page.clock.runFor(100);
      assert.equal(await page.locator('#devEd').evaluate(el => document.activeElement === el), true);
      await page.click('#rChat');
      assert.deepEqual(await ta.evaluate(el => [el.value, el.selectionStart, el.selectionEnd]), ['preserve this draft selection', 3, 12]);
    });
    await t.test('Mission shows the Waiting on you list on the page, scrolling on its own, an item opens to answer', async () => {
      await reset(); await page.click('#rMission');
      const list = page.locator('#fMission .needs [data-list]'), items = list.locator('li button');
      await items.first().waitFor();
      assert.equal(await page.locator('#fMission .needs [data-n]').innerText(), String(await items.count()));
      assert.equal(await list.evaluate(l => getComputedStyle(l).overflowY), 'auto');
      assert.equal(await page.locator('#fMission [data-win="mqueue"]').count(), 0, 'no second Waiting on you card');
      await screenshot('mission-needs');
      await items.first().click();
      assert.equal(await page.locator('#mdl[open] #mdlBody [data-answer]').count(), 1);
      await page.click('#mdlX');
    });
    await t.test('Hide steps hides tool calls and thinking in every chat and stays after a reload', async () => {
      await reset();
      const shown = () => page.locator('#chats .hist :is(details.tool, details.thought)').evaluateAll(d => d.filter(x => x.checkVisibility()).length);
      const before = await shown(); assert.ok(before > 0, 'sample chat has steps');
      await page.locator('#chats [data-steps]').first().click();
      assert.equal(await shown(), 0);
      assert.equal(await page.locator('#chats [data-steps]').first().innerText(), 'Show steps');
      await reset(); assert.equal(await shown(), 0, 'kept after a reload');
      await page.locator('#chats [data-steps]').first().click();
      assert.equal(await shown(), before);
    });
    await t.test('answering or declining an agent notification closes its dialog and updates the card', async () => {
      for (const action of ['submit', 'decline', 'approve', 'deny']) {
        await reset(); await page.click('#rMission'); // K11: the cards show (and have room) outside Dev Focus
        const card = page.locator('#cards [data-key^="asks:"]');
        assert.equal(await card.locator('.n').innerText(), '2');
        await card.locator('.open').click();
        const approval = action === 'approve' || action === 'deny';
        await page.locator('#mdlBody .mlist button', { hasText: approval ? 'Refactor provider lease' : 'Pick a colour' }).click();
        await page.click(action === 'submit' ? '#mdlBody [type="submit"]' : action === 'decline' ? '#mdlBody [data-decline]' : action === 'deny' ? '#mdlBody [data-approve="reject"]' : '#mdlBody [data-approve="allow_once"]');
        assert.equal(await page.locator('#mdl').evaluate(el => el.open), false, action + ' closes the answered notification');
        assert.equal(await card.locator('.n').innerText(), '1');
        if (action === 'submit') await screenshot('round1-answer-closed');
        await card.locator('.open').click();
        await page.click(approval ? '#mdlBody [type="submit"]' : '#mdlBody [data-approve="allow_once"]');
        assert.equal(await page.locator('#mdl').evaluate(el => el.open), false);
        assert.equal(await card.count(), 0, 'no attention card remains after the last answer');
      }
    });
    await t.test('fixture label and filename markup stay literal text and preserve attribute values', async () => {
      const payload = '</span><style data-p9-injected>body{color:red}</style><span>\'"';
      // The sample data comes from main now (GitHub issue #4), so the markup goes in through main's p9:sample answer.
      const original = await page.evaluate(() => JSON.stringify(window.p9.sample));
      assert.ok(original.includes('"Colour"') && original.includes('"plan.md"'));
      const injected = JSON.parse(original.replaceAll('"Colour"', JSON.stringify(payload)).replaceAll('"plan.md"', JSON.stringify(payload + '.md')));
      const answer = (sample) => app.evaluate(({ ipcMain }, s) => { ipcMain.removeAllListeners('p9:sample'); ipcMain.on('p9:sample', e => { e.returnValue = s; }); }, sample);
      await answer(injected);
      try {
        await reset(); await page.click('#rFiles');
        assert.equal(await page.locator('[data-p9-injected]').count(), 0);
        const file = page.locator('#tree [data-file]').filter({ hasText: payload + '.md' });
        assert.equal(await file.getAttribute('data-file'), payload + '.md');
        await screenshot('round1-literal-filename');
        await page.locator('#cards [data-key^="asks:"] .open').click();
        await page.locator('#mdlBody .mlist button', { hasText: 'Pick a colour' }).click();
        assert.ok((await page.locator('#mdlBody [data-question]').innerText()).includes(payload));
        assert.equal(await page.locator('[data-p9-injected]').count(), 0);
        await screenshot('round1-literal-label');
      } finally { await answer(JSON.parse(original)); }
    });
    // Look fixes (rc.2): panels readable over the backdrop, usage rings, the docked terminal back to full width.
    // The dev space keeps no files: the picture goes out in the log as "P9_SHOT <name> <base64>" (not on GitHub).
    const look = async name => { if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + (await page.screenshot({ animations: 'disabled' })).toString('base64')); };
    const alpha = el => el.evaluate(e => { const m = /\/ ([\d.]+)\)/.exec(getComputedStyle(e).backgroundColor); return m ? Number(m[1]) : 1; });
    await t.test('dropdown panels and cards are mostly solid so the text reads', async () => {
      await reset();
      await page.click('#setBtn'); await page.locator('#setDlg[open]').waitFor(); await page.waitForTimeout(400);
      assert.ok(await alpha(page.locator('#setDlg')) >= 0.9, 'Settings background');
      await look('look-settings');
      await page.keyboard.press('Escape');
      await page.click('#newBtn'); await page.locator('#newPop:not([hidden])').waitFor(); await page.waitForTimeout(300);
      assert.ok(await alpha(page.locator('#newPop')) >= 0.9, 'new chat picker background');
      await look('look-new-chat');
      await page.keyboard.press('Escape');
      assert.ok(await alpha(page.locator('#cards .card').first()) >= 0.9, 'card background');
    });
    await t.test('Usage shows one ring per meter on the Mission page and in its dialog, amber from 75%', async () => {
      await app.evaluate(({ ipcMain }, now) => {
        ipcMain.removeHandler('p9:usage');
        ipcMain.handle('p9:usage', () => ({ status: 200, body: { state: 'ok', samples: 3, discarded: 0, totals: { inputTokens: 100, outputTokens: 50, costUsd: 0.5 }, limits: {
          claude: { fiveHour: { usedPercent: 80, resetsAt: now + 3600000 }, sevenDay: { usedPercent: 30, resetsAt: now + 86400000 }, asOf: now },
          codex: { fiveHour: { usedPercent: 6, resetsAt: now + 3600000 }, sevenDay: { usedPercent: 52, resetsAt: now + 86400000 }, asOf: now } } } }));
      }, Date.now());
      await reset(); await page.click('#rMission');
      const rings = page.locator('#fMission [data-panel="musage"] .ring');
      await rings.first().waitFor();
      assert.deepEqual(await rings.locator('b').allInnerTexts(), ['80%', '30%', '6%', '52%']);
      assert.deepEqual(await rings.evaluateAll(r => r.map(x => x.hasAttribute('data-hot'))), [true, false, false, false]);
      assert.equal(await rings.first().evaluate(e => getComputedStyle(e, '::before').backgroundImage.includes('conic-gradient')), true);
      await look('look-usage-card');
      await page.click('#fMission [data-win="musage"]'); await page.locator('#mdl[open] #musage .ring').first().waitFor();
      assert.equal(await page.locator('#mdl #musage .ring').count(), 4);
      await page.waitForTimeout(400); await look('look-usage-dialog');
      await page.click('#mdlX');
    });
    await t.test('docking the terminal clears the width a popout resize left behind', async () => {
      await reset(); await page.click('#rTerm');
      const dock = page.locator('#dock'); await dock.waitFor();
      const stage = await page.locator('#dock').evaluate(e => e.parentElement.getBoundingClientRect().width);
      if (!(await dock.evaluate(e => e.classList.contains('float')))) await page.click('#dFloat');
      await dock.evaluate(e => { e.style.width = '420px'; e.style.height = '240px'; }); // what CSS resize: both writes
      await look('look-terminal-popout');
      await page.click('#dFloat');
      assert.equal(await dock.evaluate(e => e.style.width), '');
      assert.ok(await dock.evaluate(e => e.getBoundingClientRect().width) >= stage - 2, 'docked panel spans the page');
      await look('look-terminal-docked');
    });
  } finally { await app.close(); await rm(profile, { recursive: true, force: true }); }
});
