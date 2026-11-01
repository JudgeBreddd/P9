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
  assert.equal((await client.listTools()).tools.length, 29);
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
  // Titles may repeat (W-C); an id may not.
  assert.equal((await tool('add_section', { title: 'Ops', id: 'ops' })).error, 'duplicate-section');
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
    // Wall 8 (walls table 6, 12): a section's text, and a space button moved to another section in one write.
    assert.equal((await tool('update_section', { title: 'Operations', text: 'Sprint things.' })).record.text, 'Sprint things.');
    await tool('add_section', { title: 'Other' });
    const moved = await tool('update_button', { id: 'ops-up', section: 'Operations', move_to: 'Other' });
    assert.equal(moved.error, undefined, JSON.stringify(moved));
    const after = JSON.parse(await file(instance, SETTINGS.space)).sections;
    assert.deepEqual([after[0].text, (after[0].buttons ?? []).some((b) => b.id === 'ops-up'), after.find((x) => x.title === 'Other').buttons.map((b) => b.id)], ['Sprint things.', false, ['ops-up']]);
    assert.equal((await tool('update_button', { id: 'ops-up', move_to: 'Other' })).error, 'request-refused', 'move_to needs the current section');
    assert.equal((await tool('update_button', { id: 'ops-up', section: 'Other', move_to: 'Nope' })).error, 'unknown-section');
    assert.equal((await tool('update_section', { title: 'Operations', text: '' })).record.text, undefined, '"" removes the text');
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
  assert.deepEqual({ ...state, records: undefined }, { registry: hash(registry), space: hash(await file(instance, SETTINGS.space)), protection: true, records: undefined });
  assert.deepEqual(state.records.sections.map((section) => section.title), ['Ops'], 'the records as the files hold them, for the Fields editor');
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
  assert.equal((await edit({ kind: 'nope', key: 'hello', icon: 'x' })).status, 400);
  assert.equal((await edit({ kind: 'scripts', key: 'hello', icon: 'x' })).status, 403, 'buttons are the form\'s too (W-N), under File protection like the rest');
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
  // Wall 8 (walls table 8): a scratch space is checked on its own, with no Main space file.
  assert.match((await tool('validate_space', { space: 'scratch' })).detail, /No scratch space named scratch yet/);
  assert.equal((await tool('add_section', { title: 'Try', space: 'scratch' })).error, undefined);
  assert.equal((await tool('validate_space', { space: 'scratch' })).ok, true);
  assert.equal((await tool('validate_space')).error, 'no-space-file', 'Main is still not made');
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
  assert.ok(!details.some((detail) => /titled "Feed"/.test(detail)), 'a repeated title is not a problem (W-C)');
  assert.ok(details.some((detail) => /^Another section already has the id same/.test(detail)));
  // Migration (blast radius: every section, button and log kept). The fixture's Ops section has no id.
  const old = await file(instance, SETTINGS.space);
  await call(instance, '/file-protection', 'POST', { on: false });
  assert.equal((await tool('add_section', { title: 'Two', id: 'ops' })).error, 'duplicate-section');
  assert.equal(await file(instance, SETTINGS.space), old, 'a refused write migrates nothing');
  assert.equal((await tool('add_section', { title: 'Two' })).isError, false);
  const now = JSON.parse(await file(instance, SETTINGS.space)).sections;
  assert.deepEqual(now, [{ id: 'ops', ...JSON.parse(old).sections[0] }, { id: 'two', title: 'Two' }]);
  const [copy] = (await readdir(path.join(instance.workspace, 'hub'))).filter((name) => /^space\.json\.\d+\.bak$/.test(name));
  assert.equal(await file(instance, 'hub/' + copy), old);
  assert.equal((await stat(path.join(instance.workspace, 'hub', copy))).mode & 0o777, 0o600);
  console.log('PASS M1 strict: feed, titel (did you mean title), duplicate title and id named; migration kept Ops and its button, backup ' + copy + ' at 600');
});

