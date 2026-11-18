// O189: a sprint script can reach its sprint's chats. P9 gives each approved script run a token (P9_SCRIPT_TOKEN) and
// the desktop socket (P9_SCRIPT_SOCKET); POST /script with that token sends a note (starts no turn) or a prompt (queued
// once, marked as a script's, not the user's) to the sprint's lead, a chat under it or the lead's parent. The token
// works only while that run runs, for at most 20 calls, and never reaches hooks.log or P9's state files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { daemon, http, authenticated, root } from './helpers.mjs';

const call = (instance, route, method = 'GET', body) => http({ socketPath: instance.credentials.socketPath, route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  .then((result) => ({ ...result, body: result.text ? JSON.parse(result.text) : null }));
// What a script does: no desktop cookie, only its token.
const say = (socketPath, token, body) => http({ socketPath, route: '/script', method: 'POST',
  headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { 'x-p9-script': token }) }, body: JSON.stringify(body) })
  .then((result) => ({ status: result.status, body: result.text ? JSON.parse(result.text) : null }));
const wait = async (check, what, tries = 150) => { for (let i = 0; i < tries; i += 1) { const v = await check(); if (v) return v; await new Promise((r) => setTimeout(r, 200)); } assert.fail('timed out: ' + what); };
const filesUnder = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => { const p = path.join(dir, d.name); return d.isDirectory() ? filesUnder(p) : d.isFile() ? [p] : []; });

