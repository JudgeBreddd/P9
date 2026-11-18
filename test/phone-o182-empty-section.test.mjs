import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { remoteDaemon } from './helpers.mjs';
import { phone } from './phone-c16-helpers.mjs';

// O182 (OPEN-ITEMS-0.1.9, finding § M): a non-widget section with nothing renderable still draws a
// window with count 0 and an empty body — a heading with nothing under it. Done means: such a section
// draws nothing, or its window says so in one line. Sections with things still draw as before.
const shots = process.env.P9_SCREENSHOTS || '/tmp';
const shot = async (page, name) => { await page.screenshot({ type: 'png', path: shots + '/' + name + '.png' }); if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + shots + '/' + name + '.png'); };

async function setup(paths) {
  const ws = paths.workspace;
  for (const dir of ['hub', 'projects/event-horizon', 'p9']) await mkdir(path.join(ws, dir), { recursive: true });
  await writeFile(path.join(ws, 'hub/registry.json'), JSON.stringify({ scripts: [], apps: [], pages: [] }));
  await writeFile(path.join(ws, 'projects/AGENTS.md'), '# Projects\n\n**Main project: P9 — Event Horizon** (`event-horizon/`)\n');
  await writeFile(path.join(ws, 'projects/event-horizon/AGENTS.md'), '# P9\n\n**Status:** **Open** — phase 11 in work\n');
  // One section holds a checklist, one holds only text, and one names nothing renderable at all (no text,
  // notes, logs, data, cards, links, folders, checklists, refs, widgets, buttons) — the finding's case.
  await writeFile(path.join(ws, 'p9/space.json'), JSON.stringify({ sections: [
    { title: 'Reviews', checklists: [{ id: 'inbox', title: 'Example checklist', path: 'p9', file: 'note.md', review: ['merge', 'reject', 'pending'] }] },
    { title: 'Only words', text: 'Just a line of text.' },
    { title: 'Example Section' }] }));
  await writeFile(path.join(paths.directory, 'settings.json'), JSON.stringify({ registry: 'hub/registry.json', primary: 'projects/AGENTS.md', space: 'p9/space.json' }));
  return { args: ['--settings', path.join(paths.directory, 'settings.json')] };
}

test('O182 phone: an empty non-widget section draws nothing, while sections with things still draw', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, { setup });
  const { page } = await phone(t, server);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('[data-nav="mission"]');
  await page.waitForSelector('#mission .tile[data-open="queue"]', { timeout: 15000 });

  // The sections with something to show still draw their tiles.
  assert.equal(await page.locator('#mission .tile:has(span:text-is("Reviews"))').count(), 1, 'the section with a checklist still draws');
  assert.equal(await page.locator('#mission .tile:has(span:text-is("Only words"))').count(), 1, 'the text-only section still draws');
  // The empty section: either it is not drawn as a tile, or its window's body is one line that says
  // there is nothing — never a heading with a blank body under it.
  const tile = page.locator('#mission .tile:has(span:text-is("Example Section"))');
  const drawn = (await tile.count()) > 0;
  await shot(page, 'o182-mission-tiles');
  if (!drawn) { console.log('PASS O182: the empty section draws no tile'); return; }
  await tile.first().click();
  await page.waitForSelector('#mission dialog[open]', { timeout: 5000 });
  await shot(page, 'o182-empty-section-window');
  const body = await page.evaluate(() => { const el = document.querySelector('#mission dialog[open] .wbody'); return { text: (el?.textContent ?? '').trim(), height: Math.round(el?.getBoundingClientRect().height ?? 0) }; });
  assert.ok(body.text.length > 0, 'the empty section\'s window says something in one line, not a blank body: ' + JSON.stringify(body));
  assert.ok(body.height < 120, 'the empty-state line is one line, not an empty window: ' + body.height + ' px');
  assert.match(body.text, /nothing/i, 'the one line says there is nothing: ' + JSON.stringify(body));
  console.log('PASS O182: the empty section\'s window says so in one line: ' + JSON.stringify(body));
});
