import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export function internalEndpoint(state, platform = process.platform, identity = { home: os.homedir(), user: os.userInfo().username }) {
  if (platform !== 'win32') return path.join(state, 'daemon.sock');
  const owner = createHash('sha256').update(identity.home.toLowerCase() + '\0' + identity.user.toLowerCase()).digest('hex').slice(0, 20);
  return `\\\\.\\pipe\\p9-foundation-${owner}`;
}

export function windowsStateRoot(environment = process.env, home = os.homedir()) {
  return path.join(environment.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'P9');
}

export function windowsLockEndpoint(ownershipDirectory) {
  const owner = createHash('sha256').update(ownershipDirectory.toLowerCase()).digest('hex').slice(0, 20);
  return `\\\\.\\pipe\\p9-foundation-lock-${owner}`;
}

export function missingWindowsBinaries(installed) {
  // codex 0.159+ ships its Windows binary as a version of @openai/codex itself (`@openai+codex@0.159.3-win32-x64`)
  const alias = { '@openai+codex-win32-x64@': /^@openai\+codex@[^@]*-win32-x64$/ };
  return ['@openai+codex-win32-x64@', '@anthropic-ai+claude-agent-sdk-win32-x64@']
    .filter((prefix) => !installed.some((name) => name.startsWith(prefix) || alias[prefix]?.test(name)));
}
