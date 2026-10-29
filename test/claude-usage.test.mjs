// Live Claude plan use (threat model row 42): the daemon's idle SDK query feeds planLimits, every failure falls back to
// the other sources, it polls only while someone looks, and the bundled SDK still has the call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClaudeUsage, sdkPath, USAGE_CALL, POLL_MS, LOOKING_MS, IDLE_MS } from '../apps/server/claude-usage.mjs';
import { planLimits } from '../apps/server/limits.mjs';

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const answer = (five, week) => ({ rate_limits_available: true, rate_limits: {
  five_hour: { utilization: five, resets_at: new Date(Date.now() + 3600e3).toISOString() },
  seven_day: { utilization: week, resets_at: new Date(Date.now() + 86400e3).toISOString() } } });
// A home whose ~/.claude.json holds an hour-old /usage reading of 80%: the source the meters had before.
async function home() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-claude-usage-'));
  await writeFile(path.join(dir, '.claude.json'), JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: Date.now() - 3600e3,
    utilization: { five_hour: { utilization: 80 }, seven_day: { utilization: 50 } } } }));
  return dir;
}
// A stand-in for the SDK query; calls counts the usage calls, closed the closes.
function standIn(call) {
  const made = { calls: 0, closed: 0, opened: 0 };
  return { made, open: async () => { made.opened++; return { ...(call && { [USAGE_CALL]: async (opts) => { made.calls++; assert.deepEqual(opts, { skipBehaviors: true }); return call(); } }), close: () => { made.closed++; } }; } };
}

test('live Claude usage: the idle query\'s answer reaches planLimits as the newest Claude reading (percent, not a fraction)', { timeout: 10000 }, async () => {
  const dir = await home(), { made, open } = standIn(() => answer(42, 12)), lines = [];
  const usage = createClaudeUsage({ open, log: (line) => lines.push(line), wait: () => new Promise(() => {}) });
  assert.equal(usage.look(), null, 'the first look starts the poll; nothing to show yet');
  await settle();
  const polled = usage.look(), limits = await planLimits({ home: dir, claudePolled: polled });
  assert.equal(limits.claude.fiveHour.usedPercent, 42);
  assert.equal(limits.claude.sevenDay.usedPercent, 12);
  assert.ok(Date.now() - limits.claude.asOf < 120000, 'under 2 minutes old');
  assert.ok(limits.claude.fiveHour.resetsAt > Date.now());
  assert.equal(made.opened, 1); assert.equal(made.calls, 1); assert.deepEqual(lines, []);
});

for (const [what, call] of [['the SDK lacks the method', null], ['the call throws', () => { throw new Error('boom'); }],
  ['the call hangs past the timeout', () => new Promise(() => {})], ['signed out or no plan', () => ({ rate_limits_available: false, rate_limits: null })]]) {
  test('live Claude usage falls back when ' + what, { timeout: 15000 }, async () => {
    const dir = await home(), { made, open } = standIn(call), lines = [];
    const usage = createClaudeUsage({ open, log: (line) => lines.push(line), wait: () => new Promise(() => {}) });
    usage.look();
    for (const end = Date.now() + 8000; !made.closed && Date.now() < end;) await settle();
    assert.equal(usage.look(), null);
    const limits = await planLimits({ home: dir, claudePolled: usage.look() });
    assert.equal(limits.claude.fiveHour.usedPercent, 80, 'the old source stays');
    assert.equal(made.closed, 1, 'the broken query is closed, to be restarted at the next poll');
    assert.equal(lines.length, 1); assert.match(lines[0], /^claude usage: .*; the meters keep their other sources$/);
  });
}

test('live Claude usage polls every minute only while someone looked in the last 2 minutes, and closes after 10 idle', { timeout: 10000 }, async () => {
  let clock = 1e12, tick = null;
  const { made, open } = standIn(() => answer(5, 5));
  const usage = createClaudeUsage({ open, now: () => clock, wait: (ms) => { assert.equal(ms, POLL_MS); return new Promise((resolve) => { tick = resolve; }); } });
  const minute = async () => { clock += POLL_MS; tick(); await settle(); };
  usage.look(); await settle();
  assert.equal(made.calls, 1);
  await minute(); assert.equal(made.calls, 2, 'looked a minute ago: polls');
  await minute(); assert.equal(made.calls, 3, 'looked 2 minutes ago: still polls');
  await minute(); assert.equal(made.calls, 3, 'nobody looked for 3 minutes: no poll');
  usage.look(); assert.equal(made.calls, 3, 'a look while the loop runs does not start a second one');
  await minute(); assert.equal(made.calls, 4);
  while (clock < 1e12 + 4 * POLL_MS + IDLE_MS && !made.closed) await minute();
  assert.equal(made.closed, 1, 'closed after 10 minutes with no look');
  assert.equal(made.calls, 4 + LOOKING_MS / POLL_MS - 1);
  usage.look(); await settle();
  assert.equal(made.opened, 2, 'the next look opens a new query');
});

test('the bundled Claude Agent SDK still declares the usage call (an SDK upgrade that drops it fails here, not silently)', { timeout: 10000 }, async () => {
  const sdk = sdkPath();
  const types = await readFile(path.join(path.dirname(sdk), 'sdk.d.ts'), 'utf8');
  assert.match(types, new RegExp(USAGE_CALL + '\\(opts\\?: \\{\\s*skipBehaviors\\?: boolean;'), 'sdk.d.ts declares ' + USAGE_CALL + '({ skipBehaviors })');
  assert.ok((await import(sdk)).query, 'the SDK exports query');
});
