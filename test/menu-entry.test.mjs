// The Linux source install's menu entry: main.mjs names the window p9-event-horizon.desktop, and install.sh writes that
// entry (icon, Exec) so the menu and taskbar show P9's icon. A home and a checkout with a space and a quote (threat model row).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, execFileSync } from 'node:child_process';
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stage, bash } from './install-runtime.test.mjs';

const skip = process.platform !== 'linux';
const run = (file, args, env, cwd) => new Promise((resolve) => {
  const child = spawn(file, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { out += c; });
  child.once('close', (code) => resolve({ code, out }));
});
// The Exec value read the way the Desktop Entry spec says: the string escape first, then one quoted argument.
const execPath = (line) => {
  const value = line.replace(/\\(.)/g, (_, c) => (c === 's' ? ' ' : c === 'n' ? '\n' : c));
  assert.match(value, /^"(.*)"$/s, 'Exec is one quoted argument: ' + line);
  return value.slice(1, -1).replace(/\\(["`$\\])/g, '$1').replaceAll('%%', '%');
};

test('install.sh on a desktop writes the P9 menu entry (absolute icon, an Exec that runs); --headless does not; uninstall removes it', { skip, timeout: 60000 }, async () => {
  const s = await stage(true);
  delete s.env.DISPLAY; delete s.env.WAYLAND_DISPLAY; // the dev space has a screen of its own
  const pnpmLog = path.join(s.dir, 'pnpm.log');
  await writeFile(path.join(s.bin, 'pnpm'), '#!/bin/sh\necho "$PWD|$*" >> "' + pnpmLog + '"\n');
  await chmod(path.join(s.bin, 'pnpm'), 0o755);
  const apps = path.join(s.home, '.local', 'share', 'applications'), entry = path.join(apps, 'p9-event-horizon.desktop');
  const open = path.join(s.home, '.local', 'share', 'p9-event-horizon', 'open');

  // A headless install (a remote) writes none, even with a screen.
  const headless = await bash({ ...s, env: { ...s.env, XDG_RUNTIME_DIR: s.run, DISPLAY: ':0' } });
  assert.equal(headless.code, 0, headless.out);
  await assert.rejects(stat(entry), 'no menu entry on a headless install');
  // A desktop with no graphical session: none, and no error.
  const bare = await bash({ ...s, env: { ...s.env, XDG_RUNTIME_DIR: s.run } }, []);
  assert.equal(bare.code, 0, bare.out);
  await assert.rejects(stat(entry), 'no menu entry with no DISPLAY or WAYLAND_DISPLAY');

  const { code, out } = await bash({ ...s, env: { ...s.env, XDG_RUNTIME_DIR: s.run, WAYLAND_DISPLAY: 'wayland-0' } }, []);
  assert.equal(code, 0, out);
  const lines = (await readFile(entry, 'utf8')).split('\n');
  assert.equal(lines[0], '[Desktop Entry]');
  for (const want of ['Type=Application', 'Name=P9 Event Horizon', 'Terminal=false']) assert.ok(lines.includes(want), want + ' in\n' + lines.join('\n'));
  const icon = lines.find((l) => l.startsWith('Icon=')).slice(5);
  assert.equal(icon, path.join(s.checkout, 'apps', 'web', 'public', 'p9-icon.png'), 'the icon is the checkout\'s, by absolute path');
  const exec = execPath(lines.find((l) => l.startsWith('Exec=')).slice(5));
  assert.equal(exec, open);
  assert.equal((await stat(open)).mode & 0o777, 0o700);

  // What the menu runs: no PATH of its own (a desktop session's), the script finds pnpm and opens the checkout's desktop.
  const opened = await run(exec, [], { HOME: s.home, XDG_RUNTIME_DIR: s.run });
  assert.equal(opened.code, 0, opened.out);
  assert.equal((await readFile(pnpmLog, 'utf8')).trim().split('\n').pop(), s.checkout + '|desktop --state ' + s.run + '/p9-foundation');

  // Uninstall: Change the folder (--keep-menu) keeps it; the real uninstall removes the entry and the script.
  const env = { HOME: s.home, PATH: s.bin + ':' + process.env.PATH };
  const script = new URL('../scripts/uninstall-service.mjs', import.meta.url).pathname;
  await run(process.execPath, [script, '--force', '--keep-menu'], env);
  await stat(entry); await stat(open);
  const removed = await run(process.execPath, [script, '--force'], env);
  assert.match(removed.out, /P9_SERVICE_REMOVED/, removed.out);
  await assert.rejects(stat(entry), 'uninstall removes the menu entry');
  await assert.rejects(stat(path.dirname(open)), 'uninstall removes the open script');
  assert.equal(execFileSync('ls', [apps]).toString(), '');
});
