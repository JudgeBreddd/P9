// The floating Shell dock shows only the terminal: no light bar drawn over it (0.1.6 on a laptop: a white bar with a black
// border, about 230 by 8 px, in the lower middle of the terminal in every focus that floats the dock).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { _electron } from '@playwright/test';
import { daemon, root, versionSeen } from './helpers.mjs';

const evidence = async (page, name) => {
  const png = await page.screenshot();
  if (process.env.P9_EVIDENCE) { await mkdir(process.env.P9_EVIDENCE, { recursive: true }); await writeFile(path.join(process.env.P9_EVIDENCE, name + '.png'), png); }
  else if (process.env.CI !== 'true') console.log('P9_SHOT ' + name + ' ' + png.toString('base64'));
};

test('Floating Shell dock: nothing light drawn over the terminal', { skip: process.platform === 'win32' ? 'tmux' : false, timeout: 90000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--tmux-socket', 'p9t-' + randomUUID().slice(0, 8)] }));
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-float-')), 'profile');
  await mkdir(profile); await versionSeen(profile);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#rChat').waitFor();
  await page.click('#rTerm');
  await page.locator('#dState', { hasText: /^Connected$/ }).waitFor({ timeout: 15000 });
  assert.ok(await page.locator('#dock.float').isVisible(), 'the dock floats in Chat Focus');
  await page.waitForTimeout(500);
  await page.evaluate(() => Promise.allSettled(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished)));
  await evidence(page, 'dock-float');
  // Whatever is on top anywhere over the terminal belongs to the dock: nothing from the page behind paints through it.
  const over = await page.evaluate(() => {
    const view = document.querySelector('#termView').getBoundingClientRect(), dock = document.querySelector('#dock'), out = new Set();
    for (let x = view.left + 4; x < view.right; x += 6) for (let y = view.top + 4; y < view.bottom; y += 3) {
      const top = document.elementFromPoint(x, y);
      if (top && !dock.contains(top)) {
        const r = top.getBoundingClientRect(), s = getComputedStyle(top);
        out.add(top.tagName.toLowerCase() + (top.id ? '#' + top.id : '') + '.' + [...top.classList].join('.') + ' in ' + (top.parentElement?.id || top.parentElement?.className) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' z ' + s.zIndex + ' pos ' + s.position);
      }
    }
    return [...out];
  });
  assert.deepEqual(over, []);
});
