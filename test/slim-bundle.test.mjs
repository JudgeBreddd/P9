// U8 (threat model row 50 U8 and U9): the slim Temporary P9 a remote gets. Built from this checkout as an unpackaged app
// builds it (bundle-daemon.mjs slimBundle), sent as remote-install.mjs slimArchive sends it, unpacked outside this checkout
// (no node_modules above it), and started there with no source. Its agents' fetcher (scripts/agents.mjs) installs only a
// package whose sha512 matches the pin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { slimBundle } from '../scripts/bundle-daemon.mjs';
import { slimArchive } from '../apps/desktop/remote-install.mjs';
import { authenticated, daemon, http, root } from './helpers.mjs';

const skip = process.platform === 'win32' ? 'sh and tar' : false;
const run = (command, args, options = {}) => new Promise((resolve) => execFile(command, args, { timeout: 60000, ...options }, (error, out, err) => resolve({ code: error?.code ?? 0, out: out + err })));
async function size(dir) {
  let bytes = 0, files = 0;
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) { bytes += (await stat(path.join(entry.parentPath, entry.name))).size; files++; }
  }
  return { bytes, files };
}
const mb = (bytes) => (bytes / 1048576).toFixed(1) + ' MiB';

test('U8: the slim bundle holds the daemon and its helpers only, pins both Linux arches\' agents from the lockfile, and starts with no source', { skip, timeout: 240000 }, async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'p9-slimb-')), folder = await slimBundle(root, tmp);
  // Sent: what the remote gets over ssh.
  const tgz = path.join(tmp, 'slim.tar.gz');
  await new Promise((resolve, reject) => { const out = spawn('sh', ['-c', 'cat > "$0"', tgz], { stdio: ['pipe', 'ignore', 'ignore'] }); slimArchive(folder).pipe(out.stdin); out.once('close', resolve); out.once('error', reject); });
  const there = path.join(tmp, 'remote');
  await mkdir(there);
  assert.equal((await run('tar', ['-xzf', tgz, '-C', there])).code, 0);
  const sent = await size(there), archive = (await stat(tgz)).size;
  // Never the source, docs or agent files; never this computer's agents' binaries.
  const names = (await readdir(there, { recursive: true })).map((n) => n.split(path.sep).join('/'));
  for (const bad of ['AGENTS.md', 'CLAUDE.md', 'README.md', 'docs', 'apps/web', 'apps/server/chat.mjs', 'node_modules/@openai/codex-linux-x64', 'node_modules/@anthropic-ai/claude-agent-sdk-linux-x64', 'test'])
    assert.ok(!names.includes(bad), bad + ' was sent');
  for (const good of ['apps/server/main.mjs', 'apps/server/mcp-relay.mjs', 'apps/desktop/tools.sh', 'apps/desktop/editor-host.mjs', 'scripts/install.sh', 'scripts/background.sh', 'scripts/agents.mjs', 'scripts/install-editor.mjs', 'scripts/deps.mjs', 'agents.json', 'NOTICES.md', 'LICENSE'])
    assert.ok(names.includes(good), good + ' is missing');
  // The pins: linux-x64 and linux-arm64 (an arm64 server), each codex and claude, at this checkout's versions and lockfile hashes.
  const lock = await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8'), pins = JSON.parse(await readFile(path.join(there, 'agents.json'), 'utf8'));
  assert.deepEqual(Object.keys(pins).sort(), ['linux-arm64', 'linux-x64']);
  const codexVersion = JSON.parse(await readFile(path.join(there, 'node_modules', '@openai', 'codex', 'package.json'), 'utf8')).version;
  const sdkVersion = JSON.parse(await readFile(path.join(there, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')).version;
  for (const [arch, list] of Object.entries(pins)) {
    assert.deepEqual(list.map((p) => p.folder), ['@openai/codex-' + arch, '@anthropic-ai/claude-agent-sdk-' + arch]);
    assert.equal(list[0].url, 'https://registry.npmjs.org/@openai/codex/-/codex-' + codexVersion + '-' + arch + '.tgz');
    assert.equal(list[1].url, 'https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-' + arch + '/-/claude-agent-sdk-' + arch + '-' + sdkVersion + '.tgz');
    for (const p of list) assert.ok(/^sha512-/.test(p.integrity) && lock.includes('resolution: {integrity: ' + p.integrity), p.folder);
  }
  // What the remote fetches itself for this arch, measured from this checkout's own copies (no network here).
  let agents = 0;
  for (const p of pins['linux-' + process.arch] ?? []) {
    const dir = path.join(root, 'node_modules', '.pnpm');
    const found = (await readdir(dir)).find((n) => n.startsWith(p.folder.replace('/', '+') + '@'));
    if (found) agents += (await size(path.join(dir, found, 'node_modules', p.folder))).bytes;
  }
  console.log('P9_SLIM sent ' + mb(archive) + ' compressed, ' + mb(sent.bytes) + ' in ' + sent.files + ' files unpacked; the agents for linux-' + process.arch + ' it fetches: ' + mb(agents));
  // It starts from there: no checkout, no node_modules above it.
  const started = await daemon(t, path.join(there, 'apps', 'server', 'main.mjs'));
  const health = await http({ socketPath: started.credentials.socketPath, headers: authenticated(started.credentials) });
  assert.equal(health.status, 200, JSON.stringify(health));
  assert.equal(JSON.parse(health.text).version, JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version);
  // Builder, 2026-11-02: the desktop's agents fetch after connecting (no network here): a body that picks none or is not
  // booleans is refused; a checkout's daemon, with no agents.json, says it is not a bundle.
  const fetchAgents = (d, body) => http({ socketPath: d.credentials.socketPath, method: 'POST', route: '/setup/agents-fetch',
    headers: { ...authenticated(d.credentials), 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await fetchAgents(started, { claude: false, codex: false })).status, 400);
  assert.equal((await fetchAgents(started, { claude: 'yes', codex: true })).status, 400);
  const checkout = await fetchAgents(await daemon(t), { claude: true, codex: false });
  assert.deepEqual([checkout.status, JSON.parse(checkout.text).error], [409, 'not-a-bundle']);
});

// A stand-in for registry.npmjs.org: P9_AGENTS_FROM, a folder of .tgz files, with the same check.
async function agentsStage(tamper, args = []) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-agents-')), p9 = path.join(dir, 'p9'), from = path.join(dir, 'from');
  await mkdir(path.join(p9, 'scripts'), { recursive: true }); await mkdir(path.join(dir, 'pkg', 'package'), { recursive: true }); await mkdir(from);
  await cp(path.join(root, 'scripts', 'agents.mjs'), path.join(p9, 'scripts', 'agents.mjs'));
  await writeFile(path.join(dir, 'pkg', 'package', 'codex'), 'the binary\n');
  await writeFile(path.join(dir, 'pkg', 'package', 'package.json'), '{"version":"1.0.0-linux"}');
  assert.equal((await run('tar', ['-czf', path.join(from, 'codex-1.0.0-linux.tgz'), '-C', path.join(dir, 'pkg'), 'package'])).code, 0);
  const bytes = await readFile(path.join(from, 'codex-1.0.0-linux.tgz'));
  const integrity = 'sha512-' + createHash('sha512').update(tamper ? Buffer.concat([bytes, Buffer.from('x')]) : bytes).digest('base64');
  await writeFile(path.join(p9, 'agents.json'), JSON.stringify({ [process.platform + '-' + process.arch]: [{ folder: '@openai/codex-linux', url: 'https://registry.npmjs.org/@openai/codex/-/codex-1.0.0-linux.tgz', integrity }] }));
  const result = await run(process.execPath, [path.join(p9, 'scripts', 'agents.mjs'), ...args], { env: { ...process.env, P9_AGENTS_FROM: from } });
  return { ...result, dir, p9, from, modules: path.join(p9, 'node_modules') };
}

test('U8 agents.mjs: a package matching its pinned sha512 is installed for this machine', { skip, timeout: 30000 }, async () => {
  const s = await agentsStage(false);
  assert.equal(s.code, 0, s.out);
  assert.equal(await readFile(path.join(s.modules, '@openai', 'codex-linux', 'codex'), 'utf8'), 'the binary\n');
  assert.deepEqual((await readdir(s.modules)).filter((n) => n.startsWith('.agents-')), []);
});

test('U8 agents.mjs: a package that does not match its pin installs nothing and fails the install', { skip, timeout: 30000 }, async () => {
  const s = await agentsStage(true);
  assert.equal(s.code, 1, s.out);
  assert.match(s.out, /does not match its pinned checksum; nothing was installed/);
  assert.equal(existsSync(path.join(s.modules, '@openai')), false);
  assert.deepEqual((await readdir(s.modules)).filter((n) => n.startsWith('.agents-')), []);
});

// Builder, 2026-11-02: the slim install keeps the agents the old one had (install.sh --slim runs --keep), and the desktop
// fetches only the ones the owner picked once connected (POST /setup/agents-fetch runs agents.mjs claude and/or codex).
test('agents.mjs: fetches only the agents named, skips one already there, and --keep links the old install\'s instead of downloading', { skip, timeout: 30000 }, async () => {
  const s = await agentsStage(false, ['claude']), script = path.join(s.p9, 'scripts', 'agents.mjs');
  assert.equal(s.code, 0, s.out);
  assert.equal(existsSync(path.join(s.modules, '@openai')), false, 'codex was not picked');
  const again = (args, env = {}, cwd = s.p9) => run(process.execPath, [path.join(cwd, 'scripts', 'agents.mjs'), ...args], { env: { ...process.env, P9_AGENTS_FROM: s.from, ...env } });
  assert.equal((await again(['codex'])).code, 0);
  const binary = path.join(s.modules, '@openai', 'codex-linux', 'codex');
  assert.equal(await readFile(binary, 'utf8'), 'the binary\n');
  // Already there at its pinned version: nothing is read (an empty P9_AGENTS_FROM would fail a download).
  const empty = path.join(s.dir, 'empty'); await mkdir(empty);
  const skipped = await again([], { P9_AGENTS_FROM: empty });
  assert.equal(skipped.code, 0, skipped.out);
  // A new install beside it keeps the old one's, linked, with no download and none named.
  const next = path.join(s.dir, 'next');
  await mkdir(path.join(next, 'scripts'), { recursive: true });
  await cp(script, path.join(next, 'scripts', 'agents.mjs')); await cp(path.join(s.p9, 'agents.json'), path.join(next, 'agents.json'));
  const kept = await again(['--keep', s.p9], { P9_AGENTS_FROM: empty }, next);
  assert.equal(kept.code, 0, kept.out);
  assert.match(kept.out, /\(kept\)/);
  assert.equal((await stat(path.join(next, 'node_modules', '@openai', 'codex-linux', 'codex'))).ino, (await stat(binary)).ino);
  // --keep with nothing to keep fetches nothing.
  const none = path.join(s.dir, 'none');
  await mkdir(path.join(none, 'scripts'), { recursive: true });
  await cp(script, path.join(none, 'scripts', 'agents.mjs')); await cp(path.join(s.p9, 'agents.json'), path.join(none, 'agents.json'));
  assert.equal((await again(['--keep', empty], { P9_AGENTS_FROM: empty }, none)).code, 0);
  assert.equal(existsSync(path.join(none, 'node_modules', '@openai')), false);
});
