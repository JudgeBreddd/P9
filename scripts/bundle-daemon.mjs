// B10: the daemon ships as two bundles plus the agents' native packages, not a hoisted install of the whole workspace
// (0.1.3 unpacked 26,028 files under daemon/node_modules, every web dependency included). Each bundle sits at its old
// path, so every lookup relative to import.meta.url still resolves: windows-host.ps1 and adapterEntry from
// apps/server, and claude-agent-acp's import.meta.resolve('@anthropic-ai/claude-agent-sdk') that finds claude.exe.
import { access, cp, readFile, readdir, realpath, rm } from 'node:fs/promises';
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

// platform is the agents' binary package suffix, win32-x64 or win32-arm64 for an installer. Returns the notices of
// every package inlined into a bundle, which lose their own licence files.
export async function bundleDaemon(root, out, platform) {
  for (const folder of ['apps', 'node_modules']) await rm(path.join(out, folder), { recursive: true }).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  const modules = await bundle(path.join(root, 'apps', 'server', 'main.mjs'), path.join(out, 'apps', 'server', 'main.mjs'));
  const modulesDir = path.join(out, 'node_modules');
  const claudeAcp = await packageDir(root, '@agentclientprotocol/claude-agent-acp');
  modules.push(...await bundle(path.join(claudeAcp, 'dist', 'index.js'), path.join(modulesDir, '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js')));
  const sdk = await packageDir(claudeAcp, '@anthropic-ai/claude-agent-sdk');
  const codexAcp = await packageDir(root, '@agentclientprotocol/codex-acp');
  const codex = await packageDir(codexAcp, '@openai/codex');
  // codex-acp is already one bundle; codex.js finds its binary package by require.resolve, and claude-agent-acp finds
  // claude.exe through import.meta.resolve of the SDK, which reads only its package.json (sdk.mjs itself is inlined).
  const copies = [
    [claudeAcp, '@agentclientprotocol/claude-agent-acp', ['package.json', 'LICENSE']],
    [sdk, '@anthropic-ai/claude-agent-sdk', ['package.json', 'LICENSE.md']],
    [codexAcp, '@agentclientprotocol/codex-acp'],
    [codex, '@openai/codex'],
    [await packageDir(codex, `@openai/codex-${platform}`), `@openai/codex-${platform}`],
    [await packageDir(sdk, `@anthropic-ai/claude-agent-sdk-${platform}`), `@anthropic-ai/claude-agent-sdk-${platform}`],
  ];
  for (const [from, name, files] of copies) {
    if (!files) await cp(from, path.join(modulesDir, name), { recursive: true });
    else for (const file of files) await cp(path.join(from, file), path.join(modulesDir, name, file));
  }
  const packages = new Set(modules.flatMap((id) => /^(.*[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/.exec(id)?.[1] ?? []));
  let notices = '# Packages bundled into the P9 daemon\n\nEach package below is inlined into resources/daemon; its notices follow.\n';
  for (const dir of [...packages].sort()) {
    const { name, version, license } = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
    notices += `\n## ${name}@${version} (${license ?? 'no licence field'})\n`;
    for (const file of (await readdir(dir)).filter((file) => /^(licen[cs]e|notice|copying)/i.test(file)).sort()) {
      notices += `\n### ${file}\n\n${(await readFile(path.join(dir, file), 'utf8')).trim()}\n`;
    }
  }
  return notices;
}