test('script-say: a sprint script\'s token sends its lead a note and a queued prompt, only its own sprint, at most 20 calls, only while it runs', { timeout: 240000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', path.join(root, 'test/fake-acp-agent.mjs')] }));
  await call(instance, '/delegation', 'POST', { start: 'agent', max: 5, workers: [] });
  await call(instance, '/file-protection', 'POST', { on: false });
  const events = async (id) => (await call(instance, '/chat/events?after=0&only=' + id)).body.events;
  const warm = (await call(instance, '/chat', 'POST', { provider: 'claude' })).body.conversation;
  await call(instance, `/chat/${warm}/prompt`, 'POST', { text: 'config' });
  await wait(async () => (await events(warm)).some((e) => e.data?.content?.text?.startsWith('config:')), 'model list');
  const repo = path.join(instance.workspace, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'a']);
  const project = (await call(instance, '/projects', 'POST', { name: 'Said', work: { kind: 'new', parent: '', name: 'said' } })).body.project.id;
  const s = (await call(instance, '/projects/' + project + '/sprints', 'POST', { title: 'A script says' })).body, sprint = s.sprint;
  fs.writeFileSync(path.join(s.folder, 'sprint.md'), '# Plan\n\n- [ ] a1: a piece. Role: w1.\n');
  fs.writeFileSync(path.join(s.folder, 'roles.json'), JSON.stringify({ folder: 'repo', roles: [{ key: 'lead', provider: 'claude', model: 'haiku', effort: 'low' }] }));
  fs.copyFileSync(path.join(root, 'test/fixtures/script-say-hook.mjs'), path.join(s.folder, 'say-hook.mjs'));
  fs.writeFileSync(path.join(s.folder, 'hooks.json'), JSON.stringify({ scripts: [{ name: 'say', command: process.execPath + ' say-hook.mjs', point: 'sprint-start' }] }));
  const row = async () => (await call(instance, '/projects/' + project)).body.project.sprints.find((x) => x.lead === sprint);
  const started = await call(instance, `/sprints/${sprint}/start`, 'POST', { hooks: (await row()).files.find((f) => f.name === 'hooks.json').hash });
  assert.equal(started.status, 200, JSON.stringify(started.body));

  // The running script's environment: the desktop socket and a token of its own.
  const envFile = path.join(s.folder, 'script-env.json');
  const env = await wait(() => fs.existsSync(envFile) && JSON.parse(fs.readFileSync(envFile, 'utf8')), 'the script\'s environment file');
  assert.match(String(env.token), /^[0-9a-f]{64}$/, 'P9_SCRIPT_TOKEN is not in the script\'s environment: ' + JSON.stringify(env));
  assert.equal(env.socket, instance.credentials.socketPath);
  // Only the owner's uid reaches the socket at all: 0600, owned by the daemon's (this test's) user.
  const st = fs.statSync(env.socket);
  assert.deepEqual([st.mode & 0o777, st.uid], [0o600, process.getuid()]);

  // No token, or a wrong one: refused before anything else is read.
  assert.equal((await say(env.socket, undefined, { action: 'note', chat: sprint, text: 'x' })).status, 401);
  assert.equal((await say(env.socket, '0'.repeat(64), { action: 'note', chat: sprint, text: 'x' })).status, 401);

  // A note to the lead: a note event from P9, and no turn (no user message with it).
  const noted = await say(env.socket, env.token, { action: 'note', chat: sprint, text: 'usage tier 2 from the sampler' });
  assert.equal(noted.status, 200, JSON.stringify(noted.body));
  await wait(async () => (await events(sprint)).some((e) => e.type === 'note' && JSON.stringify(e.data).includes('usage tier 2 from the sampler')), 'the note');
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal((await events(sprint)).filter((e) => e.type === 'user' && JSON.stringify(e.data).includes('usage tier 2 from the sampler')).length, 0, 'the note started a turn');

  // A prompt to the lead: queued once, P9's, with the script's first line.
  const prompted = await say(env.socket, env.token, { action: 'prompt', chat: sprint, text: 'please look at usage now' });
  assert.equal(prompted.status, 200, JSON.stringify(prompted.body));
  const users = await wait(async () => { const u = (await events(sprint)).filter((e) => e.type === 'user' && JSON.stringify(e.data).includes('please look at usage now')); return u.length ? u : null; }, 'the prompt');
  await new Promise((r) => setTimeout(r, 1500));
  const again = (await events(sprint)).filter((e) => e.type === 'user' && JSON.stringify(e.data).includes('please look at usage now'));
  assert.equal(again.length, 1, 'the prompt arrived ' + again.length + ' times');
  assert.equal(users[0].data.from, 'p9');
  assert.match(JSON.stringify(users[0].data), /\[P9: from sprint script say, not from the user\.\]/);

  // Only this sprint's chats; only note or prompt (never steer).
  const other = await say(env.socket, env.token, { action: 'note', chat: warm, text: 'not yours' });
  assert.deepEqual([other.status, other.body.error], [422, 'not-this-sprints']);
  assert.equal((await say(env.socket, env.token, { action: 'steer', chat: sprint, text: 'now' })).status, 400);

  // At most 20 calls per run (the 4 above count): 16 more go through, the next is 429.
  for (let i = 0; i < 16; i += 1) assert.equal((await say(env.socket, env.token, { action: 'note', chat: sprint, text: 'n' + i })).status, 200, 'call ' + (i + 5));
  const capped = await say(env.socket, env.token, { action: 'note', chat: sprint, text: 'one too many' });
  assert.deepEqual([capped.status, capped.body.error], [429, 'too-many-calls']);

  // The run ends: its token stops working, and it is in neither hooks.log nor any of P9's state files.
  fs.writeFileSync(path.join(s.folder, 'script-go'), '');
  const log = await wait(() => { const l = fs.existsSync(path.join(s.folder, 'hooks.log')) && fs.readFileSync(path.join(s.folder, 'hooks.log'), 'utf8'); return l && l.includes('| say |') ? l : null; }, 'the run in hooks.log');
  assert.equal(log.includes(env.token), false, 'the token is in hooks.log: ' + log);
  assert.match(log, /my token is \[token\]/);
  assert.equal((await say(env.socket, env.token, { action: 'note', chat: sprint, text: 'late' })).status, 401);
  const status = await call(instance, `/sprints/${sprint}/status`);
  assert.equal(JSON.stringify(status.body ?? '').includes(env.token), false, 'the token is in the sprint status');
  for (const file of filesUnder(instance.state ?? path.dirname(env.socket))) assert.equal(fs.readFileSync(file).includes(env.token), false, 'the token is in ' + path.basename(file));
  console.log('PASS script-say: token in the run\'s env only; note (no turn), prompt (once, marked), 422 for another chat, 429 at call 21, 401 after the run; never in hooks.log, status or state files');
});
