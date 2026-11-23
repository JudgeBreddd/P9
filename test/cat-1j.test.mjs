// CAT-1j: an agent added to the catalog as data only (test/third-agent.mjs puts Kestrel into apps/server/agents.mjs as
// it loads) shows up everywhere the two built in do: GET /agents (what the desktop's and the phone's pickers and the
// sprint pickers read), the usage page's limits, plan_usage, and what the agents are told they can start
// (list_providers, open_chat, new_sprint's roles.json). The web side of each picker is checked against a made-up agent
// in GET /agents' answer by chat-bar, phone-parity, cat-1h-web-agents and use-1-web.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { daemon, http, authenticated, root } from './helpers.mjs';
import { Client } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const hook = path.join(root, 'test/third-agent.mjs');

test('CAT-1j: a catalog-only third agent is in every server table, the usage limits and each tool text that lists what can start', () => {
  const script = `
    const a = await import('./apps/server/agents.mjs'), d = await import('./apps/server/delegate.mjs'), l = await import('./apps/server/limits.mjs');
    const tools = Object.fromEntries(d.DELEGATE_TOOLS((properties) => ({ properties })).map(([name, text, input]) => [name, { text, input }]));
    const limits = await l.planLimits({ home: process.env.P9_EMPTY_HOME });
    console.log(JSON.stringify({ ids: a.AGENT_IDS, public: a.publicAgents().agents.find((x) => x.id === 'kestrel'), tier: a.TIER.kestrel, narrow: a.NARROW.kestrel,
      limits: Object.keys(limits), report: Object.keys(l.usageReport(limits).providers),
      listProviders: tools.list_providers.text, newSprint: tools.new_sprint.text, openChat: tools.open_chat.input.properties.provider.description,
      openMode: tools.open_chat.input.properties.mode.description }));`;
  const got = JSON.parse(execFileSync(process.execPath, ['--import', hook, '--input-type=module', '-e', script], { cwd: root, encoding: 'utf8',
    env: { ...process.env, P9_EMPTY_HOME: path.join(root, 'test', 'no-such-home') } }));
  assert.deepEqual(got.ids, ['claude', 'codex', 'kestrel']);
  assert.deepEqual(got.public.modes, [{ name: 'Look only', tier: 0 }, { name: 'Ask first', tier: 1 }, { name: 'Free run', tier: 4 }]);
  assert.deepEqual([got.public.start, got.public.auto, got.public.narrow, got.public.usage, got.public.signIn], ['Ask first', 'Ask first', 'Look only', 'kestrel-plan', 'device-code']);
  assert.deepEqual([got.tier, got.narrow], [{ 'Look only': 0, 'Ask first': 1, 'Free run': 4 }, 'look']);
  assert.deepEqual([got.limits, got.report], [['claude', 'codex', 'kestrel'], ['claude', 'codex', 'kestrel']], 'the usage page and plan_usage hold a key for it');
  assert.match(got.openChat, /^claude, codex, kestrel, or profile:<id>/);
  assert.match(got.openMode, /Kestrel Agent: Look only, Ask first, Free run\./);
  assert.match(got.listProviders, /roles\.json: claude, codex, kestrel with the models/, 'list_providers says it can be named');
  assert.match(got.newSprint, /\(provider claude, codex, kestrel or profile:<id>;/, 'new_sprint says a role may name it');
  console.log('PASS CAT-1j tables: Kestrel in the catalog tables, GET /agents body, the usage limits, plan_usage, open_chat, list_providers and new_sprint');
});

test('CAT-1j: through a real daemon, GET /agents, /usage and list_providers have the catalog-only agent', { timeout: 90000 }, async (t) => {
  const fake = path.join(root, 'test/fake-acp-agent.mjs');
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake], env: { NODE_OPTIONS: '--import ' + hook } }));
  const call = (route, method = 'GET', body) => http({ socketPath: instance.credentials.socketPath, route, method,
    headers: { ...authenticated(instance.credentials), ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body) }).then((r) => JSON.parse(r.text));
  const { agents } = await call('/agents');
  assert.deepEqual(agents.map((a) => a.id), ['claude', 'codex', 'kestrel'], 'the pickers and sprint pickers read this list');
  assert.equal(agents[2].short, 'Kestrel');
  const usage = await call('/usage');
  assert.ok(Object.hasOwn(usage.limits, 'kestrel'), 'the usage page gets a line for it');
  // An agent chat's own MCP server (the fake agent prints it): list_providers offers Kestrel for open_chat and roles.json.
  const { conversation } = await call('/chat', 'POST', { provider: 'claude' });
  let after = (await call('/chat/events?after=0&wait=0')).cursor, hit;
  await call(`/chat/${conversation}/prompt`, 'POST', { text: 'mcp' });
  for (let i = 0; i < 40 && !hit; i += 1) {
    const body = await call(`/chat/events?after=${after}&wait=2000`);
    after = body.cursor;
    hit = body.events.find((e) => e.conversation === conversation && e.data?.content?.text?.startsWith('mcp:'));
  }
  const [entry] = JSON.parse(hit.data.content.text.slice(4));
  const client = new Client({ name: 'p9-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env: Object.fromEntries(entry.env.map(({ name, value }) => [name, value])) }));
  t.after(() => client.close());
  const listed = await client.listTools();
  assert.match(listed.tools.find((x) => x.name === 'list_providers').description, /claude, codex, kestrel with/);
  const providers = JSON.parse((await client.callTool({ name: 'list_providers', arguments: {} })).content[0].text).providers.map((p) => p.provider);
  assert.deepEqual(providers.slice(0, 3), ['claude', 'codex', 'kestrel']);
  console.log('PASS CAT-1j daemon: GET /agents, /usage limits and list_providers (text and answer) have Kestrel');
});
