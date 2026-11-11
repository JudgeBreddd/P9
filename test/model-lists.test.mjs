// O47 (0.1.9): each agent's model lists come from the agent, are kept by the daemon, and are read fresh once per daemon
// run without a chat. MC-16: the option a new session starts on is named the default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, restart, http, authenticated, root } from './helpers.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((result) => ({ status: result.status, ...JSON.parse(result.text) }));
const until = async (check, what, ms = 20000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 200))) if (await check()) return;
  assert.fail('timed out: ' + what);
};
const start = (t, files = {}) => daemon(t, undefined, false, async ({ workspace }) => {
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(workspace, name), text);
  return { args: ['--acp-override', fake] };
});
const stop = async (instance) => { instance.child.kill('SIGTERM'); await new Promise((resolve) => instance.child.exitCode !== null ? resolve() : instance.child.once('exit', resolve)); };
const lists = async (instance, fresh = true) => (await call(instance, '/chat' + (fresh ? '?lists=fresh' : ''))).lists;
// Asks for a fresh read and waits until it is over.
const read = async (instance) => { let l; await until(async () => { l = await lists(instance); return ['claude', 'codex'].every((a) => l[a] && l[a].state !== 'loading'); }, 'the fresh read ended'); return l; };
const values = (list) => list.model.options.map((o) => o.value);
const calls = (instance) => fs.readFileSync(path.join(instance.workspace, 'calls.log'), 'utf8').split('\n').filter(Boolean).sort();
const MODELS = [{ value: 'default', name: 'Default (recommended)' }, { value: 'opus', name: 'Opus' }, { value: 'haiku', name: 'Haiku' }];
const setModels = (instance, list) => fs.writeFileSync(path.join(instance.workspace, 'models.json'), JSON.stringify(list));

test('lists: read fresh once per daemon run with no chat and no prompt; kept over a restart; an added model appears and a dropped one goes', { timeout: 120000 }, async (t) => {
  const instance = await start(t, { 'calls.log': '' });
  assert.deepEqual(await lists(instance, false), { claude: null, codex: null }, 'nothing kept, and a plain list starts no read');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.deepEqual(calls(instance), [], 'no agent started');
  const first = await lists(instance);
  assert.deepEqual([first.claude?.state, first.codex?.state], ['loading', 'loading']);
  await lists(instance); // a second ask while the first is on
  const got = await read(instance);
  assert.deepEqual([got.claude.state, got.codex.state], ['ok', 'ok']);
  assert.deepEqual(values(got.claude), ['default', 'opus', 'haiku']);
  assert.equal(got.claude.def.model, 'default', 'MC-16: what a new session starts on');
  assert.equal(got.claude.def.pickers.effort, 'medium');
  assert.ok(got.codex.pickers.some((p) => p.id === 'collaboration_mode'), 'each agent has its own lists');
  await lists(instance); await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.deepEqual(calls(instance), ['claude new', 'codex new'], 'one session per agent, never a prompt, never a second read');
  assert.deepEqual((await call(instance, '/chat')).conversations, [], 'no chat was made');
  // The agent adds a model and drops one: the next daemon run has the kept list at once, then the new one.
  setModels(instance, [...MODELS.filter((m) => m.value !== 'haiku'), { value: 'nova', name: 'Nova' }]);
  await stop(instance);
  const second = await restart(t, instance, 'state-2');
  const kept = await lists(second, false);
  assert.equal(kept.claude.state, 'kept'); assert.deepEqual(values(kept.claude), ['default', 'opus', 'haiku'], 'kept over the restart');
  assert.deepEqual(values((await read(second)).claude), ['default', 'opus', 'nova']);
  console.log('PASS lists: one fresh read per daemon run, no prompt, kept over a restart, added and dropped models follow the agent');
});

test('lists: a chat\'s own report updates them; a pick in the chat does not move the default', { timeout: 120000 }, async (t) => {
  const instance = await start(t);
  await read(instance);
  setModels(instance, [...MODELS, { value: 'nova', name: 'Nova' }]);
  const id = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'hello', model: 'nova' });
  await until(async () => values((await lists(instance)).claude).includes('nova'), 'the running chat\'s list is the kept one');
  const now = (await lists(instance)).claude;
  assert.equal(now.def.model, 'default', 'the default is the agent\'s, not this chat\'s pick');
  console.log('PASS lists: a live report replaces the kept list; the default stays the agent\'s own');
});

