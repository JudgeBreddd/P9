// O48 provider profiles (SECURITY.md "Provider profiles"): another service's models in Claude chats. The stand-in agent
// writes what it saw to profile.log: names and a hash, never the key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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
