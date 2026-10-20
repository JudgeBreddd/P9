import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { daemon, http, authenticated, root } from './helpers.mjs';
import { internalEndpoint, missingWindowsBinaries, windowsLockEndpoint } from '../apps/server/windows.mjs';
import { resolveWindowsExecutable, windowsJobCommand } from '../apps/server/process-tree.mjs';
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
  assert.throws(() => resolveWindowsExecutable('script.cmd', environment, () => true), /command-not-found/);
  assert.deepEqual(childEnv({ Path: 'safe', ComSpec: 'safe', PSModulePath: 'leak' }, 'win32'), { Path: 'safe', ComSpec: 'safe' });
  assert.equal(allowed('pAtH', 'win32'), true);
  assert.notEqual(windowsLockEndpoint('C:\\Users\\one\\AppData\\Local\\P9'), windowsLockEndpoint('C:\\Users\\two\\AppData\\Local\\P9'));
  assert.deepEqual(missingWindowsBinaries(['@openai+codex-win32-x64@1', '@anthropic-ai+claude-agent-sdk-win32-x64@1']), []);
  assert.deepEqual(missingWindowsBinaries(['@openai+codex-win32-x64@1']), ['@anthropic-ai+claude-agent-sdk-win32-x64@']);
  assert.deepEqual(missingWindowsBinaries(['@openai+codex@0.159.3-win32-x64', '@anthropic-ai+claude-agent-sdk-win32-x64@1']), []);
  assert.deepEqual(missingWindowsBinaries(['@openai+codex@0.159.3', '@anthropic-ai+claude-agent-sdk-win32-x64@1']), ['@openai+codex-win32-x64@']);

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
