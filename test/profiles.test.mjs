// O48 provider profiles (SECURITY.md "Provider profiles"): another service's models in Claude chats. The stand-in agent
// writes what it saw to profile.log: names and a hash, never the key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, restart, http, authenticated, root } from './helpers.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const KEY = 'sk-profile-test-0f3a9c71d2e84b56'; // made up for this file; no service knows it
const hash = (text) => createHash('sha256').update(text).digest('hex');
const raw = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body) });
const call = (...args) => raw(...args).then((result) => ({ status: result.status, text: result.text, ...JSON.parse(result.text || '{}') }));
const until = async (check, what, ms = 20000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 200))) if (await check()) return;
  assert.fail('timed out: ' + what);
};
const start = async (t) => {
  const instance = await daemon(t, undefined, false, async ({ workspace }) => { fs.writeFileSync(path.join(workspace, 'profile.log'), ''); return { args: ['--acp-override', fake] }; });
  instance.said = ''; for (const stream of [instance.child.stdout, instance.child.stderr]) stream.on('data', (chunk) => { instance.said += chunk; });
  return instance;
};
const stop = async (instance) => { instance.child.kill('SIGTERM'); await new Promise((resolve) => instance.child.exitCode !== null ? resolve() : instance.child.once('exit', resolve)); };
const seen = (instance) => fs.readFileSync(path.join(instance.workspace, 'profile.log'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const events = async (instance, id) => (await call(instance, '/chat/events?after=0&only=' + id)).events;
const said = async (instance, id, text) => {
  const before = (await events(instance, id)).length;
  const sent = await call(instance, '/chat/' + id + '/prompt', 'POST', { text });
  if (sent.status === 202 || sent.status === 200) await until(async () => (await events(instance, id)).slice(before).some((e) => e.type === 'turn-end'), 'the turn ended');
  return sent;
};
const PROFILE = { name: 'Far Cloud', baseUrl: 'https://models.example.test/api/', models: ['glm-5.3', 'kimi-k3:cloud'] };
// Every file under the test's home that holds the key.
const holders = (instance) => fs.readdirSync(instance.directory, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
  .map((entry) => path.join(entry.parentPath, entry.name)).filter((file) => { try { return fs.readFileSync(file).includes(KEY); } catch { return false; } })
  .map((file) => path.basename(file));

test('profile chat: its agent gets the model name in its environment and the key in the session request only; no other chat gets either; the key is in one file', { timeout: 120000 }, async (t) => {
  const instance = await start(t);
  const saved = await call(instance, '/profiles', 'POST', { ...PROFILE, key: KEY });
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual(saved.profile, { id: saved.profile.id, name: 'Far Cloud', baseUrl: 'https://models.example.test/api', models: PROFILE.models, secret: 'key' });
  const listed = await call(instance, '/profiles');
  assert.ok(!listed.text.includes(KEY) && !saved.text.includes(KEY), 'no reply holds the key');

  const made = await call(instance, '/chat', 'POST', { provider: 'claude', profile: saved.profile.id, model: 'glm-5.3' });
  assert.equal(made.status, 201, made.text);
  await said(instance, made.conversation, 'hello');
  const plain = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  await said(instance, plain, 'hello');

  const [first, second] = seen(instance).filter((line) => line.what === 'new' && line.agent === 'claude').slice(-2);
  assert.deepEqual(first, { agent: 'claude', what: 'new', model: 'glm-5.3', custom: 'glm-5.3', names: ['ANTHROPIC_CUSTOM_MODEL_OPTION', 'ANTHROPIC_MODEL'],
    baseUrl: 'https://models.example.test/api', keyHash: hash(KEY), keyOutside: false });
  assert.deepEqual(second, { agent: 'claude', what: 'new', model: null, custom: null, names: [], baseUrl: null, keyHash: null, keyOutside: false }, 'a chat with no profile gets nothing from one');

  const config = (await events(instance, made.conversation)).filter((e) => e.type === 'config').at(-1).data;
  assert.deepEqual(config.model, { current: 'glm-5.3', options: [{ value: 'glm-5.3', name: 'glm-5.3' }] }, 'the chat offers its one model, by the provider\'s name');
  const chats = await call(instance, '/chat');
  assert.deepEqual(chats.conversations.find((c) => c.id === made.conversation).profile, { id: saved.profile.id, name: 'Far Cloud', model: 'glm-5.3', gone: false });
  assert.equal(chats.conversations.find((c) => c.id === plain).profile, undefined);
  assert.ok(!JSON.stringify(chats.lists).includes('glm-5.3'), 'the agent\'s own kept list never gains a profile\'s model');
  assert.ok(!chats.text.includes(KEY) && !JSON.stringify(await events(instance, made.conversation)).includes(KEY), 'no chat list or event holds the key');

  assert.deepEqual(holders(instance), ['profiles.json'], 'the key is in one file');
  const file = fs.readdirSync(instance.directory, { recursive: true }).map((name) => path.join(instance.directory, name)).find((name) => path.basename(name) === 'profiles.json');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(!file.startsWith(instance.workspace + path.sep), 'not in the workspace');
  assert.ok(!instance.said.includes(KEY), 'the daemon printed no key');

  // A restart: the kept profile still works and the resumed session gets the key again.
  await stop(instance);
  const again = await restart(t, instance, 'state-2');
  await said(again, made.conversation, 'hello again');
  const resumed = seen(again).at(-1);
  assert.deepEqual({ what: resumed.what, model: resumed.model, keyHash: resumed.keyHash, keyOutside: resumed.keyOutside }, { what: 'resume', model: 'glm-5.3', keyHash: hash(KEY), keyOutside: false });
  console.log('PASS profile chat: model name in the agent\'s environment, key only in the session request (new and resume), in one mode 600 file, in no reply, event or output');
});

test('profile: what is refused; a removed profile\'s chat can be read, not continued; a profile chat is not sent to a remote; a wrong key says so', { timeout: 120000 }, async (t) => {
  const instance = await start(t);
  for (const [why, body] of [['an http-less URL', { ...PROFILE, baseUrl: 'models.example.test' }], ['a file URL', { ...PROFILE, baseUrl: 'file:///etc' }],
    ['a sign-in inside the URL', { ...PROFILE, baseUrl: 'https://me:secret@models.example.test' }], ['no model', { ...PROFILE, models: [] }],
    ['a model name with a space', { ...PROFILE, models: ['a b'] }], ['a model name that starts with a dash', { ...PROFILE, models: ['--help'] }],
    ['no name', { ...PROFILE, name: ' ' }], ['a key with a line break', { ...PROFILE, key: 'a\nb' }], ['an unknown id', { ...PROFILE, id: 'nope' }]])
    assert.equal((await call(instance, '/profiles', 'POST', body)).status, 400, why);
  assert.deepEqual((await call(instance, '/profiles')).profiles, [], 'nothing refused was kept');
  const { profile } = await call(instance, '/profiles', 'POST', { ...PROFILE, key: KEY });
  assert.equal((await call(instance, '/chat', 'POST', { provider: 'codex', profile: profile.id, model: 'glm-5.3' })).status, 400, 'Codex has no profiles');
  assert.equal((await call(instance, '/chat', 'POST', { provider: 'claude', profile: profile.id, model: 'opus' })).status, 400, 'only a model the profile lists');
  assert.equal((await call(instance, '/chat', 'POST', { provider: 'claude', profile: 'nope', model: 'glm-5.3' })).status, 400);
  assert.equal((await call(instance, '/chat')).conversations.length, 0, 'a refused chat is not made');

  const id = (await call(instance, '/chat', 'POST', { provider: 'claude', profile: profile.id, model: 'kimi-k3:cloud' })).conversation;
  await said(instance, id, 'hello');
  const away = await call(instance, '/chat/' + id + '/send-away', 'POST');
  assert.deepEqual([away.status, away.error], [409, 'move-unavailable']);
  assert.match(away.message, /key stays on this computer/);

  // A changed base URL drops the saved key, and a saved key command, unless that save brings one: a key typed for one
  // service is never sent to another address.
  const OTHER = 'sk-profile-other-77aa01bc93de4f20', inFile = () => fs.readFileSync(path.join(instance.directory, 'profiles.json'), 'utf8');
  const second = (await call(instance, '/profiles', 'POST', { ...PROFILE, name: 'Second', key: OTHER })).profile;
  assert.ok(inFile().includes(OTHER));
  const movedTo = (baseUrl, more) => call(instance, '/profiles', 'POST', { ...PROFILE, name: 'Second', id: second.id, baseUrl, ...more }).then((r) => r.profile);
  assert.equal((await movedTo('https://elsewhere.example.test/api')).secret, 'none', 'a new address with no key in the request: the old key is dropped');
  assert.ok(!inFile().includes(OTHER), 'and it is gone from the file');
  assert.equal((await movedTo('https://third.example.test', { command: 'print-key now' })).secret, 'command', 'a new address with its own command keeps that command');
  assert.equal((await movedTo('https://fourth.example.test')).secret, 'none', 'a saved command is dropped the same way');
  assert.ok(!inFile().includes('print-key'));
  assert.equal((await movedTo('https://fifth.example.test', { key: OTHER })).secret, 'key', 'a new address with its own key keeps that key');
  assert.equal((await call(instance, '/profiles/' + second.id, 'DELETE')).status, 200);
  // Edited with no key in the request: the saved key stays. Then a wrong key: the chat says whose key was refused.
  assert.equal((await call(instance, '/profiles', 'POST', { ...PROFILE, id: profile.id, name: 'Far Cloud 2' })).profile.secret, 'key');
  await call(instance, '/chat/' + id + '/stop', 'POST');
  await call(instance, '/profiles', 'POST', { ...PROFILE, id: profile.id, key: 'wrong-key' });
  const refused = await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'again' });
  assert.equal(refused.status, 502, refused.text);
  assert.match((await events(instance, id)).filter((e) => e.type === 'error').at(-1).data.message, /did not accept the key of the profile "Far Cloud"/);

  assert.equal((await call(instance, '/profiles/' + profile.id, 'DELETE')).status, 200);
  assert.equal((await call(instance, '/chat')).conversations.find((c) => c.id === id).profile.gone, true);
  const gone = await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'still there?' });
  assert.deepEqual([gone.status, gone.error], [409, 'profile-gone']);
  assert.match((await events(instance, id)).at(-1).data.message, /profile was removed in Settings/);
  assert.equal(seen(instance).filter((line) => line.model === 'kimi-k3:cloud').length, 2, 'no agent was started for the removed profile');
  // Removed while its chat is running: that agent holds the key, so the chat is stopped, not left answering.
  const own = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  await said(instance, own, 'model');
  await until(async () => JSON.stringify((await call(instance, '/chat')).lists.claude ?? null).includes('"opus"'), 'Claude\'s own list is kept');
  const live = (await call(instance, '/profiles', 'POST', { ...PROFILE, key: KEY })).profile;
  const running = (await call(instance, '/chat', 'POST', { provider: 'claude', profile: live.id, model: 'glm-5.3' })).conversation;
  assert.equal((await said(instance, running, 'model')).status < 300, true);
  // The profile chat's report is the newest one from a Claude agent here: Claude's own kept list is still Claude's.
  const kept = JSON.stringify((await call(instance, '/chat')).lists.claude ?? null);
  assert.ok(kept.includes('"opus"') && !kept.includes('glm-5.3'), kept);
  assert.equal((await call(instance, '/profiles/' + live.id, 'DELETE')).status, 200);
  let after; // refused from the first moment: 'stopping' while the agent ends, then for good
  await until(async () => { after = await call(instance, '/chat/' + running + '/prompt', 'POST', { text: 'model' }); assert.equal(after.status, 409, after.text); return after.error === 'profile-gone'; }, 'the stopped chat names its removed profile');
  assert.equal((await events(instance, running)).filter((e) => e.type === 'turn-end').length, 1, 'nothing ran after the removal');
  console.log('PASS profile: bad input refused, Codex and unlisted models refused, send-away refused, a wrong key named, a removed profile stops the chat');
});

