import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, http, authenticated, root } from './helpers.mjs';
import { Client } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

// Mission M4 (threat model row M4-b): with a space file the built-in layer draws and runs nothing, and migrate_mission moves
// an install shaped like the owner's (a kit folder in the workspace, logs and the Wiki vault outside it) to a space:
// backup first, then the space, then the setting, then the before and after list. Screenshots: the two side by side.
const fake = path.join(root, 'test/fake-acp-agent.mjs');
const shot = (name, png) => { if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png.toString('base64')); };
const SETTINGS = { primary: 'kit/personal-projects/AGENTS.md', registry: 'kit/personal-projects/workspace-hub/registry.json', waiting: 'kit/_waiting', hub: 'kit/personal-projects/workspace-hub' };
const tile = (id, title) => ({ id, title, script: id });
const OWNER = { sections: [
  { title: 'Needs you', text: 'Questions waiting on you, newest first.', folders: [{ id: 'needs-you', title: 'Waiting on you', path: 'kit/_waiting', pattern: '*-*.md' }] },
  { title: 'Ideas', folders: [{ id: 'needs-done', title: 'Needs done', path: 'kit/_ideas/needs-done', pattern: '*.md' }, { id: 'ideas', title: 'Ideas', path: 'kit/_ideas', pattern: '*-*.md' }] },
  { title: 'Handoffs', folders: [{ id: 'handoffs', title: 'Project handoffs', path: 'kit/personal-projects', pattern: 'HANDOFF.md', recursive: true }] },
  { title: 'Wiki', checklists: [
    { id: 'wiki-audit-review', title: 'Weekly Wiki audit', root: 'audit', path: 'runs', file: '_decision.md', newest: true, heading: 'Proposed register changes', marks: { x: 'Approve', parked: 'Park', ' ': 'Deny' } },
    { id: 'wiki-inbox', title: 'Wiki review inbox', root: 'wiki-inbox', file: '_decision.md', review: ['merge', 'reject', 'pending'] }] },
  { title: 'Logs and incidents', buttons: [{ id: 'server-logs', title: 'Server logs', cmd: ['true'] }, { id: 'overdue', title: 'Silent jobs', cmd: ['true'] }],
    folders: [{ id: 'logs', title: 'Logs on this machine', root: 'logs', pattern: '*.log', recursive: true }, { id: 'incidents', title: 'Incidents', root: 'logs', path: 'incidents', pattern: '*.md' }],
    data: [tile('server-logs', 'Server logs'), tile('overdue', 'Silent jobs')] },
  { title: 'Solo runs', folders: [{ id: 'solo', title: 'Last solo run', root: 'solo', pattern: '*.md' }] }] };

