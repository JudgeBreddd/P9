import { mkdir, writeFile, stat } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { daemonRequest } from './teh.mjs';

const workspace = process.argv[2];
if (!workspace || !path.isAbsolute(workspace)) throw new Error('absolute-workspace-required');
if (!(await stat(workspace)).isDirectory()) throw new Error('workspace-must-be-a-directory');
if (!process.env.XDG_RUNTIME_DIR) throw new Error('XDG_RUNTIME_DIR-unset: run this from your own login session');
try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); }
catch { throw new Error('tmux-required'); }
const main = fileURLToPath(new URL('../apps/server/main.mjs', import.meta.url));
function quote(value) {
  if (/[\r\n\x00]/.test(value)) throw new Error('invalid-unit-argument');
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$') + '"';
}
// AU4: a daemon the AppImage copied to ~/.local/share/p9/daemon/<version> (teh.mjs stageDaemon) runs through the fixed
// launcher, which starts the version daemon/current names; a source checkout's runs as before.
const share = path.join(os.homedir(), '.local', 'share', 'p9');
const launcher = main.startsWith(path.join(share, 'daemon') + path.sep) ? quote(path.join(share, 'launcher', 'p9-launch.sh')) + ' ' : '';
const directory = path.join(os.homedir(), '.config', 'systemd', 'user');
const recovery = path.join(os.homedir(), '.local', 'state', 'p9-foundation', 'conflicts');
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, 'p9-foundation.service'), `[Unit]
Description=P9 foundation daemon
[Service]
Type=simple
RuntimeDirectory=p9-foundation
RuntimeDirectoryMode=0700
UMask=0077
# The installer's PATH, so the service finds the same tmux and agent CLIs it did (release r1 R1-10).
Environment=${quote('PATH=' + process.env.PATH)}
ExecStart=${launcher}${quote(process.execPath)} ${quote(main)} --workspace ${quote(workspace)} --state %t/p9-foundation --recovery ${quote(recovery)}
Restart=on-failure
RestartSec=2
NoNewPrivileges=yes
KillMode=process
[Install]
WantedBy=default.target
`, { flag: 'wx', mode: 0o600 });
async function answers() {
  // Up to 15 s for the first start (sqlite, tmux); a daemon that crashes keeps restarting and never answers.
  for (let tries = 0; tries < 30; tries += 1) {
    const health = await daemonRequest(path.join(process.env.XDG_RUNTIME_DIR, 'p9-foundation'), 'GET', '/health').catch(() => null);
    if (health?.status === 200) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('daemon-not-answering: see journalctl --user -u p9-foundation');
}
// daemon-reload is inside the cleanup too: a failed one must not leave the unit behind (release r2 R2-10).
try { execFileSync('systemctl', ['--user', 'daemon-reload']); execFileSync('systemctl', ['--user', 'enable', '--now', 'p9-foundation.service']); await answers(); }
catch (error) {
  // Leave nothing behind, so fixing the cause and running this again works.
  try { execFileSync('systemctl', ['--user', 'disable', '--now', 'p9-foundation.service'], { stdio: 'ignore' }); } catch {}
  rmSync(path.join(directory, 'p9-foundation.service'), { force: true });
  try { execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' }); } catch {}
  throw error;
}
console.log('P9_SERVICE_INSTALLED');
