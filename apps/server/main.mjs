import { mkdir, open, lstat, chmod, unlink, readdir, realpath, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createListener } from './server.mjs';
import { openLedger } from './ledger.mjs';
import { createAnymouse } from './anymouse.mjs';
import { createHash } from 'node:crypto';
import { parseSettings } from './mission.mjs';
import { drainSaves } from '../../packages/files/index.mjs';
import { childEnv } from './child-env.mjs';
import { AGENTS, placeAgents } from './deps.mjs';
import { internalEndpoint, windowsLockEndpoint, windowsStateRoot } from './windows.mjs';
import { keepOldPhotos } from './chat.mjs';
import { createClaudeUsage, openQuery } from './claude-usage.mjs';

const windowsHost = fileURLToPath(new URL('../../scripts/windows-host.ps1', import.meta.url));

const { values } = parseArgs({ options: { workspace: { type: 'string' }, state: { type: 'string' }, recovery: { type: 'string' }, settings: { type: 'string' }, 'acp-override': { type: 'string' }, 'usage-sdk': { type: 'string' }, 'tmux-socket': { type: 'string' }, 'terminal-platform': { type: 'string' },
  'remote-port': { type: 'string' }, 'remote-origin': { type: 'string' }, ownership: { type: 'string' },
  // The checkout a server update rebuilds, and where a packaged app's version is downloaded from (update.mjs); tests point them elsewhere.
  'update-root': { type: 'string' }, 'update-archive': { type: 'string' }, 'update-turn-ms': { type: 'string' } } });
if (['workspace', 'state', 'recovery'].some((key) => !values[key] || !path.isAbsolute(values[key]))) {
  throw new Error('absolute-workspace-state-and-recovery-required');
}
process.umask(0o077);
const windows = process.platform === 'win32';
// A saved folder that is not there at start (an unplugged drive, a locked or offline share, a deleted folder) does not stop
// the daemon: this run uses the installer's default folder, /health names both, and the next start tries the saved folder
// again, which the task or unit still holds (Fable review finding 1; before, Windows replaced it for good and Linux crash-looped).
const saved = path.resolve(values.workspace);
let workspace = await realpath(saved).then(async (real) => (await lstat(real)).isDirectory() ? real : null).catch(() => null);
let savedWorkspace;
if (!workspace) {
  const fallback = path.join(os.homedir(), windows ? 'P9' : 'work');
  await mkdir(fallback, { recursive: true });
  workspace = await realpath(fallback);
  if (workspace !== saved) savedWorkspace = saved;
}
function inside(parent, child) {
  const relative = path.relative(parent, child);
  return !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
async function canonicalDestination(directory) {
  try { return await realpath(directory); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return path.join(await canonicalDestination(path.dirname(directory)), path.basename(directory));
  }
}
for (const directory of [values.state, values.recovery]) {
  if (inside(workspace, await canonicalDestination(directory))) throw new Error('private-directory-inside-workspace');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || (!windows && (stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700))
      || inside(workspace, await realpath(directory))) throw new Error('unsafe-private-directory');
}
const state = await realpath(values.state), recovery = await realpath(values.recovery);
if (inside(state, recovery) || inside(recovery, state)) throw new Error('state-and-recovery-must-be-separate');
const socketPath = internalEndpoint(state);
// ponytail: --ownership gives a second Linux daemon (the dev build's p9-dev unit) its own ledger, lock and tmux socket;
// only a unit's ExecStart passes it. Without it, the one folder every install uses.
if (values.ownership !== undefined && !path.isAbsolute(values.ownership)) throw new Error('absolute-ownership-required');
const ownershipDirectory = windows ? windowsStateRoot() : values.ownership ?? path.join(os.homedir(), '.local', 'state', 'p9-foundation');
if (inside(workspace, await canonicalDestination(ownershipDirectory))) throw new Error('private-directory-inside-workspace');
await mkdir(ownershipDirectory, { recursive: true, mode: 0o700 });
const ownershipStat = await lstat(ownershipDirectory);
if (!ownershipStat.isDirectory() || inside(workspace, await realpath(ownershipDirectory))
    || (!windows && (ownershipStat.uid !== process.getuid() || (ownershipStat.mode & 0o777) !== 0o700))) throw new Error('unsafe-ownership-directory');
