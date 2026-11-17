// Row 730 / 709, end to end: a queue worker's ring on the sprint card counts its role's items in the plan, and fills from a
// real ready and a real pass verdict (no mocked queue). Real Electron, the real daemon, the fake agent and the MCP clients
// the agents are handed (as close-window).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
const shot = async (page, name) => { if (!process.env.GITHUB_ACTIONS) { await page.waitForTimeout(400); console.log('P9_SHOT ' + name + ' ' + (await page.screenshot()).toString('base64')); } };

async function launch(t, instance) {
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-ring-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1400, height: 900 }).catch(() => {});
  await page.locator('#dataNote', { hasText: 'Chat live' }).waitFor({ timeout: 20000 });
  return { page, errors };
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

test('ring-window: a queue worker\'s ring shows its plan items and fills from a real ready and pass verdict', { timeout: 240000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  await call(instance, '/delegation', 'POST', { start: 'agent', max: 20, workers: [] });
  await call(instance, '/file-protection', 'POST', { on: false });
  // A project, so the reviewer sits beside the worker and may give it a verdict.
  const project = (await call(instance, '/projects', 'POST', { name: 'Ring', work: { kind: 'new', parent: '', name: 'ring' } })).project.id;
  const lead = (await call(instance, '/chat', 'POST', { provider: 'claude', title: 'Lead', project })).conversation;
  await call(instance, `/chat/${lead}/prompt`, 'POST', { text: 'mcp' });
  const a = await tools(t, instance, lead);
  const w = await a.tool('open_chat', { text: 'mcp', title: 'Daemon', key: 'daemon' }), r = await a.tool('open_chat', { text: 'mcp', title: 'Reviewer', key: 'review' });
  assert.ok(w.chat && r.chat, JSON.stringify([w, r]));
  const worker = await tools(t, instance, w.chat), reviewer = await tools(t, instance, r.chat);
  await a.done(w.chat); await a.done(r.chat);
  // The plan: two items for the daemon role, one for another role.
  const sprint = [path.join(path.dirname(instance.workspace), '.local', 'state', 'p9-foundation'), instance.state]
    .map((b) => path.join(b, 'sprints', lead)).find((f) => existsSync(path.join(f, 'notes', 'daemon.md')));
  assert.ok(sprint, 'found the sprint folder');
  await writeFile(path.join(sprint, 'sprint.md'), '# Plan\n\n## Items\n- [ ] d1: one. Role: daemon.\n- [ ] w1: other. Role: window.\n- [ ] d2: two. Role: daemon.\n');
  const folder = path.resolve(instance.workspace, w.folder);
  await writeFile(path.join(folder, '.gitignore'), '*\n!.gitignore\n'); // ready refuses a dirty folder
  execFileSync('git', ['init', '-q', '-b', 'main', folder]);
  execFileSync('git', ['-C', folder, 'add', '.']);
  execFileSync('git', ['-C', folder, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base']);
  const head = execFileSync('git', ['-C', folder, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  const { page, errors } = await launch(t, instance);
  await page.locator(`#navList .row[data-chat="${lead}"]`).click();
  const pane = page.locator(`.pane[data-id="${lead}"]`), card = pane.locator('.sprint');
  const ringOf = card.locator(`[data-sprint-open="${w.chat}"] .sp-ring`);
  await ringOf.waitFor({ state: 'attached', timeout: 20000 });
  if (await pane.locator('.sprint[data-folded="true"]').count()) await pane.locator('[data-sprint-fold]').click(); // open, so the shots show the ring
  const ringIs = async (want, why) => { let got;
    await until(async () => { got = await ringOf.getAttribute('aria-label'); return got === want; }, why).catch(() => { throw new Error(why + ': wanted "' + want + '", the ring says "' + got + '"'); }); };
  await ringIs('0 of 2 items passed', 'a queue worker with two plan items and nothing passed');
  await shot(page, 'ring-0-of-2');

  // A real ready (inside a turn: 'late' keeps one running) and a real pass verdict from the reviewer.
  await a.tool('send_chat', { chat: w.chat, text: 'late' });
  const ready = await worker.tool('ready', { commit: head, results: [{ check: 'unit', result: 'pass' }], weakest: 'none' });
  assert.equal(ready.ready?.item, 'd1', JSON.stringify(ready));
  await a.done(w.chat);
  const pass = await reviewer.tool('verdict', { chat: w.chat, commit: ready.ready.commit, result: 'pass', note: 'ok' });
  assert.equal(pass.review?.state, 'passed', JSON.stringify(pass));
  await ringIs('1 of 2 items passed', 'd1 passed review');
  assert.equal(await ringOf.locator('b').textContent(), '1/2');
  // P9's "start your next item" is the worker's next message: it drops ready and verdict, and the pass stays counted.
  await a.done(w.chat);
  await ringIs('1 of 2 items passed', 'the pass stays after the next message');
  const dash = await ringOf.locator('circle.a').getAttribute('stroke-dasharray');
  assert.ok(parseFloat(dash) > 0, 'the ring is drawn part full: ' + dash);
  await shot(page, 'ring-1-of-2');
  assert.deepEqual(errors, []);
  console.log('PASS ring-window: the ring read 0 of 2, then 1 of 2 after a real ready and pass verdict, and kept it after the next message');
});
