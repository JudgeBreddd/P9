// Server mode (threat model row 50, apps/desktop/remote.mjs): the window reaches a P9 daemon on another machine through ssh.
// A stand-in ssh (test/fake-ssh.mjs) runs remote.mjs's real remote command against a real daemon's runtime folder and
// forwards a Unix socket the way OpenSSH's -L does, so everything but the network hop is the real thing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, restart, http, authenticated, root } from './helpers.mjs';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { connectServer, restartServer, sshHosts, READ } from '../apps/desktop/remote.mjs';
import { daemonRequest } from '../scripts/teh.mjs';
import { EDITOR_COMMIT, EDITOR_DOWNLOADS } from '../apps/desktop/editor-host.mjs';
import { editorFor } from './editor-fixture.mjs';

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
  // editor: false (the move's tunnel) forwards the daemon's socket only.
  const move = await connectServer({ host: 'test-host', ssh: s.ssh, runtime: path.join(s.local, 'move'), editor: false });
  t.after(() => move.close());
  const moved = (await s.calls()).filter(c => c.argv.includes('-N')).at(-1);
  assert.deepEqual(moved.argv.filter(arg => arg === '-L').length, 1, JSON.stringify(moved.argv));
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
  await page.locator('#serverBadge', { hasText: 'Remote · test-host' }).waitFor();
  // The files panel has no Send files to remote in Remote mode: the files are the remote's already.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator('#rFiles').click({ timeout: 20000 });
  await page.locator('#tree').waitFor({ state: 'visible', timeout: 20000 });
  await page.waitForTimeout(1500);
  if (process.env.CI !== 'true') console.log('P9_SHOT remote-files ' + (await page.screenshot()).toString('base64'));
  assert.equal(await page.locator('#xferBtn').isVisible(), false, 'no Send files to remote in Remote mode');
  // This computer's service is not touched from Server mode, and the IPC takes only a host name ssh cannot read as an option.
  assert.deepEqual(await page.evaluate(async () => [await window.p9.repairService(), await window.p9.workspaceChange(), await window.p9.pickFolder(),
    await window.p9.server('-oProxyCommand=x').then(() => 'taken', e => e.message.includes('ipc-sender-refused')), await window.p9.remoteInstall()]),
  [{ error: 'server-mode-local-only' }, { error: 'server-mode-local-only' }, undefined, true, { error: 'remote-install-refused' }]);
  // The badge switches to Local: the window reloads onto this computer's daemon and the forward closes.
  await page.locator('#serverBadge').click();
  await page.locator('#serverBadge', { hasText: 'Local' }).waitFor();
  await status({ status: 'ok' });
  assert.ok(await gone(forward));
  assert.deepEqual(JSON.parse(await readFile(path.join(profile, 'p9-server.json'), 'utf8')), { host: null, last: 'test-host', remotes: [] });
});

// D20: while the remote is not answering yet the window shows the connecting layer, not a blank page; once it answers the
// layer goes and the window is on the remote.
// P20 on the desktop: over the remote's ssh link a long open chat loads its newest 200 blocks, not its whole history;
// Show earlier reads the blocks before them, in order, until the first message.
test('Remote mode: a long chat loads its newest blocks over the ssh link; Show earlier reads the rest in order', { skip, timeout: 120000 }, async (t) => {
  const local = await daemon(t), remote = await daemon(t), s = await stage(remote), id = randomUUID();
  const db = new DatabaseSync(path.join(remote.directory, '.local', 'state', 'p9-foundation', 'p9.db'));
  db.prepare('INSERT INTO conversations (id, provider, title, state, created) VALUES (?, ?, ?, ?, ?)').run(id, 'claude', 'Long chat', 'idle', Date.now());
  const add = db.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)');
  add.run(id, 'created', JSON.stringify({ provider: 'claude', title: 'Long chat', folder: '' }), Date.now());
  for (let i = 1; i <= 300; i++) { // 600 blocks: a message and a reply each
    add.run(id, 'user', JSON.stringify({ text: `question ${i}.` }), Date.now());
    add.run(id, 'update', JSON.stringify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `answer ${i}.` } }), Date.now());
    add.run(id, 'turn-end', JSON.stringify({ stopReason: 'end_turn' }), Date.now());
  }
  db.close();
  const profile = path.join(s.directory, 'profile');
  await mkdir(profile);
  await writeFile(path.join(profile, 'p9-server.json'), JSON.stringify({ host: 'test-host' }));
  const env = { ...process.env, P9_SSH: s.ssh, XDG_RUNTIME_DIR: s.local }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', local.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  const hist = page.locator('.hist').filter({ hasText: 'answer 300.' }).first();
  await hist.waitFor({ timeout: 30000 });
  const text = () => hist.evaluate((h) => h.textContent);
  // The newest 200 blocks: question 201 on; nothing before, and Show earlier without a count (the rest is still on the remote).
  assert.match(await text(), /question 201\./);
  assert.doesNotMatch(await text(), /question 200\./);
  assert.equal((await hist.locator('[data-earlier]').textContent()).trim(), 'Show earlier');
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'));
  if (process.env.CI !== 'true') console.log('P9_SHOT desk-tail ' + png);
  for (let clicks = 0; await hist.locator('[data-earlier]').count(); clicks++) {
    assert.ok(clicks < 5, 'Show earlier reaches the first message');
    const before = (await text()).length;
    await hist.locator('[data-earlier]').click();
    await page.waitForFunction(([n]) => [...document.querySelectorAll('.hist')].some((h) => h.textContent.includes('answer 300.') && h.textContent.length > n), [before], { timeout: 15000 });
  }
  // Everything once, in order.
  const all = await text(), at = (n) => all.indexOf(`question ${n}.`);
  assert.ok(at(1) >= 0 && at(1) < at(2) && at(199) < at(200) && at(200) < at(201) && at(299) < at(300), 'in order');
  assert.equal(all.split('question 150.').length, 2, 'no block twice');
});