test('lists: no read while the agent lock is on; a signed-out agent fails quietly and keeps the last list', { timeout: 120000 }, async (t) => {
  const instance = await start(t, { 'calls.log': '' });
  await call(instance, '/agent-lock', 'POST', { on: true });
  assert.deepEqual(await lists(instance), { claude: null, codex: null });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.deepEqual(calls(instance), [], 'locked: no agent started');
  await call(instance, '/agent-lock', 'POST', { on: false });
  assert.equal((await read(instance)).claude.state, 'ok');
  fs.writeFileSync(path.join(instance.workspace, 'signed-out'), '');
  await stop(instance);
  const second = await restart(t, instance, 'state-2');
  const got = await read(second);
  assert.equal(got.claude.state, 'failed'); assert.deepEqual(values(got.claude), ['default', 'opus', 'haiku'], 'the last list stays');
  assert.deepEqual((await call(second, '/chat')).conversations, [], 'the daemon still answers');
  console.log('PASS lists: locked reads nothing; signed out says failed and keeps the last list');
});

test('lists: Stop All waits for a read in flight', { timeout: 120000 }, async (t) => {
  const instance = await start(t, { 'calls.log': '', 'slow-lists': '' });
  assert.equal((await lists(instance)).claude.state, 'loading');
  assert.equal((await call(instance, '/stop-all', 'POST')).result, 'stopped');
  const after = await lists(instance, false);
  assert.deepEqual([after.claude.state, after.codex.state], ['ok', 'ok'], 'the read was over when Stop All answered');
  console.log('PASS lists: Stop All waited for the read');
});

async function launch(t, instance, profile) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  await page.locator('#rChat').waitFor();
  return { app, page, errors };
}
const newRows = async (page, agent) => { await page.click('#newBtn'); await page.locator('#newPop [data-new]').first().waitFor({ timeout: 10000 });
  const got = await page.locator(`#newPop [data-sec="${agent}"] [data-new]`).evaluateAll((l) => l.map((b) => b.textContent)); await page.keyboard.press('Escape'); return got; };
const menu = async (page, pane, kind) => { await pane.locator(`[data-pill="${kind}"]`).click(); await page.locator('#pillMenu:not([hidden])').waitFor();
  const got = { items: await page.locator('#pillMenu .item').evaluateAll((l) => l.map((b) => b.firstElementChild.textContent)), notes: await page.locator('#pillMenu [data-list-note]').evaluateAll((l) => l.map((p) => p.textContent)) };
  await page.keyboard.press('Escape'); return got; };
const pillValue = async (pane, kind) => (await pane.locator(`[data-pill="${kind}"]`).getAttribute('aria-label')).replace(kind + ': ', '');

