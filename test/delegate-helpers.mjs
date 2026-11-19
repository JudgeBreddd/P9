// Shared by delegate.test.mjs and delegate-schedule.test.mjs (O195 split the O140 scheduled-prompt tests out, so no
// file nears CI's per-file limit): a daemon on the stand-in agent, its routes, its events, and an MCP client per chat.
import fs from 'node:fs';
import path from 'node:path';
import { daemon, http, authenticated, root } from './helpers.mjs';
// The real MCP SDK client, as in mcp.test.mjs: the tools are called the way an agent's adapter calls them.
import { Client } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
export const fake = path.join(root, 'test/fake-acp-agent.mjs');
// profile.log in the workspace: the stand-in writes there what provider settings each agent start was given (a hash, never the key).
// env: O188's P9_WAKE_AFTER_MS for a test that needs the worker's late wake sooner than 10 min.
export const boot = (t, env) => daemon(t, undefined, false, async ({ workspace }) => { fs.writeFileSync(path.join(workspace, 'profile.log'), ''); return { args: ['--acp-override', fake], ...(env && { env }) }; });
// Settings > Delegation starts on Ask me first; these tests are about the tools, so they run on Agent decides (the
// Delegation test in delegate.test.mjs boots without it).
export const start = async (t, env) => { const instance = await boot(t, env); await call(instance, '/delegation', 'POST', { start: 'agent', max: 20, workers: [] }); return instance; };
export const call = (instance, route, method = 'GET', body) => http({ socketPath: instance.credentials.socketPath, route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  .then((result) => ({ ...result, body: result.text ? JSON.parse(result.text) : null }));
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(instance, match, after = 0) {
  for (let i = 0; i < 40; i += 1) {
    const { body } = await call(instance, `/chat/events?after=${after}&wait=2000`);
    after = body.cursor;
    const hit = body.events.find(match);
    if (hit) return { hit, cursor: after };
  }
  throw new Error('event-timeout');
}
export const events = async (instance, id) => (await call(instance, '/chat/events?after=0&only=' + id)).body.events;
// A chat the user made, and the SDK client started from the MCP entry its agent was handed.
export async function agent(t, instance, more = {}) {
  const { body: { conversation } } = await call(instance, '/chat', 'POST', { provider: 'claude', ...more });
  await call(instance, `/chat/${conversation}/prompt`, 'POST', { text: 'mcp' });
  return connect(t, instance, conversation);
}
// The same client for a chat that was already sent 'mcp' (a worker whose task was that word).
export async function connect(t, instance, conversation, after = 0) {
  const { hit, cursor } = await until(instance, (event) => event.conversation === conversation && event.data?.content?.text?.startsWith('mcp:'), after);
  const [entry] = JSON.parse(hit.data.content.text.slice(4));
  const client = new Client({ name: 'p9-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env: Object.fromEntries(entry.env.map(({ name, value }) => [name, value])) }));
  t.after(() => client.close());
  const tool = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  // Waits until the chat's turn has ended, however many 50 s calls that takes.
  const done = async (chat) => { for (;;) { const got = await tool('wait_chat', { chat }); if (!got.timedOut) return got; } };
  return { conversation, tool, done, cursor };
}
export const rows = async (instance) => (await call(instance, '/chat')).body.conversations;
