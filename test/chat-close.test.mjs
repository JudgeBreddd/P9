// The tab's x stops the chat, idle or running, on the daemon, so every window agrees: a new window reopens none of
// them, History lists the used ones most recently used first and Open gives the tab back. Real Electron, the real daemon
// and the fake agent, once per agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, http, authenticated, root } from './helpers.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((result) => ({ status: result.status, ...JSON.parse(result.text) }));
const until = async (check, what, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 200))) if (await check()) return;
  assert.fail('timed out: ' + what);
};
const state = async (instance, id) => (await call(instance, '/chat')).conversations.find((c) => c.id === id)?.state;

async function launch(t, instance) {
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-close-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('#dataNote', { hasText: 'Chat live' }).waitFor({ timeout: 20000 });
  const tabs = () => page.evaluate(() => [...document.querySelectorAll('#tabs .tab')].map((tab) => tab.dataset.id).sort());
  return { app, page, tabs, errors };
}

for (const provider of ['claude', 'codex']) {
  test('chat close ' + provider + ': the x stops an idle chat too, other windows drop it, History lists only used chats, newest use first', { timeout: 150000 }, async (t) => {
    const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
    const make = async (text) => {
      const id = (await call(instance, '/chat', 'POST', { provider })).conversation;
      if (text) {
        await call(instance, '/chat/' + id + '/prompt', 'POST', { text });
        await until(async () => (await call(instance, '/chat/events?after=0&only=' + id)).events.some((e) => e.type === 'turn-end'), text + ' answered');
      }
      return id;
    };
    const sent = await make('hello'), unsent = await make(), other = await make('hello');
    const first = await launch(t, instance);
    await until(async () => JSON.stringify(await first.tabs()) === JSON.stringify([sent, unsent, other].sort()), 'three tabs');
    // The x on a used idle chat and on one never sent: the tab goes and the daemon stops it.
    for (const id of [sent, unsent]) {
      await first.page.locator('#tabs .tab[data-id="' + id + '"] .close').click();
      await first.page.locator('#tabs .tab[data-id="' + id + '"]').waitFor({ state: 'detached', timeout: 10000 });
      await until(async () => (await state(instance, id)) === 'stopped', 'the x stopped ' + id);
    }
    // The x in another window: this one drops the tab too.
    assert.equal((await call(instance, '/chat/' + other + '/stop', 'POST', { close: true })).status, 200);
    await first.page.locator('#tabs .tab[data-id="' + other + '"]').waitFor({ state: 'detached', timeout: 10000 });
    // History: the two used chats, the newest use first; the one never sent is not there. Open gives its tab back.
    await first.page.click('#histBtn');
    const rows = () => first.page.locator('#histPop [data-open]').evaluateAll((all) => all.map((b) => b.dataset.open));
    assert.deepEqual(await rows(), [other, sent]);
    await first.page.locator('#histPop [data-open="' + sent + '"]').click();
    await first.page.locator('#tabs .tab[data-id="' + sent + '"]').waitFor({ timeout: 10000 });
    assert.deepEqual(first.errors, []);
    await first.app.close();

    // A new window (its own empty storage) reopens none of them.
    const legacy = await make();
    const second = await launch(t, instance);
    await until(async () => JSON.stringify(await second.tabs()) === JSON.stringify([legacy]), 'only the chat never closed has a tab (' + JSON.stringify(await second.tabs()) + ')');
    // A chat closed in this window before the x stopped chats: stopped once at the next load, and the old list is gone.
    await second.page.evaluate((id) => localStorage.setItem('eh-closed-chats', JSON.stringify([id])), legacy);
    await second.page.reload();
    await second.page.locator('#dataNote', { hasText: 'Chat live' }).waitFor({ timeout: 20000 });
    await until(async () => (await state(instance, legacy)) === 'stopped', 'the old closed chat was stopped');
    await until(async () => (await second.tabs()).length === 0, 'its tab is gone');
    assert.equal(await second.page.evaluate(() => localStorage.getItem('eh-closed-chats')), null);
    assert.deepEqual(second.errors, []);
    console.log('PASS chat close ' + provider + ': x stopped idle and used chats, another window dropped the tab, History [used, newest first] opens one again, a new window opened none, the old closed list was stopped and removed');
  });
}
