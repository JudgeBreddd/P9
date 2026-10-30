// Attempt 2 items 1-3 (threat model row 78): a remote with no ssh key asks for the password in P9's own window, once, and
// connects; a wrong one says so and is kept nowhere; the setup wizard connects to a remote itself, never through Settings.
// The stand-in ssh (fake-ssh.mjs) refuses key-only login to a host named password*, as OpenSSH does. Row 79: after a
// password login P9 offers its own key; a stand-in ssh-keygen beside the stand-in ssh makes it, and home/ plays the remote's home.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, root } from './helpers.mjs';

const skip = process.platform === 'win32' ? 'Unix sockets and sh' : false;
const PASSWORD = "c0rrect horse 'battery'";
const q = (s) => "'" + s + "'";

async function stage(remote) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'p9-sshpw-'));
  const server = path.join(directory, 'server'), local = path.join(directory, 'local'), log = path.join(directory, 'ssh.log'), profile = path.join(directory, 'profile'), home = path.join(directory, 'home');
  await mkdir(server); await mkdir(local, { mode: 0o700 }); await mkdir(profile); await mkdir(home);
  await symlink(remote.state, path.join(server, 'p9-foundation'));
  const ssh = path.join(directory, 'ssh');
  await writeFile(ssh, '#!/bin/sh\nFAKE_HOME=' + q(home) + ' FAKE_RUNTIME=' + q(server) + ' FAKE_SSH_LOG=' + q(log) + ' exec ' + q(process.execPath) + ' ' + q(path.join(root, 'test/fake-ssh.mjs')) + ' "$@"\n');
  await chmod(ssh, 0o755);
  await writeFile(path.join(directory, 'ssh-keygen'), '#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = -f ] && f="$2"; shift; done\n'
    + 'umask 077; echo PRIVATE > "$f"; echo "ssh-ed25519 AAAAFAKE$$ p9-event-horizon" > "$f.pub"\n', { mode: 0o755 });
  const calls = () => readFile(log, 'utf8').then((text) => text.trim().split('\n').map((line) => JSON.parse(line)), () => []);
  const master = path.join(local, 'p9-ssh-' + process.getuid(), 'password-host'); // fake-ssh's control master: %C is the host
  return { directory, local, profile, home, ssh, calls, master, keys: path.join(home, '.ssh', 'authorized_keys') };
}
async function launch(t, s, local, more = {}) {
  const env = { ...process.env, P9_SSH: s.ssh, XDG_RUNTIME_DIR: s.local, FAKE_PASSWORD: PASSWORD, ...more }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', local.state, '--user-data-dir=' + s.profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  return app.firstWindow();
}
const shot = async (page, name, locator = page) => { await page.waitForTimeout(400); console.log('P9_SHOT ' + name + ' ' + (await locator.screenshot({ type: 'png' })).toString('base64')); };
// Dark (the default) then light, with the same look the theme menu gives.
const both = async (page, name, locator) => {
  await shot(page, name + '-dark', locator);
  const was = await page.evaluate(() => { const h = document.documentElement, was = [h.className, h.dataset.theme ?? null]; h.classList.remove('dark'); h.dataset.theme = 'daylight'; return was; });
  await shot(page, name + '-light', locator);
  // Back exactly as it was (its own theme name included), or the next dark shot comes out black.
  await page.evaluate(([cls, theme]) => { const h = document.documentElement; h.className = cls; if (theme === null) delete h.dataset.theme; else h.dataset.theme = theme; }, was);
};
// Every file under a folder, read, to show the password is in none of them.
async function filesHolding(folder, text) {
  const found = [];
  for (const entry of await readdir(folder, { recursive: true, withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath ?? entry.path, entry.name);
    if ((await readFile(file).catch(() => Buffer.alloc(0))).includes(text)) found.push(file);
  }
  return found;
}
// Polled by hand: the window reloads once it is on the remote, which ends any wait running in the page.
const connected = async (page) => {
  for (const end = Date.now() + 30000; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 500))) {
    const r = await page.evaluate(() => window.p9.getStatus()).catch(() => null);
    if (r?.status === 'ok' && r.mode === 'server') return;
  }
  assert.fail('not connected in 30 s');
};

