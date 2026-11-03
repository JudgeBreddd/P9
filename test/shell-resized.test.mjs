// The Shell's text starts on the terminal's first row when the same shell was last sized by another client (a phone,
// another window) at a different size: 0.1.6 in Remote mode showed it starting in the middle of the terminal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
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

test('Shell: text starts on the first row after another client sized the same shell', { skip: process.platform === 'win32' ? 'tmux' : false, timeout: 120000 }, async (t) => {
  const socket = 'p9t-' + randomUUID().slice(0, 8);
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--tmux-socket', socket] }));
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-resized-')), 'profile');
  await mkdir(profile); await versionSeen(profile);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#rChat').waitFor();
  await page.click('#rTerm');
  await page.locator('#dState', { hasText: /^Connected$/ }).waitFor({ timeout: 15000 });
  const tmux = (...args) => execFileSync('tmux', ['-L', socket, ...args], { encoding: 'utf8' });
  const session = tmux('list-sessions', '-F', '#{session_name}').trim().split('\n')[0];
  const shows = (w) => page.waitForFunction((want) => document.querySelector('#termView .xterm-rows')?.textContent.includes(want), w, { timeout: 10000 });
  const type = async (line) => { await page.click('#termView'); await page.keyboard.type(line); await page.keyboard.press('Enter'); };
  const layout = () => page.evaluate(() => {
    const rows = [...document.querySelectorAll('#termView .xterm-rows > div')];
    return { first: rows.findIndex((row) => row.textContent.trim()), rows: rows.length, text: rows.map((row) => row.textContent.trimEnd()).filter(Boolean).slice(0, 4) };
  });
  // The other client attaches as the phone does (tmux control mode, then its size), runs a command and leaves.
  const other = async (size, tag) => {
    const client = spawn('tmux', ['-L', socket, '-C', 'attach-session', '-t', '=' + session], { stdio: ['pipe', 'ignore', 'ignore'] });
    client.stdin.write('refresh-client -C ' + size + '\n');
    await new Promise((resolve) => setTimeout(resolve, 500));
    client.stdin.write('send-keys -t =' + session + ': "' + (tag.includes('CLEAR') ? 'clear' : 'echo ' + tag) + '" Enter\n');
    await new Promise((resolve) => setTimeout(resolve, 800));
    const pane = tmux('display-message', '-p', '-t', '=' + session + ':', '#{pane_width}x#{pane_height} cursor #{cursor_x},#{cursor_y}').trim();
    if (tag.includes('STAY')) return { pane, client };
    client.kill(); await new Promise((resolve) => setTimeout(resolve, 300));
    return { pane };
  };
  const seen = {};
  for (const n of [1, 2, 3]) { await type('echo LINE""' + n); await shows('LINE' + n); }
  for (const [size, tag] of [['45,40', 'TALL'], ['45,8', 'SHORT'], ['200,60', 'BIG'], ['45,8', 'CLEARSHORT'], ['239,13', 'CLEARWIDE'], ['45,40', 'STAYTALL'], ['45,8', 'STAYSHORT'], ['45,8', 'CLEARSTAYSHORT']]) {
    await page.click('#dHide');
    const { pane, client } = await other(size, 'PHONE' + tag);
    await page.click('#rTerm');
    await page.locator('#dState', { hasText: /^Connected$/ }).waitFor({ timeout: 15000 });
    // Still attached, the phone sizes the shell again after the window did (the window's size crossing a slow link last
    // has the same effect), then leaves.
    if (client) { client.stdin.write('refresh-client -C ' + size + '\n'); await page.waitForTimeout(500); client.kill(); }
    await page.waitForTimeout(1000);
    await evidence(page, 'shell-after-' + tag.toLowerCase());
    seen[tag] = { pane, after: tmux('display-message', '-p', '-t', '=' + session + ':', '#{pane_width}x#{pane_height} cursor #{cursor_x},#{cursor_y}').trim(), ...(await layout()) };
    await type('echo AFTER""' + tag); await shows('AFTER' + tag);
    seen[tag].typed = await layout();
  }
  console.log('P9_RESIZED ' + JSON.stringify(seen));
  assert.deepEqual(Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, v.first])), { TALL: 0, SHORT: 0, BIG: 0, CLEARSHORT: 0, CLEARWIDE: 0, STAYTALL: 0, STAYSHORT: 0, CLEARSTAYSHORT: 0 }, JSON.stringify(seen));
});
