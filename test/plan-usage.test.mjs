// USE-1: plan_usage gives agents the Usage page's numbers for every catalog agent, with the pace mark, the reading's age,
// stale and pool. A provider added as catalog data with its own reader shows up with no other change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { daemon, http, authenticated, root } from './helpers.mjs';
import * as limits from '../apps/server/limits.mjs';
import { CATALOG, AGENT_IDS } from '../apps/server/agents.mjs';
import { DELEGATE_TOOLS } from '../apps/server/delegate.mjs';
import { paceOf } from '../apps/web/src/helpers.mjs';
import { Client } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const MIN = 60000, HOUR = 60 * MIN, NOW = Date.UTC(2026, 10, 22, 12);
const report = limits.usageReport ?? (() => ({ providers: {} }));

test('plan_usage: a made-up third provider with a stub reader shows next to the real ones; an old reading is stale', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-plan-usage-'));
  const third = { ...CATALOG[0], id: 'third', usage: { reader: 'stub-third', staleMs: 10 * MIN, pool: 'third-plan', hideSignedOut: false } };
  const readers = { ...limits.READERS, 'stub-third': () => ({ fiveHour: { usedPercent: 90, resetsAt: NOW + HOUR, windowMins: 300 },
    sevenDay: { usedPercent: 10, resetsAt: NOW + 42 * HOUR, windowMins: 10080 }, credits: 7, asOf: NOW - 20 * MIN }) };
  const got = report(await limits.planLimits({ home, catalog: [...CATALOG, third], readers, now: NOW }), NOW);
  assert.deepEqual(Object.keys(got.providers), [...AGENT_IDS, 'third'], 'every catalog agent has a key, the third beside the real ones');
  const t = got.providers.third;
  assert.deepEqual([t.fiveHour.pace, t.sevenDay.pace, t.credits, t.ageMs, t.stale, t.pool], ['ahead', 'headroom', 7, 20 * MIN, true, 'third-plan']);
  for (const id of AGENT_IDS) assert.equal(got.providers[id], null, id + ' has no reading in an empty home');
  const fresh = report(await limits.planLimits({ home, catalog: [third], readers: { 'stub-third': () => ({ fiveHour: null, asOf: NOW - MIN }) }, now: NOW }), NOW);
  assert.deepEqual([fresh.providers.third.stale, fresh.providers.third.ageMs, fresh.providers.third.fiveHour], [false, MIN, null]);
  assert.deepEqual(report({ a: null, signedOut: ['a'] }, NOW), { providers: { a: null }, signedOut: ['a'] }, 'a signed-out provider is null and listed');
});

test('plan_usage: the pace word is the Usage page\'s, and the tool names no agent', () => {
  const pace = limits.paceState ?? (() => undefined);
  for (const used of [0, 30, 74, 75, 80, 85, 86, 100]) for (const left of [-MIN, 0, HOUR, 3 * HOUR, 6 * HOUR]) for (const mins of [300, 10080]) {
    const w = { usedPercent: used, resetsAt: NOW + left, windowMins: mins };
    assert.equal(pace(w, NOW), paceOf(w, mins, NOW)?.state ?? null, JSON.stringify(w));
  }
  const tool = DELEGATE_TOOLS((properties, required = []) => ({ type: 'object', properties, required })).find(([name]) => name === 'plan_usage');
  assert.ok(tool, 'plan_usage is a tool');
  assert.doesNotMatch(tool[1], /claude|codex/i);
});

test('plan_usage: through the daemon, an agent and GET /usage/plan read the numbers /usage shows', { timeout: 90000 }, async (t) => {
  const fake = path.join(root, 'test/fake-acp-agent.mjs');
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake, '--codex-usage', path.join(root, 'test/fake-codex-app-server.mjs')] }));
  await mkdir(path.join(instance.directory, '.codex'), { recursive: true });
  await writeFile(path.join(instance.directory, '.codex', 'auth.json'), '{}');
  const call = (route, method = 'GET', body) => http({ socketPath: instance.credentials.socketPath, route, method,
    headers: { ...authenticated(instance.credentials), ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body) }).then((r) => JSON.parse(r.text));
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
  let got;
  for (let i = 0; i < 40 && !got?.providers?.codex; i += 1) {
    const result = await client.callTool({ name: 'plan_usage', arguments: {} });
    assert.ok(!result.isError, result.content[0].text);
    got = JSON.parse(result.content[0].text);
    if (!got.providers.codex) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const page = (await call('/usage')).limits;
  // The route and the tool answer from one function: the same, but for when the reading was taken (a poll may land between the calls).
  assert.equal((await http({ socketPath: instance.credentials.socketPath, route: '/usage/plan' })).status, 401);
  const route = await call('/usage/plan'), ageless = (r) => JSON.stringify(r, (k, v) => (k === 'ageMs' || k === 'asOf' ? undefined : v));
  assert.equal(ageless(route), ageless(got));
  assert.deepEqual(Object.keys(got.providers), AGENT_IDS);
  const codex = got.providers.codex;
  assert.deepEqual([codex.fiveHour.usedPercent, codex.sevenDay.usedPercent, codex.pool, codex.stale], [page.codex.fiveHour.usedPercent, page.codex.sevenDay.usedPercent, 'codex', false]);
  assert.ok(['ahead', 'on', 'headroom', null].includes(codex.fiveHour.pace) && 'pace' in codex.sevenDay);
  assert.ok(codex.ageMs >= 0 && codex.ageMs < 30000, 'read just now');
  console.log('PASS plan_usage through the daemon: ' + JSON.stringify([codex.fiveHour.usedPercent, codex.fiveHour.pace, codex.ageMs]));
});