test('Remote mode connecting: a turning black hole and the reason until the remote answers, then the remote', { skip, timeout: 90000 }, async (t) => {
  const local = await daemon(t), remote = await daemon(t), s = await stage(null);
  const profile = path.join(s.directory, 'profile');
  await mkdir(profile);
  await writeFile(path.join(profile, 'p9-server.json'), JSON.stringify({ host: 'test-host' }));
  const env = { ...process.env, P9_SSH: s.ssh, XDG_RUNTIME_DIR: s.local }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', local.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  const layer = page.locator('dialog#connecting[open]');
  await layer.waitFor({ timeout: 20000 });
  assert.equal(await page.locator('#connT').textContent(), 'Connecting to test-host');
  assert.match(await page.locator('#connWhy').textContent(), /P9 is not running there. Install it there from here/);
  await page.waitForTimeout(600); // a turn of the ring in the shot
  await evidence(page, 'd20-connecting');
  // D15a: Install P9 there asks first, in place, saying where and what it never does; Not now goes back and installs nothing.
  await page.locator('#connInstall', { hasText: 'Install P9 there' }).click({ timeout: 10000 });
  assert.match(await page.locator('#connWhy').textContent(), /^Install P9 on test-host\? Over your ssh login, P9 puts its source in ~\/p9 there.*never uses sudo or a password/);
  assert.equal(await page.locator('#connInstall').textContent(), 'Install');
  await page.waitForTimeout(1500); // the status poll does not overwrite the question
  assert.match(await page.locator('#connWhy').textContent(), /^Install P9 on test-host\?/);
  await evidence(page, 'd15a-ask');
  await page.click('#connNo');
  assert.equal(await page.locator('#connNo').isVisible(), false);
  assert.match(await page.locator('#connWhy').textContent(), /P9 is not running there/);
  assert.equal(await page.evaluate(() => window.p9.getStatus().then((r) => r.install ?? null)), null, 'Not now ran nothing');
  // P9 starts on the remote: the next try connects, the layer goes, the window is on the remote.
  await symlink(remote.state, path.join(s.server, 'p9-foundation'));
  await page.locator('#serverBadge', { hasText: 'Remote · test-host' }).waitFor({ timeout: 45000 });
  await page.locator('dialog#connecting[open]').waitFor({ state: 'detached', timeout: 45000 });
  assert.equal(await page.locator('dialog#connecting[open]').count(), 0);
  await evidence(page, 'd20-connected');
  console.log('PASS remote connecting: the layer while not answering, gone once on the remote');
});