test('No ssh key: P9 asks for the password once in its own window, then connects; nothing keeps it', { skip, timeout: 120000 }, async (t) => {
  const local = await daemon(t), remote = await daemon(t), s = await stage(remote);
  await writeFile(path.join(s.profile, 'p9-server.json'), JSON.stringify({ host: 'password-host' }));
  const page = await launch(t, s, local);
  const dialog = page.locator('dialog#sshDlg[open]');
  await dialog.waitFor({ timeout: 30000 });
  assert.equal(await page.locator('#sshT').textContent(), 'Password for password-host');
  assert.equal(await page.locator('#sshL').textContent(), "tester@password-host's password");
  assert.equal(await page.locator('#sshErr').isVisible(), false);
  await both(page, 'ssh-password-window', page);
  await page.fill('#sshPw', PASSWORD);
  await page.click('#sshOk');
  await connected(page);
  const calls = await s.calls(), asks = calls.filter((c) => 'askpass' in c);
  assert.equal(asks.length, 1, 'asked once: ' + JSON.stringify(asks));
  assert.deepEqual(asks[0].leaked, [], 'the password is in no environment variable ssh saw');
  // After the login, the read and the tunnel rode it: key-only ssh, no second ask.
  const login = calls.findIndex((c) => c.argv.includes('BatchMode=no'));
  assert.ok(login >= 0 && calls.slice(login + 1).some((c) => c.argv.includes('-N') && c.argv.includes('BatchMode=yes')), JSON.stringify(calls.map((c) => c.argv)));
  assert.ok(calls.every((c) => !c.argv.some((a) => a.includes(PASSWORD))), 'never on a command line');
  assert.deepEqual(await filesHolding(s.directory, PASSWORD), [], 'in no file, the ssh log included');
});

test('No ssh key, wrong password: the window says it did not work, Cancel stops, Try again asks again; nothing keeps it', { skip, timeout: 120000 }, async (t) => {
  const local = await daemon(t), remote = await daemon(t), s = await stage(remote);
  await writeFile(path.join(s.profile, 'p9-server.json'), JSON.stringify({ host: 'password-host' }));
  const page = await launch(t, s, local);
  await page.locator('dialog#sshDlg[open]').waitFor({ timeout: 30000 });
  await page.fill('#sshPw', 'not it');
  await page.click('#sshOk');
  await page.locator('#sshErr').waitFor({ state: 'visible', timeout: 15000 });
  assert.equal(await page.locator('#sshErr').textContent(), 'That password did not work. Check it and try again.');
  assert.equal(await page.locator('#sshPw').inputValue(), '', 'the field starts empty again');
  await both(page, 'ssh-password-wrong', page);
  await page.click('#sshDlg button[value="cancel"]');
  await page.locator('#connRetry').waitFor({ state: 'visible', timeout: 15000 });
  assert.match(await page.locator('#connWhy').textContent(), /Connecting stopped before the password was typed/);
  const status = await page.evaluate(() => window.p9.getStatus());
  assert.equal(status.error, 'ssh-cancelled');
  assert.equal(status.sshAsk, undefined);
  assert.deepEqual(await filesHolding(s.directory, 'not it'), [], 'the wrong password is in no file, the ssh log included');
  // No timer asks again by itself; Try again does.
  await page.waitForTimeout(3000);
  assert.equal((await s.calls()).filter((c) => 'askpass' in c).length, 2);
  await page.click('#connRetry');
  await page.locator('dialog#sshDlg[open]').waitFor({ timeout: 30000 });
  assert.equal(await page.locator('#sshErr').isVisible(), false);
});

