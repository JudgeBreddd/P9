// SPIKE o294-min0 (throwaway branch, never merged): at 0 file tabs the editor area's 220 px minimum goes to 0 and the editor
// view is sized to the icon strip plus the file list, the workbench laid out at the view's real width. Records, asserts nothing.
import test from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, root, shellReady } from './helpers.mjs';
import { editorFor } from './editor-fixture.mjs';

const evidence = process.env.P9_EVIDENCE;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const SIDE = 'workbench.parts.sidebar';

test('SPIKE o294-min0', { skip: process.platform !== 'linux', timeout: 400000 }, async t => {
  const editor = await editorFor();
  if (!editor) return t.skip('needs the editor server');
  const instance = await daemon(t);
  await writeFile(path.join(instance.workspace, 'note.txt'), 'note\n');
  await writeFile(path.join(instance.workspace, 'other.txt'), 'other\n');
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-spike-'));
  const env = { ...process.env, HOME: home, PATH: editor.path, P9_EDITOR_HOST: editor.host }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + path.join(home, 'profile')], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close().catch(() => {}), sleep(15000)]); proc.kill(); });
  const shell = await app.firstWindow();
  await shellReady(shell);
  const devWindow = app.waitForEvent('window', { predicate: page => page.url().startsWith('p9://dev/'), timeout: 60000 });
  await shell.keyboard.press('Control+2');
  const dev = await devWindow;
  await dev.waitForFunction(() => window.devFocusReady, null, { timeout: 120000 });
  const R = {};
  const probe = async (name, body) => { try { R[name] = await body(); } catch (error) { R[name] = 'THREW ' + String(error.message ?? error).split('\n')[0].slice(0, 300); } console.log('SPIKE ' + name + ': ' + JSON.stringify(R[name])); };
  const shot = async name => { if (!evidence) return; await mkdir(evidence, { recursive: true }); await writeFile(path.join(evidence, name + '.jpg'), await dev.screenshot({ type: 'jpeg', quality: 80 })); };
  // What the workbench shows: part widths (0 when hidden) and the page's own width.
  const parts = () => dev.evaluate(() => {
    const w = sel => { const el = document.querySelector(sel); return el && el.offsetParent !== null ? Math.round(el.getBoundingClientRect().width) : 0; };
    const r = sel => Math.round(document.querySelector(sel)?.getBoundingClientRect().right ?? 0);
    return { page: innerWidth, act: w('.part.activitybar'), side: w('.part.sidebar'), sideRight: r('.part.sidebar'), editor: w('.part.editor'), tabs: window.devFocus.v.window.tabGroups.all.reduce((n, g) => n + g.tabs.length, 0) };
  });
  // The editor view's bounds in the window (main), and setting its width (P9's job in a build; the test stands in for it).
  const devView = fn => app.evaluate(({ BrowserWindow }, fn) => {
    for (const win of BrowserWindow.getAllWindows()) for (const view of win.contentView.children)
      if (view.webContents?.getURL().startsWith('p9://dev/')) return new Function('view', fn)(view);
    return 'no view';
  }, fn);
  const bounds = () => devView('return view.getBounds()');
  const setWidth = width => devView(`const b = view.getBounds(); view.setBounds({ ...b, width: ${width} }); return view.getBounds();`);
  const minWidth = n => dev.evaluate(n => { window.devFocus.minDims.width = n; window.devFocus.maxDims.width = n === 0 ? 0 : Number.POSITIVE_INFINITY; window.devFocus.layout.layout(); }, n);
  // P9's rule at 0 tabs, as a build would run it: the view's width = the icon strip plus the file list (when shown) at width W.
  const follow = async W => {
    const p = await parts(), shown = p.side > 0;
    await setWidth(p.act + (shown ? W : 0));
    await sleep(400);
    return parts();
  };
  await dev.evaluate(() => window.devFocus.open('note.txt'));
  await sleep(2000);
  const before = { bounds: await bounds(), parts: await parts() }, W = before.parts.side;
  console.log('SPIKE before (1 tab): ' + JSON.stringify(before));
  await shot('min0-0-before');
  await probe('1 file list at full width, no editor sliver', async () => {
    await dev.evaluate(() => window.devFocus.v.commands.executeCommand('workbench.action.closeAllEditors'));
    await sleep(800);
    await minWidth(0);
    const p = await follow(W); await sleep(1000);
    const later = { bounds: await bounds(), parts: await parts() };
    await shot('min0-1-files-only');
    return { pass: later.parts.editor <= 1 && later.parts.side === W && later.bounds.width === later.parts.act + W, right: p, oneSecondLater: later };
  });
  await probe('2 the view width drives the file list (+100 / -100)', async () => {
    const p = await parts();
    const sash = await dev.evaluate(x => { const el = document.elementFromPoint(x, 300); return el ? el.className.toString().slice(0, 80) : null; }, p.sideRight - 2);
    await setWidth(p.page + 100); await sleep(500); const wider = await parts(); await shot('min0-2-wider');
    await setWidth(p.page); await sleep(500); const back = await parts(); await shot('min0-2-narrower');
    return { pass: wider.side === p.side + 100 && wider.editor <= 1 && back.side === p.side && back.editor <= 1, sashUnderPointer: sash, start: p, wider, back };
  });
  const W2 = (await parts()).side;
  await probe('3 Ctrl+B hides and shows the file list', async () => {
    await dev.evaluate(() => window.devFocus.v.commands.executeCommand('workbench.files.action.focusFilesExplorer'));
    await sleep(300);
    await dev.keyboard.press('Control+b'); await sleep(500);
    const hidden = await parts(), hiddenFollowed = await follow(W2);
    await shot('min0-3-ctrl-b-hidden');
    await dev.keyboard.press('Control+b'); await sleep(500);
    const shownRaw = await parts(), shownFollowed = await follow(W2);
    await shot('min0-3-ctrl-b-shown');
    return { pass: hiddenFollowed.side === 0 && hiddenFollowed.editor <= 1 && shownFollowed.side === W2 && shownFollowed.editor <= 1, hidden, hiddenFollowed, shownRaw, shownFollowed };
  });
  await probe('4 command palette opens in view', async () => {
    await dev.keyboard.press('F1'); await sleep(800);
    const box = await dev.evaluate(() => { const el = document.querySelector('.quick-input-widget'); if (!el || el.offsetParent === null) return null; const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), width: Math.round(r.width), page: innerWidth }; });
    await shot('min0-4-palette');
    await dev.keyboard.press('Escape'); await sleep(300);
    return { pass: !!box && box.left >= 0 && box.right <= box.page, box };
  });
  await probe('5 clicking a file brings the editor back at the earlier split', async () => {
    await dev.locator('.explorer-folders-view .monaco-list-row', { hasText: 'note.txt' }).first().click();
    await sleep(800);
    const opened = await parts();
    await minWidth(220); await setWidth(before.bounds.width); await sleep(400);
    await dev.evaluate(({ W, SIDE }) => { const l = window.devFocus.layout; l.setSize(SIDE, { width: W, height: l.getSize(SIDE).height }); l.layout(); }, { W: W2, SIDE });
    await sleep(800);
    const back = { bounds: await bounds(), parts: await parts() };
    await shot('min0-5-file-back');
    return { pass: back.parts.tabs === 1 && back.parts.side === W2 && back.parts.editor === before.parts.page - before.parts.act - W2, whileNarrow: opened, back, expectedEditor: before.parts.page - before.parts.act - W2 };
  });
  console.log('SPIKE RESULT ' + JSON.stringify(Object.fromEntries(Object.entries(R).map(([k, v]) => [k, v?.pass ?? v]))));
});