// D3: Settings > Remote lists only what this person has: the remotes added here and their own ~/.ssh/config Hosts, none built
// in. Add remote takes a name ssh cannot read as an option; Remove takes it off again, in p9-server.json too.
test('Remote list in Settings: nothing built in, Add remote refuses an option, adds, removes', { skip, timeout: 60000 }, async (t) => {
  const local = await daemon(t), s = await stage(null);
  const profile = path.join(s.directory, 'profile'), home = path.join(s.directory, 'home');
  await mkdir(profile); await mkdir(path.join(home, '.ssh'), { recursive: true });
  await writeFile(path.join(home, '.ssh', 'config'), 'Host from-config\n  HostName 192.0.2.1\n');
  const env = { ...process.env, HOME: home, P9_SSH: s.ssh, XDG_RUNTIME_DIR: s.local }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', local.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#rChat').waitFor({ timeout: 20000 });
  await page.click('#setBtn'); await page.locator('#setDlg[open]').waitFor();
  const listed = () => page.locator('#setRemote li strong').allTextContents();
  assert.deepEqual(await listed(), ['from-config'], 'only the ~/.ssh/config Host, nothing built in');
  await page.fill('#setRemoteName', '-oProxyCommand=x'); await page.locator('#setRemoteAdd button').click();
  await page.locator('#setRemoteErr:not([hidden])').waitFor();
  assert.deepEqual(await listed(), ['from-config']);
  await page.fill('#setRemoteName', 'test-host'); await page.locator('#setRemoteAdd button').click();
  await page.locator('#setRemote li', { hasText: 'test-host' }).locator('text=Added here').waitFor({ timeout: 10000 });
  assert.deepEqual(JSON.parse(await readFile(path.join(profile, 'p9-server.json'), 'utf8')).remotes, ['test-host']);
  await page.locator('#setRemote').scrollIntoViewIfNeeded();
  await evidence(page, 'd3-remote-list');
  await page.locator('[data-remote-remove="test-host"]').click();
  await page.locator('#setRemote li', { hasText: 'test-host' }).waitFor({ state: 'detached', timeout: 10000 });
  assert.deepEqual(JSON.parse(await readFile(path.join(profile, 'p9-server.json'), 'utf8')).remotes, []);
  // K1: a remote before 0.1.6 (main's p9:server-update too-old): a dialog with the steps by hand, at once.
  await page.keyboard.press('Escape');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('p9:server-update', { phase: 'too-old', host: 'test-host', server: '0.1.5', app: '0.1.6' }));
  await page.locator('#mdlBody ol.steps').waitFor({ timeout: 10000 });
  assert.match(await page.locator('#mdlBody').innerText(), /P9 on test-host runs 0\.1\.5, too old to update itself\. Update it once by hand/);
  assert.deepEqual(await page.locator('#mdlBody ol.steps li').allTextContents(), ['git pull', 'pnpm install --frozen-lockfile', 'pnpm build', 'bash scripts/install.sh', 'systemctl --user restart p9-foundation']);
  assert.doesNotMatch(await page.locator('#mdlBody').innerText(), /In the real app/);
  await page.evaluate(() => Promise.allSettled(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished)));
  await evidence(page, 'k1-too-old');
  console.log('PASS remote list: nothing built in, an option refused, added and removed; too-old shows the steps');
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
  await writeFile(status, JSON.stringify({ sprint: 'Window sprint', updatedAt: new Date().toISOString(), cutoff: new Date(Date.now() + 86400000).toISOString(), overall: 70, chunks: [
    { id: 'c1', title: 'Settings rows', state: 'merged', percent: 100, steps: '8/8', activity: 'done' }, { id: 'c2', title: 'Installer', state: 'running', percent: 40, steps: '3/8', activity: 'testing' },
    { id: 'c3', title: 'Phone layout', state: 'waiting', percent: 70, waitingOn: 'test run 4f2a in the queue', steps: '5/12', activity: 'needs you' },
    { id: 'c4', title: 'Rebuild', state: 'running', percent: 10, steps: '1/9', activity: 'building' }, { id: 'c5', title: 'Tests', state: 'waiting', percent: 0, steps: '0/4', activity: 'in line' },
    { id: 'c6', title: 'Docs', state: 'running', percent: 0, activity: 'idle' }] }));
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
  await page.locator('#serverBadge', { hasText: 'Remote · test-host' }).waitFor({ timeout: 20000 });
  await page.locator('#rMission').click();
  const tile = page.locator('#fMission [data-sprint]');
  await tile.waitFor({ timeout: 15000 });
  assert.match(await tile.innerText(), /Sprint status\s+1\/6/);
  await shot('desktop-sprint-tile');
  await tile.click();
  const modal = page.locator('#mdl [data-sprint-body]');
  await modal.waitFor({ timeout: 5000 });
  assert.match(await page.locator('#mdlT').innerText(), /Window sprint/);
  assert.deepEqual(await modal.locator('.spr').evaluateAll(rows => rows.map(r => [r.dataset.state, r.querySelector('.ring b').textContent])),
    [['merged', '100%'], ['running', '40%'], ['waiting', '70%'], ['running', '10%'], ['waiting', '0%'], ['running', '0%']]);
  assert.match(await modal.innerText(), /Waiting on: test run 4f2a in the queue/);
  assert.match(await modal.innerText(), /1 of 6 merged/);
  // The feed's fields: the whole-sprint ring, every activity word with the steps count, and times a person can read.
  assert.deepEqual(await modal.locator('.spall .ring').evaluate(ring => [ring.querySelector('b').textContent, ring.style.getPropertyValue('--p')]), ['70%', '70']);
  assert.deepEqual(await modal.locator('.spr').evaluateAll(rows => rows.map(r => [r.querySelector('[data-activity]').textContent, r.querySelector('[data-steps]')?.textContent ?? null])),
    [['done', '8/8'], ['testing', '3/8'], ['needs you', '5/12'], ['building', '1/9'], ['in line', '0/4'], ['idle', null]]);
  const times = await modal.locator('[data-sprint-times]').innerText();
  assert.match(times, /^Updated \d{1,2}:\d{2}\D*(AM|PM)? · cutoff \d{1,2}:\d{2}\D*(AM|PM)? tomorrow$/i);
  assert.doesNotMatch(times, /\d{4}-\d\d-\d\d|T\d\d:/);
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

