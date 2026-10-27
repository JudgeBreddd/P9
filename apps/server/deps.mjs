// Item 15 (v0.1.6 c13; threat model rows 60, 61): what P9 needs on this machine, at install and at every update.
// Bundle first: the Claude and Codex CLIs ship inside P9 already (the adapters' own packages), so "installing" one is a
// launcher in P9's own bin folder, which every terminal P9 opens has on its PATH. No download and no admin password.
// What P9 cannot carry is a system package; dependencies() names each missing one, why P9 needs it, and the one command
// that installs it, which needs the admin password. install.sh prints that list before it asks; the wizard shows it.
import { readFile, rename, stat, writeFile, mkdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { windowsStateRoot } from './windows.mjs';

export const AGENTS = ['claude', 'codex'];
// The words each adapter takes to hand its arguments to the CLI it ships (chat.mjs's sign-in uses the same).
const PASS = { claude: '--cli', codex: 'cli' };

// P9's bin folder: the user's own, never on a system path.
export const binFolder = (platform = process.platform, env = process.env, home = os.homedir()) =>
  platform === 'win32' ? path.join(windowsStateRoot(env, home), 'bin') : path.join(home, '.local', 'share', 'p9', 'bin');

const executable = (file) => stat(file).then((info) => info.isFile(), () => false);
const launcherName = (agent, platform) => platform === 'win32' ? agent + '.cmd' : agent;

// A launcher holds two absolute paths and nothing from a request: node and the adapter that ships the CLI.
function launcher(agent, node, entry, platform) {
  if (platform === 'win32') {
    // cmd.exe reads % and " in a .cmd line; a path holding one is refused rather than escaped.
    if (/["%\r\n]/.test(node + entry)) throw new Error('launcher-path-refused');
    return `@"${node}" "${entry}" ${PASS[agent]} %*\r\n`;
  }
  if (/[\r\n\x00]/.test(node + entry)) throw new Error('launcher-path-refused');
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  return `#!/bin/sh\n# Written by P9 (item 15): the ${agent} CLI that ships with P9. Rewritten at each start; delete it to remove.\nexec ${quote(node)} ${quote(entry)} ${PASS[agent]} "$@"\n`;
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
    const text = launcher(agent, node, entry(agent), platform);
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
const MANAGERS = [['apt', '/usr/bin/apt-get', 'sudo apt-get install -y'], ['dnf', '/usr/bin/dnf', 'sudo dnf install -y'],
  ['pacman', '/usr/bin/pacman', 'sudo pacman -S --noconfirm'], ['zypper', '/usr/bin/zypper', 'sudo zypper install -y']];
export async function packageManager(exists = (file) => access(file, constants.X_OK).then(() => true, () => false)) {
  for (const [name, file, command] of MANAGERS) if (await exists(file)) return { name, command };
  return null;
}

// Every dependency and where it stands: { id, ok, why, admin, command }. admin: installing it needs the admin password;
// command: the one line that does it (null with no known package manager, and for anything P9 itself carries).
export async function dependencies({ platform = process.platform, env = process.env, home = os.homedir(), manager } = {}) {
  const agents = await Promise.all(AGENTS.map(async (id) => ({ id, ok: await found(id, { platform, env, home }), admin: false, command: null,
    why: id === 'claude' ? 'Claude Code, for Claude chats and a terminal.' : 'Codex, for Codex chats and a terminal.' })));
  if (platform !== 'linux') return agents;
  manager ??= await packageManager();
  const system = await Promise.all(LINUX.map(async ({ id, program, why, packages }) => {
    const ok = await found(program, { platform, env, home });
    return { id, ok, why, admin: !ok, command: ok || !manager ? null : manager.command + ' ' + packages[manager.name] };
  }));
  return [...agents, ...system];
}

// The admin command for one dependency, for the wizard's "Run in a terminal": from the table above only.
export async function adminCommand(id) {
  const dependency = (await dependencies()).find((each) => each.id === id && each.admin);
  return dependency?.command ?? null;
}