// W-F: a field P9 does not know is named and kept on every item, on a read and through the tools. And the section shape fields
// (order, widgets, frame): checked, documented, set and removed by the tools, and handed to the page.
test('W-F and shape fields: unknown keys survive a read and MCP writes; order, widgets and frame are checked, documented, settable and reach /mission', { timeout: 60000 }, async (t) => {
  const instance = await start(t);
  const { tool } = await agent(t, instance);
  await call(instance, '/file-protection', 'POST', { on: false });
  const space = JSON.parse(await file(instance, SETTINGS.space));
  space.sections.push({ id: 'rev', title: 'Reviews', mood: 'calm', order: ['cards', 'folders', 'nope'], widgets: ['notifications'],
    folders: [{ id: 'plans', title: 'Plans', path: 'p1', tint: 'blue' }], checklists: [{ id: 'audit', title: 'Audit', path: 'p1/plan.md', tint: 'red' }],
    logs: [{ id: 'run', title: 'Run', path: 'p1/run.log', tint: 'green' }], data: [{ id: 'inbox', title: 'Reviews', script: 'mark', frame: false, tint: 'grey' }] },
  { id: 'bad', title: 'Bad', widgets: ['nope'] }, { id: 'bad2', title: 'Bad two', order: 'cards' }, { id: 'bad3', title: 'Bad three', data: [{ id: 'd', title: 'D', script: 'mark', frame: 'no' }] });
  await writeFile(path.join(instance.workspace, SETTINGS.space), JSON.stringify(space, null, 2) + '\n');

  const checked = await tool('validate_space');
  const unknown = checked.invalid.filter((entry) => entry.reason === 'unknown-field').map((entry) => entry.detail);
  for (const what of ['mood is not a field of a section', 'tint is not a field of a folder list', 'tint is not a field of a checklist', 'tint is not a field of a log view', 'tint is not a field of a data tile'])
    assert.ok(unknown.some((detail) => detail.startsWith(what)), what + ' | ' + unknown.join(' | '));
  const bad = checked.invalid.filter((entry) => entry.reason !== 'unknown-field').map((entry) => entry.index + ' ' + entry.reason + ' ' + entry.detail.split(':')[0]);
  assert.deepEqual(bad, ['2 malformed-section widgets', '3 malformed-section order', '4 malformed-record frame']);

  const mission = (await call(instance, '/mission')).body, rev = mission.space.find((section) => section.title === 'Reviews');
  assert.deepEqual([rev.mood, rev.order, rev.widgets, rev.folders, rev.checklists, rev.logs, rev.data],
    ['calm', ['cards', 'folders', 'nope'], ['notifications'], [{ tint: 'blue', id: 'plans', title: 'Plans' }], [{ tint: 'red', id: 'audit', title: 'Audit' }],
      [{ tint: 'green', id: 'run', title: 'Run' }], [{ tint: 'grey', id: 'inbox', title: 'Reviews', frame: false }]]);
  assert.equal(mission.space.find((section) => section.title === 'Ops').frame, undefined);

  // The tools: an update elsewhere keeps every extra key; order and widgets set and come off; a bad value is refused.
  assert.equal((await tool('update_section', { title: 'Reviews', order: ['checklists', 'folders'], widgets: ['waiting', 'notifications'] })).isError, false);
  let saved = JSON.parse(await file(instance, SETTINGS.space)).sections.find((section) => section.id === 'rev');
  assert.deepEqual([saved.mood, saved.folders[0].tint, saved.checklists[0].tint, saved.logs[0].tint, saved.data[0].tint, saved.order, saved.widgets],
    ['calm', 'blue', 'red', 'green', 'grey', ['checklists', 'folders'], ['waiting', 'notifications']]);
  assert.equal((await tool('update_section', { title: 'Reviews', widgets: ['nope'] })).error, 'invalid-record');
  assert.equal((await tool('update_section', { title: 'Reviews', order: 'cards' })).error, 'request-refused');
  assert.equal((await tool('update_section', { title: 'Reviews', order: [], widgets: [] })).isError, false);
  saved = JSON.parse(await file(instance, SETTINGS.space)).sections.find((section) => section.id === 'rev');
  assert.deepEqual([saved.order, saved.widgets, saved.mood], [undefined, undefined, 'calm']);
  const made = await tool('add_section', { title: 'Logs', order: ['widgets', 'data'], widgets: ['notifications'] });
  assert.deepEqual([made.action, made.record.order, made.record.widgets], ['added', ['widgets', 'data'], ['notifications']]);
  assert.equal((await tool('add_section', { title: 'Nope', widgets: ['nope'] })).error, 'invalid-section');
  const cards = await tool('set_section_items', { title: 'Logs', kind: 'data', items: [{ id: 'logs', title: 'Logs', script: 'mark', frame: false, note: 'kept' }] });
  assert.deepEqual([cards.isError, cards.unknown.map((entry) => entry.detail.split(' ')[0])], [false, ['note']]);
  assert.deepEqual(JSON.parse(await file(instance, SETTINGS.space)).sections.find((section) => section.title === 'Logs').data, [{ id: 'logs', title: 'Logs', script: 'mark', frame: false, note: 'kept' }]);

  // describe_mission and the schema know the same fields.
  const described = await tool('describe_mission'), sectionSchema = described.schema.properties.sections.items;
  assert.deepEqual([sectionSchema.properties.order.type, sectionSchema.properties.widgets.items.enum.includes('notifications'), sectionSchema.properties.data.items.properties.frame.type,
    sectionSchema.properties.cards.items.properties.frame.type], ['array', true, 'boolean', 'boolean']);
  assert.ok(!described.items.some((item) => item.item === 'widgets'), 'a field, not an item type');
  assert.match(described.about, /order field sets the order.*widgets field draws/);
  console.log('PASS W-F and shape fields: 5 unknown keys named and kept through 4 writes; bad widgets, order and frame named; order and widgets set and removed; schema lists all three');
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
  // An unknown field is kept and named (W-F), not refused; the next call replaces the list.
  const extra = await tool('set_section_items', { ...tiles, items: [{ id: 'x', title: 'X', script: 'y', every: 5 }] });
  assert.deepEqual([extra.isError, extra.unknown], [false, [{ index: 0, detail: 'every is not a field of this record. Known fields: id, title, script, frame.' }]]);
  assert.equal(JSON.parse(await file(instance, SETTINGS.space)).sections.find((section) => section.title === 'Ops').data[0].every, 5);
  assert.equal((await tool('set_section_items', tiles)).isError, false);
  assert.equal((await tool('set_section_items', { title: 'Ops', kind: 'links', items: [{ id: 'docs', title: 'Docs', url: 'https://example.com/docs' }] })).isError, false);
  const ops = JSON.parse(await file(instance, SETTINGS.space)).sections.find((section) => section.title === 'Ops');
  assert.deepEqual([ops.data, ops.links], [tiles.items, [{ id: 'docs', title: 'Docs', url: 'https://example.com/docs' }]]);
});

