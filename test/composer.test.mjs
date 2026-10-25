// The chat composer and chat pane (v0.1.5 part 2, chunk C). Real Electron, the real daemon and the fake agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, http, authenticated, root } from './helpers.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((result) => ({ status: result.status, ...JSON.parse(result.text) }));
const events = async (instance, id) => {
  const all = [];
  for (let after = 0, page; (page = await call(instance, '/chat/events?after=' + after + '&only=' + id)).events.length; after = page.cursor) all.push(...page.events);
  return all;
};
const said = async (instance, id, type) => (await events(instance, id)).filter((e) => e.type === type);
const until = async (check, what, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 200))) if (await check()) return;
  assert.fail('timed out: ' + what);
};

// One chat with the given agent, answered "hello" once, and a window on it.
async function setup(t, name, { provider = 'claude', files = [] } = {}) {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  for (const file of files) await writeFile(path.join(instance.workspace, file), '');
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-' + name + '-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const id = (await call(instance, '/chat', 'POST', { provider })).conversation;
  await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'hello' });
  const agentSaid = async (text) => (await said(instance, id, 'update')).some((e) => e.data.content?.text === text);
  await until(() => agentSaid('echo:hello'), 'hello answered');
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  await page.locator('#rBots [data-bot="' + id + '"]').waitFor({ timeout: 15000 });
  await page.locator('#tabs .tab[data-id="' + id + '"]').click();
  const pane = page.locator('.pane[data-id="' + id + '"]');
  const type = async (text) => { await pane.locator('.composer textarea').click(); await page.keyboard.type(text); };
  const send = async (text) => { await type(text); await page.keyboard.press('Enter'); };
  return { app, instance, id, page, pane, type, send, agentSaid, errors };
}

test('CP9: answering a question with Enter in its text box leaves the chat updating', { timeout: 90000 }, async (t) => {
  const { pane, page, send, agentSaid, errors } = await setup(t, 'cp9');
  await send('ask-text');
  const box = pane.locator('[data-question] input[name="f0"]');
  await box.waitFor({ timeout: 15000 });
  // Focus stays in the box as the answer goes; the window then repaints with the question gone.
  await box.click(); await page.keyboard.type('Saturn'); await page.keyboard.press('Enter');
  await until(() => agentSaid('ask:{"action":"accept","content":{"name":"Saturn"}}'), 'the answer reached the agent');
  await until(async () => (await pane.locator('[data-question]').count()) === 0, 'the question card went');
  // The next turn still shows: before the fix the throw ended the window's event loop, so nothing after it did.
  await send('after');
  await pane.locator('.hist', { hasText: 'echo:after' }).waitFor({ timeout: 15000 });
  assert.deepEqual(errors.filter((e) => /reading 'focus'/.test(e)), []);
  console.log('PASS CP9: Enter in a question\'s text box answered it, the chat kept updating and nothing threw');
});

