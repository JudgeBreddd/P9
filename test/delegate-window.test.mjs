// A7 Delegate in the window. Real Electron, the real daemon, the fake agent, and the MCP client its agent is handed.
// Worker chats sit indented under the chat that started them (folded past three); a worker's open approval or
// question is drawn in its parent's chat and answers the worker; Settings > Delegation saves to the daemon.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { Client } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { daemon, restart, http, authenticated, root } from './helpers.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-p9-op': randomUUID() }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => ({ status: r.status, ...JSON.parse(r.text) }));
const until = async (check, what, ms = 20000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 200))) if (await check()) return;
  assert.fail('timed out: ' + what);
};
const events = async (instance, id) => (await call(instance, '/chat/events?after=0&only=' + id)).events;

async function launch(t, instance) {
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-delegate-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1400, height: 900 }).catch(() => {});
  await page.locator('#dataNote', { hasText: 'Chat live' }).waitFor({ timeout: 20000 });
  return { app, page, errors };
}
// The MCP client of a chat that was sent 'mcp'.
async function tools(t, instance, conversation) {
  let entry;
  await until(async () => { const hit = (await events(instance, conversation)).find((e) => e.data?.content?.text?.startsWith('mcp:')); if (hit) [entry] = JSON.parse(hit.data.content.text.slice(4)); return !!hit; }, 'the MCP entry');
  const client = new Client({ name: 'p9-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env: Object.fromEntries(entry.env.map(({ name, value }) => [name, value])) }));
  t.after(() => client.close());
  const tool = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  const done = async (chat) => { for (;;) { const got = await tool('wait_chat', { chat }); if (!got.timedOut) return got; } };
  return { tool, done };
}
// The chat list as drawn: one entry per row, 'depth:title' for a chat and 'fold:text:expanded' for the fold row.
const listed = (page) => page.evaluate(() => [...document.querySelectorAll('#navList .rowwrap, #navList .row.subs')].filter((el) => el.offsetParent).map((el) => el.matches('.subs')
  ? 'fold:' + el.textContent.trim() + ':' + el.getAttribute('aria-expanded') : (el.dataset.depth || '0') + ':' + (el.querySelector('.row[data-chat]')?.dataset.chat ?? '?')));
const shot = async (page, name) => { if (!process.env.GITHUB_ACTIONS) { await page.waitForTimeout(400); console.log('P9_SHOT ' + name + ' ' + (await page.screenshot()).toString('base64')); } };

test('Delegate window: workers indented under their chat and folded past three; a worker\'s approval and question answered from the parent chat; Settings > Delegation saves', { timeout: 300000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  assert.equal((await call(instance, '/delegation', 'POST', { start: 'agent', max: 20, workers: [] })).status, 200);
  await call(instance, '/file-protection', 'POST', { on: false });
  const { profile } = await call(instance, '/profiles', 'POST', { name: 'Far Cloud', baseUrl: 'https://models.example.test/api/', models: ['glm-5.3', 'kimi-k3:cloud'], key: 'sk-profile-test-0f3a9c71d2e84b56' });
  const parent = (await call(instance, '/chat', 'POST', { provider: 'claude', title: 'Build the site' })).conversation;
  await call(instance, '/chat/' + parent + '/prompt', 'POST', { text: 'mcp' });
  const a = await tools(t, instance, parent);
  const kids = [];
  for (const n of [1, 2, 3]) { const made = await a.tool('open_chat', { text: 'hello', title: 'Kid ' + n }); assert.match(made.chat ?? '', /^[0-9a-f-]{36}$/, JSON.stringify(made)); await a.done(made.chat); kids.push(made.chat); }
  const other = (await call(instance, '/chat', 'POST', { provider: 'claude', title: 'On its own' })).conversation;

  const { page, errors } = await launch(t, instance);
  const row = (id) => page.locator(`#navList .row[data-chat="${id}"]`);
  await row(parent).waitFor();
  // No worker on screen, in either pane (one on screen keeps its group open).
  await row(parent).click(); await page.locator(`.pane[data-id="${parent}"]`).waitFor();
  await row(other).click(); await page.locator(`.pane[data-id="${other}"]`).waitFor();
  // Three workers: all shown, right under the parent, one step in. No fold row.
  await until(async () => (await listed(page)).filter((r) => r.startsWith('1:')).length === 3, 'three indented rows: ' + JSON.stringify(await listed(page)));
  let rows = await listed(page);
  const at = rows.indexOf('0:' + parent);
  assert.deepEqual(rows.slice(at + 1, at + 4).sort(), kids.map((k) => '1:' + k).sort(), 'the workers are not directly under their parent: ' + JSON.stringify(rows));
  assert.ok(rows.includes('0:' + other) && !rows.some((r) => r.startsWith('fold:')), JSON.stringify(rows));
  const left = (id) => row(id).evaluate((el) => el.getBoundingClientRect().left);
  assert.ok(await left(kids[0]) > await left(parent) + 8, 'a worker row is not indented');
  await shot(page, 'sidebar-three');

  // A fourth: folded behind one row, opened and closed by it; the count is on the row.
  const fourth = await a.tool('open_chat', { text: 'hello', title: 'Kid 4' }); await a.done(fourth.chat); kids.push(fourth.chat);
  await until(async () => (await listed(page)).includes('fold:Show 4 workers:false'), 'the fold row: ' + JSON.stringify(await listed(page)));
  assert.equal(await page.locator(`.pane[data-id="${fourth.chat}"]`).count(), 0, 'a worker an agent started took the screen');
  assert.ok(await page.locator(`.pane[data-id="${other}"]`).isVisible(), 'the chat being read left the screen');
  rows = await listed(page);
  assert.ok(!rows.some((r) => r.startsWith('1:')), 'four workers are not folded by default: ' + JSON.stringify(rows));
  assert.equal(rows[rows.indexOf('0:' + parent) + 1], 'fold:Show 4 workers:false');
  await shot(page, 'sidebar-folded');
  await page.click('#navList .row.subs');
  await until(async () => (await listed(page)).filter((r) => r.startsWith('1:')).length === 4, 'four rows after Show');
  assert.ok((await listed(page)).includes('fold:Hide 4 workers:true'));
  await shot(page, 'sidebar-open');
  await page.click('#navList .row.subs');
  await until(async () => !(await listed(page)).some((r) => r.startsWith('1:')), 'rows hidden after Hide');
  // The chat on screen is never folded away: open a worker, and its row stays.
  await page.click('#navList .row.subs'); await row(kids[1]).click();
  await page.locator(`.pane[data-id="${kids[1]}"]`).waitFor();
  await page.click('#navList .row.subs');
  await page.waitForTimeout(500);
  assert.ok((await listed(page)).includes('1:' + kids[1]), 'the open worker was folded away');

  // Window-1: the parent's row node stays the parent's through the redraws the workers' requests cause (with the fold row
  // among the rows, each redraw used to turn it into Kid 1's row, so a click on the parent opened Kid 1).
  await page.evaluate((id) => { window.__w1row = document.querySelector(`#navList .row[data-chat="${id}"]`); }, parent);
  // Two workers wait at once: an approval in Kid 1, a question in Kid 2. Both are drawn in the parent's chat.
  await a.tool('send_chat', { chat: kids[0], text: 'permission' });
  await a.tool('send_chat', { chat: kids[1], text: 'ask' });
  await until(async () => (await a.tool('wait_chat', { chat: kids[0] })).waiting?.kind === 'approval' && (await a.tool('wait_chat', { chat: kids[1] })).waiting?.kind === 'question', 'both workers waiting');
  await row(parent).click();
  const pane = page.locator(`.pane[data-id="${parent}"]`);
  const card = (id) => pane.locator(`.pending[data-ask="${id}"][data-ask-sub]`);
  await card(kids[0]).waitFor({ timeout: 15000 }); await card(kids[1]).waitFor({ timeout: 15000 });
  assert.deepEqual(await page.evaluate(() => [window.__w1row.isConnected, window.__w1row.dataset.chat]), [true, parent], 'the parent\'s row node became another chat\'s row');
  assert.match(await card(kids[0]).innerText(), /Worker needs approval[\s\S]*Write marker[\s\S]*Kid 1/i);
  assert.match(await card(kids[1]).innerText(), /Worker asks[\s\S]*Pick a colour[\s\S]*Kid 2/i);
  await shot(page, 'parent-cards');
  // Allow on Kid 1's card answers Kid 1, and only Kid 1.
  await card(kids[0]).locator('[data-approve="allow"]').click();
  assert.equal((await a.done(kids[0])).last, 'permission:allow');
  await card(kids[0]).waitFor({ state: 'detached', timeout: 15000 });
  assert.equal((await a.tool('wait_chat', { chat: kids[1] })).waiting?.kind, 'question', 'answering one worker\'s card touched the other');
  await card(kids[1]).waitFor();
  // The question's form answers Kid 2.
  await card(kids[1]).locator('input[value="blue"]').check();
  await card(kids[1]).evaluate((form) => form.requestSubmit());
  // requestSubmit only starts the answer's request: until it lands, wait_chat returns at once with the question still waiting.
  let answered;
  await until(async () => { answered = await a.done(kids[1]); return !answered.waiting; }, 'Kid 2 past its question', 30000);
  assert.match(answered.last, /^ask:.*blue/);
  await card(kids[1]).waitFor({ state: 'detached', timeout: 15000 });
  // Nothing was copied into the parent's history, and the answers are the user's own (no sending chat on them).
  assert.equal((await events(instance, parent)).filter((e) => ['approval', 'question', 'answered'].includes(e.type)).length, 0, 'the parent\'s history holds a worker\'s request');
  for (const k of kids.slice(0, 2)) assert.equal((await events(instance, k)).filter((e) => e.type === 'answered').at(-1).data.from, undefined, 'the user\'s answer was marked as a chat\'s');

  // Settings > Delegation: says what Delegate is, shows what the daemon holds, and saves a pick to it.
  await page.click('#setBtn'); await page.locator('#setDlg[open]').waitFor();
  const group = page.locator('#setDelegation');
  await group.scrollIntoViewIfNeeded();
  // window-9: Delegate and Sprints read as two features; Delegate is everyday work with no plan, roles or review.
  assert.match(await group.locator('[data-dg-what]').innerText(), /^Delegate is for everyday work\..*There is no plan, no fixed roles and no review step unless the agent sets one up\.$/s);
  assert.match(await group.locator('.set-row:has([data-dg-start]) strong').innerText(), /^Who may start workers$/);
  assert.equal(await group.locator('[data-dg-start]').getAttribute('aria-label'), 'Who may start workers');
  assert.match(await group.locator('.set-row:has([data-dg-start]) .muted').innerText(), /A sprint always asks you before it starts, whatever this says\.$/);
  // O226: Delegation has no worker folder setup box and no folder word; a sprint's setup is its project's.
  assert.equal(await group.locator('[data-dg-setup], input[type=text]').count(), 0, 'Settings > Delegation draws a setup field');
  assert.doesNotMatch(await group.innerText(), /folder/i);
  // F5: sprints have their own section, which says where each sprint setting lives.
  const sprints = page.locator('#setSprint');
  await sprints.scrollIntoViewIfNeeded();
  assert.deepEqual(await sprints.locator('.set-row strong').allInnerTexts(), ['Roles', 'A plan written down', 'A branch per worker', 'Ready means checked', 'Where you follow it', 'Sprint settings']);
  assert.match(await sprints.locator('p.muted').first().innerText(), /^A sprint is for a big build that runs over days or weeks.*Your yes is the approval of its plan\.$/s);
  // O227: a role names its provider; the agents never change your own folder; Sprint settings says nothing of Delegation.
  assert.match(await sprints.locator('.set-row:has(strong:text-is("Roles")) .muted').innerText(), /Each role names its own provider, model and effort;/);
  assert.match(await sprints.locator('.set-row:has(strong:text-is("A branch per worker")) .muted').innerText(), /Your own folder is only read, never changed by the agents\./);
  assert.equal(await sprints.locator('.set-row:has(strong:text-is("Sprint settings")) .muted').innerText(), 'A project\'s source to clone from and its own setup command: that project\'s page, under Sprints.');
  assert.doesNotMatch(await sprints.innerText(), /Delegation/);
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT f5-sprints ' + (await page.screenshot({ type: 'png' })).toString('base64'));
  await group.scrollIntoViewIfNeeded();
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT f5-delegation ' + (await page.screenshot({ type: 'png' })).toString('base64'));
  await until(async () => await group.locator('[data-dg-start]').inputValue() === 'agent' && !(await group.locator('[data-dg-start]').isDisabled()), 'the daemon\'s value in Settings');
  assert.deepEqual(await group.locator('[data-dg-start] option').allInnerTexts(), ['Off', 'Ask me first', 'Agent decides']);
  assert.equal(await group.locator('[data-dg-roles]').innerText(), 'Worker 1, Worker 2 and on are for Delegate. A sprint sets each of its chats\' agent, model and effort in its own roles.');
  await group.locator('[data-dg-start]').selectOption('ask');
  await until(async () => (await call(instance, '/delegation')).start === 'ask', 'Ask me first saved');
  // Workers per chat: one row per worker, each with its own agent, model and effort.
  assert.equal(await group.locator('[data-dg-max]').inputValue(), '20');
  await group.locator('[data-dg-max]').selectOption('3');
  await until(async () => (await call(instance, '/delegation')).max === 3 && await group.locator('[data-dg-worker]').count() === 3, 'three worker rows');
  assert.match(await group.locator('.set-pick:has([data-dg-agent="0"])').innerText(), /^Provider/, 'O227: the shared picker names a provider');
  assert.equal(await group.locator('[data-dg-model]').count(), 0, 'a row left on the parent\'s offers a model');
  await group.locator('[data-dg-agent="0"]').selectOption('claude');
  await group.locator('[data-dg-model="0"]').waitFor();
  await group.locator('[data-dg-model="0"]').selectOption('opus');
  await until(async () => (await call(instance, '/delegation')).workers[0].model === 'opus', 'Worker 1\'s model saved');
  await group.locator('[data-dg-effort="0"]').selectOption('high');
  await group.locator('[data-dg-agent="1"]').selectOption('codex');
  await group.locator('[data-dg-agent="2"]').selectOption('profile:' + profile.id);
  await until(async () => { const d = await call(instance, '/delegation'); return d.start === 'ask' && JSON.stringify(d.workers) === JSON.stringify([{ agent: 'claude', model: 'opus', effort: 'high' },
    { agent: 'codex', model: '', effort: '' }, { agent: 'profile:' + profile.id, model: 'glm-5.3', effort: '' }]); }, 'every pick saved together (O170: a profile saves its first model)');
  assert.deepEqual(await group.locator('[data-dg-model="2"] option').allInnerTexts(), ['Not set', 'glm-5.3', 'kimi-k3:cloud'], 'a profile row offers something other than Not set and the profile\'s models');
  assert.equal(await group.locator('[data-dg-model="2"]').inputValue(), 'glm-5.3', 'O170: the Model pick shows another model than the one saved');
  // Changing a row's agent drops the model and effort that belonged to the other agent.
  await group.locator('[data-dg-agent="0"]').selectOption('codex');
  await until(async () => { const w = (await call(instance, '/delegation')).workers[0]; return w.agent === 'codex' && w.model === '' && w.effort === ''; }, 'the old agent\'s model dropped');
  await group.locator('[data-dg-agent="0"]').selectOption('claude');
  await group.locator('[data-dg-model="0"]').selectOption('opus');
  await until(async () => (await call(instance, '/delegation')).workers[0].model === 'opus', 'Worker 1 back on opus');
  // The save's answer redraws #setDelegation (outerHTML) after the daemon already holds it, so a scroll can catch the old group detached: try again.
  await until(() => page.locator('#setDelegation').scrollIntoViewIfNeeded({ timeout: 1000 }).then(() => true, () => false), 'Delegation scrolled into view');
  await shot(page, 'settings-delegation');
  await page.keyboard.press('Escape'); await page.locator('#setDlg').waitFor({ state: 'hidden', timeout: 5000 });
  await page.click('#setBtn'); await page.locator('#setDlg[open]').waitFor();
  await until(async () => await page.locator('#setDelegation [data-dg-model="0"]').count() === 1 && await page.locator('#setDelegation [data-dg-model="0"]').inputValue() === 'opus', 'Settings reopened with the saved model');
  // A note from a worker shows in its parent's chat under the worker's name, marked as information.
  await page.keyboard.press('Escape'); await page.locator('#setDlg').waitFor({ state: 'hidden', timeout: 5000 });
  await call(instance, '/chat/' + kids[0] + '/prompt', 'POST', { text: 'mcp' });
  const kid = await tools(t, instance, kids[0]);
  assert.match((await kid.tool('send_chat', { chat: parent, text: 'The branch is pushed and the tests pass.', when: 'note' })).sent ?? '', /^as a note/);
  await row(parent).click();
  // The losing order, every time: P9's own end line for Kid 1's 'mcp' turn reaches the parent as a note about 3 s after
  // the kid's note (the end line is held first), and the pane draws it below the kid's note. Wait for both, so the
  // check below never depends on catching the kid's note while it is still the newest one.
  const endLine = (e) => e.type === 'note' && e.data.from === 'p9' && e.data.text.startsWith('[p9] Kid 1 ended its turn: mcp');
  await until(async () => (await events(instance, parent)).some(endLine), 'P9\'s end line for Kid 1\'s mcp turn');
  const drawn = (await events(instance, parent)).filter((e) => e.type === 'note' || e.type === 'user').length;
  await until(async () => await page.locator(`.pane[data-id="${parent}"] .msg.user`).count() >= drawn, 'the end line drawn in the parent pane');
  // The kid's note by its own text, not the pane's newest note (that is P9's end line by now).
  const who = page.locator(`.pane[data-id="${parent}"] .msg.user:has-text("The branch is pushed and the tests pass.") .who`);
  // O58 (j): a CI run timed out here with no cause named (run 44197851093, linux (6), n=1; the rerun passed). The record
  // below keeps what a timeout saw, so the next one narrows the candidates: the parent pane's .who texts say whether the
  // note rendered as 'Note from another chat' (the sender's title lookup missed, chat-view.mjs:284) or is absent from the
  // pane, and the daemon's ledger says whether the daemon delivered it. No single reading names the cause — a rendering
  // or event-poll stall could still hide behind either — but together they say which side to look at next.
  try {
    await until(async () => (await who.innerText()).startsWith('Note from Kid 1 · information only'), 'the note under its sender\'s name');
  } catch (e) {
    // Best-effort record: each part is bounded and caught on its own, so a stalled renderer or a rejecting daemon read
    // can neither hang the diagnostic nor replace the original note-wait failure (kept as this error's cause).
    const bounded = (p) => Promise.race([p, new Promise((res) => setTimeout(() => res(undefined), 3000))]);
    const parts = [];
    try {
      const whos = await bounded(page.locator(`.pane[data-id="${parent}"] .msg.user .who`).allInnerTexts());
      parts.push(whos ? 'window .who texts ' + JSON.stringify(whos.slice(-4)) : 'window .who texts <record: timed out>');
    } catch (d) { parts.push('window .who texts <record failed: ' + d.message + '>'); }
    try {
      const ledger = (await bounded(events(instance, parent)))?.filter((v) => ['note', 'user'].includes(v.type)).slice(-4);
      parts.push(ledger ? 'daemon note/user events ' + JSON.stringify(ledger) : 'daemon note/user events <record: timed out>');
    } catch (d) { parts.push('daemon note/user events <record failed: ' + d.message + '>'); }
    const err = new Error(e.message + ' — record: ' + parts.join(' · '));
    err.cause = e;
    throw err;
  }
  await who.scrollIntoViewIfNeeded();
  await shot(page, 'note-from-worker');
  assert.deepEqual(errors, [], 'page errors: ' + errors.join(' | '));
  console.log('PASS Delegate window: 3 workers indented, 4 folded behind "Show 4 workers"; Kid 1\'s approval and Kid 2\'s question answered from the parent chat; Settings > Delegation saved ask, 3 workers: Claude opus, Codex, a provider profile');
});

test('Delegate window: a completed worker pins its report in the parent chat', { timeout: 120000 }, async (t) => {
  const { writeFileSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  await call(instance, '/delegation', 'POST', { start: 'agent', max: 20, workers: [] });
  await call(instance, '/file-protection', 'POST', { on: false });
  const parent = (await call(instance, '/chat', 'POST', { provider: 'claude', title: 'Release work' })).conversation;
  await call(instance, `/chat/${parent}/prompt`, 'POST', { text: 'mcp' });
  const a = await tools(t, instance, parent);
  const made = await a.tool('open_chat', { text: 'first', item: 'B4', done_means: 'report is visible', checks: ['Tests pass'] });
  await a.done(made.chat);
  await a.tool('send_chat', { chat: made.chat, text: 'mcp' });
  const kid = await tools(t, instance, made.chat);
  await a.done(made.chat);
  writeFileSync(path.join(instance.workspace, '.gitignore'), '*\n!note.txt\n!.gitignore\n');
  execFileSync('git', ['init', '-q', '-b', 'main', instance.workspace]);
  execFileSync('git', ['-C', instance.workspace, 'add', '.']);
  execFileSync('git', ['-C', instance.workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base']);
  const head = execFileSync('git', ['-C', instance.workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const { page, errors } = await launch(t, instance);
  await page.locator(`#navList .row[data-chat="${parent}"]`).click();
  await a.tool('send_chat', { chat: made.chat, text: 'late' });
  const ready = await kid.tool('ready', { commit: head, results: [{ check: 'Tests pass', result: 'Passed' }], weakest: 'Live provider not checked' });
  assert.ok(ready.ready, JSON.stringify(ready));
  await a.done(made.chat);
  const pinned = page.locator(`.pane[data-id="${parent}"] .card-pin[data-card="ready-${made.chat}"]`);
  await pinned.waitFor({ timeout: 20000 });
  await until(async () => (await pinned.innerText()).includes('Live provider not checked'), 'completion card');
  assert.equal(await pinned.locator('.eyebrow').textContent(), 'Worker report');
  assert.equal(await pinned.getAttribute('data-card'), 'ready-' + made.chat);
  await shot(page, 'completion-card');
  assert.deepEqual(errors, []);
});

test('Delegate window: New chat does not crash while the daemon is connecting', { timeout: 90000, skip: process.platform === 'win32' }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-delay-')), 'profile');
  process.kill(instance.child.pid, 'SIGSTOP');
  let paused = true;
  const resume = () => { if (paused) { paused = false; try { process.kill(instance.child.pid, 'SIGCONT'); } catch {} } };
  t.after(resume);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { resume(); await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow(), errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await until(() => page.evaluate(() => typeof document.querySelector('#newBtn')?.onclick === 'function'), 'New chat handler');
    await page.locator('#newBtn').click();
    // O57: while connecting, New chat makes no local chat with made-up values; it says it waits for the daemon.
    await page.locator('#toasts .toast', { hasText: 'Connecting' }).waitFor({ timeout: 15000 });
    assert.equal(await page.locator('#chats > .pane').count(), 0, 'no chat is drawn before the daemon answers');
    assert.deepEqual(errors, []);
    await shot(page, 'connecting-chat');
  } finally { resume(); }
  await page.locator('#dataNote', { hasText: 'Chat live' }).waitFor({ timeout: 20000 });
  // The chat the user asked for opens on the daemon once it answers.
  await page.locator('#chats > .pane').first().waitFor({ timeout: 15000 });
  assert.equal(await page.locator('#chats > .pane').count(), 1);
  assert.deepEqual(errors, []);
});

test('project cut keeps an opened worker group together', { timeout: 60000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const { app, page } = await launch(t, instance);
  await app.evaluate(({ ipcMain }) => {
    const now = Date.now(), project = { id: 'project1', name: 'Workers', work: { kind: 'p9', folder: '' }, files: [] };
    const conv = (id, extra = {}) => ({ id, provider: 'claude', title: id, folder: '~', created: now, state: 'running', sent: 1, used: now, project: 'project1', archived: false, parent: null, ...extra });
    const rows = [conv('lead', { used: now - 100 }), ...Array.from({ length: 4 }, (_, i) => conv('worker' + i, { parent: 'lead' })), ...Array.from({ length: 6 }, (_, i) => conv('chat' + i))];
    ipcMain.removeHandler('p9:chat');
    ipcMain.handle('p9:chat', async (_e, action) => {
      if (action === 'list') return { status: 200, body: { conversations: rows, lists: {} } };
      if (action === 'projects') return { status: 200, body: { projects: [project] } };
      if (action === 'project') return { status: 200, body: { project } };
      if (action === 'events') { await new Promise(resolve => setTimeout(resolve, 100)); return { status: 200, body: { events: [], cursor: 0, more: false } }; }
      if (action === 'profiles') return { status: 200, body: { profiles: [] } };
      return { status: 404, body: {} };
    });
  });
  await page.reload();
  const zone = page.locator('#navList [data-zone="project1"]');
  const projectRow = zone.locator('[data-proj="project1"]');
  await projectRow.waitFor({ timeout: 15000 });
  if (await projectRow.getAttribute('aria-expanded') !== 'true') await zone.locator('[data-toggle="project1"]').click();
  await shot(page, 'sidebar-project-before');
  await zone.locator('[data-subs="lead"]').click({ timeout: 15000 });
  for (let i = 0; i < 4; i++) await zone.locator(`[data-chat="worker${i}"]`).waitFor({ timeout: 5000 });
  assert.equal(await zone.locator('[data-showmore]').innerText(), 'Show 2 more');
  await page.waitForFunction(() => { const els = [...document.querySelectorAll('#navList [data-zone="project1"] .kids > .rowwrap, #navList [data-zone="project1"] .kids > .subs')]; const order = els.map(e => e.matches('.subs') ? 'toggle' : e.querySelector('[data-chat]')?.dataset.chat); const at = order.indexOf('lead'); return at >= 0 && order[at + 5] === 'toggle'; }, null, { timeout: 5000 });
  const order = await zone.locator('.kids > .rowwrap, .kids > .subs').evaluateAll(els => els.map(e => e.matches('.subs') ? 'toggle' : e.querySelector('[data-chat]')?.dataset.chat));
  await shot(page, 'sidebar-project-cut-workers');
  assert.deepEqual(order.slice(order.indexOf('lead') + 1, order.indexOf('lead') + 5).sort(), ['worker0', 'worker1', 'worker2', 'worker3']);
  assert.equal(order[order.indexOf('lead') + 5], 'toggle');
});

// O109 (what the lead is doing and its composer could not be found): a busy lead chat, with a worker (the
// sprint card), the worker's report pinned and 30 messages waiting for its turn, keeps its text box on screen and usable
// at the window size O109 was seen at. Then the turn ends: the waiting messages go, and every one leaves the strip.
// The O109 setup: a lead with one worker whose long report is pinned, working through a 66 s turn, with `queued` messages
// waiting for its end; the window at the size O109 was seen at, with the lead open.
async function busyLead(t, queued) {
  const { writeFileSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  await call(instance, '/delegation', 'POST', { start: 'agent', max: 20, workers: [] });
  await call(instance, '/file-protection', 'POST', { on: false });
  const parent = (await call(instance, '/chat', 'POST', { provider: 'claude', title: 'Lead' })).conversation;
  await call(instance, `/chat/${parent}/prompt`, 'POST', { text: 'mcp' });
  const a = await tools(t, instance, parent);
  const made = await a.tool('open_chat', { text: 'first', item: 'B4', done_means: 'report is visible', checks: ['Tests pass'] });
  await a.done(made.chat);
  await a.tool('send_chat', { chat: made.chat, text: 'mcp' });
  const kid = await tools(t, instance, made.chat);
  await a.done(made.chat);
  writeFileSync(path.join(instance.workspace, '.gitignore'), '*\n!.gitignore\n');
  execFileSync('git', ['init', '-q', '-b', 'main', instance.workspace]);
  execFileSync('git', ['-C', instance.workspace, 'add', '.']);
  execFileSync('git', ['-C', instance.workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base']);
  const head = execFileSync('git', ['-C', instance.workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const weakest = Array.from({ length: 12 }, (_, i) => 'Line ' + (i + 1) + ' of a long weakest part, as a real report has.').join('\n\n');
  await a.tool('send_chat', { chat: made.chat, text: 'late' }); // ready needs the worker mid-turn
  const ready = await kid.tool('ready', { commit: head, results: [{ check: 'Tests pass', result: 'Passed' }], weakest });
  assert.ok(ready.ready, JSON.stringify(ready));
  await a.done(made.chat);
  // The lead works on (twenty tool steps of 3 s, about 66 s, then it ends by itself; long enough to launch the window and look), and 30 messages wait for its end, as the
  // coordinator's and the workers' notes did.
  const state = async () => (await call(instance, '/chat')).conversations.find((c) => c.id === parent).state;
  await until(async () => await state() !== 'turn', 'the lead is idle');
  // The "Ready report pinned" note rides in front of the lead's next prompt, in the same text; a first prompt takes it, so
  // the fake reads the second one as it is.
  const ends = async () => (await events(instance, parent)).filter((e) => e.type === 'turn-end').length, before = await ends();
  await call(instance, `/chat/${parent}/prompt`, 'POST', { text: 'cwd' });
  await until(async () => await ends() > before && await state() !== 'turn', 'the note read');
  const started = await call(instance, `/chat/${parent}/prompt`, 'POST', { text: 'tools 20' });
  try { await until(async () => await state() === 'turn', 'the lead is working'); } catch (error) { // what the daemon did instead
    const last = (await events(instance, parent)).slice(-20).map((e) => e.type + ':' + JSON.stringify(e.data).slice(0, 80));
    assert.fail(error.message + ' | prompt answered ' + JSON.stringify(started) + ' | state ' + await state() + ' | last events ' + last.join(' || '));
  }
  for (let i = 1; i <= queued; i++) assert.equal((await call(instance, `/chat/${parent}/prompt`, 'POST', { text: 'Queued note ' + i + ': ' + 'x'.repeat(80), when: 'queue' })).when, 'queue');
  const { app, page, errors } = await launch(t, instance);
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.unmaximize(); w.setContentSize(1568, 1348); });
  await page.setViewportSize({ width: 1568, height: 1348 }).catch(() => {});
  await page.locator(`#navList .row[data-chat="${parent}"]`).click();
  const pane = page.locator(`.pane[data-id="${parent}"]`);
  await pane.locator(`.card-pin[data-card="ready-${made.chat}"]`).waitFor({ timeout: 20000 });
  return { instance, parent, made, a, kid, head, app, page, errors, pane, weakest };
}
test('O109: 30 queued messages, a sprint card and a worker report leave the composer on screen; delivered ones leave the strip', { timeout: 150000 }, async (t) => {
  const { parent, page, errors, pane } = await busyLead(t, 30);
  // ">= 30": a worker's late note may wait with them.
  await until(async () => await pane.locator('[data-held]').count() >= 30, 'all 30 waiting messages drawn');
  const waiting = await pane.locator('[data-held]').count();
  await pane.locator('.sp-row').first().waitFor({ state: 'attached', timeout: 20000 }); // the sprint card: the lead has a worker (its rows fold away)
  // The text box is on screen, uncovered and takes focus, measured once the layout has stopped moving.
  const box = pane.locator('.composer textarea');
  const onScreen = async (name) => {
    const measure = () => box.evaluate((el) => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => { const r = el.getBoundingClientRect();
      done({ top: Math.round(r.top), bottom: Math.round(r.bottom), height: innerHeight, hit: document.elementFromPoint(r.left + 20, r.top + r.height / 2) === el }); }))));
    let seen = await measure();
    for (let i = 0; i < 20; i++) { await page.waitForTimeout(250); const again = await measure(); if (JSON.stringify(again) === JSON.stringify(seen)) break; seen = again; }
    await shot(page, 'o109-' + name);
    console.log('O109 composer ' + name + ' ' + JSON.stringify(seen));
    assert.ok(seen.bottom <= seen.height && seen.top >= 0 && seen.hit, name + ': the text box is on screen and nothing covers it: ' + JSON.stringify(seen));
    await box.click({ timeout: 5000 });
    assert.equal(await box.evaluate((el) => document.activeElement === el), true, name + ': the text box takes focus');
  };
  // Folded: the box first (what could not be found in O109), then the strip says how many wait.
  await onScreen('folded');
  assert.equal(await pane.locator('.queue > summary').innerText(), waiting + ' queued, oldest waiting <1 min'); // O125 (4): a stuck queue shows how long its oldest has waited
  assert.equal(await pane.locator('.queue').evaluate((el) => el.open), false);
  // Open: all of them listed, each with its Take back, and the box still on screen.
  await pane.locator('.queue > summary').click();
  assert.equal(await pane.locator('.queue').evaluate((el) => el.open), true);
  assert.equal(await pane.locator('.queue [data-unhold]').count(), waiting);
  await onScreen('open');
  // After a reload, the same.
  await page.reload();
  await page.locator('#dataNote', { hasText: 'Chat live' }).waitFor({ timeout: 20000 });
  await page.locator(`#navList .row[data-chat="${parent}"]`).click();
  await until(async () => await pane.locator('[data-held]').count() >= 30, 'the waiting messages drawn again after a reload');
  await onScreen('reloaded');
  // The turn ends by itself: the waiting messages go (one sender, so one prompt) and the strip empties.
  // Regression only: main already drops a delivered row (chat-view applyChat 'user'); this keeps it so with the strip.
  await until(async () => await pane.locator('[data-held]').count() === 0, 'no delivered message still reads Queued', 90000);
  assert.equal(await pane.locator('.queue').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS O109: composer on screen and focusable with 30 queued, a sprint card and a worker report at 1568x1348; all 30 left the strip when delivered');
});

// O109 (3) and (4): the worker report above the box can be closed; it goes into the chat (where it scrolls with it), stays
// closed after a reload, and the next report shows above the box again. While the lead works, the line under the chat
// names its latest step, so what it is doing shows without scrolling.
test('O109: a worker report closes into the chat and only a new one comes back; a long turn shows its latest step', { timeout: 150000 }, async (t) => {
  const { parent, made, a, kid, head, page, errors, pane } = await busyLead(t, 0);
  const card = pane.locator(`.card-pin[data-card="ready-${made.chat}"]`), old = pane.locator(`.hist [data-report="ready-${made.chat}"]`);
  const step = pane.locator('.working .step');
  await until(async () => await step.count() === 1 && /^Run tool \d+$/.test(await step.innerText()), 'the working line names the latest step');
  const box = await step.evaluate((el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: innerHeight }; });
  assert.ok(box.top >= 0 && box.bottom <= box.height, 'the step is on screen: ' + JSON.stringify(box));
  console.log('O109 step ' + await step.innerText() + ' ' + JSON.stringify(box));
  await shot(page, 'o109-step');
  await card.locator('[data-card-close]').click({ timeout: 5000 });
  await until(async () => await card.count() === 0, 'the report closed');
  await until(async () => await old.count() === 1 && (await old.innerText()).includes('Line 12 of a long weakest part'), 'the closed report in the chat');
  await shot(page, 'o109-closed');
  await page.reload();
  await page.locator('#dataNote', { hasText: 'Chat live' }).waitFor({ timeout: 20000 });
  await page.locator(`#navList .row[data-chat="${parent}"]`).click();
  await old.waitFor({ timeout: 20000 });
  assert.equal(await card.count(), 0, 'still closed after a reload');
  await shot(page, 'o109-closed-reloaded');
  await a.tool('send_chat', { chat: made.chat, text: 'late' }); // ready needs the worker mid-turn
  const again = await kid.tool('ready', { commit: head, results: [{ check: 'Tests pass', result: 'Passed' }], weakest: 'A second report: something new' });
  assert.ok(again.ready, JSON.stringify(again));
  await until(async () => await card.count() === 1 && (await card.innerText()).includes('A second report: something new'), 'the new report pinned above the box');
  assert.ok(await old.count() >= 1, 'the first report still in the chat');
  await shot(page, 'o109-new-report');
  assert.deepEqual(errors, []);
  console.log('PASS O109 report+step: step named on screen; report closed into the chat, stayed closed after a reload, a new one pinned again');
});

// 712 (old workers could not be cleared out of the sprint box top right): an archived worker leaves the card,
// as it leaves the sidebar; a stopped worker can be cleared from the card itself (one, or all stopped at once), and stays
// cleared after a reload. The card held every child chat whatever its archive (kin() in the card had no archived filter).
test('712: old workers clear out of the sprint box: archived ones leave it, a stopped one clears from the card, all stopped clear at once, ready ones too', { timeout: 240000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  await call(instance, '/delegation', 'POST', { start: 'agent', max: 20, workers: [] });
  await call(instance, '/file-protection', 'POST', { on: false }); // as busyLead: a worker's task is written to the project
  const parent = (await call(instance, '/chat', 'POST', { provider: 'claude', title: 'Lead' })).conversation;
  await call(instance, `/chat/${parent}/prompt`, 'POST', { text: 'mcp' });
  const a = await tools(t, instance, parent);
  const kids = [];
  for (let i = 0; i < 5; i++) { const made = await a.tool('open_chat', { text: 'first', item: 'W' + i, done_means: 'x', checks: ['Tests pass'] }); assert.ok(made.chat, JSON.stringify(made)); await a.done(made.chat); kids.push(made.chat); console.log('O712 made ' + i); }
  const { writeFileSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  // Reviewer FIX1: a stopped worker that reported ready (kids[5]) shows Ready, not Stopped; it must still clear, by its x and in the count. (Passed/Fix take the same branch of workerStatus; a verdict needs a sibling in a project, which this lead has not.)
  writeFileSync(path.join(instance.workspace, '.gitignore'), '*\n!.gitignore\n');
  execFileSync('git', ['init', '-q', '-b', 'main', instance.workspace]);
  execFileSync('git', ['-C', instance.workspace, 'add', '.']);
  execFileSync('git', ['-C', instance.workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base']);
  const head = execFileSync('git', ['-C', instance.workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  for (const n of [5]) {
    const made = await a.tool('open_chat', { text: 'first', item: 'W' + n, done_means: 'x', checks: ['Tests pass'] }); assert.ok(made.chat, JSON.stringify(made)); await a.done(made.chat); kids.push(made.chat);
    await a.tool('send_chat', { chat: made.chat, text: 'mcp' });
    const kid = await tools(t, instance, made.chat);
    await a.done(made.chat);
    await a.tool('send_chat', { chat: made.chat, text: 'late' }); // ready needs the worker mid-turn
    const r = await kid.tool('ready', { commit: head, results: [{ check: 'Tests pass', result: 'Passed' }], weakest: 'x' }); assert.ok(r.ready, JSON.stringify(r));
    await a.done(made.chat);
  }
  const gone = [0, 1, 2, 3, 5].map((n) => kids[n]);
  for (const id of gone) {
    const r = await a.tool('stop_chat', { chat: id, close: true }); assert.deepEqual([r.action, r.archived], ['stopped', [id]], JSON.stringify(r));
    // O132: a close archives. This test is about stopped workers left on the card, so each comes back the documented way.
    assert.equal((await a.tool('archive_chat', { chat: id, archived: false })).action, 'unarchived');
  } // kids[4] stays: a live worker keeps its row and has no clear
  console.log('O712 stopped 5');
  // The way archive_chat clears one, before the window opens (as tried for 712).
  await call(instance, `/chat/${kids[0]}/archive`, 'POST', { archived: true });
  const { app, page, errors } = await launch(t, instance);
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.unmaximize(); w.setContentSize(1568, 1348); });
  await page.setViewportSize({ width: 1568, height: 1348 }).catch(() => {});
  await page.locator(`#navList .row[data-chat="${parent}"]`).click();
  const pane = page.locator(`.pane[data-id="${parent}"]`), card = pane.locator('.sprint');
  const row = (id) => card.locator(`[data-sprint-open="${id}"]`);
  await row(kids[4]).waitFor({ state: 'attached', timeout: 20000 });
  if (await card.getAttribute('data-folded') === 'true') await card.locator('[data-sprint-fold]').click();
  await row(kids[1]).waitFor({ timeout: 5000 });
  await shot(page, 'o712-before');
  console.log('O712 card ' + await card.locator('.sp-sum').innerText());
  assert.equal(await row(kids[0]).count(), 0, 'an archived worker is still on the card');
  const sum0 = await card.locator('.sp-sum').innerText();
  assert.ok(!(await row(kids[0]).count()) && /^\d+ workers\b/.test(sum0), sum0);
  assert.equal(await row(kids[5]).getAttribute('data-status'), 'ready', 'kids[5] shows its report');
  assert.equal(await card.locator(`[data-sprint-clear="${kids[5]}"]`).count(), 1, 'a stopped ready worker has no clear');
  // One stopped worker cleared from its row; the live one has no clear.
  assert.equal(await card.locator(`[data-sprint-clear="${kids[4]}"]`).count(), 0, 'a live worker offers a clear');
  // 712 FIX2: kids[5]'s report is the one pinned; clearing another worker (kids[1]) leaves it.
  const report = (n) => pane.locator(`.card-pin[data-card="ready-${kids[n]}"]`);
  assert.equal(await report(5).count(), 1, 'the worker report is not pinned');
  await card.locator(`[data-sprint-clear="${kids[1]}"]`).click({ timeout: 5000 });
  await until(async () => await row(kids[1]).count() === 0, 'the cleared worker left the card');
  assert.equal(await report(5).count(), 1, 'clearing another worker closed this worker\'s report');
  await shot(page, 'o712-one-cleared');
  // The rest of the stopped ones at once; the live one stays.
  // Two ordinary stopped and one stopped ready: the count names all three and Clear takes exactly those.
  await card.locator('[data-sprint-clear="*"]', { hasText: 'Clear 3 stopped' }).click({ timeout: 5000 });
  await until(async () => await report(5).count() === 0, 'a cleared worker\'s report is still pinned');
  await until(async () => { for (const n of [2, 3, 5]) if (await row(kids[n]).count()) return false; return true; }, 'all stopped workers left the card');
  assert.equal(await row(kids[4]).count(), 1, 'the live worker left the card');
  assert.equal(await card.locator('[data-sprint-clear="*"]').count(), 0, 'Clear all still shows with nothing stopped');
  const archived = (await call(instance, '/chat')).conversations.filter((c) => kids.includes(c.id) && c.archived).map((c) => c.id).sort();
  assert.deepEqual(archived, [...gone].sort(), 'clearing archives exactly the stopped chats in the daemon');
  // A reload keeps them cleared, and the text box is still on screen with the card.
  await page.reload();
  await page.locator('#dataNote', { hasText: 'Chat live' }).waitFor({ timeout: 20000 });
  await page.locator(`#navList .row[data-chat="${parent}"]`).click();
  await row(kids[4]).waitFor({ state: 'attached', timeout: 20000 });
  for (const id of gone) assert.equal(await row(id).count(), 0, 'a cleared worker came back after a reload');
  assert.equal(await report(5).count(), 0, 'a cleared worker\'s report came back after a reload');
  const box = await pane.locator('.composer textarea').evaluate((el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: innerHeight, hit: document.elementFromPoint(r.left + 20, r.top + r.height / 2) === el }; });
  assert.ok(box.top >= 0 && box.bottom <= box.height && box.hit, 'the text box is on screen: ' + JSON.stringify(box));
  await shot(page, 'o712-reloaded');
  assert.deepEqual(errors, []);
  console.log('PASS 712: archived worker off the card; one stopped cleared by its x; a stopped ready row has an x; Clear 3 stopped took two plain and one ready; archived in the daemon; still gone after a reload; clearing another worker left the pinned report, clearing its own worker closed it; text box on screen');
});

// window-3 (row "A sprint never ends": the closed probe worker's report was still drawn above the message box):
// a worker archived anywhere but its own card row (archive_chat, the sidebar, another window) left its report pinned above the box,
// because the pinned report looked only at this browser's closed list. Archived is the daemon's word, so every window drops it.
test('window-3: an archived worker\'s report leaves the box above the message box, and stays gone after a reload and the lead\'s next turn', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  await call(instance, '/delegation', 'POST', { start: 'agent', max: 20, workers: [] });
  await call(instance, '/file-protection', 'POST', { on: false });
  const parent = (await call(instance, '/chat', 'POST', { provider: 'claude', title: 'Lead' })).conversation;
  await call(instance, `/chat/${parent}/prompt`, 'POST', { text: 'mcp' });
  const a = await tools(t, instance, parent);
  const { writeFileSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  writeFileSync(path.join(instance.workspace, '.gitignore'), '*\n!.gitignore\n');
  execFileSync('git', ['init', '-q', '-b', 'main', instance.workspace]);
  execFileSync('git', ['-C', instance.workspace, 'add', '.']);
  execFileSync('git', ['-C', instance.workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base']);
  const head = execFileSync('git', ['-C', instance.workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const live = await a.tool('open_chat', { text: 'first', item: 'W0', done_means: 'x', checks: ['Tests pass'] }); await a.done(live.chat); // keeps the card on screen
  const made = await a.tool('open_chat', { text: 'first', item: 'W1', done_means: 'x', checks: ['Tests pass'] }); assert.ok(made.chat, JSON.stringify(made)); await a.done(made.chat);
  const kid = made.chat;
  await a.tool('send_chat', { chat: kid, text: 'mcp' });
  const k = await tools(t, instance, kid);
  await a.done(kid);
  await a.tool('send_chat', { chat: kid, text: 'late' }); // ready needs the worker mid-turn
  const r = await k.tool('ready', { commit: head, results: [{ check: 'Tests pass', result: 'Passed' }], weakest: 'x' }); assert.ok(r.ready, JSON.stringify(r));
  await a.done(kid);
  assert.deepEqual((await a.tool('stop_chat', { chat: kid, close: true })).archived, [kid]); // "closed with stop and close"
  // O132: the close archived it. This test archives it from outside the card, so it comes back first, stopped.
  assert.equal((await a.tool('archive_chat', { chat: kid, archived: false })).action, 'unarchived');
  const { app, page, errors } = await launch(t, instance);
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.unmaximize(); w.setContentSize(1568, 1348); });
  await page.setViewportSize({ width: 1568, height: 1348 }).catch(() => {});
  await page.locator(`#navList .row[data-chat="${parent}"]`).click();
  const pane = page.locator(`.pane[data-id="${parent}"]`), card = pane.locator('.sprint');
  const row = card.locator(`[data-sprint-open="${kid}"]`), pin = pane.locator(`.card-pin[data-card="ready-${kid}"]`), inline = pane.locator(`.hist [data-report="ready-${kid}"]`);
  await pin.waitFor({ timeout: 20000 }); // stopped and closed, then back from Archived: the report is still the one to read (712 keeps it)
  await shot(page, 'w3-report-pinned');
  // The way archive_chat (and the sidebar) archives it: not from this card, so this window's own clear never ran.
  await call(instance, `/chat/${kid}/archive`, 'POST', { archived: true });
  await until(async () => await pin.count() === 0, 'the archived worker\'s report is still pinned above the box');
  assert.equal(await row.count(), 0, 'the archived worker is still on the card');
  await inline.waitFor({ timeout: 5000 }); // it scrolls with the chat, as a closed report does
  await shot(page, 'w3-archived');
  await page.reload();
  await page.locator('#dataNote', { hasText: 'Chat live' }).waitFor({ timeout: 20000 });
  await page.locator(`#navList .row[data-chat="${parent}"]`).click();
  await card.locator(`[data-sprint-open="${live.chat}"]`).waitFor({ state: 'attached', timeout: 20000 });
  assert.equal(await pin.count(), 0, 'the archived worker\'s report came back after a reload');
  assert.equal(await row.count(), 0, 'the archived worker came back to the card after a reload');
  // The lead's next turn draws the chat again; the worker and its report stay gone.
  await call(instance, `/chat/${parent}/prompt`, 'POST', { text: 'the lead goes on' });
  await pane.locator('.msg.user', { hasText: 'the lead goes on' }).waitFor({ timeout: 20000 });
  await until(async () => await pane.locator('.working').count() === 0, 'the lead\'s turn ended', 30000);
  assert.equal(await pin.count(), 0, 'the archived worker\'s report came back after the lead\'s next turn');
  assert.equal(await row.count(), 0, 'the archived worker came back to the card after the lead\'s next turn');
  await shot(page, 'w3-after-lead-turn');
  assert.deepEqual(errors, []);
  console.log('PASS window-3: a stopped worker\'s report stays pinned; archived by archive_chat it leaves the box and the card and scrolls with the chat; still gone after a reload and after the lead\'s next turn');
});

// O133 (Settings set to "sol medium" kept going back to the agent default): Settings > New chats
// start in was kept only in the window, so a chat an agent opens never got it. A Codex default effort picked in Settings
// survives a P9 restart, and a Codex worker a Claude chat opens with no effort runs on it, not Codex's own (medium here).
test('O133: a Settings default effort applies to a worker an agent opens, after a restart, and Settings still shows it', { timeout: 150000 }, async (t) => {
  let instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  // One Delegation row: a Codex worker, its model and effort left to the agent (so nothing names them).
  assert.equal((await call(instance, '/delegation', 'POST', { start: 'agent', max: 1, workers: [{ agent: 'codex', model: '', effort: '' }] })).status, 200);
  await call(instance, '/file-protection', 'POST', { on: false });
  const seen = (await call(instance, '/chat', 'POST', { provider: 'codex', title: 'Seen' })).conversation;
  await call(instance, `/chat/${seen}/prompt`, 'POST', { text: 'hi' });
  await until(async () => (await events(instance, seen)).some((e) => e.type === 'config'), 'Codex\'s lists');
  let { app, page, errors } = await launch(t, instance);
  const settings = async () => { await page.click('#setBtn'); await page.locator('#setDlg[open]').waitFor(); await page.click('[data-set-page="Chat Focus"]'); };
  const pick = '[data-default-effort="codex"]';
  await settings();
  await page.locator(pick + ' option[value="high"]').waitFor({ state: 'attached', timeout: 15000 });
  await page.selectOption(pick, 'high');
  await page.waitForTimeout(1500); // the save is a request; give it time either way, so the old build fails below, not here
  await shot(page, 'o133-picked');
  assert.deepEqual(errors, []);
  await app.close();
  instance.child.kill('SIGTERM'); await once(instance.child, 'exit');
  instance = await restart(t, instance, 'state-2');
  const parent = (await call(instance, '/chat', 'POST', { provider: 'claude', title: 'Lead' })).conversation;
  await call(instance, `/chat/${parent}/prompt`, 'POST', { text: 'mcp' });
  const a = await tools(t, instance, parent);
  const made = await a.tool('open_chat', { text: 'config', provider: 'codex', title: 'Review2' });
  assert.ok(made.chat, JSON.stringify(made));
  await a.done(made.chat);
  const said = (await events(instance, made.chat)).find((e) => e.data?.content?.text?.startsWith('config:'))?.data.content.text;
  assert.match(said ?? '', /effort=high/, 'the worker ran on the Settings default, not Codex\'s own');
  ({ app, page, errors } = await launch(t, instance));
  await page.locator(`#navList .row[data-chat="${parent}"]`).click();
  const row = page.locator(`#navList .row[data-chat="${made.chat}"]`);
  await row.waitFor({ timeout: 20000 }); await row.click();
  const effort = page.locator(`.pane[data-id="${made.chat}"] [data-pill="Effort"]`);
  await effort.waitFor({ timeout: 20000 });
  assert.equal(await effort.getAttribute('aria-label'), 'Effort: High (Default)', 'the worker\'s pill (O131 label: the Settings default is the one marked)');
  await shot(page, 'o133-worker');
  await settings();
  await until(async () => await page.locator(pick).inputValue() === 'high', 'Settings still shows High after the restart', 10000);
  await shot(page, 'o133-settings');
  assert.deepEqual(errors, []);
  console.log('PASS O133: a Codex default effort set in Settings survives a restart and a Codex worker opened by a Claude chat runs on it');
});

// window-4 (row 730: the Worker Report card above the chat box goes behind it showing its title; clicking the title slides it
// up, clicking again slides it down, so it is never permanently in the way).
test('window-4: the worker report floats folded to its title above the box, slides up and down from it, and the chat never moves', { timeout: 240000 }, async (t) => {
  const { instance, parent, made, a, kid, head, page, errors, pane } = await busyLead(t, 0);
  const card = pane.locator(`.card-pin[data-card="ready-${made.chat}"]`), title = card.locator('[data-card-tab]'), body = card.locator('.tb');
  const state = async () => (await call(instance, '/chat')).conversations.find((c) => c.id === parent).state;
  await until(async () => await state() !== 'turn', 'the lead\'s turn ended (the history stops growing)', 120000);
  await page.waitForTimeout(800);
  // Where the history is: its box, its scroll and its last row on screen. None of them may change with the report.
  const hist = async () => pane.locator('.hist').evaluate((h) => { const last = [...h.querySelectorAll(':scope > .col > *')].at(-1)?.getBoundingClientRect(); return JSON.stringify({ height: h.clientHeight, top: Math.round(h.scrollTop), last: last && Math.round(last.top) }); });
  const box = async (l) => l.evaluate((el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; });
  // Folded: the title and nothing of the report's text on screen.
  await title.waitFor({ timeout: 5000 });
  assert.equal(await title.getAttribute('aria-expanded'), 'false', 'arrives folded');
  assert.ok((await box(body)).height < 1, 'folded, the report body takes no height: ' + JSON.stringify(await box(body)));
  assert.ok((await box(card)).height < 48, 'folded, only the title shows: ' + JSON.stringify(await box(card)));
  const composer = await box(pane.locator('.composer'));
  assert.ok((await box(card)).bottom <= composer.top, 'the title sits above the message box');
  const still = await hist();
  // The chat's last row scrolled to the end is not under the title.
  await pane.locator('.hist').evaluate((h) => { h.style.scrollBehavior = 'auto'; h.scrollTop = h.scrollHeight; });
  const last = await pane.locator('.hist').evaluate((h) => [...h.querySelectorAll(':scope > .col > *')].at(-1).getBoundingClientRect().bottom);
  assert.ok(last <= (await box(card)).top + 1, 'the chat\'s last row clears the folded title: ' + JSON.stringify([last, await box(card)]));
  await pane.locator('.hist').evaluate((h, top) => { h.scrollTop = top; }, JSON.parse(still).top);
  await shot(page, 'window4-folded');
  // Opened from its title: the body slides up over the chat; the chat stays where it was.
  await title.click();
  await until(async () => (await box(body)).height > 80, async () => 'the report did not slide up: ' + JSON.stringify(await box(body)));
  assert.equal(await title.getAttribute('aria-expanded'), 'true');
  assert.ok((await card.innerText()).includes('Line 12 of a long weakest part'), 'the report text, opened');
  assert.ok((await box(card)).bottom <= composer.top + 1, 'opened upward, the box not covered');
  await page.waitForTimeout(400);
  assert.equal(await hist(), still, 'opening it did not move the chat');
  await shot(page, 'window4-open');
  // The title again (from the keyboard): it slides down.
  await title.focus(); await page.keyboard.press('Enter');
  await until(async () => (await box(body)).height < 1, 'the report slid down');
  assert.equal(await title.getAttribute('aria-expanded'), 'false');
  await page.waitForTimeout(400);
  assert.equal(await hist(), still, 'closing it did not move the chat');
  // Closed with its x, then a new report arrives: folded again, and the chat did not move either time.
  await card.locator('[data-card-close]').click();
  await until(async () => await card.count() === 0, 'the report closed');
  await page.waitForTimeout(400);
  const without = await hist();
  await a.tool('send_chat', { chat: made.chat, text: 'late' });
  assert.ok((await kid.tool('ready', { commit: head, results: [{ check: 'Tests pass', result: 'Passed' }], weakest: 'A second report' })).ready);
  await until(async () => await card.count() === 1, 'the new report pinned');
  await until(async () => await state() !== 'turn', 'the note turn ended', 60000).catch(() => {});
  assert.equal(await title.getAttribute('aria-expanded'), 'false', 'a new report arrives folded');
  // Its arrival took no room from the history (rows the lead's note adds may scroll it, so only the box is compared).
  assert.equal(JSON.parse(await hist()).height, JSON.parse(without).height, 'the history kept its height when the report came');
  // Two cards, two titles: a card the lead pins shows its own title in the strip, the report's title floats above it.
  assert.equal((await a.tool('pin_card', { id: 'status', kind: 'markdown', text: 'Build green' })).pinned, 'status');
  const strip = pane.locator('.bottom .pinned [data-card="status"] .eyebrow');
  await strip.waitFor({ timeout: 15000 });
  const [r, s] = [await box(title), await box(strip)];
  assert.ok(r.height > 0 && s.height > 0 && r.bottom <= s.top, 'both titles show, the report\'s above: ' + JSON.stringify([r, s]));
  await shot(page, 'window4-two-titles');
  // FIX1 (Reviewer): a short window with the bottom at its 70vh cap (a tall pinned card), the long report opened: its title
  // and close stay inside the pane, under the history's top, and a click there reaches them (nothing drawn over them).
  await page.setViewportSize({ width: 1280, height: 560 });
  assert.equal(await page.evaluate(() => innerHeight), 560, 'the window is short');
  assert.equal((await a.tool('pin_card', { id: 'tall', kind: 'markdown', text: Array.from({ length: 30 }, (_, i) => 'Tall pinned line ' + (i + 1)).join('\n\n') })).pinned, 'tall');
  await pane.locator('.bottom .pinned [data-card="tall"]').waitFor({ timeout: 15000 });
  await page.waitForTimeout(600);
  await title.click();
  await until(async () => await title.getAttribute('aria-expanded') === 'true', 'the report opened on the short window');
  await page.waitForTimeout(600);
  const top = (await box(pane.locator('.hist'))).top, close = card.locator('[data-card-close]');
  // What a click at each one's centre lands on: '' when it is the button itself, else the covering element.
  const hit = (l) => l.evaluate((el) => { const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, h = document.elementFromPoint(x, y);
    return h === el ? '' : `${Math.round(x)},${Math.round(y)} hits ${h ? h.outerHTML.slice(0, 160) : 'nothing'}`; });
  const [tb, cb] = [await box(title), await box(close)];
  await shot(page, 'window4-short-open');
  assert.ok(tb.top >= top - 1 && cb.top >= top - 1, 'opened on a short window, the title and close sit under the history top: ' + JSON.stringify({ top, tb, cb }));
  assert.deepEqual([await hit(title), await hit(close)], ['', ''], 'a click on the title and on the close reaches them');
  // Not just their centres: no part of the title or its x sits under a top-right card or the sprint card (an x centred in the
  // gap between two cards passed before).
  const over = (l) => l.evaluate((el) => { const r = el.getBoundingClientRect();
    return [...document.querySelectorAll('#cards .card, .pane > .sprint')].map((o) => [o.className, o.getBoundingClientRect()]).filter(([, b]) => b.height && b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top).map(([n, b]) => `${n} ${Math.round(b.left)},${Math.round(b.top)}-${Math.round(b.right)},${Math.round(b.bottom)} over ${el.className} ${Math.round(r.left)},${Math.round(r.top)}-${Math.round(r.right)},${Math.round(r.bottom)}`); });
  const under = [...await over(title), ...await over(close)];
  console.log('P9_W4_SHORT ' + JSON.stringify({ top, tb, cb, under, body: await card.evaluate((el) => getComputedStyle(el.closest('.tuck')).getPropertyValue('--tuck-body')) }));
  assert.deepEqual(under, [], 'nothing covers any part of the opened report\'s title or its x');
  await close.click();
  await until(async () => await card.count() === 0, 'closed from its x on the short window');
  assert.deepEqual(errors, []);
  console.log('PASS window-4: report arrives folded to its title above the box, the last chat row clear of it; its title slides it up (aria-expanded) and down (Enter); the chat box, scroll and last row stay put opened and closed; a new report arrives folded and takes no height from the history; a pinned card and the report show two titles; on a short window under a tall pin, the opened report keeps its title and close inside the pane and clickable');
});

// O109-repeat-visible: a message P9 resent after a restart carries repeat: true on its user event (chat.mjs deliver, the
// pause and the steer paths); the agent saw the label, so the chat's own row says it too. A plain message and one the
// event marks repeat: false say nothing; a steered resend and a note's resend say it beside their own heading.
test('O109-repeat-visible: a resent message says on its row that it may be a repeat', { timeout: 90000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const chat = (await call(instance, '/chat', 'POST', { provider: 'claude', title: 'Resent' })).conversation;
  const db = new DatabaseSync(path.join(instance.directory, '.local', 'state', 'p9-foundation', 'p9.db'), { timeout: 5000 });
  try {
    const add = db.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)');
    for (const data of [{ text: 'plain one' }, { text: 'resent one', repeat: true }, { text: 'said no', repeat: false },
      { text: 'steered resend', steered: true, repeat: true }, { text: 'note resend', info: true, repeat: true }]) add.run(chat, 'user', JSON.stringify(data), Date.now());
  } finally { db.close(); }
  const { page, errors } = await launch(t, instance);
  await page.locator(`#navList .row[data-chat="${chat}"]`).click();
  const row = (text) => page.locator(`.pane[data-id="${chat}"] .msg.user`, { hasText: text });
  await row('note resend').waitFor({ timeout: 20000 });
  const seen = {};
  for (const text of ['plain one', 'resent one', 'said no', 'steered resend', 'note resend']) seen[text] = await row(text).locator('.who').innerText();
  const says = (w) => w.includes('sent again after a restart, may be a repeat');
  assert.deepEqual(Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, says(v)])),
    { 'plain one': false, 'resent one': true, 'said no': false, 'steered resend': true, 'note resend': true }, JSON.stringify(seen));
  assert.ok(seen['note resend'].startsWith('Note from'), 'the note keeps its own heading: ' + seen['note resend']);
  // One heading line (.who is flex): the label is in the heading's own text, not an item of its own with a gap before it.
  assert.equal(await row('resent one').locator('.who[data-repeat]').count(), 1);
  assert.equal(await row('resent one').locator('.who > *').count(), 0, 'the label is a separate flex item');
  assert.ok(!(await row('resent one').innerText()).includes('[P9:'), 'the agent\'s label text is not drawn into the message');
  await shot(page, 'o109-repeat-visible');
  assert.deepEqual(errors, []);
  console.log('PASS O109-repeat-visible: ' + JSON.stringify(seen));
});
