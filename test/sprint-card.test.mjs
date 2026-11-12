// P9-Sprint E1/I2/F3: the sprint row of the chat card. Real Electron with the sample data; workers are added through the test door
// (window.__sprint), carrying the contract's fields (task, ready, verdict, idleSince, parent, state).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));
const MIN = 60000;
const worker = (id, title, over = {}) => ({ id, agent: 'claude', title, parent: 's-claude-2', state: 'running', pending: null, live: false, model: 'Opus 5.5', mode: 'Manual', effort: 'Medium', queue: [], limits: { h5: 0, d7: 0 }, context: null, cacheMin: null, cwd: '~', events: [{ t: 'agent', text: 'On it.' }], ...over });

test('Sprint card: a chat with workers shows one row per worker with its item, status, age and ring; open requests are listed with how long they waited', { timeout: 120000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'p9-card-sprint-row-'));
  const env = { ...process.env, P9_SAMPLE_DATA: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--user-data-dir=' + profile], env, timeout: 15000 });
  t.after(() => app.close());
  const page = await app.firstWindow({ timeout: 15000 });
  page.on('pageerror', e => console.log('PAGEERROR ' + e.message)); page.on('console', m => m.type() === 'error' && console.log('CONSOLE ' + m.text()));
  await page.locator('#cards .card').first().waitFor({ timeout: 15000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 900));
  const shot = async (name) => { await page.waitForTimeout(500); const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64')); if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png); };
  await page.addStyleTag({ content: '#toasts{display:none!important}' }); // the sample notifications' toasts sit in the same corner; this test is about the card
  const now = Date.now();
  const lead = 's-claude-2';
  await page.evaluate(id => { const s = document.querySelector('#navList .row[data-chat="' + id + '"]'); s?.click(); }, lead);

  // A chat with no worker has no card.
  assert.equal(await page.locator('.sprint').count(), 0, 'a card on a chat with no workers');

  const ask = (kind, title, at) => ({ pending: kind, events: [{ t: kind, title, at, options: [['ok', 'Allow', 'allow_once']], diff: [], fields: [] }] });
  const ws = [
    worker('w-work', 'Claude builder', { task: { item: 'A1 login form', doneMeans: 'x', checks: [] } }),
    worker('w-idle', 'Codex tests', { agent: 'codex', task: { item: 'A2 test the form' }, idleSince: now - 12 * MIN }),
    worker('w-asked', 'Claude schema', { task: { item: 'B1 schema' }, ...ask('question', 'Keep the old column?', now - 5 * MIN) }),
    worker('w-ready', 'Codex api', { task: { item: 'B2 api' }, ready: { commit: 'aaa111', claimed: false, results: [], files: [], at: now - 3 * MIN } }),
    worker('w-passed', 'Claude docs', { task: { item: 'C1 docs' }, ready: { commit: 'bbb222', at: now - 30 * MIN }, verdict: { by: 'rev', commit: 'bbb222', result: 'pass', note: '', at: now - 20 * MIN } }),
    worker('w-fix', 'Claude cli', { task: { item: 'C2 cli' }, ready: { commit: 'ccc333', at: now - 30 * MIN }, verdict: { by: 'rev', commit: 'ccc333', result: 'fix', note: 'x', at: now - 10 * MIN } }),
    worker('w-stale', 'Claude lint', { task: { item: 'D1 lint' }, ready: { commit: 'ddd444', at: now - 9 * MIN }, verdict: { by: 'rev', commit: 'old000', result: 'pass', note: '', at: now - 40 * MIN } }),
    worker('w-stop', 'Codex perf', { state: 'stopped', task: { item: 'E1 perf' } }),
    worker('w-appr', 'Claude infra', { task: { item: 'F1 infra' }, ...ask('approval', 'Edit deploy.yml', now - 9 * MIN) }),
  ];
  await page.evaluate(w => window.__sprint.add(...w), ws);
  await page.locator('.sprint').waitFor({ timeout: 5000 });
  // Opened here: it folds by default only in a narrow window.
  if (await page.locator('.sprint[data-folded="true"]').count()) await page.click('[data-sprint-fold]');
  const rows = await page.evaluate(() => [...document.querySelectorAll('.sprint .sp-row')].map(r => [r.dataset.sprintOpen, r.dataset.status, r.querySelector('.sp-item').textContent, r.querySelector('.sp-st time')?.textContent ?? '']));
  assert.deepEqual(rows.map(r => r.slice(0, 3).join('|')), [
    'w-work|working|A1 login form', 'w-idle|idle|A2 test the form', 'w-asked|asked|B1 schema', 'w-ready|ready|B2 api', 'w-passed|passed|C1 docs',
    'w-fix|fix|C2 cli', 'w-stale|ready|D1 lint', 'w-stop|stopped|E1 perf', 'w-appr|asked|F1 infra']);
  assert.equal(rows[1][3], '12 min', 'idle age');
  assert.equal(rows[3][3], '3 min', 'ready age');
  // F3: the workers' open requests, oldest first, each with its wait.
  const asks = await page.evaluate(() => [...document.querySelectorAll('.sprint .sp-asks button')].map(b => [b.dataset.sprintAsk, b.querySelector('.sp-akind').textContent, b.querySelector('.sp-wait time').textContent]));
  assert.deepEqual(asks, [['w-appr', 'Approval', '9 min'], ['w-asked', 'Question', '5 min']]);
  assert.match(await page.locator('.sprint .sp-sum').innerText(), /9 workers · 2 need you · 2 ready/);
  await shot('sprint-card-all-statuses');

  // Fold to a strip and back; a row opens that worker's chat.
  await page.click('[data-sprint-fold]');
  assert.equal(await page.locator('.sprint .sp-rows').isVisible(), false);
  await shot('sprint-card-folded');
  await page.click('[data-sprint-fold]');
  await page.locator('[data-sprint-open="w-idle"]').click();
  await page.locator('.pane[data-id="w-idle"]').waitFor({ timeout: 5000 });

  // A long list scrolls inside the card; the card keeps its place. Two more looks.
  await page.locator('#navList .row[data-chat="' + lead + '"]').click();
  await page.evaluate(() => window.__sprint.add(...Array.from({ length: 6 }, (_, i) => ({ id: 'w-x' + i, agent: 'codex', title: 'Codex extra ' + i, parent: 's-claude-2', state: 'running', pending: null, live: false, model: 'Opus 5.5', mode: 'Manual', effort: 'Medium', queue: [], limits: { h5: 0, d7: 0 }, context: null, cacheMin: null, cwd: '~', events: [], task: { item: 'X' + i + ' extra item' } }))));
  assert.equal(await page.locator('.sprint .sp-row').count(), 15);
  const r = await page.locator('.sprint').boundingBox(); assert.ok(r.y + r.height <= 900, 'the long card runs off the window');
  await shot('sprint-card-15-workers');
  for (const look of ['redline', 'duskwood']) {
    await page.click('#themeBtn'); await page.click('[data-theme-pick="' + look + '"]'); await page.keyboard.press('Escape');
    await shot('sprint-card-' + look);
  }

  // Narrow window: the card is there, within the window, and folded until opened.
  await page.locator('#navList .row[data-chat="' + lead + '"]').click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(520, 800));
  await page.waitForTimeout(400);
  const box = await page.locator('.sprint').boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 520, 'the card is outside the narrow window: ' + JSON.stringify(box));
  await shot('sprint-card-narrow');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 900));
});
