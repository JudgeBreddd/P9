// O177: the folder-sprint close screen says plainly what happens (the screen text is the product copy from the row).
// Yes is today's Apply (the same call, the yes + shown gate untouched); No closes the screen and writes nothing.
// A real copy fixture: the linked folder is a git repo at its baseline; the sprint's copy is the one P9 itself makes
// (startCopy), holding one change commit past that baseline, so saving means writing the change into the linked folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { _electron } from '@playwright/test';
import { daemon, root, versionSeen, http, authenticated } from './helpers.mjs';
import { startCopy } from '../apps/server/folder-copy.mjs';

const ID = '0123abcd-0000-4000-8000-000000000007';
const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();
const call = (instance, route, method = 'GET', body) => http({ socketPath: instance.credentials.socketPath, route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => ({ status: r.status, body: JSON.parse(r.text || '{}') }));

async function openCopyScreen(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'p9-yesno-'));
  const solo = path.join(base, 'solo'); // the linked project folder, left at its baseline
  g(base, 'init', '-q', '-b', 'main', solo);
  await writeFile(path.join(solo, 'a.txt'), 'one\n');
  g(solo, 'add', '-A'); g(solo, 'commit', '-qm', 'first');
  const own = path.join(base, 'own');
  await mkdir(own, { mode: 0o700 }); // the ownership dir the daemon accepts (0700, this uid)
  const sprintDir = path.join(own, 'sprints', ID);
  const made = await startCopy(sprintDir, solo); // the copy P9 itself makes, with the record the apply reads
  assert.equal(made.error, undefined, made.detail);
  const copy = path.join(sprintDir, 'copy');
  await writeFile(path.join(copy, 'a.txt'), 'two\n');
  await writeFile(path.join(copy, 'b.txt'), 'new\n'); // the sprint's one change: a.txt modified, b.txt added — only in the copy
  g(copy, 'add', '-A'); g(copy, 'commit', '-qm', 'second');
  const instance = await daemon(t, undefined, false, async (paths) => {
    for (const dir of ['hub', 'projects', 'waiting']) await mkdir(path.join(paths.workspace, dir), { recursive: true });
    await writeFile(path.join(paths.workspace, 'hub', 'registry.json'), JSON.stringify({ scripts: [
      { id: 'sprint-start', title: 'Sprint start', group: 'Sprint', cmd: [process.execPath, '-e', 'console.log("start-" + "ok")'], confirm: true }], apps: [], pages: [] }));
    await writeFile(path.join(paths.workspace, 'projects', 'AGENTS.md'), '# Projects\n');
    await writeFile(path.join(paths.directory, 'settings.json'), JSON.stringify({ registry: 'hub/registry.json', primary: 'projects/AGENTS.md', waiting: 'waiting' }));
    return { args: ['--settings', path.join(paths.directory, 'settings.json'), '--ownership', own] };
  });
  assert.equal((await call(instance, '/file-protection', 'POST', { on: false })).status, 200, 'file protection off so Yes may write');
  const status = path.join(instance.directory, '.local', 'state', 'sprint', 'status.json');
  await mkdir(path.dirname(status), { recursive: true });
  await writeFile(status, JSON.stringify({ sprint: 'Copy sprint', updatedAt: new Date().toISOString(), chunks: [{ id: 'c1', title: 'One', state: 'running', percent: 10 }] }));
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-yesno-')), 'profile');
  await mkdir(profile); await versionSeen(profile);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#rMission').click();
  const tile = page.locator('#fMission [data-sprint]');
  await tile.waitFor({ timeout: 15000 }).catch(async (error) => { console.log('P9_YESNO no tile: ' + JSON.stringify(await page.evaluate(() => ({ mission: document.querySelector('#fMission')?.innerText.slice(0, 300) })))); throw error; });
  await tile.click();
  const copyBtn = page.locator(`#mdl [data-copies] [data-copy="${ID}"]`);
  await copyBtn.waitFor({ timeout: 10000 });
  // One real click, then a bounded wait for the modal. A press sometimes opened nothing in earlier runs; cause not found.
  await copyBtn.click({ timeout: 10000 });
  await page.locator('#mdlT', { hasText: 'Folder sprint' }).waitFor({ timeout: 10000 })
    .catch(async (error) => { console.log('P9_YESNO first click lost: ' + JSON.stringify(await page.evaluate(() => ({ title: document.querySelector('#mdlT')?.innerText, open: [...document.querySelectorAll('dialog[open]')].map((d) => d.id), body: document.querySelector('#mdlBody')?.innerText.slice(0, 300), copies: document.querySelector('#mdl [data-copies]')?.innerText.slice(0, 200) })))); throw error; });
  await page.waitForFunction(() => !/Loading/.test(document.querySelector('#mdlBody').innerText), null, { timeout: 15000 });
  return { solo, sprintDir, page };
}