// W-C, W-J: a section is named by its id; a title works while only one section has it. Two sections may share a title and both draw;
// a space button keeps its own group and names its section.
test('W-C and W-J: sections by id, a repeated title both draw, an ambiguous title names the ids; a space button keeps its group', { timeout: 60000 }, async (t) => {
  const instance = await start(t);
  const { tool } = await agent(t, instance);
  await call(instance, '/file-protection', 'POST', { on: false });
  const second = await tool('add_section', { title: 'Ops' });
  assert.deepEqual([second.isError, second.record.id], [false, 'ops-2']);
  assert.equal((await tool('add_section', { title: 'Other', id: 'Bad Id' })).error, 'invalid-section');
  const ambiguous = await tool('add_button', { record: { id: 'two-up', title: 'Two up', cmd: ['true'] }, section: 'Ops' });
  assert.deepEqual([ambiguous.error, ambiguous.ids], ['ambiguous-section', ['ops', 'ops-2']]);
  assert.match(ambiguous.detail, /^2 sections are titled "Ops": name one by its id \(ops, ops-2\)\.$/);
  assert.equal((await tool('add_button', { record: { id: 'two-up', title: 'Two up', group: 'Custom', cmd: ['true'] }, section: 'ops-2' })).isError, false);
  for (const [name, args] of [['update_section', { title: 'Ops', text: 'x' }], ['remove_section', { title: 'Ops' }], ['set_section_items', { title: 'Ops', kind: 'links', items: [] }],
    ['patch_section', { section: 'Ops', set: { text: 'x' } }], ['move_section', { section: 'Ops', index: 0 }]]) assert.equal((await tool(name, args)).error, 'ambiguous-section', name);
  assert.equal((await tool('update_section', { title: 'ops-2', new_title: 'Ops', text: 'Second' })).isError, false);
  const mission = (await call(instance, '/mission')).body;
  assert.deepEqual(mission.space.map((section) => [section.id, section.title]), [['ops', 'Ops'], ['ops-2', 'Ops']], 'both draw');
  assert.deepEqual(mission.scripts.filter((script) => script.section).map((script) => [script.id, script.group, script.section]), [['ops-up', '', 'ops'], ['two-up', 'Custom', 'ops-2']]);
  // The file's own check: a repeated id is still dropped and named.
  const dup = await tool('validate_space', { text: JSON.stringify({ sections: [{ id: 'a', title: 'Same' }, { id: 'b', title: 'Same' }, { id: 'a', title: 'Again' }] }) });
  assert.deepEqual(dup.invalid.map((entry) => [entry.index, entry.reason]), [[2, 'duplicate-section']]);
  console.log('PASS W-C/W-J: Ops twice (ops, ops-2) both drawn; 6 tools named the ids for the ambiguous title; two-up keeps group Custom in section ops-2');
});

