// O200 in the window: the panel's search lists a chat found by a word said only in its messages (not in its title), with a
// line under the row showing the words that matched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, http, authenticated, root, versionSeen } from './helpers.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const call = (instance, route, method = 'GET', body) => http({ socketPath: instance.credentials.socketPath, route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  .then((result) => ({ ...result, body: result.text ? JSON.parse(result.text) : null }));
const settle = async (check, what, ms = 30000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) if (await check()) return; assert.fail('timed out: ' + what); };

test('O200 window: a search finds a chat by a word only in its messages and shows the matching words under its row', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const chat = (await call(instance, '/chat', 'POST', { provider: 'claude' })).body.conversation;
  await call(instance, `/chat/${chat}/prompt`, 'POST', { text: 'tell me about the quokka' });
  await settle(async () => (await call(instance, '/chat/events?after=0&only=' + chat)).body.events.some((e) => e.type === 'turn-end'), 'the turn');
  assert.equal((await call(instance, `/chat/${chat}/rename`, 'POST', { title: 'Plain title' })).status, 200);

  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-chat-search-')), 'profile');
  await mkdir(profile, { recursive: true }); await versionSeen(profile);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  const row = page.locator(`#navList .rowwrap:has(.row[data-chat="${chat}"])`);
  await row.waitFor({ timeout: 20000 });
  await settle(async () => (await row.locator('.row .t').innerText()) === 'Plain title', 'the renamed row', 10000);

  await page.fill('#navQ', 'Quokka');
  await row.locator('.snip mark').waitFor({ timeout: 10000 });
  assert.match(await row.locator('.snip').innerText(), /the quokka/);
  // A word in neither the title nor the messages lists nothing.
  await page.fill('#navQ', 'quokkas2');
  await row.waitFor({ state: 'detached', timeout: 10000 });
  // A search matching the title shows the row without a snippet.
  await page.fill('#navQ', 'plain');
  await row.waitFor({ timeout: 10000 });
  await page.waitForTimeout(800); // past the search's 250 ms wait and its answer
  assert.equal(await row.locator('.snip').count(), 0);
  // A message said after the search is typed finds the chat without retyping it.
  await page.fill('#navQ', 'wombat');
  await row.waitFor({ state: 'detached', timeout: 10000 });
  await page.waitForTimeout(800); // the search for wombat has answered (no match) before the message is said
  await call(instance, `/chat/${chat}/prompt`, 'POST', { text: 'now the wombat' });
  await row.locator('.snip mark').waitFor({ timeout: 15000 });
  assert.match(await row.locator('.snip').innerText(), /the wombat/);
});
