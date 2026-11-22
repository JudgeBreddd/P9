// CAT-1i: the desktop's agent checks and the install scripts read the agent catalog (apps/server/agents.mjs) instead of
// naming claude and codex. With the catalog's two agents nothing changes; the electron tests in agent-setup pin the
// IPC refusals, these pin that the names come from the catalog.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as catalog from '../apps/server/agents.mjs';

const { CATALOG, AGENT_IDS } = catalog;
import { agentPins } from '../scripts/bundle-daemon.mjs';
import { root } from './helpers.mjs';

const LITERAL = /['"`](claude|codex)['"`]/;

test('CAT-1i: the desktop and the install scripts name no agent; they read the catalog', async () => {
  const read = (file) => readFile(path.join(root, file), 'utf8');
  for (const file of ['apps/desktop/main.mjs', 'scripts/agents.mjs', 'scripts/bare-machine.sh']) {
    const hits = (await read(file)).split('\n').map((line, i) => [i + 1, line]).filter(([, line]) => LITERAL.test(line) && !/^\s*\/\//.test(line));
    assert.deepEqual(hits, [], file + ' names an agent instead of reading the catalog');
  }
  const main = await read('apps/desktop/main.mjs');
  assert.match(main, /import \{[^}]*\bAGENT_IDS\b[^}]*\} from '\.\.\/server\/agents\.mjs';/, 'the desktop imports the catalog');
  assert.match(main, /SIGN_IN_KIND\[name\] === 'device-code'/, 'the one-time code is shown for a device-code agent, not for a named one');
  assert.match(await read('scripts/agents.mjs'), /from '\.\.\/apps\/server\/agents\.mjs';/, 'the fetcher imports the catalog (it has no imports of its own)');
  assert.match(await read('scripts/bare-machine.sh'), /from '\.\/apps\/server\/agents\.mjs';/);
  // R2-1 (#452): a packaged app that imports agents.mjs must ship it.
  assert.ok(JSON.parse(await read('package.json')).build.files.includes('apps/server/agents.mjs'), 'build.files lists agents.mjs');
});

test('CAT-1i: each agent binary package the slim remote fetches belongs to one catalog agent', async (t) => {
  assert.equal(typeof catalog.agentOfPackage, 'function', 'no agentOfPackage: the fetcher tells a package\'s agent by its @openai/ prefix');
  const { agentOfPackage } = catalog;
  for (const a of CATALOG) assert.equal(typeof a.native, 'string', a.id + ': the binary package name before its platform');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-cat1i-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const codex = path.join(dir, 'codex'), sdk = path.join(dir, 'sdk');
  for (const [folder, version] of [[codex, '1.2.3'], [sdk, '0.4.5']]) {
    await mkdir(folder); await writeFile(path.join(folder, 'package.json'), JSON.stringify({ version }));
  }
  const keys = ['@openai/codex@1.2.3-linux-x64', '@anthropic-ai/claude-agent-sdk-linux-x64@0.4.5', '@openai/codex@1.2.3-linux-arm64', '@anthropic-ai/claude-agent-sdk-linux-arm64@0.4.5'];
  await writeFile(path.join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n\npackages:\n"
    + keys.map((key, i) => "\n  '" + key + "':\n    resolution: {integrity: sha512-" + String.fromCharCode(65 + i).repeat(86) + '==}\n').join(''));
  const pins = await agentPins(dir, codex, sdk);
  for (const arch of ['linux-x64', 'linux-arm64']) {
    assert.deepEqual(pins[arch].map((p) => agentOfPackage(p.folder)).sort(), [...AGENT_IDS].sort(), arch + ': one package per agent');
  }
  assert.equal(agentOfPackage('@someone/else-linux-x64'), null, 'a package no agent names belongs to none');
});
