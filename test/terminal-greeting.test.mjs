// Settings > General: "Show the shell's welcome message". Off: new terminals get P9_NO_GREETING=1, and fish (tmux's
// default-shell here) starts with its greeting function emptied; on (the default): the shell starts as tmux starts it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, http, authenticated, root } from './helpers.mjs';

const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((result) => ({ status: result.status, body: JSON.parse(result.text) }));

test('Terminal welcome message: shown by default; off hides fish\'s greeting and sets P9_NO_GREETING=1 in new terminals', { skip: process.platform !== 'linux', timeout: 120000 }, async (t) => {
  // A stand-in fish: each start writes its arguments and its P9_NO_GREETING, then waits as a shell would.
  const bin = await mkdtemp(path.join(os.tmpdir(), 'p9-greet-')), fish = path.join(bin, 'fish');
  await writeFile(fish, '#!/bin/sh\n{ printf "%s|" "$@"; echo; echo "NG=$P9_NO_GREETING"; } > ' + bin + '/start.$$\nexec sleep 600\n');
  await chmod(fish, 0o755);
  const instance = await daemon(t, undefined, false, async () => ({ env: { SHELL: fish } }));
  const starts = async () => (await readdir(bin)).filter((name) => name.startsWith('start.'));
  // A new terminal from the desktop; returns what its shell was started with.
  const started = async () => {
    const before = new Set(await starts());
    const made = await call(instance, '/terminals', 'POST', {});
    assert.equal(made.status, 201, JSON.stringify(made.body));
    for (let i = 0; i < 100; i++) {
      const file = (await starts()).find((name) => !before.has(name));
      if (file) { const text = await readFile(path.join(bin, file), 'utf8'); if (text.includes('NG=')) return text; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('the shell never started');
  };
  t.after(() => call(instance, '/stop-all', 'POST', {}).catch(() => {}));

  assert.deepEqual((await call(instance, '/terminal-greeting')).body, { show: true });
  for (const bad of [{ show: 'no' }, { show: false, x: 1 }, {}, [false], null]) assert.equal((await call(instance, '/terminal-greeting', 'POST', bad)).status, 400);
  assert.equal(await started(), '|\nNG=\n', 'shown: the shell starts as tmux starts it');

  const profile = path.join(bin, 'profile'), env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#rChat').waitFor();
  // The IPC takes {} or exactly { show: boolean }.
  for (const bad of [{ show: 'no' }, { show: true, x: 1 }]) assert.equal((await page.evaluate((body) => window.p9.terminal('greeting', body), bad)).status, 400);
  await page.click('#setBtn');
  const box = page.locator('#setGreeting');
  assert.equal(await box.isChecked(), true);
  await box.uncheck();
  await page.waitForFunction(() => document.querySelector('#setGreeting')?.checked === false && !document.querySelector('#setGreeting').disabled, null, { timeout: 5000 });
  assert.deepEqual((await call(instance, '/terminal-greeting')).body, { show: false });
  await box.scrollIntoViewIfNeeded();
  console.log('P9_SHOT terminal-greeting-setting ' + (await page.screenshot()).toString('base64'));
  assert.equal(await started(), '-l|-C|function fish_greeting; end|\nNG=1\n', 'hidden: fish with its greeting emptied');

  await box.check();
  await page.waitForFunction(() => document.querySelector('#setGreeting')?.checked === true, null, { timeout: 5000 });
  assert.deepEqual((await call(instance, '/terminal-greeting')).body, { show: true });
  assert.equal(await started(), '|\nNG=\n', 'shown again');
  console.log('PASS terminal greeting: default shown, off hides it, on brings it back');
});
