// Chat Focus file modal, editable (v0.1.6 chunk 12, item 17; threat model rows 23, 4, 7): a real file opens in the same editor as
// Dev Focus's fallback, Save is the p9:mission "save" action = the daemon's guarded PUT /files, a changed file shows the conflict
// and nothing is overwritten, and the main process refuses anything but {path, hash, content} before a request is made.
// Real Electron against a real daemon. The dev space keeps no files: pictures go out in the log as "P9_SHOT <name> <base64>"
// and are written to P9_SCREENSHOTS when that is set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, root } from './helpers.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const long = Array.from({ length: 120 }, (_, i) => 'line ' + (i + 1)).join('\n') + '\n';

test('Chat Focus file modal: edit and Save through the guarded PUT /files, a changed file shows the conflict and is never overwritten, bad input is refused in main (A/B)', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async (paths) => {
    const w = paths.workspace;
    for (const dir of ['_tyler', '_ideas', '_private', 'hub', 'proj']) await mkdir(path.join(w, dir), { recursive: true });
    await writeFile(path.join(w, 'hub/registry.json'), JSON.stringify({ scripts: [], apps: [], pages: [] }));
    await writeFile(path.join(w, 'AGENTS.md'), '# Projects\n\n**Main project: Proj** (`proj/`)\n');
    await writeFile(path.join(w, 'proj/notes.md'), 'project notes\nline two\n');
    await writeFile(path.join(w, 'proj/conflict.md'), 'before\n');
    await writeFile(path.join(w, 'proj/long.md'), long);
    await writeFile(path.join(w, '_tyler/question.md'), '# Question\n\nA.\n');
    await writeFile(path.join(w, '_' + 'private/secret.md'), 'secret\n');
    await symlink(paths.directory, path.join(w, 'out'));
    await writeFile(path.join(paths.directory, 'settings.json'), JSON.stringify({ waiting: '_tyler', registry: 'hub/registry.json', primary: 'AGENTS.md' }));
    return { args: ['--acp-override', fake, '--settings', path.join(paths.directory, 'settings.json')] };
  });
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-edit-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1300, height: 860 }).catch(() => {});
  await page.locator('#rBell b', { hasText: '1' }).waitFor({ timeout: 15000 });
  const disk = (name) => readFile(path.join(instance.workspace, name), 'utf8');
  const shot = async (name) => {
    const png = await page.screenshot({ animations: 'disabled' });
    if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png.toString('base64'));
    if (process.env.P9_SCREENSHOTS) { await mkdir(process.env.P9_SCREENSHOTS, { recursive: true }); await writeFile(path.join(process.env.P9_SCREENSHOTS, name + '.png'), png); }
  };
  const openFile = async (name) => {
    await page.locator(`#tree [data-lfile="${name}"]`).click();
    await page.waitForFunction((n) => document.querySelector('#mdlT')?.textContent === n && document.querySelector('#mdlBody textarea')?.value.length > 0, name, { timeout: 8000 });
  };
  const ask = (action, payload) => page.evaluate(([a, p]) => window.p9.mission(a, p), [action, payload]);
  await page.click('#rFiles');
  await page.locator('#tree .where', { hasText: 'proj' }).waitFor({ timeout: 5000 });

  // 1. It opens as the editor, and Save writes the file through the daemon.
  await openFile('proj/notes.md');
  assert.equal(await page.locator('#mdlBody textarea').inputValue(), 'project notes\nline two\n');
  assert.equal(await page.locator('#mdlFoot [data-savefile]').count(), 0, 'nothing to save yet');
  await page.locator('#mdlBody textarea').fill('project notes\nline two\nline three, typed here\n');
  await page.locator('#mdlFoot [data-savefile]').waitFor();
  await shot('file-modal-editable');
  await page.locator('#mdlFoot [data-savefile]').click();
  await page.locator('#mdlFoot', { hasText: 'saved' }).waitFor({ timeout: 5000 });
  assert.equal(await disk('proj/notes.md'), 'project notes\nline two\nline three, typed here\n', 'Save wrote the file');
  await page.keyboard.press('Escape');

  // 2. Ctrl S saves too, and a reopen reads the new text from the disk.
  await openFile('proj/notes.md');
  await page.locator('#mdlBody textarea').fill('second save\n'); await page.locator('#mdlBody textarea').press('Control+s');
  await page.locator('#mdlFoot', { hasText: 'saved' }).waitFor({ timeout: 5000 });
  assert.equal(await disk('proj/notes.md'), 'second save\n');
  await page.keyboard.press('Escape');

  // 3. A file that changed behind the modal: 409, the banner, the disk text untouched; Load disk version shows it.
  await openFile('proj/conflict.md');
  await writeFile(path.join(instance.workspace, 'proj/conflict.md'), 'changed by someone else\n');
  await page.locator('#mdlBody textarea').fill('my edit\n');
  await page.locator('#mdlFoot [data-savefile]').click();
  await page.locator('#mdlBody [data-conflict]').waitFor({ timeout: 5000 });
  assert.equal(await disk('proj/conflict.md'), 'changed by someone else\n', 'the conflict overwrote nothing');
  assert.equal(await page.locator('#mdlBody textarea').inputValue(), 'my edit\n', 'and my text is still here');
  const [bannerH, editorH] = await Promise.all([page.locator('#mdlBody [data-conflict]').evaluate(e => e.getBoundingClientRect().height), page.locator('#mdlBody .ed').evaluate(e => e.getBoundingClientRect().height)]);
  assert.ok(bannerH < 160 && editorH > 200, 'the conflict notice is a strip above the editor, not the editor squeezed below it: ' + bannerH + ' / ' + editorH);
  await shot('file-modal-conflict');
  await page.locator('#mdlBody [data-disk]').click();
  await page.waitForFunction(() => document.querySelector('#mdlBody textarea')?.value === 'changed by someone else\n');
  assert.equal(await page.locator('#mdlBody [data-conflict]').count(), 0);
  await page.keyboard.press('Escape');

  // 4. It scrolls and is resizable like the other modals.
  await openFile('proj/long.md');
  const m = await page.evaluate(() => { const t = document.querySelector('#mdlBody textarea'), d = document.querySelector('dialog.mdl, .mdl'); return { scroll: t.scrollHeight > t.clientHeight, resize: getComputedStyle(d).resize, overflow: getComputedStyle(t).overflowY }; });
  assert.deepEqual(m, { scroll: true, resize: 'both', overflow: 'auto' }, 'the text scrolls inside the modal and the modal resizes');
  // the modal opens near its max-width (94vw), so size it from inside the limits: 520 px, then 600 px
  for (const w of [520, 600]) {
    await page.evaluate(w => { document.querySelector('.mdl').style.width = w + 'px'; }, w);
    const got = await page.waitForFunction(w => { const d = document.querySelector('.mdl'); return Math.abs(d.getBoundingClientRect().width - w) <= 1; }, w, { timeout: 2000 }).then(() => true, async () => JSON.stringify(await page.evaluate(() => { const d = document.querySelector('.mdl'), c = getComputedStyle(d); return { tag: d.tagName, inline: d.style.width, width: c.width, rect: d.getBoundingClientRect().width, max: c.maxWidth, min: c.minWidth, vw: innerWidth, transition: c.transitionProperty }; })));
    assert.equal(got, true, 'its width follows the resize to ' + w + ': ' + got);
  }
  await page.keyboard.press('Escape');

  // 5. The main process refuses anything that is not exactly {path, hash, content} before asking the daemon; the daemon refuses the rest.
  const refused = { status: 400, body: { error: 'request-refused' } }, hash = (await ask('read', { path: 'proj/notes.md' })).body.hash;
  for (const payload of [{}, { path: 7, hash, content: 'x' }, { path: 'proj/notes.md', hash: 'abc', content: 'x' }, { path: 'proj/notes.md', hash, content: 7 }, { path: 'proj/notes.md', hash, content: 'x', extra: 1 },
    { path: 'proj/notes.md', content: 'x' }, { path: 'p'.repeat(1001), hash, content: 'x' }, { path: 'proj/notes.md', hash, content: 'x'.repeat(2 * 1024 * 1024 + 1) }]) {
    assert.deepEqual(await ask('save', payload), refused, JSON.stringify(payload).slice(0, 80));
  }
  for (const name of ['../x.md', 'out/settings.json', '_' + 'private/secret.md', 'proj/../_' + 'private/secret.md']) {
    const r = await ask('save', { path: name, hash, content: 'owned\n' });
    assert.ok(r.status >= 400, name + ' must not save: ' + r.status);
  }
  assert.equal(await disk('_' + 'private/secret.md'), 'secret\n'); assert.equal(await disk('proj/notes.md'), 'second save\n');
  const wrong = await ask('save', { path: 'proj/notes.md', hash: '0'.repeat(64), content: 'blind\n' });
  assert.equal(wrong.status, 409, 'a stale hash is a conflict'); assert.equal(await disk('proj/notes.md'), 'second save\n');
  await assert.rejects(ask('write', { path: 'proj/notes.md', content: 'x' }), /ipc-sender-refused/);
  // (A third argument never reaches main: the frozen preload forwards the action and the payload only; main's args.length check is a second lock.)
});