// CP1 and CP8, both agents. The fake's tool calls take 10 s here (slow-tools), so a message sent during one is held.
const steers = (instance) => readFile(path.join(instance.workspace, 'steers.log'), 'utf8').catch(() => '');
const started = (instance, id, tool) => until(async () => (await said(instance, id, 'update')).some((e) => e.data.toolCallId === tool), tool + ' started');
const users = async (instance, id) => (await said(instance, id, 'user')).map((e) => e.data.text);
for (const provider of ['claude', 'codex']) {
  test('CP1 ' + provider + ': Enter during a tool call holds the message, and it goes into the turn once, when that call ends', { timeout: 120000 }, async (t) => {
    const { instance, id, pane, send, agentSaid } = await setup(t, 'cp1-steer-' + provider, { provider, files: ['slow-tools'] });
    await send('tools 1');
    await started(instance, id, 'tool-1');
    await pane.locator('[data-when="steer"]').waitFor({ timeout: 5000 }); // the chip shows while the agent works
    await send('mid');
    await pane.locator('.queue [data-held]', { hasText: 'After this step: mid' }).waitFor({ timeout: 5000 });
    await until(() => agentSaid('got:mid'), 'mid reached the agent', 20000);
    await until(() => agentSaid('tools done'), 'the turn went on', 10000);
    const all = await events(instance, id), at = (f) => all.findIndex(f);
    const held = at((e) => e.type === 'held'), done = at((e) => e.data.toolCallId === 'tool-1' && e.data.status === 'completed'), user = at((e) => e.type === 'user' && e.data.text === 'mid');
    assert.ok(held >= 0 && held < done && done < user, 'held while the tool call ran, steered after it ended');
    assert.deepEqual([all[user].data.steered, all[user].data.held, all[held].data.when], [true, [all[held].data.id], 'steer']);
    assert.equal(await steers(instance), 'mid\n', 'exactly one steer');
    assert.equal(await pane.locator('.queue [data-held]').count(), 0);
    console.log('PASS CP1 ' + provider + ': a message sent during a tool call waited for it to end, then went into the turn once');
  });

  test('CP1 ' + provider + ': when the turn ends first, a held message and a queued one (Tab) go as the next prompt; nothing is steered', { timeout: 120000 }, async (t) => {
    const { instance, id, pane, page, type, send, agentSaid } = await setup(t, 'cp1-end-' + provider, { provider, files: ['slow-tools'] });
    await send('tool-open');
    await started(instance, id, 'tool-1');
    await send('mid');
    await type('later'); await page.keyboard.press('Tab');
    await pane.locator('.queue [data-held]', { hasText: 'Queued: later' }).waitFor({ timeout: 5000 });
    assert.deepEqual(await pane.locator('.queue [data-held] span').allInnerTexts(), ['After this step: mid', 'Queued: later']);
    await until(() => agentSaid('echo:mid\n\nlater'), 'both went as one prompt after the turn', 25000);
    assert.deepEqual([await users(instance, id), await steers(instance), await pane.locator('.queue [data-held]').count()], [['hello', 'tool-open', 'mid\n\nlater'], '', 0]);
    console.log('PASS CP1 ' + provider + ': the turn ended with its tool call open; the held and the queued message went as one prompt, held first, no steer');
  });

  test('CP8 ' + provider + ': a message held past the turn\'s last step still lands, and the chat stops showing working', { timeout: 120000 }, async (t) => {
    const { instance, id, pane, send, agentSaid } = await setup(t, 'cp8-' + provider, { provider, files: ['slow-tools'] });
    await send('tool-last');
    await started(instance, id, 'tool-1');
    await send('mid');
    await pane.locator('.queue [data-held]', { hasText: 'mid' }).waitFor({ timeout: 5000 });
    // The steer reaches the agent just after its turn ended. Claude refuses it (promptRequired), so it goes as a prompt;
    // Codex takes it into a turn of its own that reports no end, which P9 takes as ended after 10 s of quiet.
    if (provider === 'codex') {
      await until(() => agentSaid('got:mid'), 'Codex took mid into a turn of its own', 20000);
      await until(async () => (await said(instance, id, 'turn-end')).some((e) => e.data.unprompted), 'that turn ended after 10 s of quiet', 20000);
    } else await until(() => agentSaid('echo:mid'), 'refused as a steer, mid went as the next prompt', 20000);
    await until(async () => (await pane.locator('.working').count()) === 0, 'the chat no longer shows working', 15000);
    assert.equal(await pane.locator('.queue [data-held]').count(), 0);
    console.log('PASS CP8 ' + provider + ': a steer that crossed the turn\'s end landed and the chat went idle');
  });

  test('CP1 ' + provider + ': the x takes a held message back into the box; Esc cancels the turn and gives back the rest', { timeout: 120000 }, async (t) => {
    const { instance, id, pane, page, send } = await setup(t, 'cp1-back-' + provider, { provider, files: ['slow-tools'] });
    const box = pane.locator('.composer textarea'), rows = pane.locator('.queue [data-held]');
    await send('tools 1');
    await started(instance, id, 'tool-1');
    await send('one'); await send('two');
    await until(async () => (await rows.count()) === 2, 'both held', 5000);
    await rows.filter({ hasText: 'one' }).locator('[data-unhold]').click();
    await until(async () => (await box.inputValue()) === 'one', 'one back in the box', 5000);
    await box.click(); await page.keyboard.press('Escape');
    await until(async () => (await box.inputValue()) === 'two\none', 'two back in the box after the cancel', 10000);
    assert.deepEqual([await users(instance, id), await steers(instance), await rows.count(), (await said(instance, id, 'turn-end')).at(-1).data.stopReason],
      [['hello', 'tools 1'], '', 0, 'cancelled']);
    console.log('PASS CP1 ' + provider + ': the x and Esc each put the held text back in the box and sent nothing');
  });
}

