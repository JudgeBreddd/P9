// D7 (v0.1.6): the Chat Focus file editor in Server mode. Save goes through the ssh forward to the server's guarded PUT /files
// and lands on the server's disk; Ctrl+S saves the same way wherever the focus is in the editor window, and a failed save
// says so in words. Real Electron, a real daemon behind test/fake-ssh.mjs (as remote.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, root } from './helpers.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const skip = process.platform === 'win32' ? 'Unix sockets and sh' : false;

test('D7: Server mode Chat Focus editor: Save and Ctrl+S reach the server file; a failed save names the cause', { skip, timeout: 120000 }, async (t) => {
  const local = await daemon(t);
  const remote = await daemon(t, undefined, false, async (paths) => {
    const w = paths.workspace;
    for (const dir of ['_tyler', 'hub', 'proj']) await mkdir(path.join(w, dir), { recursive: true });
    await writeFile(path.join(w, 'hub/registry.json'), JSON.stringify({ scripts: [], apps: [], pages: [] }));
    await writeFile(path.join(w, 'AGENTS.md'), '# Projects\n\n**Main project: Proj** (`proj/`)\n');
    await writeFile(path.join(w, 'proj/notes.md'), 'on the server\n');
    await writeFile(path.join(paths.directory, 'settings.json'), JSON.stringify({ waiting: '_tyler', registry: 'hub/registry.json', primary: 'AGENTS.md' }));
    return { args: ['--acp-override', fake, '--settings', path.join(paths.directory, 'settings.json')] };
  });
  const directory = await mkdtemp(path.join(os.tmpdir(), 'p9-server-save-'));
  const server = path.join(directory, 'server'), runtime = path.join(directory, 'local'), log = path.join(directory, 'ssh.log');
  await mkdir(server); await mkdir(runtime, { mode: 0o700 });
  await symlink(remote.state, path.join(server, 'p9-foundation'));
  const ssh = path.join(directory, 'ssh'), q = s => "'" + s + "'";
  await writeFile(ssh, '#!/bin/sh\nFAKE_RUNTIME=' + q(server) + ' FAKE_SSH_LOG=' + q(log) + ' exec ' + q(process.execPath) + ' ' + q(path.join(root, 'test/fake-ssh.mjs')) + ' "$@"\n');
  await chmod(ssh, 0o755);
  const profile = path.join(directory, 'profile'); await mkdir(profile);
  await writeFile(path.join(profile, 'p9-server.json'), JSON.stringify({ host: 'test-host' }));
  const env = { ...process.env, P9_SSH: ssh, XDG_RUNTIME_DIR: runtime }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', local.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1300, height: 860 }).catch(() => {});
  await page.locator('#serverBadge', { hasText: 'test-host' }).waitFor({ timeout: 20000 });
  const disk = () => readFile(path.join(remote.workspace, 'proj/notes.md'), 'utf8');
  await page.click('#rFiles');
  await page.locator('#tree [data-lfile="proj/notes.md"]').click({ timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('#mdlBody textarea')?.value === 'on the server\n', null, { timeout: 8000 });

  // 1. Save writes the server's file.
  await page.locator('#mdlBody textarea').fill('saved from the laptop\n');
  await page.locator('#mdlFoot [data-savefile]').click();
  await page.locator('#mdlFoot', { hasText: 'saved' }).waitFor({ timeout: 8000 });
  assert.equal(await disk(), 'saved from the laptop\n', 'Save reached the server');

  // 2. Ctrl+S after the Save button took the focus (the modal re-rendered): it still saves.
  await page.locator('#mdlBody textarea').fill('second, by Ctrl+S\n');
  await page.locator('#mdlT').click();
  await page.keyboard.press('Control+s');
  await page.locator('#mdlFoot', { hasText: 'saved' }).waitFor({ timeout: 8000 });
  assert.equal(await disk(), 'second, by Ctrl+S\n', 'Ctrl+S reached the server with the focus outside the text');

  // 3. A refused save names the cause in words, not a bare status, and the text stays.
  await chmod(path.join(remote.workspace, 'proj'), 0o500);
  t.after(() => chmod(path.join(remote.workspace, 'proj'), 0o700).catch(() => {}));
  await page.locator('#mdlBody textarea').fill('cannot land\n');
  await page.keyboard.press('Control+s');
  const toast = page.locator('#toasts .toast', { hasText: 'Could not save' }).first();
  await toast.waitFor({ timeout: 8000 });
  await toast.evaluate((el) => Promise.all(el.getAnimations().filter((a) => a.animationName === 'pop').map((a) => a.finished)));
  console.log('P9_SHOT d7-save-refused ' + (await page.screenshot()).toString('base64'));
  assert.match(await toast.innerText(), /no permission to write it \(EACCES\)/, 'the reason in words, then the code');
  assert.equal(await toast.locator('.truncate').evaluate((el) => el.scrollWidth <= el.clientWidth), true, 'the reason is not cut off');
  // The toast list is a popover so it draws above the open editor (a modal sits in the top layer, over any z-index); the
  // modal makes it inert, so hit testing cannot see it: the screenshot shows it.
  assert.equal(await page.locator('#toasts').evaluate((el) => el.matches(':popover-open')), true, 'the toast shows above the open editor');
  assert.equal(await page.locator('#mdlBody textarea').inputValue(), 'cannot land\n', 'the text is still here');
});
