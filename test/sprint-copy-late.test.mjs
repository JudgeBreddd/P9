// daemon-3 (Reviewer, FIX on c8202fa): the folder-sprint review's code loads with import() when its window opens. If that load
// fails after the owner has moved on to another window, the failure must not write into the window now open. The chunk
// request is held 2 s and then cancelled by the window's session; meanwhile the owner goes back to the Sprint window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, root, versionSeen } from './helpers.mjs';

const ID = '0123abcd-0000-4000-8000-000000000007';

test('Folder sprint: a late failed load of its review does not write into the window open now', { timeout: 120000 }, async (t) => {
  const own = await mkdtemp(path.join(os.tmpdir(), 'p9-own-'));
  const instance = await daemon(t, undefined, false, async (paths) => {
    for (const dir of ['hub', 'projects', 'waiting']) await mkdir(path.join(paths.workspace, dir), { recursive: true });
    await writeFile(path.join(paths.workspace, 'hub', 'registry.json'), JSON.stringify({ scripts: [
      { id: 'sprint-start', title: 'Sprint start', group: 'Sprint', cmd: [process.execPath, '-e', 'console.log("start-" + "ok")'], confirm: true }], apps: [], pages: [] }));
    await writeFile(path.join(paths.workspace, 'projects', 'AGENTS.md'), '# Projects\n');
    await writeFile(path.join(paths.directory, 'settings.json'), JSON.stringify({ registry: 'hub/registry.json', primary: 'projects/AGENTS.md', waiting: 'waiting' }));
    return { args: ['--settings', path.join(paths.directory, 'settings.json'), '--ownership', own] };
  });
  const status = path.join(instance.directory, '.local', 'state', 'sprint', 'status.json');
  await mkdir(path.dirname(status), { recursive: true });
  await writeFile(status, JSON.stringify({ sprint: 'Copy sprint', updatedAt: new Date().toISOString(), chunks: [{ id: 'c1', title: 'One', state: 'running', percent: 10 }] }));
  await mkdir(path.join(own, 'sprints', ID), { recursive: true });
  await writeFile(path.join(own, 'sprints', ID, 'copy-record.json'), JSON.stringify({ source: 'x', baseline: { commit: 'x' } }));

  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-late-')), 'profile');
  await mkdir(profile); await versionSeen(profile);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  // The review's chunk: held 2 s, then cancelled, so its import() rejects after the owner has left. Everything else loads.
  await app.evaluate(({ session }) => {
    globalThis.held = 0;
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      if (/sprint-copy-view/.test(details.url)) { globalThis.held++; setTimeout(() => callback({ cancel: true }), 2000); } else callback({});
    });
  });
  await page.locator('#rMission').click();
  const tile = page.locator('#fMission [data-sprint]');
  await tile.waitFor({ timeout: 15000 }).catch(async (error) => { console.log('P9_LATE no tile: ' + JSON.stringify(await page.evaluate(() => ({ mission: document.querySelector('#fMission')?.innerText.slice(0, 300), open: [...document.querySelectorAll('dialog[open]')].map((d) => d.id) })))); throw error; });
  await tile.click();
  await page.locator(`#mdl [data-copies] [data-copy="${ID}"]`).click({ timeout: 10000 });
  await page.keyboard.press('Escape');
  await page.locator('#mdl[open]').waitFor({ state: 'hidden', timeout: 5000 });
  await tile.click();
  await page.locator('#mdl [data-sprint-body]').waitFor({ timeout: 5000 });
  await page.waitForTimeout(3500);
  assert.equal(await app.evaluate(() => globalThis.held), 1, 'the review\'s chunk was requested once and held');
  assert.match(await page.locator('#mdlT').innerText(), /Copy sprint/);
  const body = await page.locator('#mdlBody').innerText();
  assert.doesNotMatch(body, /Cannot show this copy/, 'the late failure wrote into the Sprint window');
  assert.equal(await page.locator('#mdl [data-sprint-body]').count(), 1, 'the Sprint window\'s content is still there');
  console.log('PASS late failed review load leaves the open Sprint window as it was');
});
