// O233: a folder sprint's change waits in Mission's Sprint window > Folder sprints. That window opened only while the machine had
// the sprint skill's status file, which a P9 sprint never writes, so on the machine holding the copy there was no way to the
// change; and the list drew nothing both when the daemon asked had no copies and when the call failed. Now the tile shows
// for a waiting change alone and names it, the button names the folder, and the list always says what it found, and where.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, root, versionSeen } from './helpers.mjs';

const until = async (check, what, ms = 5000) => { for (const end = Date.now() + ms; !(await check());) { if (Date.now() > end) throw new Error('timed out: ' + what); await new Promise((r) => setTimeout(r, 50)); } };
const ID = '0123abcd-0000-4000-8000-000000000233', BAD = '0123abcd-0000-4000-8000-000000000234';

test('Folder sprints: a waiting change shows with no sprint status file, names its folder, and an empty or failed list says so plainly (O233)', { timeout: 120000 }, async (t) => {
  const own = await mkdtemp(path.join(os.tmpdir(), 'p9-own-'));
  const instance = await daemon(t, undefined, false, async (paths) => {
    for (const dir of ['hub', 'projects', 'waiting']) await mkdir(path.join(paths.workspace, dir), { recursive: true });
    await writeFile(path.join(paths.workspace, 'hub', 'registry.json'), JSON.stringify({ scripts: [
      { id: 'sprint-start', title: 'Sprint start', group: 'Sprint', cmd: [process.execPath, '-e', 'console.log("start-" + "ok")'], confirm: true }], apps: [], pages: [] }));
    await writeFile(path.join(paths.workspace, 'projects', 'AGENTS.md'), '# Projects\n');
    await writeFile(path.join(paths.directory, 'settings.json'), JSON.stringify({ registry: 'hub/registry.json', primary: 'projects/AGENTS.md', waiting: 'waiting' }));
    return { args: ['--settings', path.join(paths.directory, 'settings.json'), '--ownership', own] };
  });
  // No ~/.local/state/sprint/status.json: only P9's own copy, as on the machine that ran the sprint.
  await mkdir(path.join(own, 'sprints', ID), { recursive: true });
  await writeFile(path.join(own, 'sprints', ID, 'copy-record.json'), JSON.stringify({ source: path.join(os.tmpdir(), 'o233-notes'), baseline: { commit: 'x' } }));
  // FIX1 (Reviewer): a record that is not JSON still lists its copy, by its id, and does not take the good one down with it.
  await mkdir(path.join(own, 'sprints', BAD), { recursive: true });
  await writeFile(path.join(own, 'sprints', BAD, 'copy-record.json'), '{"source": "cut off');
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-o233-')), 'profile');
  await mkdir(profile); await versionSeen(profile);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#rMission').click();
  const tile = page.locator('#fMission [data-sprint]');
  await tile.waitFor({ timeout: 15000 }).catch(async (error) => { console.log('P9_O233 no tile: ' + JSON.stringify(await page.evaluate(() => document.querySelector('#fMission')?.innerText.slice(0, 400)))); throw error; });
  assert.match(await tile.innerText(), /2 to apply/, 'the tile counts both waiting changes');
  await tile.click();
  const button = page.locator(`#mdl [data-copies] [data-copy="${ID}"]`);
  await button.waitFor({ timeout: 10000 });
  assert.equal(await button.innerText(), 'Review change: o233-notes', 'the button names the folder');
  assert.equal(await page.locator(`#mdl [data-copies] [data-copy="${BAD}"]`).innerText(), 'Review change: ' + BAD, 'an unreadable record lists its copy by id');
  assert.doesNotMatch(await page.locator('#mdlBody').innerText(), /status file is there but P9 cannot read it/, 'no status-file error when there is no status file');
  // The list call answered with nothing, then failed: each is said, with the machine asked.
  const answer = async (reply) => app.evaluate(({ ipcMain }, reply) => {
    globalThis.o233h ??= ipcMain._invokeHandlers.get('p9:mission'); ipcMain.removeHandler('p9:mission');
    ipcMain.handle('p9:mission', async (e, action, ...rest) => (action === 'sprintCopies' ? (reply === 'throw' ? Promise.reject(new Error('gone')) : reply) : globalThis.o233h(e, action, ...rest)));
  }, reply);
  const reopen = async () => { await page.keyboard.press('Escape'); await page.locator('#mdl[open]').waitFor({ state: 'hidden', timeout: 5000 }); await tile.click(); };
  await answer({ status: 200, body: { copies: [] } }); await reopen();
  await page.locator('#mdl [data-copies] [data-copies-none]').waitFor({ timeout: 5000 });
  assert.equal(await page.locator('#mdl [data-copies]').innerText(), 'No folder sprints on this computer.');
  await answer({ status: 500, body: { error: 'sprints-unreadable' } }); await reopen();
  await page.locator('#mdl [data-copies] [data-copies-error]').waitFor({ timeout: 5000 });
  assert.match(await page.locator('#mdl [data-copies]').innerText(), /P9 could not list the folder sprints on this computer \(sprints-unreadable\)\./);
  await answer('throw'); await reopen();
  // The last open's error line stays until the new list is drawn, so wait for this one's words.
  await page.waitForFunction(() => /\(.*gone.*\)/.test(document.querySelector('#mdl [data-copies]')?.innerText ?? ''), null, { timeout: 5000 });
  assert.match(await page.locator('#mdl [data-copies]').innerText(), /P9 could not list the folder sprints on this computer \(.*gone.*\)\./);
  // FIX1 (Reviewer): an earlier open's answer that lands after a later open's never draws over it. Every list call made while
  // the first open happens is held (the tile's own timed read may be among them), the second open's is answered with an empty
  // list and drawn, then the held ones are let go with an error.
  await app.evaluate(({ ipcMain }) => {
    globalThis.o233held = []; globalThis.o233hold = true; ipcMain.removeHandler('p9:mission');
    ipcMain.handle('p9:mission', async (e, action, ...rest) => action !== 'sprintCopies' ? globalThis.o233h(e, action, ...rest)
      : globalThis.o233hold ? new Promise((done) => globalThis.o233held.push(done)) : { status: 200, body: { copies: [] } });
  });
  await reopen();
  await until(() => app.evaluate(() => globalThis.o233held.length > 0), 'the first open\'s list call is held');
  await app.evaluate(() => { globalThis.o233hold = false; });
  await reopen();
  await page.locator('#mdl [data-copies] [data-copies-none]').waitFor({ timeout: 5000 });
  await app.evaluate(() => globalThis.o233held.forEach((done) => done({ status: 500, body: { error: 'late-first' } })));
  // ponytail: nothing to wait on for a draw that must not happen; 1 s is many times one IPC answer here.
  await page.waitForTimeout(1000);
  assert.equal(await page.locator('#mdl [data-copies]').innerText(), 'No folder sprints on this computer.', 'the late first answer drew nothing');
  console.log('PASS O233: tile with no status file says 2 to apply, button names o233-notes, a broken record lists by id, empty list and 500 and a thrown call each said plainly, a late earlier answer draws nothing');
});
