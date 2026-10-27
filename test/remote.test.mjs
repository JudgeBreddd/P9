// Server mode (threat model row 50, apps/desktop/remote.mjs): the window reaches a P9 daemon on another machine through ssh.
// A stand-in ssh (test/fake-ssh.mjs) runs remote.mjs's real remote command against a real daemon's runtime folder and
// forwards a Unix socket the way OpenSSH's -L does, so everything but the network hop is the real thing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, restart, http, authenticated, root } from './helpers.mjs';
import { execFileSync } from 'node:child_process';
import { connectServer, restartServer, sshHosts, READ } from '../apps/desktop/remote.mjs';

const skip = process.platform === 'win32' ? 'Unix sockets and sh; Windows OpenSSH is checked on a Windows desktop' : false;
const mode = async file => (await stat(file)).mode & 0o777;
const gone = async (folder, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 50))) if (!await stat(folder).catch(() => null)) return true;
  return false;
};

// server: this side's view of the server's $XDG_RUNTIME_DIR, its p9-foundation a link to the daemon's state folder.
// local: this machine's runtime folder. ssh: a wrapper that runs the stand-in; log: one line per ssh call.
async function stage(instance) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'p9-remote-'));
  const server = path.join(directory, 'server'), local = path.join(directory, 'local'), log = path.join(directory, 'ssh.log');
  await mkdir(server); await mkdir(local, { mode: 0o700 });
  if (instance) await symlink(instance.state, path.join(server, 'p9-foundation'));
  const ssh = path.join(directory, 'ssh'), q = s => "'" + s + "'";
  await writeFile(ssh, '#!/bin/sh\nFAKE_RUNTIME=' + q(server) + ' FAKE_SSH_LOG=' + q(log) + ' exec ' + q(process.execPath) + ' ' + q(path.join(root, 'test/fake-ssh.mjs')) + ' "$@"\n');
  await chmod(ssh, 0o755);
  const calls = () => readFile(log, 'utf8').then(text => text.trim().split('\n').map(line => JSON.parse(line)), () => []);
  return { directory, server, local, log, ssh, calls };
}

test('Server mode: the forward, its files and the ssh it runs', { skip }, async (t) => {
  const instance = await daemon(t), s = await stage(instance);
  let dropped = false;
  const server = await connectServer({ host: 'test-host', ssh: s.ssh, runtime: s.local, onDrop: () => { dropped = true; } });
  t.after(() => server.close());
  assert.equal(server.state, path.join(s.local, 'p9-server', 'test-host'));
  const saved = JSON.parse(await readFile(path.join(server.state, 'desktop.json'), 'utf8'));
  assert.deepEqual(saved, { cookie: instance.credentials.cookie, csrf: instance.credentials.csrf, socketPath: path.join(server.state, 'daemon.sock') });
  assert.equal((await server.check()).status, 'ok');
  // Through the forward the server's own desktop check applies: its cookie gets in, another does not.
  assert.equal((await http({ socketPath: saved.socketPath, headers: authenticated(saved) })).status, 200);
  assert.equal((await http({ socketPath: saved.socketPath, headers: authenticated({ ...saved, cookie: 'x'.repeat(saved.cookie.length) }) })).status, 401);
  // Owner-only: the folders 0700, the credentials and the forwarded socket 0600.
  assert.deepEqual([await mode(path.dirname(server.state)), await mode(server.state), await mode(path.join(server.state, 'desktop.json')), await mode(saved.socketPath)],
    [0o700, 0o700, 0o600, 0o600]);
  // Fixed argv, BatchMode on every call; the tunnel forwards exactly the server daemon's socket.
  const calls = await s.calls();
  assert.ok(calls.length >= 2 && calls.every(c => c.argv.includes('BatchMode=yes') && c.argv.includes('test-host')), JSON.stringify(calls));
  const tunnel = calls.find(c => c.argv.includes('-N'));
  assert.equal(tunnel.argv[tunnel.argv.indexOf('-L') + 1], saved.socketPath + ':' + path.join(s.server, 'p9-foundation', 'daemon.sock'));
  assert.ok(tunnel.argv.includes('StreamLocalBindMask=0177') && tunnel.argv.includes('ExitOnForwardFailure=yes'));
  // close() removes the folder and is not a drop.
  await server.close();
  assert.ok(await gone(server.state));
  assert.equal(dropped, false);
});

