// A3 (0.1.9): the pace mark. Each plan window is a row: how much is left, a bar with a tick where even use would be now,
// a word for ahead / on pace / room to spare, and the time to the reset. The panel's Usage button opens the rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, root } from './helpers.mjs';
import { paceOf, paceRow, countdown, planWindows } from '../apps/web/src/helpers.mjs';
import { planLimits } from '../apps/server/limits.mjs';
import { readOnce, createCodexUsage } from '../apps/server/codex-usage.mjs';
import { http, authenticated } from './helpers.mjs';
const call = (instance, route) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, headers: authenticated(instance.credentials) }).then((answer) => JSON.parse(answer.text));

const HOUR = 3600000, NOW = Date.UTC(2026, 10, 10, 12);
const round = (pace) => pace && { elapsed: Math.round(pace.elapsed * 1000) / 1000, gap: Math.round(pace.gap * 10) / 10, state: pace.state };

test('pace: the clock\'s share of the window against the share used', () => {
  // A 5 h window that resets in 1 h is 80% gone.
  const w = (used, left, mins) => ({ usedPercent: used, resetsAt: NOW + left, windowMins: mins });
  assert.deepEqual(round(paceOf(w(80, HOUR), 300, NOW)), { elapsed: 0.8, gap: 0, state: 'on' });
  assert.deepEqual(round(paceOf(w(85, HOUR), 300, NOW)), { elapsed: 0.8, gap: 5, state: 'on' }, '5 points over is still on pace');
  assert.deepEqual(round(paceOf(w(86, HOUR), 300, NOW)), { elapsed: 0.8, gap: 6, state: 'ahead' });
  assert.deepEqual(round(paceOf(w(74, HOUR), 300, NOW)), { elapsed: 0.8, gap: -6, state: 'headroom' });
  // The window's own length wins over the caller's; a week with 42 h left is 75% gone.
  assert.deepEqual(round(paceOf(w(30, 42 * HOUR, 10080), 300, NOW)), { elapsed: 0.75, gap: -45, state: 'headroom' });
  // A reset further away than the window is long is the window's start, not a negative share.
  assert.equal(paceOf(w(3, 6 * HOUR), 300, NOW).elapsed, 0);
  // Nothing to measure against: no window, no reset time, a reset already passed.
  assert.equal(paceOf(null, 300, NOW), null);
  assert.equal(paceOf({ usedPercent: 40, resetsAt: null }, 300, NOW), null);
  assert.equal(paceOf(w(40, -1), 300, NOW), null);
  assert.deepEqual([countdown(102 * 60000), countdown(76 * HOUR), countdown(12 * 60000), countdown(-5)], ['1h 42m', '3d 4h', '12m', '0m']);
  console.log('PASS pace math: on at 0 and +5, ahead at +6, headroom at -6; a week 75% gone; null with no reset to measure against');
});

