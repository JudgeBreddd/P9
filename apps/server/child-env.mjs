// Every process P9 starts (agents, scripts, apps, later terminals) gets an environment built from empty plus this
// list, so a token in the daemon's own environment never reaches a child. Agents read their logins from HOME.
const ALLOW = new Set(['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'LANG', 'LANGUAGE', 'TZ', 'TERM', 'COLORTERM', 'TMPDIR', 'TMUX_TMPDIR',
  'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'USERNAME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'ProgramData',
  'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_DATA_DIRS', 'XDG_CONFIG_DIRS',
  'XDG_CURRENT_DESKTOP', 'XDG_SESSION_TYPE', 'DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS',
  // The POSIX and glibc locale categories, by name: a wildcard would also pass a made-up LC_SECRET_TOKEN.
  'LC_ALL', 'LC_CTYPE', 'LC_COLLATE', 'LC_MESSAGES', 'LC_MONETARY', 'LC_NUMERIC', 'LC_TIME', 'LC_ADDRESS',
  'LC_IDENTIFICATION', 'LC_MEASUREMENT', 'LC_NAME', 'LC_PAPER', 'LC_TELEPHONE']);

export const allowed = (key, platform = process.platform) => platform === 'win32'
  ? [...ALLOW].some((name) => name.toLowerCase() === key.toLowerCase())
  : ALLOW.has(key);

export function childEnv(source = process.env, platform = process.platform) {
  return Object.fromEntries(Object.entries(source).filter(([key]) => allowed(key, platform)));
}