// Windows has no mode bits: the three folders' ACLs may grant only this user, SYSTEM and Administrators (B8). The
// installer makes %LOCALAPPDATA%\P9 owner-only; a source run's folders inherit the profile's ACL, which holds those three.
if (windows) {
  const folders = Buffer.from([state, recovery, ownershipDirectory].join('\n')).toString('base64');
  const acl = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', windowsHost, '-Mode', 'Acl', '-Payload', folders], { encoding: 'utf8', env: childEnv() });
  if (acl.status !== 0) {
    throw new Error(String(acl.stdout).split(/\r?\n/).includes(ownershipDirectory) ? 'unsafe-ownership-directory' : 'unsafe-private-directory');
  }
}
let workspaceLock;
if (windows) {
  workspaceLock = createNetServer();
  await new Promise((resolve, reject) => {
    workspaceLock.once('error', (error) => reject(new Error(error.code === 'EADDRINUSE' ? 'daemon-already-running' : 'workspace-lock-unavailable')));
    workspaceLock.listen(windowsLockEndpoint(ownershipDirectory), resolve);
  });
} else {
  workspaceLock = await open(path.join(ownershipDirectory, 'daemon.lock'),
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  const lockStat = await workspaceLock.stat();
  if (!lockStat.isFile() || lockStat.nlink !== 1 || lockStat.uid !== process.getuid()
      || (lockStat.mode & 0o777) !== 0o600) throw new Error('unsafe-ownership-file');
  // The daemon retains this open description; process exit releases its kernel lock.
  const ownership = spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', '3'],
    { stdio: ['ignore', 'ignore', 'ignore', workspaceLock.fd], env: childEnv() });
  if (ownership.status !== 0) {
    await workspaceLock.close();
    throw new Error(ownership.status === 1 ? 'daemon-already-running' : 'workspace-lock-unavailable');
  }
}
await keepOldPhotos(state, ownershipDirectory);
const stateEntries = await readdir(state);
if (windows) {
  if (stateEntries.some((name) => name !== 'desktop.json')) throw new Error('state-directory-not-empty');
  await unlink(path.join(state, 'desktop.json')).catch((error) => { if (error.code !== 'ENOENT') throw error; });
} else {
  const socketName = path.basename(socketPath);
  // editor.sock: Server mode's Dev Focus editor (server.mjs /dev/editor), left by a daemon that died; the next start replaces it.
  if (stateEntries.some((name) => !['desktop.json', socketName, 'editor.sock'].includes(name))) throw new Error('state-directory-not-empty');
  await unlink(path.join(state, 'desktop.json')).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  await unlink(socketPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
}
// Mission Control's ICM paths (workspace-relative); without the file the Mission routes answer settings-missing.
const settingsFile = values.settings ?? (windows ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'P9', 'settings.json')
  : path.join(os.homedir(), '.config', 'p9', 'settings.json'));
