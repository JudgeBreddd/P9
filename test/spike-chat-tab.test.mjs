// SPIKE o294 (throwaway branch, never merged): the shell's page opened in a workbench tab. Records what works and what
// breaks; asserts nothing. Prints one SPIKE line per probe and saves screenshots with P9_EVIDENCE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, http, authenticated, root, shellReady } from './helpers.mjs';
import { editorFor } from './editor-fixture.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const evidence = process.env.P9_EVIDENCE;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then(result => ({ status: result.status, ...JSON.parse(result.text) }));
const events = async (instance, id) => {
  const all = [];
  for (let after = 0, page; (page = await call(instance, '/chat/events?after=' + after + '&only=' + id)).events.length; after = page.cursor) all.push(...page.events);
  return all;
};
const until = async (check, ms = 15000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) if (await check().catch(() => false)) return true; return false; };
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
async function shot(page, name) {
  if (!evidence) return;
  await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, name + '.jpg'), await page.screenshot({ type: 'jpeg', quality: 80 }));
}

test('SPIKE o294: the shell page in a workbench tab', { skip: process.platform !== 'linux', timeout: 480000 }, async t => {
  const editor = await editorFor();
  if (!editor) return t.skip('needs the editor server');
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  await writeFile(path.join(instance.workspace, 'note.txt'), 'note\n');
  await writeFile(path.join(instance.workspace, 'pic.png'), Buffer.from(PNG, 'base64'));
  const id = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'hello' });
  const agentSaid = async text => (await events(instance, id)).some(e => e.type === 'update' && e.data.content?.text === text);
  assert.ok(await until(() => agentSaid('echo:hello')), 'hello answered');
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-spike-'));
  const env = { ...process.env, HOME: home, PATH: editor.path, P9_EDITOR_HOST: editor.host }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + path.join(home, 'profile')], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close().catch(() => {}), sleep(15000)]); proc.kill(); });
  const shell = await app.firstWindow();
  await shellReady(shell);
  const devWindow = app.waitForEvent('window', { predicate: page => page.url().startsWith('p9://dev/'), timeout: 60000 });
  await shell.keyboard.press('Control+2');
  const dev = await devWindow, logs = [];
  dev.on('console', m => (m.type() === 'error' || m.type() === 'warning') && logs.push(m.type() + ': ' + m.text().slice(0, 300)));
  dev.on('pageerror', e => logs.push('pageerror: ' + (e.message ?? e).slice(0, 300)));
  await dev.waitForFunction(() => window.devFocusReady || document.querySelector('#status')?.textContent, null, { timeout: 120000 });
  const R = {};
  const probe = async (name, body) => { try { R[name] = await body(); } catch (error) { R[name] = 'THREW ' + String(error.message ?? error).split('\n')[0].slice(0, 300); } console.log('SPIKE ' + name + ': ' + JSON.stringify(R[name])); };
  const groups = () => dev.evaluate(() => window.devFocus.v.window.tabGroups.all.map(g => g.tabs.map(tab => tab.label)));
  await dev.evaluate(() => window.devFocus.open('note.txt'));
  await sleep(1500);
  // The chat tab: a webview panel beside the file holding the shell page (p9://chat/ serves the shell's files).
  await probe('open tab', () => dev.evaluate(() => {
    const panel = window.devFocus.v.window.createWebviewPanel('p9.chat', 'Chat', { viewColumn: 2 }, { enableScripts: true, retainContextWhenHidden: true });
    panel.webview.html = '<!doctype html><html><body style="margin:0;height:100vh;overflow:hidden"><iframe src="p9://chat/" style="border:0;width:100%;height:100%" allow="clipboard-read; clipboard-write"></iframe></body></html>';
    window.__chatPanel = panel; return 'created';
  }));
  let frame = null;
  await until(async () => (frame = dev.frames().find(f => f.url().startsWith('p9://chat/'))), 30000);
  await probe('frame loaded', async () => frame ? frame.url() : { missing: true, frames: dev.frames().map(f => f.url().slice(0, 80)) });
  if (!frame) { console.log('SPIKE logs: ' + JSON.stringify(logs.slice(0, 30))); await shot(dev, 'spike-no-frame'); return; }
  frame.on?.('console', () => {});
  await probe('bridge present', () => frame.evaluate(() => typeof window.p9?.chat));
  await probe('session (chat list from the daemon)', async () => (await until(() => frame.locator('#navList .row[data-chat="' + id + '"]').count().then(n => n > 0), 30000)) ? 'listed' : { listed: false, body: (await frame.evaluate(() => document.body.innerText.slice(0, 300))) });
  await probe('boot (status bar texts)', () => frame.evaluate(() => [document.querySelector('#dataNote')?.textContent, document.querySelector('#daemonStatus')?.textContent]));
  await probe('first-run walkthrough skipped', async () => { const skip = frame.getByRole('button', { name: 'Skip', exact: true }); if (!await skip.count()) return 'none'; await skip.first().click(); return 'skipped'; });
  console.log('SPIKE logs so far: ' + JSON.stringify(logs.filter(l => !/EAI_AGAIN|ENOTFOUND|ECONNREFUSED/.test(l)).slice(0, 40)));
  await frame.evaluate(() => { window.__mark = 'kept'; });
  await shot(dev, 'spike-1-file-and-chat');
  await probe('open the chat', async () => { await frame.locator('#nav .row[data-chat="' + id + '"]').click({ timeout: 10000 }); return (await until(() => frame.locator('.pane[data-id="' + id + '"] .composer textarea').isVisible(), 15000)) ? 'pane' : 'no pane'; });
  const pane = frame.locator('.pane[data-id="' + id + '"]');
  await probe('focus: click into the box, keys land there', async () => { await pane.locator('.composer textarea').click({ timeout: 10000 }); await dev.keyboard.type('spike'); return frame.evaluate(() => [document.activeElement?.tagName, document.activeElement?.value?.trim()]); });
  await probe('send (Enter)', async () => { await dev.keyboard.press('Enter'); return (await until(async () => (await events(instance, id)).some(e => e.type === 'user' && e.data.text === 'spike'), 15000)) ? 'daemon got it' : 'not sent'; });
  await probe('streaming (reply shows in the tab)', async () => (await until(() => pane.innerText().then(text => text.includes('echo:spike')), 20000)) ? 'shown' : 'not shown');
  await probe('paperclip', async () => {
    const chooser = dev.waitForEvent('filechooser', { timeout: 10000 }).catch(error => error);
    await pane.locator('[data-attach]').click({ timeout: 10000 });
    const got = await chooser; if (got instanceof Error) return 'no file chooser: ' + got.message.split('\n')[0];
    await got.setFiles(path.join(instance.workspace, 'pic.png'));
    return (await until(() => pane.locator('.attach .att').count().then(n => n > 0), 10000)) ? 'attached' : 'not attached';
  });
  await probe('paste an image (Ctrl+V)', async () => {
    const before = await pane.locator('.attach .att').count();
    await app.evaluate(({ clipboard, nativeImage }, png) => clipboard.writeImage(nativeImage.createFromDataURL('data:image/png;base64,' + png)), PNG);
    await pane.locator('.composer textarea').click({ timeout: 10000 }); await dev.keyboard.press('Control+V');
    return (await until(() => pane.locator('.attach .att').count().then(n => n > before), 10000)) ? 'attached' : 'not attached (' + before + ' before)';
  });
  await probe('desktop bridge call (getStatus)', () => frame.evaluate(() => window.p9.getStatus().then(r => 'answered: ' + Object.keys(r ?? {}).slice(0, 6).join(','), e => 'refused: ' + e.message)));
  await probe('Ctrl+P from the chat box opens quick open', async () => { await pane.locator('.composer textarea').click({ timeout: 10000 }); await dev.keyboard.press('Control+P'); await sleep(800);
    const open = await dev.evaluate(() => { const w = document.querySelector('.quick-input-widget'); return !!w && getComputedStyle(w).display !== 'none'; }); await dev.keyboard.press('Escape'); return open; });
  await probe('F1 from the file opens the palette over the chat', async () => { await dev.evaluate(() => window.devFocus.v.commands.executeCommand('workbench.action.focusFirstEditorGroup')); await dev.keyboard.press('F1'); await sleep(800);
    const open = await dev.evaluate(() => { const w = document.querySelector('.quick-input-widget'); return !!w && getComputedStyle(w).display !== 'none'; }); await shot(dev, 'spike-palette'); await dev.keyboard.press('Escape'); return open; });
  await probe('Ctrl+1 from the chat box switches focus', async () => { await pane.locator('.composer textarea').click({ timeout: 10000 }); await dev.keyboard.press('Control+1'); await sleep(800);
    const focus = await shell.evaluate(() => document.querySelector('.shell')?.dataset.focus); await shell.keyboard.press('Control+2'); await sleep(1500); return focus; });
  await probe('groups with file + chat', groups);
  // Close the file's last tab: closeEmptyGroups removes its column and the chat's column fills the space.
  await probe('chat only after the last file tab closes', async () => {
    await dev.evaluate(async () => { const { v } = window.devFocus, g = v.window.tabGroups.all.find(g => g.tabs.some(tab => tab.label === 'note.txt')); await v.window.tabGroups.close(g.tabs); });
    await sleep(1500);
    return { groups: await groups(), chatWidth: await dev.evaluate(() => Math.round([...document.querySelectorAll('.part.editor iframe')].find(f => f.offsetParent)?.getBoundingClientRect().width ?? 0)), editorWidth: await dev.evaluate(() => Math.round(document.querySelector('.part.editor').getBoundingClientRect().width)), mark: await frame.evaluate(() => window.__mark).catch(e => 'frame gone: ' + e.message) };
  });
  await shot(dev, 'spike-2-chat-only');
  // Clicking a file in the list from chat only: where does it open (a tab over the chat, or beside it)?
  await probe('a file opened from chat only', async () => { await dev.evaluate(() => window.devFocus.open('note.txt')); await sleep(1500); return groups(); });
  await shot(dev, 'spike-3-file-over-chat');
  await probe('chat state after being behind a file tab', async () => { const f = dev.frames().find(f => f.url().startsWith('p9://chat/')); return f ? f.evaluate(() => window.__mark ?? 'reloaded') : 'no frame (unloaded)'; });
  await probe('chat state after moving its tab to another column', async () => {
    await dev.evaluate(() => window.__chatPanel.reveal(1)); await sleep(500);
    await dev.evaluate(() => window.devFocus.v.commands.executeCommand('workbench.action.moveEditorToNextGroup')); await sleep(2000);
    const f = dev.frames().find(f => f.url().startsWith('p9://chat/')); return { groups: await groups(), mark: f ? await f.evaluate(() => window.__mark ?? 'reloaded') : 'no frame' };
  });
  await shot(dev, 'spike-4-moved');
  await probe('nothing open after both close', async () => { await dev.evaluate(() => window.devFocus.v.commands.executeCommand('workbench.action.closeAllEditors')); await sleep(1500); return { groups: await groups(), hints: await dev.evaluate(() => !!document.querySelector('.editor-group-watermark') && document.querySelector('.editor-group-watermark').offsetParent !== null) }; });
  await shot(dev, 'spike-5-nothing-open');
  console.log('SPIKE logs: ' + JSON.stringify(logs.filter(l => !/EAI_AGAIN|ENOTFOUND|ECONNREFUSED/.test(l)).slice(0, 40)));
  console.log('SPIKE RESULT ' + JSON.stringify(R));
});
