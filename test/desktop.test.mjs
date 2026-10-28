import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from '@playwright/test';
import { daemon, http, authenticated } from './helpers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
test('Phase 4: real sandboxed Electron, bridge boundary and approved shell acceptance', { timeout: 90000 }, async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'p9-desktop-'));
  const env = { ...process.env, P9_SAMPLE_DATA: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  const application = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 15000 });
  try {
    const page = await application.firstWindow({ timeout: 15000 });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.locator('#cards .card').first().waitFor();
    const preferences = await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return { preferences: window.webContents.getLastWebPreferences(), args: process.argv, pid: window.webContents.getOSProcessId() };
    });
    assert.equal(preferences.preferences.contextIsolation, true);
    assert.equal(preferences.preferences.sandbox, true);
    assert.equal(preferences.preferences.nodeIntegration, false);
    assert.ok(!preferences.args.includes('--no-sandbox'));
    if (process.platform === 'linux') assert.match(await readFile(`/proc/${preferences.pid}/status`, 'utf8'), /Seccomp:\s+2/);
    assert.deepEqual(await page.evaluate(() => [Object.keys(window.p9), typeof require, typeof process, Object.isFrozen(window.p9)]), [['getStatus', 'usage', 'anymouse', 'mission', 'pickPicture', 'agentLogin', 'workspaceChange', 'restartService', 'repairService', 'rebuild', 'chat', 'lifecycle', 'devView', 'look', 'getSettings', 'setSettings', 'openDocs', 'openUpdates', 'updates', 'openPetdex', 'openLink', 'fileProtection', 'listPets', 'loadPet', 'addPets', 'importPets', 'installPets', 'removePet', 'server', 'sendToServer', 'cancelMove', 'onMove', 'xferPlan', 'xferRun', 'onXfer', 'serverUpdate', 'onServerUpdate', 'pickFolder', 'onFocus', 'terminal', 'terminalOpen', 'terminalSend', 'terminalClose', 'onTerminal', 'landing', 'version', 'source', 'sample'], 'undefined', 'undefined', true]);
    assert.deepEqual(await page.evaluate(() => window.p9.getStatus()), { status: 'unavailable' });
    // Auto-update (threat model row 39): a source checkout never updates; the bridge takes only its three calls.
    const off = { state: 'off', current: JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version, available: null, reason: 'source checkout' };
    assert.deepEqual(await page.evaluate(() => window.p9.updates()), off);
    assert.deepEqual(await page.evaluate(() => window.p9.updates({ check: true })), off);
    for (const ask of [{ check: 'yes' }, { install: true, check: true }, 'check', null]) await assert.rejects(page.evaluate(ask => window.p9.updates(ask), ask), /ipc-sender-refused/);
    const csp = await page.evaluate(async () => (await fetch('/')).headers.get('content-security-policy'));
    assert.match(csp, /default-src 'none'/); assert.match(csp, /script-src 'self' 'sha256-/); assert.ok(!csp.includes('unsafe-eval'));
    assert.deepEqual(await page.evaluate(async () => {
      const script = document.createElement('script'); script.textContent = 'window.injected = true'; document.body.append(script);
      return [window.injected === undefined, (await fetch('/missing')).status, (await fetch('/%2e%2e/package.json')).status, (await fetch('/', { method: 'POST' })).status];
    }), [true, 404, 404, 404]);
    const hostile = await application.evaluateHandle(async ({ BrowserWindow }, preload) => {
      const window = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: true, contextIsolation: true } });
      await window.loadURL('data:text/html,<title>attacker</title>'); return window;
    }, path.join(root, 'test/attacker-preload.cjs'));
    const refusal = await hostile.evaluate(window => window.webContents.executeJavaScript("window.probe.call().then(()=>({accepted:true}),error=>({accepted:false,message:error.message,sandboxed:window.probe.sandboxed}))"));
    assert.equal(refusal.accepted, false); assert.match(refusal.message, /ipc-sender-refused/); assert.equal(refusal.sandboxed, true);
    await hostile.evaluate(window => window.destroy());
    // Exercise the production handler with the genuine main frame and malformed arguments.
    const argsRefused = await application.evaluate(async ({ ipcMain, BrowserWindow }) => {
      const sender = BrowserWindow.getAllWindows()[0].webContents;
      try { await ipcMain._invokeHandlers.get('p9:get-status')({ sender, senderFrame: sender.mainFrame }, 'extra'); return false; }
      catch (error) { return error.message === 'ipc-sender-refused'; }
    });
    assert.equal(argsRefused, true);
    const missionRefused = await application.evaluate(async ({ ipcMain, BrowserWindow }) => {
      const sender = BrowserWindow.getAllWindows()[0].webContents, handler = ipcMain._invokeHandlers.get('p9:mission'), frame = { sender, senderFrame: sender.mainFrame };
      const refused = async (...args) => { try { await handler(frame, ...args); return false; } catch (error) { return error.message === 'ipc-sender-refused'; } };
      return [await refused('exec', { cmd: 'touch x' }), await refused('overview', {}, 'extra'), await refused('run', ['doctor']),
        await refused('overview', {}).then(() => false), (await handler(frame, 'run', { id: '../x' })).status, (await handler(frame, 'overview')).status];
    });
    assert.deepEqual(missionRefused, [true, true, true, false, 400, 503]);
    assert.deepEqual(await page.evaluate(() => window.p9.mission('overview')), { status: 503, body: { error: 'daemon-unavailable' } });
    const chatRefused = await application.evaluate(async ({ ipcMain, BrowserWindow }) => {
      const sender = BrowserWindow.getAllWindows()[0].webContents, handler = ipcMain._invokeHandlers.get('p9:chat'), frame = { sender, senderFrame: sender.mainFrame };
      const refused = async (...args) => { try { await handler(frame, ...args); return false; } catch (error) { return error.message === 'ipc-sender-refused'; } };
      const id = '00000000-0000-4000-8000-000000000000';
      return [await refused('exec', {}), await refused('list', {}, 'extra'), (await handler(frame, 'prompt', { id: '../x', text: 'hi' })).status,
        (await handler(frame, 'prompt', { id, text: 'hi', op: 'not-a-uuid' })).status, (await handler(frame, 'events', { wait: 60000 })).status,
        (await handler(frame, 'stopAll', { unexpected: true })).status, (await handler(frame, 'stopAll', {})).status,
        (await handler(frame, 'prompt', { id, text: 'hi', op: id })).status];
    });
    assert.deepEqual(chatRefused, [true, true, 400, 400, 400, 400, 503, 503]);
    console.log('PASS phase4 Electron: actual sandbox + isolation, exact bridge, CSP enforcement, sender/argument refusal, external navigation/popup blocked');

    assert.deepEqual(await page.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.hasAttribute('data-amoled')]), ['event-horizon-prime', true]);
    await page.click('#themeBtn'); await page.click('[data-theme-pick="redline"]');
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'redline');
    await page.reload(); await page.locator('#cards .card').first().waitFor();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'redline');
    await page.click('#themeBtn'); await page.click('[data-theme-pick="event-horizon-prime"]'); await page.click('#themeBtn');
    console.log('PASS phase4 DUWOP: fresh Prime AMOLED, actual theme switch, saved look survives reload');

    const ta = page.locator('#chats .pane textarea').first(), hist = page.locator('#chats .hist').first();
    const focus = mode => page.click('#r' + ({ chat: 'Chat', dev: 'Dev', mission: 'Mission' })[mode]);
    const card = prefix => page.locator(`#cards .card[data-key^="${prefix}"]`);
    const caret = element => element.evaluate(t => [document.activeElement === t, t.value, t.selectionStart, t.selectionEnd]);
    await ta.fill('acceptance draft in chat'); await ta.evaluate(t => t.setSelectionRange(3, 9));
    await hist.evaluate(h => h.scrollTo({ top: 40, behavior: 'instant' })); const chatTop = await hist.evaluate(h => h.scrollTop);
    const identity = await page.evaluate(() => { window.navigationMarker = {}; return performance.timeOrigin; });
    await focus('dev'); await page.click('#devTree [data-file="server.ts"]');
    const editor = page.locator('#devEd'); await editor.fill((await editor.inputValue()) + '\n// dev draft'); await editor.evaluate(t => t.setSelectionRange(20, 25));
    const devValue = await editor.inputValue();
    await focus('mission');
    // Phase 16: Mission sections live in windows; a window keeps its scroll across close, reopen and focus changes.
    const body = page.locator('#mdlBody');
    const openWin = async id => { await page.click(`#fMission [data-win="${id}"]`); await page.locator(`#mdl[open] #mdlBody #${id}`).waitFor(); };
    const closeWin = async () => { await page.click('#mdlX'); await page.locator('#mdl[open]').waitFor({ state: 'detached' }); };
    // Sample sections are too short to scroll, so a test-only sheet makes the queue window long (it survives re-renders).
    // #mdlBody must be the one scroller: before the fix .pbody scrolled and winTop never saved (council stuck round, 2026-10-17).
    const panelID = 'mnotes';
    await page.addStyleTag({ content: `#mdl #${panelID} .pbody::after{content:"";display:block;height:900px}` });
    await openWin(panelID); assert.equal(await page.locator(`#mdl #${panelID} .pbody`).evaluate(p => getComputedStyle(p).overflowY), 'visible'); assert.ok(await body.evaluate(b => b.scrollHeight > b.clientHeight + 20));
    const missionTop = await body.evaluate(b => new Promise(done => { b.addEventListener('scroll', () => done(b.scrollTop), { once: true }); b.scrollTo({ top: 80, behavior: 'instant' }); }));
    assert.ok(missionTop > 0); await closeWin();
    await focus('chat'); assert.deepEqual((await caret(ta)).slice(1), ['acceptance draft in chat', 3, 9]); assert.equal(await hist.evaluate(h => h.scrollTop), chatTop);
    await focus('dev'); assert.equal(await page.locator('#devTabs [aria-selected="true"]').getAttribute('data-file'), 'server.ts');
    assert.deepEqual((await caret(editor)).slice(1), [devValue, 20, 25]);
    await focus('mission'); await openWin(panelID); assert.equal(await body.evaluate(p => p.scrollTop), missionTop); await closeWin();
    assert.equal(await page.evaluate(() => performance.timeOrigin), identity); assert.equal(await page.locator('astro-island').count(), 1);
    console.log('PASS phase4 must-pass: Chat draft/caret/scroll, Dev tab/draft/caret and Mission scroll survive focus cycle without reload');

    await focus('dev'); await editor.evaluate(t => { t.focus(); t.setSelectionRange(20, 25); });
    const asks = Number(await card('asks:').locator('.n').innerText());
    await page.keyboard.press('Control+k'); await page.locator('#palette li', { hasText: 'Simulate an agent question' }).click();
    assert.equal(Number(await card('asks:').locator('.n').innerText()), asks + 1); assert.equal(await card('run:s-codex-1').count(), 0); assert.match(await card('asks:').getAttribute('class'), /fx-halo/);
    await card('asks:').locator('.open').click(); await page.locator('#mdlBody .mlist button', { hasText: 'Unit tests for codex-limits' }).click();
    await page.check('#mdlBody [data-question] input[value="vitest"]'); await page.click('#mdlBody [data-question] [type="submit"]');
    assert.equal(await page.locator('#mdl').evaluate(el => el.open), false);
    // The dialog's close event restores the caret as a separate task; a fixed 100 ms wait lost that race on a loaded CI runner.
    await page.waitForFunction(() => document.activeElement?.id === 'devEd', null, { timeout: 5000 }).catch(() => {});
    assert.deepEqual(await caret(editor), [true, devValue, 20, 25]);
    await focus('mission'); await card('reviews:').locator('.open').click(); await page.keyboard.press('Escape');
    await openWin(panelID); assert.equal(await body.evaluate(p => p.scrollTop), missionTop); await closeWin();
    console.log('PASS phase4 D10-1: asking session moves cards, modal answer handles it, close restores editor caret and Mission scroll');

    await focus('chat'); await ta.click(); await ta.evaluate(t => t.setSelectionRange(3, 9));
    await card('reviews:').locator('.open').click(); await page.locator('#mdlBody .mlist button').first().click();
    assert.ok(await page.locator('#mdlBody .fileview p').count() >= 3); assert.equal(await page.locator('#mdlBody [data-openfile]').count(), 0);
    await page.locator('#mdlBody textarea').fill('ok by me'); await page.keyboard.press('Escape');
    await ta.evaluate(t => new Promise(r => { const end = Date.now() + 2000; (function poll() { document.activeElement === t || Date.now() > end ? r() : requestAnimationFrame(poll); })(); })); // focus returns after the dialog's close; a fixed 100 ms wait failed 1 in 4 gate runs
    assert.deepEqual(await caret(ta), [true, 'acceptance draft in chat', 3, 9]); assert.equal(await hist.evaluate(h => h.scrollTop), chatTop);
    console.log('PASS phase4 D10-2: inline review file, close restores chat draft/caret/scroll');
    await card('reviews:').locator('.open').click();
    while (!await page.locator('#mdlBody .mlist').count()) await page.click('#mdlBack');
    assert.equal(await page.locator('#mdlBody .mlist li').count(), 5);
    await page.locator('#mdlBody .mlist button').first().click(); await page.locator('#mdlBody textarea').fill('skipped with a note');
    await page.click('#mdlFoot [data-skip]'); await page.locator('#mdlBody textarea').fill('handled'); await page.click('#mdlFoot [data-save]');
    await page.locator('#mdlBody textarea').fill('half an answer'); await page.locator('#mdlBody textarea').evaluate(t => { t.setSelectionRange(4, 4); t.dispatchEvent(new Event('keyup')); });
    const title = await page.locator('#mdlT').innerText(); await page.keyboard.press('Escape'); await card('reviews:').locator('.open').click();
    assert.equal(await page.locator('#mdlT').innerText(), title); assert.deepEqual(await page.locator('#mdlBody textarea').evaluate(t => [t.value, t.selectionStart]), ['half an answer', 4]);
    await page.click('#mdlBack'); assert.equal(await page.locator('#mdlBody .mlist li').count(), 4);
    await page.locator('#mdlBody .mlist button').first().click(); assert.equal(await page.locator('#mdlBody textarea').inputValue(), 'skipped with a note'); await page.keyboard.press('Escape');
    console.log('PASS phase4 D10-3 and D10-6: five reviews, skipped draft retained, one save removed, reopen restores item/draft/caret');

    await page.click('#rFiles'); await page.click('#tree [data-file="plan.md"]');
    await page.locator('#mdlEd').fill((await page.locator('#mdlEd').inputValue()) + '\n- [ ] grew into a real task');
    await page.locator('#mdlEd').evaluate(t => { t.focus(); t.setSelectionRange(t.value.length, t.value.length); });
    const selection = await page.locator('#mdlEd').evaluate(t => t.selectionStart); await page.click('#mdlPrimary');
    // Same race as D10-1 above (GitHub run 39724310852 lost it here): wait for the editor's focus, not a fixed 100 ms.
    await page.waitForFunction(() => document.activeElement?.id === 'devEd', null, { timeout: 5000 }).catch(() => {});
    assert.equal(await page.locator('.shell').getAttribute('data-focus'), 'dev');
    assert.equal(await page.locator('#devTabs [aria-selected="true"]').getAttribute('data-file'), 'plan.md');
    assert.deepEqual(await editor.evaluate(t => [document.activeElement === t, t.selectionStart, t.value.endsWith('grew into a real task')]), [true, selection, true]);
    assert.equal(await page.locator('#devTabs [data-file="server.ts"]').count(), 1);
    console.log('PASS phase4 D10-4: Make Primary carries draft/caret into Dev and keeps earlier tab');

    await page.evaluate(() => document.documentElement.style.setProperty('--toast-life', '0.1s'));
    await page.keyboard.press('Control+k'); await page.locator('#palette li', { hasText: 'Simulate a system notification' }).click();
    assert.equal(await page.locator('.toast', { hasText: 'nightly-backup' }).count(), 1);
    await page.locator('.toast', { hasText: 'nightly-backup' }).waitFor({ state: 'detached', timeout: 5000 });
    await page.keyboard.press('Control+Shift+N'); assert.equal(await page.locator('#mdlBody .mlist li', { hasText: 'nightly-backup' }).count(), 1);
    await page.keyboard.press('Escape'); console.log('PASS phase4 D10-5: faded toast remains in Notification Center');
    await page.setViewportSize({ width: 1280, height: 720 });
    for (const mode of ['chat', 'dev', 'mission']) {
      await focus(mode);
      assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth));
      assert.ok(await page.locator('#rBell').isVisible());
      assert.ok(await page.locator('#cards .card').evaluateAll(cards => cards.some(c => { const r = c.getBoundingClientRect(); return r.bottom <= innerHeight && r.right <= innerWidth; })));
    }
    console.log('PASS phase4 D10-7: all focus modes fit 1280x720; cards and Notification Center stay visible');
    await focus('chat');
    for (let index = 0; index < 4; index++) {
      await page.click('#histBtn');
      await page.locator('#histPop [data-open]').nth(index).click();
      assert.deepEqual(errors, []);
      assert.equal(await page.locator('#histPop').isVisible(), false);
      assert.equal(await page.locator('#chats [data-resume]').count(), 1);
      assert.match(await page.locator('#chats').innerText(), /Older events are not shown/);
    }
    console.log('PASS phase4 History: every entry renders conversation and Resume without errors, then closes the picker');
    // Copy output after a script run puts exactly that output on the clipboard; the page still cannot read it (threat model row 19).
    const saved = await application.evaluate(({ clipboard }) => clipboard.readText()); // the desktop's real clipboard, put back below
    try {
      await focus('mission'); await page.locator('#fMission [data-group]').first().click(); await page.locator('#mdlBody .mlist [data-i]').first().click();
      await page.click('#mdlFoot [data-run]'); if (await page.locator('#mdlFoot [data-run]', { hasText: 'Confirm' }).count()) await page.click('#mdlFoot [data-run]');
      await page.locator('#mdlFoot [data-copy]').waitFor(); await page.waitForFunction(() => !document.querySelector('#mdlBody pre.out').textContent.includes('running…'));
      await page.click('#mdlFoot [data-copy]');
      await page.locator('#mdlFoot [data-copy][data-said="Copied"]').waitFor({ timeout: 5000 });
      if (process.env.P9_SCREENSHOTS) { await mkdir(process.env.P9_SCREENSHOTS, { recursive: true }); await page.screenshot({ path: path.join(process.env.P9_SCREENSHOTS, 'copy-output.png') }); }
      const shown = await page.locator('#mdlBody pre.out').textContent();
      assert.ok(shown.split('\n').length > 2); assert.equal(await application.evaluate(({ clipboard }) => clipboard.readText()), shown);
      assert.equal(await page.evaluate(() => navigator.clipboard.readText().then(() => 'read', () => 'refused')), 'refused');
      await page.click('#mdlX');
    } finally { await application.evaluate(({ clipboard }, text) => clipboard.writeText(text), saved); }
    // Floating terminal: dragging the title bar moves it exactly with the cursor and selects nothing; the corner resizes it.
    await focus('chat'); await page.keyboard.press('Control+Backquote');
    const wasFloat = await page.locator('#dock.float').count(); if (!wasFloat) await page.click('#dFloat');
    const dockBox = () => page.locator('#dock').boundingBox();
    const d0 = await dockBox(), grab = [d0.x + 60, d0.y + 12];
    await page.mouse.move(...grab); await page.mouse.down(); await page.mouse.move(grab[0] - 150, grab[1] + 40, { steps: 8 }); await page.mouse.move(grab[0] - 200, grab[1] + 60, { steps: 4 }); await page.mouse.up();
    const d1 = await dockBox();
    assert.deepEqual([Math.round(d1.x - d0.x), Math.round(d1.y - d0.y), await page.evaluate(() => getSelection().toString())], [-200, 60, ''], 'moves with the cursor, selects nothing');
    await page.mouse.move(d1.x + d1.width - 3, d1.y + d1.height - 3); await page.mouse.down(); await page.mouse.move(d1.x + d1.width + 117, d1.y + d1.height + 77, { steps: 6 }); await page.mouse.up();
    const d2 = await dockBox();
    assert.deepEqual([Math.round(d2.width - d1.width), Math.round(d2.height - d1.height)], [120, 80], 'the corner resizes it');
    if (process.env.P9_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.P9_SCREENSHOTS, 'terminal-float.png') });
    if (!wasFloat) await page.click('#dFloat'); await page.keyboard.press('Control+Backquote');
    console.log('PASS floating terminal: drag follows the cursor with no selection, corner resize');
    console.log('PASS Copy output:script output on the clipboard, button says Copied; clipboard read refused');
    assert.deepEqual(errors, []);
    if (process.env.P9_SCREENSHOTS) {
      await mkdir(process.env.P9_SCREENSHOTS, { recursive: true });
      await page.setViewportSize({ width: 1440, height: 900 });
      for (const mode of ['chat', 'dev', 'mission']) { await focus(mode); await page.screenshot({ path: path.join(process.env.P9_SCREENSHOTS, `electron-${mode}.png`) }); }
      await writeFile(path.join(process.env.P9_SCREENSHOTS, 'desktop-check.json'), JSON.stringify({ preferences, csp, errors, refusal }, null, 2));
    }
    const navigation = await application.evaluate(async ({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      const events = { will: [], started: [], committed: [] };
      const started = (_event, url) => events.started.push(url);
      const committed = (_event, url) => events.committed.push(url);
      const before = contents.getURL();
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { cleanup(); reject(new Error('missing-will-navigate')); }, 5000);
        const cleanup = () => { clearTimeout(timeout); contents.off('will-navigate', will); contents.off('did-start-navigation', started); contents.off('did-navigate', committed); };
        const will = (event, url) => {
          events.will.push({ url, prevented: event.defaultPrevented });
          setImmediate(() => { cleanup(); resolve({ before, after: contents.getURL(), ...events }); });
        };
        contents.on('will-navigate', will);
        contents.on('did-start-navigation', started);
        contents.on('did-navigate', committed);
        void contents.executeJavaScript("window.open('https://example.com/'); location.href = 'https://example.com/';").catch(reject);
      });
    });
    assert.deepEqual(navigation.will, [{ url: 'https://example.com/', prevented: true }]);
    assert.deepEqual(navigation.committed, []);
    assert.ok(navigation.started.every(url => url === 'https://example.com/'));
    assert.equal(navigation.before, 'p9://app/'); assert.equal(navigation.after, navigation.before);
    // The popup was refused: the only pages are the shell and (since Phase 8) the Dev Focus view.
    assert.deepEqual(application.windows().map(page => page.url()).filter(url => !url.startsWith('p9://dev/')), ['p9://app/']);
    if (process.env.P9_SCREENSHOTS) await writeFile(path.join(process.env.P9_SCREENSHOTS, 'navigation-check.json'), JSON.stringify(navigation, null, 2));
  } finally { await application.close(); await rm(profile, { recursive: true, force: true }); }
});

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((result) => JSON.parse(result.text));