// W-E, W-N, W-O: one patch for any field of a section or record, moves, and no limit tighter than the file's.
test('W-E patch and move: any section field (unknown kept and named), items whole, records by their table; sections and buttons reorder; no tighter limits', { timeout: 60000 }, async (t) => {
  const instance = await start(t);
  const { tool } = await agent(t, instance);
  const sections = async () => JSON.parse(await file(instance, SETTINGS.space)).sections;
  assert.equal((await tool('patch_section', { section: 'Ops', set: { text: 'x' } })).error, 'registry-read-only', 'File protection on');
  await call(instance, '/file-protection', 'POST', { on: false });
  await call(instance, '/agent-lock', 'POST', { on: true });
  assert.equal((await tool('patch_section', { section: 'Ops', set: { text: 'x' } })).error, 'agent-lock-on');
  await call(instance, '/agent-lock', 'POST', { on: false });
  const patched = await tool('patch_section', { section: 'Ops', set: { text: 'Ops text', quick_note: { root: 'vault', path: 'inbox' }, order: ['buttons', 'text'], widgets: ['notifications', 'sprint'],
    data: [{ id: 'tile', title: 'Tile', script: 'mark', frame: false }], mood: 'calm' } });
  assert.deepEqual([patched.isError, patched.action, patched.unknown.map((entry) => entry.detail.split(' ')[0])], [false, 'patched', ['mood']]);
  let [ops] = await sections();
  assert.deepEqual([ops.text, ops.quick_note, ops.order, ops.widgets, ops.data, ops.mood, ops.buttons.length], ['Ops text', { root: 'vault', path: 'inbox' }, ['buttons', 'text'], ['notifications', 'sprint'],
    [{ id: 'tile', title: 'Tile', script: 'mark', frame: false }], 'calm', 1]);
  assert.equal((await tool('patch_section', { section: 'ops', set: { mood: null, quick_note: null, id: 'ops-main' } })).isError, false);
  [ops] = await sections();
  assert.deepEqual([ops.id, 'mood' in ops, 'quick_note' in ops], ['ops-main', false, false]);
  // The same checks as the specific tools: the field table, a button's own table, picture from the desktop form only, unique ids.
  assert.match((await tool('patch_section', { section: 'ops-main', set: { widgets: ['nope'] } })).detail, /^widgets:/);
  assert.match((await tool('patch_section', { section: 'ops-main', set: { data: [{ id: 'd', title: 'D', script: 'mark', frame: 'no' }] } })).detail, /^frame:/);
  assert.match((await tool('patch_section', { section: 'ops-main', set: { buttons: [{ id: 'ops-up', title: 'Up', cmd: ['true'], shell: 'rm' }] } })).detail, /^shell is not a field of a button/);
  assert.match((await tool('patch_section', { section: 'ops-main', set: { buttons: [{ id: 'ops-up', title: 'Up', cmd: ['true'], args: ['a', 'b', 'c', 'd', 'e'] }] } })).detail, /^args:/);
  assert.equal((await tool('patch_section', { section: 'ops-main', set: { picture: 'x.png' } })).error, 'request-refused');
  assert.equal((await tool('patch_section', { section: 'ops-main', set: { id: null } })).error, 'invalid-record');
  assert.equal((await tool('add_section', { title: 'Two' })).isError, false);
  assert.equal((await tool('patch_section', { section: 'two', set: { id: 'ops-main' } })).error, 'duplicate-section');
  assert.equal((await tool('patch_section', { section: 'two', set: { buttons: [{ id: 'hello', title: 'Clash', cmd: ['true'] }] } })).error, 'not-accepted', 'a registry id');
  assert.equal((await tool('patch_section', { section: 'two', set: { buttons: [{ id: 'two-up', title: 'Two up', cmd: ['true'] }, { id: 'two-down', title: 'Two down', cmd: ['true'] }] } })).isError, false);

  // patch_item: a record's table, closed for new keys; a space button by its section.
  const app = await tool('patch_item', { kind: 'apps', id: 'editor', set: { title: 'My editor', desc: 'Edits' } });
  assert.deepEqual([app.isError, JSON.parse(await file(instance, SETTINGS.registry)).apps[0]], [false, { id: 'editor', title: 'My editor', cmd: ['true'], desc: 'Edits' }]);
  assert.match((await tool('patch_item', { kind: 'apps', id: 'editor', set: { comand: ['x'] } })).detail, /^comand is not a field of this record\. Did you mean cmd\?/);
  assert.match((await tool('patch_item', { kind: 'pages', id: 'dash', set: { url: 'javascript:alert(1)' } })).detail, /^url:/);
  assert.equal((await tool('patch_item', { kind: 'scripts', id: 'two-up', section: 'two', set: { title: 'Two up!', group: 'Custom', confirm: true } })).isError, false);
  assert.deepEqual((await sections())[1].buttons[0], { id: 'two-up', title: 'Two up!', cmd: ['true'], group: 'Custom', confirm: true });
  assert.equal((await tool('patch_item', { kind: 'scripts', id: 'two-up', set: { title: 'x' } })).error, 'unknown-id', 'without section: the registry');

  // Moves: a section to an index, a button within its section and into another; out of range refused.
  assert.deepEqual((await tool('move_section', { section: 'two', index: 0 })).order, ['two', 'ops-main']);
  assert.equal((await tool('move_section', { section: 'two', index: 2 })).error, 'request-refused');
  assert.deepEqual((await tool('move_button', { id: 'two-down', section: 'two', index: 0 })).order, ['two-down', 'two-up']);
  const moved = await tool('move_button', { id: 'two-up', section: 'two', to: 'ops-main', index: 0 });
  assert.deepEqual([moved.section, moved.order], ['ops-main', ['two-up', 'ops-up']]);
  assert.equal((await tool('move_button', { id: 'two-up', section: 'ops-main', index: 9 })).error, 'request-refused');
  assert.deepEqual((await sections()).map((section) => [section.id, section.buttons.map((button) => button.id)]), [['two', ['two-down']], ['ops-main', ['two-up', 'ops-up']]]);
  assert.equal((await call(instance, '/mission')).body.scripts.find((script) => script.id === 'two-up').section, 'ops-main');

  // W-O: titles and text as long as the file takes them, and a list longer than 64.
  const long = 'L'.repeat(300);
  assert.equal((await tool('update_section', { title: 'two', new_title: long, text: 'T'.repeat(5000) })).isError, false);
  assert.equal((await tool('add_button', { record: { id: 'long', title: long, cmd: ['true'] }, section: long })).isError, false);
  const links = Array.from({ length: 70 }, (_, i) => ({ id: 'l' + i, title: 'L' + i, url: 'https://example.com/' + i }));
  assert.equal((await tool('set_section_items', { title: 'two', kind: 'links', items: links })).isError, false);
  assert.equal((await sections())[0].links.length, 70);
  // The desktop form's patch and move: the same guards (a picture never goes through set).
  assert.equal((await call(instance, '/mission/edit', 'POST', { kind: 'sections', key: 'two', set: { text: 'From the form' } })).status, 200);
  assert.equal((await call(instance, '/mission/edit', 'POST', { kind: 'sections', key: 'two', set: { picture: 'x.png' } })).status, 400);
  assert.equal((await call(instance, '/mission/edit', 'POST', { kind: 'sections', key: 'two', set: { text: 'y' }, index: 1 })).status, 400);
  assert.equal((await call(instance, '/mission/edit', 'POST', { kind: 'apps', key: 'editor', index: 1 })).status, 400);
  assert.equal((await call(instance, '/mission/edit', 'POST', { kind: 'sections', key: 'two', index: 1, hash: hash('stale') })).status, 409);
  assert.equal((await call(instance, '/mission/edit', 'POST', { kind: 'sections', key: 'two', index: 1 })).status, 200);
  assert.deepEqual((await sections()).map((section) => [section.id, section.text]), [['ops-main', 'Ops text'], ['two', 'From the form']]);
  const state = (await call(instance, '/mission/edit')).body;
  assert.deepEqual([state.records.sections.map((section) => section.id), state.records.apps[0].desc], [['ops-main', 'two'], 'Edits']);
  console.log('PASS W-E/W-N/W-O: patch set 6 fields (mood named), removed 2, renamed the id; 7 refusals kept the file; 2 moves each kind; 300-char titles, 5000-char text, 70 links; form patch/move 200, picture/mixed/stale refused');
});

