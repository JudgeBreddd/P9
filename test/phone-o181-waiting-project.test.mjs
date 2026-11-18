import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { remoteDaemon } from './helpers.mjs';
import { phone } from './phone-c16-helpers.mjs';

// O181: the line under each Waiting row on the phone shows the project a waiting item came from, not the waiting
// file's own name. A waiting item says its project with a "**Project:** <name>" line in the file; one that does
// not say it shows only its age, never a file slug.
const shots = process.env.P9_SCREENSHOTS || '/tmp';
const shot = async (page, name) => { const png = await page.screenshot({ type: 'png', path: shots + '/' + name + '.png' }); if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png.toString('base64')); };
async function setup(paths) {
  const ws = paths.workspace;
  for (const dir of ['hub', 'projects', '_waiting']) await mkdir(path.join(ws, dir), { recursive: true });
  await writeFile(path.join(ws, 'hub/registry.json'), JSON.stringify({ scripts: [], apps: [], pages: [] }));
  await writeFile(path.join(ws, 'projects/AGENTS.md'), '# Projects\n');
  // Two waiting items: one names its project in the file, one does not.
  await writeFile(path.join(ws, '_waiting/cart-price-round.md'),
    '# Round the resale prices?\n\n**Project:** Cart Pulse\n\nThe engine rounds up; selling sites show halves.\n\nQ. Round to halves?\n\nA.\n');
  await writeFile(path.join(ws, '_waiting/pick-a-color.md'),
    '# Pick a color\n\nUse the **blue** one unless it clashes.\n\nQ. Which one?\n\nA.\n');
  await writeFile(path.join(paths.directory, 'settings.json'),
    JSON.stringify({ registry: 'hub/registry.json', primary: 'projects/AGENTS.md', waiting: '_waiting' }));
  return { args: ['--settings', path.join(paths.directory, 'settings.json')] };
}
const openWaiting = async (page) => {
  await page.click('[data-nav="mission"]');
  await page.waitForSelector('#mission .tile[data-open="queue"]', { timeout: 15000 });
  await page.click('#mission .tile[data-open="queue"]');
  await page.waitForSelector('#mission dialog[open] details.row', { timeout: 5000 });
};

test('O181: a waiting item that names its project shows the project under its title; one that does not shows no file slug', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, { setup });
  const { page, session } = await phone(t, server);
  await openWaiting(page);
  // Read everything first, so the wrong line is in the log either way.
  const mission = await server.remote('/mission', { session });
  const lineOf = (title) => page.locator('#mission dialog[open] summary', { hasText: title }).locator('small').innerText();
  const withProject = await lineOf('Round the resale prices?');
  const withoutProject = await lineOf('Pick a color');
  const items = Object.fromEntries((mission.body.queue ?? []).map((item) => [item.name, item]));
  console.log('O181 lines: ' + JSON.stringify({ withProject, withoutProject, project: items['cart-price-round.md']?.project }));
  // The server sends the project the file says, not the file's own name.
  assert.equal(mission.status, 200);
  assert.equal(items['cart-price-round.md'].project, 'Cart Pulse', 'the server reads the project from the file');
  assert.equal(items['pick-a-color.md'].project, '', 'an item with no project line has no project');
  assert.equal(items['cart-price-round.md'].title, 'Round the resale prices?', 'the title still comes from the file');
  assert.match(withProject, /Cart Pulse/, 'the project shows under the title');
  assert.doesNotMatch(withProject, /cart-price-round/, 'the waiting file\'s own name is gone from the line');
  assert.match(withProject, /\bd\b|\bh\b|min/, 'the age still shows');
  assert.doesNotMatch(withoutProject, /pick-a-color/, 'an item with no project shows no file slug');
  await shot(page, 'phone-o181-waiting-project');
  console.log('PASS O181: waiting rows show the project from the file, no file slug');
});
