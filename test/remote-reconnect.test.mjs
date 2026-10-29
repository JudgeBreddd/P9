// D20: once this window has connected to a remote, a lost tunnel never covers the page again. The full Connecting layer is only
// for a remote with nothing to show yet; a later drop shows a small Reconnecting badge in the title bar, only after 3 s of
// failure, and a draft in the composer stays editable and copyable throughout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rename, symlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, http, authenticated, root } from './helpers.mjs';

const skip = process.platform === 'win32' ? 'Unix sockets and sh' : false;
const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((result) => ({ status: result.status, ...JSON.parse(result.text) }));

test('D20: a drop after connecting shows the Reconnecting badge after 3 s, never the full layer, and the draft stays usable', { skip, timeout: 120000 }, async (t) => {
  const local = await daemon(t), remote = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', path.join(root, 'test/fake-acp-agent.mjs')] }));
  const id = (await call(remote, '/chat', 'POST', { provider: 'claude' })).conversation;
  // The stand-in ssh reaches the remote through server/p9-foundation; moving that link away is a remote that stops answering.
  const directory = await mkdtemp(path.join(os.tmpdir(), 'p9-reconnect-'));
  const server = path.join(directory, 'server'), runtime = path.join(directory, 'local'), link = path.join(server, 'p9-foundation');
  await mkdir(server); await mkdir(runtime, { mode: 0o700 });
  await symlink(remote.state, link);
  const ssh = path.join(directory, 'ssh'), log = path.join(directory, 'ssh.log'), q = (s) => "'" + s + "'";
  await writeFile(ssh, '#!/bin/sh\nFAKE_RUNTIME=' + q(server) + ' FAKE_SSH_LOG=' + q(log) + ' exec ' + q(process.execPath) + ' ' + q(path.join(root, 'test/fake-ssh.mjs')) + ' "$@"\n');
  await chmod(ssh, 0o755);
  const profile = path.join(directory, 'profile');
  await mkdir(profile);
  await writeFile(path.join(profile, 'p9-server.json'), JSON.stringify({ host: 'test-host' }));
  const env = { ...process.env, P9_SSH: ssh, XDG_RUNTIME_DIR: runtime }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', local.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#daemonStatus', { hasText: 'Connected to test-host' }).waitFor({ timeout: 30000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 900));
  await page.locator('#tabs .tab[data-id="' + id + '"]').click({ timeout: 15000 });
  const box = page.locator('.pane[data-id="' + id + '"] .composer textarea');
  await box.click(); await page.keyboard.type('A long draft that must survive');
  const badge = page.locator('#reconnecting');
  assert.equal(await badge.isHidden(), true, 'no badge while connected');
  const shot = async (name) => {
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
    if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png);
  };
  for (const theme of ['event-horizon-prime', 'daylight']) {
    // The drop: the remote stops answering and the tunnel ends.
    await rename(link, link + '.away');
    const tunnel = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((c) => c.argv.includes('-N')).pop();
    process.kill(tunnel.pid, 'SIGTERM');
    const lost = Date.now();
    await page.locator('#daemonStatus', { hasNotText: 'Connected to test-host' }).waitFor({ timeout: 10000 });
    // The first seconds: no layer, no badge (a blip stays invisible), and the draft is still editable.
    assert.equal(await page.locator('dialog#connecting[open]').count(), 0, 'the full layer opened on a drop');
    if (Date.now() - lost < 2500) assert.equal(await badge.isHidden(), true, 'the badge showed before 3 s');
    await box.click(); await page.keyboard.press('End'); await page.keyboard.type(' (' + theme + ')');
    // Then the badge, still no layer, and the draft copies out.
    await badge.waitFor({ state: 'visible', timeout: 8000 });
    assert.ok(Date.now() - lost >= 2900, 'the badge showed after ' + (Date.now() - lost) + ' ms');
    assert.equal(await page.locator('dialog#connecting[open]').count(), 0, 'the full layer opened on a drop');
    assert.match(await badge.textContent(), /Reconnecting…/);
    await box.click(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('ControlOrMeta+c');
    assert.match(await app.evaluate(({ clipboard }) => clipboard.readText()), new RegExp('^A long draft that must survive.*\\(' + theme + '\\)$'));
    await shot('d20-reconnecting-' + theme);
    // The remote answers again: the badge goes, the draft is untouched.
    await rename(link + '.away', link);
    await badge.waitFor({ state: 'hidden', timeout: 45000 });
    assert.match(await box.inputValue(), new RegExp('\\(' + theme + '\\)$'));
    if (theme === 'event-horizon-prime') { await page.click('#themeBtn'); await page.click('[data-theme-pick="daylight"]'); await page.keyboard.press('Escape'); }
  }
  console.log('PASS D20: a drop after connecting showed the badge after 3 s, never the layer, and the draft stayed usable');
});
