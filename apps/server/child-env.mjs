import { binFolder } from './deps.mjs';
// Every process P9 starts (agents, scripts, apps, later terminals) gets an environment built from empty plus this
// list, so a token in the daemon's own environment never reaches a child. Agents read their logins from HOME.
const ALLOW = new Set(['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'LANG', 'LANGUAGE', 'TZ', 'TERM', 'COLORTERM', 'TMPDIR', 'TMUX_TMPDIR',
  'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'USERNAME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'ProgramData',
  'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_DATA_DIRS', 'XDG_CONFIG_DIRS',
  'XDG_CURRENT_DESKTOP', 'XDG_SESSION_TYPE', 'DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS',
  // The POSIX and glibc locale categories, by name: a wildcard would also pass a made-up LC_SECRET_TOKEN.
  'LC_ALL', 'LC_CTYPE', 'LC_COLLATE', 'LC_MESSAGES', 'LC_MONETARY', 'LC_NUMERIC', 'LC_TIME', 'LC_ADDRESS',
  'LC_IDENTIFICATION', 'LC_MEASUREMENT', 'LC_NAME', 'LC_PAPER', 'LC_TELEPHONE']);

// PD-2: what the package-manager and download starts (server.mjs build, update.mjs update, setup-routes.mjs agents fetch)
// need on top: the owner's proxy and extra CA certificates, and where pnpm and corepack keep themselves. By name, never
// npm_config_*: that would pass npm_config__authToken. Registry logins stay in the home folder's .npmrc.
export const TOOL_NAMES = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'PNPM_HOME', 'COREPACK_HOME'];

export const allowed = (key, platform = process.platform, extra = []) => platform === 'win32'
  ? [...ALLOW, ...extra].some((name) => name.toLowerCase() === key.toLowerCase())
  : ALLOW.has(key) || extra.includes(key);

// extra: more names to pass when set (only TOOL_NAMES, from the three starts above).
export function childEnv(source = process.env, platform = process.platform, extra = []) {
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => allowed(key, platform, extra)));
  // A unit from before install-service recorded the installer's PATH starts with systemd's bare PATH after a reboot,
  // so tmux and agent CLIs in ~/.local/bin (systemd's user-binaries directory) went missing. Appended, so it never
  // shadows a system binary.
  // ponytail: only ~/.local/bin; a tool elsewhere (nvm, ~/.cargo/bin) still needs the unit's PATH line (UPGRADE.md).
  const local = env.HOME + '/.local/bin';
  if (platform === 'linux' && env.HOME && env.PATH !== undefined && !env.PATH.split(':').includes(local)) env.PATH += ':' + local;
  // Item 15: P9's own bin folder (the Claude and Codex launchers, deps.mjs), last, so a CLI the owner installed wins.
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH');
  const home = platform === 'win32' ? env.USERPROFILE : env.HOME;
  if (key && home && (platform === 'linux' || platform === 'win32')) {
    const bin = binFolder(platform, env, home), sep = platform === 'win32' ? ';' : ':';
    if (!env[key].split(sep).includes(bin)) env[key] += sep + bin;
  }
  return env;
}
