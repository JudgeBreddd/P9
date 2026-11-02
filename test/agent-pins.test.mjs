// U8: the slim remote's agent pins (agents.json) come from pnpm-lock.yaml. A Windows checkout has CRLF line ends
// (core.autocrlf, as GitHub's Windows runners set it), and pnpm package:win builds the same pins there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { agentPins } from '../scripts/bundle-daemon.mjs';

test('agent pins read a CRLF pnpm-lock.yaml the same as an LF one', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-pins-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const codex = path.join(dir, 'codex'), sdk = path.join(dir, 'sdk');
  for (const [folder, version] of [[codex, '1.2.3'], [sdk, '0.4.5']]) {
    await mkdir(folder); await writeFile(path.join(folder, 'package.json'), JSON.stringify({ version }));
  }
  const keys = ['@openai/codex@1.2.3-linux-x64', '@anthropic-ai/claude-agent-sdk-linux-x64@0.4.5', '@openai/codex@1.2.3-linux-arm64', '@anthropic-ai/claude-agent-sdk-linux-arm64@0.4.5'];
  const sums = keys.map((key, i) => 'sha512-' + String.fromCharCode(65 + i).repeat(86) + '==');
  const lock = "lockfileVersion: '9.0'\n\npackages:\n" + keys.map((key, i) => "\n  '" + key + "':\n    resolution: {integrity: " + sums[i] + '}\n    cpu: [x64]\n').join('');
  const pins = async (text) => { await writeFile(path.join(dir, 'pnpm-lock.yaml'), text); return agentPins(dir, codex, sdk); };
  const lf = await pins(lock);
  assert.deepEqual(lf['linux-x64'].map((p) => p.integrity), [sums[0], sums[1]]);
  assert.deepEqual(lf['linux-arm64'].map((p) => p.integrity), [sums[2], sums[3]]);
  assert.equal(lf['linux-x64'][0].url, 'https://registry.npmjs.org/@openai/codex/-/codex-1.2.3-linux-x64.tgz');
  assert.deepEqual(await pins(lock.replace(/\n/g, '\r\n')), lf, 'the CRLF lockfile gives the same pins');
  console.log('PASS agent pins: LF and CRLF lockfiles give the same 4 pins');
});
