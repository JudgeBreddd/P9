// O248: on a remote over a slow link, the switcher (the machine menu, Settings, Mission Control, Dev Focus) was slow: "Every
// click is slow or half opens the box or takes 15-20 seconds to work." The window is on a remote through the stand-in ssh
// (test/fake-ssh.mjs) with 150 ms each way and 2 Mbit/s shared by every channel, as one ssh connection is. Each click is
// timed from the click to the thing fully open, twice: with the link full (a busy chat's history coming down), and after.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { _electron } from '@playwright/test';
import { daemon, http, authenticated, root, versionSeen } from './helpers.mjs';

const skip = process.platform === 'win32' ? 'Unix sockets and sh' : false;
const fake = path.join(root, 'test/fake-acp-agent.mjs');
const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-p9-op': randomUUID() }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => ({ status: r.status, ...JSON.parse(r.text) }));
const until = async (check, what, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (await check()) return;
  throw new Error('timed out: ' + what);
};
const ended = (instance, id) => until(async () => (await call(instance, '/chat/events?after=0&tail=1&only=' + id)).events.at(-1)?.type === 'turn-end', id + ' answered');

test('O248 the switcher opens at once on a remote over a slow link', { skip, timeout: 300000 }, async (t) => {
  const local = await daemon(t), remote = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  // A busy chat (MBs of screenshots) first, then small ones: its history comes down the link after the list (late()).
  const heavy = (await call(remote, '/chat', 'POST', { provider: 'claude', title: 'Busy' })).conversation;
  await call(remote, `/chat/${heavy}/prompt`, 'POST', { text: 'heavy 8' }); await ended(remote, heavy);
  for (let i = 0; i < 3; i += 1) {
    const id = (await call(remote, '/chat', 'POST', { provider: 'claude', title: 'Chat ' + i })).conversation;
    await call(remote, `/chat/${id}/prompt`, 'POST', { text: 'hello ' + i }); await ended(remote, id);
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'p9-switcher-'));
  const server = path.join(directory, 'server'), runtime = path.join(directory, 'local'), log = path.join(directory, 'ssh.log');
  await mkdir(server); await mkdir(runtime, { mode: 0o700 });
  await symlink(remote.state, path.join(server, 'p9-foundation'));
  const ssh = path.join(directory, 'ssh'), q = (s) => "'" + s + "'";
  await writeFile(ssh, '#!/bin/sh\nFAKE_SSH_DELAY_MS=150 FAKE_SSH_BPS=250000 FAKE_RUNTIME=' + q(server) + ' FAKE_SSH_LOG=' + q(log) + ' exec ' + q(process.execPath) + ' ' + q(path.join(root, 'test/fake-ssh.mjs')) + ' "$@"\n');
  await chmod(ssh, 0o755);
  const profile = path.join(directory, 'profile'); await mkdir(profile);
  await versionSeen(profile);
  // A second saved remote: the menu probes it over ssh as it opens (unreachable* never answers in fake-ssh).
  await writeFile(path.join(profile, 'p9-server.json'), JSON.stringify({ host: 'test-host', last: 'test-host', remotes: ['test-host', 'unreachable-box'] }));
  const env = { ...process.env, P9_SSH: ssh, XDG_RUNTIME_DIR: runtime, P9_FIRST_RUN: 'off' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', local.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 60000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((r) => setTimeout(r, 15000))]); proc.kill(); });
  const page = await app.firstWindow({ timeout: 60000 });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1400, height: 900 }).catch(() => {});
  await page.locator('#serverBadge', { hasText: 'test-host' }).waitFor({ timeout: 120000 });
  await page.locator('#navList .row[data-chat]').nth(3).waitFor({ timeout: 120000 });

  // Each step: the click, then the thing fully open (the menu with every row, the remote in use's state still on its way; the dialog
  // open; the focus pane shown), then it is closed again. ms from the click.
  const timed = async (name, click, open, close) => {
    const t0 = Date.now(); await click();
    await open().catch((e) => { throw new Error(name + ' not open in 30 s: ' + e.message); });
    const ms = Date.now() - t0; await close(); return [name, ms];
  };
  const round = async () => Object.fromEntries([
    await timed('menu', () => page.click('#serverBadge'),
      () => page.locator('#serverPop [data-server-go="test-host"][aria-current]').waitFor({ timeout: 30000 })
        .then(() => page.locator('#serverPop [data-server-go="unreachable-box"]').waitFor({ timeout: 30000 }))
        .then(() => page.locator('#serverPop #serverAdd').waitFor({ timeout: 30000 })),
      () => page.keyboard.press('Escape').then(() => page.locator('#serverPop').waitFor({ state: 'hidden', timeout: 5000 }))),
    await timed('settings', () => page.click('#setBtn'), () => page.locator('#setDlg[open] legend').first().waitFor({ timeout: 30000 }),
      () => page.click('#setClose').then(() => page.locator('#setDlg:not([open])').waitFor({ state: 'attached', timeout: 5000 }))),
    await timed('mission', () => page.click('#rMission'), () => page.locator('.fpane.on[data-focus="mission"]').waitFor({ timeout: 30000 }), async () => {}),
    await timed('dev', () => page.click('#rDev'), () => page.locator('.fpane.on[data-focus="dev"]').waitFor({ timeout: 30000 }), async () => {}),
    await timed('chat', () => page.click('#rChat'), () => page.locator('.fpane.on[data-focus="chat"]').waitFor({ timeout: 30000 }), async () => {}),
  ]);
  // The link full: the busy chat's ~3.5 MB (~14 s at 2 Mbit/s) asked through the window's own forward, so every call the
  // clicks make waits behind it, as behind a chat's history or a screenshot coming down.
  const reads = async () => (await readFile(log, 'utf8')).split('\n').filter((l) => l.includes('p9-foundation/desktop.json') && l.includes('printf')).length;
  const before = await reads(), t0 = Date.now(), step = (s) => console.log('O248 step ' + s + ' at ' + (Date.now() - t0) + ' ms');
  // Counted as it comes, so a slow link says how far it got (helpers' http() has a 10 s idle limit and no progress).
  const down = { bytes: 0, first: 0, status: 0 };
  step('busy chat is ' + JSON.stringify(await call(remote, '/chat/events?after=0&tail=200&only=' + heavy)).length + ' chars off the link');
  const full = new Promise((resolve, reject) => request({ agent: false, socketPath: path.join(runtime, 'p9-server', 'test-host', 'daemon.sock'),
    path: '/chat/events?after=0&tail=200&only=' + heavy, headers: authenticated(remote.credentials) }, (res) => {
    down.status = res.statusCode;
    res.on('data', (d) => { down.first ||= Date.now() - t0; down.bytes += d.length; }).on('end', () => resolve(down)).on('error', (e) => reject(new Error(e.message + ' after ' + JSON.stringify(down) + ' at ' + (Date.now() - t0) + ' ms')));
  }).on('error', reject).end());
  await new Promise((r) => setTimeout(r, 500));
  const busy = await round(); step('busy round ' + JSON.stringify(busy));
  await page.click('#serverBadge'); await new Promise((r) => setTimeout(r, 3000)); await page.keyboard.press('Escape'); // past the 2 s other status calls allow
  step('menu again');
  // A change made while Settings' reads are still on the link stays: those reads went out before its save.
  await page.click('#setBtn'); await page.locator('#setDlg[open] #setGreeting:checked').waitFor({ timeout: 5000 }); await page.uncheck('#setGreeting');
  step('greeting off');
  await Promise.race([full, new Promise((r, j) => setTimeout(() => j(new Error('the busy chat not down in 60 s: ' + JSON.stringify(down))), 60000))]);
  step('busy chat down ' + JSON.stringify(down)); assert.ok(down.status === 200 && down.bytes > 3e6, 'the busy chat came down the link');
  // Counted after the link drains, and 3 s more: the checks sent while it was full (10 s each) have timed out by now, and an ssh login
  // on a timeout would have started.
  await new Promise((r) => setTimeout(r, 3000));
  const logins = await reads() - before; step('logins while full ' + logins);
  assert.equal(await page.isChecked('#setGreeting'), false, 'the greeting stays off after the reads land'); await page.click('#setClose');
  const settled = await round();
  // With the link free the remote in use's check answers: Connected.
  await page.click('#serverBadge'); await page.locator('#serverPop [data-server-go="test-host"] .muted', { hasText: 'Connected' }).waitFor({ timeout: 5000 }); await page.keyboard.press('Escape');
  await page.click('#setBtn'); assert.equal(await page.locator('#setDlg[open] #setGreeting').isChecked({ timeout: 5000 }), false, 'off on the next open'); await page.click('#setClose');
  console.log('O248 ms from click to open, 300 ms RTT, 2 Mbit/s: link full ' + JSON.stringify(busy) + '; after ' + JSON.stringify(settled) + '; ssh logins while full: ' + logins);
  assert.deepEqual(errors, []);
  // A slow /health is not new credentials: it started an ssh login (the credentials read) each time, 15-20 s on a real link.
  assert.equal(logins, 0, 'no ssh login while the link was full');
  // A click opens on what the window already knows: no round trip comes first (the link may be full for 15 s).
  for (const [when, r] of [['with the link full', busy], ['after', settled]])
    for (const [name, ms] of Object.entries(r)) assert.ok(ms < 2000, `${name} took ${ms} ms to open ${when}`);
});
