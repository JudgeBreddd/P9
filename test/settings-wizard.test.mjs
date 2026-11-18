// settings-wizard: split from test/settings.test.mjs (O120), by area — the Settings dialog's wizard surfaces.
// Same helpers, same fixtures, every test moved verbatim: none dropped, none weakened.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { deflateSync, crc32 } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { _electron } from '@playwright/test';
import { daemon, http, authenticated, root, versionSeen, openFiles } from './helpers.mjs';
import { REPO } from '../apps/server/anymouse.mjs';
import { AZURE, FIXTURE, OTHERS } from './azure-fixture.mjs';
const look = (on, roles = {}) => ({ on, size: 48, claude: null, codex: null, system: null, top: null, pane: null, ...roles });
const PETS = { chat: look(true), dev: look(false), mission: look(false) };
const SKIPPER = { system: 'skipper' }, DEFAULT_PETS = { chat: look(true, SKIPPER), dev: look(false, SKIPPER), mission: look(false, SKIPPER) };
const DOCS_URL = 'https://github.com/' + REPO + '#readme'; // main.mjs loads only inside Electron
const RELEASES_URL = 'https://github.com/' + REPO + '/releases/latest';
const PETDEX_URL = 'https://petdex.dev';
// 0.1.8: Mode, Model and Effort are pills in the message bar (controller.mjs pillMenu); each opens a menu of menuitemradio choices.
// pillValue reads a pill's value from its aria-label; pillItems lists a menu (the checked ones marked); choose picks (no submenus).
const pillOf = (pane, kind) => pane.locator(`[data-pill="${kind}"]`);
const pillValue = async (pane, kind) => (await pillOf(pane, kind).getAttribute('aria-label')).replace(kind + ': ', '');
const menuItem = (page, label) => page.locator('#pillMenu .item').filter({ has: page.locator(`.truncate:text-is("${label}")`) });
const pillItems = async (page, pane, kind) => { await pillOf(pane, kind).click(); await page.locator('#pillMenu:not([hidden])').waitFor(); const items = await page.locator('#pillMenu .item').evaluateAll((l) => l.map((b) => b.firstElementChild.textContent + (b.getAttribute('aria-checked') === 'true' ? ' ✓' : ''))); await page.keyboard.press('Escape'); return items; };
const choose = async (page, pane, kind, ...labels) => { await pillOf(pane, kind).click(); for (const label of labels) await menuItem(page, label).click(); };
const fake = path.join(root, 'test/fake-acp-agent.mjs');
const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((result) => JSON.parse(result.text));


