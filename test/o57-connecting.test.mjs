// O57: New chat pressed while the window is still connecting to its daemon. Before, the window made a local chat with a model
// named `undefined` and 0% usage, and dropped it once the daemon answered. Now it says it is connecting, makes nothing up,
// and opens the chat on the daemon once it answers. Real Electron, the real daemon (started after the window) and the fake agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, root } from './helpers.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs');

test('O57: New chat while connecting waits for the daemon and opens the chat once it answers', { timeout: 120000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'p9-o57-'));
  let app, page, before;
  // The window starts first, on the state folder the daemon will use; the daemon starts once New chat was pressed.
  await daemon(t, undefined, false, async (paths) => {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.P9_SAMPLE_DATA;
    app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', paths.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
    const proc = app.process();
    t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
    page = await app.firstWindow();
    await page.locator('#rChat').waitFor();
    // The window has tried the daemon and found none (the status line no longer says it is checking).
    await page.waitForFunction(() => !/checking/.test(document.querySelector('#daemonStatus')?.textContent), null, { timeout: 15000 });
    await page.evaluate(() => document.querySelector('#newBtn').click());
    await page.waitForTimeout(500);
    before = await page.evaluate(() => ({ panes: [...document.querySelectorAll('#chats .pane')].map((p) => p.textContent.replace(/\s+/g, ' ')),
      toasts: [...document.querySelectorAll('#toasts .toast')].map((x) => x.textContent) }));
    return { args: ['--acp-override', fake] };
  });
  // While connecting: no chat with made-up values, and the window says what it is waiting for.
  assert.ok(!before.panes.some((p) => /undefined/.test(p)), 'a chat pane names a model "undefined": ' + before.panes.join(' | ').slice(0, 300));
  assert.deepEqual(before.panes, [], 'no chat is drawn before the daemon answers');
  assert.ok(before.toasts.some((x) => /Connecting/.test(x)), 'no word that the chat waits for the connection: ' + before.toasts.join(' | '));
  // Once the daemon answers, the chat the user asked for is there, open, with the daemon's model.
  await page.waitForFunction(() => /Chat live/.test(document.querySelector('#dataNote')?.textContent), null, { timeout: 30000 });
  const pane = page.locator('#chats .pane');
  await pane.first().waitFor({ timeout: 15000 });
  assert.equal(await page.locator('#navList .row[data-chat]').count(), 1, 'one chat, the one New chat asked for');
  assert.doesNotMatch(await pane.first().textContent(), /undefined/);
  await pane.first().locator('[data-pill="Model"]').waitFor({ timeout: 10000 });
  const png = await page.screenshot({ type: 'png' });
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT o57-opened ' + png.toString('base64'));
});