test('Server mode: host names ssh would read as options are refused before ssh runs', { skip }, async () => {
  const s = await stage();
  for (const host of ['-oProxyCommand=touch pwned', 'a b', 'a;b', '$(id)', '', 'a\nb', 'x'.repeat(254)]) {
    await assert.rejects(connectServer({ host, ssh: s.ssh, runtime: s.local }), /server-host-refused/, JSON.stringify(host));
    assert.equal(await restartServer(host, s.ssh), false);
  }
  assert.deepEqual(await s.calls(), []);
  // A server that answers but runs no P9, and one ssh cannot reach, say so apart.
  await assert.rejects(connectServer({ host: 'test-host', ssh: s.ssh, runtime: s.local }), /server-no-p9/);
  await assert.rejects(connectServer({ host: 'test-host', ssh: path.join(s.directory, 'no-ssh'), runtime: s.local }), /server-unreachable/);
});

// A non-tty ssh session can come without $XDG_RUNTIME_DIR (a home server, 2026-10-26); the read falls back to systemd's /run/user/<uid>.
test('Server mode: the server read works without $XDG_RUNTIME_DIR', { skip }, () => {
  const env = { ...process.env }; delete env.XDG_RUNTIME_DIR;
  assert.equal(execFileSync('sh', ['-c', READ], { env, encoding: 'utf8' }).split('\n')[0], '/run/user/' + process.getuid());
});

test('Server mode: a lost tunnel is a drop, and a restarted server daemon is found again', { skip }, async (t) => {
  const instance = await daemon(t), s = await stage(instance);
  let drop;
  const dropped = new Promise(resolve => { drop = resolve; });
  const server = await connectServer({ host: 'test-host', ssh: s.ssh, runtime: s.local, onDrop: drop });
  t.after(() => server.close());
  // The server daemon restarts (new boot, new credentials) under the same runtime path; the forward stays up.
  instance.child.kill('SIGTERM');
  await once(instance.child, 'exit');
  const second = await restart(t, instance, 'state-2');
  await rm(path.join(s.server, 'p9-foundation'));
  await symlink(second.state, path.join(s.server, 'p9-foundation'));
  assert.notEqual(second.credentials.cookie, instance.credentials.cookie);
  assert.equal((await server.check()).status, 'ok');
  assert.equal(JSON.parse(await readFile(path.join(server.state, 'desktop.json'), 'utf8')).cookie, second.credentials.cookie);
  // The ssh process ends (lid closed, network gone): onDrop runs and the folder goes.
  process.kill((await s.calls()).find(c => c.argv.includes('-N')).pid, 'SIGTERM');
  await Promise.race([dropped, new Promise((_, reject) => setTimeout(() => reject(new Error('no onDrop')), 5000))]);
  assert.ok(await gone(server.state));
});

test('Server mode: ~/.ssh/config hosts for the Settings list', { skip }, async () => {
  const s = await stage(), file = path.join(s.directory, 'config');
  await writeFile(file, 'Host pfister laptop\n  HostName 192.0.2.1\nHost *.example !bad -evil\nInclude other\n  host Lower\nMatch all\nHost pfister\n');
  assert.deepEqual(await sshHosts(file), ['pfister', 'laptop', 'Lower']);
  assert.deepEqual(await sshHosts(path.join(s.directory, 'none')), []);
});

test('Server mode in the window: badge, status, local-only actions, switch back', { skip }, async (t) => {
  const local = await daemon(t), remote = await daemon(t), s = await stage(remote);
  const profile = path.join(s.directory, 'profile'), forward = path.join(s.local, 'p9-server', 'test-host');
  await mkdir(profile);
  await writeFile(path.join(profile, 'p9-server.json'), JSON.stringify({ host: 'test-host' }));
  const env = { ...process.env, P9_SSH: s.ssh, XDG_RUNTIME_DIR: s.local }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', local.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#rChat').waitFor();
  const status = async want => {
    let last;
    for (const end = Date.now() + 20000; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 250))) {
      last = await page.evaluate(() => window.p9.getStatus()).catch(error => error.message);
      if (JSON.stringify(last) === JSON.stringify(want)) return;
    }
    assert.deepEqual(last, want);
  };
  await status({ status: 'ok', mode: 'server', host: 'test-host' });
  assert.equal(JSON.parse(await readFile(path.join(forward, 'desktop.json'), 'utf8')).cookie, remote.credentials.cookie);
  await page.locator('#serverBadge', { hasText: 'Server · test-host' }).waitFor();
  // This computer's service is not touched from Server mode, and the IPC takes only a host name ssh cannot read as an option.
  assert.deepEqual(await page.evaluate(async () => [await window.p9.repairService(), await window.p9.workspaceChange(), await window.p9.pickFolder(),
    await window.p9.server('-oProxyCommand=x').then(() => 'taken', e => e.message.includes('ipc-sender-refused'))]),
  [{ error: 'server-mode-local-only' }, { error: 'server-mode-local-only' }, undefined, true]);
  // The badge switches to Local: the window reloads onto this computer's daemon and the forward closes.
  await page.locator('#serverBadge').click();
  await page.locator('#serverBadge', { hasText: 'Local' }).waitFor();
  await status({ status: 'ok' });
  assert.ok(await gone(forward));
  assert.deepEqual(JSON.parse(await readFile(path.join(profile, 'p9-server.json'), 'utf8')), { host: null, last: 'test-host' });
});

