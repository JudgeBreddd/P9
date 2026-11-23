// O238: a checklist write (Apply, a mark, a review word) refreshes the section wherever it shows. The page column and the
// section's window each keep their own copy, and the daemon answers a tile again within 30 s from its last run; before the
// fix the page kept the old review line and the old tile until a reload, while a freshly opened window showed the new one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { remoteDaemon, root, versionSeen } from './helpers.mjs';

const node = process.execPath;
// The tile prints the review word of the decision file, as the owner's audit card shows its review state.
const REVIEW = [node, '-e', 'const t = require("fs").readFileSync("inbox/a/_decision.md", "utf8"); process.stdout.write(JSON.stringify({ type: "stat", value: /review: (\\w+)/.exec(t)[1], label: "Review" }))'];
const SPACE = { sections: [
  { id: 'wiki', title: 'Wiki', place: 'col1', data: [{ id: 'tile-review', title: 'Review state', script: 'review' }],
    checklists: [{ id: 'inbox', title: 'Wiki inbox', path: 'inbox', file: '_decision.md', review: ['merge', 'pending'] }] },
  { title: 'Main', widget: 'primary', place: 'col2' }] };

async function setup({ workspace, directory }) {
  for (const folder of ['hub', 'projects/event-horizon', '_waiting', 'inbox/a']) await mkdir(path.join(workspace, folder), { recursive: true });
  await writeFile(path.join(workspace, 'hub/registry.json'), JSON.stringify({ scripts: [{ id: 'review', title: 'Review', cmd: REVIEW }], apps: [], pages: [] }));
  await writeFile(path.join(workspace, 'projects/AGENTS.md'), '# Projects\n\n**Main project: P9 — Event Horizon** (`event-horizon/`)\n');
  await writeFile(path.join(workspace, 'projects/event-horizon/AGENTS.md'), '# P9\n\n**Status:** **Open**\n');
  await writeFile(path.join(workspace, 'hub/space.json'), JSON.stringify(SPACE));
  await writeFile(path.join(workspace, 'inbox/a/_decision.md'), 'review: pending\n\nTwo pages to merge.\n');
  const settings = { primary: 'projects/AGENTS.md', registry: 'hub/registry.json', waiting: '_waiting', space: 'hub/space.json' };
  await writeFile(path.join(directory, 'settings.json'), JSON.stringify(settings));
  return { args: ['--settings', path.join(directory, 'settings.json')] };
}

async function launch(t, before = async () => {}) {
  const server = await remoteDaemon(t, { setup });
  assert.equal((await server.desk('/mission/data/allow', 'POST', { id: 'tile-review' })).status, 200);
  const profile = path.join(server.directory, 'electron-profile');
  await mkdir(profile); await versionSeen(profile);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', server.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await before(app);
  await page.click('#rMission');
  return { app, page, wiki: page.locator('#fMission [data-sec="Wiki"]') };
}

test('O238 a checklist write refreshes the page column and its tile, from the window and from the page, without a reload', { timeout: 150000 }, async (t) => {
  const { page, wiki } = await launch(t);
  await wiki.locator('[data-ck="inbox"] [data-ck-review]', { hasText: 'review: pending' }).waitFor({ timeout: 20000 });
  await wiki.locator('[data-tile="tile-review"]', { hasText: 'pending' }).waitFor({ timeout: 15000 });
  // 8 s, well inside the 30 s pull and the daemon's 30 s answer: only the write's own refresh can draw the new state.
  const soon = { timeout: 8000 };

  // From the window: press merge there; the window and, behind it, the page column both show it.
  await wiki.locator('.phead').click();
  const box = page.locator('#mdl[open] #mdlBody');
  await box.locator('[data-ck="inbox"] [data-ck-word="merge"]').click();
  await box.locator('[data-ck="inbox"] [data-ck-review]', { hasText: 'review: merge' }).waitFor(soon);
  await box.locator('[data-tile="tile-review"]', { hasText: 'merge' }).waitFor(soon);
  await page.keyboard.press('Escape');
  await wiki.locator('[data-ck="inbox"] [data-ck-review]', { hasText: 'review: merge' }).waitFor(soon);
  await wiki.locator('[data-tile="tile-review"]', { hasText: 'merge' }).waitFor(soon);

  // From the page: press pending in the column; its own tile follows, past the daemon's last answer.
  await wiki.locator('[data-ck="inbox"] [data-ck-word="pending"]').click();
  await wiki.locator('[data-ck="inbox"] [data-ck-review]', { hasText: 'review: pending' }).waitFor(soon);
  await wiki.locator('[data-tile="tile-review"]', { hasText: 'pending' }).waitFor(soon);
  console.log('PASS O238: a write in the window and one on the page each refresh the page column and its tile within 8 s');
});

// Fix 1 (review): an answer asked before the write and arriving after it must not draw the old state over the new. The main
// process holds the page column's first checklist read and first tile answer (both read pending), the write goes in from
// the window, then the held answers are let go; before the fix they put the column back to pending until the next 30 s pull.
test('O238 an answer asked before the write cannot draw the old review line or tile over the new one', { timeout: 150000 }, async (t) => {
  const { app, page, wiki } = await launch(t, (app) => app.evaluate(({ ipcMain }) => {
    const handler = ipcMain._invokeHandlers.get('p9:mission'), hold = new Set(['checklist inbox', 'data tile-review']);
    let release; const gate = new Promise((resolve) => { release = resolve; });
    globalThis.o238 = { held: 0, release };
    ipcMain.removeHandler('p9:mission');
    ipcMain.handle('p9:mission', async (event, action, payload) => {
      const answer = await handler(event, action, payload);
      if (hold.delete(action + ' ' + payload?.id)) { globalThis.o238.held++; await gate; }
      return answer;
    });
  }));
  const held = async (n) => { for (let i = 0; i < 100 && await app.evaluate(() => globalThis.o238.held) < n; i++) await page.waitForTimeout(100); };
  await held(2);
  assert.equal(await app.evaluate(() => globalThis.o238.held), 2, 'the column asked its checklist and tile and both answers are held');
  await wiki.locator('.phead').click();
  const box = page.locator('#mdl[open] #mdlBody');
  await box.locator('[data-ck="inbox"] [data-ck-word="merge"]').click();
  await box.locator('[data-tile="tile-review"]', { hasText: 'merge' }).waitFor({ timeout: 8000 });
  await page.keyboard.press('Escape');
  await wiki.locator('[data-ck="inbox"] [data-ck-review]', { hasText: 'review: merge' }).waitFor({ timeout: 8000 });
  await wiki.locator('[data-tile="tile-review"]', { hasText: 'merge' }).waitFor({ timeout: 8000 });
  await app.evaluate(() => globalThis.o238.release());
  await page.waitForTimeout(1500); // the held answers arrive and are handled within this; a redraw from them would show here
  assert.match(await wiki.locator('[data-ck="inbox"] [data-ck-review]').innerText(), /review: merge/);
  assert.match(await wiki.locator('[data-tile="tile-review"]').innerText(), /merge/);
  console.log('PASS O238 fix 1: the column keeps merge after the answers asked before the write arrive');
});
