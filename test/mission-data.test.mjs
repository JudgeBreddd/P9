import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { daemon, http, authenticated } from './helpers.mjs';
import { tileHtml, linkHtml } from '../apps/web/src/data-tiles.mjs';
import { dataShape } from '../apps/server/mission-fields.mjs';

// Mission data tiles and links (M3, threat model row 70).
const node = process.execPath;
const SETTINGS = { primary: 'projects/AGENTS.md', registry: 'hub/registry.json', waiting: '_waiting', space: 'hub/space.json' };
const print = (value) => [node, '-e', `require('fs').appendFileSync('ran-' + process.argv[1], 'x'); process.stdout.write(${JSON.stringify(JSON.stringify(value))})`];
const SCRIPTS = [
  { id: 'stat', title: 'Count', cmd: [...print({ type: 'stat', value: 12, label: 'Inbox', unit: 'notes' }), 'stat'] },
  { id: 'list', title: 'Recent', cmd: [...print({ type: 'list', rows: [{ title: 'Plan', subtitle: '2 h ago', link: 'https://example.com/plan', badge: 3 }] }), 'list'] },
  { id: 'table', title: 'Services', cmd: [...print({ type: 'table', columns: ['Name', 'State'], rows: [['web', 'up'], ['db', 'down']] }), 'table'] },
  { id: 'rings', title: 'Disks', cmd: [...print({ type: 'rings', rings: [{ label: 'Root', percent: 42 }, { label: 'Data', percent: 87.4 }] }), 'rings'] },
  { id: 'html', title: 'Html', cmd: [...print({ type: 'stat', value: '<img src=x onerror=alert(1)>' }), 'html'] },
  { id: 'pie', title: 'Pie', cmd: [...print({ type: 'pie', slices: [1] }), 'pie'] },
  { id: 'slow', title: 'Slow', cmd: [node, '-e', 'process.stdout.write("{}"); setTimeout(() => {}, 25000)'] },
  { id: 'big', title: 'Big', cmd: [node, '-e', 'process.stdout.write("x".repeat(100 * 1024))'] },
  { id: 'asks', title: 'Asks', confirm: true, cmd: [node, '-e', '1'] },
];
const SPACE = { sections: [{ id: 'home', title: 'Home', data: ['stat', 'list', 'table', 'rings', 'html', 'pie', 'slow', 'big', 'asks'].map((id) => ({ id: 'tile-' + id, title: id, script: id })),
  links: [{ id: 'docs', title: 'Docs', url: 'https://example.com/docs' }, { id: 'evil', title: 'Evil', url: 'javascript:alert(1)' }] }] };