// v0.1.6 U3 (threat model row 33): in Unrestricted mode (agent lock off and File protection off) run_script, answer_needs_you
// and allow_folder act without asking (a prompt would hang the call); the other checks stay. Off, they ask as before.
test('U3: in Unrestricted mode run_script, answer_needs_you and allow_folder act without asking', async (t) => {
  const instance = await start(t);
  const { conversation, tool, cursor } = await agent(t, instance);
  const settingsFile = path.join(instance.directory, 'settings.json');
  assert.equal((await tool('allow_folder', { name: 'home', folder: instance.directory })).error, 'root-refused', 'mode off: home refused as before');
  const pending = tool('run_script', { id: 'mark' });
  const asked = await until(instance, (event) => event.conversation === conversation && event.type === 'approval', cursor);
  await call(instance, `/chat/${conversation}/answer`, 'POST', { request: asked.hit.data.request, answer: { optionId: 'reject' } });
  assert.equal((await pending).error, 'not-allowed', 'mode off: it asked');
  await assert.rejects(access(path.join(instance.workspace, 'marker')));

  assert.equal((await call(instance, '/file-protection', 'POST', { on: false })).body.on, false);
  const ran = await tool('run_script', { id: 'mark' });
  assert.deepEqual([ran.done, ran.code], [true, 0], JSON.stringify(ran));
  assert.equal(await file(instance, 'marker'), 'ran');
  assert.match((await tool('run_script', { id: 'gate', args: ['_archive/plan.md'] })).reason, /listed choices/, 'argument rules stay');
  const { items: [item] } = await tool('list_needs_you');
  assert.ok((await tool('answer_needs_you', { name: item.name, hash: hash('stale'), answer: '2' })).error, 'the changed-since check stays');
  assert.equal((await tool('answer_needs_you', { name: item.name, hash: item.hash, answer: '2' })).action, 'answered');
  assert.match(await file(instance, '_waiting/pick.md'), /^A\. 2$/m);
  const added = await tool('allow_folder', { name: 'home', folder: instance.directory });
  assert.equal(added.name, 'home', JSON.stringify(added));
  assert.ok(JSON.parse(await readFile(settingsFile, 'utf8')).notes_roots.home, 'home added to notes_roots');
  assert.equal((await tool('allow_folder', { name: 'state', folder: instance.state })).error, 'root-refused', 'P9\'s own folders stay refused');
  await call(instance, '/agent-lock', 'POST', { on: true });
  assert.equal((await tool('run_script', { id: 'mark' })).error, 'agent-lock-on');
  console.log('PASS U3: off, home refused and run_script asked; on, run_script, answer_needs_you and allow_folder(home) acted unasked, a stale hash and state still refused');
});

