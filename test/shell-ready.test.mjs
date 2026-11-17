// shellReady (test/helpers.mjs) waits for loaded data, never for a kept alert alone: a remote-update alert can light the
// bell before the chats and waiting items have loaded, and a test that went on then would read an empty shell.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from '@playwright/test';
import { shellReady, shellReadyCheck } from './helpers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

test('shellReady: the bell counts toward ready only for loaded chats and waiting items, not for a kept alert', { timeout: 60000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'p9-shell-ready-'));
  const env = { ...process.env, P9_SAMPLE_DATA: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--user-data-dir=' + profile], env, timeout: 15000 });
  t.after(() => app.close());
  const page = await app.firstWindow({ timeout: 15000 });
  await shellReady(page, { timeout: 15000 });
  const bell = () => page.evaluate(() => ({ shown: Number(document.querySelector('#rBell b').textContent) || 0, items: Number(document.querySelector('#rBell').dataset.items) }));
  const before = await bell();
  // A kept alert, as a remote-update alert is: the bell's number goes up, the data count does not.
  await page.evaluate(() => window.__toast({ kind: 'chat', txt: 'A remote update', level: 'bad' }));
  await page.waitForFunction((n) => Number(document.querySelector('#rBell b').textContent) === n, before.shown + 1, { timeout: 5000 });
  const after = await bell();
  assert.ok(Number.isInteger(before.items), 'the bell carries a data-items count (' + before.items + ')');
  assert.equal(after.items, before.items, 'a kept alert does not count as loaded data');
  // The early-alert screen: no card drawn yet, the bell lit by that alert only, no data loaded (items 0).
  // Set and checked in one evaluate, so no render between them puts the real count back.
  const at = (items) => page.evaluate(`(() => { document.querySelector('#cards').style.display = 'none'; document.querySelector('#rBell').dataset.items = '${items}'; return { lit: Number(document.querySelector('#rBell b').textContent) > 0, ready: (${shellReadyCheck})() }; })()`); // lit is #259's first bell check, which counted alerts
  assert.deepEqual(await at(0), { lit: true, ready: false }, 'the old check (lit) passed on the alert alone; the new one does not');
  // Data arrives: one bell item from it, and the shell is ready.
  assert.deepEqual(await at(1), { lit: true, ready: true }, 'a bell item from data is ready');
  console.log('PASS shellReady ignores a kept alert: bell', before.shown, '->', after.shown, 'items', before.items, '->', after.items);
});