test('profile: a key command is run with no shell at each chat start and its first line is the key; a failing one starts no agent', { timeout: 120000 }, async (t) => {
  const instance = await start(t);
  const script = path.join(instance.directory, 'print-key.mjs'), marker = path.join(instance.directory, 'shell-ran');
  fs.writeFileSync(script, `if (process.argv[2] === 'fail') process.exit(3); console.log(${JSON.stringify(KEY)}); console.log('second line');\n`);
  // The ; and the $( ) would run under a shell; with none they are plain arguments the script ignores.
  const { profile } = await call(instance, '/profiles', 'POST', { ...PROFILE, command: `${process.execPath} ${script} ok ; touch ${marker} $(touch ${marker})` });
  assert.equal(profile.secret, 'command');
  const id = (await call(instance, '/chat', 'POST', { provider: 'claude', profile: profile.id, model: 'glm-5.3' })).conversation;
  await said(instance, id, 'hello');
  assert.deepEqual([seen(instance).at(-1).keyHash, seen(instance).at(-1).keyOutside], [hash(KEY), false]);
  assert.ok(!fs.existsSync(marker), 'no shell read the command');
  assert.deepEqual(holders(instance), ['print-key.mjs'], 'P9 kept the command, not what it printed');

  await call(instance, '/chat/' + id + '/stop', 'POST');
  await call(instance, '/profiles', 'POST', { ...PROFILE, id: profile.id, command: `${process.execPath} ${script} fail` });
  const count = seen(instance).length;
  const failed = await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'again' });
  assert.equal(failed.status, 502, failed.text);
  assert.match((await events(instance, id)).filter((e) => e.type === 'error').at(-1).data.message, /key command .* failed or printed nothing/);
  assert.equal(seen(instance).length, count, 'no session was asked for without a key');
  console.log('PASS profile: the key command runs without a shell per chat start; a failing one starts no session');
});

