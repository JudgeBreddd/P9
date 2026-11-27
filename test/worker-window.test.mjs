// I3 worker window, what it reads (OPEN-ITEMS 6.5, page half, part A): the Sprint View's Details under a chat's row shows
// its folder's branch, head and changed files, its items, its notes file's last lines and its last reply. The server's
// part is look on each sprint_status worker (sprint-hooks.mjs view): one git status per chat, kept 15 s (the page reads
// the status every 5 s), bounded by a timeout, and none for a closed sprint. The page's part is statusHtml's panel.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { createHooks, parseStatus } from '../apps/server/sprint-hooks.mjs';
import { statusHtml } from '../apps/web/src/sprint-view.mjs';

const EA = '33333333-3333-4333-8333-333333333333', EB = '44444444-4444-4444-8444-444444444444', EC = '55555555-5555-4555-8555-555555555555', ED = '66666666-6666-4666-8666-666666666666';
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), name));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' }).toString();

test('I3 worker window: parseStatus reads branch, head and changed files from git status --porcelain=v2 --branch -z', () => {
  const sha = 'a'.repeat(40);
  const out = [`# branch.oid ${sha}`, '# branch.head sprint/x/build', '# branch.upstream origin/x', '1 .M N... 100644 100644 100644 b c src/a file.mjs',
    '2 R. N... 100644 100644 100644 b c R100 new.mjs', 'old.mjs', 'u UU N... 100644 100644 100644 100644 b c d both.mjs', '? notes/new.md', ''].join('\0');
  assert.deepEqual(parseStatus(out), { branch: 'sprint/x/build', head: sha, changed: { count: 4, files: ['src/a file.mjs', 'new.mjs', 'both.mjs', 'notes/new.md'] } },
    'a rename names its new path once (the old path is its own record), a space in a path is kept');
  assert.deepEqual(parseStatus('# branch.oid (initial)\0# branch.head main\0'), { branch: 'main', head: null, changed: { count: 0, files: [] } }, 'a branch with no commit yet');
  assert.equal(parseStatus(`# branch.oid ${sha}\0# branch.head (detached)\0`).branch, null, 'detached');
  const many = parseStatus(['# branch.oid (initial)', '# branch.head m', ...Array.from({ length: 25 }, (_, i) => `? f${i}`)].join('\0'));
  assert.deepEqual([many.changed.count, many.changed.files.length, many.changed.files.at(-1)], [25, 20, 'f19'], 'the count is every file, the list the first 20');
});

// A sprint: lead EA, workers EB (a git folder with a commit and an untracked file), EC (a folder that is not git) and ED
// (no folder). r.closed: the sprint is closed with a record.
function rig() {
  const repo = tmp('p9-i3-repo-'), plain = tmp('p9-i3-plain-');
  git(repo, 'init', '-q', '-b', 'sprint/s/build'); fs.writeFileSync(path.join(repo, 'a.txt'), 'a'); git(repo, 'add', 'a.txt'); git(repo, 'commit', '-qm', 'one');
  fs.writeFileSync(path.join(repo, 'new.txt'), 'n');
  const folders = { [EA]: null, [EB]: repo, [EC]: plain, [ED]: null }, keys = { [EB]: 'build', [EC]: 'docs', [ED]: null };
  const r = { repo, closed: null, notes: { 'notes/build.md': '# Notes\n\n## Now\n- Doing: B4\n\x1b[31mred\x1b[0m line\n\n' + Array.from({ length: 20 }, (_, i) => `- Log ${i}`).join('\n') + '\n' },
    replies: { [EB]: 'Pushed B4. Done.', [EC]: '' }, gauges: {}, modes: {} };
  const info = (c) => (c in folders ? { title: c.slice(0, 2), provider: 'fake' } : null);
  const chat = { lock: () => ({ on: false }), info, family: () => [{ id: EA }, ...[EB, EC, ED].map((id) => ({ id, parent: EA, key: keys[id] }))], list: () => [],
    sprint: () => ({}), gauge: (c) => r.gauges[c] ?? null, lastMode: (c) => r.modes[c] ?? null, startFolder: async (c) => folders[c], scriptLibrary: () => [], allowScripts: () => false, paused: () => false,
    socketPath: '/nowhere', note: async () => ({}), closing: () => false, reply: (c) => r.replies[c] ?? '',
    sprintFiles: { exists: (c) => c === EA, read: (c, name) => (name === 'sprint.md' ? '# Plan\n\n- [ ] B4: build it; role build\n' : r.notes[name] ?? null), folderOf: () => repo, log: () => {} },
    projects: { merge: () => true, started: () => ({ at: 0, by: 'owner', plan: null, scripts: [] }), closed: () => r.closed, prepOf: () => null, record: async () => null, sprintSet: async () => ({ source: null, setup: '' }) } };
  r.hooks = createHooks({ chat, usage: async () => null, stateOf: () => 'idle', rolesOf: () => ({ error: 'none' }), allowed: async () => true, ticking: false });
  r.look = async (id) => (await r.hooks.view(EA)).workers.find((w) => w.chat === id).look;
  return r;
}