if (!path.isAbsolute(settingsFile)) throw new Error('absolute-settings-required');
let settings, settingsInvalid = false;
try { settings = parseSettings(await readFile(settingsFile, 'utf8')); }
// A broken file turns off Mission Control only; Chat, terminals and the phone stay up (release r1 R1-3).
catch (error) { if (error.code !== 'ENOENT') { settingsInvalid = true; console.error('P9_SETTINGS_INVALID ' + settingsFile + ': ' + String(error.message).slice(0, 200)); } }
const credentials = { cookie: randomBytes(32).toString('hex'), csrf: randomBytes(32).toString('hex'), socketPath };
// Chat history and operation IDs outlive the daemon: they live in the 0700 ownership directory, not the state directory.
const ledger = openLedger(path.join(ownershipDirectory, 'p9.db'));
// ponytail: --acp-override swaps the real adapters for a test or recording shim; only the unit's ExecStart can pass it.
const adapterOverride = values['acp-override'];
if (adapterOverride !== undefined && !path.isAbsolute(adapterOverride)) throw new Error('absolute-acp-override-required');
// ponytail: --usage-sdk, with --acp-override only, swaps the SDK the live Claude usage poll loads for a test stand-in.
const usageSdk = values['usage-sdk'];
if (usageSdk !== undefined && !path.isAbsolute(usageSdk)) throw new Error('absolute-usage-sdk-required');
const instance = createHash('sha256').update(ownershipDirectory).digest('hex').slice(0, 8);
const tmuxSocket = values['tmux-socket'] ?? `p9-${instance}`;
if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tmuxSocket)) throw new Error('invalid-tmux-socket');
// ponytail: --terminal-platform is for tests (another platform's terminal backend, or none); it can only take terminals away.
// BL4: honoured only under the test home (test/helpers.mjs sets P9_TEST_HOME), so a shipped unit never takes it.
const terminalPlatform = values['terminal-platform'];
if (terminalPlatform !== undefined && (!process.env.P9_TEST_HOME || !['darwin', process.platform].includes(terminalPlatform))) throw new Error('invalid-terminal-platform');
// The update's stand-ins (another checkout, a loopback archive, a short turn limit) are test flags too: refused the same way.
const updateFlag = ['update-root', 'update-archive', 'update-turn-ms'].find((name) => values[name] !== undefined);
if (updateFlag && !process.env.P9_TEST_HOME) throw new Error('invalid-test-flag --' + updateFlag);
// Remote logins (phase 10) are off unless both flags are given: the port binds 127.0.0.1 only, for tailscale serve to
// proxy, and the origin pins the passkey RP ID and the Host header (https, or http://localhost for tests).
let remote;
if (values['remote-port'] !== undefined || values['remote-origin'] !== undefined) {
  const port = Number(values['remote-port']), origin = new URL(values['remote-origin'] ?? 'invalid:');
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || origin.origin !== values['remote-origin']
      || !(origin.protocol === 'https:' || (origin.protocol === 'http:' && (origin.hostname === 'localhost' || origin.hostname.endsWith('.localhost'))))) throw new Error('invalid-remote-options');
  remote = { port, origin: origin.origin, rpID: origin.hostname, host: origin.host };
}
// Anymouse's GitHub token (Builder's install only, from secrets.sh): read once, then gone from the environment children see.
const githubToken = process.env.P9_GITHUB_TOKEN || undefined;
delete process.env.P9_GITHUB_TOKEN;
// ponytail: P9_GITHUB_API points the API at a loopback stand-in for tests; nothing else is accepted, so the token cannot be sent elsewhere.
const githubApi = /^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.P9_GITHUB_API ?? '') ? process.env.P9_GITHUB_API : undefined;
delete process.env.P9_GITHUB_API;
const server = createListener({ workspace, savedWorkspace, recovery, state, credentials, transport: windows ? 'pipe' : 'unix', settings, settingsInvalid, settingsFile, ledger, adapterOverride, claudeUsage: adapterOverride === undefined ? createClaudeUsage() : usageSdk && createClaudeUsage({ open: () => openQuery(usageSdk) }), instance, tmuxSocket, terminalPlatform, ownership: ownershipDirectory, remote, anymouse: createAnymouse({ token: githubToken, api: githubApi }),
  ...(values['update-root'] ? { updateRoot: path.resolve(values['update-root']) } : {}), updateArchive: values['update-archive'],
  ...(values['update-turn-ms'] ? { updateTurnMs: Number(values['update-turn-ms']) } : {}) });
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  if (remote) {
    await new Promise((resolve, reject) => {
      server.remote.once('error', reject);
      server.remote.listen(remote.port, '127.0.0.1', resolve);
    });
  }
  if (!windows) await chmod(socketPath, 0o600);
  else {
    const acl = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', windowsHost, '-Mode', 'PipeLock', '-Pipe', socketPath], { encoding: 'utf8', env: childEnv() });
    if (acl.status !== 0) throw new Error('pipe-acl-not-current-user-only');
  }
  // A second process must bind successfully before it may create credentials.
  const credentialFile = await open(path.join(values.state, 'desktop.json'), 'wx', 0o600);
  try { await credentialFile.writeFile(JSON.stringify(credentials)); await credentialFile.sync(); }
  finally { await credentialFile.close(); }
} catch {
  console.error('P9_START_FAILED');
  process.exit(1);
}
// Item 15: an update moved the CLIs P9 ships; the launchers the owner installed are rewritten to point at this version's.
placeAgents(AGENTS, { refresh: true }).catch((error) => console.error('P9_AGENT_LAUNCHERS_NOT_UPDATED ' + (error.code ?? error.message)));
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  // A stuck request or filesystem must not keep systemctl stop waiting indefinitely.
  setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 10000).unref();
  if (server.remote) { server.remote.close(); server.remote.closeAllConnections(); }
  server.editor?.stop(); // Server mode's editor runs in its own systemd scope, so it would outlive the daemon
  // Agents stop first, alongside the request drain: an open long poll would otherwise hold server.close for 8 s.
  // The woken polls answer, then sit idle on keep-alive; close them once the agents are down.
  const work = Promise.all([server.chat.shutdown(), server.mission.stopAll()]).then((result) => { server.closeIdleConnections(); return result; });
  server.close(async () => {
    try {
      if ((await work).some((value) => String(value).startsWith('cleanup-failed'))) console.error('P9_CLEANUP_FAILED');
      await drainSaves();
      server.closeAllConnections();
      await unlink(path.join(values.state, 'desktop.json'));
      if (windows) await new Promise((resolve) => workspaceLock.close(resolve));
      else await workspaceLock?.close();
      process.exit(0);
    } catch { process.exit(1); }
  });
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
console.log('P9_READY');