// CP7: Codex's turn of its own (CP8) is one the daemon has no handle on, so a cancel answers 409 no-turn. Claude's
// unprompted work keeps sending updates, and each shows it working again, so Codex's is the case to prove.
test('CP7: Esc on a turn the daemon has no handle on leaves the chat idle, with no error', { timeout: 120000 }, async (t) => {
  const { instance, id, page, pane, send, agentSaid } = await setup(t, 'cp7', { provider: 'codex', files: ['slow-tools'] });
  await send('tool-last');
  await started(instance, id, 'tool-1');
  await send('mid');
  await until(() => agentSaid('got:mid'), 'Codex took mid into a turn of its own', 20000);
  await pane.locator('.working').waitFor({ timeout: 5000 });
  await pane.locator('.composer textarea').click(); await page.keyboard.press('Escape');
  await until(async () => (await pane.locator('.working').count()) === 0, 'idle well before the 10 s quiet', 4000);
  assert.equal(await page.locator('.toast', { hasText: 'no-turn' }).count(), 0);
  console.log('PASS CP7: Esc with no daemon turn left the chat idle and showed no error');
});

// CP2, CP4, CP5: each check gathers what it saw into one object, so a failure shows every part that broke.
const height = (l) => l.evaluate((n) => n.getBoundingClientRect().height);
test('CP2: the box grows with its text to twice its height, then scrolls', { timeout: 90000 }, async (t) => {
  const { page, pane, type } = await setup(t, 'cp2');
  const box = pane.locator('.composer textarea');
  await type('one line'); const one = await height(box);
  for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+Enter');
  const five = await height(box);
  for (let i = 0; i < 8; i++) await page.keyboard.press('Shift+Enter');
  const tall = await height(box);
  assert.deepEqual({ grew: five > one, twice: Math.abs(tall - 2 * one) <= 2, scrolls: await box.evaluate((b) => b.scrollHeight > b.clientHeight) },
    { grew: true, twice: true, scrolls: true }, 'heights ' + [one, five, tall].join(', '));
  console.log('PASS CP2: the box went ' + one + ', ' + five + ', ' + tall + 'px for 1, 5 and 13 lines, then scrolled');
});

test('CP4: an edit shows as a line diff, and its long lines wrap', { timeout: 90000 }, async (t) => {
  const { pane, send, agentSaid } = await setup(t, 'cp4');
  await send('diff and code');
  await until(() => agentSaid('Run this:\n\n```sh\nnpm test\n```'), 'the reply');
  const tool = pane.locator('details.tool', { hasText: 'Edit notes.md' }), diff = tool.locator('.diff');
  await tool.locator('summary').click();
  // The one changed line, three unchanged lines either side, and the cut-off rest as one line.
  assert.deepEqual({
    rows: (await diff.locator('div').allInnerTexts()).map((r) => r.trim()),
    wraps: await height(diff.locator('.add')) > 2 * await height(diff.locator('.del')),
    sideways: await diff.evaluate((d) => d.scrollWidth > d.clientWidth),
  }, { rows: ['two', 'three', 'four', '− five', '+ FIVE' + ' long'.repeat(60), 'six', 'seven', 'eight', '⋯'], wraps: true, sideways: false });
  console.log('PASS CP4: a one-line edit showed as 9 rows (3 unchanged either side, the rest cut), its long line wrapped');
});

