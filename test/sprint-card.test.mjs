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

const launch = async (t, sample) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'p9-card-sprint-row-'));
  const env = { ...process.env, P9_SAMPLE_DATA: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--user-data-dir=' + profile], env, timeout: 15000 });
  t.after(() => app.close());
  const page = await app.firstWindow({ timeout: 15000 });
  page.on('pageerror', e => console.log('PAGEERROR ' + e.message));
  await page.locator('#cards .card').first().waitFor({ timeout: 15000 });
  return { app, page };
};
const shotAt = async (page, app, name) => { await page.waitForTimeout(500); const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64')); if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png); };
const sizeTo = async (app, w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [w, h]);
// Where the first card sits against its pane and the needs-you cards, as the page lays it out.
const geometry = (page) => page.evaluate(() => {
  const hit = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  const cards = [...document.querySelectorAll('#cards .card')].map(c => c.getBoundingClientRect());
  return { width: innerWidth, sprints: [...document.querySelectorAll('#chats .sprint')].map(sp => { const b = sp.getBoundingClientRect(), p = sp.closest('.pane').getBoundingClientRect();
    return { id: sp.closest('.pane').dataset.id, folded: sp.dataset.folded, right: getComputedStyle(sp).right, inside: b.left >= p.left && b.right <= p.right && b.top >= p.top && b.bottom <= p.bottom, apart: !cards.some(c => hit(b, c)), cardsOverPane: cards.some(c => hit(p, c)) }; }) };
});

test('Sprint card: a chat with workers shows one row per worker with its item, status, age and ring; open requests are listed with how long they waited', { timeout: 120000 }, async (t) => {
  const { app, page } = await launch(t);
  await sizeTo(app, 1400, 900);
  const shot = (name) => shotAt(page, app, name);
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
  assert.equal(await page.locator('.sprint').getAttribute('data-folded'), 'true', 'the card covers the centered column at this width');
  // The narrowest window P9 allows (720 px): a chat nobody has opened the card on starts folded, the question form stays usable, and
  // opening the card keeps it inside the pane and apart from the needs-you cards.
  await sizeTo(app, 720, 800); await page.waitForTimeout(500);
  let g = await geometry(page);
  assert.equal(g.width, 720, 'the window is not the narrow size');
  assert.deepEqual(g.sprints.map(x => [x.id, x.folded, x.inside, x.apart]), [[lead, 'true', true, true]], 'fresh chat, narrow: folded, inside its pane, apart from the cards');
  const submit = page.locator('.pane[data-id="' + lead + '"] button:has-text("Submit answer")');
  await submit.waitFor({ timeout: 5000 });
  assert.equal(await submit.evaluate(b => { const r = b.getBoundingClientRect(); return b.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), true, 'the form button is covered');
  await shot('sprint-card-narrow-folded');
  await page.click('[data-sprint-fold]');
  g = await geometry(page);
  assert.deepEqual(g.sprints.map(x => [x.folded, x.inside, x.apart]), [['false', true, true]], 'opened at 720 px: inside the pane, apart from the cards');
  await shot('sprint-card-narrow-open');
  await sizeTo(app, 1400, 900); await page.waitForTimeout(500);
  // Opened here: it folds by default only in a narrow window.
  if (await page.locator('.sprint[data-folded="true"]').count()) await page.click('[data-sprint-fold]');
  const colLeft = () => page.locator('.pane .hist .col').first().evaluate(e => e.getBoundingClientRect().left);
  const openedLeft = await colLeft();
  const centres = await page.locator('.pane').first().evaluate(p => { const mid = e => { const r = e.getBoundingClientRect(); return r.left + r.width / 2; }; return [mid(p.querySelector('.hist .col')), mid(p.querySelector('.composer'))]; });
  assert.ok(Math.abs(centres[0] - centres[1]) < 1, 'chat and composer are not aligned');
  await page.click('[data-sprint-fold]');
  const foldedLeft = await colLeft();
  assert.ok(Math.abs(openedLeft - foldedLeft) < 1, `chat moved from ${foldedLeft} to ${openedLeft}`);
  await page.click('[data-sprint-fold]');
  const withCards = await colLeft();
  await page.locator('#cards').evaluate(e => { e.style.visibility = 'hidden'; });
  await page.waitForTimeout(200);
  assert.ok(Math.abs((await colLeft()) - withCards) < 1, 'notification cards moved the chat');
  await page.locator('#cards').evaluate(e => { e.style.visibility = ''; });
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
  // Split: two leads, each with workers; each card sits in its own pane, and only a pane the cards overlap makes room for them.
  await page.click('#chats .pane [data-tool="split"]');
  await page.waitForFunction(() => document.querySelectorAll('#chats .pane').length === 2, null, { timeout: 5000 });
  const two = await page.evaluate(() => [...document.querySelectorAll('#chats .pane')].map(p => p.dataset.id));
  await page.evaluate(([a, b]) => window.__sprint.add(...[a, b].flatMap((id, i) => [1, 2].map(n => ({ id: 'sp' + i + n, agent: 'claude', title: 'Split worker ' + i + n, parent: id, state: 'running', pending: null, live: false, model: 'Opus 5.5', mode: 'Manual', effort: 'Medium', queue: [], limits: { h5: 0, d7: 0 }, context: null, cacheMin: null, cwd: '~', events: [], task: { item: 'S' + i + n + ' split item' } })))), two);
  await page.waitForFunction(() => document.querySelectorAll('#chats .sprint').length === 2, null, { timeout: 5000 });
  g = await geometry(page);
  assert.deepEqual(g.sprints.map(x => [x.inside, x.apart]), [[true, true], [true, true]], 'Split: each card inside its own pane and apart from the cards');
  assert.equal(g.sprints.find(x => !x.cardsOverPane)?.right ?? '18px', '18px', 'a pane the cards do not overlap keeps the card at its own edge');
  await shot('sprint-card-split');
  await page.locator('#chats .sprint [data-sprint-fold]').last().click();
  g = await geometry(page);
  assert.deepEqual(g.sprints.map(x => [x.inside, x.apart]), [[true, true], [true, true]], 'Split, opened in the narrow pane: still inside it and apart from the cards');
  await shot('sprint-card-split-open');
  // The narrowest Split (721 px: two panes of about 335 px, the cards stack over the right one): both cards start folded, and opened they
  // stay inside their pane and apart from the cards, the right one moving below the stack where there is no room beside it.
  await sizeTo(app, 721, 800); await page.waitForTimeout(500);
  g = await geometry(page);
  assert.equal(g.width, 721, 'the window is not the narrowest Split size');
  assert.equal(await page.locator('#chats .pane').count(), 2, 'not a Split at 721 px');
  assert.ok(g.sprints.some(x => x.cardsOverPane), 'the cards do not reach a pane here');
  const setFold = async (want) => { for (const sp of await page.locator('#chats .sprint').all()) if (await sp.getAttribute('data-folded') !== want) await sp.locator('[data-sprint-fold]').click(); };
  await setFold('true'); g = await geometry(page);
  assert.deepEqual(g.sprints.map(x => [x.folded, x.inside, x.apart]), [['true', true, true], ['true', true, true]], '721 px Split, folded: inside the panes and apart from the cards');
  await shot('sprint-card-split-721-folded');
  await setFold('false'); g = await geometry(page);
  assert.deepEqual(g.sprints.map(x => [x.folded, x.inside, x.apart]), [['false', true, true], ['false', true, true]], '721 px Split, opened: inside the panes and apart from the cards');
  await shot('sprint-card-split-721-open');
  await sizeTo(app, 1400, 900); await page.waitForTimeout(500);
  await page.click('#chats .pane [data-tool="split"]');
  await page.locator('#navList .row[data-chat="' + lead + '"]').click();
  for (const look of ['redline', 'duskwood']) {
    await page.click('#themeBtn'); await page.click('[data-theme-pick="' + look + '"]'); await page.keyboard.press('Escape');
    await shot('sprint-card-' + look);
  }

});

// The fields arrive the way they do live: the daemon's list and its events, nothing patched into the page. A stand-in daemon answers the
// page's chat calls (list, events, profiles) and the test changes what it reports.
test('Sprint card: a new worker, its ready, its verdict and its next turn reach the card from the daemon with nothing patched in; a field the list drops is cleared', { timeout: 120000 }, async (t) => {
  const { app, page } = await launch(t);
  await sizeTo(app, 1400, 900);
  await app.evaluate(({ ipcMain }) => {
    const f = globalThis.__fake = { convs: [], events: [], cursor: 0 };
    ipcMain.removeHandler('p9:chat');
    ipcMain.handle('p9:chat', async (_e, action, payload = {}) => {
      if (action === 'list') return { status: 200, body: { conversations: f.convs.map(c => ({ ...c })), lists: {} } };
      if (action === 'profiles') return { status: 200, body: { profiles: [] } };
      if (action === 'events') {
        const after = Number(payload.after) || 0, take = () => f.events.filter(e => e.cursor > after);
        for (let i = 0; i < 30 && payload.wait && !take().length; i++) await new Promise(r => setTimeout(r, 100));
        return { status: 200, body: { events: take(), cursor: f.cursor, more: false } };
      }
      return { status: 404, body: {} };
    });
  });
  const send = (convs, events) => app.evaluate((_, [convs, events]) => { const f = globalThis.__fake; f.convs = convs; for (const e of events) f.events.push({ ...e, at: Date.now(), cursor: ++f.cursor }); }, [convs, events]);
  const now = Date.now(), MIN = 60000;
  const conv = (id, over = {}) => ({ id, provider: 'claude', title: id, folder: '~', created: now - 1000, state: 'running', sent: 0, used: now, project: null, archived: false, parent: null, ...over });
  const lead = conv('lead-1');
  await send([lead], [{ type: 'created', conversation: 'lead-1', data: { provider: 'claude', title: 'Lead', folder: '~' } }, { type: 'connected', conversation: 'lead-1', data: { session: 's1' } }]);
  await page.reload();
  await page.locator('.pane[data-id="lead-1"]').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('.sprint').count(), 0, 'a card on a lead with no workers');
  const row = (id) => page.locator('.sprint [data-sprint-open="' + id + '"]');
  const status = async (id) => (await row(id).count()) ? row(id).getAttribute('data-status') : null;
  const is = async (id, want, why) => { await assert.doesNotReject(async () => { for (let i = 0; i < 60; i++) { if (await status(id) === want) return; await page.waitForTimeout(100); } throw new Error(why + ': wanted ' + want + ', the card has ' + await status(id)); }); };

  // A worker the lead starts: its row, with the item from the list, appears and works.
  const w = (over = {}) => conv('w-1', { parent: 'lead-1', title: 'Builder', task: { item: 'A1 login form', doneMeans: 'x', checks: [] }, ...over });
  await send([lead, w()], [{ type: 'created', conversation: 'w-1', data: { provider: 'claude', title: 'Builder', folder: '~', parent: 'lead-1' } }, { type: 'connected', conversation: 'w-1', data: { session: 's2' } }]);
  await is('w-1', 'working', 'a new worker');
  assert.equal(await row('w-1').locator('.sp-item').textContent(), 'A1 login form');
  // Ready.
  await send([lead, w({ ready: { commit: 'c1', claimed: false, results: [], files: [], at: Date.now() } })], [{ type: 'turn-end', conversation: 'w-1', data: { stopReason: 'end_turn' } }]);
  await is('w-1', 'ready', 'ready reported');
  // A verdict for that commit passes it; one for another commit does not; one with no commit does not.
  await send([lead, w({ ready: { commit: 'c1', at: Date.now() }, verdict: { by: 'rev', commit: 'c1', result: 'pass', note: '', at: Date.now() } })], [{ type: 'note', conversation: 'lead-1', data: { text: 'verdict' } }]);
  await is('w-1', 'passed', 'a verdict for the ready commit');
  await shotAt(page, app, 'sprint-card-live-passed');
  await send([lead, w({ ready: { commit: 'c2', at: Date.now() }, verdict: { by: 'rev', commit: 'c1', result: 'pass', note: '', at: Date.now() } })], [{ type: 'note', conversation: 'lead-1', data: { text: 'newer commit' } }]);
  await is('w-1', 'ready', 'a verdict for an older commit');
  await send([lead, w({ ready: { commit: 'c2', at: Date.now() }, verdict: { by: 'rev', result: 'pass', note: '', at: Date.now() } })], [{ type: 'note', conversation: 'lead-1', data: { text: 'no commit' } }]);
  await is('w-1', 'ready', 'a verdict with no commit');
  await send([lead, w({ verdict: { by: 'rev', commit: 'c2', result: 'pass', note: '', at: Date.now() } })], [{ type: 'note', conversation: 'lead-1', data: { text: 'no ready' } }]);
  await is('w-1', 'working', 'a verdict with no ready commit');
  // A new turn: the list no longer has ready or verdict, and the card drops them.
  await send([lead, w()], [{ type: 'user', conversation: 'w-1', data: { text: 'fix the label' } }]);
  await is('w-1', 'working', 'a new turn clears ready and verdict');
  // Idle with an age, then working again once the field is gone.
  await send([lead, w({ idleSince: Date.now() - 12 * MIN })], [{ type: 'note', conversation: 'lead-1', data: { text: 'idle' } }]);
  await is('w-1', 'idle', 'idleSince');
  assert.equal(await row('w-1').locator('.sp-st time').textContent(), '12 min');
  await send([lead, w()], [{ type: 'note', conversation: 'lead-1', data: { text: 'busy' } }]);
  await is('w-1', 'working', 'idleSince dropped');
});

test('Sprint files button explains when the lead has no project', { timeout: 60000 }, async (t) => {
  const { page } = await launch(t);
  await page.locator('#navList .row[data-chat="s-claude-2"]').click();
  await page.evaluate(w => window.__sprint.add(w), worker('w-files', 'Files worker'));
  const button = page.locator('.sprint [data-sprint-files]');
  await button.waitFor({ timeout: 5000 });
  assert.equal(await button.isDisabled(), true);
  assert.match(await button.getAttribute('title'), /project/i);
});

test('Sprint files button opens the lead section in its project', { timeout: 60000 }, async (t) => {
  const { app, page } = await launch(t);
  await app.evaluate(({ ipcMain }) => {
    const now = Date.now();
    const conv = (id, extra = {}) => ({ id, provider: 'claude', title: id, folder: '~', created: now, state: 'running', sent: 1, used: now, project: 'project1', archived: false, parent: null, ...extra });
    const project = { id: 'project1', name: 'Project', work: { kind: 'p9', folder: '' }, files: [], sprints: [{ lead: 'lead1', title: 'Lead', files: [{ name: 'sprint.md', text: 'Plan', size: 4 }] }] };
    ipcMain.removeHandler('p9:chat');
    ipcMain.handle('p9:chat', async (_e, action) => {
      if (action === 'list') return { status: 200, body: { conversations: [conv('lead1'), conv('worker1', { parent: 'lead1' })], lists: {} } };
      if (action === 'projects') return { status: 200, body: { projects: [project] } };
      if (action === 'project') return { status: 200, body: { project } };
      if (action === 'events') { await new Promise(resolve => setTimeout(resolve, 100)); return { status: 200, body: { events: [], cursor: 0, more: false } }; }
      if (action === 'profiles') return { status: 200, body: { profiles: [] } };
      return { status: 404, body: {} };
    });
  });
  await page.reload();
  await page.locator('#navList [data-chat="lead1"]').click({ timeout: 15000 });
  await page.locator('.sprint [data-sprint-files]').click({ timeout: 5000 });
  const section = page.locator('#projPage [data-sprint="lead1"]');
  await section.waitFor({ timeout: 10000 });
  assert.equal(await section.locator('[data-pj="spfile"]').first().innerText(), 'sprint.md');
  assert.equal(await section.evaluate(e => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight; }), true);
});