test('pace: one row says what is left, the pace, where the tick is and when it resets', () => {
  const row = paceRow('Session', { usedPercent: 91, resetsAt: NOW + HOUR, windowMins: 300 }, 300, NOW);
  assert.match(row, /data-pace="ahead" data-hot="2"/);
  assert.match(row, /<b>9% left<\/b><span class="prow-p" title="[^"]+runs out before the reset">Over pace<\/span>/);
  assert.match(row, /resets in 1h 0m<\/span>/);
  assert.match(row, /<i style="width:91%"><\/i><u style="left:80%"><\/u>/, 'the fill is what is used, the tick is where the clock is');
  assert.match(row, /aria-label="Session: 91% used, 80% of the window gone\./);
  // A window that has reset: all of it is left, no tick. One never recorded: said so.
  const fresh = paceRow('Weekly', { usedPercent: 61, resetsAt: NOW - HOUR }, 10080, NOW);
  assert.match(fresh, /<b>100% left<\/b><span class="prow-p">new window<\/span>/); assert.doesNotMatch(fresh, /<u |data-pace|resets in/);
  assert.match(paceRow('Weekly', null, 10080, NOW), /<b>—<\/b><span class="prow-p">not recorded<\/span>/);
  // A window with no reset time keeps its figure and has no tick.
  const bare = paceRow('Session', { usedPercent: 20, resetsAt: null }, 300, NOW);
  assert.match(bare, /<b>80% left<\/b>/); assert.doesNotMatch(bare, /<u |data-pace/);
  // A model's name comes from the daemon: it is text, never markup.
  const rows = planWindows({ fiveHour: null, sevenDay: null, models: [{ name: '<b>x', usedPercent: 1, resetsAt: null }] });
  assert.deepEqual(rows.map((r) => r[0]), ['Session', 'Weekly', 'Weekly · <b>x']);
  assert.doesNotMatch(paceRow(...rows[2], NOW), /<b>x/);
  console.log('PASS pace row: 9% left, Over pace, tick at 80%, resets in 1h 0m; reset window 100% left with no tick; unrecorded said so');
});

test('pace: the daemon says how long each window is, and keeps a plan\'s per-model week windows', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-pace-'));
  const at = (hours) => new Date(Date.now() + hours * HOUR).toISOString();
  const limits = await planLimits({ home, claudePolled: { at: Date.now(), windows: { five_hour: { utilization: 12, resets_at: at(2) }, seven_day: { utilization: 40, resets_at: at(50) },
    seven_day_opus: { utilization: 55, resets_at: at(50) }, seven_day_sonnet: null, 'seven_day_<i>': { utilization: 1, resets_at: at(1) } } } });
  assert.deepEqual([limits.claude.fiveHour.windowMins, limits.claude.sevenDay.windowMins], [300, 10080]);
  assert.deepEqual(limits.claude.models.map((m) => [m.name, m.usedPercent, m.windowMins]), [['opus', 55, 10080]], 'only a named window with a reading');
  const day = path.join(home, '.codex', 'sessions', '2026', '11', '10');
  await mkdir(day, { recursive: true });
  await writeFile(path.join(day, 'rollout-a.jsonl'), JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'token_count', rate_limits: {
    primary: { used_percent: 61, window_minutes: 300, resets_at: Math.round((Date.now() + HOUR) / 1000) }, secondary: { used_percent: 33, window_minutes: 10080, resets_at: Math.round((Date.now() + 90 * HOUR) / 1000) } } } }) + '\n');
  const codex = (await planLimits({ home })).codex;
  assert.deepEqual([codex.fiveHour.windowMins, codex.sevenDay.windowMins, codex.models], [300, 10080, undefined]);
  console.log('PASS window lengths: Claude 300 / 10080 with Opus\'s week kept, Codex 300 / 10080');
});

// Claude: 5 h window with 1 h left (80% gone), 42% used: room to spare. Week with 42 h left (75% gone), 90% used: over pace.
// Codex: its 5 h window already reset.
async function seed(home) {
  const now = Date.now();
  await writeFile(path.join(home, '.claude.json'), JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: now,
    utilization: { five_hour: { utilization: 42, resets_at: new Date(now + HOUR).toISOString() }, seven_day: { utilization: 90, resets_at: new Date(now + 42 * HOUR).toISOString() } } } }));
  const day = path.join(home, '.codex', 'sessions', '2026', '11', '10');
  await mkdir(day, { recursive: true });
  await writeFile(path.join(home, '.codex', 'auth.json'), '{}');
  await writeFile(path.join(day, 'rollout-a.jsonl'), JSON.stringify({ timestamp: new Date(now).toISOString(), type: 'event_msg', payload: { type: 'token_count', rate_limits: {
    primary: { used_percent: 61, window_minutes: 300, resets_at: Math.round((now - HOUR) / 1000) }, secondary: { used_percent: 33, window_minutes: 10080, resets_at: Math.round((now + 84 * HOUR) / 1000) } } } }) + '\n');
}

