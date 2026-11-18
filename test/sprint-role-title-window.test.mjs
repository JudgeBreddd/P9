// O172 (window half): a sprint started while the window is open. The daemon kept each chat's role name (#304), but the
// window took the agent's live session_info_update title over it, so the rows said the task's title, not the role, until
// a restart. Real Electron, the real daemon and the fake agent ("title <text>" in a role's work file sends a title).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { _electron } from '@playwright/test';
import { daemon, http, authenticated, root, versionSeen } from './helpers.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const call = (instance, route, method = 'GET', body) => http({ socketPath: instance.credentials.socketPath, route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  .then((result) => ({ ...result, body: result.text ? JSON.parse(result.text) : null }));
const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
const events = async (instance, id) => (await call(instance, '/chat/events?after=0&only=' + id)).body.events;
const settle = async (check, what, ms = 30000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) { const got = await check(); if (got) return got; } assert.fail('timed out: ' + what); };
const titled = async (instance, id) => (await events(instance, id)).some((e) => e.data?.sessionUpdate === 'session_info_update' || e.data?.update?.sessionUpdate === 'session_info_update');

test('Sprint O172 window: chats of a sprint started with the window open keep their role names in the rows, live and after a reload; the user\'s rename still wins', { timeout: 150000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  await call(instance, '/file-protection', 'POST', { on: false });
  const ws = instance.workspace, repo = path.join(ws, 'repo');
  fs.mkdirSync(repo); g(repo, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); g(repo, 'add', 'a.txt'); g(repo, 'commit', '-qm', 'a');
  // One plain chat first: its session reads claude's model list, which a sprint role's model is checked against (as #304's test).
  const plain = (await call(instance, '/chat', 'POST', { provider: 'claude' })).body.conversation;
  await call(instance, `/chat/${plain}/prompt`, 'POST', { text: 'hi' });
  await settle(async () => (await events(instance, plain)).some((e) => e.type === 'turn-end'), 'the plain chat\'s turn');
  const project = (await call(instance, '/projects', 'POST', { name: 'Fresh', work: { kind: 'new', parent: '', name: 'fresh' } })).body.project.id;
  const prep = (await call(instance, '/projects/' + project + '/sprints', 'POST', { title: 'test 1' })).body;
  const file = (name) => path.join(prep.folder, name);
  fs.writeFileSync(file('roles.json'), JSON.stringify({ folder: 'repo', roles: ['lead', 'review'].map((key) => ({ key, provider: 'claude', model: 'haiku', effort: 'low' })) }));
  fs.writeFileSync(file('roles/lead.work.md'), 'title Sales tax close');
  fs.writeFileSync(file('roles/review.work.md'), 'title Sales tax close review');

  // The window is open before Start, so the chats arrive live (the owner's case), not from a restart's list.
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-role-title-window-')), 'profile');
  await mkdir(profile, { recursive: true }); await versionSeen(profile);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#rChat').waitFor();

  const press = await call(instance, `/sprints/${prep.sprint}/start`, 'POST', {});
  assert.equal(press.status, 200, JSON.stringify(press.body));
  const lead = prep.sprint, review = press.body.chats.find((c) => c.key === 'review').chat;
  // Each agent sent its title (so the check is not vacuous), and its turn ended.
  for (const id of [lead, review]) await settle(async () => (await titled(instance, id)) && (await events(instance, id)).some((e) => e.type === 'turn-end'), 'a titled turn from ' + id);

  // A search for the project lists all its chats, workers unfolded; a row's title attribute is the chat's name.
  const rows = async () => { await page.fill('#navQ', 'Fresh'); return page.evaluate((ids) => ids.map((id) => (document.querySelector(`#navList .row[data-chat="${id}"]`)?.title ?? '').split(' · ')[0]), [lead, review]); };
  const names = async (want, what) => { let got; await settle(async () => JSON.stringify(got = await rows()) === JSON.stringify(want), what, 15000).catch(() => {}); assert.deepEqual(got, want, what); };
  // O172, Sprint panel: on the lead's chat the card lists its workers (kin: the lead is not a row of its own card), each by
  // the <b> in .sp-name; the lead's own name is the pane's crumb.
  const panel = async () => { await page.locator(`#navList .row[data-chat="${lead}"]`).click(); return page.evaluate((id) => { const p = document.querySelector(`.pane[data-id="${id}"]`);
    return { crumb: p?.querySelector('.ptool .ct')?.textContent ?? '', rows: [...(p?.querySelectorAll('.sprint .sp-row .sp-name b') ?? [])].map((b) => b.textContent) }; }, lead); };
  const card = async (what) => { const want = { crumb: 'test 1', rows: ['review'] }; let got; await settle(async () => JSON.stringify(got = await panel()) === JSON.stringify(want), what, 15000).catch(() => {}); assert.deepEqual(got, want, what); };
  await names(['test 1', 'review'], 'live: the lead keeps its sprint\'s name and the worker its role key over the agent\'s titles');
  await card('live: the Sprint panel names the lead and its worker by role');
  await page.reload(); await page.locator('#rChat').waitFor();
  await names(['test 1', 'review'], 'after a reload the role names show');
  await card('after a reload the Sprint panel names them by role');

  const renamed = await call(instance, `/chat/${review}/rename`, 'POST', { title: 'Reviewer A' });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  await names(['test 1', 'Reviewer A'], 'the user\'s rename names a sprint chat in the window');
  console.log('PASS sprint role title window');
});
