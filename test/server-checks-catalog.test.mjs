// CAT-1d: the server's remaining agent checks read the catalog: the wizard's install bodies, + Add's provider and the
// delegate tool descriptions. With the catalog's two agents the routes behave as before; these cases pin that, and that
// a built-in name is never an agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { CATALOG, AGENT_IDS } from '../apps/server/agents.mjs';
import { DELEGATE_TOOLS } from '../apps/server/delegate.mjs';
import { daemon, http, authenticated, root } from './helpers.mjs';

test('server checks: open_chat names every catalog agent and each one\'s modes by its catalog name', () => {
  const [, , schema] = DELEGATE_TOOLS((properties, required) => ({ properties, required })).find(([name]) => name === 'open_chat');
  const { provider, mode } = schema.properties;
  for (const id of AGENT_IDS) assert.ok(provider.description.startsWith(AGENT_IDS.join(', ') + ', or profile:'), id + ': ' + provider.description);
  for (const a of CATALOG) assert.ok(mode.description.includes(a.name + ': ' + Object.keys(a.modes).join(', ')), a.id + ': ' + mode.description);
});

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  .then((r) => ({ status: r.status, body: JSON.parse(r.text || 'null') }));

test('server checks: install bodies take every catalog agent in any order and nothing else; + Add refuses a built-in name', { timeout: 60000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const every = (value) => Object.fromEntries([...AGENT_IDS].reverse().map((id, i) => [id, value ?? i === 0]));
  // A checkout is not a bundle: a body that passes the check gets not-a-bundle, one that does not gets request-refused.
  assert.deepEqual(await call(instance, '/setup/agents-fetch', 'POST', every()), { status: 409, body: { error: 'not-a-bundle' } });
  for (const body of [every(false), { ...every(), constructor: true }, JSON.parse('{"__proto__": true, ' + JSON.stringify(every()).slice(1)), { toString: true }]) {
    assert.deepEqual(await call(instance, '/setup/agents-fetch', 'POST', body), { status: 400, body: { error: 'request-refused' } }, JSON.stringify(body));
  }
  for (const provider of ['constructor', '__proto__', 'toString', AGENT_IDS, 'nope']) {
    assert.deepEqual(await call(instance, '/mission/build', 'POST', { provider }), { status: 400, body: { error: 'request-refused' } }, JSON.stringify(provider));
  }
  console.log('PASS install bodies follow the catalog in any key order; built-in names and other keys refused; + Add refuses non-agents');
});