test('window: the panel\'s Usage button opens each plan\'s rows from Chat Focus, with the tick where the clock is', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async ({ directory }) => { await seed(directory); return { args: ['--acp-override', path.join(root, 'test/fake-acp-agent.mjs')] }; });
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + await mkdtemp(path.join(os.tmpdir(), 'p9-pace-profile-'))], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('#rChat').waitFor();
  const shot = async (name) => { if (!process.env.GITHUB_ACTIONS) { await page.waitForTimeout(400); console.log('P9_SHOT ' + name + ' ' + (await page.screenshot()).toString('base64')); } };
  assert.equal(await page.locator('.shell').getAttribute('data-focus'), 'chat');
  // The button sits in the panel's foot, between Commands and Collapse, and is three bars.
  const foot = await page.locator('.p-foot > *').evaluateAll((l) => l.filter((e) => e.id).map((e) => e.id));
  assert.ok(foot.indexOf('rUsage') > foot.indexOf('rCmd') && foot.indexOf('rUsage') < foot.indexOf('collapse'), 'foot order: ' + foot);
  assert.equal(await page.locator('#rUsage svg path').count(), 3);
  await page.click('#rUsage');
  const claude = page.locator('#mdl .uagent[data-agent="claude"]');
  await claude.locator('.prow').first().waitFor({ timeout: 15000 });
  assert.equal(await page.locator('#mdlT').innerText(), 'Usage');
  const read = (agent) => page.locator(`#mdl .uagent[data-agent="${agent}"] .prow`).evaluateAll((rows) => rows.map((r) => { const bar = r.querySelector('.pbar').getBoundingClientRect(), tick = r.querySelector('.pbar u')?.getBoundingClientRect(), fill = r.querySelector('.pbar i').getBoundingClientRect();
    return { label: r.querySelector('.prow-l').textContent, left: r.querySelector('.prow-h b').textContent, word: r.querySelector('.prow-p').textContent, reset: r.querySelector('.prow-r')?.textContent ?? '', pace: r.dataset.pace ?? '',
      fill: Math.round(fill.width / bar.width * 100), tick: tick ? Math.round((tick.left + tick.width / 2 - bar.left) / bar.width * 100) : null, shown: !!tick && tick.height > bar.height }; }));
  const [session, weekly] = await read('claude');
  assert.deepEqual({ ...session, reset: '' }, { label: 'Session', left: '58% left', word: 'Room to spare', reset: '', pace: 'headroom', fill: 42, tick: 80, shown: true });
  assert.match(session.reset, /^resets in (1h 0m|59m|58m)$/);
  assert.deepEqual({ ...weekly, reset: '' }, { label: 'Weekly', left: '10% left', word: 'Over pace', reset: '', pace: 'ahead', fill: 90, tick: 75, shown: true });
  assert.match(weekly.reset, /^resets in 1d 1[78]h$/);
  const [codexSession, codexWeekly] = await read('codex');
  assert.deepEqual([codexSession.left, codexSession.word, codexSession.tick, codexWeekly.left, codexWeekly.tick], ['100% left', 'new window', null, '67% left', 50]);
  await shot('usage-window');
  await page.keyboard.press('Escape');
  // Also from Ctrl K, and with the panel collapsed to its strip.
  await page.keyboard.press('Control+b');
  await page.locator('.lpanel[data-collapsed]').waitFor({ timeout: 5000 });
  assert.ok(await page.locator('#rUsage').isVisible(), 'the Usage button is gone from the collapsed strip');
  await page.keyboard.press('Control+k'); await page.fill('#palIn', 'usage'); await page.keyboard.press('Enter');
  await claude.locator('.prow').first().waitFor({ timeout: 10000 });
  await shot('usage-window-strip');
  assert.deepEqual(errors, []);
  console.log('PASS usage window: Claude Session 58% left, Room to spare, tick at 80%; Weekly 10% left, Over pace, tick at 75%; Codex new window with no tick');
});

