import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { daemon, http, authenticated, remoteDaemon, passkeyDevice, enrollDevice } from './helpers.mjs';
import { oneLineChange } from '../apps/server/mission.mjs';

// Mission M4: checklists (threat model row M4-a). The weekly Wiki audit's decision file (Approve, Park, Deny per row, then
// Apply) and the Wiki inbox's review line, each written one mark or one line at a time through the guarded save.
const SETTINGS = { primary: 'projects/AGENTS.md', registry: 'hub/registry.json', waiting: '_waiting', space: 'hub/space.json' };
const AUDIT = { id: 'audit', title: 'Weekly Wiki audit', root: 'audit', path: 'runs', file: '_decision.md', newest: true, heading: 'Proposed register changes',
  marks: { x: 'Approve', parked: 'Park', ' ': 'Deny' }, apply: 'audit-apply' };
const SPACE = { sections: [
  { title: 'Wiki', buttons: [{ id: 'audit-apply', title: 'Apply the audit', cmd: ['sh', '-c', 'printf %s "$1" > applied.txt', 'sh'], args: ['Run'] }],
    checklists: [AUDIT,
      { id: 'inbox', title: 'Wiki inbox', path: 'inbox', file: '_decision.md', review: ['merge', 'reject', 'pending'] },
      { id: 'todo', title: 'To do', path: 'notes/todo.md', marks: { x: 'Done', ' ': 'Not done' } },
      { id: 'far', title: 'Far', root: 'far', path: 'list.md', marks: { x: 'Done', ' ': 'Not done' } }] },
  { title: 'Bad', checklists: [{ id: 'evil', title: 'Evil', path: 'notes/todo.md', marks: { 'x]\n- [x': 'Evil' } }, { id: 'up', title: 'Up', path: '../x.md' }] }] };
const DECISION = (day) => '---\nreview: pending\n---\n\n# Audit run ' + day + '\n\n## Proposed register changes\n\n'
  + '- [x] K01 (both) still happening I-002: Jobs die silently Cards: C012\n- [parked] K02 (fable) DISAGREE on the vault sync\n- [ ] K03 (both) new issue: Compiled notes go stale\n\n'
  + '## Findings the script dropped\n\n- [ ] X01 not a change\n';

