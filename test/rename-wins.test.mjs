// O126 (Tyler, 2026-11-17): "when a session resumes, it changes the chat name i set for it." The daemon already kept the
// user's name (conversations.title); the window took the agent's later session_info_update title over it. Real Electron,
// the real daemon and the fake agent ("title <text>" sends a session_info_update title).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, http, authenticated, root, versionSeen } from './helpers.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((result) => JSON.parse(result.text));
const until = async (check, what, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) if (await check()) return;
  assert.fail('timed out: ' + what);
};
const turns = async (instance, id) => (await call(instance, '/chat/events?after=0&only=' + id)).events.filter((e) => e.type === 'turn-end').length;
const say = async (instance, id, text) => { const n = await turns(instance, id); await call(instance, `/chat/${id}/prompt`, 'POST', { text }); await until(async () => (await turns(instance, id)) > n, id + ' answered ' + text); };
const listed = async (instance, id) => (await call(instance, '/chat')).conversations.find((c) => c.id === id);
async function launch(t, instance) {
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-rename-wins-')), 'profile');
  await mkdir(profile, { recursive: true }); await versionSeen(profile);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#rChat').waitFor();
  return page;
}

test('Rename wins: a name the user gave stays over the agent\'s title, live and after a restart; an unnamed chat takes it', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const open = async () => (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  const named = await open(), plain = await open();
  await say(instance, named, 'hello');
  assert.equal((await call(instance, `/chat/${named}/rename`, 'POST', { title: 'My own name' })).title, 'My own name');
  // The agent's title after the rename: the replay order that took the name away.
  await say(instance, named, 'title Agent title');
  await say(instance, plain, 'title Agent plain title');
  // The daemon's list (what the phone draws) already kept the name before O126.
  assert.equal((await listed(instance, named)).title, 'My own name');
  assert.equal((await listed(instance, plain)).title, 'Agent plain title');

  // A fresh window replays both chats from the start (a restart).
  const page = await launch(t, instance);
  const title = (id) => page.locator(`#navList .row[data-chat="${id}"]`);
  await title(plain).filter({ hasText: 'Agent plain title' }).waitFor({ timeout: 15000 });
  await title(named).waitFor({ timeout: 15000 });
  assert.match(await title(named).innerText(), /My own name/, 'after a restart the user\'s name shows');
  assert.doesNotMatch(await title(named).innerText(), /Agent title/);

  // Live: another agent title while the window is open leaves the name; an unnamed chat still follows its agent.
  await say(instance, named, 'title Agent title again');
  await say(instance, plain, 'title Agent plain title two');
  await title(plain).filter({ hasText: 'Agent plain title two' }).waitFor({ timeout: 15000 });
  assert.match(await title(named).innerText(), /My own name/, 'live, the user\'s name stays');
  assert.doesNotMatch(await title(named).innerText(), /Agent title/);
  // The list says which name is the user's (a tailed replay can leave the renamed event out).
  assert.equal((await listed(instance, named)).named, true);
  assert.equal((await listed(instance, plain)).named, false);
});
