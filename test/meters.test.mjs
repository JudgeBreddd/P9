// The chat meters (v0.1.5 part 2, chunk H). Real Electron, the real daemon and the fake agent, once per agent.
// MR1: every bar fills, amber from 75%. MR2: Claude's 5 h and 7 d follow its rateLimit events, Codex's follow each turn
// end, and the cache clock moves on every 15 s without a re-render.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, http, authenticated, root } from './helpers.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
// The dev space prints a screenshot as a P9_SHOT line (not on GitHub, where nobody reads it).
const shot = async (locator, name) => { if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + (await locator.screenshot({ type: 'png' })).toString('base64')); };
const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((result) => ({ status: result.status, ...JSON.parse(result.text) }));
const until = async (check, what, ms = 20000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 200))) if (await check()) return;
  assert.fail('timed out: ' + what);
};
// Codex's figure is read from its session log: a rollout whose newest rate_limits event says n% on both windows.
const rollout = (instance, n) => writeFile(path.join(instance.directory, '.codex', 'sessions', '2026', '10', '24', 'rollout-meters.jsonl'),
  JSON.stringify({ timestamp: new Date().toISOString(), payload: { rate_limits: {
    primary: { used_percent: n, window_minutes: 300, resets_at: Date.now() / 1000 + 3 * 3600 },
    secondary: { used_percent: n, window_minutes: 10080, resets_at: Date.now() / 1000 + 72 * 3600 } } } }) + '\n');

// text: the first prompt, sent before the window opens; done: the event that says it was answered; before: run then.
async function open(t, provider, { text = 'hello', done = (e) => e.data?.content?.text === 'echo:' + text, before } = {}) {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  await mkdir(path.join(instance.directory, '.codex', 'sessions', '2026', '10', '24'), { recursive: true });
  await rollout(instance, 74);
  // A signed-in Codex: without its auth.json, Usage (P8) names Codex signed out and drops its figures.
  await writeFile(path.join(instance.directory, '.codex', 'auth.json'), '{}');
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-meters-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const id = (await call(instance, '/chat', 'POST', { provider })).conversation;
  await call(instance, '/chat/' + id + '/prompt', 'POST', { text });
  await until(async () => (await call(instance, '/chat/events?after=0&only=' + id)).events.some(done), text + ' answered');
  await before?.(instance, id);
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('#rBots [data-bot="' + id + '"]').waitFor({ timeout: 15000 });
  await page.locator('#tabs .tab[data-id="' + id + '"]').click();
  const pane = page.locator('.pane[data-id="' + id + '"]');
  // The three bars: [percent shown, amber, fill painted] each.
  const bars = () => pane.locator('.meters .meter').evaluateAll((all) => all.slice(0, 3).map((m) => {
    const bar = m.querySelector('.fx-meter'), fill = getComputedStyle(bar.firstElementChild);
    return [m.querySelector('b').textContent, bar.hasAttribute('data-hot'), fill.backgroundImage !== 'none' || fill.backgroundColor !== 'rgba(0, 0, 0, 0)'];
  }));
  // How much of its track each bar covers, in percent. The fill's width eases over .4 s, so right after a figure changes
  // it can lag the label: wait for the animations, then the fill must match the figure.
  const fills = () => pane.locator('.meters .meter').evaluateAll((all) => all.slice(0, 3).map((m) => { const bar = m.querySelector('.fx-meter'); return Math.round(bar.firstElementChild.getBoundingClientRect().width / bar.getBoundingClientRect().width * 100); }));
  const filled = async (n, what) => {
    await until(async () => { await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {})))); return (await fills()).every((f) => Math.abs(f - n) <= 1); }, what + ' fill covers ' + n + '% of its track (' + JSON.stringify(await fills()) + ')', 8000);
  };
  const send = async (text) => { await pane.locator('.composer textarea').click(); await page.keyboard.type(text); await page.keyboard.press('Enter'); };
  return { instance, id, page, pane, bars, fills, filled, send, errors };
}

for (const provider of ['claude', 'codex']) {
  test('MR1 and MR2 ' + provider + ': all three bars fill and turn amber from 75%, and the figures follow the agent without waiting a minute', { timeout: 120000 }, async (t) => {
    const { instance, page, pane, bars, fills, filled, send, errors } = await open(t, provider);
    // Codex: the 5 h and 7 d bars start at the rollout's 74%. Claude has no reading yet: its first one is the event below.
    await send('limits 74');
    const at74 = [['74%', false, true], ['74%', false, true], ['74%', false, true]];
    await until(async () => JSON.stringify(await bars()) === JSON.stringify(at74), provider + ' bars at 74% (' + JSON.stringify(await bars()) + ')');
    console.log('FILL ' + provider + ' the moment the figures read 74%: ' + JSON.stringify(await fills()));
    await filled(74, provider);
    await shot(pane.locator('.meters'), 'meters-' + provider + '-74');
    // 76%: no minute passes. Claude's arrives as a rateLimit event after its turn ended; Codex's is in the log before
    // the turn ends.
    if (provider === 'codex') await rollout(instance, 76);
    await send('limits 76');
    const at76 = [['76%', true, true], ['76%', true, true], ['76%', true, true]];
    await until(async () => JSON.stringify(await bars()) === JSON.stringify(at76), provider + ' bars at 76% (' + JSON.stringify(await bars()) + ')', 15000);
    await filled(76, provider);
    await shot(pane.locator('.meters'), 'meters-' + provider + '-76');
    assert.deepEqual(errors, []);
    console.log('PASS MR1 MR2 ' + provider + ': three filled bars, none amber at 74%, all amber at 76%, no wait for the minute poll');
  });
}

