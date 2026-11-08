import { createHash } from 'node:crypto';
import { copyFile, stat, truncate } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function internalEndpoint(state, platform = process.platform, identity = { home: os.homedir(), user: os.userInfo().username }) {
  if (platform !== 'win32') return path.join(state, 'daemon.sock');
  // W3: the state folder is in the name too, so a dev daemon with its own state runs beside the daily one. Clients
  // read the name from the credentials the daemon writes into its state folder (socketPath).
  const owner = createHash('sha256').update(identity.home.toLowerCase() + '\0' + identity.user.toLowerCase() + '\0' + state.toLowerCase()).digest('hex').slice(0, 20);
  return `\\\\.\\pipe\\p9-foundation-${owner}`;
}

// O6 (here, not in update.mjs: teh.mjs needs it, and the bundled daemon ships this file but not update.mjs):
// a unit's state folder is its RuntimeDirectory (install-service.mjs), so the folder's name is the unit's: p9-foundation,
// or a dev daemon's p9-dev beside it. Any other folder (a hand-started daemon, a test's) is the daily unit.
// Windows (O6b): a dev task's state is %LOCALAPPDATA%\<unit>\runtime (install-windows.ps1 -Unit), beside the daily
// %LOCALAPPDATA%\P9\runtime, so there the parent folder names the unit.
export const unitOf = (state) => {
  const name = (p) => (/^p9-[a-z-]+$/.test(p) ? p : null), base = path.win32.basename(String(state));
  return name(base) || (base === 'runtime' && name(path.win32.basename(path.win32.dirname(String(state))))) || 'p9-foundation';
};
// O6b: the unit's Scheduled Task. The daily one keeps its name, so installs before 0.1.9 are the same task.
export const windowsTaskName = (unit) => (unit === 'p9-foundation' ? 'P9 Foundation' : 'P9 ' + unit);

export function windowsStateRoot(environment = process.env, home = os.homedir()) {
  return path.join(environment.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'P9');
}

// daemon.log on Windows (016 item 6), and Linux background mode's (sh's >>): the writer has it open for append only, so the daemon copies it to .1 and empties it
// in place while running; the next write lands at the new end. ponytail: a line written between the copy and the truncate is lost.
export const LOG_MAX = 5 * 1024 * 1024;
export async function trimLog(file, max = LOG_MAX) {
  if ((await stat(file).catch(() => null))?.size > max) { await copyFile(file, file + '.1'); await truncate(file, 0); return true; }
  return false;
}

export function windowsLockEndpoint(ownershipDirectory) {
  const owner = createHash('sha256').update(ownershipDirectory.toLowerCase()).digest('hex').slice(0, 20);
  return `\\\\.\\pipe\\p9-foundation-lock-${owner}`;
}

export function missingWindowsBinaries(installed, arch = 'x64') {
  // codex 0.159+ ships its Windows binary as a version of @openai/codex itself (`@openai+codex@0.159.3-win32-x64`)
  const codex = `@openai+codex-win32-${arch}@`;
  const alias = { [codex]: new RegExp(`^@openai\\+codex@[^@]*-win32-${arch}$`) };
  return [codex, `@anthropic-ai+claude-agent-sdk-win32-${arch}@`]
    .filter((prefix) => !installed.some((name) => name.startsWith(prefix) || alias[prefix]?.test(name)));
}