// Send to server (D14) in the window: the button beside Hand off, then the pane frozen as moved. Screenshots go to the log (P9_SHOT).
test('Send to server in the window: the button, then Moved to the server', { skip, timeout: 60000 }, async (t) => {
  const markers = async ({ workspace }) => {
    for (const marker of ['uuid-sessions', 'claude-home']) await writeFile(path.join(workspace, marker), '');
    return { args: ['--acp-override', path.join(root, 'test/fake-acp-agent.mjs')] };
  };
  const local = await daemon(t, undefined, false, markers), remote = await daemon(t, undefined, false, markers), s = await stage(remote);
  const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
    headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body) }).then(result => JSON.parse(result.text));
  const id = (await call(local, '/chat', 'POST', { provider: 'claude' })).conversation;
  await call(local, '/chat/' + id + '/prompt', 'POST', { text: 'hello' });
  for (const end = Date.now() + 15000; !(await call(local, '/chat/events?after=0&only=' + id)).events.some(e => e.type === 'turn-end'); await new Promise(resolve => setTimeout(resolve, 100)))
    assert.ok(Date.now() < end, 'the first turn ended');
  const profile = path.join(s.directory, 'profile');
  await mkdir(profile);
  await writeFile(path.join(profile, 'p9-server.json'), JSON.stringify({ host: null, last: 'test-host' }));
  const env = { ...process.env, P9_SSH: s.ssh, XDG_RUNTIME_DIR: s.local }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', local.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise(resolve => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 800 });
  const shot = async name => { if (process.env.CI !== 'true') console.log('P9_SHOT ' + name + ' ' + (await page.screenshot()).toString('base64')); };
  const pane = page.locator('.pane[data-id="' + id + '"]');
  const button = pane.locator('[data-send-away]');
  await button.waitFor({ timeout: 20000 });
  assert.match(await button.getAttribute('title'), /test-host/);
  await button.hover();
  await shot('send-to-server-button');
  await button.click();
  await pane.getByText('Moved to test-host').first().waitFor({ timeout: 30000 });
  assert.equal(await pane.locator('textarea').isDisabled(), true);
  assert.equal(await pane.locator('[data-send]').isDisabled(), true);
  assert.equal(await pane.locator('[data-send-away]').count(), 0);
  await shot('send-to-server-moved');
  assert.equal((await call(remote, '/chat')).conversations.find(c => c.id === id)?.state, 'stopped');
});