// Send files (item 23) in the window (Local mode, a server chosen before): the files panel's button, the first-send prompt, the conflict prompt
// with the delete box and the Syncthing warning, and a limit refusal that opens its Setting. The pictures go out in
// the log as "P9_SHOT <name> <base64>" (the dev space keeps no files; not on GitHub).
test('xfer window: the first-send and conflict prompts ask in words, and a limit refusal opens its Setting', { skip, timeout: 60000 }, async (t) => {
  const at = (hhmm) => new Date('2026-10-27T' + hhmm + ':00Z'); // the window runs at TZ=UTC
  // Mission's settings (the page goes live, and the files panel with it, once Mission answers), the same on both sides,
  // so those files are "same" in the plan.
  const fill = (files) => async ({ workspace, directory }) => {
    files = { ...files, 'hub/registry.json': JSON.stringify({ scripts: [], apps: [], pages: [] }), 'projects/AGENTS.md': '# Projects\n' };
    for (const [name, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(workspace, name)), { recursive: true }); await writeFile(path.join(workspace, name), text); }
    await mkdir(path.join(workspace, 'waiting'));
    await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ registry: 'hub/registry.json', primary: 'projects/AGENTS.md', waiting: 'waiting' }));
    return { args: ['--settings', path.join(directory, 'settings.json')] };
  };
  const laptop = await daemon(t, undefined, false, fill({ 'docs/a.md': '# A, the laptop\'s', 'docs/plan.md': 'plan, laptop', 'src/new.js': 'new' }));
  const server = await daemon(t, undefined, false, fill({ 'docs/a.md': '# A, the server\'s', 'docs/plan.md': 'plan, server' }));
  await utimes(path.join(laptop.workspace, 'docs/a.md'), at('11:02'), at('11:02'));
  await utimes(path.join(server.workspace, 'docs/a.md'), at('13:40'), at('13:40'));
  await utimes(path.join(laptop.workspace, 'docs/plan.md'), at('16:20'), at('16:20'));
  await utimes(path.join(server.workspace, 'docs/plan.md'), at('09:15'), at('09:15'));
  const s = await stage(server), profile = path.join(s.directory, 'profile');
  await mkdir(profile);
  await writeFile(path.join(profile, 'p9-server.json'), JSON.stringify({ host: null, last: 'test-host' }));
  const env = { ...process.env, P9_SSH: s.ssh, XDG_RUNTIME_DIR: s.local, TZ: 'UTC' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', laptop.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 800 });
  const shot = async (name) => { if (process.env.CI !== 'true') console.log('P9_SHOT ' + name + ' ' + (await page.screenshot()).toString('base64')); };
  const dialog = page.locator('#xferDlg'), title = page.locator('#xferT');
  const send = async () => { await page.click('#xferBtn'); await dialog.waitFor({ timeout: 20000 }); };
  await page.locator('#rFiles').click({ timeout: 20000 });
  await page.locator('#fileScope').waitFor({ state: 'visible', timeout: 20000 });
  await page.selectOption('#fileScope', 'workspace');
  await page.locator('#xferBtn').waitFor({ timeout: 20000 });
  assert.match(await page.locator('#xferBtn').getAttribute('title'), /test-host/);

  // First send: nothing recorded, two files differ; one choice for the list, and no "Keep the server's".
  await send();
  assert.equal(await title.innerText(), 'First send to test-host');
  const asked = await page.locator('[data-xfer-asked]').innerText();
  assert.match(asked, /2 files differ between the two/);
  assert.match(asked, /1 newer on the laptop, 1 newer on the remote/);
  assert.match(asked, /docs\/a\.md different on the two; the remote's copy is newer \([^)]*1:40[^)]*\) than the laptop's \([^)]*11:02[^)]*\)/);
  assert.deepEqual(await dialog.locator('[data-xfer-choice]').allInnerTexts(), ['Laptop wins', 'Keep the newer of each']);
  assert.equal(await dialog.locator('[data-xfer-syncthing]').count(), 0);
  await shot('xfer-first-send');
  await dialog.locator('[data-xfer-choice="newer"]').click();
  for (const end = Date.now() + 20000; (await title.innerText()) !== 'Sent'; await new Promise((resolve) => setTimeout(resolve, 100))) assert.ok(Date.now() < end, 'sent: ' + await dialog.innerText());
  assert.match(await page.locator('#xferP').innerText(), /2 sent, 1 taken from the remote, 2 old copies kept in recovery/);
  const read = (box, name) => readFile(path.join(box.workspace, name), 'utf8');
  assert.deepEqual([await read(laptop, 'docs/a.md'), await read(server, 'docs/plan.md'), await read(server, 'src/new.js')], ['# A, the server\'s', 'plan, laptop', 'new']);
  await dialog.locator('[data-xfer-close]').click();
  console.log('PASS xfer window first send: asked in words with the summary line; keep the newer settled each file');

  // Since: docs/a.md changed on both, src/new.js deleted here, and the server's docs is a Syncthing folder.
  await writeFile(path.join(laptop.workspace, 'docs/a.md'), '# A, laptop edit');
  await writeFile(path.join(server.workspace, 'docs/a.md'), '# A, server edit');
  await utimes(path.join(laptop.workspace, 'docs/a.md'), at('11:02'), at('11:02'));
  await utimes(path.join(server.workspace, 'docs/a.md'), at('13:40'), at('13:40'));
  await rm(path.join(laptop.workspace, 'src/new.js'));
  await mkdir(path.join(server.workspace, 'docs/.stfolder'));
  await send();
  assert.equal(await title.innerText(), 'Files changed on both sides');
  assert.match(await page.locator('[data-xfer-asked]').innerText(),
    /docs\/a\.md changed on both since your last send; the remote's copy is newer \([^)]*1:40[^)]*\) than the laptop's \([^)]*11:02[^)]*\)/);
  assert.match(await page.locator('[data-xfer-asked]').innerText(), /0 newer on the laptop, 1 newer on the remote/);
  assert.match(await page.locator('[data-xfer-deletes]').innerText(), /Delete on the remote too\s*1 file was deleted on the laptop since your last send/);
  assert.match(await page.locator('[data-xfer-syncthing]').innerText(), /Syncthing already syncs this folder.*docs \(server\)/s);
  assert.deepEqual(await dialog.locator('[data-xfer-choice]').allInnerTexts(), ['Keep the laptop\'s', 'Keep the remote\'s', 'Keep the newer of each']);
  await page.check('#xferDel');
  await shot('xfer-conflict');
  await dialog.locator('[data-xfer-choice="server"]').click();
  for (const end = Date.now() + 20000; (await title.innerText()) !== 'Sent'; await new Promise((resolve) => setTimeout(resolve, 100))) assert.ok(Date.now() < end, 'sent: ' + await dialog.innerText());
  assert.match(await page.locator('#xferP').innerText(), /1 taken from the remote, 1 deleted on the remote, 2 old copies kept in recovery/);
  assert.equal(await read(laptop, 'docs/a.md'), '# A, server edit');
  await assert.rejects(stat(path.join(server.workspace, 'src/new.js')));
  await dialog.locator('[data-xfer-close]').click();
  console.log('PASS xfer window conflict: asked with the delete box and the Syncthing warning; keep the server\'s and the delete landed');

  // A limit: 1 MiB a file, a 2 MiB file. Refused before anything is copied; Open Settings lands on that limit.
  await page.evaluate(() => window.p9.getSettings().then((s) => window.p9.setSettings({ ...s, xfer: { ...s.xfer, fileMiB: 1 } })));
  await rm(path.join(server.workspace, 'docs/.stfolder'), { recursive: true });
  await writeFile(path.join(laptop.workspace, 'docs/big.bin'), Buffer.alloc(2 * 1024 * 1024, 1));
  await send();
  for (const end = Date.now() + 20000; (await title.innerText()) !== 'Not sent'; await new Promise((resolve) => setTimeout(resolve, 100))) assert.ok(Date.now() < end, 'refused: ' + await dialog.innerText());
  assert.match(await page.locator('#xferP').innerText(), /docs\/big\.bin is 2\.0 MiB; the limit is 1 MiB a file\. Change it in Settings, Largest file to send\./);
  await shot('xfer-limit');
  await page.click('#xferSetting');
  await page.locator('#setXfer-fileMiB').waitFor({ timeout: 10000 });
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'setXfer-fileMiB');
  await assert.rejects(stat(path.join(server.workspace, 'docs/big.bin')));
  console.log('PASS xfer window limit: refused before sending, named Largest file to send, and Open Settings focused it');
});

