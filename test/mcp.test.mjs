import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, access, stat, readdir, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { daemon, remoteDaemon, http, authenticated, root, passkeyDevice, enrollDevice } from './helpers.mjs';
import { pinned, applyCard } from '../apps/web/src/pinned.mjs';
import { md } from '../apps/web/src/helpers.mjs';
import { parseSettings } from '../apps/server/mission.mjs';
// The real MCP SDK client (a dependency of the Claude adapter), so P9's hand-written server is held to what clients send.
import { Client } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const hash = (text) => createHash('sha256').update(text).digest('hex');
const node = process.execPath;
const SETTINGS = { primary: 'projects/AGENTS.md', registry: 'hub/registry.json', waiting: '_waiting', space: 'hub/space.json' };

// folder: where settings.json goes under the test home (an install's is .config/p9, away from the state folder).
async function start(t, bom = '', settings = SETTINGS, folder = '') {
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
    await mkdir(path.join(directory, folder), { recursive: true });
    await writeFile(path.join(directory, folder, 'settings.json'), JSON.stringify(settings));
    return { args: ['--acp-override', fake, '--settings', path.join(directory, folder, 'settings.json')] };
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
  assert.equal((await client.listTools()).tools.length, 25);
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
  console.log('PASS MCP: SDK client initialized and listed 21 tools; wrong, missing, cookie-only and stopped-chat tokens all 401');
});

test('MCP writes: File protection and the agent lock refuse them; the parser, a stale hash and a clashing ID keep the file', async (t) => {
  const instance = await start(t);
  const { tool } = await agent(t, instance);
  const before = await file(instance, SETTINGS.registry);
  const record = { id: 'build', title: 'Build', cmd: ['make'] };
  assert.equal((await tool('add_button', { record })).error, 'registry-read-only');
  await call(instance, '/file-protection', 'POST', { on: false });
  const typo = await tool('add_button', { record: { ...record, comand: ['x'] } });
  assert.equal(typo.error, 'invalid-record');
  assert.match(typo.detail, /^comand is not a field of this record\. Did you mean cmd\?/);
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
    // An agent cannot set a picture (the edit form's alone): a call naming one changes nothing.
    assert.notEqual((await tool('update_button', { id: 'hello', picture: '0123456789abcdef.png' })).isError, false);
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
    // W1 (threat model row 72 e): a section's built-in panel, references and notes key; "" or [] removes each; a bad value changes nothing.
    let set = await tool('update_section', { title: 'Operations', widget: 'usage', refs: ['hello', 'dash'], notes: 'vault' });
    assert.deepEqual([set.record?.widget, set.record?.refs, set.record?.notes], ['usage', ['hello', 'dash'], 'vault'], JSON.stringify(set));
    const withAll = await file(instance, SETTINGS.space);
    assert.deepEqual((({ widget, refs, notes }) => ({ widget, refs, notes }))(JSON.parse(withAll).sections[0]), { widget: 'usage', refs: ['hello', 'dash'], notes: 'vault' });
    for (const bad of [{ widget: 'shell' }, { notes: '../outside' }, { refs: ['rm -rf /'] }]) {
      assert.equal((await tool('update_section', { title: 'Operations', ...bad })).error, 'invalid-record', JSON.stringify(bad));
    }
    assert.equal((await tool('update_button', { id: 'hello', widget: 'usage' })).error, 'request-refused', 'only sections take a widget');
    assert.equal(await file(instance, SETTINGS.space), withAll);
    set = await tool('update_section', { title: 'Operations', widget: '', refs: [], notes: '' });
    const cleared = JSON.parse(await file(instance, SETTINGS.space)).sections[0];
    assert.deepEqual(['widget', 'refs', 'notes'].filter((key) => key in cleared), []);
    await call(instance, '/agent-lock', 'POST', { on: true });
    assert.equal((await tool('update_app', { id: 'editor', icon: 'E' })).error, 'agent-lock-on');
    const locked = await file(instance, SETTINGS.space);
    assert.equal((await tool('update_section', { title: 'Operations', widget: 'usage' })).error, 'agent-lock-on', 'the agent lock refuses a widget too');
    assert.equal(await file(instance, SETTINGS.space), locked);
    console.log(`PASS MCP update tools (${provider}): button, app, link, section changed; stale hash, link/path icons, unknown ID, lock and protection refused`);
  });
}