// Sprint tracker (#35) in the window, in Server mode: the tile and its window read the server's status file, not this
// computer's; a sprint script asks first and runs there; switching to Local (no file here) takes the tile away.
test('Sprint in the window: the server\'s status file draws the tile and rings, scripts ask first, Local has none', { skip, timeout: 60000 }, async (t) => {
  const settings = async (paths) => {
    for (const dir of ['hub', 'projects', 'waiting']) await mkdir(path.join(paths.workspace, dir), { recursive: true });
    await writeFile(path.join(paths.workspace, 'hub', 'registry.json'), JSON.stringify({ scripts: [
      { id: 'sprint-start', title: 'Sprint start', group: 'Sprint', cmd: [process.execPath, '-e', 'console.log("start-" + "ok")'], confirm: true }], apps: [], pages: [] }));
    await writeFile(path.join(paths.workspace, 'projects', 'AGENTS.md'), '# Projects\n');
    await writeFile(path.join(paths.directory, 'settings.json'), JSON.stringify({ registry: 'hub/registry.json', primary: 'projects/AGENTS.md', waiting: 'waiting' }));
    return { args: ['--settings', path.join(paths.directory, 'settings.json')] };
  };
  const local = await daemon(t, undefined, false, settings), remote = await daemon(t, undefined, false, settings), s = await stage(remote);
  const status = path.join(remote.directory, '.local', 'state', 'sprint', 'status.json');
  await mkdir(path.dirname(status), { recursive: true });
  await writeFile(status, JSON.stringify({ sprint: 'Window sprint', updatedAt: '2026-10-27T14:30', cutoff: '07:00', chunks: [
    { id: 'c1', title: 'Settings rows', state: 'merged', percent: 100 }, { id: 'c2', title: 'Installer', state: 'running', percent: 40 },
    { id: 'c3', title: 'Phone layout', state: 'waiting', percent: 70, waitingOn: 'test run 4f2a in the queue' }] }));
  const profile = path.join(s.directory, 'profile');
  await mkdir(profile);
  await writeFile(path.join(profile, 'p9-server.json'), JSON.stringify({ host: 'test-host' }));
  const env = { ...process.env, P9_SSH: s.ssh, XDG_RUNTIME_DIR: s.local }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', local.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise(resolve => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 800 });
  const shot = async name => { if (process.env.CI !== 'true') console.log('P9_SHOT ' + name + ' ' + (await page.screenshot()).toString('base64')); };
  await page.locator('#serverBadge', { hasText: 'Server · test-host' }).waitFor({ timeout: 20000 });
  await page.locator('#rMission').click();
  const tile = page.locator('#fMission [data-sprint]');
  await tile.waitFor({ timeout: 15000 });
  assert.match(await tile.innerText(), /Sprint status\s+1\/3/);
  await shot('desktop-sprint-tile');
  await tile.click();
  const modal = page.locator('#mdl [data-sprint-body]');
  await modal.waitFor({ timeout: 5000 });
  assert.match(await page.locator('#mdlT').innerText(), /Window sprint/);
  assert.deepEqual(await modal.locator('.spr').evaluateAll(rows => rows.map(r => [r.dataset.state, r.querySelector('.ring b').textContent])),
    [['merged', '100%'], ['running', '40%'], ['waiting', '70%']]);
  assert.match(await modal.innerText(), /Waiting on: test run 4f2a in the queue/);
  assert.match(await modal.innerText(), /1 of 3 merged/);
  const colours = await modal.locator('.spr').evaluateAll(rows => rows.map(r => getComputedStyle(r.querySelector('.ring')).getPropertyValue('--ring-c').trim()));
  assert.equal(new Set(colours).size, 3, 'merged, running and waiting each their own colour: ' + colours);
  // No sprint-close or sprint-heavy in this registry: those buttons are off and say what is missing.
  assert.equal(await page.locator('#mdlFoot [data-sprint-run="sprint-close"]').getAttribute('title'), 'Add a sprint-close button to the registry');
  await shot('desktop-sprint-modal');
  await page.setViewportSize({ width: 390, height: 844 });
  const tmuxBox = await page.locator('#mdlFoot [data-sprint-tmux]').boundingBox();
  assert.ok(tmuxBox && tmuxBox.x + tmuxBox.width <= 390, 'Open tmux off the edge at 390 wide: ' + JSON.stringify(tmuxBox));
  await shot('desktop-sprint-modal-narrow');
  await page.setViewportSize({ width: 1280, height: 800 });
  // Sprint start: the script window, Run arms it, Confirm run runs it on the server.
  await page.locator('#mdlFoot [data-sprint-run="sprint-start"]').click();
  await page.locator('#mdlFoot [data-run]', { hasText: 'Run' }).click();
  await page.locator('#mdlFoot [data-run]', { hasText: 'Confirm run' }).click();
  await page.locator('#mdl', { hasText: 'start-ok' }).waitFor({ timeout: 15000 });
  await shot('desktop-sprint-ran');
  await page.keyboard.press('Escape');
  // Local: no status file on this computer, so no tile.
  await page.locator('#serverBadge').click();
  await page.locator('#serverBadge', { hasText: 'Local' }).waitFor({ timeout: 20000 });
  await page.locator('#rMission').click();
  await page.locator('#fMission [data-idea]').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('#fMission [data-sprint]').count(), 0, 'a Sprint tile in Local with no status file here');
  console.log('PASS desktop sprint: tile and rings from the server file, start confirmed and ran there, no tile in Local');
});
