// "Continue on phone" in the desktop chat pane (PH1): real Electron, the real daemon and the fake agent. The phone side
// (the page opening on the linked chat) is in phone-continue.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, http, authenticated, root } from './helpers.mjs';

// The dev space keeps no files: the picture goes out in the log as "P9_SHOT <name> <base64>" (not on GitHub).
const shot = async (page, name) => { const png = await page.screenshot(); if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png.toString('base64')); };
const fake = path.join(root, 'test/fake-acp-agent.mjs');
const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((result) => ({ status: result.status, ...JSON.parse(result.text) }));

// A window on one chat with `provider`; `host` is the settings.json server_host ('' leaves it unset).
async function window(t, provider, host) {
  const instance = await daemon(t, undefined, false, async ({ directory, workspace }) => {
    const file = path.join(directory, '.config', 'p9', 'settings.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ primary: 'AGENTS.md', registry: 'mission/registry.json', waiting: 'needs-you', ...(host && { server_host: host }) }));
    await writeFile(path.join(workspace, 'AGENTS.md'), '# Top\n');
    await mkdir(path.join(workspace, 'mission')); await mkdir(path.join(workspace, 'needs-you'));
    await writeFile(path.join(workspace, 'mission/registry.json'), '{"scripts":[],"apps":[],"pages":[]}');
    return { args: ['--acp-override', fake] };
  });
  const id = (await call(instance, '/chat', 'POST', { provider })).conversation;
  // The window lists a chat once it has said something.
  await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'hello' });
  for (let i = 0; i < 100 && !(await call(instance, '/chat/events?after=0&only=' + id)).events.some((event) => event.type === 'update'); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-phone-link-')), 'profile');
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#rBots [data-bot="' + id + '"]').waitFor({ timeout: 15000 });
  await page.locator('#tabs .tab[data-id="' + id + '"]').click();
  return { id, page, pane: page.locator('.pane[data-id="' + id + '"]') };
}

for (const provider of ['claude', 'codex']) {
  test(`PH1 (${provider}): the Phone button shows a QR and a link that carry this chat's id`, { timeout: 90000 }, async (t) => {
    const { id, page, pane } = await window(t, provider, 'test-server');
    await pane.locator('[data-phone]').click();
    await page.locator('#phoneDlg[open]').waitFor({ timeout: 10000 });
    assert.equal(await page.inputValue('#phoneDlg [data-phone-link]'), `https://test-server/phone#chat=${id}`);
    // Drawn here: an inline SVG of the code, and no picture fetched from anywhere.
    assert.equal(await page.locator('#phoneDlg .qr svg').count(), 1);
    assert.equal(await page.locator('#phoneDlg img, #phoneDlg iframe').count(), 0);
    await page.waitForTimeout(600); // the dialog fades in
    await shot(page, `desktop-phone-qr-${provider}`);
    await page.click('#phoneDlg button:has-text("Close")');
    await page.locator('#phoneDlg[open]').waitFor({ state: 'detached', timeout: 5000 });
  });
}

test('PH1: with no server host set the dialog says where to set it and offers no link', { timeout: 90000 }, async (t) => {
  const { page, pane } = await window(t, 'claude', '');
  await pane.locator('[data-phone]').click();
  await page.locator('#phoneDlg[open]').waitFor({ timeout: 10000 });
  assert.match(await page.locator('#phoneBody').innerText(), /Server host name/);
  assert.equal(await page.locator('#phoneDlg [data-phone-link], #phoneDlg .qr').count(), 0);
});
