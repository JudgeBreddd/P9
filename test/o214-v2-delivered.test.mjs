// O214: a P9 restart during a role's first turn. On ACP v2 (Codex) the agent answers session/prompt with a messageId
// the moment it takes the message into its thread, so the message arrived even if the turn never ended: the next Start
// does not send it again, nor does the next message carry its start block again. A turn that fails after that answer
// (signed out) did not arrive and is sent again. ACP v1 (Claude) has no such answer and keeps today's rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { daemon, restart, http, authenticated, root } from './helpers.mjs';

const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  .then((result) => ({ ...result, body: result.text ? JSON.parse(result.text) : null }));
const events = async (instance, id) => (await call(instance, '/chat/events?after=0&only=' + id)).body.events;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(instance, id, match) {
  for (let i = 0; i < 150; i += 1) {
    const hit = (await events(instance, id)).find(match);
    if (hit) return hit;
    await pause(200);
  }
  throw new Error('no such event on ' + id + ': ' + (await events(instance, id)).map((e) => e.type).join(' '));
}
const work = (instance, id) => events(instance, id).then((all) => all.filter((e) => e.type === 'user' && !String(e.data?.text).startsWith('[p9] P9 restarted')).length);
const said = (e) => e.type === 'update' && String(e.data?.content?.text).startsWith('said:');
// A sprint on one agent: its roles, each role's work, and the chat P9 reads the agent's model list from.
async function sprint(t, agent, provider, roles, text) {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', path.join(root, agent)] }));
  const project = (await call(instance, '/projects', 'POST', { name: 'Restart', work: { kind: 'new', parent: '', name: 'restart' } })).body.project.id;
  await call(instance, '/file-protection', 'POST', { on: false }); // Unrestricted, as the sprint tests run
  const probe = (await call(instance, '/chat', 'POST', { provider })).body.conversation;
  await call(instance, `/chat/${probe}/prompt`, 'POST', { text: provider === 'codex' ? 'fail' : 'config' });
  await until(instance, probe, (e) => ['turn-end', 'error'].includes(e.type));
  const s = (await call(instance, '/projects/' + project + '/sprints', 'POST', { title: 'Restart' })).body;
  const row = (key) => ({ key, provider, model: provider === 'codex' ? 'opus' : 'haiku', effort: provider === 'codex' ? '' : 'low' });
  fs.writeFileSync(path.join(s.folder, 'roles.json'), JSON.stringify({ roles: roles.map(row) }));
  for (const key of roles) fs.writeFileSync(path.join(s.folder, `roles/${key}.work.md`), text);
  return { instance, s };
}
// P9 stops (killed, as a crash or a power cut) while the first turns run, and starts again on the same ledger.
async function crash(t, instance, id) {
  await until(instance, id, (e) => e.type === 'user');
  await pause(2000);
  assert.equal((await events(instance, id)).some((e) => e.type === 'turn-end'), false, 'the first turn ended before the restart');
  instance.child.kill('SIGKILL');
  await new Promise((r) => instance.child.once('exit', r));
  return restart(t, instance, 'state-2');
}

test('O214 v2 (Codex): P9 restarts during the first turns; the next Start sends neither role its work again, and P9\'s restart line to the lead does not carry its start block again', { timeout: 240000 }, async (t) => {
  const { instance, s } = await sprint(t, 'test/fake-acp-v2-agent.mjs', 'codex', ['lead', 'review'], 'slow');
  const first = await call(instance, `/sprints/${s.sprint}/start`, 'POST', {});
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const w1 = first.body.chats.find((c) => c.key === 'review').chat;
  await until(instance, w1, (e) => e.type === 'user');
  const second = await crash(t, instance, s.sprint);
  // P9's line to the lead (a sprint with a chat cut mid-turn): P9 sends it, so a start block not yet sent rides with it.
  const line = await until(second, s.sprint, said);
  assert.doesNotMatch(line.data.content.text, /you lead this sprint/, 'the restart line carried the lead\'s start block again');
  const again = await call(second, `/sprints/${s.sprint}/start`, 'POST', {});
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual([await work(second, s.sprint), await work(second, w1)], [1, 1], 'a role was sent its first message again: ' + JSON.stringify(again.body.chats));
  assert.deepEqual(again.body.chats.map((c) => [c.key, c.sent ?? false]), [['lead', false], ['review', false]]);
  console.log('PASS O214 v2: after a restart mid-first-turn, Start sent no role its work again; the restart line had no start block');
});

test('O214 v2 (Codex): after that restart, a next turn that fails (signed out) does not undo the first message\'s arrival', { timeout: 180000 }, async (t) => {
  const { instance, s } = await sprint(t, 'test/fake-acp-v2-agent.mjs', 'codex', ['lead'], 'slow');
  assert.equal((await call(instance, `/sprints/${s.sprint}/start`, 'POST', {})).status, 200);
  const second = await crash(t, instance, s.sprint);
  await call(second, `/chat/${s.sprint}/prompt`, 'POST', { text: 'fail' });
  await until(second, s.sprint, (e) => e.type === 'error');
  const again = await call(second, `/sprints/${s.sprint}/start`, 'POST', {});
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(await work(second, s.sprint), 2, 'the first message was sent again after a later turn failed (2 = it and the failed one)');
  console.log('PASS O214 v2: a failed turn after the restart left the first message counted as arrived');
});

test('O214 v2 (Codex): a first turn that fails after the agent took it (signed out) is sent again on the next Start', { timeout: 180000 }, async (t) => {
  const { instance, s } = await sprint(t, 'test/fake-acp-v2-agent.mjs', 'codex', ['lead'], 'fail');
  const first = await call(instance, `/sprints/${s.sprint}/start`, 'POST', {});
  await until(instance, s.sprint, (e) => e.type === 'error');
  fs.writeFileSync(path.join(s.folder, 'roles/lead.work.md'), 'echo');
  const again = await call(instance, `/sprints/${s.sprint}/start`, 'POST', {});
  assert.equal(again.status, 200, JSON.stringify([first.body, again.body]));
  assert.equal(await work(instance, s.sprint), 2, 'the failed first message was not sent again');
  // Its start block too: the turn that failed did not deliver it.
  assert.match((await until(instance, s.sprint, said)).data.content.text, /you lead this sprint/, 'the resend lost the lead\'s start block');
  console.log('PASS O214 v2: a first turn that failed after the agent took it was sent again, start block included');
});

test('O214 v1 (Claude): unchanged, a first turn P9 restarted during is sent again on the next Start', { timeout: 180000 }, async (t) => {
  const { instance, s } = await sprint(t, 'test/fake-acp-agent.mjs', 'claude', ['lead'], 'slow');
  assert.equal((await call(instance, `/sprints/${s.sprint}/start`, 'POST', {})).status, 200);
  const second = await crash(t, instance, s.sprint);
  const again = await call(second, `/sprints/${s.sprint}/start`, 'POST', {});
  assert.equal(await work(second, s.sprint), 2, 'v1 changed: ' + JSON.stringify(again.body));
  console.log('PASS O214 v1: a first turn P9 restarted during was sent again, as before');
});
