// Two look bugs: the phone's header bar let scrolled content show through it, and picking the theme already in use moved the
// desktop shell sideways. Desktop in a dark and a light theme, the phone at 390x844; the shots are evidence.
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
// Where the shell sits: the Mission frame's left edge and every scroll offset that could move it.
const place = (page) => page.evaluate(() => ({
  left: Math.round(document.querySelector('#fMission').getBoundingClientRect().left),
  scrolled: [...document.querySelectorAll('*')].filter((n) => n.scrollLeft).map((n) => (n.id || n.className || n.tagName) + ':' + n.scrollLeft),
}));

test('picking the theme already in use leaves the desktop where it was (dark, light)', { timeout: 120000 }, async (t) => {
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
  await page.locator('#fMission [data-onboard] [data-template="blank"]').waitFor({ timeout: 15000 });
  // ponytail: a fixed pause after a theme switch: the switch slides the shell, which no finite animation reports.
  const pick = async (name) => { await page.click('#themeBtn'); await page.click('[data-theme-pick="' + name + '"]'); await page.keyboard.press('Escape'); await page.waitForTimeout(800); await settled(page); };
  for (const name of ['daylight', 'event-horizon-prime']) {
    await pick(name);
    assert.deepEqual(await page.evaluate(() => [document.body.scrollWidth, innerWidth]), [1440, 1440], name + ': nothing makes the page wider than the window');
    const before = await place(page);
    await pick(name);
    assert.deepEqual(await place(page), before, name + ': picked again, the shell stays put');
    shot('c36-look-repick-desktop-' + name, await page.screenshot());
  }
});

test('the phone header bar is solid, so scrolled content does not show through it', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, { setup });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const device = await passkeyDevice(browser, server, 'phone-bar');
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
  // The bar's background painted on a canvas: any alpha under 255 lets what scrolls beneath it through.
  const alpha = await phone.evaluate(() => {
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.fillStyle = getComputedStyle(document.querySelector('[data-bar="mission"]')).backgroundColor; ctx.fillRect(0, 0, 1, 1);
    return ctx.getImageData(0, 0, 1, 1).data[3];
  });
  assert.equal(alpha, 255);
  await phone.locator('#mission').evaluate((n) => { (n.querySelector('[data-onboard]')?.closest('[class]') ?? n).scrollIntoView(); window.scrollBy(0, 160); document.querySelectorAll('#mission *').forEach((m) => { if (m.scrollHeight > m.clientHeight + 40) m.scrollTop = 160; }); });
  await settled(phone); shot('look-bar-phone', await phone.screenshot());
});
