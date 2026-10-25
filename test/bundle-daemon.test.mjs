import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { root, daemon } from './helpers.mjs';
import { bundleDaemon } from '../scripts/bundle-daemon.mjs';

// B10: package-windows.mjs builds the installer's daemon folder with bundleDaemon; this builds the same layout with this
// platform's agent binaries and runs it, so a bundle that cannot start or find its agents fails here before Windows CI.
test('B10: the bundled daemon is a few dozen files, starts, and its agents answer from the bundled layout', async (t) => {
  // Outside the repo, so nothing resolves from the workspace's node_modules. ponytail: about 670 MB of agent binaries;
  // the test sandbox's /tmp is 1 GB, so move this to a disk folder with no node_modules above it if that fills.
  const out = await mkdtemp(path.join(os.tmpdir(), 'p9-bundle-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const notices = await bundleDaemon(root, out, `${process.platform}-${process.arch}`);
  const files = (await readdir(out, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
  // 0.1.3 shipped 26,028 files in daemon/node_modules; codex's binary package alone is about 46 of these.
  assert.ok(files.length < 100, files.length + ' files in the bundled daemon');

  const instance = await daemon(t, path.join(out, 'apps', 'server', 'main.mjs'));
  assert.ok(files.some((entry) => entry.name === 'mcp-relay.mjs'), 'the MCP relay is beside main.mjs');
  // The installed daemon folder also holds package.json, scripts/teh.mjs (package-windows.mjs, package-linux.mjs) and
  // packages/ (package.json extraResources); teh doctor run from there must load and reach the bundled daemon.
  await cp(path.join(root, 'package.json'), path.join(out, 'package.json'));
  await cp(path.join(root, 'scripts', 'teh.mjs'), path.join(out, 'scripts', 'teh.mjs'));
  await cp(path.join(root, 'packages'), path.join(out, 'packages'), { recursive: true });
  const doctor = spawnSync(process.execPath, [path.join(out, 'scripts', 'teh.mjs'), 'doctor', '--state', instance.state], { encoding: 'utf8', timeout: 30000 });
  assert.equal(doctor.status, 0, 'teh doctor from the daemon folder: ' + doctor.stderr.slice(-1000));
  assert.equal(JSON.parse(doctor.stdout).daemon.status, 'ok');
  for (const name of ['hono', 'ws', '@simplewebauthn/server', '@agentclientprotocol/sdk', 'zod']) assert.match(notices, new RegExp('\n## ' + name + '@'), name + ' notice');
  for (const section of notices.split('\n## ').slice(1)) assert.match(section, /\n### /, section.split('\n')[0] + ' has no licence text');

  const modules = path.join(out, 'node_modules');
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-bundle-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const adapter of ['claude-agent-acp', 'codex-acp']) {
    const child = spawn(process.execPath, [path.join(modules, '@agentclientprotocol', adapter, 'dist', 'index.js')], { env: { PATH: process.env.PATH, HOME: home } });
    t.after(() => child.kill());
    let output = '', errors = '';
    child.stderr.on('data', (chunk) => { errors += chunk; });
    await new Promise((resolve) => {
      child.stdout.on('data', (chunk) => { output += chunk; if (output.includes('\n')) resolve(); });
      child.once('exit', resolve);
      setTimeout(resolve, 15000);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } }) + '\n');
    });
    assert.equal(JSON.parse(output.split('\n')[0]).result?.agentInfo?.name, '@agentclientprotocol/' + adapter, adapter + ' said: ' + output.slice(0, 500) + errors.slice(-500));
  }
  // claude-agent-acp finds claude through import.meta.resolve, which session/new reaches only with a login; the bundle
  // must keep that call, and the same call from the bundle's folder must find this platform's binary.
  const claudeDist = path.join(modules, '@agentclientprotocol', 'claude-agent-acp', 'dist');
  assert.match(await readFile(path.join(claudeDist, 'index.js'), 'utf8'), /createRequire\(import\.meta\.resolve\("@anthropic-ai\/claude-agent-sdk"\)\)/);
  await writeFile(path.join(claudeDist, 'probe.mjs'), "import { createRequire } from 'node:module';\n"
    + "console.log(createRequire(import.meta.resolve('@anthropic-ai/claude-agent-sdk')).resolve(process.argv[2]));\n");
  const probe = spawnSync(process.execPath, [path.join(claudeDist, 'probe.mjs'), `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`], { encoding: 'utf8' });
  assert.equal(probe.stdout.trim(), path.join(modules, '@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`, 'claude'), probe.stderr);
});
