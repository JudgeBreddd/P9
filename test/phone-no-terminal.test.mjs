// The bar: nobody is sent to a terminal. tmux missing where P9 runs: the phone (and a browser) cannot carry the admin
// password, so it says in words that this step is finished in the P9 desktop app on a computer: no command, no terminal
// button, no Copy. The daemon's /terminals answers tmux-not-found (routed); the phone at 390x844, dark then light.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { remoteDaemon, passkeyDevice, enrollDevice } from './helpers.mjs';

const shot = (name, png) => { if (process.env.CI !== 'true') console.log('P9_SHOT ' + name + ' ' + png.toString('base64')); };
const COMMAND = /sudo|apt|dnf|pacman|zypper|install tmux/;

test('tmux missing: the phone says to finish setup in the P9 desktop app, with no command, terminal button or Copy (dark, light)', { timeout: 90000 }, async (t) => {
  const server = await remoteDaemon(t);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const device = await passkeyDevice(browser, server, 'phone-no-tmux');
  const session = await enrollDevice(server, device);
  await device.context.addCookies([{ name: 'p9s', value: session.token, url: server.origin, httpOnly: true, secure: true, sameSite: 'Strict' }]);
  const phone = device.page;
  // The test container has no network, so Chromium says offline and the phone sends nothing; the daemon is on loopback all the same.
  await device.context.addInitScript(() => Object.defineProperty(Navigator.prototype, 'onLine', { get: () => true }));
  await phone.route(/\/terminals(\?.*)?$/, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'tmux-not-found' }) }));
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(server.origin + '/phone/');
  await phone.evaluate((csrf) => sessionStorage.setItem('p9-csrf', csrf), session.csrf);
  await phone.reload();
  for (const [theme, name] of [['event-horizon-prime', 'dark'], ['daylight', 'light']]) {
    await phone.click('[data-nav="chat"]');
    await phone.click('[data-bar="chat"] #themeBtn');
    await phone.click('#themeMenu [data-theme-pick="' + theme + '"]');
    await phone.keyboard.press('Escape');
    assert.equal(await phone.evaluate(() => document.documentElement.dataset.theme), theme);
    await phone.click('[data-nav="terminal"]');
    const said = phone.locator('#screen');
    await phone.waitForFunction(() => document.querySelector('#screen')?.dataset.off?.includes('P9 desktop app'), null, { timeout: 15000 });
    assert.equal(await phone.locator('#termState').innerText(), 'tmux not installed', 'the bar is one short line');
    assert.match(await said.evaluate((n) => n.dataset.off), /^Not connected\nTerminals need tmux, and the computer P9 runs on does not have it\..*Settings → Setup → Terminal\. Then press Refresh\.$/);
    const shown = await phone.locator('body').innerText();
    assert.doesNotMatch(shown, COMMAND, 'no command on the page');
    assert.doesNotMatch(shown, /Run in a terminal|\bCopy\b/, 'no terminal button, no Copy');
    await phone.waitForTimeout(400);
    shot('c37-phone-no-tmux-' + name, await phone.screenshot());
  }
});