// Chunk 3 (v0.1.6): first launch and Mission Control. D13.5 maximised window, D9 empty Mission explains itself, D3 the
// starter-files step, D1 "Connect to a P9 on another machine" on the welcome screen, D6 an existing layout is attached,
// D4 labels use the owner's own name, D10 robot heads are numbered.
const openFirst = async (t, instance) => {
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-first-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#rChat').waitFor();
  const shot = async (name, locator = page) => { await page.waitForTimeout(500); const png = await locator.screenshot({ type: 'png' }); if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png.toString('base64')); };
  return { app, page, shot };
};

// One test per item, so one broken item fails only its own test and a single A/B run can break them all at once.
const signedIn = async ({ directory }) => { await mkdir(path.join(directory, '.claude'), { recursive: true }); await writeFile(path.join(directory, '.claude', '.credentials.json'), '{}'); };
const emptyFirst = async (t) => openFirst(t, await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] })));
const openWelcome = async (page) => {
  await page.locator('#cards [data-key="welcome"] .open').click();
  await page.locator('#welDlg[open]').waitFor({ timeout: 10000 });
  // The card opens at the first thing not done (sign in); Back reaches the welcome step.
  for (let back = 0; back < 4 && (await page.locator('#welT').textContent()) !== 'Welcome to Event Horizon'; back++) await page.locator('#welFoot [data-act="back"]').click();
  assert.equal(await page.locator('#welT').textContent(), 'Welcome to Event Horizon');
};

