import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { remoteDaemon, root } from './helpers.mjs';
import { phone } from './phone-c16-helpers.mjs';

// MC-16 on the phone: its Model sheet and effort picker name the option a new chat starts on, by the desktop's rule
// (controller.mjs isDefault): the Settings start default while the agent offers it, else the agent's own start value.
// The fake agent starts on "Default (recommended)" and Medium; Settings here says Haiku and High.
const PROFILED = '00000000-0000-4000-8000-0000000000d1';
const until = async (check, what) => { for (const end = Date.now() + 20000; !(await check());) { assert.ok(Date.now() < end, what); await new Promise((r) => setTimeout(r, 200)); } };

test('MC-16 phone: the Model sheet and the effort picker name the default, the Settings start default first, as on the desktop', { timeout: 150000 }, async (t) => {
  const server = await remoteDaemon(t, { args: ['--acp-override', path.join(root, 'test/fake-acp-agent.mjs')] });
  const { desk } = server;
  assert.equal((await desk('/start-defaults', 'POST', { set: { claude: { model: 'haiku', effort: 'high' } } })).status, 200);
  // A chat that has run once (its own settings are known), and the agent's lists read fresh (its own start values).
  const id = (await desk('/chat', 'POST', { provider: 'claude' })).body.conversation;
  await desk('/chat/' + id + '/prompt', 'POST', { text: 'hello' });
  await until(async () => (await desk('/chat/events?after=0&only=' + id)).body.events.some((e) => e.type === 'turn-end'), 'hello answered');
  await desk('/chat?lists=fresh');
  await until(async () => (await desk('/chat')).body.lists.claude?.state === 'ok', 'lists read');
  // A chat on a provider profile has the one model it was started on: nothing is marked there (as on the desktop).
  const db = new DatabaseSync(path.join(server.directory, '.local', 'state', 'p9-foundation', 'p9.db'), { timeout: 5000 });
  db.prepare('INSERT INTO conversations (id, provider, title, state, created) VALUES (?, ?, ?, ?, ?)').run(PROFILED, 'claude', 'On a profile', 'idle', Date.now());
  db.prepare('INSERT INTO prefs (key, value) VALUES (?, ?)').run('profile:' + PROFILED, JSON.stringify({ id: 'p1', name: 'Gateway', model: 'haiku' }));
  const event = db.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)');
  for (const [type, data] of [['user', { text: 'hi' }], ['config', { model: { current: 'haiku', options: [{ value: 'haiku', name: 'Haiku' }] },
    pickers: [{ id: 'effort', name: 'Effort', current: 'high', options: [{ value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] }] }], ['turn-end', { stopReason: 'end_turn' }]]) event.run(PROFILED, type, JSON.stringify(data), Date.now());
  db.close();

  const { page } = await phone(t, server);
  // models: the chat's own model list (marks aside), when the one on screen before it could still be drawn: a hash change
  // picks the chat at once, and its pickers are redrawn only when its history is in.
  const read = async (chat, models) => {
    await page.goto(server.origin + '/phone/#chat=' + chat);
    await page.waitForFunction(({ chat, models }) => document.querySelector('#conversation')?.value === chat && document.querySelector('#model option')
      && (!models || [...document.querySelectorAll('#model option')].map((o) => o.textContent.replace(' (Default)', '')).join('|') === models), { chat, models }, { timeout: 15000 });
    return page.evaluate(() => ({ models: [...document.querySelectorAll('#model option')].map((o) => o.textContent),
      effort: [...document.querySelectorAll('#pickers select[data-config="effort"] option')].map((o) => o.textContent),
      bar: document.querySelector('#modelBtn')?.textContent.trim() }));
  };
  let seen = await read(id);
  assert.ok(seen.models.includes('Haiku (Default)'), 'MC-16: the Settings default model is not named the default: ' + seen.models.join(' | '));
  assert.equal(seen.models.filter((m) => /\(Default\)/.test(m)).length, 1, 'one model marked: ' + seen.models.join(' | '));
  assert.ok(seen.models.includes('Default (recommended)'), 'an option whose own name says default is left as it is');
  assert.deepEqual(seen.effort, ['Effort: Low', 'Effort: Medium', 'Effort: High (Default)'], 'MC-16: the Settings default effort is the one marked, not the agent\'s Medium');
  // The Model sheet lists the same names.
  await page.click('#modelBtn'); await page.locator('#sheetBody .opt').first().waitFor();
  assert.ok((await page.locator('#sheetBody .opt').allTextContents()).includes('Haiku (Default)'), 'the Model sheet names the default');
  await page.keyboard.press('Escape');

  // FIX1: Settings changes while this chat stays open (no reload, no navigation, no event on this chat). Another chat's
  // event makes the phone list again, and the open chat's labels follow the new default.
  // A pick made here and not sent yet (High; the chat runs on Medium) must stay the pick through that redraw.
  await page.evaluate(() => { const s = document.querySelector('#pickers select[data-config="effort"]'); s.value = 'high'; s.dispatchEvent(new Event('change', { bubbles: true })); });
  assert.equal((await desk('/start-defaults', 'POST', { set: { claude: { model: 'opus', effort: 'low' } } })).status, 200);
  await desk('/chat', 'POST', { provider: 'claude' });
  await page.waitForFunction(() => [...document.querySelectorAll('#pickers select[data-config="effort"] option')].some((o) => o.textContent === 'Effort: Low (Default)'), null, { timeout: 20000 })
    .catch(async () => assert.fail('FIX1: the open chat kept the old default after a relist: ' + (await page.evaluate(() => [...document.querySelectorAll('#pickers option, #model option')].map((o) => o.textContent).join(' | ')))));
  const now = await page.evaluate(() => ({ models: [...document.querySelectorAll('#model option')].map((o) => o.textContent), chat: document.querySelector('#conversation')?.value }));
  assert.equal(now.chat, id, 'still on the same chat');
  assert.equal(await page.locator('#pickers select[data-config="effort"]').inputValue(), 'high', 'the unsent pick survived the redraw');
  assert.ok(now.models.includes('Opus (Default)') && !now.models.includes('Haiku (Default)'), 'the model mark follows too: ' + now.models.join(' | '));

  // A Settings default the agent does not offer: the agent's own start value is the default (Medium; its model's own name says so).
  assert.equal((await desk('/start-defaults', 'POST', { set: { claude: { model: 'gone-model', effort: 'gone' } } })).status, 200);
  await page.reload(); seen = await read(id);
  assert.deepEqual(seen.effort, ['Effort: Low', 'Effort: Medium (Default)', 'Effort: High'], 'a Settings effort the agent dropped falls back to the agent\'s own');
  assert.ok(!seen.models.some((m) => /\(Default\)/.test(m)), 'no model marked twice when the agent\'s own default already says so: ' + seen.models.join(' | '));

  // The profile chat's history arrives late (held 1.5 s here, as on a slow link): what is read must be its own pickers, not
  // the previous chat's left on screen (they mark Medium, which failed CI as "nothing marked on a profile chat").
  await page.route((url) => url.pathname === '/chat/events' && (url.searchParams.get('only') ?? '').split(',').includes(PROFILED),
    async (route) => { await new Promise((resolve) => setTimeout(resolve, 1500)); await route.continue(); });
  seen = await read(PROFILED, 'Haiku');
  assert.ok(seen.models.length && seen.effort.length, 'the profile chat lists its pickers');
  assert.deepEqual([...seen.models, ...seen.effort].filter((x) => /\(Default\)/.test(x)), [], 'nothing marked on a profile chat');
  console.log('PASS MC-16 phone: Settings default marked (Haiku, High), the agent\'s own when Settings names one it dropped, none on a profile chat');
});