// Send to server with the chat's folder (item 23; Builder, 2026-10-27): a folder that needs a choice shows the Send files prompt
// before the chat is frozen ("Same prompt first"); Cancel freezes nothing, a choice sends the folder and then the chat. A
// Syncthing folder sends no files and keeps the wait ("Keep today's wait").
test('xfer window move: the prompt comes before the freeze, the folder goes first; a Syncthing folder sends no files', { skip, timeout: 60000 }, async (t) => {
  const fill = (files) => async ({ workspace, directory }) => {
    files = { ...files, 'hub/registry.json': JSON.stringify({ scripts: [], apps: [], pages: [] }), 'projects/AGENTS.md': '# Projects\n', 'uuid-sessions': '', 'claude-home': '' };
    for (const [name, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(workspace, name)), { recursive: true }); await writeFile(path.join(workspace, name), text); }
    await mkdir(path.join(workspace, 'waiting'));
    await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ registry: 'hub/registry.json', primary: 'projects/AGENTS.md', waiting: 'waiting' }));
    return { args: ['--settings', path.join(directory, 'settings.json'), '--acp-override', path.join(root, 'test/fake-acp-agent.mjs')] };
  };
  const laptop = await daemon(t, undefined, false, fill({ 'docs/a.md': 'laptop' }));
  const server = await daemon(t, undefined, false, fill({ 'docs/a.md': 'server' }));
  const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
    headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body) }).then((result) => ({ status: result.status, ...(result.status === 404 ? {} : JSON.parse(result.text)) }));
  const until = async (check, what, ms = 20000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 100))) if (await check()) return;
    assert.fail('timed out: ' + what);
  };
  const listed = async (instance, id) => (await call(instance, '/chat')).conversations.find((c) => c.id === id);
  const chat = async (text) => {
    const id = (await call(laptop, '/chat', 'POST', { provider: 'claude' })).conversation;
    assert.equal((await call(laptop, '/chat/' + id + '/prompt', 'POST', { text })).status, 202);
    await until(async () => (await call(laptop, '/chat/events?after=0&only=' + id)).events.some((e) => e.type === 'turn-end'), text + ' answered');
    return id;
  };
  const s = await stage(server), profile = path.join(s.directory, 'profile');
  await mkdir(profile);
  await writeFile(path.join(profile, 'p9-server.json'), JSON.stringify({ host: null, last: 'test-host' }));
  const env = { ...process.env, P9_SSH: s.ssh, XDG_RUNTIME_DIR: s.local, TZ: 'UTC' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', laptop.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 800 });
  const shot = async (name) => { if (process.env.CI !== 'true') console.log('P9_SHOT ' + name + ' ' + (await page.screenshot()).toString('base64')); };
  const dialog = page.locator('#xferDlg'), read = (box, name) => readFile(path.join(box.workspace, name), 'utf8');
  const press = async (id) => {
    await page.locator('#tabs .tab[data-id="' + id + '"]').click({ timeout: 20000 });
    await page.locator('.pane[data-id="' + id + '"] [data-send-away]').click({ timeout: 20000 });
  };

  // docs/a.md differs and nothing was sent before: the first-send prompt, with the chat still runnable here.
  const id = await chat('edit moved-notes.md');
  await press(id);
  await dialog.waitFor({ timeout: 20000 });
  assert.equal(await page.locator('#xferT').innerText(), 'First send to test-host');
  assert.match(await page.locator('#xferP').innerText(), /The chat moves once they are there\./);
  assert.deepEqual(await dialog.locator('[data-xfer-choice]').allInnerTexts(), ['Laptop wins', 'Keep the newer of each']);
  assert.notEqual((await listed(laptop, id)).state, 'moving', 'frozen before the choice');
  await shot('xfer-move-ask');
  await dialog.locator('[data-xfer-close]').click();
  await page.waitForTimeout(500);
  assert.notEqual((await listed(laptop, id)).state, 'moving', 'Cancel froze it');
  assert.equal(await listed(server, id), undefined);
  // Laptop wins: the folder goes, then the chat; no Syncthing wait. Every label the move shows is kept, to check the uploading words.
  const said = () => page.evaluate(() => window.__said.splice(0));
  await page.evaluate(() => { window.__said = []; new MutationObserver(() => window.__said.push(document.querySelector('#moveWhat').textContent)).observe(document.querySelector('#moveWhat'), { childList: true, characterData: true, subtree: true }); });
  await press(id);
  await dialog.waitFor({ timeout: 20000 });
  await dialog.locator('[data-xfer-choice="laptop"]').click();
  await until(async () => (await listed(laptop, id))?.state === 'moved', 'the chat moved');
  assert.ok(await listed(server, id));
  assert.deepEqual([await read(server, 'docs/a.md'), await read(server, 'moved-notes.md')], ['laptop', await read(laptop, 'moved-notes.md')]);
  await page.locator('#moveDlg[open]').waitFor({ timeout: 20000 });
  await page.click('#moveNo');
  const words = await said();
  assert.ok(words.includes('Sending the files and the chat to test-host'), words.join(' | '));
  assert.ok(!words.includes('Waiting for the files…'), words.join(' | '));
  console.log('PASS xfer window move: the prompt came before the freeze, Cancel froze nothing, Laptop wins sent the folder and then the chat');

  // A Syncthing folder: no prompt and no files, though docs/a.md differs again; the chat moves once the server has its file.
  await writeFile(path.join(laptop.workspace, 'docs/a.md'), 'laptop again');
  await mkdir(path.join(laptop.workspace, '.stfolder'));
  const synced = await chat('edit synced.md');
  await writeFile(path.join(server.workspace, 'synced.md'), await read(laptop, 'synced.md')); // as Syncthing would
  await press(synced);
  await until(async () => (await listed(laptop, synced))?.state === 'moved', 'the Syncthing chat moved');
  assert.equal(await dialog.isVisible(), false, 'no prompt for a Syncthing folder');
  assert.equal(await read(server, 'docs/a.md'), 'laptop', 'no files sent into a Syncthing folder');
  assert.ok((await said()).includes('Sending the chat to test-host'));
  console.log('PASS xfer window move: a Syncthing folder moved with no prompt and no files');
});

