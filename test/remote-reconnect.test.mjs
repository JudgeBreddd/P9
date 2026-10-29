// D20: once this window has connected to a remote, a slow or lost remote shows nothing in the background: no full Connecting
// layer, no title-bar note, the label stays. Only what the user does waits where they did it (a send's working row), and a
// draft in the composer stays editable and copyable throughout. The full layer is only for a remote with nothing to show yet.
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

test('D20: after connecting, slow and failed requests show no layer and no note; a send shows its working row; the draft stays usable', { skip, timeout: 120000 }, async (t) => {
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
  t.after(async () => { remote.child.kill('SIGCONT'); await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  try {
  const page = await app.firstWindow();
  const label = page.locator('#daemonStatus');
  await label.filter({ hasText: 'Connected to test-host' }).waitFor({ timeout: 30000 });
  await page.locator('#tabs .tab[data-id="' + id + '"]').click({ timeout: 15000 });
  const pane = page.locator('.pane[data-id="' + id + '"]'), box = pane.locator('.composer textarea');
  await box.click(); await page.keyboard.type('A long draft that must survive');
  // Nothing in the background shows for 6 s (a 2 s health limit, retried every second): no layer, no note, the label stays.
  const quiet = async (why) => {
    for (const end = Date.now() + 6000; Date.now() < end; await page.waitForTimeout(250)) {
      assert.equal(await page.locator('dialog#connecting[open]').count(), 0, 'the full layer opened: ' + why);
      assert.equal(await page.locator('#reconnecting').count(), 0, 'a title-bar note showed: ' + why);
      assert.equal(await label.textContent(), 'Connected to test-host', 'the label changed: ' + why);
      assert.equal(await page.locator('.toast.bad').count(), 0, 'an error toast showed: ' + why);
    }
  };
  // Slow: the remote daemon stops answering in time (stopped, not gone), so every health check times out.
  remote.child.kill('SIGSTOP');
  await quiet('slow remote');
  await box.click(); await page.keyboard.press('End'); await page.keyboard.type(' (slow)');
  remote.child.kill('SIGCONT');
  // Failed: the tunnel ends and the remote is gone; main rebuilds it.
  await rename(link, link + '.away');
  const tunnel = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((c) => c.argv.includes('-N')).pop();
  process.kill(tunnel.pid, 'SIGTERM');
  await quiet('lost tunnel');
  await box.click(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('ControlOrMeta+c');
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'A long draft that must survive (slow)');
  // A send to a remote that is gone ends in words, not a code (before: Chat prompt: daemon-unavailable), and the message
  // is back in the box. The 90 s wait is not run here: a gone tunnel fails at once; chat-failed.test.mjs has the minutes.
  await page.keyboard.press('Enter');
  const toast = page.locator('.toast.bad', { hasText: 'Could not send. P9 on test-host is not answering. Your message is back in the box.' });
  await toast.waitFor({ timeout: 20000 }).catch(async (error) => { console.log('D20 toasts: ' + JSON.stringify(await page.locator('.toast').allTextContents())); throw error; });
  assert.equal(await box.inputValue(), 'A long draft that must survive (slow)');
  const theme = async (name) => { await page.click('#themeBtn'); await page.click('[data-theme-pick="' + name + '"]'); await page.keyboard.press('Escape');
    await page.waitForFunction((dark) => document.documentElement.classList.contains('dark') === dark, name !== 'daylight', { timeout: 5000 }); };
  if (!process.env.GITHUB_ACTIONS) {
    console.log('P9_SHOT d23-send-failed ' + (await page.screenshot()).toString('base64'));
    // One failed send, one toast (the retry inside liveChat.call does not raise its own); the light send waits for it to go.
    await page.waitForTimeout(2500); assert.equal(await toast.count(), 1, 'one failed send shows one toast');
    for (const end = Date.now() + 30000; await toast.count();) { assert.ok(Date.now() < end, 'the first toast did not go'); await page.waitForTimeout(250); }
    await theme('daylight'); await box.click(); await page.keyboard.press('Enter');
    for (const end = Date.now() + 20000; await box.inputValue() !== 'A long draft that must survive (slow)';) {
      assert.ok(Date.now() < end, 'light send: the draft did not come back'); await page.waitForTimeout(200); }
    await toast.waitFor({ timeout: 5000 }); await page.waitForTimeout(2500); assert.equal(await toast.count(), 1, 'one failed send shows one toast');
    console.log('P9_SHOT d23-send-failed-light ' + (await page.screenshot()).toString('base64'));
    await theme('event-horizon-prime');
  }
  await rename(link + '.away', link);
  // An action waits where it was taken: a send shows the chat's working row at once, even while the remote is slow.
  remote.child.kill('SIGSTOP');
  await box.click(); await page.keyboard.press('Enter');
  await pane.locator('.working', { hasText: 'Sending…' }).waitFor({ timeout: 1500 });
  assert.equal(await page.locator('dialog#connecting[open]').count(), 0);
  remote.child.kill('SIGCONT');
  console.log('PASS D20: slow and failed requests after connecting showed nothing; a send showed its working row; the draft stayed usable');
  } catch (error) { console.log('D20 FAILED: ' + error.message.slice(0, 300)); throw error; } finally { remote.child.kill('SIGCONT'); }
});