test('First launch D13.5: the main window is maximised when it is made', { timeout: 20000 }, async () => {
  // The test display has no window manager, so isMaximized() is false there whatever the code asks: check the call itself, right after the window is made.
  assert.match(await readFile(path.join(root, 'apps/desktop/main.mjs'), 'utf8'), /new BrowserWindow\([\s\S]{0,900}?\n  window\.removeMenu\(\);[^\n]*\n(?:  \/\/[^\n]*\n)*  window\.maximize\(\);/);
});

test('First launch D9: an empty Mission says what Mission Control is and offers Set up', { timeout: 60000 }, async (t) => {
  const { page, shot } = await emptyFirst(t);
  await page.click('#rMission');
  const intro = page.locator('#fMission [data-mission-intro]');
  await intro.waitFor({ timeout: 15000 });
  assert.match(await intro.innerText(), /What is Mission Control\?[\s\S]*buttons[\s\S]*apps and pages[\s\S]*waiting on you[\s\S]*Set up Mission Control/);
  await shot('mission-empty');
});

test('First launch D1: the welcome screen offers a P9 on another machine', { timeout: 60000 }, async (t) => {
  const { page, shot } = await emptyFirst(t);
  await openWelcome(page);
  const connect = page.locator('#welBody [data-act="remote"]');
  assert.match(await connect.innerText(), /Connect to a P9 on another machine/);
  await shot('wizard-welcome', page.locator('#welDlg'));
  await connect.click();
  await page.locator('#welBody [data-wiz-remote]').waitFor({ timeout: 10000 });
  assert.match(await page.locator('#welBody [data-wiz-remote]').innerText(), /ssh|Host/);
  await shot('wizard-welcome-remote', page.locator('#welDlg'));
  await page.locator('#welBody [data-act="remote"]').click();
  assert.equal(await page.locator('#welBody [data-wiz-remote]').count(), 0, 'Hide closes the choice');
});

test('First launch D3: the Mission step says what is created, what is not, and what the button does', { timeout: 60000 }, async (t) => {
  // Signed in, so the Set up card opens at the first thing not done: Mission Control's files (Next stays off until an agent is signed in).
  const { page, shot } = await openFirst(t, await daemon(t, undefined, false, async (where) => { await signedIn(where); return { args: ['--acp-override', fake] }; }));
  await page.locator('#cards [data-key="welcome"] .open').click();
  await page.locator('#welDlg[open]').waitFor({ timeout: 10000 });
  await page.locator('#welT', { hasText: 'Mission Control' }).waitFor({ timeout: 10000 });
  const step = await page.locator('#welBody').innerText();
  assert.match(step, /control room[\s\S]*buttons for your scripts[\s\S]*A file that is already there is never changed or replaced/);
  assert.match(step, /Create the starter files adds only this \(nothing that exists changes\)/);
  assert.match(step, /Makes the files listed above, empty, and points P9 at them\./);
  assert.match(step, /Mission Control files[\s\S]*Not there yet/);
  assert.equal(await page.locator('#welBody [data-act="starter"]').innerText(), 'Create the starter files');
  await shot('wizard-mission-step', page.locator('#welDlg'));
});

// A workspace that keeps its own layout: AGENTS.md in Work/, a registry in Work/tools, waiting items in Work/_waiting.
const layout = async ({ workspace }) => {
  await mkdir(path.join(workspace, 'Work/_waiting'), { recursive: true });
  await mkdir(path.join(workspace, 'Work/tools'), { recursive: true });
  await writeFile(path.join(workspace, 'Work/AGENTS.md'), '# Workspace\n');
  await writeFile(path.join(workspace, 'Work/tools/registry.json'), JSON.stringify({
    scripts: [{ id: 'backup', title: 'Back up', group: 'Maintenance', cmd: ['true'] }], apps: [], pages: [] }));
  await writeFile(path.join(workspace, 'Work/_waiting/alpha-question.md'), '# Which colour?\n\nA.\n');
};

test('First launch D6: the wizard finds the workspace\'s own layout and attaches it', { timeout: 90000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async (where) => { await layout(where); await signedIn(where); return { args: ['--acp-override', fake] }; });
  const { page, shot } = await openFirst(t, instance);
  const card = page.locator('#cards [data-key="welcome"]');
  await card.waitFor({ timeout: 15000 });
  await card.locator('.open').click();
  await page.locator('#welDlg[open]').waitFor({ timeout: 10000 });
  await page.locator('#welBody [data-path]').first().waitFor({ timeout: 10000 });
  // The nested main file, the registry and the _waiting folder are proposed, not the empty starter paths.
  assert.deepEqual((await page.locator('#welBody [data-path]').evaluateAll((all) => all.map((box) => box.value))).slice(0, 3), ['Work/AGENTS.md', 'Work/tools/registry.json', 'Work/_waiting']);
  assert.equal(await page.locator('#welBody [data-act="starter"]').innerText(), 'Use these files');
  assert.match(await page.locator('#welBody [data-creates]').innerText(), /^[^,]*settings\.json$/, 'only the settings file is written, no project files');
  await shot('wizard-mission-existing', page.locator('#welDlg'));
  await page.click('#welBody [data-act="starter"]');
  await page.locator('#welBody .ok', { hasText: 'Created:' }).waitFor({ timeout: 10000 }).catch(() => {});
  await page.evaluate(() => document.querySelector('#welDlg').close());
  await page.click('#rMission');
  await page.locator('#fMission .needs [data-list] li .kind').first().waitFor({ timeout: 20000 });
  assert.equal(await page.locator('#fMission [data-mission-intro]').count(), 0, 'a filled Mission has no intro');
  await shot('mission-filled');
});