// ---- Item 33: Dev Focus in Server mode (threat model row 50). The server's daemon starts its editor server on editor.sock;
// the tunnel's second forward carries it, and a loopback relay on the laptop hands it to the same Dev Focus page as Local's.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// A screenshot: saved under P9_EVIDENCE, else printed into the log (the dev space keeps no files).
const evidence = async (page, name) => {
  const png = await page.screenshot();
  if (process.env.P9_EVIDENCE) { await mkdir(process.env.P9_EVIDENCE, { recursive: true }); await writeFile(path.join(process.env.P9_EVIDENCE, name + '.png'), png); }
  else if (process.env.CI !== 'true') console.log('P9_SHOT ' + name + ' ' + png.toString('base64'));
};
// GET over a Unix socket, answering the status (the REH's token check: 403 without the token).
const socketGet = (socketPath, route) => new Promise((resolve, reject) => {
  const req = request({ socketPath, path: route, headers: { host: 'localhost' }, timeout: 10000 }, res => { res.resume(); resolve(res.statusCode); });
  req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout'))); req.end();
});
const refused = async (socketPath, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await socketGet(socketPath, '/').then(() => false, () => true)) return true;
  return false;
};
// A daemon set up as the server: the editor server (the fixture, or the real one) on its PATH and P9_EDITOR_HOST.
const editorDaemon = (t, editor, env = { P9_EDITOR_HOST: editor.host }) => daemon(t, undefined, false, async () => ({ path: editor.path, env }));

