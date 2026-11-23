// Row "A sprint never ends", the phone side: a worker its lead closes for real (stop_chat close: true, which archives it since
// #255) leaves the phone's pinned report and the phone's Chats list, live and after a reload. close-window checks the window;
// phone-o109's window-3 test archives through the route on a seeded chat. This one runs the real close path: the real daemon,
// the fake agent and the MCP client its lead is handed (as close-window), with the phone signed in remotely.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { Client } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { remoteDaemon, root } from './helpers.mjs';
import { phone } from './phone-c16-helpers.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const shot = async (page, name) => { const png = await page.screenshot({ type: 'png' }); if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png.toString('base64')); };
const until = async (check, what, ms = 20000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 200))) if (await check()) return;
  assert.fail('timed out: ' + what);
};
async function tools(t, server, conversation) {
  let entry;
  await until(async () => {
    const hit = (await server.desk('/chat/events?after=0&only=' + conversation)).body.events.find((e) => e.data?.content?.text?.startsWith('mcp:'));
    if (hit) [entry] = JSON.parse(hit.data.content.text.slice(4)); return !!hit;
  }, 'the MCP entry');
  const client = new Client({ name: 'p9-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env: Object.fromEntries(entry.env.map(({ name, value }) => [name, value])) }));
  t.after(() => client.close());
  const tool = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  const done = async (chat) => { for (;;) { const got = await tool('wait_chat', { chat }); if (!got.timedOut) return got; } };
  return { tool, done };
}

test('phone-close: a worker its lead closes leaves the phone\'s pinned report and Chats list, live and after a reload', { timeout: 240000 }, async (t) => {
  const server = await remoteDaemon(t, { args: ['--acp-override', fake] });
  const desk = async (route, body) => { const r = await server.desk(route, 'POST', body); assert.ok(r.status < 300, route + ' ' + r.status + ' ' + JSON.stringify(r.body)); return r.body; };
  await desk('/delegation', { start: 'agent', max: 20, workers: [] });
  await desk('/file-protection', { on: false });
  const lead = (await desk('/chat', { provider: 'claude', title: 'Lead' })).conversation;
  await desk(`/chat/${lead}/prompt`, { text: 'mcp' });
  const a = await tools(t, server, lead);
  const open = async (item) => { const made = await a.tool('open_chat', { text: 'first', item, done_means: 'x', checks: ['Tests pass'] }); assert.ok(made.chat, JSON.stringify(made)); await a.done(made.chat); return made.chat; };
  await writeFile(path.join(server.workspace, '.gitignore'), '*\n!.gitignore\n');
  execFileSync('git', ['init', '-q', '-b', 'main', server.workspace]);
  execFileSync('git', ['-C', server.workspace, 'add', '.']);
  execFileSync('git', ['-C', server.workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base']);
  const head = execFileSync('git', ['-C', server.workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  await open('W0'); // keeps the sprint card pinned
  const kid = await open('W1');
  await a.tool('send_chat', { chat: kid, text: 'mcp' });
  const k = await tools(t, server, kid);
  await a.done(kid);
  await a.tool('send_chat', { chat: kid, text: 'late' }); // ready needs the worker mid-turn
  const r = await k.tool('ready', { commit: head, results: [{ check: 'Tests pass', result: 'Passed' }], weakest: 'x' }); assert.ok(r.ready, JSON.stringify(r));
  await a.done(kid);

  const { page } = await phone(t, server);
  const pinned = () => page.evaluate((id) => document.querySelectorAll(`#pinned [data-card="ready-${id}"]`).length, kid);
  const listed = async () => { await page.evaluate(() => history.replaceState(null, '', '#')); await page.reload(); await page.waitForSelector('h1:text("Chats")');
    await page.locator(`[data-chat="${lead}"]`).first().waitFor({ state: 'attached', timeout: 20000 }); return page.locator(`[data-chat="${kid}"]`).count(); };
  const openLead = async () => { await page.evaluate((id) => history.replaceState(null, '', '#chat=' + id), lead); await page.reload();
    // the report's own row in the chat is drawn once the chat has loaded (hidden while pinned, shown once it is not)
    await page.locator('#events article[data-kind="report"]').first().waitFor({ state: 'attached', timeout: 30000 }); };
  const before = await listed();
  assert.equal(before, 1, 'before the close the worker is not in the phone\'s Chats list, so its leaving proves nothing');
  await openLead();
  assert.equal(await pinned(), 1, 'before the close the worker\'s report is pinned on the phone');
  await shot(page, 'phone-close-before');

  // The lead closes W1 with the phone open on the lead: the report leaves without a reload.
  const closed = await a.tool('stop_chat', { chat: kid, close: true });
  assert.equal(closed.action, 'stopped', JSON.stringify(closed));
  await until(async () => (await pinned()) === 0, 'the closed worker\'s report is still pinned on the phone');
  assert.equal((await server.desk('/chat')).body.conversations.find((c) => c.id === kid)?.archived, true, 'close did not archive the worker');
  await shot(page, 'phone-close-live');

  await openLead();
  assert.equal(await pinned(), 0, 'the closed worker\'s report came back after a reload');
  assert.equal(await listed(), 0, `the closed worker is still in the phone's Chats list (before the close: ${before})`);
  await shot(page, 'phone-close-reloaded');
  console.log(`PASS phone-close: closed worker's report left the phone live and after a reload; Chats list rows ${before} -> 0`);
});
