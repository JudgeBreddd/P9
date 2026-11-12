// Settings > Remote Connect > Open P9 on (0.1.8): where P9 opens the next time it starts. Real Electron, two real daemons and
// the stand-in ssh of remote.test.mjs (test/fake-ssh.mjs: a host named unreachable* cannot be reached).
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, root } from './helpers.mjs';

const skip = process.platform === 'win32' ? 'Unix sockets and sh; Windows OpenSSH is checked on a Windows desktop' : false;
// As remote.test.mjs: server is this side's view of the server's runtime folder, local this machine's, ssh the stand-in.
async function stage(instance) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'p9-open-on-'));
  const server = path.join(directory, 'server'), local = path.join(directory, 'local'), log = path.join(directory, 'ssh.log');
  await mkdir(server); await mkdir(local, { mode: 0o700 });
  await symlink(instance.state, path.join(server, 'p9-foundation'));
  const ssh = path.join(directory, 'ssh'), q = (s) => "'" + s + "'";
  await writeFile(ssh, '#!/bin/sh\nFAKE_RUNTIME=' + q(server) + ' FAKE_SSH_LOG=' + q(log) + ' exec ' + q(process.execPath) + ' ' + q(path.join(root, 'test/fake-ssh.mjs')) + ' "$@"\n');
  await chmod(ssh, 0o755);
  return { directory, server, local, ssh };
}

test('Open P9 on: Where it was last (as before), This computer or a remote; kept in p9-server.json for the next start; an unreachable remote keeps connecting as Connect does', { skip, timeout: 240000 }, async (t) => {
  const local = await daemon(t), remote = await daemon(t), s = await stage(remote);
  const profile = path.join(s.directory, 'profile'), file = path.join(profile, 'p9-server.json');
  await mkdir(profile);
  await writeFile(file, JSON.stringify({ host: null, last: 'test-host', remotes: ['test-host'] }));
  const env = { ...process.env, P9_SSH: s.ssh, XDG_RUNTIME_DIR: s.local }; delete env.ELECTRON_RUN_AS_NODE;
  const launch = async () => {
    const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', local.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
    const proc = app.process();
    t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
    const page = await app.firstWindow();
    await page.locator('#rChat').waitFor();
    const status = async (check, what) => {
      let last;
      for (const end = Date.now() + 25000; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 250))) {
        last = await page.evaluate(() => window.p9.getStatus()).catch((error) => ({ error: error.message }));
        if (check(last)) return last;
      }
      assert.fail(what + '; status: ' + JSON.stringify(last));
    };
    return { app, page, status };
  };
  const saved = async () => JSON.parse(await readFile(file, 'utf8'));
  const savedOpenOn = async (want) => { for (const end = Date.now() + 5000; JSON.stringify((await saved()).openOn) !== JSON.stringify(want) && Date.now() < end;) await new Promise((resolve) => setTimeout(resolve, 100)); return (await saved()).openOn; };
  const openOn = async (page) => { await page.click('#setBtn'); await page.locator('#setDlg[open]').waitFor(); await page.click('[data-set-page="Remote Connect"]'); const pick = page.locator('#setOpenOn'); await pick.waitFor(); return pick; };
  const closeSettings = async (page) => { await page.keyboard.press('Escape'); await page.locator('#setDlg').waitFor({ state: 'hidden', timeout: 5000 }); };
  const onLocal = (st) => st.status === 'ok' && st.mode !== 'server';
  // Nothing chosen: this computer, as saved (today's behaviour). The row offers the three kinds of place.
  let { app, page, status } = await launch();
  await status(onLocal, 'opened on this computer, as saved');
  let pick = await openOn(page);
  assert.deepEqual([await pick.inputValue(), await pick.locator('option').allInnerTexts()], ['last', ['Where it was last', 'This computer', 'test-host']]);
  await pick.selectOption('test-host');
  assert.equal(await savedOpenOn('test-host'), 'test-host');
  assert.equal((await saved()).host, null, 'this window stays where it is until the next start');
  // Phase 2 review: saves that overlap. Every read during them is whole JSON, and the last one sent is the one kept.
  let reading = true, reads = 0;
  const reader = (async () => { while (reading) { JSON.parse(await readFile(file, 'utf8')); reads += 1; } })();
  await page.evaluate(() => Promise.all(Array.from({ length: 200 }, (_, i) => window.p9.remotes('open-on', i % 2 ? '' : 'test-host'))));
  await page.evaluate(() => window.p9.remotes('open-on', 'test-host'));
  reading = false; await reader;
  assert.ok(reads > 0, 'the file was read while the saves ran');
  assert.equal((await saved()).openOn, 'test-host', 'the last save is the one kept');
  await closeSettings(page);
  await status(onLocal, 'still on this computer');
  await app.close();
  // Next start: on test-host.
  ({ app, page, status } = await launch());
  await status((st) => st.mode === 'server' && st.host === 'test-host' && st.status === 'ok', 'opened on test-host');
  await page.locator('#serverBadge', { hasText: 'Remote · test-host' }).waitFor();
  pick = await openOn(page);
  assert.equal(await pick.inputValue(), 'test-host');
  // This computer: the next start is local although the remote is the host saved now.
  await pick.selectOption('local');
  assert.equal(await savedOpenOn(''), '');
  assert.equal((await saved()).host, 'test-host');
  await closeSettings(page);
  await app.close();
  ({ app, page, status } = await launch());
  await status(onLocal, 'opened on this computer');
  pick = await openOn(page);
  assert.equal(await pick.inputValue(), 'local');
  // Where it was last: the choice goes, and Connect's remote is where P9 opens next, as before 0.1.8.
  await pick.selectOption('last');
  assert.equal(await savedOpenOn(undefined), undefined);
  await page.click('#setRemote [data-remote-go="test-host"]'); // main reloads the window onto the remote
  await page.locator('#rChat').waitFor({ timeout: 20000 });
  await status((st) => st.mode === 'server' && st.host === 'test-host' && st.status === 'ok', 'connected to test-host');
  await app.close();
  assert.equal((await saved()).host, 'test-host');
  ({ app, page, status } = await launch());
  await status((st) => st.mode === 'server' && st.host === 'test-host' && st.status === 'ok', 'opened where it was last');
  await app.close();
  // A chosen remote that cannot be reached: P9 opens connecting to it, as Connect does, and keeps trying.
  await writeFile(file, JSON.stringify({ host: null, last: 'test-host', remotes: ['test-host', 'unreachable-box'], openOn: 'unreachable-box' }));
  ({ app, page, status } = await launch());
  const st = await status((x) => x.mode === 'server' && x.host === 'unreachable-box' && x.status !== 'ok', 'connecting to the unreachable remote');
  assert.equal(st.status, 'unavailable');
  assert.equal((await saved()).openOn, 'unreachable-box', 'the choice stays for the next start');
  console.log('PASS Open P9 on: last / this computer / a remote kept and read at the next start; an unreachable remote shows connecting');
});
