// O259: a window started in remote mode before the remote answers stays the same page once it does. It used to reload
// itself on the first answer (shell-start.ts), so the empty shell, the connecting layer and a second full load showed in a
// row. Logs "P9_O259 <json>": what the window showed from launch to a usable chat, as segments with their start in seconds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, http, authenticated, root } from './helpers.mjs';

const skip = process.platform === 'win32' ? 'Unix sockets and sh' : false;
const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((result) => ({ status: result.status, ...JSON.parse(result.text) }));

test('O259: a window that opened before the remote answered is not reloaded when it does; its chat comes in place', { skip, timeout: 120000 }, async (t) => {
  const local = await daemon(t), remote = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', path.join(root, 'test/fake-acp-agent.mjs')] }));
  const id = (await call(remote, '/chat', 'POST', { provider: 'claude' })).conversation;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'p9-slow-start-'));
  const server = path.join(directory, 'server'), runtime = path.join(directory, 'local');
  await mkdir(server); await mkdir(runtime, { mode: 0o700 });
  await symlink(remote.state, path.join(server, 'p9-foundation'));
  // A slow remote: the tunnel (-L, not the -O cancel) takes 4 s to come up, as a slow ssh login does.
  const ssh = path.join(directory, 'ssh'), q = (s) => "'" + s + "'";
  await writeFile(ssh, '#!/bin/sh\ncase " $* " in *" -O "*) ;; *" -L "*) sleep 4;; esac\nFAKE_RUNTIME=' + q(server) + ' FAKE_SSH_LOG=' + q(path.join(directory, 'ssh.log'))
    + ' exec ' + q(process.execPath) + ' ' + q(path.join(root, 'test/fake-ssh.mjs')) + ' "$@"\n');
  await chmod(ssh, 0o755);
  const profile = path.join(directory, 'profile');
  await mkdir(profile);
  await writeFile(path.join(profile, 'p9-server.json'), JSON.stringify({ host: 'test-host' }));
  const env = { ...process.env, P9_SSH: ssh, XDG_RUNTIME_DIR: runtime }; delete env.ELECTRON_RUN_AS_NODE;
  const start = Date.now();
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', local.state, '--user-data-dir=' + profile], env, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  // What the window shows, every 100 ms: a page load in progress, the shell not wired yet, the connecting layer, the shell.
  const look = () => page.evaluate((id) => ({ origin: performance.timeOrigin, wired: performance.getEntriesByName('p9-shell-usable')[0]?.startTime,
    say: !document.querySelector('.shell') || document.querySelector('.shell[data-pending]') ? 'empty shell'
      : document.querySelector('dialog#connecting[open]') ? 'connecting layer'
      : document.querySelector('#nav .row[data-chat="' + id + '"]')?.checkVisibility() ? 'shell with the chat' : 'shell, no chats yet' }), id)
    .catch(() => ({ origin: null, say: 'page loading' }));
  // Each page load: when it started and when its shell was wired, in seconds from launch (from the page's own clock).
  const seen = [], origins = new Map(), sec = (ms) => Math.round(ms / 100) / 10;
  let usable = null;
  for (const end = Date.now() + 60000; !usable && Date.now() < end; await page.waitForTimeout(100)) {
    const l = await look(), at = Math.round((Date.now() - start) / 100) / 10;
    if (l.origin) origins.set(l.origin, { start: sec(l.origin - start), wired: l.wired === undefined ? null : sec(l.origin + l.wired - start) });
    if (seen.at(-1)?.say !== l.say) seen.push({ at, say: l.say });
    if (l.say === 'shell with the chat') {
      // Usable: the chat opens and takes typing.
      await page.locator('#nav .row[data-chat="' + id + '"]').click({ timeout: 5000 }).catch(() => {});
      const box = page.locator('.pane[data-id="' + id + '"] .composer textarea');
      if (await box.isVisible().catch(() => false)) { await box.fill('typed'); if (await box.inputValue() === 'typed') usable = Math.round((Date.now() - start) / 100) / 10; }
    }
  }
  // After the chat: what else the window holds once on the remote (cards, Mission Control, notes, toasts).
  await page.waitForTimeout(6000);
  const after = await page.evaluate(() => ({ cards: [...document.querySelectorAll('#cards .card')].map((c) => c.dataset.key),
    mission: document.querySelector('#fMission')?.innerText.replace(/\s+/g, ' ').slice(0, 160), note: document.querySelector('#dataNote')?.textContent,
    label: document.querySelector('#daemonStatus')?.textContent, toasts: [...document.querySelectorAll('.toast')].map((x) => x.textContent) })).catch((error) => ({ error: error.message }));
  console.log('P9_O259 ' + JSON.stringify({ usable, loads: [...origins.values()], seen, after }));
  assert.ok(usable, 'the chat was not usable within 60 s: ' + JSON.stringify(seen));
  assert.ok(seen.some((s) => s.say === 'connecting layer'), 'the window did not open before the remote answered: ' + JSON.stringify(seen));
  assert.equal(origins.size, 1, 'the window loaded ' + origins.size + ' times: ' + JSON.stringify(seen));
  assert.equal(after.label, 'Connected to test-host');
  assert.doesNotMatch(after.mission ?? '', /not answering/, 'Mission Control still waits for the remote');
  assert.deepEqual(after.toasts.filter((x) => /unavailable|not answering/i.test(x)), [], 'a toast from the wait stayed');
  console.log('PASS O259: one load from launch to a usable chat on a slow remote');
});
