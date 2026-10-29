// Mission M4 part 1 on screen: the onboarding card a fresh profile shows, each of its buttons, and the space picker; desktop in
// a dark and a light theme, and the phone at 390x844. The shots are evidence; the asserts check what each button opened.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, _electron } from '@playwright/test';
import { remoteDaemon, passkeyDevice, enrollDevice, root, versionSeen } from './helpers.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
async function setup(paths) {
  const w = paths.workspace;
  await mkdir(path.join(w, 'mission'), { recursive: true });
  await mkdir(path.join(w, 'needs-you'));
  await writeFile(path.join(w, 'AGENTS.md'), '# Workspace\n');
  await writeFile(path.join(w, 'mission/registry.json'), '{}\n');
  await mkdir(path.join(paths.directory, '.config/p9'), { recursive: true });
  await writeFile(path.join(paths.directory, '.config/p9/settings.json'), JSON.stringify({ primary: 'AGENTS.md', registry: 'mission/registry.json', waiting: 'needs-you' }));
  return { args: ['--acp-override', fake, '--settings', path.join(paths.directory, '.config/p9/settings.json')] };
}
const shot = (name, png) => { if (process.env.CI !== 'true') console.log('P9_SHOT ' + name + ' ' + png.toString('base64')); };
const settled = (page) => page.evaluate(() => Promise.allSettled(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished)));
const THEMES = ['event-horizon-prime', 'daylight'];

test('M4a look: a fresh profile shows only the onboarding card; each button opens its thing; the space picker on desktop (dark, light) and phone', { timeout: 180000 }, async (t) => {
  const server = await remoteDaemon(t, { setup });
  const profile = path.join(server.directory, 'electron-profile');
  await mkdir(profile); await versionSeen(profile);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', server.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.click('#rMission');
  // ponytail: a fixed pause after a theme switch, for the shot only: the switch slides the shell, which no finite animation reports.
  const theme = async (name) => { await page.click('#themeBtn'); await page.click('[data-theme-pick="' + name + '"]'); await page.keyboard.press('Escape'); await page.waitForTimeout(800); };

  // Only the card: no waiting list, panels or section tiles.
  await page.locator('#fMission [data-onboard] [data-template="blank"]').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('#fMission .mrow, #fMission .needs, #fMission [data-group]').count(), 0);
  assert.equal(await page.locator('#fMission [data-template]').count(), 4);

  await page.click('#fMission [data-yourself]');
  await page.locator('#mdlBody[data-kind="guide"] [data-guide] h1').waitFor({ timeout: 10000 });
  assert.match(await page.locator('#mdlBody [data-guide]').innerText(), /Build your Mission Control space[\s\S]*describe_mission/);
  assert.equal(await page.locator('#mdlFoot [data-guide-edit]').count(), 1);
  await settled(page); shot('m4a-guide-desktop', await page.screenshot());
  await page.keyboard.press('Escape');
  await page.locator('#mdl[open]').waitFor({ state: 'detached', timeout: 5000 });
  for (const provider of ['claude', 'codex']) {
    await page.click(`#fMission [data-build="${provider}"]`);
    await page.locator('#mdlBody[data-kind="chat"]').waitFor({ timeout: 15000 });
    await page.keyboard.press('Escape');
    await page.locator('#mdl[open]').waitFor({ state: 'detached', timeout: 5000 });
  }

  // The card's shots after the window has settled at 1440 (the first shot right after launch caught it mid-resize).
  for (const name of [...THEMES].reverse()) { await theme(name); await settled(page); shot('m4a-card-desktop-' + name, await page.screenshot()); }
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const device = await passkeyDevice(browser, server, 'phone-m4a');
  const session = await enrollDevice(server, device);
  await device.context.addCookies([{ name: 'p9s', value: session.token, url: server.origin, httpOnly: true, secure: true, sameSite: 'Strict' }]);
  const phone = device.page;
  // The test container has no network, so Chromium says offline and the phone sends nothing; the daemon is on loopback all the same.
  await device.context.addInitScript(() => Object.defineProperty(Navigator.prototype, 'onLine', { get: () => true }));
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(server.origin + '/phone/');
  await phone.evaluate((csrf) => sessionStorage.setItem('p9-csrf', csrf), session.csrf);
  await phone.reload();
  await phone.click('[data-nav="mission"]');
  await phone.locator('#mission [data-onboard] [data-template="blank"]').waitFor({ timeout: 15000 });
  assert.equal(await phone.locator('#mission [data-open]').count(), 0);
  await settled(phone); shot('m4a-card-phone', await phone.screenshot());
  await phone.click('#mission [data-yourself]');
  await phone.locator('#sheet[open] [data-guide] h1').waitFor({ timeout: 10000 });
  await phone.keyboard.press('Escape');
  await phone.click('#mission [data-build="codex"]');
  await phone.waitForFunction(() => location.hash.startsWith('#chat=') || document.querySelector('[data-onboard-note]')?.textContent, null, { timeout: 15000 });
  assert.match(await phone.evaluate(() => location.hash), /^#chat=/, await phone.evaluate(() => document.querySelector('[data-onboard-note]')?.textContent ?? ''));

  // A scratch space appears: the picker shows on the card; picking it shows that space with the picker above it.
  assert.equal((await server.desk('/mission/template', 'POST', { name: 'homelab', space: 'draft', confirm: true })).status, 201);
  await page.locator('#fMission [data-onboard] [data-space-pick]').waitFor({ timeout: 20000 });
  await page.selectOption('#fMission [data-space-pick]', 'draft');
  await page.locator('#fMission [data-group="Services"]').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('#fMission [data-onboard]').count(), 0);
  for (const name of THEMES) { await theme(name); await settled(page); shot('m4a-picker-desktop-' + name, await page.screenshot()); }
  await phone.goto(server.origin + '/phone/');
  await phone.click('[data-nav="mission"]');
  await phone.locator('#mission [data-space-pick]').waitFor({ timeout: 15000 });
  await phone.locator('#mission [data-open]:has-text("Services")').waitFor({ timeout: 15000 });
  assert.equal(await phone.locator('#mission [data-space-pick]').inputValue(), 'draft');
  await settled(phone); shot('m4a-picker-phone', await phone.screenshot());

  // Back to Main: the card again; a template (File protection asks with a second click) fills the space and the card goes.
  await page.selectOption('#fMission [data-space-pick]', '');
  await page.locator('#fMission [data-onboard] [data-template="blank"]').waitFor({ timeout: 15000 });
  await page.click('#fMission [data-template="blank"]');
  await page.locator('#fMission [data-template="blank"][data-armed]').waitFor({ timeout: 10000 });
  await page.click('#fMission [data-template="blank"]');
  await page.locator('#fMission [data-group="Start here"]').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('#fMission [data-onboard]').count(), 0);
});
