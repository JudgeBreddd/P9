import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, root } from './helpers.mjs';

// Mission M2 on the desktop: an owner's Mission rebuilt as a space (folder lists and references) beside the built-in tiles.
const shot = (name, png) => { if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png.toString('base64')); };
const SETTINGS = { primary: 'projects/AGENTS.md', registry: 'hub/registry.json', waiting: '_waiting', space: 'hub/space.json' };
const SPACE = { sections: [
  { title: 'Needs you', text: 'Questions waiting on you, newest first.', folders: [{ id: 'needs-you', title: 'Waiting on you', path: '_waiting', pattern: '*-*.md' }] },
  { title: 'Ideas', folders: [{ id: 'needs-done', title: 'Needs done', path: '_ideas/needs-done', pattern: '*.md' }, { id: 'ideas', title: 'Ideas', path: '_ideas', pattern: '*-*.md' }] },
  { title: 'Handoffs', folders: [{ id: 'handoffs', title: 'Open handoffs', path: 'projects', pattern: 'HANDOFF.md', recursive: true, match: 'Status: open' }] },
  { title: 'Daily', refs: ['continuity', 'doctor', 'heartbeats', 'weekly-usage'] },
  { title: 'Launch', refs: ['claude-code', 'obsidian', 'dashboard', 'retired-tool'] }] };
const script = (id, title) => ({ id, title, group: 'Workspace', cmd: ['true'] });

async function seed({ directory, workspace }) {
  for (const folder of ['projects/alpha', 'projects/beta', 'projects/gamma', 'hub', '_waiting', '_ideas/needs-done']) await mkdir(path.join(workspace, folder), { recursive: true });
  await writeFile(path.join(workspace, 'projects/AGENTS.md'), '# Projects\n\n**Main project: Alpha** (`alpha/`)\n');
  await writeFile(path.join(workspace, SETTINGS.registry), JSON.stringify({
    scripts: [script('continuity', 'Continuity'), script('doctor', 'Doctor'), script('heartbeats', 'Heartbeats'), script('weekly-usage', 'Weekly usage')],
    apps: [{ id: 'claude-code', title: 'Claude Code', cmd: ['true'] }, { id: 'obsidian', title: 'Obsidian', cmd: ['true'] }],
    pages: [{ id: 'dashboard', title: 'Dashboard', url: 'https://example.com' }] }));
  await writeFile(path.join(workspace, SETTINGS.space), JSON.stringify(SPACE, null, 2) + '\n');
  const files = { '_waiting/pick-a-host.md': '# Pick a host\n\nA.\n', '_waiting/review-plan.md': '# Review the plan\n\nA.\n', '_waiting/AGENTS.md': '# Rules\n',
    '_ideas/needs-done/live-usage.md': '# Live usage\n', '_ideas/memory-idea.md': '# Memory\n', '_ideas/AGENTS.md': '# Rules\n',
    'projects/alpha/HANDOFF.md': '# Alpha\nStatus: open\n\nThe next step is the folder tile.\n', 'projects/beta/HANDOFF.md': '# Beta\nStatus: open\n', 'projects/gamma/HANDOFF.md': '# Gamma\nStatus: done\n' };
  let minute = 0;
  for (const [name, text] of Object.entries(files)) {
    await writeFile(path.join(workspace, name), text);
    const when = new Date(Date.now() - (60 - (minute += 5)) * 60000);
    await utimes(path.join(workspace, name), when, when);
  }
  await writeFile(path.join(directory, 'settings.json'), JSON.stringify(SETTINGS));
  return { args: ['--settings', path.join(directory, 'settings.json')] };
}

test('Mission space on the desktop: folder lists with counts open files read-only; references draw, a missing one says not found', { timeout: 150000 }, async (t) => {
  const instance = await daemon(t, undefined, false, seed);
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-space-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#dataNote', { hasText: 'Chat live' }).waitFor({ timeout: 20000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 900));
  await page.click('#rMission');
  await page.locator('#fMission [data-group="Launch"]').waitFor({ timeout: 20000 });
  const section = async (title) => { await page.click(`#fMission [data-group="${title}"]`); await page.locator('#mdl[open] #mdlBody .mlist').waitFor({ timeout: 10000 }); };
  const close = async () => { await page.keyboard.press('Escape'); await page.locator('#mdl[open]').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {}); };

  for (const theme of ['event-horizon-prime', 'daylight']) {
    await page.click('#themeBtn'); await page.click(`[data-theme-pick="${theme}"]`); await page.keyboard.press('Escape');
    await page.mouse.move(0, 0);
    await page.waitForFunction((dark) => document.documentElement.classList.contains('dark') === dark, theme !== 'daylight', { timeout: 5000 });
    shot('mission-space-' + theme, await page.screenshot({ animations: 'disabled' }));

    // A section of references only is not an empty tile: it counts every row it opens.
    assert.equal(await page.locator('#fMission [data-group="Launch"] .n').innerText(), '4');
    await section('Launch');
    assert.equal(await page.locator('#mdlT').innerText(), 'Launch · 4 items');
    const refs = await page.locator('#mdlBody .mlist li button').evaluateAll((all) => all.map((b) => b.innerText.replace(/\s+/g, ' ').trim()));
    assert.deepEqual(refs, ['APP Claude Code', 'APP Obsidian', 'LINK Dashboard', 'REF retired-tool not found']);
    assert.equal(await page.locator('#mdlBody [data-ref-missing]').isDisabled(), true);
    shot('mission-space-refs-' + theme, await page.screenshot({ animations: 'disabled' }));
    await close();

    await section('Handoffs');
    await page.locator('#mdlBody [data-folder] [data-count]', { hasText: '2' }).waitFor({ timeout: 10000 });
    await page.click('#mdlBody [data-folder]');
    await page.locator('#mdlFoot [data-folder-count]', { hasText: '2 files' }).waitFor({ timeout: 10000 });
    assert.deepEqual(await page.locator('#mdlBody .mlist li button').evaluateAll((all) => all.map((b) => b.querySelector('.truncate').innerText)), ['beta/HANDOFF.md', 'alpha/HANDOFF.md']);
    shot('mission-space-folder-' + theme, await page.screenshot({ animations: 'disabled' }));
    await page.locator('#mdlBody .mlist li button').last().click();
    await page.locator('#mdlBody pre.out', { hasText: 'The next step is the folder tile.' }).waitFor({ timeout: 10000 });
    assert.equal(await page.locator('#mdlBody textarea, #mdlBody [contenteditable="true"]').count(), 0, 'the file view is read-only');
    await close();
  }
  console.log('PASS mission space desktop: refs 3 drawn + not found; Handoffs count 2, list newest first, file opens read-only; both themes');
});