// Wave 3 (MCP side): #11 log views (heading, from, lines), W-G columns and span, a Fields save racing another edit merged when the
// fields it sets did not change (base), the desktop form for buttons (registry and space), #5 preview_card, and every new field documented.
test('Wave 3: log heading/from/lines, col6 and span, base merges a racing save, the form edits buttons, preview_card', { timeout: 60000 }, async (t) => {
  const instance = await start(t);
  const { tool, client } = await agent(t, instance);
  await call(instance, '/file-protection', 'POST', { on: false });
  const sections = async () => JSON.parse(await file(instance, SETTINGS.space)).sections;
  // #11: one Markdown heading's part, the top of a file, any number of lines; the default stays the last 200.
  await writeFile(path.join(instance.workspace, 'hub/status.md'), '# Status\nintro\n## Now\none\ntwo\nthree\n### Detail\nfour\n## Later\nfive\n' + Array.from({ length: 300 }, (_, i) => 'line ' + i).join('\n'));
  const logs = [{ id: 'now', title: 'Now', path: 'hub/status.md', heading: 'Now', from: 'start', lines: 3 }, { id: 'tail', title: 'Tail', path: 'hub/status.md', lines: 2 },
    { id: 'whole', title: 'Whole', path: 'hub/status.md' }, { id: 'none', title: 'None', path: 'hub/status.md', heading: 'Missing' }];
  const set = await tool('patch_section', { section: 'Ops', set: { logs } });
  assert.equal(set.isError, false, JSON.stringify(set));
  const log = async (name) => (await call(instance, '/mission/space-log?' + new URLSearchParams({ name }))).body.text;
  assert.equal(await log('now'), '## Now\none\ntwo');
  assert.equal(await log('tail'), 'line 298\nline 299');
  assert.deepEqual([(await log('whole')).split('\n').length, (await log('whole')).split('\n')[0]], [200, 'line 100']);
  assert.equal(await log('none'), 'No heading "Missing" in this file.');
  for (const [bad, field] of [[{ lines: 0 }, 'lines'], [{ lines: 2001 }, 'lines'], [{ from: 'middle' }, 'from'], [{ heading: 'a\nb' }, 'heading']]) {
    const refused = await tool('patch_section', { section: 'Ops', set: { logs: [{ ...logs[0], ...bad }] } });
    assert.match(refused.detail ?? '', new RegExp('^' + field + ':'), JSON.stringify(refused));
  }
  // W-G: up to six columns, and span 1 to 6.
  assert.equal((await tool('patch_section', { section: 'Ops', set: { place: 'col6', span: 2 } })).isError, false);
  assert.match((await tool('patch_section', { section: 'Ops', set: { span: 7 } })).detail, /^span:/);
  assert.match((await tool('patch_section', { section: 'Ops', set: { place: 'col7' } })).detail, /^place:/);
  assert.equal((await tool('validate_space', { text: JSON.stringify({ sections: [{ id: 'a', title: 'A', place: 'col4', span: 3 }] }) })).ok, true);

  // A save racing another edit: with base it goes ahead when its own fields are as they were, and names them when they are not.
  const read = (await tool('patch_section', { section: 'Ops', set: { text: 'Mine' } })).hash;
  const other = await tool('patch_section', { section: 'Ops', set: { icon: '🧪' } });
  assert.notEqual(other.hash, read);
  assert.equal((await tool('patch_section', { section: 'Ops', set: { text: 'Late' }, hash: read })).error, 'hash-conflict', 'no base: refused as before');
  const merged = await tool('patch_section', { section: 'Ops', set: { text: 'Late' }, base: { text: 'Mine' }, hash: read });
  assert.equal(merged.isError, false, JSON.stringify(merged));
  let [ops] = await sections();
  assert.deepEqual([ops.text, ops.icon], ['Late', '🧪'], 'both edits kept');
  const clash = await tool('patch_section', { section: 'Ops', set: { icon: '🔧' }, base: { icon: null }, hash: read });
  assert.deepEqual([clash.error, clash.fields], ['hash-conflict', ['icon']]);
  assert.equal((await tool('patch_section', { section: 'Ops', set: { text: 'x' }, base: { text: 'Late' } })).error, 'request-refused', 'base needs hash');
  assert.equal((await tool('patch_item', { kind: 'apps', id: 'editor', set: { desc: 'Raced' }, base: {}, hash: hash('stale') })).isError, false, 'a registry record merges too');

  // The desktop form: registry scripts and space buttons (W-N), their Fields with base, and a space button's order.
  const state = (await call(instance, '/mission/edit')).body;
  assert.deepEqual(state.records.scripts.map((script) => script.id), ['hello', 'mark', 'gate']);
  const form = (body) => call(instance, '/mission/edit', 'POST', body);
  assert.equal((await form({ kind: 'scripts', key: 'hello', title: 'Hello there', hash: state.registry })).status, 200);
  assert.equal(JSON.parse(await file(instance, SETTINGS.registry)).scripts[0].title, 'Hello there');
  assert.equal((await tool('add_button', { record: { id: 'ops-down', title: 'Down', cmd: ['true'] }, section: 'ops' })).isError, false);
  assert.equal((await form({ kind: 'scripts', key: 'ops-up', section: 'ops', set: { desc: 'Brings it up' }, base: { desc: null }, hash: state.space })).status, 200, 'stale hash, base matches: merged');
  assert.equal((await form({ kind: 'scripts', key: 'ops-up', section: 'ops', set: { desc: 'Again' }, base: { desc: null }, hash: state.space })).status, 409, 'base no longer matches');
  assert.equal((await form({ kind: 'scripts', key: 'ops-down', section: 'ops', index: 0 })).status, 200);
  [ops] = await sections();
  assert.deepEqual(ops.buttons.map((button) => [button.id, button.desc]), [['ops-down', undefined], ['ops-up', 'Brings it up']]);
  assert.equal((await form({ kind: 'scripts', key: 'ops-up', section: 'ops', icon: '⬆' })).status, 200, 'a space button\'s icon');
  assert.equal((await sections())[0].buttons[1].icon, '⬆');
  for (const body of [{ kind: 'apps', key: 'editor', section: 'ops', title: 'x' }, { kind: 'scripts', key: 'hello', index: 0 }, { kind: 'scripts', key: 'hello', title: 'x', base: {} }])
    assert.equal((await form(body)).status, 400, JSON.stringify(body));

  // #5: the card's own page with sample data, said as one document an artifact can show; nothing runs.
  await writeFile(path.join(instance.workspace, 'hub/card.html'), '<p id="n"></p><script>addEventListener("p9data", (e) => { n.textContent = e.detail.n; });</script>');
  assert.equal((await tool('patch_section', { section: 'Ops', set: { cards: [{ id: 'ops-card', title: 'Ops card', html: 'hub/card.html', script: 'mark', frame: false }] } })).isError, false);
  const preview = await tool('preview_card', { id: 'ops-card', data: { n: 3, s: '</script>' } });
  assert.equal(preview.isError, false, JSON.stringify(preview));
  assert.equal(preview.document, '<script>window.p9data = {"n":3,"s":"\\u003c/script>"}; addEventListener(\'load\', () => { if (window.p9data !== undefined) dispatchEvent(new CustomEvent(\'p9data\', { detail: window.p9data })); });</script>'
    + '<p id="n"></p><script>addEventListener("p9data", (e) => { n.textContent = e.detail.n; });</script>');
  assert.deepEqual([preview.section, preview.frame, /720 px/.test(preview.size)], ['ops', false, true]);
  assert.match((await tool('preview_card', { id: 'ops-card' })).document, /^<script>window\.p9data = undefined;/);
  assert.equal((await tool('preview_card', { id: 'nope' })).error, 'unknown-id');
  await assert.rejects(access(path.join(instance.workspace, 'marker')), 'its script did not run');

  // Each new field in the schema an agent reads, and in describe_mission.
  const described = await tool('describe_mission');
  const props = described.schema.properties.sections.items.properties;
  assert.ok(props.span.description && /col6/.test(props.place.description));
  assert.deepEqual(['heading', 'from', 'lines'].map((key) => Boolean(props.logs.items.properties[key]?.description)), [true, true, true]);
  assert.match(described.about, /preview_card/);
  const tools = (await client.listTools()).tools;
  assert.ok(tools.find((entry) => entry.name === 'patch_section').inputSchema.properties.base && tools.find((entry) => entry.name === 'preview_card'));
  console.log('PASS wave 3 MCP: 4 log views (heading, tail 2, default 200, missing heading), 4 refused; col6/span 2 kept, span 7 and col7 refused; '
    + 'base merged 2 racing saves, refused a clash naming icon; form edited a registry script, a space button (merge, clash, move, icon), 3 bad bodies refused; preview_card document exact, script not run');
});