test('Setup wizard UI: every screen in order, sign-in through the fake CLI, starter files, skip into the Notification Center until done (threat model rows 17, 31)', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-welcome-')), profile = path.join(home, 'profile');
  const opened = path.join(home, 'opened.txt'), browser = path.join(home, 'browser');
  await writeFile(browser, '#!/bin/sh\nprintf "%s\\n" "$1" >> ' + opened + '\n');
  await chmod(browser, 0o755);
  const env = { ...process.env, P9_OPEN_URL: browser }; delete env.ELECTRON_RUN_AS_NODE;
  const launch = async () => {
    const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
    const proc = app.process();
    t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
    const page = await app.firstWindow();
    await page.locator('#rChat').waitFor();
    return { app, page };
  };
  const until = async (check, what) => {
    for (let i = 0; i < 100; i++) { const value = await check(); if (value) return value; await new Promise((r) => setTimeout(r, 100)); }
    throw new Error('timed out: ' + what);
  };
  const ev = process.env.P9_EVIDENCE, shot = async (name) => { if (ev) { await page.waitForTimeout(600); await page.screenshot({ path: path.join(ev, name) }); } };
  const credentials = path.join(instance.directory, '.claude', '.credentials.json'), marker = 'P9-CREDENTIAL-MARKER-' + Date.now();
  const setup = () => call(instance, '/setup');
  let s = await setup();
  assert.deepEqual(Object.keys(s).sort(), ['agentsFile', 'claude', 'claudeCli', 'codex', 'codexCli', 'conflict', 'creates', 'dependencies', 'found', 'proposed', 'registryFile', 'settings', 'settingsError', 'settingsFile',
    'settingsInvalid', 'settingsPresent', 'tmux', 'workspace', 'workspaceEmpty', 'writable']);
  assert.deepEqual([s.settings, s.settingsPresent, s.claude, s.codex, s.writable], [false, false, false, false, true]);
  // Off Linux there is no Terminal screen and tmux counts as done; tmux missing here leaves that one check open.
  // Item 15: step 3 asks Claude, Codex or both; the card opens there unless a CLI is on PATH already.
  const total = s.tmux === null ? 7 : 8, first = s.claudeCli || s.codexCli ? [4, 'Sign in to an agent'] : [3, 'Claude, Codex or both?'], rows = s.tmux === null ? 2 : 3, settingsFile = s.settingsFile;

  let { app, page } = await launch();
  const card = () => page.locator('#cards [data-key="welcome"]'), body = () => page.locator('#welBody').innerText();
  const at = (n, title) => page.waitForFunction(([n, title, total]) => document.querySelector('#welDlg').open
    && document.querySelector('#welStep').textContent === 'Step ' + n + ' of ' + total && document.querySelector('#welT').textContent === title, [n, title, total]);
  const next = () => page.click('#welFoot [data-act="next"]');
  // The pick step: Claude unless something is picked already, Install, then the same button is Next.
  const pickThrough = async () => {
    await at(3, 'Claude, Codex or both?');
    if (await page.locator('#welFoot [data-act="install"]').isDisabled()) await page.click('#welBody [data-act="choose:claude"]');
    if (await page.locator('#welFoot [data-act="install"]').innerText() === 'Install') {
      await page.click('#welFoot [data-act="install"]'); await page.locator('#welBody [data-installed]').waitFor({ timeout: 10000 });
    }
    await page.click('#welFoot [data-act="install"]'); await at(4, 'Sign in to an agent');
  };
  await card().waitFor({ timeout: 10000 });
  assert.match(await card().innerText(), new RegExp('Set up · ' + (rows - 1 - (s.tmux === false ? 1 : 0)) + ' of ' + rows + ' done[\\s\\S]*agent sign-in$'));
  await shot('setup-card.png');
  // The card opens at the first step not done; Back walks to the start.
  await card().locator('.open').click();
  await at(...first);
  if (first[0] === 4) { assert.ok(await page.locator('#welFoot [data-act="next"]').isDisabled(), 'no agent signed in: Next waits'); await page.click('[data-act="back"]'); }
  await at(3, 'Claude, Codex or both?');
  await page.click('[data-act="back"]'); await at(2, 'Your workspace');
  assert.equal(await page.locator('#welWs').textContent(), s.workspace);
  assert.match(await body(), /P9 can write here/);
  await shot('wizard-1-workspace.png');
  // Attempt 2, item 8: card 2 says what the folder is for, and nothing about starter files.
  assert.match(await body(), /This is your main working folder while you use P9\. You can change it any time in Settings\. If you have no workspace or project folder you prefer, P9 makes one for you\. Changing it restarts P9's background service/);
  assert.doesNotMatch(await body(), /starter/i);
  const wizShot = async (name) => { await page.waitForTimeout(400); const png = await page.locator('#welDlg').screenshot({ type: 'png' }); if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png.toString('base64')); };
  const wizLight = async (name) => { const was = await page.evaluate(() => { const h = document.documentElement, was = h.dataset.theme; h.classList.remove('dark'); h.dataset.theme = 'daylight'; return was; });
    await wizShot(name); await page.evaluate((was) => { const h = document.documentElement; h.classList.add('dark'); if (was === undefined) delete h.dataset.theme; else h.dataset.theme = was; }, was); };
  await wizShot('wizard-card2-dark'); await wizLight('wizard-card2-light');
  await page.click('[data-act="back"]'); await at(1, 'Welcome to Event Horizon');
  await shot('wizard-0-welcome.png');
  await next(); await at(2, 'Your workspace'); await next(); await pickThrough();
  assert.ok(await page.locator('#welFoot [data-act="next"]').isDisabled(), 'no agent signed in: Next waits');

  // Sign-in: the fake CLI prints a claude.com URL and a paste prompt. The page learns only that a URL exists.
  await page.click('[data-act="start:claude"]');
  await page.locator('[data-act="open:claude"]').waitFor({ timeout: 10000 });
  await page.fill('#welCode', 'abc 123');
  await page.waitForTimeout(10500);
  assert.equal(await page.locator('#welCode').inputValue(), 'abc 123', 'a 10 s refresh keeps what is typed');
  await shot('wizard-2-signing-in.png');
  await page.click('[data-act="code:claude"]');
  assert.equal(await until(() => readFile(path.join(instance.workspace, 'fake-login-code'), 'utf8').catch(() => ''), 'the code'), '"abc 123"\n');
  await page.waitForFunction(() => document.querySelector('#welCode')?.value === '', null, { timeout: 5000 }); // sent: the box empties
  await page.click('[data-act="open:claude"]');
  assert.equal((await until(() => readFile(opened, 'utf8').catch(() => ''), 'the open')).trim(), 'https://claude.com/cai/oauth/authorize?fake=1');
  assert.ok(!(await page.content()).includes('oauth'), 'the page never holds the URL');
  // "done" ends the fake CLI without a credentials file: the cause, and Retry in place of Sign in.
  await page.fill('#welCode', 'done'); await page.click('[data-act="code:claude"]');
  await page.locator('[data-act="start:claude"]', { hasText: 'Retry' }).waitFor({ timeout: 10000 });
  assert.match(await body(), /Claude sign-in ended without signing in/);
  await shot('wizard-2-ended.png');
  // The credentials file appears: shown within a refresh, never read.
  await mkdir(path.dirname(credentials), { recursive: true }); await writeFile(credentials, JSON.stringify({ token: marker }));
  await page.locator('#welBody .ok', { hasText: 'Signed in' }).waitFor({ timeout: 12000 }); // the 10 s poll (BL5)
  assert.ok(!(await page.content()).includes(marker));
  assert.ok(await page.locator('#welFoot [data-act="next"]').isEnabled());
  await shot('wizard-2-agents.png');

  await next();
  if (s.tmux !== null) {
    // Item 15: something only an admin can install (the SSH client on a machine without it) turns this step into the admin screen.
    const admin = s.dependencies.filter((x) => x.admin).map((x) => x.id);
    await at(5, admin.length ? 'This needs your admin password' : 'Terminal');
    if (admin.length) assert.deepEqual(await page.locator('#welBody [data-admin]').evaluateAll((all) => all.map((x) => x.dataset.admin)), admin);
    else assert.match(await body(), s.tmux ? /✓ Found/ : /tmux is not installed/);
    await shot('wizard-4-terminal.png');
    await next();
  }
  await at(total - 2, 'You');
  await page.fill('#welName', 'Ada');
  await page.waitForTimeout(10500); // across one 10 s poll (BL5)
  assert.equal(await page.locator('#welName').inputValue(), 'Ada');
  await page.locator('#welName').press('Tab');
  await until(() => page.evaluate(() => window.p9.getSettings().then((x) => x.name === 'Ada')), 'the name saved');
  // Issue #4 item 4, option C: petdex.dev, opened only through the fixed-address opener.
  await page.click('#welPetdex');
  await until(async () => (await readFile(opened, 'utf8')).includes(PETDEX_URL), 'petdex opened');
  await shot('wizard-5-you.png');
  await next(); await at(total - 1, s.tmux === false ? 'Almost there' : 'You are set');
  await shot('wizard-6-done.png');
  // Attempt 2, item 8: no Mission Control check (Mission has no starter files); Mission Control is the last step.
  assert.doesNotMatch(await body(), /Mission/, 'no Mission Control row');
  await next(); await at(total, 'Mission Control');
  assert.equal(await page.locator('#welFoot [data-act="close"]').count(), 1, 'the last step: Close, not Skip');
  // Fresh-install finding 1: Mission starts empty and is built there. Open Mission Control is the main button, nothing is required, and an
  // older setup's files sit folded under "I already have Mission files", every path optional and empty (nothing found here).
  assert.match(await body(), /Last, build Mission Control: your control room for scripts, live numbers, logs, notes and links\. It starts empty\. Open Mission Control takes you to its own wizard/);
  assert.equal(await page.locator('#welFoot [data-act="mission-open"]').getAttribute('data-variant'), 'default', 'Open Mission Control is the main button');
  await wizShot('wizard-last-mission-dark'); await wizLight('wizard-last-mission-light');
  assert.equal(await page.locator('#welBody [data-have]').evaluate((d) => d.open), false, 'folded away at first');
  assert.equal(await page.locator('#welBody [data-act="starter"]').count(), 0, 'no button that makes files');
  await page.waitForTimeout(400);
  const step5 = async (name) => { const png = await page.locator('#welDlg').screenshot({ type: 'png' }); if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png.toString('base64')); };
  await step5('wizard-mission-dark');
  await page.click('#welBody [data-have] > summary');
  assert.match(await page.locator('#welBody [data-have]').innerText(), /Main project folder \(optional\)[\s\S]*Buttons, apps and pages file \(optional\)[\s\S]*Folder of items waiting on you \(optional\)/);
  assert.deepEqual((await page.locator('#welBody [data-path]').evaluateAll((all) => all.map((box) => box.value))).slice(0, 3), ['', '', ''], 'no starter names filled in');
  assert.equal(await page.locator('#welBody [data-act="starter"]').count(), 0, 'Use these files waits for a path');
  // The path rows share one label column and one box column, as in Settings: every box at the same x and width.
  const wizEdges = await page.locator('#welBody [data-path]').evaluateAll((all) => all.map((box) => { const r = box.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.width)]; }));
  assert.equal(wizEdges.length, 4);
  assert.deepEqual(wizEdges, wizEdges.map(() => wizEdges[0]), 'aligned wizard boxes');
  await page.waitForTimeout(10500); // across one 10 s poll (BL5): the section stays open
  assert.equal(await page.locator('#welBody [data-have]').evaluate((d) => d.open), true, 'still open after a refresh');
  await step5('wizard-mission-open-dark');
  // Daylight as the theme picker sets it (the picker sits behind the wizard).
  const theme = await page.evaluate(() => { const h = document.documentElement, was = h.dataset.theme; h.classList.remove('dark'); h.dataset.theme = 'daylight'; return was; });
  await step5('wizard-mission-open-light');
  await page.click('#welBody [data-have] > summary');
  await step5('wizard-mission-light');
  await page.evaluate((was) => { const h = document.documentElement; h.classList.add('dark'); if (was === undefined) delete h.dataset.theme; else h.dataset.theme = was; }, theme);
  // The desktop passes scripts_root through to the daemon like the other four paths (it was refused as request-refused).
  const checked = await page.evaluate(async (folder) => {
    const r = await window.p9.chat('setup', { ...(await window.p9.chat('setup', {})).body.proposed, scripts_root: folder });
    return [r.status, r.body?.pathsInvalid ?? false, r.body?.proposed?.scripts_root];
  }, instance.workspace);
  assert.deepEqual(checked, [200, false, instance.workspace], 'scripts_root checked');
  await page.click('#welBody [data-have] > summary');
  await page.click('[data-act="docs"]');
  await until(async () => (await readFile(opened, 'utf8')).includes('docs/guide.md#buttons-apps-and-pages'), 'the guide opened');
  // Typing one path offers Use these files; clearing it takes the button away again.
  await page.fill('#welBody [data-path="waiting"]', 'needs-you');
  await page.locator('#welBody [data-path="waiting"]').dispatchEvent('change');
  await page.locator('#welBody [data-act="starter"]', { hasText: 'Use these files' }).waitFor({ timeout: 10000 });
  await page.fill('#welBody [data-path="waiting"]', '');
  await page.locator('#welBody [data-path="waiting"]').dispatchEvent('change');
  await page.locator('#welBody [data-act="starter"]').waitFor({ state: 'detached', timeout: 10000 });
  for (const name of ['AGENTS.md', 'mission', 'needs-you', '_ideas']) await assert.rejects(stat(path.join(instance.workspace, name)), name);
  await page.click('[data-act="back"]'); await at(total - 1, s.tmux === false ? 'Almost there' : 'You are set');
  if (s.tmux !== false) await card().waitFor({ state: 'detached', timeout: 5000 }); // every check passes: no card anywhere
  await page.click('[data-act="tour"]');
  await page.locator('#walk').waitFor({ timeout: 5000 });
  assert.equal(await page.locator('#welDlg').evaluate((d) => d.open), false);
  await page.keyboard.press('Escape');

  // Fresh-install finding 1: after the wizard, Mission opens at its onboarding card, with no error.
  await page.evaluate(() => document.querySelector('#welDlg')?.close());
  await page.click('#rMission');
  await page.locator('#fMission [data-onboard] [data-template="blank"]').waitFor({ timeout: 15000 });
  assert.doesNotMatch(await page.locator('#fMission').innerText(), /is required|could not be read|not found|error/i);
  // Fresh-install finding 2: P9 wrote its own settings file and no ICM files; none of the ICM widgets draw.
  assert.equal(await readFile(settingsFile, 'utf8'), '{}\n');
  for (const name of ['AGENTS.md', 'mission', 'needs-you', '_ideas']) await assert.rejects(stat(path.join(instance.workspace, name)), name);
  assert.equal(await page.locator('#fMission .needs').isVisible(), false, 'no Waiting on you');
  assert.deepEqual(await page.locator('#fMission [data-panel]').evaluateAll((all) => all.filter((p) => p.checkVisibility()).map((p) => p.dataset.panel)), [], 'no ICM panels');
  await page.waitForTimeout(400);
  const mission = await page.screenshot({ type: 'png' });
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT mission-after-next ' + mission.toString('base64'));
  await page.click('#rChat').catch(() => {});

  // Signed out again. The x skips: the card leaves the stack for the Notification Center, and stays there after a restart.
  await rm(credentials);
  await app.close();
  ({ app, page } = await launch());
  await card().waitFor({ timeout: 10000 });
  assert.match(await card().innerText(), new RegExp('Set up · ' + (rows - 1 - (s.tmux === false ? 1 : 0)) + ' of ' + rows + ' done'));
  await card().locator('.x').click();
  assert.equal(await card().count(), 0);
  const centerRow = () => page.locator('#mdlBody [data-i]', { hasText: 'Set up ·' });
  await page.keyboard.press('Control+Shift+N');
  await centerRow().waitFor();
  await shot('setup-in-center.png');
  await centerRow().click();
  await at(4, 'Sign in to an agent');
  await page.keyboard.press('Escape');
  await app.close();
  ({ app, page } = await launch());
  await page.keyboard.press('Control+Shift+N');
  await centerRow().waitFor({ timeout: 10000 });
  assert.equal(await card().count(), 0, 'skipped: not on the stack after a restart');
  await page.click('#mdlX');
  // Settings → Setup opens it at the same step; signed in meanwhile, the notification goes.
  await page.click('#setBtn');
  assert.equal(await page.locator('#setWel').innerText(), 'Setup');
  await shot('settings-setup.png');
  await page.click('#setWel');
  await at(4, 'Sign in to an agent');
  await writeFile(credentials, JSON.stringify({ token: marker }));
  await page.locator('#welBody .ok', { hasText: 'Signed in' }).waitFor({ timeout: 12000 }); // the 10 s poll (BL5)
  await page.keyboard.press('Escape');
  if (s.tmux !== false) {
    await page.keyboard.press('Control+Shift+N');
    await page.locator('#mdlBody').waitFor();
    await page.waitForTimeout(500);
    assert.equal(await centerRow().count(), 0, 'done: gone from the Notification Center');
    await page.click('#mdlX');
  }
  // "Turn Mission off for now" stays on the Mission Control screen.
  await page.click('#setBtn'); await page.click('#setWel');
  await at(s.tmux === false ? 5 : 1, s.tmux === false ? 'Terminal' : 'Welcome to Event Horizon');
  if (s.tmux !== false) { await next(); await next(); await pickThrough(); }
  for (let i = 0; i < 4 && await page.locator('#welT').textContent() !== 'Mission Control'; i++) { await next(); await page.waitForTimeout(300); }
  await at(total, 'Mission Control');
  // Its button opens Mission's onboarding card.
  await page.click('[data-act="mission-open"]');
  await page.locator('#fMission [data-onboard] [data-template="blank"]').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('#welDlg').evaluate((d) => d.open), false);
  await page.click('#setBtn'); await page.click('#setWel');
  await at(s.tmux === false ? 5 : 1, s.tmux === false ? 'Terminal' : 'Welcome to Event Horizon');
  if (s.tmux !== false) { await next(); await next(); await pickThrough(); }
  for (let i = 0; i < 4 && await page.locator('#welT').textContent() !== 'Mission Control'; i++) { await next(); await page.waitForTimeout(300); }
  await at(total, 'Mission Control');
  await page.click('[data-act="mission-off"]');
  await page.waitForFunction(() => document.querySelector('[data-focus-btn="mission"]').hidden && !document.querySelector('#welDlg').open);
  // Ctrl K offers no Mission command while Mission is off.
  await page.keyboard.press('Control+k'); await page.fill('#palIn', 'mission');
  const missionCmds = await page.locator('#palList li[data-i]').allTextContents(); await page.keyboard.press('Escape');
  assert.deepEqual(missionCmds, [], 'Ctrl K offers no Mission command while Mission is off');
  console.log('PASS setup wizard UI: card count, resume at the first step not done, sign-in code and open, ended shows Retry, starter files, name and petdex, tour, skip to the Notification Center across a restart, gone when done, Mission off');
});

