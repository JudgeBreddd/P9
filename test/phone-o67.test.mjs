import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { remoteDaemon } from './helpers.mjs';
import { phone } from './phone-c16-helpers.mjs';

// O67: Mission and Files on the phone read as text, not source. Each test fails on main 074b17d.
const shots = process.env.P9_SCREENSHOTS || '/tmp';
const shot = async (page, name) => { const png = await page.screenshot({ type: 'png', path: shots + '/' + name + '.png' }); if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png.toString('base64')); };
const NOTE = '# Weekly plan\n\nShip the **phone** list, then:\n\n- one\n- two\n';
async function setup(paths) {
  const ws = paths.workspace;
  for (const dir of ['hub', 'projects/event-horizon', '_waiting', 'p9', 'docs', 'inbox']) await mkdir(path.join(ws, dir), { recursive: true });
  await mkdir(path.join(paths.directory, 'spaces'), { recursive: true });
  await writeFile(path.join(ws, 'hub/registry.json'), JSON.stringify({ scripts: [], apps: [], pages: [] }));
  await writeFile(path.join(ws, 'projects/AGENTS.md'), '# Projects\n\n**Main project: P9 — Event Horizon** (`event-horizon/`)\n');
  await writeFile(path.join(ws, 'projects/event-horizon/AGENTS.md'), '# P9\n\n**Status:** **Open** — phase 11 in work\n');
  await writeFile(path.join(ws, '_waiting/pick.md'), '# Pick a color\n\nUse the **blue** one unless:\n\n- it clashes\n\nQ. Which one?\n\nA.\n');
  await writeFile(path.join(ws, 'docs/plan.md'), NOTE);
  await writeFile(path.join(ws, 'docs/raw.txt'), 'plain **text** stays\n');
  await writeFile(path.join(ws, 'p9/space.json'), JSON.stringify({ sections: [{ title: 'Reviews',
    folders: [{ id: 'docs', title: 'Docs', path: 'docs' }],
    checklists: [{ id: 'inbox', title: 'Wiki review inbox', path: 'inbox', file: '_decision.md', review: ['merge', 'reject', 'pending'] }],
    buttons: [{ id: 'slow', title: 'Slow job', cmd: [process.execPath, '-e', 'let n=0;const t=setInterval(()=>{console.log("tick "+ ++n);if(n>30)clearInterval(t)},300)'] }] }] }));
  await writeFile(path.join(paths.directory, 'spaces/draft.json'), JSON.stringify({ sections: [] }));
  await writeFile(path.join(paths.directory, 'settings.json'), JSON.stringify({ registry: 'hub/registry.json', primary: 'projects/AGENTS.md', waiting: '_waiting', space: 'p9/space.json' }));
  return { args: ['--settings', path.join(paths.directory, 'settings.json')] };
}
async function mission(t) {
  const server = await remoteDaemon(t, { setup });
  const { page } = await phone(t, server);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('[data-nav="mission"]');
  await page.waitForSelector('#mission .tile[data-open="queue"]', { timeout: 15000 });
  return { server, page };
}
const openTile = async (page, name) => { await page.click(`#mission .tile:has(span:text-is("${name}"))`); await page.waitForSelector('#mission dialog[open]', { timeout: 5000 }); };

test('O67 a: a waiting item and a Markdown folder file read rendered; a text file stays as written', { timeout: 120000 }, async (t) => {
  const { page } = await mission(t);
  await openTile(page, 'Waiting on you');
  await page.click('#mission dialog[open] summary:has-text("Pick a color")');
  assert.equal(await page.locator('#mission dialog[open] details[open] .md strong').first().innerText({ timeout: 5000 }), 'blue', 'the waiting item shows its Markdown marks');
  assert.equal(await page.locator('#mission dialog[open] details[open] .md li').count(), 1);
  await shot(page, 'phone-o67-waiting');
  await page.click('#mission dialog[open] [data-close]');
  await openTile(page, 'Reviews');
  await page.click('#mission dialog[open] summary:has-text("Docs")');
  await page.click('#mission dialog[open] summary:has-text("plan.md")');
  await page.waitForSelector('#mission dialog[open] div.md[data-text] h1:text-is("Weekly plan")', { timeout: 10000 });
  assert.equal(await page.locator('#mission dialog[open] div.md[data-text] li').count(), 2);
  await page.click('#mission dialog[open] summary:has-text("raw.txt")');
  await page.waitForSelector('#mission dialog[open] pre[data-text]:text-is("plain **text** stays")', { timeout: 10000 });
  await shot(page, 'phone-o67-folder-file');
  console.log('PASS O67 a: waiting item and plan.md rendered, raw.txt as written');
});