// AR2 (threat model row 42): pin_card and unpin_card reach Claude's and Codex's chats alike. A card is a chat event, so
// the ledger replays it in order, and the strip renders the text through md(), which shows HTML as text.
for (const provider of ['claude', 'codex']) {
  test(`MCP pin_card (${provider} chat): cards replace by id, the 8 KB cap counts UTF-8 bytes, the lock does not stop them, unpin replays`, async (t) => {
    const instance = await start(t);
    const { conversation, tool } = await agent(t, instance, provider);
    assert.equal((await tool('pin_card', { id: 'todo', kind: 'checklist', text: '- [ ] one' })).pinned, 'todo');
    const hostile = '- [x] one\n\n<img src=x onerror="alert(1)"> <script>alert(2)</script> [link](javascript:alert(3))';
    assert.equal((await tool('pin_card', { id: 'todo', kind: 'checklist', text: hostile })).pinned, 'todo');
    // 8192 bytes go in, 8193 do not; 4097 two-byte characters are 8194 bytes, under 8192 characters.
    assert.equal((await tool('pin_card', { id: 'big', kind: 'markdown', text: 'a'.repeat(8192) })).pinned, 'big');
    assert.equal((await tool('pin_card', { id: 'wide', kind: 'markdown', text: 'é'.repeat(4096) })).pinned, 'wide');
    for (const text of ['a'.repeat(8193), 'é'.repeat(4097)]) assert.equal((await tool('pin_card', { id: 'over', kind: 'markdown', text })).error, 'too-large', text.length + ' characters');
    for (const args of [{ id: 'a b', kind: 'markdown', text: 'x' }, { id: '../x', kind: 'markdown', text: 'x' }, { id: 'x'.repeat(65), kind: 'markdown', text: 'x' },
      { id: '', kind: 'markdown', text: 'x' }, { id: 'k', kind: 'html', text: 'x' }, { id: 'k', kind: 'table', text: ' \n' }, { id: 'k', kind: 'table' }]) {
      assert.notEqual((await tool('pin_card', args)).isError, false, JSON.stringify(args));
    }
    assert.notEqual((await tool('unpin_card', { id: '../x' })).isError, false);
    // Pinning writes no file, so the agent lock leaves it alone.
    await call(instance, '/agent-lock', 'POST', { on: true });
    assert.equal((await tool('pin_card', { id: 'locked', kind: 'table', text: '| a |\n|---|\n| 1 |' })).pinned, 'locked');
    await call(instance, '/agent-lock', 'POST', { on: false });
    assert.equal((await tool('unpin_card', { id: 'big' })).unpinned, 'big');
    const { hit } = await until(instance, (event) => event.conversation === conversation && event.type === 'unpin');
    assert.deepEqual(hit.data, { id: 'big' });

    // The replay a desktop or phone does from the ledger: refused cards never landed, the replaced and unpinned ones are gone.
    const all = [];
    for (let after = 0, page; (page = (await call(instance, `/chat/events?after=${after}&only=${conversation}`)).body).events.length; after = page.cursor) all.push(...page.events);
    const cards = all.filter((event) => event.type === 'card' || event.type === 'unpin');
    assert.deepEqual(cards.map((event) => event.type + ':' + event.data.id), ['card:todo', 'card:todo', 'card:big', 'card:wide', 'card:locked', 'unpin:big']);
    assert.deepEqual(cards[1].data, { id: 'todo', kind: 'checklist', text: hostile });
    const s = { events: [] };
    for (const event of cards) applyCard(s, event.type, event.data);
    assert.deepEqual([...s.cards.keys()], ['todo', 'wide', 'locked']);
    const html = pinned(s, (card) => md.parse(card.text));
    assert.match(html, /^<div class="pinned"/);
    assert.ok(!/<img|<script|<a |href=/i.test(html), html);
    assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;') && html.includes('&lt;script&gt;'), html);
    assert.ok(!html.includes('data-card="big"') && html.includes('data-card="locked"') && html.includes('<table>'));
    assert.equal(pinned({ events: [], cards: new Map() }, () => ''), '');
    console.log(`PASS MCP pin_card (${provider}): replace by id, 8192 bytes in and 8193 (or 4097 x é) refused, bad id/kind/text refused, lock did not stop it, replay showed HTML as text and dropped the unpinned card`);
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

// Mission revamp M1 (threat model row 68): an agent whose harness reads no MCP resources learns the space from a tool.
test('M1 describe_mission: a tools-only client gets the schema, an example of every item type and the templates; nothing of the user\'s', { timeout: 60000 }, async (t) => {
  const instance = await start(t);
  const { client, tool } = await agent(t, instance);
  const listed = (await client.listTools()).tools.find((entry) => entry.name === 'describe_mission');
  assert.ok(listed.description.length <= 200, 'a short listing: ' + listed.description.length);
  const before = await file(instance, SETTINGS.space);
  const { isError, ...told } = await tool('describe_mission');
  assert.equal(isError, false);
  assert.ok(told.schema.properties.sections.items.properties.buttons);
  assert.deepEqual(told.items.map((entry) => entry.item), ['buttons', 'logs', 'notes', 'folders', 'refs', 'data', 'cards', 'checklists', 'links']);
  for (const entry of told.items) assert.ok(entry.example[entry.item] !== undefined && entry.about, entry.item + ' has an example');
  assert.ok(told.templates.some((template) => template.name === 'blank'));
  // Every example is a section the parser keeps whole.
  for (const space of [told.file, { sections: told.items.map((entry) => entry.example) }]) assert.deepEqual((await tool('validate_space', { text: JSON.stringify(space) })).invalid, []);
  const text = JSON.stringify(told);
  assert.ok(!text.includes(instance.directory) && !text.includes('ops-up'), 'no path or content of the user\'s');
  assert.equal(await file(instance, SETTINGS.space), before);
  console.log('PASS M1 describe_mission: ' + text.length + ' characters, listing ' + listed.description.length + ', items ' + told.items.map((entry) => entry.item));
});

// Threat model row 69: no space in settings, so the first space write makes an owner-only file beside settings.json.
test('M1 first space write: makes mission-space.json at mode 600 and names it in settings; never under the lock or File protection', { timeout: 60000 }, async (t) => {
  const { space: ignored, ...bare } = SETTINGS;
  const instance = await start(t, '', bare, '.config/p9');
  const { tool } = await agent(t, instance);
  const made = path.join(instance.directory, '.config/p9/mission-space.json'), settingsFile = path.join(instance.directory, '.config/p9/settings.json');
  const none = await tool('validate_space');
  assert.equal(none.error, 'no-space-file');
  assert.match(none.detail, /^There is no space file yet\. The first add_section creates .*mission-space\.json/);
  assert.match((await tool('status')).space, /no space file yet/);
  assert.equal((await tool('add_section', { title: 'Home' })).error, 'registry-read-only');
  await call(instance, '/file-protection', 'POST', { on: false });
  await call(instance, '/agent-lock', 'POST', { on: true });
  assert.equal((await tool('add_section', { title: 'Home' })).error, 'agent-lock-on');
  await call(instance, '/agent-lock', 'POST', { on: false });
  await assert.rejects(access(made), 'nothing made while refused');
  const added = await tool('add_section', { title: 'Home lab' });
  assert.equal(added.isError, false, JSON.stringify(added));
  assert.equal(added.file, made);
  assert.equal((await stat(made)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(settingsFile, 'utf8')).space, made);
  assert.equal((await tool('add_section', { title: 'Two' })).isError, false);
  assert.equal((await stat(made)).mode & 0o777, 0o600, 'a later save keeps 600');
  assert.deepEqual(JSON.parse(await readFile(made, 'utf8')).sections.map(({ id, title }) => [id, title]), [['home-lab', 'Home lab'], ['two', 'Two']]);
  assert.ok((await call(instance, '/mission')).body.space.some((section) => section.title === 'Home lab'), 'Mission Control reads it');
  // An absolute space path is only ever P9's own file name.
  assert.throws(() => parseSettings(JSON.stringify({ ...bare, space: '/etc/other.json' })), /invalid-settings/);
  assert.equal(parseSettings(JSON.stringify({ ...bare, space: made })).space, made);
  console.log('PASS M1 first write: refused under protection and the lock with nothing made, then ' + made.slice(instance.directory.length) + ' at 600, in settings, kept 600');
});

// Plain words for each broken state of the space file, never a bare parser message.
test('M1 space errors: a missing, an empty and a broken space file each say what is wrong', { timeout: 60000 }, async (t) => {
  const instance = await start(t);
  const { tool } = await agent(t, instance);
  const where = path.join(instance.workspace, SETTINGS.space);
  const cases = [['', 'empty-space-file', /^The space file hub\/space\.json is empty\. A space is a JSON object/],
    ['{"sections": [', 'invalid-json', /^The space file hub\/space\.json is not valid JSON \(/], ['[]', 'invalid-space', /is JSON but not a space/]];
  for (const [text, error, words] of cases) {
    await writeFile(where, text);
    const result = await tool('validate_space');
    assert.equal(result.error, error, text);
    assert.match(result.detail, words);
  }
  assert.equal((await tool('validate_space', { text: '' })).detail.startsWith('The text is empty'), true);
  await unlink(where);
  const gone = await tool('validate_space');
  assert.equal(gone.error, 'space-file-missing');
  assert.match(gone.detail, /^Settings name the space file hub\/space\.json, but P9 cannot read it there/);
  console.log('PASS M1 errors: empty, broken JSON, not a space and missing each named in words');
});

// Strict validation: unknown fields named (with a guess), a repeated title or id refused; old files get ids, a copy kept first.
test('M1 strict space: unknown fields and duplicates come back named; an old file gets ids with every section kept and a backup', { timeout: 60000 }, async (t) => {
  const instance = await start(t);
  const { tool } = await agent(t, instance);
  const strict = await tool('validate_space', { text: JSON.stringify({ sections: [{ title: 'Feed', feed: 'x', titel: 'y' }, { title: 'Feed' }, { id: 'same', title: 'One' }, { id: 'same', title: 'Two' }] }) });
  const details = strict.invalid.map((entry) => entry.detail);
  assert.equal(strict.ok, false);
  assert.ok(details.some((detail) => /^feed is not a field of a section\. Known fields: id, title/.test(detail)), details.join(' | '));
  assert.ok(details.some((detail) => /^titel is not a field of a section\. Did you mean title\?/.test(detail)));
  assert.ok(details.some((detail) => /^Another section is already titled "Feed"/.test(detail)));
  assert.ok(details.some((detail) => /^Another section already has the id same/.test(detail)));
  // Migration (blast radius: every section, button and log kept). The fixture's Ops section has no id.
  const old = await file(instance, SETTINGS.space);
  await call(instance, '/file-protection', 'POST', { on: false });
  assert.equal((await tool('add_section', { title: 'Ops ' })).error, 'duplicate-section');
  assert.equal(await file(instance, SETTINGS.space), old, 'a refused write migrates nothing');
  assert.equal((await tool('add_section', { title: 'Two' })).isError, false);
  const now = JSON.parse(await file(instance, SETTINGS.space)).sections;
  assert.deepEqual(now, [{ id: 'ops', ...JSON.parse(old).sections[0] }, { id: 'two', title: 'Two' }]);
  const [copy] = (await readdir(path.join(instance.workspace, 'hub'))).filter((name) => /^space\.json\.\d+\.bak$/.test(name));
  assert.equal(await file(instance, 'hub/' + copy), old);
  assert.equal((await stat(path.join(instance.workspace, 'hub', copy))).mode & 0o777, 0o600);
  console.log('PASS M1 strict: feed, titel (did you mean title), duplicate title and id named; migration kept Ops and its button, backup ' + copy + ' at 600');
});

test('M3 set_section_items: data tiles and links go in through the lock and File protection; a javascript: link is refused by name', { timeout: 60000 }, async (t) => {
  const instance = await start(t);
  const { tool } = await agent(t, instance);
  const kinds = (await tool('describe_mission')).items.map((item) => item.item);
  assert.ok(kinds.includes('data') && kinds.includes('links'), kinds.join());
  const tiles = { title: 'Ops', kind: 'data', items: [{ id: 'inbox', title: 'Inbox', script: 'count-inbox' }] };
  assert.equal((await tool('set_section_items', tiles)).error, 'registry-read-only', 'File protection on');
  await call(instance, '/file-protection', 'POST', { on: false });
  await call(instance, '/agent-lock', 'POST', { on: true });
  assert.equal((await tool('set_section_items', tiles)).error, 'agent-lock-on');
  await call(instance, '/agent-lock', 'POST', { on: false });
  const evil = await tool('set_section_items', { title: 'Ops', kind: 'links', items: [{ id: 'evil', title: 'Evil', url: 'javascript:alert(1)' }] });
  assert.deepEqual([evil.error, evil.index], ['invalid-item', 0]);
  assert.match(evil.detail, /^url: An http:\/\/ or https:\/\/ address/);
  assert.equal((await tool('set_section_items', { ...tiles, items: [{ id: 'x', title: 'X', script: 'y', every: 5 }] })).detail, 'every is not a field of this record. Known fields: id, title, script.');
  assert.equal((await tool('set_section_items', tiles)).isError, false);
  assert.equal((await tool('set_section_items', { title: 'Ops', kind: 'links', items: [{ id: 'docs', title: 'Docs', url: 'https://example.com/docs' }] })).isError, false);
  const ops = JSON.parse(await file(instance, SETTINGS.space)).sections.find((section) => section.title === 'Ops');
  assert.deepEqual([ops.data, ops.links], [tiles.items, [{ id: 'docs', title: 'Docs', url: 'https://example.com/docs' }]]);
});