async function seed({ directory, workspace }) {
  const icm = path.join(workspace, 'kit'), hub = path.join(icm, 'personal-projects/workspace-hub');
  for (const folder of [hub, path.join(icm, 'personal-projects/alpha'), path.join(icm, 'personal-projects/beta'), path.join(icm, '_waiting'), path.join(icm, '_ideas/needs-done'),
    path.join(directory, 'icm-logs/incidents'), path.join(directory, 'vault/Review/Inbox/librarian-batch-1')]) await mkdir(folder, { recursive: true });
  const files = { 'personal-projects/AGENTS.md': '# Projects\n', 'personal-projects/alpha/HANDOFF.md': '# Alpha\nStatus: open\n', 'personal-projects/beta/HANDOFF.md': '# Beta\nStatus: open\n',
    '_waiting/pick-a-host.md': '# Pick a host\n\nA.\n', '_ideas/memory-idea.md': '# Memory\n', '_ideas/needs-done/live-usage.md': '# Live usage\n' };
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(icm, name), text);
  await writeFile(path.join(hub, 'registry.json'), JSON.stringify({ scripts: [{ id: 'doctor', title: 'Doctor', group: 'Daily', cmd: ['true'] }] }));
  await writeFile(path.join(directory, 'icm-logs/backup.log'), 'backup done\n');
  await writeFile(path.join(directory, 'icm-logs/sync.log'), 'sync done\n');
  await writeFile(path.join(directory, 'icm-logs/incidents/2026-10-28-disk.md'), '# Incident: disk on the server, 2026-10-28 03:00:00\n');
  await writeFile(path.join(directory, 'vault/Review/Inbox/librarian-batch-1/_decision.md'), 'review: pending\n');
  await writeFile(path.join(directory, 'vault/Review/Inbox/librarian-batch-1/page.md'), '# Page\n');
  await writeFile(path.join(directory, 'settings.json'), JSON.stringify(SETTINGS));
  return { args: ['--acp-override', fake, '--settings', path.join(directory, 'settings.json')],
    env: { ICM_LOG_DIR: path.join(directory, 'icm-logs'), MC_VAULT: path.join(directory, 'vault') } };
}
const call = (instance, route, method = 'GET', body) => http({ socketPath: instance.credentials.socketPath, route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  .then((result) => ({ status: result.status, body: result.text ? JSON.parse(result.text) : null }));
async function until(instance, match, after = 0) {
  for (let i = 0; i < 40; i += 1) {
    const { body } = await call(instance, `/chat/events?after=${after}&wait=2000`);
    after = body.cursor;
    const hit = body.events.find(match);
    if (hit) return { hit, cursor: after };
  }
  throw new Error('event-timeout');
}
async function agent(t, instance) {
  const { body: { conversation } } = await call(instance, '/chat', 'POST', { provider: 'claude' });
  await call(instance, `/chat/${conversation}/prompt`, 'POST', { text: 'mcp' });
  const { hit } = await until(instance, (event) => event.conversation === conversation && event.data?.content?.text?.startsWith('mcp:'));
  const [entry] = JSON.parse(hit.data.content.text.slice(4));
  const client = new Client({ name: 'p9-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env: Object.fromEntries(entry.env.map(({ name, value }) => [name, value])) }));
  t.after(() => client.close());
  return async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
}

test('migrate_mission: backup first, the space, the setting, every item kept or lost; then the built-in layer draws and runs nothing', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, seed);
  const settingsFile = path.join(instance.directory, 'settings.json'), oldSettings = await readFile(settingsFile, 'utf8');
  const before = await call(instance, '/mission/hub');
  assert.equal(before.status, 200);
  assert.deepEqual(before.body.handoffs.map((row) => row.project), ['kit/personal-projects/alpha', 'kit/personal-projects/beta']);

  // The desktop before: the built-in layer's cards.
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-migrate-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#dataNote', { hasText: 'Chat live' }).waitFor({ timeout: 20000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 900));
  await page.click('#rMission');
  await page.locator('#fMission [data-win="mwork"]').waitFor({ timeout: 20000 });
  const theme = async (name) => { await page.click('#themeBtn'); await page.click(`[data-theme-pick="${name}"]`); await page.keyboard.press('Escape');
    await page.waitForFunction((dark) => document.documentElement.classList.contains('dark') === dark, name !== 'daylight', { timeout: 5000 }); };
  for (const name of ['event-horizon-prime', 'daylight']) { await theme(name); shot('migrate-before-' + name, await page.screenshot({ animations: 'disabled' })); }

  // Refused before anything is written: a space with a bad item.
  const tool = await agent(t, instance);
  assert.equal((await tool('migrate_mission', { text: JSON.stringify(OWNER) })).error, 'registry-read-only', 'File protection on');
  await call(instance, '/file-protection', 'POST', { on: false });
  const bad =await tool('migrate_mission', { text: JSON.stringify({ sections: [{ title: 'X', checklists: [{ id: 'up', title: 'Up', path: '../x.md' }] }] }) });
  assert.equal(bad.error, 'invalid-space');
  assert.equal(await readFile(settingsFile, 'utf8'), oldSettings);

  const done = await tool('migrate_mission', { text: JSON.stringify(OWNER, null, 2) });
  assert.equal(done.error, undefined, JSON.stringify(done));
  // (a) the backup is the old settings byte for byte; the space is new; the setting names it; no notes root was added.
  assert.equal(await readFile(done.backup, 'utf8'), oldSettings);
  assert.deepEqual(JSON.parse(await readFile(done.space, 'utf8')), OWNER);
  const now = JSON.parse(await readFile(settingsFile, 'utf8'));
  assert.equal(now.space, done.space);
  assert.equal(now.notes_roots, undefined, 'the migration adds no folder outside the workspace');
  // (b) the list: kept with the item that shows it, lost in plain words, roots not allowed yet named, every kind of loss named.
  const list = await readFile(done.list, 'utf8');
  assert.match(list, /Roll back: copy .*settings\.json\.pre-space-\d+\.bak over .*settings\.json/);
  assert.match(list, /^- Work in flight: kit\/personal-projects\/alpha\/HANDOFF\.md: kept in Handoffs › Project handoffs$/m);
  assert.match(list, /^- Logs on this machine: backup\.log: lost/m);
  assert.match(list, /^- Incidents: 2026-10-28-disk\.md: lost/m);
  assert.match(list, /^- Wiki review inbox: librarian-batch-1: lost/m);
  assert.match(list, /^- audit, logs, solo, wiki-inbox$/m);
  for (const loss of ['grouped and counted per check', 'last line', 'BLUF', 'Notifications', 'over ssh']) assert.ok(list.includes(loss), loss);
  assert.deepEqual([done.kept, done.lost], [2, 4]);

  // (e) the built-in layer: refused before any read; its decide route too. (d) a second migration is refused.
  const off = await call(instance, '/mission/hub');
  assert.deepEqual([off.status, off.body.error], [404, 'space-set']);
  assert.equal((await call(instance, '/mission/hub/decide', 'POST', { name: 'librarian-batch-1', choice: 'merge' })).body.error, 'space-set');
  assert.equal(await readFile(path.join(instance.directory, 'vault/Review/Inbox/librarian-batch-1/_decision.md'), 'utf8'), 'review: pending\n');
  const settingsNow = await readFile(settingsFile, 'utf8');
  assert.equal((await tool('migrate_mission', { text: JSON.stringify(OWNER) })).error, 'space-set');
  assert.equal(await readFile(settingsFile, 'utf8'), settingsNow);
  assert.equal((await readdir(instance.directory)).filter((name) => name.startsWith('settings.json.pre-space-')).length, 1);

  // The desktop after: the space's sections, no built-in card.
  await page.reload();
  await page.locator('#dataNote', { hasText: 'Chat live' }).waitFor({ timeout: 20000 });
  await page.click('#rMission');
  await page.locator('#fMission [data-group="Wiki"]').waitFor({ timeout: 20000 });
  for (const win of ['minbox', 'mwork']) assert.equal(await page.locator(`#fMission [data-win="${win}"]`).count(), 0, win);
  assert.equal(await page.locator('#fMission [data-hub-hint]').count(), 0);
  // The built-in Logs and incidents panel goes too, and Notifications no longer talks about scheduled jobs.
  await page.locator('#fMission [data-panel="mlogs"]').waitFor({ state: 'hidden', timeout: 10000 });
  assert.doesNotMatch(await page.locator('#fMission [data-win="mnotes"]').textContent(), /Scheduled jobs/);
  for (const name of ['event-horizon-prime', 'daylight']) {
    await theme(name);
    shot('migrate-after-' + name, await page.screenshot({ animations: 'disabled' }));
    await page.click('#fMission [data-group="Wiki"]');
    await page.locator('#mdl[open] [data-ck="wiki-audit-review"]').waitFor({ timeout: 10000 });
    shot('migrate-wiki-' + name, await page.screenshot({ animations: 'disabled' }));
    await page.keyboard.press('Escape');
  }
  console.log('PASS migrate: bad space refused unchanged; backup = old settings; space + setting; list 2 kept 4 lost, roots not allowed named; hub space-set; second refused; desktop before/after both themes');
});