test('First launch D4: a waiting item says who it waits on, from the owner\'s own name', { timeout: 90000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async (where) => {
    await layout(where);
    const file = path.join(where.directory, '.config', 'p9', 'settings.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ primary: 'Work/AGENTS.md', registry: 'Work/tools/registry.json', waiting: 'Work/_waiting' }));
    return { args: ['--acp-override', fake] };
  });
  const { page } = await openFirst(t, instance);
  await page.click('#rMission');
  const chip = page.locator('#fMission .needs [data-list] li .kind');
  await chip.first().waitFor({ timeout: 20000 });
  // A new profile's name is the account's own (the greeting's), so the chip reads it; it is never a fixed person.
  const own = await page.evaluate(async () => (await window.p9.getSettings()).name);
  assert.equal(await chip.first().textContent(), own ? 'needs ' + own : 'needs you');
  const reopen = async (name) => { await page.evaluate(async (name) => window.p9.setSettings({ ...(await window.p9.getSettings()), name }), name); await page.reload(); await page.click('#rMission'); await chip.first().waitFor({ timeout: 20000 }); return chip.first().textContent(); };
  assert.equal(await reopen('Sam'), 'needs Sam');
  assert.equal(await reopen(''), 'needs you');
});

test('First launch D10: two running chats are told apart by number and title', { timeout: 90000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const { page, shot } = await openFirst(t, instance);
  for (const text of ['first chat', 'second chat']) {
    const id = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
    await call(instance, `/chat/${id}/prompt`, 'POST', { text });
    await page.locator(`#rBots [data-bot="${id}"]`).waitFor({ timeout: 20000 });
  }
  const heads = await page.locator('#rBots [data-bot]').evaluateAll((all) => all.map((b) => [b.dataset.n, b.title, b.getAttribute('aria-label')]));
  assert.equal(heads.length, 2);
  assert.deepEqual(heads.map((h) => h[0]).sort(), ['1', '2']);
  for (const [n, title, label] of heads) { assert.match(title, new RegExp('^#' + n + ' .+ · (Claude|Codex) · (working|idle)$')); assert.equal(label, title); }
  assert.notEqual(heads[0][1], heads[1][1], 'the two heads read differently');
  await page.click('#rChat');
  await shot('rail-robot-heads', page.locator('.rail'));
});