test('Setup wizard card 1: says what connecting offers, and connects to a new remote in the wizard, never through Settings', { skip, timeout: 120000 }, async (t) => {
  const fake = path.join(root, 'test/fake-acp-agent.mjs');
  const local = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] })), remote = await daemon(t), s = await stage(remote);
  const page = await launch(t, s, local);
  await page.locator('#rChat').waitFor({ timeout: 20000 });
  await page.locator('#cards [data-key="welcome"] .open').click();
  await page.locator('#welDlg[open]').waitFor({ timeout: 10000 });
  for (let back = 0; back < 4 && (await page.locator('#welT').textContent()) !== 'Welcome to Event Horizon'; back++) await page.locator('#welFoot [data-act="back"]').click();
  const card = await page.locator('#welBody').innerText();
  assert.match(card, /Work on a remote over ssh\?/);
  assert.match(card, /kept running, so your phone and this desktop reach it any time, or only while you are connected, the way VS Code Remote-SSH works/);
  assert.doesNotMatch(card, /server/i);
  assert.doesNotMatch(card, /Four checks|Mission Control/, 'c21 item 8: the starter-files check is gone');
  await both(page, 'ssh-wizard-card1', page.locator('#welDlg'));
  await page.locator('#welBody [data-act="remote"]').click();
  const field = page.locator('#welBody #welHost');
  await field.waitFor({ timeout: 10000 });
  assert.doesNotMatch(await page.locator('#welBody [data-wiz-remote]').innerText(), /Settings|without a password/);
  await field.fill('password-host');
  await both(page, 'ssh-wizard-connect', page.locator('#welDlg'));
  await field.fill('bad host');
  await page.locator('#welBody [data-act="connect"]').click();
  await page.locator('#welBody [role="alert"]', { hasText: 'Type a Host name or user@address' }).waitFor({ timeout: 5000 });
  await field.fill('password-host');
  await page.locator('#welBody [data-act="connect"]').click();
  // The window goes onto the remote, asks for the password, and connects; Settings never opened.
  await page.locator('dialog#sshDlg[open]').waitFor({ timeout: 30000 });
  await page.fill('#sshPw', PASSWORD);
  await page.click('#sshOk');
  await connected(page);
  assert.equal(await page.locator('#setDlg[open]').count(), 0, 'Settings never opened');
  // The window reloads onto the remote around now; read again until it has settled.
  let st; for (const end = Date.now() + 15000; !st && Date.now() < end;) st = await page.evaluate(() => window.p9.server()).catch(() => page.waitForTimeout(500));
  assert.deepEqual(st?.remotes, ['password-host'], 'the new remote is in Settings > Remote Connect\'s list');
});

const typePassword = async (page) => {
  await page.locator('dialog#sshDlg[open]').waitFor({ timeout: 30000 });
  await page.fill('#sshPw', PASSWORD);
  await page.click('#sshOk');
};
const asks = async (s) => (await s.calls()).filter((c) => 'askpass' in c).length;
// The window reloads onto the remote it is sent to, which ends the call's page; main has it by then.
const reconnect = (page) => page.evaluate(() => window.p9.server('password-host')).catch(() => {});

test('Key offer, Yes: P9 makes its key, adds one line to the remote, and connects with no password; a key the remote no longer has asks again and offers again', { skip, timeout: 120000 }, async (t) => {
  const local = await daemon(t), remote = await daemon(t), s = await stage(remote);
  await writeFile(path.join(s.profile, 'p9-server.json'), JSON.stringify({ host: 'password-host' }));
  const page = await launch(t, s, local);
  await typePassword(page);
  await page.locator('dialog#keyDlg[open]').waitFor({ timeout: 30000 });
  assert.equal(await page.locator('#keyT').textContent(), 'Connect to password-host without a password?');
  assert.equal(await page.locator('#keyYes').textContent(), 'Yes, add a key');
  await both(page, 'ssh-key-offer', page);
  await page.click('#keyYes');
  await page.locator('#keyMsg', { hasText: 'Done. P9 logs in to password-host with its own key from now on.' }).waitFor({ timeout: 30000 });
  assert.equal(await page.locator('#keyNever').isVisible(), false, 'Don\'t ask again goes once the key is added');
  await both(page, 'ssh-key-done', page);
  const lines = (await readFile(s.keys, 'utf8')).split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], (await readFile(path.join(s.profile, 'ssh', 'p9_ed25519.pub'), 'utf8')).trim());
  assert.equal((await stat(path.join(s.profile, 'ssh', 'p9_ed25519'))).mode & 0o777, 0o600);
  await page.click('#keyYes');
  await page.locator('dialog#keyDlg').waitFor({ state: 'hidden', timeout: 5000 });
  // The login gone (as after 10 idle minutes): the key alone connects, and nothing asks.
  await rm(s.master, { force: true });
  const before = await asks(s);
  await reconnect(page);
  await connected(page);
  assert.equal(await asks(s), before, 'no password asked');
  assert.equal(await page.locator('dialog#sshDlg[open], dialog#keyDlg[open]').count(), 0);
  // The remote dropped the key: the password window again, then the offer again. A second Yes adds one line, not two.
  await writeFile(s.keys, '');
  await rm(s.master, { force: true });
  await reconnect(page);
  await typePassword(page);
  await page.locator('dialog#keyDlg[open]').waitFor({ timeout: 30000 });
  await page.click('#keyYes');
  await page.locator('#keyMsg', { hasText: 'Done.' }).waitFor({ timeout: 30000 });
  assert.equal((await readFile(s.keys, 'utf8')).split('\n').filter(Boolean).length, 1);
});

