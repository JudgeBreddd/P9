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
import { daemon, http, authenticated, root } from './helpers.mjs';

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

  // Two workers wait at once: an approval in Kid 1, a question in Kid 2. Both are drawn in the parent's chat.
  await a.tool('send_chat', { chat: kids[0], text: 'permission' });
  await a.tool('send_chat', { chat: kids[1], text: 'ask' });
  await until(async () => (await a.tool('wait_chat', { chat: kids[0] })).waiting?.kind === 'approval' && (await a.tool('wait_chat', { chat: kids[1] })).waiting?.kind === 'question', 'both workers waiting');
  await row(parent).click();
  const pane = page.locator(`.pane[data-id="${parent}"]`);
  const card = (id) => pane.locator(`.pending[data-ask="${id}"][data-ask-sub]`);
  await card(kids[0]).waitFor({ timeout: 15000 }); await card(kids[1]).waitFor({ timeout: 15000 });
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
  assert.match(await group.locator('[data-dg-what]').innerText(), /hand parts of a job to workers/);
  await until(async () => await group.locator('[data-dg-start]').inputValue() === 'agent' && !(await group.locator('[data-dg-start]').isDisabled()), 'the daemon\'s value in Settings');
  assert.deepEqual(await group.locator('[data-dg-start] option').allInnerTexts(), ['Off', 'Ask me first', 'Agent decides']);
  await group.locator('[data-dg-start]').selectOption('ask');
  await until(async () => (await call(instance, '/delegation')).start === 'ask', 'Ask me first saved');
  // Workers per chat: one row per worker, each with its own agent, model and effort.
  assert.equal(await group.locator('[data-dg-max]').inputValue(), '20');
  await group.locator('[data-dg-max]').selectOption('3');
  await until(async () => (await call(instance, '/delegation')).max === 3 && await group.locator('[data-dg-worker]').count() === 3, 'three worker rows');
  assert.equal(await group.locator('[data-dg-model]').count(), 0, 'a row left on the parent\'s offers a model');
  await group.locator('[data-dg-agent="0"]').selectOption('claude');
  await group.locator('[data-dg-model="0"]').waitFor();
  await group.locator('[data-dg-model="0"]').selectOption('opus');
  await until(async () => (await call(instance, '/delegation')).workers[0].model === 'opus', 'Worker 1\'s model saved');
  await group.locator('[data-dg-effort="0"]').selectOption('high');
  await group.locator('[data-dg-agent="1"]').selectOption('codex');
  await group.locator('[data-dg-agent="2"]').selectOption('profile:' + profile.id);
  await until(async () => { const d = await call(instance, '/delegation'); return d.start === 'ask' && JSON.stringify(d.workers) === JSON.stringify([{ agent: 'claude', model: 'opus', effort: 'high' },
    { agent: 'codex', model: '', effort: '' }, { agent: 'profile:' + profile.id, model: '', effort: '' }]); }, 'every pick saved together');
  assert.deepEqual(await group.locator('[data-dg-model="2"] option').allInnerTexts(), ['glm-5.3', 'kimi-k3:cloud'], 'a profile row offers something other than the profile\'s models');
  // Changing a row's agent drops the model and effort that belonged to the other agent.
  await group.locator('[data-dg-agent="0"]').selectOption('codex');
  await until(async () => { const w = (await call(instance, '/delegation')).workers[0]; return w.agent === 'codex' && w.model === '' && w.effort === ''; }, 'the old agent\'s model dropped');
  await group.locator('[data-dg-agent="0"]').selectOption('claude');
  await group.locator('[data-dg-model="0"]').selectOption('opus');
  await until(async () => (await call(instance, '/delegation')).workers[0].model === 'opus', 'Worker 1 back on opus');
  await page.locator('#setDelegation').scrollIntoViewIfNeeded();
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
  const who = page.locator(`.pane[data-id="${parent}"] .msg.user .who`).last();
  await until(async () => (await who.innerText()).startsWith('Note from Kid 1 · information only'), 'the note under its sender\'s name');
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
    await page.locator('#chats > .pane').first().waitFor({ timeout: 15000 });
    assert.deepEqual(errors, []);
    await shot(page, 'connecting-chat');
  } finally { resume(); }
  await page.locator('#dataNote', { hasText: 'Chat live' }).waitFor({ timeout: 20000 });
  console.log('CONNECTING_CHAT_PANES_AFTER ' + await page.locator('#chats > .pane').count());
});

test('project cut keeps an opened worker group together', { timeout: 60000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const { app, page } = await launch(t, instance);
  await app.evaluate(({ ipcMain }) => {
    const now = Date.now(), project = { id: 'project1', name: 'Workers', work: { kind: 'p9', folder: '' }, files: [] };
    const conv = (id, extra = {}) => ({ id, provider: 'claude', title: id, folder: '~', created: now, state: 'running', sent: 1, used: now, project: 'project1', archived: false, parent: null, ...extra });
    const rows = [conv('lead', { used: now + 100 }), ...Array.from({ length: 4 }, (_, i) => conv('worker' + i, { parent: 'lead' })), ...Array.from({ length: 6 }, (_, i) => conv('chat' + i))];
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
  await zone.locator('[data-subs="lead"]').click({ timeout: 15000 });
  for (let i = 0; i < 4; i++) await zone.locator(`[data-chat="worker${i}"]`).waitFor({ timeout: 5000 });
  assert.equal(await zone.locator('[data-showmore]').innerText(), 'Show 2 more');
  const order = await zone.locator('.kids > .rowwrap, .kids > .subs').evaluateAll(els => els.map(e => e.matches('.subs') ? 'toggle' : e.querySelector('[data-chat]')?.dataset.chat));
  assert.deepEqual(order.slice(order.indexOf('lead') + 1, order.indexOf('lead') + 5).sort(), ['worker0', 'worker1', 'worker2', 'worker3']);
  assert.equal(order[order.indexOf('lead') + 5], 'toggle');
  await shot(page, 'sidebar-project-cut-workers');
});