test('Server mode Dev Focus: the server\'s daemon runs one editor on editor.sock, the tunnel forwards it, the daemon\'s stop ends it', { skip, timeout: 120000 }, async (t) => {
  const editor = await editorFor();
  if (!editor) return t.skip('needs the editor server (P9_EDITOR_HOST, or the fixtures reh.tar.gz)');
  const instance = await editorDaemon(t, editor), s = await stage(instance);
  const server = await connectServer({ host: 'test-host', ssh: s.ssh, runtime: s.local });
  t.after(() => server.close());
  // One ssh, two forwards: the daemon's socket and the editor's, both into the owner-only folder.
  const tunnel = (await s.calls()).find(c => c.argv.includes('-N'));
  assert.deepEqual(tunnel.argv.flatMap((arg, i) => (arg === '-L' ? [tunnel.argv[i + 1]] : [])), [
    path.join(server.state, 'daemon.sock') + ':' + path.join(s.server, 'p9-foundation', 'daemon.sock'),
    path.join(server.state, 'editor.sock') + ':' + path.join(s.server, 'p9-foundation', 'editor.sock')]);
  // Desktop only and exact: the route takes {} and nothing else.
  assert.equal((await daemonRequest(server.state, 'POST', '/dev/editor', { path: '/' })).status, 400);
  const started = await daemonRequest(server.state, 'POST', '/dev/editor', {}, undefined, 60000);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.commit, EDITOR_COMMIT);
  assert.match(started.body.token, /^[0-9a-f]{64}$/);
  assert.equal(await mode(path.join(instance.state, 'editor.sock')), 0o600, 'the editor socket on the server is owner-only');
  // Through the forward, the editor's own token check: refused without it, served with it.
  const forwarded = path.join(server.state, 'editor.sock');
  assert.equal(await socketGet(forwarded, '/'), 403);
  assert.notEqual(await socketGet(forwarded, '/?tkn=' + started.body.token), 403);
  // One editor per daemon: asking again gets the same one; Install is refused while it runs.
  assert.equal((await daemonRequest(server.state, 'POST', '/dev/editor', {}, undefined, 60000)).body.token, started.body.token);
  assert.equal((await daemonRequest(server.state, 'POST', '/dev/editor/install', {})).status, 409);
  // The dev view's writes into the editor's data folder are checked on the server: inside it yes, the workspace no.
  const writable = (file, kind = 'write') => daemonRequest(server.state, 'POST', '/dev/editor/writable', { path: file, kind }).then(r => r.body.ok);
  assert.equal(await writable(path.join(started.body.data, 'settings.json')), true);
  assert.equal(await writable(path.join(instance.workspace, 'note.txt')), false);
  assert.equal((await daemonRequest(server.state, 'POST', '/dev/editor/writable', { path: '/x', kind: 'write', more: 1 })).status, 400);
  // The editor runs in its own scope, so it would outlive the daemon: the daemon's stop ends it.
  instance.child.kill('SIGTERM');
  await once(instance.child, 'exit');
  assert.ok(await refused(path.join(instance.state, 'editor.sock')), 'the editor server still answers after the daemon stopped');
  console.log('PASS server editor: two forwards, one editor on a 0600 socket, token checked through the tunnel, writable checked there, ended with the daemon');
});

test('Dev Focus in Server mode, in the window: the unavailable page names the server, Install there, then the server\'s files open and save', { skip, timeout: 300000 }, async (t) => {
  const editor = await editorFor(), tarball = path.join(root, '_private', 'fixtures', 'reh.tar.gz');
  if (!editor || !existsSync(tarball) || process.arch !== 'x64') return t.skip('needs the fixtures reh.tar.gz (x64) and the editor server');
  // The download Install fetches, from loopback: the pinned x64 file itself.
  const files = createServer((req, res) => createReadStream(tarball).pipe(res)).listen(0, '127.0.0.1');
  await once(files, 'listening');
  t.after(() => files.close());
  // The server has no editor server yet (no P9_EDITOR_HOST: its own ~/.local/share/p9/codium-server, which is missing).
  const remote = await editorDaemon(t, editor, { P9_EDITOR_SERVER_URL: 'http://127.0.0.1:' + files.address().port + '/reh.tar.gz', P9_EDITOR_SERVER_SHA256: EDITOR_DOWNLOADS.x64[1] });
  const local = await daemon(t), s = await stage(remote);
  const profile = path.join(s.directory, 'profile');
  await mkdir(profile);
  await writeFile(path.join(profile, 'p9-server.json'), JSON.stringify({ host: 'test-host' }));
  await writeFile(path.join(remote.workspace, 'on-server.txt'), 'before\n');
  // This computer's editor server would be "missing" too: a Dev Focus that worked here could only be the server's.
  const env = { ...process.env, P9_SSH: s.ssh, XDG_RUNTIME_DIR: s.local, HOME: s.directory, P9_EDITOR_HOST: path.join(s.directory, 'no-editor-here') };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', local.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), sleep(15000)]); proc.kill(); });
  const shell = await app.firstWindow();
  await shell.locator('#serverBadge', { hasText: 'Remote · test-host' }).waitFor({ timeout: 20000 });
  const devPage = () => app.waitForEvent('window', { predicate: page => page.url().startsWith('p9://dev/'), timeout: 60000 });
  let opened = devPage();
  await shell.keyboard.press('Control+2');
  let dev = await opened;
  // Missing on the server: the page says where, and Install acts there.
  await dev.locator('#cause').waitFor({ timeout: 60000 });
  assert.match(await dev.locator('#cause').textContent(), /not installed on the remote test-host\. It belongs in .*\.local\/share\/p9\/codium-server\./);
  assert.equal(await dev.locator('#install').textContent(), 'Install the editor server on the remote');
  await evidence(dev, 'c10-server-unavailable');
  opened = devPage();
  await dev.locator('#install').click();
  dev = await opened;
  const errors = []; dev.on('pageerror', error => errors.push(error.stack ?? error.message));
  await dev.waitForFunction(() => window.devFocusReady || document.querySelector('#cause')?.textContent, null, { timeout: 120000 });
  assert.equal(await dev.locator('#cause').count(), 0, await dev.locator('#cause').textContent().catch(() => ''));
  const config = await dev.evaluate(() => window.p9dev.config());
  assert.equal(config.server, 'test-host');
  assert.equal(config.workspace, remote.workspace);
  assert.ok(existsSync(path.join(remote.directory, '.local', 'share', 'p9', 'codium-server', 'product.json')), 'installed in the server\'s ~/.local/share/p9');
  // The server's file opens, and Ctrl+S saves it on the server, through the guarded save over the tunnel.
  await dev.evaluate(async () => {
    const { v, open } = window.devFocus, editor = await open('on-server.txt');
    await editor.edit(edit => edit.insert(new v.Position(0, 0), 'typed '));
  });
  await dev.evaluate(() => window.devFocus.v.commands.executeCommand('workbench.action.focusActiveEditorGroup'));
  await dev.keyboard.press('Control+s');
  const saved = path.join(remote.workspace, 'on-server.txt');
  for (let i = 0; i < 60 && (await readFile(saved, 'utf8')) === 'before\n'; i++) await sleep(250);
  assert.equal(await readFile(saved, 'utf8'), 'typed before\n', 'Ctrl+S saved the server\'s file');
  await evidence(dev, 'c10-server-dev-focus');
  assert.deepEqual(errors.filter(error => !/EAI_AGAIN|ENOTFOUND|ECONNREFUSED/.test(error)), []);
  console.log('PASS server Dev Focus in the window: missing names the server, Install there, the server\'s file opened and saved');
});

