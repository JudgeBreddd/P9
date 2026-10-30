import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { childEnv } from './child-env.mjs';

const run = promisify(execFile);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// In the packaged app the desktop's copy of this module is in app.asar, which PowerShell cannot read; it uses the
// daemon's copy of the script, resources/daemon/scripts (release r2 R2-1). A no-op for the daemon and for source runs.
export const hostScript = (url) => fileURLToPath(new URL('../../scripts/windows-host.ps1', url)).replace(/app\.asar(?=[\\/])/, 'daemon');
const host = hostScript(import.meta.url);

export const hasUserBus = () => process.platform === 'linux' && !!process.env.XDG_RUNTIME_DIR
  && existsSync(path.join(process.env.XDG_RUNTIME_DIR, 'bus'));

const lookup = (environment, name) => Object.entries(environment).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];

export function resolveWindowsExecutable(executable, environment = process.env, fileExists = existsSync) {
  if (path.win32.isAbsolute(executable) || /[\\/]/.test(executable)) return executable;
  const pathValue = lookup(environment, 'path') ?? '';
  const suppliedExtension = path.win32.extname(executable).toLowerCase();
  if (suppliedExtension && !['.exe', '.com', '.cmd', '.bat'].includes(suppliedExtension)) throw new Error(`command-not-found:${executable}`);
  const extensions = suppliedExtension ? [''] : ['.exe', '.com', '.cmd', '.bat'];
  for (const directory of pathValue.split(';').filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.win32.resolve(directory, executable + extension);
      if (fileExists(candidate)) return candidate;
    }
  }
  throw new Error(`command-not-found:${executable}`);
}

// A .cmd or .bat (npm, pnpm) runs only through cmd.exe, which parses its line again (D3). Every part goes inside double
// quotes, where & | < > ^ are plain text, and a part holding a quote, % or a line break is refused, so nothing in it can
// end the quoting or expand a variable. verbatim: the caller passes the line unchanged (Node's windowsVerbatimArguments).
export function windowsArgv(argv, environment = process.env, fileExists = existsSync) {
  const executable = resolveWindowsExecutable(argv[0], environment, fileExists);
  if (!/\.(cmd|bat)$/i.test(executable)) return { argv: [executable, ...argv.slice(1)], verbatim: false };
  const parts = [executable, ...argv.slice(1)];
  if (parts.some((part) => /["%\r\n\0]/.test(part))) throw new Error(`unsafe-batch-argument:${path.win32.basename(executable)}`);
  const cmd = path.win32.join(lookup(environment, 'SystemRoot') || 'C:\\Windows', 'System32', 'cmd.exe');
  return { argv: [cmd, '/d', '/s', '/v:off', '/c', '"' + parts.map((part) => `"${part}"`).join(' ') + '"'], verbatim: true };
}

// mode Job: the host waits on the child inside a kill-on-close Job Object (detach: what the child starts leaves it, W1).
// Console: it starts the child in a new console window and exits at once (a registry terminal button on Windows, D1).
// Launch: the same with no window, for an app or a page (W2). Both start the child outside the daemon's job.
export function windowsJobCommand(argv, environment = childEnv(), mode = 'Job', detach = false) {
  const { argv: resolved, verbatim } = windowsArgv(argv, environment);
  const payload = Buffer.from(JSON.stringify({ argv: resolved, env: environment, ...(verbatim ? { verbatim } : {}), ...(detach ? { detach } : {}) })).toString('base64');
  return ['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', host, '-Mode', mode, '-Payload', payload];
}

// Windows owns the process tree through a Job Object. Linux chat uses a systemd scope; other launches use a process group.
export function launchTree(argv, cwd, { instance = 'run', prefix = 'p9-chat', scope = false, stdio = 'pipe', detach = false } = {}) {
  let full = argv, unit = null, job = false, detached = true;
  if (process.platform === 'win32') {
    const environment = childEnv();
    full = windowsJobCommand(argv, environment, 'Job', detach);
    job = true;
    detached = false;
  } else if (scope && hasUserBus()) {
    unit = `${prefix}-${instance}-${randomUUID()}`;
    // ponytail: each chat is capped at 4 GiB; raise MemoryMax if a real session ever needs more.
    full = ['systemd-run', '--user', '--scope', '--quiet', '--collect', '--slice=p9.slice', '--unit', unit, '-p', 'MemoryMax=4G',
      '-p', 'TimeoutStopSec=2', '--', ...argv];
  }
  const child = spawn(full[0], full.slice(1), { cwd, env: childEnv(), shell: false, detached, stdio });
  return { child, unit, job };
}

// A failed query counts as active, so Stop never reports success it could not confirm.
async function scopeActive(unit) {
  try { return ['active', 'activating', 'deactivating', 'reloading'].includes((await run('systemctl', ['--user', 'is-active', unit + '.scope'], { env: childEnv(), timeout: 1000 })).stdout.trim()); }
  catch (error) {
    const state = String(error.stdout ?? '').trim();
    return !['inactive', 'failed', 'unknown'].includes(state);
  }
}

export async function stopScopes(prefix, instance, owned = new Set()) {
  // launchTree cannot create a scope without the bus either; Phase 9's gate separately requires the real bus.
  if (!hasUserBus()) return 'stopped';
  const active = async () => {
    try {
      const { stdout } = await run('systemctl', ['--user', 'list-units', '--plain', '--no-legend',
        '--state=active,activating,deactivating,reloading', `${prefix}-${instance}-*.scope`], { env: childEnv(), timeout: 1000 });
      return stdout.split('\n').map((line) => line.trim().split(/\s+/)[0]).filter((unit) => unit && !owned.has(unit));
    } catch { return null; }
  };
  let left = await active();
  if (left?.length) {
    await run('systemctl', ['--user', 'stop', ...left], { env: childEnv(), timeout: 2000 }).catch(() => {});
    for (let i = 0; i < 20 && (left = await active())?.length; i++) await wait(50);
  }
  return left?.length === 0 ? 'stopped' : 'cleanup-failed';
}

export async function endTree({ child, unit, job }) {
  if (unit) {
    await run('systemctl', ['--user', 'stop', unit + '.scope'], { env: childEnv(), timeout: 1000 }).catch(() => {});
    for (let i = 0; i < 20 && await scopeActive(unit); i++) await wait(50);
    return (await scopeActive(unit)) ? 'cleanup-failed' : 'stopped';
  }
  if (job) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    for (let i = 0; i < 40 && child.exitCode === null && child.signalCode === null; i++) await wait(25);
    // The PowerShell owner holds the only job handle. Its confirmed exit closes the handle and Windows kills the job.
    return child.exitCode !== null || child.signalCode !== null ? 'stopped' : 'cleanup-failed';
  }
  const alive = () => { try { process.kill(-child.pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    try { process.kill(-child.pid, signal); } catch { /* already gone */ }
    for (let i = 0; i < 20 && alive(); i++) await wait(25);
  }
  return alive() ? 'cleanup-failed' : 'stopped';
}