// The window. launch, newRows and menu are model-lists.test.mjs's.
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
const newRows = async (page) => { await page.click('#newBtn'); await page.locator('#newPop [data-new]').first().waitFor({ timeout: 10000 });
  const got = await page.locator('#newPop [data-sec="claude"] :is([data-new], [data-profile-hd])').evaluateAll((l) => l.map((b) => b.textContent)); await page.keyboard.press('Escape'); return got; };
const menu = async (page, pane) => { await pane.locator('[data-pill="Model"]').click(); await page.locator('#pillMenu:not([hidden])').waitFor();
  const got = { head: await page.locator('#pillMenu .hd').first().textContent(), items: await page.locator('#pillMenu .item').evaluateAll((l) => l.map((b) => b.firstElementChild.textContent)), notes: await page.locator('#pillMenu [data-list-note]').evaluateAll((l) => l.map((x) => x.textContent)) };
  await page.keyboard.press('Escape'); return got; };
const profilesPage = async (page) => { await page.click('#setBtn'); await page.locator('[data-set-page="Chat Focus"]').waitFor({ timeout: 10000 }); await page.click('[data-set-page="Chat Focus"]'); await page.locator('#setProfiles').waitFor(); };

test('window: a profile typed in Settings puts its models in the New chat menu; its chat runs on that one model and leaves Claude\'s list alone; the page never holds the key after Save; a removed profile says so', { timeout: 240000 }, async (t) => {
  const instance = await start(t);
  const { page, errors } = await launch(t, instance, path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p9-prof-')), 'profile'));
  const shot = async (name) => { if (!process.env.GITHUB_ACTIONS) { await page.waitForTimeout(400); console.log('P9_SHOT ' + name + ' ' + (await page.screenshot()).toString('base64')); } };
  const CLAUDE = ['Claude default model', 'Claude · Default (recommended)', 'Claude · Opus', 'Claude · Haiku'];
  await until(async () => JSON.stringify(await newRows(page)) === JSON.stringify(CLAUDE), 'Claude\'s own models are listed, and no profile row yet');
  // The user's default Claude model: not a profile's model, so a profile chat must not send it.
  await page.evaluate(() => localStorage.setItem('p9-model-default:claude', 'opus'));
  await profilesPage(page);
  await page.click('#profileAdd');
  await page.fill('#profileName', 'Far Cloud');
  await page.fill('#profileUrl', 'http://models.example.test');
  assert.equal(await page.locator('#profileHttp').isVisible(), true, 'a plain http address is called not encrypted while it is typed');
  await page.fill('#profileKey', KEY);
  await page.click('#profileSave'); // no model yet
  await page.locator('#profileNote', { hasText: 'Not saved' }).waitFor();
  assert.equal((await call(instance, '/profiles')).profiles.length, 0, 'a refused form saved nothing');
  assert.equal(await page.inputValue('#profileKey'), KEY, 'a refused form keeps what was typed');
  await page.fill('#profileUrl', 'https://models.example.test');
  assert.equal(await page.locator('#profileHttp').isVisible(), false);
  await page.fill('#profileModels', 'glm-5.3\nkimi-k3:cloud');
  await shot('o48-form');
  await page.click('#profileSave');
  const row = page.locator('#setProfiles [data-profile]');
  await row.waitFor();
  assert.match(await row.textContent(), /Far Cloud.*https:\/\/models\.example\.test · glm-5\.3, kimi-k3:cloud · Key saved/);
  const [made] = (await call(instance, '/profiles')).profiles;
  assert.equal(made.secret, 'key');
  await shot('o48-saved');
  // After Save the page holds the key nowhere: no field, no markup, no storage.
  const held = () => page.evaluate((key) => [document.documentElement.outerHTML.includes(key), [...document.querySelectorAll('input,textarea')].some((el) => el.value.includes(key)), JSON.stringify({ ...localStorage, ...sessionStorage }).includes(key)], KEY);
  assert.deepEqual(await held(), [false, false, false]);
  await row.locator('[data-profile-edit]').click();
  assert.equal(await page.inputValue('#profileKey'), '', 'Edit never shows the saved key');
  assert.deepEqual(await held(), [false, false, false]);
  // A new base URL with no key typed: Settings asks for the key and sends nothing.
  await page.fill('#profileUrl', 'https://elsewhere.example.test');
  await page.click('#profileSave');
  await page.locator('#profileNote', { hasText: 'The base URL changed' }).waitFor({ timeout: 5000 });
  assert.equal((await call(instance, '/profiles')).profiles[0].baseUrl, made.baseUrl, 'nothing was saved');
  await page.click('#profileCancel');
  await page.keyboard.press('Escape');
  // New chat: the profile's models under Claude's own.
  assert.deepEqual(await newRows(page), [...CLAUDE, 'Far Cloud', 'glm-5.3', 'kimi-k3:cloud']);
  await page.click('#newBtn'); await page.locator('#newPop [data-profile]').first().waitFor(); await shot('o48-new-menu');
  await page.click('#newPop [data-profile][data-model="glm-5.3"]');
  let id; await until(async () => (id = (await call(instance, '/chat')).conversations.find((c) => c.profile)?.id), 'the chat was made on the profile');
  const pane = page.locator('.pane[data-id="' + id + '"]');
  await pane.locator('[data-pill="Model"]').waitFor({ timeout: 10000 });
  assert.equal((await pane.locator('[data-pill="Model"]').getAttribute('aria-label')), 'Model: glm-5.3');
  assert.equal(await pane.locator('.meters .meter').count(), 1, 'Context only: the Claude plan\'s 5 h and 7 d bars are not this chat\'s');
  await pane.locator('.composer textarea').fill('model'); await pane.locator('.composer textarea').press('Enter');
  await pane.locator('.hist', { hasText: 'model:glm-5.3' }).waitFor({ timeout: 20000 }); // ran, on its model, though the Claude default is Opus
  assert.deepEqual(seen(instance).filter((line) => line.what === 'new' && line.model).map((line) => [line.model, line.baseUrl, line.keyHash]), [['glm-5.3', 'https://models.example.test', hash(KEY)]]);
  await pane.locator('[data-pill="Model"]').click(); await page.locator('#pillMenu:not([hidden])').waitFor(); await shot('o48-pill'); await page.keyboard.press('Escape');
  assert.deepEqual(await menu(page, pane), { head: 'Far Cloud', items: ['glm-5.3'], notes: ['This chat runs on this model only. Start a new chat for another one.'] });
  assert.equal((await pane.locator('[data-pill="Model"]').getAttribute('aria-label')), 'Model: glm-5.3');
  // Its one-model report did not become Claude's list.
  assert.deepEqual(await newRows(page), [...CLAUDE, 'Far Cloud', 'glm-5.3', 'kimi-k3:cloud']);
  // Removed in Settings: gone from the menu, and the chat says why it cannot go on.
  await profilesPage(page);
  await page.click('#setProfiles [data-profile-remove]');
  await page.locator('#setProfiles [data-profile]').waitFor({ state: 'detached' });
  await page.keyboard.press('Escape');
  assert.deepEqual(await newRows(page), CLAUDE);
  assert.match((await menu(page, pane)).notes[0], /removed in Settings/);
  await pane.locator('.composer textarea').fill('model'); await pane.locator('.composer textarea').press('Enter');
  await pane.locator('.hist', { hasText: 'was removed' }).waitFor({ timeout: 20000 });
  assert.equal(await pane.getByText('Running', { exact: true }).count(), 0, 'a chat that cannot go on is not called Running');
  await shot('o48-removed');
  assert.deepEqual(errors.filter((e) => !/Failed to load resource/.test(e)), []);
  console.log('PASS window: profile in Settings, in the New chat menu, fixed model, key not held, removed profile said');
});