test('Dev Focus\'s page when the editor server cannot start: no systemd user session says what to do', { skip, timeout: 120000 }, async (t) => {
  const editor = await editorFor();
  if (!editor) return t.skip('needs the editor server (P9_EDITOR_HOST, or the fixtures reh.tar.gz)');
  const local = await daemon(t), dir = await mkdtemp(path.join(os.tmpdir(), 'p9-nobus-'));
  // What systemd-run prints with no user manager to talk to (su, sudo, an ssh login on a server without lingering).
  await writeFile(path.join(dir, 'systemd-run'), '#!/bin/sh\necho "Failed to connect to user scope bus via local transport: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined" >&2\nexit 1\n', { mode: 0o755 });
  const env = { ...process.env, HOME: dir, PATH: dir + ':' + process.env.PATH, P9_EDITOR_HOST: editor.host };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', local.state, '--user-data-dir=' + path.join(dir, 'profile')], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), sleep(15000)]); proc.kill(); });
  const shell = await app.firstWindow();
  await shell.locator('#cards .card').first().waitFor();
  const opened = app.waitForEvent('window', { predicate: page => page.url().startsWith('p9://dev/'), timeout: 60000 });
  await shell.keyboard.press('Control+2');
  const dev = await opened;
  await dev.locator('#cause').waitFor({ timeout: 60000 });
  const cause = await dev.locator('#cause').textContent();
  assert.match(cause, /this computer has no systemd user session/);
  assert.match(cause, /loginctl enable-linger/);
  assert.equal(await dev.locator('#install').count(), 0, 'Install would not fix a missing user session');
  await evidence(dev, 'c10-no-user-session');
  console.log('PASS unavailable page: no user session named, with what to do, and no Install button');
});

// D13: the first start after an update says so: the version, one line per change, and the full list's link (the release
// commit). Close closes it and a reload does not bring it back.
test('What is new: after an update the window lists the changes and links the full list', { skip, timeout: 90000 }, async (t) => {
  const local = await daemon(t), directory = await mkdtemp(path.join(os.tmpdir(), 'p9-news-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const profile = path.join(directory, 'profile'), opened = path.join(directory, 'opened');
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  await mkdir(profile);
  await writeFile(path.join(profile, 'p9-version.txt'), '0.1.5');
  await writeFile(path.join(directory, 'open'), '#!/bin/sh\necho "$1" > ' + JSON.stringify(opened) + '\n', { mode: 0o755 });
  const env = { ...process.env, P9_OPEN_URL: path.join(directory, 'open') }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', local.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#mdlBody .review.news').waitFor({ timeout: 20000 });
  assert.equal(await page.locator('#mdlT').innerText(), 'Updated to ' + version);
  assert.match(await page.locator('#mdlBody').innerText(), new RegExp('P9 went from 0\\.1\\.5 to ' + version.replace(/\./g, '\\.') + '\\. What changed:'));
  const { WHATS_NEW } = await import('../apps/web/src/whats-new.mjs');
  assert.deepEqual(await page.locator('#mdlBody .review.news li').allTextContents(), WHATS_NEW.changes);
  await page.evaluate(() => Promise.allSettled(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished)));
  await evidence(page, 'd13-whats-new');
  await page.locator('#mdlFoot [data-full]').click();
  for (const end = Date.now() + 10000; Date.now() < end && !existsSync(opened); await new Promise((resolve) => setTimeout(resolve, 100)));
  assert.equal((await readFile(opened, 'utf8')).trim(), 'https://github.com/JudgeBreddd/p9/commit/v' + version);
  await page.locator('#mdlFoot [data-dismiss]').click();
  await page.locator('#mdl[open]').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  assert.equal(await page.evaluate(() => document.querySelector('#mdl').open), false);
  assert.equal(await readFile(path.join(profile, 'p9-version.txt'), 'utf8'), version);
  await page.reload();
  await page.locator('#rChat').waitFor();
  assert.equal(await page.evaluate(() => window.p9.whatsNew()), null);
});