// The live Codex read: one Codex account used on several computers moves the windows where this computer's session
// files cannot see it, so the daemon asks Codex itself.
const fakeCodex = path.join(root, 'test/fake-codex-app-server.mjs');
// The read starts Codex with P9's own short list of environment names, so a mode reaches the stand-in through a small
// file that sets it and then loads the stand-in.
const inMode = async (mode) => { const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-pace-fake-')), mode + '.mjs'); await writeFile(file, `process.env.FAKE_CODEX_USAGE = ${JSON.stringify(mode)};\nawait import(${JSON.stringify(fakeCodex)});\n`); return file; };
test('codex read: one call answers both windows; an error or a silent Codex leaves the session files as the source', { timeout: 30000 }, async () => {
  const windows = await readOnce(fakeCodex);
  assert.deepEqual([windows.primary.usedPercent, windows.primary.windowDurationMins, windows.secondary.usedPercent, windows.secondary.windowDurationMins], [12, 300, 88, 10080]);
  // The error's own text can name the account: it never reaches the log.
  const lines = [];
  {
    const signedOut = await inMode('signed-out');
    await assert.rejects(readOnce(signedOut), /^Error: no plan limits/);
    const usage = createCodexUsage({ read: () => readOnce(signedOut), log: (line) => lines.push(line), wait: () => new Promise(() => {}) });
    usage.look();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(usage.look(), null);
  }
  assert.deepEqual(lines, ['codex usage: no plan limits (signed out, or not a ChatGPT plan); the meters keep their other sources']);
  const started = Date.now();
  await assert.rejects(readOnce(await inMode('hang'), 700), /^Error: timed out$/);
  assert.ok(Date.now() - started < 5000, 'a silent Codex is given up on at the time limit');
  console.log('PASS codex read: 12% and 88% from one call; an error logs one line with no account in it; a silent Codex times out');
});

test('codex read: the newer reading wins, the daemon\'s own or the session files\'', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-pace-codex-')), now = Date.now();
  const day = path.join(home, '.codex', 'sessions', '2026', '11', '10');
  await mkdir(day, { recursive: true });
  const fileAt = now - 3 * HOUR;
  await writeFile(path.join(day, 'rollout-a.jsonl'), JSON.stringify({ timestamp: new Date(fileAt).toISOString(), payload: { rate_limits: {
    primary: { used_percent: 5, window_minutes: 300, resets_at: Math.round((now + HOUR) / 1000) }, secondary: { used_percent: 33, window_minutes: 10080, resets_at: Math.round((now + 50 * HOUR) / 1000) } } } }) + '\n');
  const windows = { primary: { usedPercent: 71, windowDurationMins: 10080, resetsAt: Math.round((now + 50 * HOUR) / 1000) }, secondary: { usedPercent: 40, windowDurationMins: 300, resetsAt: Math.round((now + HOUR) / 1000) } };
  const figures = (l) => l && [l.fiveHour?.usedPercent, l.sevenDay?.usedPercent, l.sevenDay?.windowMins, l.asOf];
  // Told by its length, not its slot: here the week came first.
  assert.deepEqual(figures((await planLimits({ home, codexPolled: { windows, at: now } })).codex), [40, 71, 10080, now]);
  assert.deepEqual(figures((await planLimits({ home, codexPolled: { windows, at: fileAt - 1 } })).codex), [5, 33, 10080, fileAt], 'an older read does not hide a newer session file');
  assert.deepEqual(figures((await planLimits({ home, codexPolled: null })).codex), [5, 33, 10080, fileAt]);
  assert.deepEqual(figures((await planLimits({ home: path.join(home, 'none'), codexPolled: { windows, at: now } })).codex), [40, 71, 10080, now], 'no session file at all');
  assert.equal((await planLimits({ home: path.join(home, 'none'), codexPolled: { windows: { primary: { usedPercent: 9, windowDurationMins: 60 } }, at: now } })).codex, null, 'a window of another length is not shown as one of ours');
});

test('codex read: the daemon shows Codex\'s own figures with no session file on this computer', { timeout: 60000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', path.join(root, 'test/fake-acp-agent.mjs'), '--codex-usage', fakeCodex] }));
  // Signed in, with no session folder: a signed-out Codex shows no figures at all.
  await mkdir(path.join(instance.directory, '.codex'), { recursive: true });
  await writeFile(path.join(instance.directory, '.codex', 'auth.json'), '{}');
  let limits;
  for (let i = 0; i < 40 && !limits?.codex; i += 1) { limits = (await call(instance, '/usage')).limits; if (!limits?.codex) await new Promise((resolve) => setTimeout(resolve, 250)); }
  assert.deepEqual([limits.codex?.fiveHour?.usedPercent, limits.codex?.sevenDay?.usedPercent, limits.codex?.fiveHour?.windowMins], [12, 88, 300]);
  assert.ok(Date.now() - limits.codex.asOf < 30000, 'read just now');
  console.log('PASS codex read through the daemon: 12% and 88% with no session file');
});