const readScreen = (page) => page.locator('#mdlBody').innerText();
async function assertScreen(page) {
  const text = await readScreen(page);
  if (!/These are the files that were edited during the sprint/.test(text)) {
    console.log('P9_YESNO screen: ' + JSON.stringify(await page.evaluate(() => ({ title: document.querySelector('#mdlT')?.innerText, open: [...document.querySelectorAll('dialog[open]')].map((d) => d.id), body: document.querySelector('#mdlBody')?.innerText.slice(0, 500), foot: document.querySelector('#mdlFoot')?.innerText }))));
  }
  assert.match(text, /These are the files that were edited during the sprint, only in P9\. Do you want to save them to your linked project folder\?/,
    'the screen says plainly what happens');
  assert.match(text, /M a\.txt/, 'the modified file is listed');
  assert.match(text, /A b\.txt/, 'the added file is listed');
  assert.doesNotMatch(text, /Changes to apply to your folder|Nothing is written until you press Apply/, 'the old heading and line are gone');
  assert.match(text, /A file changed since this was shown is refused\./, 'the refusal line stays');
  const buttons = page.locator('#mdlFoot button');
  assert.equal(await buttons.count(), 2, 'exactly the two buttons');
  assert.equal(await page.locator('#mdlFoot [data-copy-apply]').innerText(), 'Yes');
  assert.equal(await page.locator('#mdlFoot [data-copy-no]').innerText(), 'No');
}

test('Folder sprint close screen: Yes saves the sprint edits to the linked folder, as Apply did', { timeout: 120000 }, async (t) => {
  const { solo, sprintDir, page } = await openCopyScreen(t);
  await assertScreen(page);
  await page.locator('#mdlFoot [data-copy-apply]').click();
  await page.waitForFunction(() => /Applied\./.test(document.querySelector('#mdlBody')?.innerText ?? ''), null, { timeout: 30000 })
    .catch(async (error) => { console.log('P9_YESNO yes-click modal: ' + await readScreen(page)); throw error; });
  assert.equal(await readFile(path.join(solo, 'a.txt'), 'utf8'), 'two\n', 'the edit reached the linked folder');
  assert.equal(await readFile(path.join(solo, 'b.txt'), 'utf8'), 'new\n', 'the added file reached the linked folder');
  await access(path.join(sprintDir, 'apply-result.json'));
  console.log('PASS yes saves the sprint edits to the linked folder');
});

test('Folder sprint close screen: No closes with nothing written to the linked folder', { timeout: 120000 }, async (t) => {
  const { solo, sprintDir, page } = await openCopyScreen(t);
  await assertScreen(page);
  await page.locator('#mdlFoot [data-copy-no]').click();
  await page.locator('#mdl[open]').waitFor({ state: 'hidden', timeout: 5000 });
  assert.equal(await readFile(path.join(solo, 'a.txt'), 'utf8'), 'one\n', 'the linked folder is unchanged');
  await access(path.join(solo, 'b.txt')).then(() => { throw new Error('b.txt was written'); }, () => {});
  await access(path.join(sprintDir, 'apply-result.json')).then(() => { throw new Error('an apply was recorded'); }, () => {});
  console.log('PASS no closes with nothing written to the linked folder');
});
