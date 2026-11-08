// B10: the daemon ships as two bundles plus the agents' native packages, not a hoisted install of the whole workspace
// (0.1.3 unpacked 26,028 files under daemon/node_modules, every web dependency included). Each bundle sits at its old
// path, so every lookup relative to import.meta.url still resolves: windows-host.ps1 and adapterEntry from
// apps/server, and claude-agent-acp's import.meta.resolve('@anthropic-ai/claude-agent-sdk') that finds claude.exe.
import { access, cp, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { rolldown } from 'rolldown';

// Node's own lookup: the nearest node_modules/<name> above the package's real (pnpm store) folder.
async function packageDir(from, name) {
  for (let dir = await realpath(from); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (await access(candidate).then(() => true, () => false)) return realpath(candidate);
    if (dir === path.dirname(dir)) throw new Error(`package-not-found:${name}`);
  }
}

async function bundle(input, file) {
  const warnings = [];
  const build = await rolldown({ input, platform: 'node', onLog: (level, log) => { if (level === 'warn') warnings.push(log.code + ': ' + log.message); } });
  // A warning (an import it could not resolve, say) fails the package instead of shipping a daemon that throws at runtime.
  if (warnings.length) throw new Error('bundle-warnings:\n' + warnings.join('\n'));
  const { output: [chunk] } = await build.write({ file, format: 'esm', codeSplitting: false });
  await build.close();
  return chunk.moduleIds;
}

// Codex's rg.exe (its file search, on PATH from codex-path) imports vcruntime140.dll on Windows arm64, which a Windows
// without the VC++ runtime lacks, and Codex ships no copy beside it (bare-windows, CI run 40611561200). Its voice/bin
// carries the same arch's copy, and Windows loads a DLL from the exe's own folder first, so no admin install is needed.
// A Codex that stops shipping that copy fails the package here instead of an installed P9's file search.
export async function appLocalRuntime(vendor) {
  for (const triple of await readdir(vendor)) {
    await cp(path.join(vendor, triple, 'codex-resources', 'voice', 'bin', 'vcruntime140.dll'), path.join(vendor, triple, 'codex-path', 'vcruntime140.dll'));
  }
}

// U8: the agents' binary packages for each Linux arch the slim Temporary P9 runs on, by exact version with the sha512
// integrity pnpm-lock.yaml pins (the same check pnpm install --frozen-lockfile makes), for scripts/agents.mjs on the remote.
// codex and sdk: the installed packages' folders; a version the lockfile does not pin stops the build.
// ponytail: glibc only (Node's own Linux builds are glibc too), so no musl entries.
export async function agentPins(root, codex, sdk) {
  // A Windows checkout (core.autocrlf, as GitHub's Windows runners set it) has CRLF line ends; the keys are found by \n.
  const lock = (await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8')).replace(/\r\n/g, '\n');
  const version = async (dir) => JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')).version;
  const codexVersion = await version(codex), sdkVersion = await version(sdk);
  const pins = {};
  for (const arch of ['x64', 'arm64']) {
    const wanted = [['@openai/codex-linux-' + arch, '@openai/codex@' + codexVersion + '-linux-' + arch],
      ['@anthropic-ai/claude-agent-sdk-linux-' + arch, '@anthropic-ai/claude-agent-sdk-linux-' + arch + '@' + sdkVersion]];
    pins['linux-' + arch] = wanted.map(([folder, key]) => {
      const at = lock.indexOf("\n  '" + key + "':\n    resolution: {integrity: ");
      const integrity = at < 0 ? null : /^sha512-[A-Za-z0-9+/]+=*/.exec(lock.slice(lock.indexOf('integrity: ', at) + 11))?.[0];
      if (!integrity) throw new Error('agent-pin-not-in-lockfile:' + key);
      const name = key.slice(0, key.lastIndexOf('@')), exact = key.slice(key.lastIndexOf('@') + 1);
      return { folder, url: 'https://registry.npmjs.org/' + name + '/-/' + name.split('/')[1] + '-' + exact + '.tgz', integrity };
    });
  }
  return pins;
}

// U8: what the slim Temporary P9 needs beside the bundles (remote-install.mjs SLIM): its install and start scripts, tmux's
// and the editor server's installers, and the agents' fetcher. Each imports only Node's standard library and these.
const SLIM_FILES = ['scripts/install.sh', 'scripts/background.sh', 'scripts/deps.mjs', 'scripts/install-editor.mjs', 'scripts/agents.mjs',
  'apps/desktop/tools.sh', 'apps/desktop/editor-host.mjs', 'apps/server/process-tree.mjs', 'package.json', 'LICENSE'];

// platform is the agents' binary package suffix, win32-x64 or win32-arm64 for an installer; null for none (U8: the slim
// Temporary P9, whose remote fetches its own). Returns the notices of every package inlined into a bundle, which lose their
// own licence files; out/NOTICES.md gets them too.
export async function bundleDaemon(root, out, platform) {
  for (const folder of ['apps', 'node_modules']) await rm(path.join(out, folder), { recursive: true }).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  const modules = await bundle(path.join(root, 'apps', 'server', 'main.mjs'), path.join(out, 'apps', 'server', 'main.mjs'));
  // The P9 MCP relay runs as its own process beside main.mjs (chat.mjs). The daemon's teh.mjs (doctor, and the AppImage's
  // install-service.mjs) imports windows.mjs and child-env.mjs from here, and child-env.mjs imports deps.mjs (run8 caught
  // its absence: the doctor could not start). telemetry.mjs and memory.mjs are worker threads, loaded by path (memory.mjs imports secret-rules.mjs). All seven import
  // only Node's standard library and each other.
  for (const file of ['mcp-relay.mjs', 'windows.mjs', 'child-env.mjs', 'deps.mjs', 'telemetry.mjs', 'memory.mjs', 'secret-rules.mjs']) await cp(path.join(root, 'apps', 'server', file), path.join(out, 'apps', 'server', file));
  const modulesDir = path.join(out, 'node_modules');
  const claudeAcp = await packageDir(root, '@agentclientprotocol/claude-agent-acp');
  modules.push(...await bundle(path.join(claudeAcp, 'dist', 'index.js'), path.join(modulesDir, '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js')));
  const sdk = await packageDir(claudeAcp, '@anthropic-ai/claude-agent-sdk');
  const codexAcp = await packageDir(root, '@agentclientprotocol/codex-acp');
  const codex = await packageDir(codexAcp, '@openai/codex');
  // codex-acp is already one bundle; codex.js finds its binary package by require.resolve, and claude-agent-acp finds
  // claude.exe through import.meta.resolve of the SDK, which reads only its package.json (sdk.mjs itself is inlined).
  // claude-usage.mjs imports sdk.mjs at run time by path (the Claude 5 h meter), so it ships too; 0.3.293's sdk.mjs
  // imports only Node's standard library.
  const copies = [
    [claudeAcp, '@agentclientprotocol/claude-agent-acp', ['package.json', 'LICENSE']],
    [sdk, '@anthropic-ai/claude-agent-sdk', ['package.json', 'LICENSE.md', 'sdk.mjs']],
    [codexAcp, '@agentclientprotocol/codex-acp'],
    [codex, '@openai/codex'],
    ...platform ? [[await packageDir(codex, `@openai/codex-${platform}`), `@openai/codex-${platform}`],
      [await packageDir(sdk, `@anthropic-ai/claude-agent-sdk-${platform}`), `@anthropic-ai/claude-agent-sdk-${platform}`]] : [],
  ];
  for (const [from, name, files] of copies) {
    if (!files) await cp(from, path.join(modulesDir, name), { recursive: true });
    else for (const file of files) await cp(path.join(from, file), path.join(modulesDir, name, file));
  }
  await writeFile(path.join(out, 'agents.json'), JSON.stringify(await agentPins(root, codex, sdk), null, 2) + '\n');
  for (const file of SLIM_FILES) await cp(path.join(root, file), path.join(out, file));
  if (platform?.startsWith('win32')) await appLocalRuntime(path.join(modulesDir, '@openai', `codex-${platform}`, 'vendor'));
  const packages = new Set(modules.flatMap((id) => /^(.*[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/.exec(id)?.[1] ?? []));
  let notices = '# Packages bundled into the P9 daemon\n\nEach package below is inlined into resources/daemon; its notices follow.\n';
  for (const dir of [...packages].sort()) {
    const { name, version, license } = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
    notices += `\n## ${name}@${version} (${license ?? 'no licence field'})\n`;
    for (const file of (await readdir(dir)).filter((file) => /^(licen[cs]e|notice|copying)/i.test(file)).sort()) {
      notices += `\n### ${file}\n\n${(await readFile(path.join(dir, file), 'utf8')).trim()}\n`;
    }
  }
  await writeFile(path.join(out, 'NOTICES.md'), notices);
  return notices;
}

// U8: a slim Temporary P9 built from this checkout (an unpackaged app; a packaged one has its resources/daemon), in a new
// folder under parent. -> the folder, for remote-install.mjs slimArchive; the caller removes it.
export async function slimBundle(root, parent) {
  const out = await mkdtemp(path.join(parent, 'p9-slim-'));
  await bundleDaemon(root, out, null);
  await cp(path.join(root, 'packages'), path.join(out, 'packages'), { recursive: true });
  return out;
}