test('Setup wizard UI: starter settings on a folder with its own layout show the found paths, editable, and Use these repoints (threat model row 38)', { skip: process.platform === 'win32', timeout: 120000 }, async (t) => {
  const hub = 'work/workspace-hub';
  const instance = await daemon(t, undefined, false, async ({ directory, workspace }) => {
    const file = path.join(directory, '.config', 'p9', 'settings.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ primary: 'AGENTS.md', registry: 'mission/registry.json', waiting: 'needs-you' }));
    await mkdir(path.join(directory, '.claude'), { recursive: true });
    await writeFile(path.join(directory, '.claude', '.credentials.json'), '{}'); // agent sign-in done: the card opens at Mission Control
    await mkdir(path.join(workspace, hub), { recursive: true });
    await writeFile(path.join(workspace, hub, 'registry.json'), '{"scripts":[],"apps":[],"pages":[]}');
    await writeFile(path.join(workspace, 'AGENTS.md'), '# Top\n');
    await mkdir(path.join(workspace, 'work/_owner'));
    await writeFile(path.join(workspace, 'work/_owner/AGENTS.md'), '# Waiting on me\n');
    return { args: ['--acp-override', fake] };
  });
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-conflict-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#rChat').waitFor();
  const card = page.locator('#cards [data-key="welcome"]');
  await card.waitFor({ timeout: 10000 });
  await card.locator('.open').click();
  await page.locator('#welDlg[open]').waitFor({ timeout: 10000 });
  await page.locator('#welBody [data-conflict]').waitFor({ timeout: 10000 });
  assert.deepEqual(await page.locator('#welBody [data-path]').evaluateAll((inputs) => inputs.map((input) => input.value)),
    ['AGENTS.md', hub + '/registry.json', 'work/_owner', '']);
  await page.waitForTimeout(400);
  const png = await page.screenshot({ type: 'png' });
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT conflict-card ' + png.toString('base64'));
  await page.click('[data-act="starter"]');
  await page.locator('#welBody .ok', { hasText: 'Created:' }).waitFor({ timeout: 10000 });
  const saved = JSON.parse(await readFile(path.join(instance.directory, '.config', 'p9', 'settings.json'), 'utf8'));
  assert.deepEqual(saved, { primary: 'AGENTS.md', registry: hub + '/registry.json', waiting: 'work/_owner' });
  assert.deepEqual((await readdir(instance.workspace)).sort(), ['AGENTS.md', 'note.txt', 'work'], 'no mission/ or needs-you/');
  console.log('PASS wizard UI: found paths shown in the conflict state; Use these repointed the settings and made nothing else');
});

test('Setup wizard: polls every 10 s while a check fails and stops once setup is done (BL5)', { skip: process.platform === 'win32', timeout: 180000 }, async (t) => {
  // darwin: no terminal check, so signing in is the only step left.
  const instance = await missionDaemon(t, false, ['--terminal-platform', 'darwin']);
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-poll-')), 'profile');
  const { app, page } = await launchOn(t, instance, profile);
  // Count the renderer's setup checks in main, where every one passes.
  await app.evaluate(({ ipcMain }) => {
    const handler = ipcMain._invokeHandlers.get('p9:chat');
    globalThis.setupChecks = 0;
    ipcMain._invokeHandlers.set('p9:chat', (event, action, ...rest) => { if (action === 'setup') globalThis.setupChecks++; return handler(event, action, ...rest); });
  });
  const checks = () => app.evaluate(() => globalThis.setupChecks);
  const card = page.locator('#cards [data-key="welcome"]');
  await card.waitFor({ timeout: 10000 });
  await card.locator('.open').click();
  await page.locator('#welDlg[open]').waitFor({ timeout: 10000 });
  const before = await checks();
  await page.waitForTimeout(25000);
  const failing = (await checks()) - before;
  assert.ok(failing >= 1 && failing <= 3, 'about one check per 10 s while sign-in is missing, got ' + failing + ' in 25 s');
  await mkdir(path.join(instance.directory, '.claude'), { recursive: true });
  await writeFile(path.join(instance.directory, '.claude', '.credentials.json'), '{}');
  await page.waitForTimeout(12000); // the next check sees it done
  assert.equal(await card.count(), 0, 'setup done: the card is gone');
  const done = await checks();
  await page.waitForTimeout(22000);
  assert.equal((await checks()) - done, 0, 'no checks once setup is done');
  assert.equal(await page.locator('#welDlg[open]').count(), 1, 'the wizard is still open');
  console.log('PASS wizard poll: ' + failing + ' checks in 25 s while a check fails, none once done');
});

const MISSION_FILES = { primary: 'AGENTS.md', registry: 'mission/registry.json', waiting: 'needs-you' };
const missionDaemon = (t, signedIn, args = []) => daemon(t, undefined, false, async ({ directory, workspace }) => {
  const file = path.join(directory, '.config', 'p9', 'settings.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(MISSION_FILES));
  await writeFile(path.join(workspace, 'AGENTS.md'), '# Top\n');
  await mkdir(path.join(workspace, 'mission')); await mkdir(path.join(workspace, 'needs-you')); await mkdir(path.join(workspace, 'inbox'));
  await writeFile(path.join(workspace, 'mission/registry.json'), '{"scripts":[],"apps":[],"pages":[]}');
  if (signedIn) { await mkdir(path.join(directory, '.claude'), { recursive: true }); await writeFile(path.join(directory, '.claude', '.credentials.json'), '{}'); }
  return { args: ['--acp-override', fake, ...args] };
});
const launchOn = async (t, instance, profile) => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#rChat').waitFor();
  return { app, page };
};
const pickNext = (app, filePaths) => app.evaluate(({ dialog }, filePaths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths }); }, filePaths);