test('O67 b: a Markdown file from Files opens in the read view', { timeout: 120000 }, async (t) => {
  const { page } = await mission(t);
  await page.click('[data-nav="files"]');
  await page.click('#fileList button[data-name="docs"]');
  await page.click('#fileList button[data-name="plan.md"]');
  await page.waitForSelector('#fileState:text("Loaded")', { timeout: 10000 });
  assert.equal(await page.isVisible('#rendered'), true, 'plan.md opened in the editor');
  assert.equal(await page.isVisible('#editor'), false);
  assert.equal(await page.locator('#rendered h1').innerText(), 'Weekly plan');
  await shot(page, 'phone-o67-file-read');
  await page.click('#closeFile');
  await page.click('#fileList button[data-name="raw.txt"]');
  await page.waitForFunction(() => document.querySelector('#openPath').textContent === 'raw.txt' && document.querySelector('#fileState').textContent === 'Loaded', null, { timeout: 10000 });
  assert.equal(await page.isVisible('#editor'), true, 'a text file still opens in the editor');
  console.log('PASS O67 b: plan.md opens rendered, raw.txt in the editor');
});

test('O67 c, f: the project tile shows its name as text, and a checklist row says what it holds', { timeout: 120000 }, async (t) => {
  const { page } = await mission(t);
  const fonts = await page.evaluate(() => { const font = (el) => getComputedStyle(el).fontFamily;
    return { name: font(document.querySelector('#mission [data-open="primary"] b')), title: font(document.querySelector('#mission [data-open="primary"] span')), count: font(document.querySelector('#mission [data-open="queue"] b')) }; });
  assert.equal(fonts.name, fonts.title, "the project's name is in the count's font");
  assert.notEqual(fonts.count, fonts.title, 'a count keeps its own font');
  await shot(page, 'phone-o67-tiles');
  await openTile(page, 'Reviews');
  const line = page.locator('#mission dialog[open] summary:has-text("Wiki review inbox") small');
  await page.waitForFunction(() => document.querySelector('#mission dialog[open] [data-ck-count]')?.textContent === 'nothing to review', null, { timeout: 10000 });
  assert.equal(await line.innerText(), 'nothing to review');
  await shot(page, 'phone-o67-checklist-row');
  console.log('PASS O67 c, f: name in the text font; the empty checklist row reads "nothing to review"');
});

test('O67 d: a space change that fails says so', { timeout: 120000 }, async (t) => {
  const { page } = await mission(t);
  await page.route('**/mission/space', (route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'settings-changed' }) }));
  await page.selectOption('#mission [data-space-pick]', 'draft');
  await page.waitForSelector('#mission [data-space-failed]', { timeout: 10000 });
  assert.match(await page.locator('#mission [data-space-failed]').innerText(), /The space was not changed \(settings-changed\)/);
  assert.equal(await page.locator('#mission [data-space-pick]').inputValue(), '', 'the picker shows a space that is not the one in use');
  await shot(page, 'phone-o67-space-failed');
  console.log('PASS O67 d: the refusal is said under the picker, which is back on Main');
});

test('O67 e: a script stops being followed when its window closes', { timeout: 120000 }, async (t) => {
  const { page } = await mission(t);
  let polls = 0; page.on('request', (request) => { if (/\/runs\/[^/]+\?from=/.test(request.url())) polls++; });
  await openTile(page, 'Reviews');
  await page.click('#mission dialog[open] summary:has-text("Slow job") [data-run-now]');
  await page.waitForSelector('#mission dialog[open] pre[data-output]:has-text("tick 2")', { timeout: 15000 });
  await page.click('#mission dialog[open] [data-close]');
  await page.waitForTimeout(1200); const settled = polls; // the poll in flight at the close may still land
  await page.waitForTimeout(3000);
  assert.equal(polls, settled, `the run was read ${polls - settled} more times after its window closed`);
  console.log('PASS O67 e: no read of the run after the window closed (' + settled + ' before)');
});
