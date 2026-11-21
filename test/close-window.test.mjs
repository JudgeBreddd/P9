// Row 721 / O132, the window side: a worker its lead closes (stop_chat close: true) leaves the sprint card, the sidebar and
// the report pinned above the message box, live and after a reload. Under the agent lock a close only stops, so the
// worker stays. Real Electron, the real daemon, the fake agent and the MCP client its agent is handed (as delegate-window).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { Client } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { daemon, http, authenticated, root, watchStartup, waitStartup } from './helpers.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-p9-op': randomUUID() }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => ({ status: r.status, ...JSON.parse(r.text) }));
const until = async (check, what, ms = 20000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 200))) if (await check()) return;
  assert.fail('timed out: ' + what);
};
const events = async (instance, id) => (await call(instance, '/chat/events?after=0&only=' + id)).events;
const shot = async (page, name) => { if (!process.env.GITHUB_ACTIONS) { await page.waitForTimeout(400); console.log('P9_SHOT ' + name + ' ' + (await page.screenshot()).toString('base64')); } };

async function launch(t, instance) {
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-close-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow(), watch = watchStartup(page);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.unmaximize(); w.setContentSize(1568, 1348); });
  await page.setViewportSize({ width: 1568, height: 1348 }).catch(() => {});
  // O71: timed out on CI 3 times (11-20, 11-21), the O58 (l) shape; a timeout prints the page's stage.
  await waitStartup(page, watch, page.locator('#dataNote', { hasText: 'Chat live' }), { what: 'Chat live', timeout: 20000 });
  return { page, errors, watch };
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

test('close-window: a worker its lead closes leaves the card, the sidebar and the pinned report, live and after a reload; under the agent lock it stays', { timeout: 240000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  await call(instance, '/delegation', 'POST', { start: 'agent', max: 20, workers: [] });
  await call(instance, '/file-protection', 'POST', { on: false });
  const parent = (await call(instance, '/chat', 'POST', { provider: 'claude', title: 'Lead' })).conversation;
  await call(instance, `/chat/${parent}/prompt`, 'POST', { text: 'mcp' });
  const a = await tools(t, instance, parent);
  await writeFile(path.join(instance.workspace, '.gitignore'), '*\n!.gitignore\n');
  execFileSync('git', ['init', '-q', '-b', 'main', instance.workspace]);
  execFileSync('git', ['-C', instance.workspace, 'add', '.']);
  execFileSync('git', ['-C', instance.workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base']);
  const head = execFileSync('git', ['-C', instance.workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const open = async (item) => { const made = await a.tool('open_chat', { text: 'first', item, done_means: 'x', checks: ['Tests pass'] }); assert.ok(made.chat, JSON.stringify(made)); await a.done(made.chat); return made.chat; };
  const live = await open('W0'); // keeps the card on screen
  const kid = await open('W1'), held = await open('W2');
  // W1 reports ready, so its report is pinned above the message box.
  await a.tool('send_chat', { chat: kid, text: 'mcp' });
  const k = await tools(t, instance, kid);
  await a.done(kid);
  await a.tool('send_chat', { chat: kid, text: 'late' }); // ready needs the worker mid-turn
  const r = await k.tool('ready', { commit: head, results: [{ check: 'Tests pass', result: 'Passed' }], weakest: 'x' }); assert.ok(r.ready, JSON.stringify(r));
  await a.done(kid);

  const { page, errors, watch } = await launch(t, instance);
  await page.locator(`#navList .row[data-chat="${parent}"]`).click();
  const pane = page.locator(`.pane[data-id="${parent}"]`), card = pane.locator('.sprint');
  const onCard = (id) => card.locator(`[data-sprint-open="${id}"]`).count();
  const inSidebar = (id) => page.locator(`#navList .row[data-chat="${id}"]`).count(); // attached: worker rows fold under their lead
  const pin = pane.locator(`.card-pin[data-card="ready-${kid}"]`);
  const where = async (id) => ({ card: await onCard(id), sidebar: await inSidebar(id), pinned: await pane.locator(`.card-pin[data-card="ready-${id}"]`).count() });
  await pin.waitFor({ timeout: 20000 });
  await card.locator(`[data-sprint-open="${held}"]`).waitFor({ state: 'attached', timeout: 20000 }); // the card's rows fold away
  assert.deepEqual(await where(kid), { card: 1, sidebar: 1, pinned: 1 }, 'before the close the worker is on the card, in the sidebar and its report pinned');
  await shot(page, 'close-before');

  // The lead closes W1 with the window open: it leaves all three without a reload.
  const closed = await a.tool('stop_chat', { chat: kid, close: true });
  assert.equal(closed.action, 'stopped', JSON.stringify(closed));
  let last;
  await until(async () => { last = await where(kid); return !last.card && !last.sidebar && !last.pinned; }, 'the closed worker is still drawn').catch((e) => { throw new Error(e.message + ' ' + JSON.stringify(last)); });
  await pane.locator(`.hist [data-report="ready-${kid}"]`).waitFor({ state: 'attached', timeout: 5000 }); // its report scrolls with the chat, as an archived one does
  await shot(page, 'close-live');

  // Under the agent lock a close stops W2 and archives nothing, so it stays on the card and in the sidebar.
  await call(instance, '/agent-lock', 'POST', { on: true });
  assert.equal((await a.tool('stop_chat', { chat: held, close: true })).action, 'stopped');
  await call(instance, '/agent-lock', 'POST', { on: false });

  await page.reload();
  await waitStartup(page, watch, page.locator('#dataNote', { hasText: 'Chat live' }), { what: 'Chat live after a reload', timeout: 20000 });
  await page.locator(`#navList .row[data-chat="${parent}"]`).click();
  await card.locator(`[data-sprint-open="${live}"]`).waitFor({ state: 'attached', timeout: 20000 });
  assert.deepEqual(await where(kid), { card: 0, sidebar: 0, pinned: 0 }, 'the closed worker came back after a reload');
  assert.deepEqual([await onCard(held), await inSidebar(held)], [1, 1], 'a close under the agent lock took the worker off the card or the sidebar');
  assert.deepEqual([await onCard(live), await inSidebar(live)], [1, 1], 'the live worker left');
  await shot(page, 'close-reloaded');
  assert.deepEqual(errors, []);
  console.log('PASS close-window: a closed worker left the card, the sidebar and the pinned report live and after a reload; a close under the agent lock left the worker on the card and in the sidebar');
});