test('I3 worker window: sprint_status gives each chat its look: branch, head, changed files, notes tail and last reply', async () => {
  const r = rig(), head = git(r.repo, 'rev-parse', 'HEAD').trim(), b = await r.look(EB);
  assert.deepEqual(b.git, { branch: 'sprint/s/build', head, changed: { count: 1, files: ['new.txt'] } });
  assert.equal(b.notes.file, 'notes/build.md');
  assert.equal(b.notes.tail.length, 15, 'the last 15 lines that are not empty');
  assert.equal(b.notes.tail.at(-1), '- Log 19');
  assert.equal(r.notes['notes/build.md'].includes('\x1b'), true); assert.equal((await r.hooks.view(EA)).workers.some((w) => JSON.stringify(w.look).includes('\\u001b')), false, 'no control character reaches the page');
  assert.equal(b.reply, 'Pushed B4. Done.', 'a line separator in a reply is a space');
  const c = await r.look(EC), d = await r.look(ED);
  assert.deepEqual([c.git, c.notes, c.reply], [null, null, null], 'a folder that is not git: no git; no notes file; no reply yet');
  assert.equal(d.git, null, 'no folder: no git');
  assert.equal(d.notes, null, 'a worker without a key reads notes/<chat ID>.md, which is not there');
});

test('I3 worker window: one look per chat is kept 15 s, so the page\'s 5 s reads do not run git each time', async () => {
  const r = rig(), first = await r.look(EB);
  fs.writeFileSync(path.join(r.repo, 'second.txt'), 's');
  r.replies[EB] = 'a newer reply';
  const again = await r.look(EB);
  assert.deepEqual(again, first, 'a read within 15 s answers the kept look (no second git status)');
  const both = await Promise.all([r.hooks.view(EA), r.hooks.view(EA)]);
  assert.deepEqual(both[0].workers.map((w) => w.look), both[1].workers.map((w) => w.look), 'two reads at once share one look');
});