test('window: New chat lists each agent\'s models before any chat; opening an old chat never puts its old list back; a dropped model is said so; defaults are named', { timeout: 240000 }, async (t) => {
  const OLD = [{ value: 'default', name: 'Default (recommended)' }, { value: 'opus', name: 'Opus' }, { value: 'retired', name: 'Retired' }];
  const instance = await start(t, { 'models.json': JSON.stringify(OLD) });
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-lists-')), 'profile');
  // An old chat that ran on a model the agent later drops.
  const id = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'hello', model: 'retired' });
  await until(async () => (await call(instance, '/chat/events?after=0&only=' + id)).events.some((e) => e.type === 'turn-end'), 'hello answered');
  await call(instance, '/chat/' + id + '/stop', 'POST', {});
  setModels(instance, [...MODELS, { value: 'nova', name: 'Nova' }]);
  await stop(instance);
  const second = await restart(t, instance, 'state-2');
  const { page, errors } = await launch(t, second, profile);
  // No chat has run in this daemon run: the lists still come, from the fresh read.
  const NOW = ['Claude default model', 'Claude · Default (recommended)', 'Claude · Opus', 'Claude · Haiku', 'Claude · Nova'];
  await until(async () => JSON.stringify(await newRows(page, 'claude')) === JSON.stringify(NOW), 'New chat lists the agent\'s models of today');
  // Each agent's list is its own read and arrives on its own.
  await until(async () => (await newRows(page, 'codex')).length === 5, 'Codex too, with no Codex chat ever');
  // The old chat opens from History (its events replay now): the shared list stays today's.
  await page.locator('#nav .row[data-chat="' + id + '"]').click();
  const pane = page.locator('.pane[data-id="' + id + '"]');
  await pane.locator('[data-pill="Model"]').waitFor({ timeout: 15000 });
  await pane.locator('.hist', { hasText: 'hello' }).first().waitFor({ timeout: 15000 });
  assert.deepEqual(await newRows(page, 'claude'), NOW, 'replaying the old chat did not bring its list back');
  const model = await menu(page, pane, 'Model');
  assert.deepEqual(model.items.slice(0, 4), ['Default (recommended)', 'Opus', 'Haiku', 'Nova'], 'its menu offers today\'s models');
  assert.equal(await pillValue(pane, 'Model'), 'Retired', 'the chat still shows the model it ran on');
  assert.match(model.notes.join(' '), /This chat was on Retired, which Claude no longer lists/);
  // MC-16: the effort a new session starts on is named, in the menu and on the closed pill.
  assert.ok((await menu(page, pane, 'Effort')).items.includes('Medium (Default)'), 'Effort menu names the default');
  assert.equal(await pillValue(pane, 'Effort'), 'Medium (Default)');
  assert.deepEqual(errors, []);
  console.log('PASS window: lists before any chat; no stale list from a replay; a dropped model is said; defaults named');
});

// The read is still going when the window is up (the fake agent answers after 9 s). What is open then fills in when the
// lists arrive, and nothing else on the page is drawn again: a full redraw of Settings dropped what was being typed.
test('window: lists that arrive while Settings is open fill its default rows and leave a box being typed in alone', { timeout: 120000 }, async (t) => {
  const instance = await start(t, { 'slow-lists': '9000' });
  const { page, errors } = await launch(t, instance, path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-lists-')), 'profile'));
  const options = () => page.locator('#setBody [data-default-model="claude"] option').count();
  await page.click('#setBtn'); await page.locator('#setName').waitFor({ timeout: 10000 });
  assert.equal(await options(), 1, 'still being read: only the agent\'s default');
  await page.locator('#setName').evaluate((el) => { el.dataset.mark = 'same'; });
  await page.locator('#setName').fill(''); await page.locator('#setName').pressSequentially('Ada'); // the box starts with the account's name
  await until(async () => await options() === 4, 'the Default model row lists the models');
  assert.equal(await page.locator('#setName').inputValue(), 'Ada', 'what was typed is still there');
  assert.equal(await page.locator('#setName').getAttribute('data-mark'), 'same', 'the same box: Settings was not drawn again');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'setName', 'and it still has the caret');
  // The new row's select still saves.
  await page.locator('#setBody [data-default-model="claude"]').evaluate((el) => { el.value = 'opus'; el.dispatchEvent(new Event('change')); }); // on another Settings page, so not clicked
  assert.equal(await page.evaluate(() => localStorage.getItem('p9-model-default:claude')), 'opus');
  assert.deepEqual(errors, []);
  console.log('PASS window: lists arriving with Settings open fill the default rows only');
});

test('window: lists that arrive while the New menu is open fill its rows', { timeout: 120000 }, async (t) => {
  const instance = await start(t, { 'slow-lists': '9000' });
  const { page, errors } = await launch(t, instance, path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-lists-')), 'profile'));
  const rows = () => page.locator('#newPop [data-sec="codex"] [data-new]').evaluateAll((l) => l.map((b) => b.textContent));
  await page.click('#newBtn'); await page.locator('#newPop [data-new]').first().waitFor({ timeout: 10000 });
  assert.deepEqual(await rows(), ['Codex default model'], 'still being read');
  await until(async () => (await rows()).length === 4, 'the open menu lists the models');
  assert.deepEqual(await rows(), ['Codex default model', 'Codex · Default (recommended)', 'Codex · Opus', 'Codex · Haiku']);
  assert.ok(await page.evaluate(() => document.activeElement?.closest('#newPop')), 'the keyboard is still in the menu');
  assert.deepEqual(errors, []);
  console.log('PASS window: lists arriving with the New menu open fill it');
});