test('CP5: a code block in a reply has a Copy button that copies just the code', { timeout: 90000 }, async (t) => {
  const { app, pane, send, agentSaid } = await setup(t, 'cp5');
  await send('diff and code');
  await until(() => agentSaid('Run this:\n\n```sh\nnpm test\n```'), 'the reply');
  await pane.locator('.msg.agent pre').hover();
  await pane.locator('.msg.agent pre [data-copycode]').click({ timeout: 5000 });
  await until(async () => await app.evaluate(({ clipboard }) => clipboard.readText()) === 'npm test\n', 'the code on the clipboard', 5000);
  console.log('PASS CP5: Copy put the code block, and only it, on the clipboard');
});

// CP3, both agents: a photo sent with a message shows above it, from the daemon's copy, and again after a reload.
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
for (const provider of ['claude', 'codex']) {
  test('CP3 ' + provider + ': a sent photo shows as a thumbnail above its message, on the same side, and still does after a reload', { timeout: 90000 }, async (t) => {
    const { instance, id, page, pane, agentSaid } = await setup(t, 'cp3-' + provider, { provider });
    assert.equal((await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'look', images: [{ mimeType: 'image/png', data: png }] })).status, 202);
    await until(() => agentSaid('echo:look[image image/png ' + Buffer.from(png, 'base64').length + ']'), 'the agent got the photo');
    const thumb = () => pane.locator('.user-imgs + .msg.user', { hasText: 'look' }).evaluate((m) => {
      const img = m.previousElementSibling.querySelector('img');
      return { src: img.src.slice(0, 22), loaded: img.complete && img.naturalWidth === 1, width: img.getBoundingClientRect().width, offRight: Math.round(m.getBoundingClientRect().right - img.getBoundingClientRect().right) };
    });
    const want = { src: 'data:image/png;base64,', loaded: true, width: 96, offRight: 0 };
    await until(async () => (await thumb()).loaded, 'the thumbnail loaded', 10000);
    assert.deepEqual(await thumb(), want);
    await page.reload();
    await page.locator('#tabs .tab[data-id="' + id + '"]').click({ timeout: 15000 });
    await until(async () => (await thumb().catch(() => ({}))).loaded, 'the thumbnail loaded again after the reload', 15000);
    assert.deepEqual(await thumb(), want);
    console.log('PASS CP3 ' + provider + ': the photo showed above its message from the daemon\'s copy, before and after a reload');
  });
}

// RS2: the agent asks through P9's MCP server, as a real one would. The native "Restart P9?" dialog is answered Cancel,
// so nothing restarts; it opening proves the button reached the restart.
test('RS2: an agent\'s restart request shows a Restart P9 button that asks to restart P9', { timeout: 90000 }, async (t) => {
  const { Client } = await import('../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
  const { StdioClientTransport } = await import('../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
  const { app, instance, id, pane, send } = await setup(t, 'rs2');
  await send('mcp');
  let entry;
  await until(async () => ([entry] = JSON.parse((await said(instance, id, 'update')).find((e) => e.data.content?.text?.startsWith('mcp:'))?.data.content.text.slice(4) ?? '[]')).length, 'the MCP entry');
  const client = new Client({ name: 'p9-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env: Object.fromEntries(entry.env.map(({ name, value }) => [name, value])) }));
  t.after(() => client.close());
  await client.callTool({ name: 'request_restart', arguments: { reason: 'settings changed' } });
  await app.evaluate(({ dialog }) => { globalThis.asked = []; dialog.showMessageBox = async (_window, options) => { globalThis.asked.push(options.title); return { response: 0 }; }; });
  const button = pane.locator('.notice', { hasText: 'settings changed' }).locator('[data-restart-p9]');
  await button.click({ timeout: 10000 });
  await until(async () => (await app.evaluate(() => globalThis.asked)).includes('Restart P9?'), 'the restart dialog', 5000);
  await until(() => button.isEnabled(), 'the button back after Cancel', 5000);
  console.log('PASS RS2: the restart request showed Restart P9; it asked to restart, and Cancel left P9 running');
});
