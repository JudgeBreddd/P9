// Item 15 (v0.1.6 c13; threat model rows 60, 61): what P9 needs on this machine, at install and at every update.
// Bundle first: the Claude and Codex CLIs ship inside P9 already (the adapters' own packages), so "installing" one is a
// launcher in P9's own bin folder, which every terminal P9 opens has on its PATH. No download and no admin password.
// What P9 cannot carry is a system package; dependencies() names each missing one, why P9 needs it, and the one command
// that installs it, which needs the admin password. install.sh prints that list before it asks; the wizard shows it.
import { readFile, rename, stat, writeFile, mkdir, access } from 'node:fs/promises';
import { constants, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { windowsStateRoot } from './windows.mjs';

export const AGENTS = ['claude', 'codex'];
// What each launcher runs with node. Claude: the adapter, whose --cli hands everything else to the CLI it ships. Codex:
// the CLI the adapter ships, directly, resolved the way the adapter resolves it (from its real path, as node runs it:
// pnpm keeps @openai/codex beside the real folder, not under the node_modules link): codex-acp 2.1.1 answers --version
// anywhere in its arguments with its own name before it reads "cli", so through it "codex --version" (or a prompt
// holding those words) never reached Codex.
const PASS = { claude: ' --cli', codex: '' };
const cliEntry = (agent, adapter) => agent === 'codex' ? createRequire(realpathSync(adapter)).resolve('@openai/codex/bin/codex.js') : adapter;

// P9's bin folder: the user's own, never on a system path.
export const binFolder = (platform = process.platform, env = process.env, home = os.homedir()) =>
  platform === 'win32' ? path.join(windowsStateRoot(env, home), 'bin') : path.join(home, '.local', 'share', 'p9', 'bin');

const executable = (file) => stat(file).then((info) => info.isFile(), () => false);
const launcherName = (agent, platform) => platform === 'win32' ? agent + '.cmd' : agent;

// A launcher holds two absolute paths and nothing from a request: node and the CLI's entry (above).
function launcher(agent, node, entry, platform) {
  if (platform === 'win32') {
    // cmd.exe reads % and " in a .cmd line; a path holding one is refused rather than escaped.
    if (/["%\r\n]/.test(node + entry)) throw new Error('launcher-path-refused');
    return `@"${node}" "${entry}"${PASS[agent]} %*\r\n`;
  }
  if (/[\r\n\x00]/.test(node + entry)) throw new Error('launcher-path-refused');
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  return `#!/bin/sh\n# Written by P9 (item 15): the ${agent} CLI that ships with P9. Rewritten at each start; delete it to remove.\nexec ${quote(node)} ${quote(entry)}${PASS[agent]} "$@"\n`;
}

// Writes the launcher of each named agent (a temp file, then rename). refresh: only those already there, so a daemon start
// after an update points them at the new version and never adds one the owner did not pick. Returns the agents written.
export async function placeAgents(agents, { platform = process.platform, bin = binFolder(platform), node = process.execPath, entry, refresh = false } = {}) {
  // chat.mjs only when needed: scripts/deps.mjs (install.sh's check) runs before the daemon's modules are built.
  entry ??= (await import('./chat.mjs')).adapterEntry;
  if (!Array.isArray(agents) || !agents.every((agent) => AGENTS.includes(agent))) throw new Error('agents-refused');
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const written = [];
  for (const agent of agents) {
    const file = path.join(bin, launcherName(agent, platform));
    const text = launcher(agent, node, cliEntry(agent, entry(agent)), platform);
    if (refresh && !await executable(file)) continue;
    if (await readFile(file, 'utf8').catch(() => null) !== text) {
      await writeFile(file + '.tmp', text, { mode: 0o755 });
      await rename(file + '.tmp', file);
    }
    written.push(agent);
  }
  return written;
}

// A program on PATH, in ~/.local/bin (where Claude's own installer puts it) or in P9's bin folder.
export async function found(name, { platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const folders = [...(env.PATH ?? env.Path ?? '').split(path.delimiter), path.join(home, '.local', 'bin'), binFolder(platform, env, home)].filter(Boolean);
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.ps1'] : [''];
  for (const folder of folders) for (const ext of exts) if (await executable(path.join(folder, name + ext))) return true;
  return false;
}

// The system packages P9 uses, by what each package manager calls them. ssh: Server mode and Send to server only.
const LINUX = [
  { id: 'tmux', program: 'tmux', why: "P9's terminals run inside tmux, so a terminal keeps running when its window closes. Without it P9 cannot start.",
    packages: { apt: 'tmux', dnf: 'tmux', pacman: 'tmux', zypper: 'tmux' } },
  { id: 'ssh', program: 'ssh', why: 'Server mode and Send to server reach your other machine over SSH. The rest of P9 works without it.',
    packages: { apt: 'openssh-client', dnf: 'openssh-clients', pacman: 'openssh', zypper: 'openssh-clients' } },
];
// apt: a bare machine has no package lists until an update; ';' so one broken third-party list does not stop the install.
const MANAGERS = [['apt', '/usr/bin/apt-get', 'sudo apt-get update; sudo apt-get install -y'], ['dnf', '/usr/bin/dnf', 'sudo dnf install -y'],
  ['pacman', '/usr/bin/pacman', 'sudo pacman -S --noconfirm'], ['zypper', '/usr/bin/zypper', 'sudo zypper install -y']];
export async function packageManager(exists = (file) => access(file, constants.X_OK).then(() => true, () => false)) {
  for (const [name, file, command] of MANAGERS) if (await exists(file)) return { name, command };
  return null;
}

// Ubuntu 23.10 and newer stop unprivileged user namespaces for any program without an AppArmor profile, and Chromium's
// sandbox needs one, so the Electron in a clone aborts at start (bare-machine.sh, v0.1.6). The fix is a profile that
// allows userns for that one file, never --no-sandbox (README). Only for a clone: the AppImage mounts at a random
// /tmp/.mount_* path that no profile can name, and a daemon copied by the AppImage has no Electron.
// ponytail: one profile name, so a second clone on the same machine replaces the first one's profile.
export const PROFILE = '/etc/apparmor.d/p9-electron';
export const cloneElectron = (root = fileURLToPath(new URL('../../', import.meta.url))) =>
  path.join(root, 'node_modules', 'electron', 'dist', 'electron');
export function profileText(electron) {
  if (/["\\\r\n\x00]/.test(electron)) throw new Error('profile-path-refused');
  return 'abi <abi/4.0>,\ninclude <tunables/global>\n\n# Written by P9 (item 15): lets P9\'s Electron use its sandbox on Ubuntu 23.10 and newer.\n' +
    `profile p9-electron "${electron}" flags=(unconfined) {\n  userns,\n}\n`;
}
const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
export async function sandboxDependency({ electron = cloneElectron(), read = (file) => readFile(file, 'utf8') } = {}) {
  const restricted = (await read('/proc/sys/kernel/apparmor_restrict_unprivileged_userns').catch(() => '0')).trim() === '1';
  const text = profileText(electron);
  // A chrome-sandbox the owner made setuid root (Electron's other documented fix) needs no profile.
  const setuid = await stat(path.join(path.dirname(electron), 'chrome-sandbox')).then((info) => info.uid === 0 && (info.mode & 0o4000) !== 0, () => false);
  const ok = !restricted || setuid || await read(PROFILE).then((current) => current === text, () => false);
  return { id: 'sandbox', ok, admin: !ok,
    why: "Ubuntu stops P9's window from opening until AppArmor allows its sandbox. This adds a rule for P9's own Electron only.",
    command: ok ? null : `printf '%s' ${shellQuote(text)} | sudo tee ${PROFILE} >/dev/null && sudo apparmor_parser -r ${PROFILE}` };
}

// Every dependency and where it stands: { id, ok, why, admin, command }. admin: installing it needs the admin password;
// command: the one line that does it (null with no known package manager, and for anything P9 itself carries).
// desktop: also what the window needs (install.sh without --headless; by default, when this clone has an Electron).
export async function dependencies({ platform = process.platform, env = process.env, home = os.homedir(), manager, desktop, electron = cloneElectron() } = {}) {
  const agents = await Promise.all(AGENTS.map(async (id) => ({ id, ok: await found(id, { platform, env, home }), admin: false, command: null,
    why: id === 'claude' ? 'Claude Code, for Claude chats and a terminal.' : 'Codex, for Codex chats and a terminal.' })));
  if (platform !== 'linux') return agents;
  if (manager === undefined) manager = await packageManager(); // null: no known package manager, so no command
  const system = await Promise.all(LINUX.map(async ({ id, program, why, packages }) => {
    const ok = await found(program, { platform, env, home });
    return { id, ok, why, admin: !ok, package: manager && packages[manager.name], command: ok || !manager ? null : manager.command + ' ' + packages[manager.name] };
  }));
  desktop ??= await executable(electron);
  return [...agents, ...system, ...desktop ? [await sandboxDependency({ electron })] : []];
}

// What every update runs after its build (c15's /update, install.sh's update path): the agents the owner picked point
// at the new version, and the system packages still missing come back with their reasons and commands. It never runs
// sudo itself; the caller shows the reason first and asks.
export async function ensureDependencies(options = {}) {
  const placed = await placeAgents(AGENTS, { refresh: true });
  const missing = (await dependencies(options)).filter((dependency) => dependency.admin);
  return { placed, missing };
}

// What the wizard shows: the window's own sandbox is left out, since a window that opened has a working sandbox (P9 never
// runs Electron with --no-sandbox). install.sh and every update check it (scripts/deps.mjs, ensureDependencies).
export const wizardDependencies = (options = {}) => dependencies({ ...options, desktop: false });
// The admin command for one dependency, for the wizard's "Run in a terminal": from the table above only.
export async function adminCommand(id) {
  const dependency = (await wizardDependencies()).find((each) => each.id === id && each.admin);
  return dependency?.command ?? null;
}

