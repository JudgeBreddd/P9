import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { daemon, http, authenticated, root } from './helpers.mjs';
import * as windowsModule from '../apps/server/windows.mjs';
import { internalEndpoint, missingWindowsBinaries, trimLog, windowsLockEndpoint } from '../apps/server/windows.mjs';
import { resolveWindowsExecutable, windowsArgv, windowsJobCommand } from '../apps/server/process-tree.mjs';
import { allowed, childEnv } from '../apps/server/child-env.mjs';

const fake = path.join(root, 'test', 'fake-acp-agent.mjs');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const json = async (promise) => { const result = await promise; return { ...result, body: JSON.parse(result.text) }; };

test('Windows endpoint, payload, executable and job host contracts are owner-scoped and shell-free', async () => {
  const first = internalEndpoint('ignored', 'win32', { home: 'C:\\Users\\one', user: 'one' });
  const second = internalEndpoint('ignored', 'win32', { home: 'C:\\Users\\two', user: 'two' });
  assert.match(first, /^\\\\\.\\pipe\\p9-foundation-[a-f0-9]{20}$/);
  assert.notEqual(first, second);
  // W3: one user, two state folders (the daily daemon and a dev one), two pipes.
  assert.notEqual(internalEndpoint('C:\\P9\\runtime', 'win32', { home: 'C:\\Users\\one', user: 'one' }),
    internalEndpoint('C:\\P9-dev\\runtime', 'win32', { home: 'C:\\Users\\one', user: 'one' }));
  const environment = { Path: 'C:\\Program Files\\nodejs;C:\\Windows\\System32', ComSpec: 'C:\\Windows\\System32\\cmd.exe' };
  const command = windowsJobCommand(['C:\\Program Files\\nodejs\\node.exe', '-e', '--mode', '-Debug'], environment);
  const payload = JSON.parse(Buffer.from(command.at(-1), 'base64').toString());
  assert.deepEqual(payload, { argv: ['C:\\Program Files\\nodejs\\node.exe', '-e', '--mode', '-Debug'], env: environment });
  assert.deepEqual(command.slice(-4, -1), ['-Mode', 'Job', '-Payload']);
  assert.equal(command.includes('cmd.exe'), false);
  assert.equal(resolveWindowsExecutable('node.exe', environment, (file) => file === 'C:\\Program Files\\nodejs\\node.exe'),
    'C:\\Program Files\\nodejs\\node.exe');
  assert.throws(() => resolveWindowsExecutable('script.ps1', environment, () => true), /command-not-found/);
  // D3: npm and pnpm are .cmd files, found after .exe and .com, and run through cmd.exe with every part quoted.
  const npm = 'C:\\Program Files\\nodejs\\npm.cmd';
  const windowsRoot = { ...environment, SystemRoot: 'C:\\Windows' };
  assert.equal(resolveWindowsExecutable('npm', environment, (file) => file === npm), npm);
  assert.deepEqual(windowsArgv(['npm', 'run', 'a&b', 'x!y'], windowsRoot, (file) => file === npm), { verbatim: true,
    argv: ['C:\\Windows\\System32\\cmd.exe', '/d', '/s', '/v:off', '/c', `""${npm}" "run" "a&b" "x!y""`] });
  assert.deepEqual(windowsArgv(['node', '-e', 'a&b'], windowsRoot, (file) => file.endsWith('node.exe')),
    { argv: ['C:\\Program Files\\nodejs\\node.exe', '-e', 'a&b'], verbatim: false });
  for (const bad of ['%PATH%', 'a"&calc', 'line\r\nnext']) {
    assert.throws(() => windowsArgv(['npm', bad], windowsRoot, (file) => file === npm), /unsafe-batch-argument:npm\.cmd/);
  }
  assert.equal(JSON.parse(Buffer.from(windowsJobCommand([npm, 'test'], windowsRoot).at(-1), 'base64').toString()).verbatim, true);
  assert.deepEqual(windowsJobCommand([npm, 'test'], windowsRoot, 'Console').slice(-4, -1), ['-Mode', 'Console', '-Payload']);
  // W1, W2: a detach run carries the flag to the host; Launch starts an app or a page with no window.
  assert.equal(JSON.parse(Buffer.from(windowsJobCommand([npm, 'test'], windowsRoot, 'Job', true).at(-1), 'base64').toString()).detach, true);
  assert.deepEqual(windowsJobCommand([npm, 'test'], windowsRoot, 'Launch').slice(-4, -1), ['-Mode', 'Launch', '-Payload']);
  assert.deepEqual(childEnv({ Path: 'safe', ComSpec: 'safe', PSModulePath: 'leak' }, 'win32'), { Path: 'safe', ComSpec: 'safe' });
  assert.equal(allowed('pAtH', 'win32'), true);
  assert.notEqual(windowsLockEndpoint('C:\\Users\\one\\AppData\\Local\\P9'), windowsLockEndpoint('C:\\Users\\two\\AppData\\Local\\P9'));
  assert.deepEqual(missingWindowsBinaries(['@openai+codex-win32-x64@1', '@anthropic-ai+claude-agent-sdk-win32-x64@1']), []);
  assert.deepEqual(missingWindowsBinaries(['@openai+codex-win32-x64@1']), ['@anthropic-ai+claude-agent-sdk-win32-x64@']);
  assert.deepEqual(missingWindowsBinaries(['@openai+codex@0.159.3-win32-x64', '@anthropic-ai+claude-agent-sdk-win32-x64@1']), []);
  assert.deepEqual(missingWindowsBinaries(['@openai+codex@0.159.3', '@anthropic-ai+claude-agent-sdk-win32-x64@1']), ['@openai+codex-win32-x64@']);
  // B9: an ARM64 build needs the ARM64 binaries; x64 ones do not count.
  assert.deepEqual(missingWindowsBinaries(['@openai+codex@0.159.3-win32-arm64', '@anthropic-ai+claude-agent-sdk-win32-arm64@0.3.293'], 'arm64'), []);
  assert.deepEqual(missingWindowsBinaries(['@openai+codex@0.159.3-win32-x64', '@anthropic-ai+claude-agent-sdk-win32-x64@1'], 'arm64'),
    ['@openai+codex-win32-arm64@', '@anthropic-ai+claude-agent-sdk-win32-arm64@']);

  const [host, main, pack, extract] = await Promise.all(['scripts/windows-host.ps1', 'apps/server/main.mjs', 'scripts/package-windows.mjs',
    'scripts/extract-node-windows.ps1'].map((file) => readFile(path.join(root, file), 'utf8')));
  assert.match(host, /PROC_THREAD_ATTRIBUTE_JOB_LIST/);
  assert.doesNotMatch(host, /AssignProcessToJobObject/);
  assert.ok(main.indexOf('windowsLockEndpoint') < main.indexOf('await readdir(state)'), 'lock must precede state or ledger mutation');
  assert.ok(main.includes('else lockPipe({ host: windowsHost, pipe: socketPath, env: childEnv() });'), 'Windows locks its pipe through lockPipe');
  assert.ok(main.includes('if (windows) lockFolders({ host: windowsHost, folders: [state, recovery, ownershipDirectory], env: childEnv() });'), 'Windows checks its three folders through lockFolders (timed)');
  assert.ok(main.indexOf('lockPipe({') < main.indexOf("'desktop.json'), 'wx'"), 'pipe ACL check must precede credentials');
  assert.ok(main.includes("console.error('P9_START_FAILED_CODE ' + ([error?.code, error?.name]"), 'a refused start names its code (PIPE_ACL) in the log');
  assert.match(pack, /extract-node-windows\.ps1/);
  assert.match(pack, /process\.env\.npm_execpath/);
  // O151: Windows' own tar.exe by full path, and a failed extract stops the build.
  assert.match(extract, /System32\\tar\.exe'\) -xf \$Archive -C \$Build/);
  assert.match(extract, /if \(\$LASTEXITCODE -ne 0\) \{ throw/);
});

// O23: on a Windows machine with WSL, System32\bash.exe and WindowsApps\bash.exe are WSL launchers. A bare bash or sh (a
// Mission button's cmd) must reach Git Bash, never WSL; every other name resolves exactly as before.
// N6-1: the refusal side of the pipe lock runs on every platform: spawnSync is stubbed, so no Windows and no PowerShell.
// (The lock itself, Win32 SetSecurityInfo and the ACE check in windows-host.ps1, runs only on the Windows CI job above.)
test('N6-1 PIPE_ACL: lockPipe runs PipeLock on the pipe with a timeout; any exit but 0 (ACE check failed, no PowerShell, timed out) refuses with code PIPE_ACL', () => {
  const { lockPipe, PIPE_LOCK_MS } = windowsModule;
  assert.equal(typeof lockPipe, 'function', 'no lockPipe: the PIPE_ACL refusal is inline in main.mjs and untested');
  const pipe = '\\\\.\\pipe\\p9-foundation-0123456789abcdef0123', host = 'C:\\P9\\scripts\\windows-host.ps1', env = { Path: 'C:\\Windows' };
  const calls = [];
  const stub = (result) => (command, args, options) => { calls.push({ command, args, options }); return result; };
  assert.equal(lockPipe({ host, pipe, env, run: stub({ status: 0, stdout: 'D:P(A;;FA;;;S-1-5-21-1)\r\n' }) }), undefined);
  assert.deepEqual(calls[0].command, 'powershell.exe');
  assert.deepEqual(calls[0].args, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', host, '-Mode', 'PipeLock', '-Pipe', pipe]);
  assert.equal(calls[0].options.env, env);
  assert.equal(calls[0].options.shell, undefined, 'no shell: the pipe name is one argument');
  assert.ok(Number.isInteger(calls[0].options.timeout) && calls[0].options.timeout === PIPE_LOCK_MS && PIPE_LOCK_MS >= 60_000,
    'a hung PowerShell must not hold the start forever (CI cold starts took up to 20 s)');
  const refused = (result, why) => assert.throws(() => lockPipe({ host, pipe, env, run: stub(result) }),
    (error) => error.code === 'PIPE_ACL' && error.message === 'pipe-acl-not-current-user-only' && !error.message.includes(pipe), why);
  refused({ status: 1, stderr: 'pipe-acl-not-current-user-only' }, 'the ACE check threw');
  refused({ status: null, error: Object.assign(new Error('spawnSync powershell.exe ENOENT'), { code: 'ENOENT' }) }, 'no PowerShell');
  refused({ status: null, signal: 'SIGTERM', error: Object.assign(new Error('spawnSync powershell.exe ETIMEDOUT'), { code: 'ETIMEDOUT' }) }, 'killed at the timeout');
  refused({ status: 3221225786 }, 'killed by Windows (an NTSTATUS exit)');
  refused(undefined, 'no result');
  console.log('PASS N6-1 PIPE_ACL: exit 0 locks; exit 1, no PowerShell, timeout, NTSTATUS and no result refuse as PIPE_ACL (timeout ' + PIPE_LOCK_MS + ' ms)');
});

// N6-1 (the row's last piece): main.mjs's B8 folder check (windows-host.ps1 -Mode Acl on state, recovery and the ownership
// folder) ran spawnSync with no timeout, so a hung PowerShell held the start forever, as the pipe lock did before #364.
test('N6-1 B8: lockFolders runs the Acl check on the three folders with a timeout; any exit but 0 refuses, naming the ownership folder when the check prints it', () => {
  const { lockFolders, PIPE_LOCK_MS } = windowsModule;
  assert.equal(typeof lockFolders, 'function', 'no lockFolders: the B8 folder check is inline in main.mjs with no timeout');
  const host = 'C:\\P9\\scripts\\windows-host.ps1', env = { Path: 'C:\\Windows' };
  const folders = ['C:\\Users\\one\\AppData\\Local\\P9\\state', 'C:\\Users\\one\\AppData\\Local\\P9\\recovery', 'C:\\Users\\one\\AppData\\Local\\P9'];
  const calls = [];
  const stub = (result) => (command, args, options) => { calls.push({ command, args, options }); return result; };
  assert.equal(lockFolders({ host, folders, env, run: stub({ status: 0, stdout: '' }) }), undefined);
  assert.equal(calls[0].command, 'powershell.exe');
  assert.deepEqual(calls[0].args, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', host, '-Mode', 'Acl',
    '-Payload', Buffer.from(folders.join('\n')).toString('base64')]);
  assert.equal(calls[0].options.env, env);
  assert.equal(calls[0].options.shell, undefined, 'no shell: the payload is one argument');
  assert.equal(calls[0].options.timeout, PIPE_LOCK_MS, 'a hung PowerShell must not hold the start forever');
  const refused = (result, message, why) => assert.throws(() => lockFolders({ host, folders, env, run: stub(result) }), (error) => error.message === message, why);
  refused({ status: 1, stdout: folders[0] + '\r\n' }, 'unsafe-private-directory', 'the state folder grants someone else');
  refused({ status: 1, stdout: folders[2] + '\r\n' }, 'unsafe-ownership-directory', 'the ownership folder grants someone else');
  refused({ status: null, signal: 'SIGTERM', error: Object.assign(new Error('spawnSync powershell.exe ETIMEDOUT'), { code: 'ETIMEDOUT' }) }, 'folder-acl-check-timed-out', 'killed at the timeout: names the hang, not the folders');
  refused({ status: null, error: Object.assign(new Error('spawnSync powershell.exe ENOENT'), { code: 'ENOENT' }) }, 'unsafe-private-directory', 'no PowerShell');
  refused(undefined, 'unsafe-private-directory', 'no result');
  console.log('PASS N6-1 B8: exit 0 passes; a folder named, a timeout named, no PowerShell and no result refuse (timeout ' + PIPE_LOCK_MS + ' ms)');
});

test('O23: bare bash and sh skip the WSL launchers and fall back to Git Bash; cmd, node and powershell are unchanged', () => {
  const env = { Path: 'C:\\Windows\\system32;C:\\Users\\one\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Program Files\\Git\\cmd;C:\\Program Files\\nodejs;C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
    SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\one\\AppData\\Local', ProgramFiles: 'C:\\Program Files' };
  const disk = new Set(['C:\\Windows\\system32\\bash.exe', 'C:\\Users\\one\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe',
    'C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\bin\\sh.exe', 'C:\\Windows\\system32\\cmd.exe',
    'C:\\Program Files\\nodejs\\node.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe']);
  const exists = (file) => disk.has(file);
  for (const name of ['bash', 'BASH', 'bash.exe']) assert.equal(resolveWindowsExecutable(name, env, exists), 'C:\\Program Files\\Git\\bin\\bash.exe', name);
  assert.equal(resolveWindowsExecutable('sh', env, exists), 'C:\\Program Files\\Git\\bin\\sh.exe');
  // A real bash earlier on PATH than Git's own still wins (MSYS2, a portable Git): only the WSL launchers are skipped.
  const msys = { ...env, Path: 'C:\\msys64\\usr\\bin;' + env.Path };
  assert.equal(resolveWindowsExecutable('bash', msys, (file) => file === 'C:\\msys64\\usr\\bin\\bash.exe' || exists(file)), 'C:\\msys64\\usr\\bin\\bash.exe');
  // Only WSL on the machine: refused, never WSL. An explicit path is the user's choice and is kept.
  assert.throws(() => resolveWindowsExecutable('bash', env, (file) => file.includes('system32') || file.includes('WindowsApps')), /command-not-found:bash/);
  assert.equal(resolveWindowsExecutable('C:\\Windows\\System32\\bash.exe', env, exists), 'C:\\Windows\\System32\\bash.exe');
  assert.equal(resolveWindowsExecutable('cmd', env, exists), 'C:\\Windows\\system32\\cmd.exe');
  assert.equal(resolveWindowsExecutable('node', env, exists), 'C:\\Program Files\\nodejs\\node.exe');
  assert.equal(resolveWindowsExecutable('powershell', env, exists), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
});

test('Windows host: a .cmd runs with & intact, Console starts a program, Acl refuses a shared folder, the DLL loads', {
  skip: process.platform !== 'win32' && 'requires cmd.exe, PowerShell 5.1 and NTFS ACLs',
  timeout: 120000,
}, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-host-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const host = path.join(root, 'scripts', 'windows-host.ps1');
  const ps = (args) => spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf8' });
  // D3: through the job host, the way chat and the editor start a program.
  const script = path.join(dir, 'echo-args.cmd');
  await writeFile(script, `@"${process.execPath}" -e "console.log(JSON.stringify(process.argv.slice(1)))" -- %*\r\n`);
  const job = windowsJobCommand([script, 'a&b', 'x!y', 'two words'], { ...process.env });
  const ran = spawnSync(job[0], job.slice(1), { encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(JSON.parse(ran.stdout.trim().split(/\r?\n/).pop()), ['a&b', 'x!y', 'two words']);
  // D1: Console starts the program in its own window and returns without waiting for it.
  const marker = path.join(dir, 'console.txt');
  const opened = windowsJobCommand([process.execPath, '-e', `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'up'),500)`], { ...process.env }, 'Console');
  const consoleRun = spawnSync(opened[0], opened.slice(1), { encoding: 'utf8' });
  assert.equal(consoleRun.status, 0, consoleRun.stderr);
  for (let i = 0; i < 50 && !existsSync(marker); i += 1) await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(existsSync(marker), 'Console did not start the program');
  // W2: Launch does the same with no window.
  const launchMarker = path.join(dir, 'launch.txt');
  const launch = windowsJobCommand([process.execPath, '-e', `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(launchMarker)},'up'),500)`], { ...process.env }, 'Launch');
  const launchRun = spawnSync(launch[0], launch.slice(1), { encoding: 'utf8' });
  assert.equal(launchRun.status, 0, launchRun.stderr);
  for (let i = 0; i < 50 && !existsSync(launchMarker); i += 1) await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(existsSync(launchMarker), 'Launch did not start the program');
  // B8: a folder Everyone can read fails; the folder this user's profile made passes.
  const shared = path.join(dir, 'shared');
  await mkdir(shared);
  execFileSync('icacls.exe', [shared, '/grant', '*S-1-1-0:(R)']);
  const payload = (folders) => Buffer.from(folders.join('\n')).toString('base64');
  const acl = ps(['-File', host, '-Mode', 'Acl', '-Payload', payload([dir, shared])]);
  assert.equal(acl.status, 1, acl.stderr);
  assert.deepEqual(acl.stdout.trim().split(/\r?\n/), [shared]);
  // The daemon's own call: its allowlisted environment and a LOCALAPPDATA no PowerShell has used, as in daemon().
  await mkdir(path.join(dir, 'cold'));
  const began = Date.now();
  const cold = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', host,
    '-Mode', 'Acl', '-Payload', payload([dir])], { encoding: 'utf8', env: { ...childEnv(), LOCALAPPDATA: path.join(dir, 'cold') } });
  assert.equal(cold.status, 0, cold.stdout + cold.stderr);
  console.log(`B8 Acl check, new LOCALAPPDATA: ${Date.now() - began} ms`);
  // E4: the compiled class beside a copy of the host is what it loads; time one start each way.
  const copy = path.join(dir, 'host');
  await mkdir(copy);
  await copyFile(host, path.join(copy, 'windows-host.ps1'));
  const time = () => { const began = Date.now(); const r = ps(['-File', path.join(copy, 'windows-host.ps1'), '-Mode', 'PipeAcl', '-Pipe', '\\\\.\\pipe\\p9-missing']); return [Date.now() - began, r]; };
  const [compiling] = time();
  assert.equal(ps(['-File', host, '-Mode', 'Compile', '-Out', path.join(copy, 'P9WindowsHost.dll')]).status, 0);
  const [loading, loaded] = time();
  assert.doesNotMatch(loaded.stderr, /Add-Type|TypeDefinition|already exists/, loaded.stderr);
  console.log(`E4 host start: ${compiling} ms compiling, ${loading} ms with the DLL`);
});

test('Windows Stop ends detached chat and script children through Job Objects within 5 s', {
  skip: process.platform !== 'win32' && 'requires Windows Job Objects, named-pipe security descriptors, and Task Scheduler runtime',
  timeout: 90000,
}, async (t) => {
  const instance = await daemon(t, undefined, false, async (paths) => {
    await mkdir(path.join(paths.workspace, 'waiting'));
    await writeFile(path.join(paths.workspace, 'registry.json'), JSON.stringify({ scripts: [
      { id: 'detach', title: 'Detached fixture', cmd: [process.execPath, path.join(root, 'test', 'windows-detached-script.mjs')] },
      { id: 'keep', title: 'Kept fixture', detach: true, cmd: [process.execPath, path.join(root, 'test', 'windows-detached-script.mjs')] },
      { id: 'missing', title: 'Missing fixture', cmd: ['p9-missing-command.exe'] },
      { id: 'argv', title: 'Argument fixture', cmd: ['node.exe', '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', '--'], args: ['Value'] },
    ], apps: [], pages: [] }));
    await writeFile(path.join(paths.directory, 'settings.json'), JSON.stringify({ primary: 'primary.md', registry: 'registry.json', waiting: 'waiting' }));
    return { path: `${path.dirname(process.execPath)};${process.env.PATH}`, args: ['--settings', path.join(paths.directory, 'settings.json'), '--acp-override', fake] };
  });
  const call = (route, method = 'GET', body) => http({ socketPath: instance.credentials.socketPath, route, method,
    headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body) });

  const acl = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(root, 'scripts', 'windows-host.ps1'), '-Mode', 'PipeAcl', '-Pipe', instance.credentials.socketPath], { encoding: 'utf8' }).trim();
  // SDDL writes well-known accounts as aliases (the runners' built-in Administrator is LA), so compare parsed SIDs.
  const [sid, ...trustees] = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; (New-Object Security.AccessControl.RawSecurityDescriptor('${acl}')).DiscretionaryAcl | ForEach-Object { $_.SecurityIdentifier.Value }`],
  { encoding: 'utf8' }).trim().split(/\r?\n/);
  assert.match(acl, /^D:P?/);
  assert.deepEqual(trustees, [sid]);

  const conversation = (await json(call('/chat', 'POST', { provider: 'claude' }))).body.conversation;
  assert.equal((await call(`/chat/${conversation}/prompt`, 'POST', { text: 'detach' })).status, 202);
  let chatPid;
  for (let cursor = 0, i = 0; i < 60 && !chatPid; i += 1) {
    const events = (await json(call(`/chat/events?after=${cursor}&wait=1000`))).body;
    cursor = events.cursor;
    const update = events.events.find((event) => event.data?.content?.text?.startsWith('detach:'));
    if (update) chatPid = Number(update.data.content.text.slice(7));
  }
  assert.ok(chatPid && alive(chatPid), 'detached chat child did not start');
  let began = Date.now();
  assert.equal((await json(call(`/chat/${conversation}/stop`, 'POST'))).body.result, 'stopped');
  assert.ok(Date.now() - began < 5000 && !alive(chatPid), 'detached chat child survived Stop');

  const launched = await json(call('/scripts/detach/run', 'POST', {}));
  assert.equal(launched.status, 202, launched.text);
  let scriptPid;
  for (let i = 0; i < 100 && !scriptPid; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const output = await json(call(`/runs/${launched.body.run}?from=0`));
    scriptPid = Number(output.body.output.match(/detach:(\d+)/)?.[1]);
  }
  assert.ok(scriptPid && alive(scriptPid), 'detached registry-script child did not start');
  began = Date.now();
  assert.equal((await json(call('/stop-all', 'POST', {}))).body.result, 'stopped');
  assert.ok(Date.now() - began < 5000 && !alive(scriptPid), 'detached registry-script child survived Stop All');

  // W1: a "detach": true record's script ends on Stop All; what it started (a GUI app in the bug) keeps running.
  const kept = await json(call('/scripts/keep/run', 'POST', {}));
  assert.equal(kept.status, 202, kept.text);
  let keptPid;
  for (let i = 0; i < 100 && !keptPid; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    keptPid = Number((await json(call(`/runs/${kept.body.run}?from=0`))).body.output.match(/detach:(\d+)/)?.[1]);
  }
  t.after(() => { try { process.kill(keptPid); } catch {} });
  assert.ok(keptPid && alive(keptPid), 'detach script child did not start');
  assert.equal((await json(call('/stop-all', 'POST', {}))).body.result, 'stopped');
  let keptRun;
  for (let i = 0; i < 50 && !keptRun?.body.done; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    keptRun = await json(call(`/runs/${kept.body.run}?from=0`));
  }
  assert.ok(keptRun.body.done, 'detach script survived Stop All');
  assert.ok(alive(keptPid), 'detach script child died with its script');

  const argvRun = await json(call('/scripts/argv/run', 'POST', { args: ['-Debug'] }));
  assert.equal(argvRun.status, 202, argvRun.text);
  let argvOutput;
  for (let i = 0; i < 100 && !argvOutput?.body.done; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    argvOutput = await json(call(`/runs/${argvRun.body.run}?from=0`));
  }
  assert.equal(argvOutput.body.code, 0, argvOutput.text);
  assert.match(argvOutput.body.output, /\["-Debug"\]/);
  // A missing executable finishes with 127 and frees its run slot: five in a row still start (MAX_RUNNING is 4).
  for (let i = 0; i < 5; i += 1) {
    const missing = await json(call('/scripts/missing/run', 'POST', {}));
    assert.equal(missing.status, 202, missing.text);
    const result = await json(call(`/runs/${missing.body.run}?from=0`));
    assert.equal(result.body.code, 127, result.text);
  }
  console.log(`PASS Windows Job Objects: pipe ACL only ${sid}; dash argv preserved; chat child ${chatPid} and script child ${scriptPid} gone within 5 s`);
});

// 016 item 6: daemon.log is trimmed while the daemon runs, not only at the host's start. The writer here holds it open for
// append, as the Windows host gives it to node (FILE_APPEND_DATA); after the trim its next line lands at the new end, no gap.
test('daemon.log: over the limit it is copied to .1 and emptied in place while a writer holds it open; main.mjs checks it every 10 min on every platform (the Windows task\'s and Linux background mode\'s log)', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'p9-log-')), log = path.join(directory, 'daemon.log');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { open } = await import('node:fs/promises'), writer = await open(log, 'a');
  t.after(() => writer.close());
  await writer.write('old line\n'.repeat(200));
  assert.equal(await trimLog(log, 10000), false, 'under the limit nothing moves');
  assert.equal(await trimLog(log, 1000), true);
  await writer.write('new line\n');
  assert.equal(await readFile(log, 'utf8'), 'new line\n', 'the open writer goes on at the start, with no hole of NULs');
  assert.equal(await readFile(log + '.1', 'utf8'), 'old line\n'.repeat(200));
  assert.equal(await trimLog(path.join(directory, 'missing.log')), false);
  const main = await readFile(path.join(root, 'apps/server/main.mjs'), 'utf8');
  assert.match(main, /\nsetInterval\(\(\) => trimLog\(path\.join\(values\.state, '\.\.', 'daemon\.log'\)\)\.catch\(\(\) => \{\}\), 600000\)\.unref\(\);/);
  // Linux background mode: the daemon's state folder is $r/p9-foundation and sh appends its output to $r/daemon.log, the
  // same file the check above names (values.state/../daemon.log); sh's >> is append-only, as the writer above.
  const background = await readFile(path.join(root, 'scripts/background.sh'), 'utf8');
  assert.match(background, /state="\$r\/p9-foundation"/);
  assert.match(background, /--state "\$state"[^\n]*\n[^\n]*>>"\$r\/daemon\.log" 2>&1 &/);
});
