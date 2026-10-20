// Hot reload check: a new file in apps/web/dist must be served and the window reloaded, with no app restart.
// Run: node scripts/hot-reload-check.mjs (any open P9 window on the new code reloads too; chats keep running).
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));
const probe = path.join(root, 'apps/web/dist/hot-reload-probe.txt'), token = randomBytes(8).toString('hex');
const profile = await mkdtemp(path.join(os.tmpdir(), 'p9-hot-'));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const application = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 15000 });
try {
  const page = await application.firstWindow({ timeout: 15000 });
  await page.locator('#cards .card').first().waitFor();
  await page.evaluate(() => { window.hotMark = 1; });
  await writeFile(probe, token);
  await page.waitForFunction(() => window.hotMark === undefined, [], { timeout: 10000 });
  await page.locator('#cards .card').first().waitFor();
  assert.equal(await page.evaluate(async () => (await fetch('/hot-reload-probe.txt')).text()), token);
  console.log('PASS: window reloaded and serves the new build');
} finally {
  await rm(probe, { force: true });
  await application.close();
  await rm(profile, { recursive: true, force: true });
}
