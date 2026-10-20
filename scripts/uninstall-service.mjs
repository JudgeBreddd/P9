// Remove P9's per-user daemon unit (Linux). Only the named p9-* unit and its drop-ins are touched: other apps
// (agent-first-workspace, workspace-hub) and P9's state folder stay. The state holds chat history; delete it by hand.
// Usage: node scripts/uninstall-service.mjs [--unit p9-foundation.service] [--force]
import { existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { daemonRequest } from './teh.mjs';

const { values } = parseArgs({ options: { unit: { type: 'string', default: 'p9-foundation.service' }, force: { type: 'boolean', default: false } } });
if (!/^p9-[a-z0-9-]+\.service$/.test(values.unit)) throw new Error('p9-unit-required');
const directory = path.join(os.homedir(), '.config', 'systemd', 'user');
// Removing the installed daemon: Stop All first, so its chats, scripts and tmux terminals (their own units) do not
// outlive it. Only for the real unit, whose socket is the one below; never for another p9-* unit.
if (values.unit === 'p9-foundation.service' && process.env.XDG_RUNTIME_DIR) {
  const stopped = await daemonRequest(path.join(process.env.XDG_RUNTIME_DIR, 'p9-foundation'), 'POST', '/stop-all', {}).catch(() => null);
  console.log(stopped?.status === 200 ? 'P9_STOP_ALL_DONE'
    : "P9_STOP_ALL_SKIPPED: daemon not answering; check with systemctl --user list-units 'p9-*'");
  if (stopped?.status !== 200) process.exitCode = 1;
} else if (values.unit === 'p9-foundation.service') {
  console.log("P9_STOP_ALL_SKIPPED: XDG_RUNTIME_DIR unset; check with systemctl --user list-units 'p9-*'");
  process.exitCode = 1;
}
let stopped = process.exitCode !== 1;
try { execFileSync('systemctl', ['--user', 'disable', '--now', values.unit], { stdio: 'ignore' }); } catch { stopped = false; }
// Without the unit file nothing can stop what is still running, so a failed stop keeps it (release r1 R1-6).
if (!stopped && !values.force) {
  console.log('P9_SERVICE_KEPT ' + values.unit + ": stop failed; check systemctl --user list-units 'p9-*', then run again (--force removes it anyway)");
  process.exit(1);
}
rmSync(path.join(directory, values.unit), { force: true });
rmSync(path.join(directory, values.unit + '.d'), { recursive: true, force: true });
execFileSync('systemctl', ['--user', 'daemon-reload']);
const state = path.join(os.homedir(), '.local', 'state', 'p9-foundation');
console.log('P9_SERVICE_REMOVED ' + values.unit + (existsSync(state) ? '; state kept at ' + state : ''));
