// Live Claude plan use (5 h and 7 d), so the meters move with no P9 Claude chat running (threat model row 42). One idle
// Claude Agent SDK query asks the call claude-agent-acp's /usage uses. It runs no settings, hooks, plugins or MCP
// servers and is never sent a prompt. It polls every minute while someone looks at usage (a /usage request in the last
// 2 minutes) and closes after 10 minutes with none. Any failure leaves the other sources in limits.mjs as they were.
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { adapterEntry } from './chat.mjs';
import { childEnv } from './child-env.mjs';

// The name says it can go in any SDK release: test/claude-usage.test.mjs fails when the bundled SDK lacks it.
export const USAGE_CALL = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET';
export const POLL_MS = 60000, LOOKING_MS = 120000, IDLE_MS = 600000, TIMEOUT_MS = 5000; // 5 s: the adapter's own timeout

// The SDK claude-agent-acp itself loads, so an adapter upgrade moves both together. From the adapter's real path: pnpm
// links it, and only its real folder sees its own dependencies.
export const sdkPath = () => createRequire(realpathSync(adapterEntry('claude'))).resolve('@anthropic-ai/claude-agent-sdk');

export async function openQuery(sdk = sdkPath()) {
  const { query } = await import(pathToFileURL(sdk).href);
  // Streaming input that never yields: the process starts and answers control calls, but no turn ever runs.
  return query({ prompt: (async function* () { await new Promise(() => {}); })(), options: {
    settingSources: [], hooks: {}, mcpServers: {}, strictMcpConfig: true, plugins: [], persistSession: false, cwd: os.tmpdir(), env: childEnv() } });
}

export function createClaudeUsage({ open = openQuery, now = Date.now, log = (line) => console.error(line), wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()) } = {}) {
  let query = null, reading = null, looked = 0, running = false, said = '';
  const close = () => { try { query?.close(); } catch {} query = null; };
  async function poll() {
    try {
      query ??= await open();
      if (typeof query[USAGE_CALL] !== 'function') throw new Error('the bundled SDK has no usage call');
      let timer;
      const answer = await Promise.race([query[USAGE_CALL]({ skipBehaviors: true }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), TIMEOUT_MS); })]).finally(() => clearTimeout(timer));
      if (!answer?.rate_limits_available || !answer.rate_limits) throw new Error('no plan limits (signed out, or not a Claude plan)');
      reading = { windows: answer.rate_limits, at: now() }; said = '';
    } catch (error) {
      // One line per kind of failure, never the answer; the process is restarted at the next poll.
      if (said !== error.message) log('claude usage: ' + (said = error.message) + '; the meters keep their other sources');
      close();
    }
  }
  async function loop() {
    running = true;
    try {
      for (let idle = 0; idle < IDLE_MS; idle = now() - looked) {
        if (idle <= LOOKING_MS) await poll();
        await wait(POLL_MS);
      }
    } finally { close(); running = false; }
  }
  return {
    // A /usage request: someone is looking. Returns the last good answer ({ windows, at }) or null.
    look() { looked = now(); if (!running) void loop(); return reading; },
    close,
  };
}
