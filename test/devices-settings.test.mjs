// O205 Settings > Remote Connect > Devices: real Electron, the real daemon with phone access on, one phone enrolled with a
// virtual passkey and one still asking. The list, Approve, Refuse and Remove go through main's IPC over the Unix socket;
// the TCP port has no /devices route, signed in or not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron, chromium } from '@playwright/test';
import { remoteDaemon, root, passkeyDevice, enrollDevice, askEnrollment } from './helpers.mjs';

// The dev space keeps no files: the picture goes out in the log as "P9_SHOT <name> <base64>" (not on GitHub).
const shot = async (target, name) => { const png = await target.screenshot(); if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png.toString('base64')); };

test('O205: Settings lists a waiting phone (code, lapse time) and a signed-in one; Approve, Refuse and Remove work there, and the network cannot reach /devices', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, { setup: async ({ directory, workspace }) => {
    const file = path.join(directory, '.config', 'p9', 'settings.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ primary: 'AGENTS.md', registry: 'mission/registry.json', waiting: 'needs-you' }));
    await writeFile(path.join(workspace, 'AGENTS.md'), '# Top\n');
    await mkdir(path.join(workspace, 'mission')); await mkdir(path.join(workspace, 'needs-you'));
    await writeFile(path.join(workspace, 'mission/registry.json'), '{"scripts":[],"apps":[],"pages":[]}');
    return {};
  } });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const phone = await enrollDevice(server, await passkeyDevice(browser, server, 'Pixel'));
  const asking = await askEnrollment(server, 'Kitchen tablet');
  const { code } = (await server.desk('/devices')).body.enrollments.find((e) => e.id === asking);

  // The network side: no /devices route on the TCP port, for a signed-in phone or anyone else.
  for (const session of [phone, undefined]) {
    assert.equal((await server.remote('/devices', { session })).status, 404);
    for (const route of ['/devices/enrollments/' + asking + '/approve', '/devices/enrollments/' + asking + '/refuse', '/devices/' + phone.device + '/revoke', '/devices/reset'])
      assert.equal((await server.remote(route, { method: 'POST', session, body: {} })).status, 404, route);
  }
  assert.equal((await server.desk('/devices')).body.enrollments.find((e) => e.id === asking).state, 'pending', 'nothing from the network changed it');

  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-devices-')), 'profile');
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', server.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  // main checks what the page names: an id that is not a uuid, or anything beside it, is refused before the socket.
  for (const [action, payload] of [['deviceApprove', { id: '../reset' }], ['deviceRemove', { id: phone.device, all: true }], ['devices', { id: asking }]])
    assert.equal((await page.evaluate(([a, p]) => window.p9.chat(a, p), [action, payload])).status, 400, action);

  await page.locator('#setBtn').click();
  await page.locator('#setDlg[open]').waitFor();
  await page.locator('[data-set-page="Remote Connect"]').click();
  const list = page.locator('#setDevices'), waiting = list.locator('li', { hasText: 'Kitchen tablet' }), signed = list.locator('li', { hasText: 'Pixel' });
  await waiting.waitFor({ timeout: 10000 });
  const words = await waiting.textContent();
  assert.ok(words.includes('Code ' + code), words);
  assert.match(words, /asks until \d{1,2}:\d{2}/, 'the time the request lapses');
  assert.deepEqual(await waiting.locator('button').allTextContents(), ['Approve', 'Refuse']);
  assert.match(await signed.textContent(), /Added /);
  assert.deepEqual(await signed.locator('button').allTextContents(), ['Remove']);
  assert.equal(await list.locator('[data-set-page]').count(), 0);
  await shot(page.locator('#setDlg'), 'settings-devices');

  // Approve: the request waits for the phone to finish, and can still be refused.
  await waiting.locator('button', { hasText: 'Approve' }).click();
  await waiting.filter({ hasText: 'Approved: waiting for the phone' }).waitFor({ timeout: 5000 });
  assert.equal((await server.desk('/devices')).body.enrollments.find((e) => e.id === asking).state, 'approved');
  await waiting.locator('button', { hasText: 'Refuse' }).click();
  await waiting.waitFor({ state: 'detached', timeout: 5000 });
  assert.equal((await server.desk('/devices')).body.enrollments.some((e) => e.id === asking), false);

  // Remove asks first; Cancel keeps the phone, OK revokes it and its session.
  page.once('dialog', (d) => d.dismiss());
  await signed.locator('button', { hasText: 'Remove' }).click();
  await page.waitForTimeout(300);
  assert.equal((await server.desk('/devices')).body.devices.find((d) => d.id === phone.device).state, 'active');
  page.once('dialog', (d) => d.accept());
  await signed.locator('button', { hasText: 'Remove' }).click();
  await signed.waitFor({ state: 'detached', timeout: 5000 });
  assert.equal((await server.desk('/devices')).body.devices.find((d) => d.id === phone.device).state, 'revoked');
  await list.getByText('No phones yet').waitFor();
});