async function seed({ directory, workspace }) {
  const runs = path.join(workspace, 'wiki/audit/runs');
  for (const folder of ['projects', 'hub', '_waiting', 'notes', 'inbox/librarian-a', 'inbox/librarian-b', 'inbox/librarian-twice', runs + '/2026-10-21', runs + '/2026-10-28', runs + '/backfill-undated', path.join(directory, 'far')])
    await mkdir(path.resolve(workspace, folder), { recursive: true });
  await writeFile(path.join(workspace, 'projects/AGENTS.md'), '# Projects\n');
  await writeFile(path.join(workspace, SETTINGS.registry), JSON.stringify({ scripts: [] }));
  await writeFile(path.join(workspace, SETTINGS.space), JSON.stringify(SPACE, null, 2) + '\n');
  // The owner's runs folder also holds backfill-* runs; letters sort after digits, so newest must skip them.
  for (const day of ['2026-10-21', '2026-10-28', 'backfill-undated']) await writeFile(path.join(runs, day, '_decision.md'), DECISION(day));
  await writeFile(path.join(workspace, 'inbox/librarian-a/_decision.md'), 'review: pending\n\nTwo pages to merge.\n');
  await writeFile(path.join(workspace, 'inbox/librarian-b/_decision.md'), 'review: "merge"\n');
  await writeFile(path.join(workspace, 'inbox/librarian-twice/_decision.md'), 'review: pending\nreview: pending\n');
  await writeFile(path.join(workspace, 'notes/todo.md'), '# To do\r\n\r\n- [ ] Water the plants\r\n- [x] Pay rent\r\n');
  await writeFile(path.join(directory, 'far/list.md'), '- [ ] far\n');
  await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ ...SETTINGS, notes_roots: { audit: path.join(workspace, 'wiki/audit'), far: path.join(directory, 'far') } }));
  return { args: ['--settings', path.join(directory, 'settings.json')] };
}
const call = (instance, route, method = 'GET', body) => http({ socketPath: instance.credentials.socketPath, route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  .then((result) => ({ status: result.status, body: result.text ? JSON.parse(result.text) : null }));
const get = (instance, id) => call(instance, '/mission/checklist?' + new URLSearchParams({ id }));
const set = (instance, body) => call(instance, '/mission/checklist', 'POST', body);
const shot = async (page, name) => { const png = await page.screenshot(); if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png.toString('base64')); };

test('the one-line check: one mark or one review line, nothing else', { timeout: 10000 }, () => {
  const before = 'review: pending\n- [ ] a\r\n- [x] b\n';
  assert.equal(oneLineChange(before, 'review: pending\n- [x] a\r\n- [x] b\n', 'mark'), true);
  assert.equal(oneLineChange(before, 'review: apply\n- [ ] a\r\n- [x] b\n', 'review'), true);
  assert.equal(oneLineChange(before, 'review: pending\n- [x] a\r\n- [ ] b\n', 'mark'), false, 'two marks');
  assert.equal(oneLineChange(before, 'review: pending\n- [x] a\n- [x] b\n', 'mark'), false, 'a CRLF made LF');
  assert.equal(oneLineChange(before, 'review: pending\n- [x] A\r\n- [x] b\n', 'mark'), false, 'the row text changed');
  assert.equal(oneLineChange(before, 'review: apply\n- [x] a\r\n- [x] b\n', 'review'), false, 'a line besides the review line');
  assert.equal(oneLineChange(before, 'review: apply\nreview: x\n- [ ] a\r\n- [x] b\n', 'review'), false, 'a line added');
  console.log('PASS one-line check: 2 allowed, 5 refused');
});

test('checklists: Approve one row and Deny another, only those marks change; refusals change nothing; Apply runs from pending only', { timeout: 60000 }, async (t) => {
  const instance = await daemon(t, undefined, false, seed);
  const overview = (await call(instance, '/mission')).body;
  const wiki = overview.space.find((section) => section.title === 'Wiki');
  assert.deepEqual(wiki.checklists.map((item) => item.id), ['audit', 'inbox', 'todo', 'far']);
  assert.deepEqual(overview.invalid.filter((entry) => entry.checklists !== undefined).map((entry) => entry.reason), ['malformed-record', 'malformed-record'], 'the bad mark and .. are dropped');

  // The newest run only, rows under the heading only.
  const audit = await get(instance, 'audit');
  assert.equal(audit.status, 200);
  assert.deepEqual(audit.body.files.map((file) => [file.path, file.name, file.review]), [['runs/2026-10-28/_decision.md', '2026-10-28', 'pending']]);
  assert.deepEqual(audit.body.files[0].rows.map((row) => row.mark), ['x', 'parked', ' ']);
  assert.match(audit.body.files[0].rows[2].text, /^K03 /);
  const file = path.join(instance.directory, 'workspace', 'wiki/audit', audit.body.files[0].path);
  const before = await readFile(file, 'utf8');
  const { hash } = audit.body.files[0];

  // Refusals first: each leaves the file byte for byte.
  const refused = [
    [{ id: 'audit', path: audit.body.files[0].path, hash, row: 2, mark: 'yes' }, 400, 'a mark not in the list'],
    [{ id: 'audit', path: audit.body.files[0].path, hash, row: 2, mark: 'x]\n- [x' }, 400, 'a mark with a line break'],
    [{ id: 'audit', path: audit.body.files[0].path, hash: '0'.repeat(64), row: 2, mark: 'x' }, 409, 'a stale hash'],
    [{ id: 'audit', path: 'runs/2026-10-21/_decision.md', hash, row: 2, mark: 'x' }, 404, 'a run the item does not list'],
    [{ id: 'audit', path: 'runs/../runs/2026-10-28/_decision.md', hash, row: 2, mark: 'x' }, 404, '..'],
    [{ id: 'audit', path: audit.body.files[0].path, hash, row: 9, mark: 'x' }, 400, 'no such row'],
    [{ id: 'audit', path: audit.body.files[0].path, hash, review: 'apply' }, 400, 'the audit lists no review words'],
  ];
  for (const [body, status, why] of refused) assert.equal((await set(instance, body)).status, status, why);
  assert.equal(await readFile(file, 'utf8'), before);

  // Approve K03, Deny K01: exactly those two marks change on disk.
  const approved = await set(instance, { id: 'audit', path: audit.body.files[0].path, hash, row: 2, mark: 'x' });
  assert.equal(approved.status, 200);
  const denied = await set(instance, { id: 'audit', path: audit.body.files[0].path, hash: approved.body.hash, row: 0, mark: ' ' });
  assert.equal(denied.status, 200);
  assert.equal(await readFile(file, 'utf8'), before.replace('- [ ] K03', '- [x] K03').replace('- [x] K01', '- [ ] K01'));

  // Apply: only review: pending becomes review: apply, then the button runs with the run's date.
  const applied = await set(instance, { id: 'audit', path: audit.body.files[0].path, hash: denied.body.hash, apply: true });
  assert.equal(applied.status, 202);
  const done = before.replace('- [ ] K03', '- [x] K03').replace('- [x] K01', '- [ ] K01').replace('review: pending', 'review: apply');
  assert.equal(await readFile(file, 'utf8'), done);
  const stamp = path.join(instance.directory, 'workspace', 'applied.txt');
  for (let i = 0; i < 50 && !(await readFile(stamp, 'utf8').catch(() => '')); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await readFile(stamp, 'utf8'), '2026-10-28');
  const again = await set(instance, { id: 'audit', path: audit.body.files[0].path, hash: applied.body.hash, apply: true });
  assert.equal(again.status, 409, 'review is apply now, not pending');
  assert.equal(again.body.error, 'not-pending');
  assert.equal(await readFile(file, 'utf8'), done);

  // The inbox: every batch, its review line switched to a listed word only; two review lines are refused.
  const inbox = await get(instance, 'inbox');
  assert.deepEqual(inbox.body.files.map((entry) => [entry.name, entry.review]), [['librarian-a', 'pending'], ['librarian-b', 'merge'], ['librarian-twice', null]]);
  const a = inbox.body.files[0], aFile = path.join(instance.directory, 'workspace', 'inbox', a.name, '_decision.md');
  assert.equal((await set(instance, { id: 'inbox', path: a.path, hash: a.hash, review: 'delete' })).status, 400, 'a word not in the list');
  assert.equal((await set(instance, { id: 'inbox', path: a.path, hash: a.hash, row: 0, mark: 'x' })).status, 400, 'the inbox lists no marks');
  const twice = inbox.body.files[2];
  assert.equal((await set(instance, { id: 'inbox', path: twice.path, hash: twice.hash, review: 'merge' })).body?.error, 'review-line-count');
  assert.equal((await set(instance, { id: 'inbox', path: a.path, hash: a.hash, review: 'reject' })).status, 200);
  assert.equal(await readFile(aFile, 'utf8'), 'review: reject\n\nTwo pages to merge.\n');

  // A CRLF file keeps its CRLF; a root outside the workspace is refused.
  const todo = (await get(instance, 'todo')).body.files[0];
  assert.equal((await set(instance, { id: 'todo', path: todo.path, hash: todo.hash, row: 0, mark: 'x' })).status, 200);
  assert.equal(await readFile(path.join(instance.directory, 'workspace', 'notes/todo.md'), 'utf8'), '# To do\r\n\r\n- [x] Water the plants\r\n- [x] Pay rent\r\n');
  assert.deepEqual([(await get(instance, 'far')).status, (await get(instance, 'far')).body.error], [403, 'outside-workspace']);
  console.log('PASS checklist: 7 refusals change nothing; Approve K03 + Deny K01 change 2 marks; Apply writes review: apply and runs with 2026-10-28, twice refused; inbox reject; CRLF kept; far root refused');
});

test('the weekly Wiki audit on the phone at 390x844: Approve, Park, Deny per row and Apply', { timeout: 90000, skip: process.platform === 'win32' && 'Windows CI has no Playwright Chromium' }, async (t) => {
  const server = await remoteDaemon(t, { setup: seed });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const device = await passkeyDevice(browser, server, 'phone-checklist');
  const session = await enrollDevice(server, device);
  const page = device.page;
  await device.context.addCookies([{ name: 'p9s', value: session.token, url: server.origin, httpOnly: true, secure: true, sameSite: 'Strict' }]);
  // The test container has no network, so Chromium reports offline and the phone refuses every write; the daemon is local.
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'onLine', { get: () => true }));
  await page.goto(server.origin + '/phone/');
  await page.evaluate((csrf) => sessionStorage.setItem('p9-csrf', csrf), session.csrf);
  await page.reload();
  await page.setViewportSize({ width: 390, height: 844 });
  const open = async () => {
    await page.click('[data-nav="mission"]');
    const tile = page.locator('#mission [data-open]', { has: page.locator('span', { hasText: /^Wiki$/ }) });
    await tile.waitFor({ timeout: 15000 });
    await tile.click();
    const box = page.locator('#mission dialog[open]');
    await box.locator('summary', { hasText: 'Weekly Wiki audit' }).click();
    await box.locator('[data-ck="audit"] [data-ck-row]').first().waitFor({ timeout: 10000 });
    return box;
  };
  let box = await open();
  const row = (n) => box.locator('[data-ck="audit"] [data-ck-row]').nth(n);
  assert.deepEqual(await box.locator('[data-ck="audit"] [data-ck-row] [aria-pressed="true"]').evaluateAll((all) => all.map((b) => b.textContent.trim())), ['Approve', 'Park', 'Deny']);
  await row(2).locator('button', { hasText: 'Approve' }).click();
  await box.locator('[data-ck="audit"] [data-ck-row]:nth-child(3) button[aria-pressed="true"]:text-is("Approve"), [data-ck="audit"] .ck-note').first().waitFor({ timeout: 10000 });
  assert.equal(await box.locator('[data-ck="audit"] .ck-note').count(), 0, await box.locator('[data-ck="audit"]').textContent());
  await shot(page, 'phone-audit-event-horizon-prime');
  await page.keyboard.press('Escape');
  await page.click('[data-nav="chat"]');
  await page.click('[data-bar="chat"] #themeBtn');
  await page.click('#themeMenu [data-theme-pick="daylight"]');
  await page.keyboard.press('Escape');
  box = await open();
  await row(2).locator('button[aria-pressed="true"]', { hasText: 'Approve' }).waitFor({ timeout: 10000 });
  await box.locator('[data-ck="audit"] [data-ck-apply]').click();
  await box.locator('[data-ck="audit"] [data-ck-apply][data-armed]', { hasText: 'press again' }).waitFor({ timeout: 5000 });
  await shot(page, 'phone-audit-armed-daylight');
  await box.locator('[data-ck="audit"] [data-ck-apply]').click();
  await box.locator('[data-ck="audit"] [data-ck-review]', { hasText: 'apply' }).waitFor({ timeout: 10000 });
  await shot(page, 'phone-audit-daylight');
  console.log('PASS phone audit: marks drawn pressed, Approve K03 lands, Apply sets review apply; both themes');
});