test('Key offer, No with Don\'t ask again: nothing is made or added, the next password login offers nothing, and Settings > Remote offers it again', { skip, timeout: 120000 }, async (t) => {
  const local = await daemon(t), remote = await daemon(t), s = await stage(remote);
  await writeFile(path.join(s.profile, 'p9-server.json'), JSON.stringify({ host: 'password-host', remotes: ['password-host'] }));
  const page = await launch(t, s, local);
  await typePassword(page);
  await page.locator('dialog#keyDlg[open]').waitFor({ timeout: 30000 });
  assert.equal(await page.locator('#keyLater').textContent(), 'Settings > Remote Connect can offer it again.');
  await page.check('#keyNever');
  await page.click('#keyNo');
  await page.locator('dialog#keyDlg').waitFor({ state: 'hidden', timeout: 5000 });
  for (const end = Date.now() + 10000; Date.now() < end && !(await page.evaluate(() => window.p9.server())).noKey?.length;) await page.waitForTimeout(250);
  assert.deepEqual((await page.evaluate(() => window.p9.server())).noKey, ['password-host']);
  await assert.rejects(stat(path.join(s.profile, 'ssh', 'p9_ed25519')), 'no key made');
  await assert.rejects(stat(s.keys), 'nothing added to the remote');
  await rm(s.master, { force: true });
  await reconnect(page);
  await typePassword(page);
  await connected(page);
  await page.waitForTimeout(6000); // more than one status poll
  assert.equal(await page.locator('dialog#keyDlg[open]').count(), 0, 'not offered again');
  await page.click('#setBtn');
  const again = page.locator('#setDlg [data-key-again="password-host"]');
  await page.click('[data-set-page="Remote Connect"]');
  await again.waitFor({ timeout: 10000 });
  await shot(page, 'ssh-key-settings-dark', page.locator('#setRemote'));
  await again.click();
  for (const end = Date.now() + 10000; Date.now() < end && (await page.evaluate(() => window.p9.server())).noKey?.length;) await page.waitForTimeout(250);
  assert.deepEqual((await page.evaluate(() => window.p9.server())).noKey, []);
  await page.locator('#setDlg [data-key-again]').waitFor({ state: 'detached', timeout: 5000 });
});

test('A dropped connection to a password-only remote says it dropped and asks for the password again', { skip, timeout: 120000 }, async (t) => {
  const local = await daemon(t), remote = await daemon(t), s = await stage(remote);
  await writeFile(path.join(s.profile, 'p9-server.json'), JSON.stringify({ host: 'password-host', noKey: ['password-host'] }));
  const page = await launch(t, s, local);
  await typePassword(page);
  await connected(page);
  await page.waitForTimeout(6000); // the window has shown the remote (a status poll after connecting)
  const tunnel = (await s.calls()).filter((c) => c.argv.includes('-N')).pop();
  await rm(s.master, { force: true });
  process.kill(tunnel.pid);
  await page.locator('dialog#sshDlg[open]').waitFor({ timeout: 30000 });
  assert.equal(await page.locator('#sshP').textContent(), 'The connection to password-host dropped. No ssh key works for password-host, so ssh needs your password to connect again.');
  assert.equal(await page.locator('#connT').textContent(), 'Reconnecting to password-host');
  assert.match(await page.locator('#connWhy').textContent(), /dropped\. No ssh key works there/);
  await both(page, 'ssh-reconnect', page);
  await page.fill('#sshPw', PASSWORD);
  await page.click('#sshOk');
  await connected(page);
  await page.locator('dialog#connecting').waitFor({ state: 'hidden', timeout: 15000 });
});