async function start(t) {
  return daemon(t, undefined, false, async (paths) => {
    const w = paths.workspace;
    for (const folder of ['hub', 'projects/event-horizon', '_waiting']) await mkdir(path.join(w, folder), { recursive: true });
    await writeFile(path.join(w, SETTINGS.registry), JSON.stringify({ scripts: SCRIPTS, apps: [], pages: [] }));
    await writeFile(path.join(w, SETTINGS.primary), '# Projects\n\n**Main project: P9 — Event Horizon** (`event-horizon/`; named 2026-10-15)\n');
    await writeFile(path.join(w, 'projects/event-horizon/AGENTS.md'), '# P9\n\n**Status:** **Open**\n');
    await writeFile(path.join(w, SETTINGS.space), JSON.stringify(SPACE));
    await writeFile(path.join(paths.directory, 'settings.json'), JSON.stringify(SETTINGS));
    return { args: ['--settings', path.join(paths.directory, 'settings.json')] };
  });
}
const call = async (instance, route, method = 'GET', body) => {
  // 30 s: a slow tile's ask lasts its 10 s limit, the helper's default.
  const result = await http({ socketPath: instance.credentials.socketPath, route, method, timeout: 30000,
    headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: result.status, body: JSON.parse(result.text) };
};
const tile = (instance, id) => call(instance, '/mission/data?id=tile-' + id);
const allow = (instance, id) => call(instance, '/mission/data/allow', 'POST', { id: 'tile-' + id });
const ran = (instance, id) => readFile(path.join(instance.workspace, 'ran-' + id), 'utf8').catch(() => '');
const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

test('M3 data tiles: nothing runs before Allow; each shape comes back; slow, oversized and bad output say what happened, as text', { timeout: 90000 }, async (t) => {
  const instance = await start(t);
  const overview = (await call(instance, '/mission')).body;
  const home = overview.space.find((section) => section.id === 'home');
  assert.deepEqual(home.data.map((d) => d.id).slice(0, 2), ['tile-stat', 'tile-list']);
  assert.deepEqual(home.links, [{ id: 'docs', title: 'Docs', url: 'https://example.com/docs' }], 'the javascript: link is dropped');

  // Asked once per tile: no run before the user's Allow, and an agent's space cannot hold the answer.
  const first = await tile(instance, 'stat');
  assert.deepEqual([first.status, first.body.error, first.body.script], [409, 'allow-required', 'Count']);
  assert.equal(await ran(instance, 'stat'), '', 'nothing ran before Allow');
  assert.equal((await allow(instance, 'stat')).status, 200);
  const answers = path.join(instance.directory, 'mission-allowed.json');
  assert.equal((await stat(answers)).mode & 0o777, 0o600);
  assert.deepEqual((await tile(instance, 'stat')).body, { shape: { type: 'stat', value: 12, label: 'Inbox', unit: 'notes' } });
  await tile(instance, 'stat');
  assert.equal(await ran(instance, 'stat'), 'x', 'a second ask within 30 s gets the last answer');

  for (const id of ['list', 'table', 'rings']) { await allow(instance, id); assert.equal((await tile(instance, id)).body.shape?.type, id); }
  // A list row's javascript: link is no shape at all: the whole answer is the bad-shape text.
  assert.match(dataShape({ type: 'list', rows: [{ title: 'x', link: 'javascript:alert(1)' }] }), /http\(s\) link/);

  await allow(instance, 'pie');
  assert.deepEqual((await tile(instance, 'pie')).body, { why: 'printed JSON whose type is not stat, list, table or rings', printed: '{"type":"pie","slices":[1]}' });
  await allow(instance, 'big');
  const big = (await tile(instance, 'big')).body;
  assert.equal(big.why, 'printed more than 64 KiB and was stopped');
  assert.equal(big.printed.length, 2000);
  await allow(instance, 'slow');
  const began = Date.now();
  assert.deepEqual((await tile(instance, 'slow')).body, { why: 'took longer than 10 s and was stopped', printed: '{}' });
  assert.ok(Date.now() - began < 15000, 'stopped at 10 s');

  // Scripts that ask first are never run by a tile; a changed command asks again.
  assert.equal((await allow(instance, 'asks')).body.error, 'not-a-data-script');
  const registry = path.join(instance.workspace, SETTINGS.registry);
  const changed = SCRIPTS.map((s) => (s.id === 'stat' ? { ...s, cmd: [...print({ type: 'stat', value: 13 }), 'stat'] } : s));
  await writeFile(registry, JSON.stringify({ scripts: changed, apps: [], pages: [] }));
  assert.equal((await tile(instance, 'stat')).body.error, 'allow-required', 'a changed command is asked about again');

  // Drawn as text: markup in the output and a bad link arrive escaped or not at all.
  await allow(instance, 'html');
  const html = tileHtml((await tile(instance, 'html')).body, esc);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;') && !html.includes('<img'), html);
  const drawn = tileHtml({ shape: { type: 'list', rows: [{ title: '<b>x</b>', link: 'javascript:alert(1)' }, { title: 'ok', link: 'https://example.com/a"b' }] } }, esc);
  assert.ok(!drawn.includes('javascript:') && !drawn.includes('<b>') && drawn.includes('href="https://example.com/a&quot;b"'), drawn);
  assert.ok(linkHtml({ title: 'Docs', url: 'https://example.com/docs' }, esc).includes('<small>example.com</small>'));
});
