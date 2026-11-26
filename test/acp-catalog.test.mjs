// CAT-1c: the ACP version P9 asks each agent for, and whether its start mode is shown at once, are catalog data
// (acp, tellStart), not checks on the id. The values are the ones chat.mjs held before.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as agents from '../apps/server/agents.mjs';
import { acpAsk } from '../apps/server/chat.mjs';
import { daemon, http, authenticated, root } from './helpers.mjs';

// Namespace import, so the asserts (not a missing export) are what fail on code without these.
const ACP = agents.ACP ?? {}, TELL_START = agents.TELL_START ?? {};

test('acp catalog: claude asks ACP 2 (A1) and starts quietly, codex asks ACP 2 and shows its start mode; acpAsk reads the catalog', () => {
  assert.deepEqual(agents.CATALOG.map((a) => [a.id, ACP[a.id], TELL_START[a.id]]), [['claude', 2, false], ['codex', 2, true]]);
  assert.ok(Object.isFrozen(ACP) && Object.isFrozen(TELL_START));
  for (const a of agents.CATALOG) {
    assert.equal(acpAsk(a.id, {}), ACP[a.id], a.id);
    assert.equal(acpAsk(a.id, { P9_ACP_VERSION: '1' }), 1, a.id + ': the environment still puts every agent on 1');
  }
  assert.equal(acpAsk('not-an-agent', {}), 1, 'an unknown agent asks 1');
  assert.equal(acpAsk('constructor', {}), 1, 'a built-in name is not an agent');
});

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => ({ ...r, body: JSON.parse(r.text) }));

test('acp catalog: a codex chat shows its start mode before it connects; a claude chat says its mode with the first prompt', { timeout: 60000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const order = {};
  for (const provider of ['claude', 'codex']) {
    const created = await call(instance, '/chat', 'POST', { provider });
    assert.equal(created.status, 201, created.text);
    const id = created.body.conversation, seen = [];
    assert.equal((await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'hello' })).status, 202);
    for (let after = 0, i = 0; i < 40 && !seen.some((e) => e.conversation === id && e.type === 'turn-end'); i += 1) {
      const { body } = await call(instance, `/chat/events?after=${after}&wait=2000`);
      seen.push(...body.events); after = body.cursor;
    }
    const mine = seen.filter((e) => e.conversation === id && e.type !== 'update');
    order[provider] = mine.map((e) => e.type);
    assert.equal(mine.filter((e) => e.type === 'mode').length, 1, provider + ': its mode is said once');
    assert.equal(mine.find((e) => e.type === 'mode').data.name, agents.CATALOG.find((a) => a.id === provider).auto === 'Auto' ? 'Manual' : 'Auto review', provider);
  }
  const before = (types) => types.indexOf('mode') < types.indexOf('connected');
  assert.deepEqual([before(order.claude), before(order.codex)], [false, true], JSON.stringify(order));
  console.log('PASS codex told Auto review at start, claude told Manual with its first prompt: ' + JSON.stringify(order));
});