test('A changed host key: P9 says so and will not connect, offers no password window and no yes, and names the known_hosts line', { skip, timeout: 90000 }, async (t) => {
  const local = await daemon(t), remote = await daemon(t), s = await stage(remote);
  await writeFile(path.join(s.profile, 'p9-server.json'), JSON.stringify({ host: 'changed-host', remotes: ['changed-host'] }));
  const page = await launch(t, s, local);
  const why = page.locator('#connWhy', { hasText: 'host key' });
  await why.waitFor({ timeout: 30000 });
  await page.waitForTimeout(8000); // more than one status poll and the first timed retry would have been
  const text = await why.textContent();
  assert.match(text, /changed-host/);
  assert.equal(await page.locator('#connT').textContent(), 'Not connecting to changed-host');
  assert.match(text, /will not connect/);
  assert.match(text, /\/tmp\/fake-home\/\.ssh\/known_hosts line 7/);
  assert.match(text, /ssh-keygen -R changed-host/);
  assert.equal(await page.locator('dialog#sshDlg[open]').count(), 0, 'no password window');
  const calls = await s.calls();
  assert.equal(calls.filter((c) => 'askpass' in c).length, 0, 'ssh never asked');
  assert.ok(!calls.some((c) => c.argv.includes('BatchMode=no')), 'no password login was started');
  assert.equal(calls.filter((c) => c.argv.at(-1)?.includes('desktop.json')).length, 1, 'no timed retry');
  assert.equal(await page.locator('#connRetry').isVisible(), true, 'Try again is the way back');
  await both(page, 'ssh-host-key-changed', page.locator('#connWhy').locator('xpath=ancestor::dialog[1]'));
});

// The 0.1.6 decision: Windows stays key-only in 0.1.6 (its OpenSSH has no control master, so no password window and no key
// offer); a remote that wants a password says it needs a key from this computer and how to add one.
test('sshFailure: what each ssh failure means, on Windows and elsewhere', { timeout: 10000 }, async () => {
  const { sshFailure } = await import('../apps/desktop/remote.mjs');
  const denied = 'tester@password-host: Permission denied (publickey,password).\n';
  assert.equal(sshFailure(denied, true).message, 'ssh-key-needed');
  assert.equal(sshFailure(denied, false).message, 'ssh-login-needed');
  assert.equal(sshFailure('Received disconnect from 192.0.2.1 port 22:2: Too many authentication failures\nNo more authentication methods to try.\n', true).message, 'ssh-key-needed');
  assert.equal(sshFailure('Host key verification failed.\n', true).message, 'server-unreachable', 'an unknown host key on Windows is not a missing key');
  assert.equal(sshFailure('ssh: connect to host password-host port 22: Connection refused\n', true).message, 'server-unreachable');
  const changed = sshFailure('@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nOffending ED25519 key in C:\\Users\\tester\\.ssh\\known_hosts:4\nHost key verification failed.\n', true);
  assert.equal(changed.message, 'ssh-host-key-changed');
  assert.deepEqual(changed.knownHosts, { file: 'C:\\Users\\tester\\.ssh\\known_hosts', line: 4 });
});

test('Windows: a remote with no key from this computer says how to add one; no password window, no key offer, no timed retry', { skip, timeout: 90000 }, async (t) => {
  const local = await daemon(t), remote = await daemon(t), s = await stage(remote);
  await writeFile(path.join(s.profile, 'p9-server.json'), JSON.stringify({ host: 'password-host', remotes: ['password-host'] }));
  // Windows' keys-only ssh (remote.mjs sshFailure) without the rest of main taking its Windows paths.
  const page = await launch(t, s, local, { P9_SSH_KEYS_ONLY: '1' });
  const why = page.locator('#connWhy', { hasText: 'ssh key' });
  await why.waitFor({ timeout: 30000 });
  await page.waitForTimeout(8000); // more than one status poll and the first timed retry would have been
  assert.equal(await page.locator('#connT').textContent(), 'Not connecting to password-host');
  assert.equal(await page.locator('#connSteps').isVisible(), true);
  const text = (await why.textContent()) + ' ' + (await page.locator('#connSteps').textContent());
  for (const said of ['password-host needs an ssh key from this computer', 'ssh-keygen -t ed25519', 'authorized_keys', 'ssh password-host', 'Try again']) assert.ok(text.includes(said), said);
  assert.equal(await page.locator('dialog#sshDlg[open]').count(), 0, 'no password window');
  assert.equal(await page.locator('dialog#keyDlg[open]').count(), 0, 'no key offer');
  const calls = await s.calls();
  assert.ok(!calls.some((c) => c.argv.includes('BatchMode=no') || 'askpass' in c), 'no password login was started');
  assert.equal(calls.filter((c) => c.argv.at(-1)?.includes('desktop.json')).length, 1, 'no timed retry');
  assert.equal(await page.locator('#connRetry').isVisible(), true, 'Try again is the way back');
  await both(page, 'ssh-windows-key-needed', page.locator('#connWhy').locator('xpath=ancestor::dialog[1]'));
});