test('I3 worker window: a git that does not answer is stopped after 5 s and the look says no git; a closed sprint runs no git at all', { timeout: 30000 }, async () => {
  const bin = tmp('p9-i3-bin-'), ran = path.join(bin, 'ran');
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho x >> '${ran}'\nexec sleep 30\n`, { mode: 0o755 });
  const r = rig(), closed = rig(); // made before the stand-in git is first on PATH
  const PATH = process.env.PATH; process.env.PATH = bin + path.delimiter + PATH;
  try {
    const t = Date.now(), b = await r.look(EB);
    assert.equal(b.git, null);
    assert.ok(Date.now() - t < 12000, `bounded by the timeout, took ${Date.now() - t} ms`);
    assert.equal(fs.readFileSync(ran, 'utf8').split('\n').filter(Boolean).length, 2, 'git ran for the two chats with a folder');
    fs.rmSync(ran);
    closed.closed = { at: 1, by: 'owner', record: { sprint: { id: EA }, workers: [{ chat: EB, look: { git: null, notes: null, reply: 'at Close' } }] } };
    const v = await closed.hooks.view(EA);
    assert.equal(v.workers[0].look.reply, 'at Close', 'a closed sprint answers with its record');
    assert.equal(fs.existsSync(ran), false, 'a closed sprint ran git');
  } finally { process.env.PATH = PATH; }
});

test('I3 worker window: a stopped chat keeps the effort it ran on, from its newest config, as it keeps its model', async () => {
  const r = rig();
  r.gauges[EB] = { model: 'haiku', effort: 'low', context: null, spent: null }; // a stopped chat: info has no live session, so no model or effort
  const b = (await r.hooks.view(EA)).workers.find((w) => w.chat === EB);
  assert.deepEqual([b.model, b.effort], ['haiku', 'low']);
});

test('I3 worker window: a stopped chat keeps the mode it ran in, from its newest mode event', async () => {
  const r = rig();
  r.modes[EB] = 'auto'; // a stopped chat: info has no live session, so no mode; chat.lastMode reads its newest mode event
  const ws = (await r.hooks.view(EA)).workers, b = ws.find((w) => w.chat === EB);
  assert.equal(b.mode, 'auto');
  assert.equal(ws.find((w) => w.chat === EC).mode, null, 'a chat that never told a mode has none');
});

const esc = (v) => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const s = (workers, items = []) => ({ sprint: { id: 'L' }, closed: null, workers, items, done: { merged: 0, ticked: 0, total: items.length }, spent: null, scripts: { running: 0, additional: 0, waiting: 0 } });
const w = (chat, more) => ({ chat, key: chat, title: chat, provider: 'fake', profile: null, model: 'm', effort: null, state: 'idle', folder: '/w/' + chat, work: null, ...more });
const panel = (html, chat) => new RegExp(`<li data-key="${chat}">[^]*?<div class="sv-look" data-sv-look( hidden)?>([^]*?)</div></li>`).exec(html);

test('I3 worker window: Details under each row shows the look, items and review; shut until pressed', () => {
  const sha = 'b'.repeat(40), items = [{ id: 'B4', text: 'B4: build it', role: 'a', ticked: false, review: { state: 'fix', fixes: 1 } }, { id: 'B5', text: 'B5: <next>', role: 'a', ticked: false }, { id: 'D1', text: 'D1', role: 'b' }];
  const html = statusHtml(s([
    w('a', { profile: 'p1', mode: 'auto', waiting: true, ready: { item: 'B4', commit: sha }, verdict: { result: 'fix', note: 'add a test' },
      look: { git: { branch: 'sprint/s/a', head: sha, changed: { count: 22, files: Array.from({ length: 20 }, (_, i) => `f${i}<`) } }, notes: { file: 'notes/a.md', tail: ['- Doing: <B4>'] }, reply: 'Pushed <b>.' } }),
    w('b', { folder: null, look: { git: null, notes: { file: 'notes/b.md', tail: [] }, reply: null } }),
    w('c', { look: { git: null, notes: null, reply: null } }),
    w('d', {})], items), esc);
  const a = panel(html, 'a');
  assert.ok(a, 'a Details panel in the row'); assert.equal(a[1], ' hidden', 'shut until pressed');
  assert.match(html, /<li data-key="a">[^]*?data-sv-lookbtn aria-expanded="false"[^>]*>Details</);
  for (const want of [/profile p1 · mode auto/, /sprint\/s\/a · bbbbbbbb/, /22 not committed: f0&lt;, [^]*f19&lt;, …/, /Ready: B4 at bbbbbbbb · fix: add a test/,
    /waiting for you/, /data-sv-litem="B4"[^]*Fix asked · 1 fix</, /data-sv-litem="B5"[^]*B5: &lt;next&gt;[^]*Open/, /notes\/a\.md/, /<pre class="sv-pre" data-sv-notes>- Doing: &lt;B4&gt;<\/pre>/, /data-sv-reply>Pushed &lt;b&gt;\.</])
    assert.match(a[2], want);
  assert.doesNotMatch(a[2], /data-sv-litem="D1"/, 'only its own role\'s items');
  const b = panel(html, 'b')[2];
  for (const want of [/No folder/, /The notes file is empty/, /No reply yet/, /Nothing sent for review/]) assert.match(b, want);
  assert.match(panel(html, 'c')[2], /Not a git folder, or git did not answer in time[^]*No notes file/);
  assert.match(panel(html, 'd')[2], /Not read for this record/, 'a record from before look says so');
  assert.match(panel(html, 'd')[2], /No items in the plan for this role/);
});

test('I3 worker window: Details stays open across the 5 s redraw, per chat', async () => {
  const on = {};
  globalThis.document = { addEventListener: (t, f) => { (on[t] ??= []).push(f); } };
  try {
    const v = await import('../apps/web/src/sprint-view.mjs?i3look');
    const f = { hidden: true }, li = { dataset: { key: 'a' }, querySelector: () => f }, attrs = {};
    const b = { closest: (q) => (q === '[data-sv-lookbtn]' ? b : q === 'li[data-key]' ? li : null), setAttribute: (k, x) => { attrs[k] = x; } };
    const press = () => on.click.forEach((h) => h({ target: b }));
    const draw = () => v.statusHtml(s([w('a', { look: { git: null, notes: null, reply: null } }), w('z', { look: { git: null, notes: null, reply: null } })]), esc);
    press();
    assert.deepEqual([f.hidden, attrs['aria-expanded']], [false, true]);
    assert.equal(panel(draw(), 'a')[1], undefined, 'the redraw keeps it open');
    assert.equal(panel(draw(), 'z')[1], ' hidden', 'another chat stays shut');
    assert.match(draw(), /<li data-key="a">[^]*?data-sv-lookbtn aria-expanded="true"/);
    press();
    assert.deepEqual([f.hidden, panel(draw(), 'a')[1]], [true, ' hidden'], 'pressed again: shut, and the redraw keeps it shut');
  } finally { delete globalThis.document; }
});

test('I3 worker window: Details shows tokens used and the context of its limit, or says they are not reported yet; the row reads the same context', () => {
  const html = statusHtml(s([w('a', { spent: { inputTokens: 12000, outputTokens: 3400, cachedTokens: 0, costUsd: 0 }, context: { used: 50000, size: 200000 }, look: { git: null, notes: null, reply: null } }),
    w('b', { spent: null, context: null, look: { git: null, notes: null, reply: null } })]), esc);
  assert.match(panel(html, 'a')[2], /<dt>Tokens used<\/dt><dd>12K in · 3\.4K out · 0 cached<\/dd>/);
  assert.match(panel(html, 'a')[2], /<dt>Context<\/dt><dd>50K of 200K tokens · 25%<\/dd>/);
  assert.match(html, /<li data-key="a">[^]*?<span class="muted">m · context 25% · 12K in/, 'the row: its context as a share, from the same reading');
  assert.match(panel(html, 'b')[2], /<dt>Tokens used<\/dt><dd>Nothing reported yet<\/dd>[^]*<dt>Context<\/dt><dd>Nothing reported yet<\/dd>/);
  assert.doesNotMatch(html, /<li data-key="b">[^]*?<span class="muted">m · context/, 'no context reported: none on the row');
});

// The page's own stylesheet in a real browser, with Details open: the item names get their room beside the state pill, and a
// long last reply with no spaces wraps inside its box instead of scrolling sideways.
const shown = async (t, html) => {
  const css = fs.readFileSync(new URL('../apps/web/src/styles/projects.css', import.meta.url), 'utf8');
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  await page.setContent(`<style>${css}</style><div class="ppage" style="width:740px">${html}</div>`);
  await page.evaluate(() => document.querySelectorAll('[data-sv-look]').forEach((x) => { x.hidden = false; }));
  return page;
};
const browserTest = { timeout: 60000, skip: process.platform === 'win32' && 'Windows CI has no Playwright Chromium' };

test('I3 worker window: in the browser an item name is not cut to one character beside its pill', browserTest, async (t) => {
  const items = [{ id: 'B1', text: 'B1: draw the beds page', role: 'a', ticked: false }, { id: 'B2', text: 'B2: test the beds page', role: 'a', ticked: false, review: { state: 'ready' } }];
  const page = await shown(t, statusHtml(s([w('a', { look: { git: null, notes: null, reply: null } })], items), esc));
  const got = await page.evaluate(() => [...document.querySelectorAll('[data-sv-litem]')].map((li) => {
    const n = li.querySelector('.sv-text'), g = li.querySelector('.tag');
    return { name: n.getBoundingClientRect().width, full: n.scrollWidth, pill: g.getBoundingClientRect().width, row: li.getBoundingClientRect().width };
  }));
  assert.equal(got.length, 2);
  for (const x of got) {
    assert.ok(x.name >= x.full && x.name > 100, `the whole name shows: ${x.name} px for ${x.full} px of text`);
    assert.ok(x.pill < x.row / 4, `the pill is as wide as its text, not the row: ${x.pill} px of ${x.row} px`);
  }
  // The plan list (box, name, pills) keeps its grid, so its columns line up across rows as before.
  const plan = await page.evaluate(() => [...document.querySelectorAll('li[data-sv-item]')].map((li) => { const c = getComputedStyle(li); return [c.display, c.gridTemplateColumns.split(' ').length]; }));
  assert.ok(plan.length >= 2, 'the plan list is drawn');
  for (const x of plan) assert.deepEqual(x, ['grid', 4]);
});

test('I3 worker window: in the browser a last reply with no spaces wraps, with no sideways scroll', browserTest, async (t) => {
  const page = await shown(t, statusHtml(s([w('a', { look: { git: null, notes: null, reply: 'token:' + 'dca80f66'.repeat(60) } })]), esc));
  const r = await page.evaluate(() => { const x = document.querySelector('[data-sv-reply]'); return { scroll: x.scrollWidth, box: x.clientWidth, wide: x.getBoundingClientRect().width, tall: x.clientHeight }; });
  assert.ok(r.wide <= 740, `the box stays inside the page, not pushed out by the line: ${r.wide} px`);
  assert.ok(r.scroll <= r.box, `no sideways scroll: ${r.scroll} px in ${r.box} px`);
  assert.ok(r.tall > 40, `it wraps onto more lines: ${r.tall} px tall`);
});
