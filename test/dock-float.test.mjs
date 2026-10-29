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
  // The shell's text starts on the terminal's first row, floating and docked, also after the dock is hidden and opened again
  // (reattaching the same shell), not in the middle or the lower half.
  const shows = (want) => page.waitForFunction((w) => document.querySelector('#termView .xterm-rows')?.textContent.includes(w), want, { timeout: 10000 });
  const type = async (line) => { await page.click('#termView'); await page.keyboard.type(line); await page.keyboard.press('Enter'); };
  const layout = () => page.evaluate(() => {
    const rows = [...document.querySelectorAll('#termView .xterm-rows > div')], box = document.querySelector('#termView').getBoundingClientRect();
    const screen = document.querySelector('#termView .xterm-screen')?.getBoundingClientRect();
    return { first: rows.findIndex((row) => row.textContent.trim()), rows: rows.length, screenTop: Math.round((screen?.top ?? 0) - box.top), fits: Math.round(box.height) };
  });
  const reopen = async (name) => {
    await page.click('#dHide'); await page.click('#rTerm');
    await page.locator('#dState', { hasText: /^Connected$/ }).waitFor({ timeout: 15000 });
    await page.waitForTimeout(800);
    await evidence(page, name);
    return layout();
  };
  for (const n of [1, 2, 3]) { await type('echo LINE""' + n); await shows('LINE' + n); }
  const floated = await reopen('dock-float-reopen');
  await page.click('#dFloat'); await page.waitForTimeout(500);
  const docked = await reopen('dock-drawer-reopen');
  assert.deepEqual({ floated: floated.first, docked: docked.first }, { floated: 0, docked: 0 },
    JSON.stringify({ floated, docked }));
  // Dev Focus: its editor is drawn above the page, so the terminal there only docks (no float button, a floating one docks
  // itself) and the theme picker is off, saying why. Back in Chat the terminal floats again and the picker works.
  await page.click('#dFloat'); await page.waitForTimeout(300);
  assert.ok(await page.locator('#dock.float').isVisible(), 'floating again in Chat Focus');
  const dev = () => page.evaluate(() => ({ float: document.querySelector('#dock').classList.contains('float'), floatButton: Boolean(document.querySelector('#dFloat').offsetParent),
    theme: document.querySelector('#themeBtn').disabled, title: document.querySelector('#themeBtn').title }));
  await page.click('[data-focus-btn="dev"]'); await page.waitForTimeout(800);
  await evidence(page, 'dev-focus-docked');
  assert.deepEqual(await dev(), { float: false, floatButton: false, theme: true, title: 'Look: not available in Dev Focus, where the editor would cover the picker' });
  await page.click('[data-focus-btn="chat"]'); await page.waitForTimeout(500);
  assert.deepEqual(await dev(), { float: true, floatButton: true, theme: false, title: 'Look: the theme of this focus mode' });
});