// Items 24 and 25 (specs/move-progress-events.md check 4): the window draws main's p9:move stream over the moving chat,
// says when the server goes quiet, cancels through main, and on done asks "Open it on <host>?"; Enter switches with the
// host main sent. Main's handlers stand in for the move (its own stream is send-to-server.test.mjs).
test('Send to server: the black hole and bar follow p9:move; Cancel goes to main; done asks, then switches and reopens the chat; a reload mid-move asks to finish', { timeout: 150000 }, async (t) => {
  // The fake agent keeps a Claude Code transcript (claude-home), so the daemon can freeze the chat for the reload check.
  const instance = await daemon(t, undefined, false, async ({ workspace }) => {
    for (const marker of ['uuid-sessions', 'claude-home']) await writeFile(path.join(workspace, marker), '');
    return { args: ['--acp-override', fake] };
  });
  const { app, page, shot } = await openFirst(t, instance);
  const id = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'move me' });
  await page.locator(`#tabs .tab[data-id="${id}"]`).click();
  const pane = page.locator(`.pane[data-id="${id}"]`);
  await pane.waitFor();
  await app.evaluate(({ ipcMain }) => {
    globalThis.calls = [];
    for (const name of ['p9:server', 'p9:move-cancel']) ipcMain.removeHandler(name);
    ipcMain.handle('p9:server', (_event, ...args) => { globalThis.calls.push(['server', ...args]); return args.length ? { ok: true } : { host: null, last: 'test-host', connected: false, hosts: [] }; });
    ipcMain.handle('p9:move-cancel', (_event, ...args) => { globalThis.calls.push(['cancel', ...args]); return { cancelling: true }; });
  });
  let seq = 0;
  const move = (phase, percent, extra) => app.evaluate(({ BrowserWindow }, m) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === m.url).webContents.send('p9:move', m.move),
    { url: page.url(), move: { id, seq: ++seq, host: 'test-host', phase, percent, bytes: { sent: Math.round(percent * 100000), total: 10000000 }, ...extra } });
  const fx = page.locator('#moveFx'), b = await pane.boundingBox(); // the pane's place before it is pulled in
  await move('stopping', 0);
  await fx.waitFor();
  assert.equal(await pane.getAttribute('data-pulled'), '', 'the chat is pulled in');
  assert.equal(await page.locator('#moveWhat').textContent(), 'Pausing the chat here…');
  await move('connecting', 0);
  assert.equal(await page.locator('#moveWhat').textContent(), 'Connecting to test-host…');
  await move('uploading', 40);
  await page.waitForFunction(() => document.querySelector('#movePct').textContent === '40%');
  assert.equal(await page.locator('.move-bar').getAttribute('aria-valuenow'), '40');
  assert.equal(await page.locator('#moveBytes').textContent(), ' · 3.8 MB of 9.5 MB');
  // The overlay covers the chat's pane, not the window.
  const a = await fx.boundingBox();
  assert.deepEqual([a.x, a.y, a.width, a.height].map(Math.round), [b.x, b.y, b.width, b.height].map(Math.round));
  for (const n of [1, 2, 3]) await shot('move-frame-' + n, page);
  // No event for 15 s (three missed heartbeats): the label says so; the next event clears it.
  await page.locator('#moveFx[data-wait]').waitFor({ timeout: 20000 });
  assert.equal(await page.locator('#moveWhat').textContent(), 'Waiting for the server…');
  // Long after the chat has fallen in (scaled to a dot), the overlay still covers the pane's whole place.
  const c = await fx.boundingBox();
  assert.deepEqual([c.x, c.y, c.width, c.height].map(Math.round), [b.x, b.y, b.width, b.height].map(Math.round), 'the overlay keeps the pane\'s size');
  await shot('move-waiting', page);
  await move('uploading', 70);
  assert.equal(await fx.getAttribute('data-wait'), null);
  await page.click('#moveCancel');
  for (let i = 0; i < 50 && !(await app.evaluate(() => globalThis.calls.length)); i++) await page.waitForTimeout(100);
  assert.deepEqual(await app.evaluate(() => globalThis.calls), [['cancel', id]]);
  await move('landing', 99);
  assert.equal(await page.locator('#moveWhat').textContent(), 'test-host is setting it up…');
  assert.equal(await page.locator('#moveCancel').isVisible(), false, 'no Cancel once the server has it');
  await shot('move-landing', page);
  await move('done', 100);
  const ask = page.locator('#moveDlg');
  await ask.waitFor();
  assert.equal(await page.locator('#moveT').textContent(), 'Open it on test-host?');
  await shot('move-ask', page);
  // Enter from the "Don't show again" box still takes the switch (a form's own Enter would press Stay).
  await page.locator('#moveNever').check();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => localStorage.getItem('p9-after-move'));
  assert.deepEqual(await page.evaluate(() => [JSON.parse(localStorage.getItem('p9-after-move')), localStorage.getItem('p9-after-move-ask')]), [{ id }, 'open']);
  assert.deepEqual(await app.evaluate(() => globalThis.calls), [['cancel', id], ['server', 'test-host']]);
  // The reload main does: the chat opens in the pane and the key goes.
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await pane.waitFor({ timeout: 20000 });
  await page.waitForFunction(() => localStorage.getItem('p9-after-move') === null);
  // A window reloaded mid-move: the daemon says moving, main sends nothing for 6 s, so the window asks to finish. Yes asks
  // main to move it (here main has no server, and says so).
  let frozen;
  for (let i = 0; i < 100 && !(frozen = await call(instance, '/chat/' + id + '/send-away', 'POST', {})).session && frozen.error !== 'moving'; i++) await page.waitForTimeout(100);
  assert.ok(frozen.session || frozen.error === 'moving', JSON.stringify(frozen));
  await page.reload();
  await page.locator('#moveDlg[open]').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('#moveT').textContent(), 'Finish the move?');
  assert.equal(await page.locator('#moveNeverRow').isVisible(), false);
  await shot('move-finish-ask', page);
  await page.click('#moveYes');
  await pane.getByText('Not sent to the server: No server yet').waitFor({ timeout: 10000 });
  // Reduced motion: no sky, no mark; the bar, its label and Cancel.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await pane.waitFor({ timeout: 20000 });
  await move('uploading', 55);
  await fx.waitFor();
  assert.deepEqual(await page.evaluate(() => ['#moveSky', '.move-mark'].map((s) => getComputedStyle(document.querySelector(s)).display)), ['none', 'none']);
  await shot('move-reduced', page);
});
