// O162 (PRs an hour): the status answer's prs_per_hour is the items merged (P9's own merge record) per hour since
// Start, and the Sprint View draws that number. A record closed before the field existed draws no such row.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHooks } from '../apps/server/sprint-hooks.mjs';
import { statusHtml } from '../apps/web/src/sprint-view.mjs';

const id = '55555555-5555-4555-8555-555555555555', w = '66666666-6666-4666-8666-666666666666';
const plan = '# Plan\n\n- [x] A1: one; role w1\n- [x] A2: two; role w1\n- [x] A3: three; role w1\n- [ ] A4: four; role w1\n';
const merged = (item) => ({ state: 'passed', commit: 'a'.repeat(40), fixes: 0, merged: true, at: 1 });
const esc = (v) => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function hooksAt(startedAt, closed = null) {
  const chat = { lock: () => ({ on: false }), allowScripts: () => true, mergedNow: async () => undefined, gauge: () => null, startFolder: async () => '.',
    info: (c) => (c === id ? { title: 'S', provider: 'fake', project: 'p' } : c === w ? { title: 'w1', provider: 'fake', project: 'p', parent: id } : null),
    family: () => [{ id, project: 'p', title: 'S' }, { id: w, parent: id, key: 'w1' }], list: () => [],
    sprint: (c) => (c === w ? { reviews: { A1: merged(), A2: merged(), A3: merged(), A4: { state: 'passed', commit: 'b'.repeat(40), fixes: 0, at: 1 } } } : {}),
    sprintFiles: { exists: (c) => c === id, read: (_s, f) => (f === 'sprint.md' ? plan : null), folderOf: () => '.', log: () => {} },
    projects: { merge: () => true, started: () => ({ at: startedAt, by: 'owner', plan: null, scripts: [] }), closed: () => closed, prepOf: () => null, record: async () => ({ name: 'P' }) } };
  return createHooks({ chat, usage: () => null, stateOf: () => 'running', rolesOf: () => ({ error: 'none' }), allowed: async () => true });
}

test('Sprint View PRs an hour: merged items over hours since Start, from the status answer to the page; none on an older record', async () => {
  const got = await hooksAt(Date.now() - 2 * 3_600_000).status(id, id);
  assert.equal(got.done.merged, 3, JSON.stringify(got.done));
  assert.equal(got.prs_per_hour, Math.round((got.done.merged * 10) / (got.running_ms / 3_600_000)) / 10);
  assert.equal(got.prs_per_hour, 1.5);
  assert.match(statusHtml(got, esc), /<dt>PRs an hour<\/dt><dd data-sv-fact="rate">1\.5<\/dd>/);
  // Ten minutes in with 3 merged: the count so far (that hour's), not 18 an hour.
  assert.equal((await hooksAt(Date.now() - 600_000).status(id, id)).prs_per_hour, 3);
  // A record closed before O162 has no prs_per_hour: no row, never "undefined".
  const { prs_per_hour: _gone, ...old } = got;
  const html = statusHtml({ ...old, closed: { at: '2026-11-01T10:00:00.000Z', by: 'owner' } }, esc);
  assert.doesNotMatch(html, /PRs an hour|data-sv-fact="rate"|undefined/);
  console.log('PASS O162 PRs an hour: 3 merged in 2 h answers 1.5 and the page draws 1.5; 3 in 10 min answers 3; an older record draws no row');
});