test('MR2: the cache clock moves on every 15 s without rebuilding the pane', { timeout: 90000 }, async (t) => {
  const { page, pane } = await open(t, 'claude');
  const cache = pane.locator('.meters .cache');
  await until(async () => /60 min/.test(await cache.textContent()), 'the clock shows after the turn');
  await cache.evaluate((el) => { el.dataset.mark = 'same'; });
  // Ten minutes pass (the page's clock jumps); the tick, not a re-render, moves the figure.
  await page.evaluate(() => { const now = Date.now; Date.now = () => now() + 10 * 60000; });
  await until(async () => /50 min/.test(await cache.textContent()), 'the clock moved to 50 min', 20000);
  assert.equal(await cache.getAttribute('data-mark'), 'same', 'the same element: the pane was not rebuilt');
  await page.evaluate(() => { const now = Date.now; Date.now = () => now() + 45 * 60000; });
  await until(async () => (await cache.getAttribute('data-s')) === 'cooling', 'the state moved to cooling', 20000);
  console.log('PASS MR2: the cache clock moved on its own from 60 to 50 min and then cooling, in place');
});

// An agent working unattended inside one long prompted turn re-warms the cache with every step: the clock follows its
// output, not the turn end before the prompt (owner, 2026-10-28: the clock never reset for an agent posting 30 min apart).
test('cache clock claude: a long prompted turn that works on its own starts the clock again from its output', { timeout: 90000 }, async (t) => {
  const before = async (instance, id) => {
    await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'long work' });
    await until(async () => (await call(instance, '/chat/events?after=0&only=' + id)).events.some((e) => e.data?.toolCallId === 'lw-2'), 'long work going');
    // The last turn end, the prompt and the first steps were half an hour ago; the turn goes on live.
    const db = new DatabaseSync(path.join(instance.directory, '.local', 'state', 'p9-foundation', 'p9.db'));
    try { db.prepare('UPDATE events SET at = at - 1800000 WHERE conversation = ?').run(id); } finally { db.close(); }
  };
  const { page, pane, errors } = await open(t, 'claude', { before });
  const cache = pane.locator('.meters .cache'), clock = () => cache.evaluate((el) => el.lastChild.textContent);
  await cache.waitFor({ timeout: 10000 });
  await until(async () => /^(59|60) min$/.test(await clock()), 'the clock follows the running turn (it read ' + await clock().catch(() => '?') + ')', 20000);
  assert.equal(await cache.getAttribute('data-s'), 'warm');
  for (const theme of ['event-horizon-prime', 'daylight']) { // the default dark theme and the light one
    await page.click('#themeBtn'); await page.click('[data-theme-pick="' + theme + '"]'); await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await shot(pane.locator('.meters'), 'cache-turn-' + theme);
  }
  assert.deepEqual(errors, []);
  console.log('PASS cache clock claude: ' + await clock() + ' during a prompted turn whose start is 30 min back');
});

// A background task's report wakes the agent with no prompt; that work reads the cache too, so the clock starts again.
for (const provider of ['claude', 'codex']) {
  test('cache clock ' + provider + ': unprompted agent work after the turn ended starts the clock again', { timeout: 90000 }, async (t) => {
    // The turn ended half an hour ago: everything logged so far is moved back 30 min; the work goes on live.
    const back = (instance, id) => {
      const db = new DatabaseSync(path.join(instance.directory, '.local', 'state', 'p9-foundation', 'p9.db'));
      try { db.prepare('UPDATE events SET at = at - 1800000 WHERE conversation = ?').run(id); } finally { db.close(); }
    };
    const { page, pane, errors } = await open(t, provider, { text: 'background quiet', done: (e) => e.data?.toolCallId === 'bg-2', before: back });
    const clock = () => pane.locator('.meters .cache').evaluate((el) => el.lastChild.textContent);
    await pane.locator('.meters .cache').waitFor({ timeout: 10000 });
    // Claude's clock reads from its newest output, not the 30-min-old turn end; Codex shows no clock, as before.
    if (provider === 'claude') await until(async () => /^(59|60) min$/.test(await clock()), 'the clock is back near 60 min', 20000);
    else { await page.waitForTimeout(2000); assert.equal(await clock(), '—'); }
    assert.deepEqual(errors, []);
    console.log('PASS cache clock ' + provider + ': ' + await clock() + ' with the turn end 30 min back');
  });
}
