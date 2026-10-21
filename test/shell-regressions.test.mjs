import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, readdir } from 'node:fs/promises';
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
        await reset(); await page.click('#rDev');
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
      const assets = path.join(root, 'apps/web/dist/_astro');
      const shell = (await readdir(assets)).find(name => name.startsWith('Shell.') && name.endsWith('.js'));
      const original = await readFile(path.join(assets, shell), 'utf8');
      assert.match(original, /["'`]Colour["'`]/); assert.match(original, /["'`]plan\.md["'`]/);
      const injected = original.replace(/["'`]Colour["'`]/g, JSON.stringify(payload)).replace(/["'`]plan\.md["'`]/g, JSON.stringify(payload + '.md'));
      await page.route('**/' + shell, route => route.fulfill({ body: injected, contentType: 'text/javascript' }));
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
      } finally { await page.unroute('**/' + shell); }
    });
  } finally { await app.close(); await rm(profile, { recursive: true, force: true }); }
});
