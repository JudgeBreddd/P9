import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { daemon, remoteDaemon, http, authenticated, root, passkeyDevice, enrollDevice } from './helpers.mjs';
// The real MCP SDK client (a dependency of the Claude adapter), so P9's hand-written server is held to what clients send.
import { Client } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const hash = (text) => createHash('sha256').update(text).digest('hex');
const node = process.execPath;
const SETTINGS = { primary: 'projects/AGENTS.md', registry: 'hub/registry.json', waiting: '_waiting', space: 'hub/space.json' };

async function start(t, bom = '') {
  return daemon(t, undefined, false, async ({ directory, workspace }) => {
    for (const folder of ['projects', 'hub', '_waiting']) await mkdir(path.join(workspace, folder));
    await writeFile(path.join(workspace, 'projects/AGENTS.md'), '# Projects\n');
    await writeFile(path.join(workspace, SETTINGS.registry), bom + JSON.stringify({ scripts: [
      { id: 'hello', title: 'Hello', cmd: [node, '-e', 'console.log("hi", process.argv[1])'], args: ['Name'] },
      { id: 'mark', title: 'Mark', cmd: [node, '-e', 'require("fs").writeFileSync("marker", "ran")'] },
      { id: 'gate', title: 'Gate', cmd: [node, '-e', 'console.log(process.argv[1])'], args: [{ label: 'Plan', choices: 'plans' }] }], apps: [{ id: 'editor', title: 'Editor', cmd: ['true'] }], pages: [{ id: 'dash', title: 'Dashboard', url: 'http://127.0.0.1:5000/' }] }, null, 2) + '\n');
    await mkdir(path.join(workspace, 'p1'));
    await writeFile(path.join(workspace, 'p1/plan.md'), '# plan\n');
    await writeFile(path.join(workspace, SETTINGS.space), bom + JSON.stringify({ sections: [{ title: 'Ops', buttons: [{ id: 'ops-up', title: 'Up', cmd: ['true'] }] }] }, null, 2) + '\n');
    await writeFile(path.join(workspace, '_waiting/pick.md'), '# Which one?\n\n**Your answer:** 1 or 2.\nA.\n');
    await writeFile(path.join(directory, 'settings.json'), JSON.stringify(SETTINGS));
    return { args: ['--acp-override', fake, '--settings', path.join(directory, 'settings.json')] };
  });
}
const call = (instance, route, method = 'GET', body, headers = authenticated(instance.credentials)) => http({ socketPath: instance.credentials.socketPath,
  route, method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  .then((result) => ({ ...result, body: result.text ? JSON.parse(result.text) : null }));
async function until(instance, match, after = 0) {
  for (let i = 0; i < 40; i += 1) {
    const { body } = await call(instance, `/chat/events?after=${after}&wait=2000`);
    after = body.cursor;
    const hit = body.events.find(match);
    if (hit) return { hit, cursor: after };
  }
  throw new Error('event-timeout');
}
// A chat, the MCP entry its agent was handed, and the SDK client started from exactly that entry.
async function agent(t, instance, provider = 'claude') {
  const { body: { conversation } } = await call(instance, '/chat', 'POST', { provider });
  await call(instance, `/chat/${conversation}/prompt`, 'POST', { text: 'mcp' });
  const { hit, cursor } = await until(instance, (event) => event.conversation === conversation && event.data?.content?.text?.startsWith('mcp:'));
  const [entry] = JSON.parse(hit.data.content.text.slice(4));
  const client = new Client({ name: 'p9-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env: Object.fromEntries(entry.env.map(({ name, value }) => [name, value])) }));
  t.after(() => client.close());
  const tool = async (name, args = {}, options) => {
    const result = await client.callTool({ name, arguments: args }, undefined, options);
    return { ...JSON.parse(result.content[0].text), isError: result.isError };
  };
  return { conversation, entry, client, tool, cursor };
}
const file = (instance, relative) => readFile(path.join(instance.workspace, relative), 'utf8');

test('MCP: each chat gets its own token; the server answers the SDK client, and a wrong or stopped token gets 401', async (t) => {
  const instance = await start(t);
  const { conversation, entry, client, tool } = await agent(t, instance);
  assert.equal(entry.name, 'p9');
  assert.equal(entry.command, process.execPath);
  assert.deepEqual(entry.env.map(({ name }) => name), ['P9_MCP_SOCKET', 'P9_MCP_TOKEN']);
  assert.match(entry.env[1].value, /^[0-9a-f]{64}$/);
  assert.equal(client.getServerVersion().name, 'p9');
  assert.equal((await client.listTools()).tools.length, 19);
  const schema = JSON.parse((await client.readResource({ uri: 'p9://schema/registry' })).contents[0].text);
  assert.ok(schema.properties.scripts.items.properties.cmd.description);
  const registry = JSON.parse((await client.readResource({ uri: 'p9://registry' })).contents[0].text);
  assert.equal(registry.hash, hash(await file(instance, SETTINGS.registry)));
  assert.equal((await tool('validate_registry', { text: '{"scripts":[{"id":"Bad"}]}' })).invalid[0].reason, 'malformed-record');
  await assert.rejects(client.readResource({ uri: 'p9://nope' }), /-32002|not found/i);

  const mcp = (token, body = { jsonrpc: '2.0', id: 1, method: 'ping' }) => call(instance, '/mcp', 'POST', body, token === undefined ? {} : { 'x-p9-mcp': token });
  assert.equal((await mcp(entry.env[1].value)).status, 200);
  for (const token of [undefined, randomBytes(32).toString('hex'), entry.env[1].value.toUpperCase(), 'x']) assert.equal((await mcp(token)).status, 401, String(token));
  // The desktop's own cookie is not an MCP token.
  assert.equal((await call(instance, '/mcp', 'POST', { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);
  assert.equal((await mcp(entry.env[1].value, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 204);
  assert.equal((await mcp(entry.env[1].value, [1])).body.error.code, -32600);
  await call(instance, `/chat/${conversation}/stop`, 'POST', {});
  assert.equal((await mcp(entry.env[1].value)).status, 401);
  console.log('PASS MCP: SDK client initialized and listed 19 tools; wrong, missing, cookie-only and stopped-chat tokens all 401');
});

test('MCP writes: File protection and the agent lock refuse them; the parser, a stale hash and a clashing ID keep the file', async (t) => {
  const instance = await start(t);
  const { tool } = await agent(t, instance);
  const before = await file(instance, SETTINGS.registry);
  const record = { id: 'build', title: 'Build', cmd: ['make'] };
  assert.equal((await tool('add_button', { record })).error, 'registry-read-only');
  await call(instance, '/file-protection', 'POST', { on: false });
  const typo = await tool('add_button', { record: { ...record, comand: ['x'] } });
  assert.deepEqual([typo.error, typo.detail], ['invalid-record', 'unknown field comand']);
  assert.match((await tool('add_button', { record: { id: 'build', title: 'Build' } })).detail, /^cmd is required/);
  await call(instance, '/agent-lock', 'POST', { on: true });
  assert.equal((await tool('add_button', { record })).error, 'agent-lock-on');
  await call(instance, '/agent-lock', 'POST', { on: false });
  assert.equal(await file(instance, SETTINGS.registry), before);

  const stale = await tool('add_button', { record, hash: hash('something else') });
  assert.deepEqual([stale.error, stale.diskHash], ['hash-conflict', hash(before)]);
  // ops-up is a space button: one ID in both files drops both, so Mission Control would not keep it.
  assert.equal((await tool('add_button', { record: { ...record, id: 'ops-up' } })).error, 'not-accepted');
  assert.equal(await file(instance, SETTINGS.registry), before);

  const added = await tool('add_button', { record, hash: hash(before) });
  assert.equal(added.isError, false);
  assert.equal(added.hash, hash(await file(instance, SETTINGS.registry)));
  assert.ok((await call(instance, '/mission')).body.scripts.some((script) => script.id === 'build'));
  const section = await tool('add_button', { record: { id: 'ops-down', title: 'Down', cmd: ['true'] }, section: ' Ops ' });
  assert.equal(section.file, SETTINGS.space);
  assert.equal((await tool('add_section', { title: 'Ops' })).error, 'duplicate-section');
  assert.equal((await tool('remove_button', { id: 'build' })).records[0].id, 'build');
  assert.equal((await tool('remove_section', { title: 'Ops' })).action, 'removed');
  assert.deepEqual(JSON.parse(await file(instance, SETTINGS.space)).sections, []);
  console.log('PASS MCP writes: protection and lock refused, typo and missing cmd named, stale hash and cross-file ID refused, add/remove landed');
});

test('MCP run_script and answer_needs_you run only after Allow in the chat; Reject, a cancel and the lock run nothing', async (t) => {
  const instance = await start(t);
  const { conversation, tool, cursor } = await agent(t, instance);
  const approval = (after) => until(instance, (event) => event.conversation === conversation && event.type === 'approval', after);
  const answer = (request, optionId) => call(instance, `/chat/${conversation}/answer`, 'POST', { request, answer: { optionId } });

  let pending = tool('run_script', { id: 'mark' });
  let asked = await approval(cursor);
  assert.match(asked.hit.data.toolCall.title, /^P9 Mission Control: run mark \(Mark\): /);
  await answer(asked.hit.data.request, 'reject');
  assert.equal((await pending).error, 'not-allowed');
  await assert.rejects(access(path.join(instance.workspace, 'marker')));

  // A cancelled tool call (the agent's Esc) withdraws the prompt from the chat.
  const controller = new AbortController();
  pending = tool('run_script', { id: 'mark' }, { signal: controller.signal });
  asked = await approval(asked.cursor);
  controller.abort();
  await assert.rejects(pending);
  const withdrawn = await until(instance, (event) => event.type === 'answered' && event.data.request === asked.hit.data.request, asked.cursor);
  assert.equal(withdrawn.hit.data.answer.outcome.outcome, 'cancelled');
  assert.equal((await answer(asked.hit.data.request, 'allow')).status, 404);
  await assert.rejects(access(path.join(instance.workspace, 'marker')));

  // Refused before the user is asked (an approval here would hang the call): Mission's argument rules, and a command
  // too long to show in full, since the user approves exactly the text shown.
  assert.match((await tool('run_script', { id: 'hello', args: ['a\u0000b'] })).reason, /control character U\+0000/);
  assert.match((await tool('run_script', { id: 'hello', args: ['x'.repeat(6000)] })).reason, /too long to show/);
  // choices "plans" is checked against the plan.md list Mission fills, not the word itself.
  assert.match((await tool('run_script', { id: 'gate', args: ['_archive/plan.md'] })).reason, /listed choices/);
  pending = tool('run_script', { id: 'gate', args: ['p1/plan.md'] });
  asked = await approval(withdrawn.cursor);
  assert.match(asked.hit.data.toolCall.title, /"p1\/plan.md"$/);
  await answer(asked.hit.data.request, 'reject');
  assert.equal((await pending).error, 'not-allowed');
  await call(instance, '/agent-lock', 'POST', { on: true });
  assert.equal((await tool('run_script', { id: 'mark' })).error, 'agent-lock-on');
  await call(instance, '/agent-lock', 'POST', { on: false });

  pending = tool('run_script', { id: 'hello', args: ['there'] });
  asked = await approval(asked.cursor);
  assert.match(asked.hit.data.toolCall.title, /"there"$/);
  await answer(asked.hit.data.request, 'allow');
  const ran = await pending;
  assert.deepEqual([ran.done, ran.code], [true, 0]);
  assert.match(ran.output, /hi there/);

  const { items: [item] } = await tool('list_needs_you');
  pending = tool('answer_needs_you', { name: item.name, hash: item.hash, answer: '2' });
  asked = await approval(asked.cursor);
  await answer(asked.hit.data.request, 'allow');
  assert.equal((await pending).action, 'answered');
  assert.match(await file(instance, '_waiting/pick.md'), /^A\. 2$/m);

  assert.equal((await tool('request_restart', { reason: 'settings changed' })).asked, true);
  assert.equal((await until(instance, (event) => event.type === 'restart-request', asked.cursor)).hit.data.reason, 'settings changed');
  console.log('PASS MCP approvals: Reject ran nothing, a cancel withdrew the prompt, the lock refused, Allow ran and answered; restart only asked');
});

test('MCP: the phone listener has no MCP server, even for an enrolled phone holding a live chat\'s token', async (t) => {
  const server = await remoteDaemon(t, { args: ['--acp-override', fake] });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const session = await enrollDevice(server, await passkeyDevice(browser, server, 'phone'));
  const { entry } = await agent(t, server);
  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' }, headers = { 'x-p9-mcp': entry.env[1].value };
  // The phone first: a logged-in phone gets past the passkey check, so only the route itself can refuse it.
  assert.equal((await server.remote('/mcp', { method: 'POST', body: ping, headers, session })).status, 404);
  assert.equal((await server.remote('/mcp', { method: 'POST', body: ping, headers })).status, 401);
  assert.equal((await call(server, '/mcp', 'POST', ping, headers)).status, 200);
  console.log('PASS MCP remote: an enrolled phone with a live token gets 404 on the phone listener; the desktop socket answers');
});

// ME4: update_* edit a title or icon through the same guarded edit(); the tools reach Claude's and Codex's chats alike.
for (const provider of ['claude', 'codex']) {
  test(`MCP update tools (${provider} chat): title and icon change through the guarded edit; bad icons, stale hashes and protection keep the file`, async (t) => {
    const instance = await start(t);
    const { tool } = await agent(t, instance, provider);
    const before = await file(instance, SETTINGS.registry);
    assert.equal((await tool('update_button', { id: 'hello', icon: '👋' })).error, 'registry-read-only');
    await call(instance, '/file-protection', 'POST', { on: false });
    const done = await tool('update_button', { id: 'hello', title: 'Say hello', icon: '👋', hash: hash(before) });
    assert.deepEqual([done.isError, done.action, done.record.icon, done.record.title], [false, 'updated', '👋', 'Say hello']);
    const text = await file(instance, SETTINGS.registry);
    assert.equal(done.hash, hash(text));
    assert.deepEqual(JSON.parse(text).scripts[0], { ...JSON.parse(before).scripts[0], title: 'Say hello', icon: '👋' });
    assert.equal((await call(instance, '/mission')).body.scripts.find((script) => script.id === 'hello').icon, '👋');
    // A stale hash, a link or a path as an icon, an unknown ID and a call that changes nothing are all refused; the file stays.
    assert.equal((await tool('update_button', { id: 'hello', icon: '🙂', hash: hash(before) })).error, 'hash-conflict');
    for (const icon of ['http://example.com/a.png', 'a/b.png', 'c:\\x', 'two words', 'x'.repeat(17)]) assert.equal((await tool('update_button', { id: 'hello', icon })).error, 'invalid-record', icon);
    assert.equal((await tool('update_button', { id: 'nope', icon: 'x' })).error, 'unknown-id');
    assert.equal((await tool('update_button', { id: 'hello' })).error, 'nothing-to-change');
    assert.equal(await file(instance, SETTINGS.registry), text);
    // An empty icon removes it.
    await tool('update_button', { id: 'hello', icon: '' });
    assert.equal('icon' in JSON.parse(await file(instance, SETTINGS.registry)).scripts[0], false);
    // App, link and section; a space button by its section; a renamed section keeps its buttons.
    assert.equal((await tool('update_app', { id: 'editor', icon: '✏️' })).record.icon, '✏️');
    assert.equal((await tool('update_page', { id: 'dash', title: 'Board', icon: 'D' })).record.title, 'Board');
    assert.equal((await tool('update_button', { id: 'ops-up', section: 'Ops', icon: '⬆' })).file, SETTINGS.space);
    assert.equal((await tool('update_section', { title: 'Ops', new_title: 'Operations', icon: '🛠' })).record.title, 'Operations');
    const space = JSON.parse(await file(instance, SETTINGS.space)).sections[0];
    assert.deepEqual([space.title, space.icon, space.buttons[0].icon], ['Operations', '🛠', '⬆']);
    const overview = (await call(instance, '/mission')).body;
    assert.deepEqual([overview.apps[0].icon, overview.pages[0].icon, overview.space[0].icon], ['✏️', 'D', '🛠']);
    assert.equal((await tool('update_section', { title: 'Operations', new_title: ' ' })).error, 'invalid-record');
    assert.equal((await tool('update_section', { title: 'Nope', icon: 'x' })).error, 'unknown-section');
    await call(instance, '/agent-lock', 'POST', { on: true });
    assert.equal((await tool('update_app', { id: 'editor', icon: 'E' })).error, 'agent-lock-on');
    console.log(`PASS MCP update tools (${provider}): button, app, link, section changed; stale hash, link/path icons, unknown ID, lock and protection refused`);
  });
}

test('The edit form route: File protection asks first, a stale hash is refused, the agent lock does not stop the user', async (t) => {
  const instance = await start(t);
  const registry = await file(instance, SETTINGS.registry);
  const state = (await call(instance, '/mission/edit')).body;
  assert.deepEqual(state, { registry: hash(registry), space: hash(await file(instance, SETTINGS.space)), protection: true });
  const edit = (body) => call(instance, '/mission/edit', 'POST', { hash: state.registry, ...body });
  const asked = await edit({ kind: 'apps', key: 'editor', icon: 'E' });
  assert.deepEqual([asked.status, asked.body.error], [403, 'registry-read-only']);
  assert.equal(await file(instance, SETTINGS.registry), registry);
  const saved = await edit({ kind: 'apps', key: 'editor', title: 'Code', icon: 'E', confirm: true });
  assert.deepEqual([saved.status, saved.body.record.title], [200, 'Code']);
  assert.equal(JSON.parse(await file(instance, SETTINGS.registry)).apps[0].icon, 'E');
  // The hash the form opened with is now stale: refused with the disk hash, nothing written.
  const written = await file(instance, SETTINGS.registry);
  const stale = await edit({ kind: 'pages', key: 'dash', icon: 'D', confirm: true });
  assert.deepEqual([stale.status, stale.body.error, stale.body.diskHash], [409, 'hash-conflict', hash(written)]);
  assert.equal(await file(instance, SETTINGS.registry), written);
  // The hash from the last save works, and the agent lock (about agents) does not block the user's own form.
  await call(instance, '/agent-lock', 'POST', { on: true });
  const again = await edit({ kind: 'pages', key: 'dash', icon: 'D', confirm: true, hash: saved.body.hash });
  assert.equal(again.status, 200);
  assert.equal((await edit({ kind: 'scripts', key: 'hello', icon: 'x' })).status, 400);
  assert.equal((await edit({ kind: 'apps', key: 'editor', icon: 'x', cmd: ['rm'] })).status, 400);
  assert.equal((await edit({ kind: 'apps', key: 'editor', icon: 'http://x.example/i.png', confirm: true, hash: again.body.hash })).body.error, 'invalid-record');
  assert.equal((await edit({ kind: 'sections', key: 'Ops', icon: '🛠', confirm: true, hash: state.space })).status, 200);
  console.log('PASS edit route: protection asked first (403 then 200), stale hash 409 with nothing written, lock does not stop the form, other fields 400');
});

test('BL2: a registry and a space saved with a BOM load and take an edit', async (t) => {
  const instance = await start(t, '\uFEFF');
  assert.equal((await call(instance, '/mission')).body.scripts.length, 4);
  await call(instance, '/file-protection', 'POST', { on: false });
  const { tool } = await agent(t, instance);
  const added = await tool('add_button', { record: { id: 'build', title: 'Build', cmd: ['make'] } });
  assert.equal(added.isError, false, JSON.stringify(added));
  assert.equal((await tool('update_section', { title: 'Ops', icon: '🛠' })).isError, false);
  assert.equal((await tool('remove_button', { id: 'build' })).isError, false);
  assert.equal(JSON.parse(await file(instance, SETTINGS.space)).sections[0].icon, '🛠');
  console.log('PASS BL2: BOM registry and space load, add, update and remove');
});
