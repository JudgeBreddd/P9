import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { daemon, http, authenticated, root } from './helpers.mjs';
import { internalEndpoint, missingWindowsBinaries, windowsLockEndpoint } from '../apps/server/windows.mjs';
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
  assert.ok(main.indexOf("'-Mode', 'PipeLock'") < main.indexOf("'desktop.json'), 'wx'"), 'pipe ACL check must precede credentials');
  assert.match(pack, /extract-node-windows\.ps1/);
  assert.match(pack, /process\.env\.npm_execpath/);
  assert.match(extract, /Expand-Archive/);
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
  // B8: a folder Everyone can read fails; the folder this user's profile made passes.
  const shared = path.join(dir, 'shared');
  await mkdir(shared);
  execFileSync('icacls.exe', [shared, '/grant', '*S-1-1-0:(R)']);
  const payload = (folders) => Buffer.from(JSON.stringify(folders)).toString('base64');
  const acl = ps(['-File', host, '-Mode', 'Acl', '-Payload', payload([dir, shared])]);
  assert.equal(acl.status, 1, acl.stderr);
  assert.deepEqual(acl.stdout.trim().split(/\r?\n/), [shared]);
  assert.equal(ps(['-File', host, '-Mode', 'Acl', '-Payload', payload([dir])]).status, 0);
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
  const sid = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { encoding: 'utf8' }).trim();
  assert.match(acl, /^D:P?/);
  assert.deepEqual([...acl.matchAll(/;;;([^)]+)\)/g)].map((match) => match[1]), [sid]);

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
