// settings-looks: split from test/settings.test.mjs (O120), by area — the Settings dialog's looks surfaces.
// Same helpers, same fixtures, every test moved verbatim: none dropped, none weakened.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { deflateSync, crc32 } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { _electron } from '@playwright/test';
import { daemon, http, authenticated, root, versionSeen, openFiles } from './helpers.mjs';
import { REPO } from '../apps/server/anymouse.mjs';
import { AZURE, FIXTURE, OTHERS } from './azure-fixture.mjs';
const look = (on, roles = {}) => ({ on, size: 48, claude: null, codex: null, system: null, top: null, pane: null, ...roles });
const PETS = { chat: look(true), dev: look(false), mission: look(false) };
const SKIPPER = { system: 'skipper' }, DEFAULT_PETS = { chat: look(true, SKIPPER), dev: look(false, SKIPPER), mission: look(false, SKIPPER) };
const DOCS_URL = 'https://github.com/' + REPO + '#readme'; // main.mjs loads only inside Electron
const RELEASES_URL = 'https://github.com/' + REPO + '/releases/latest';
const PETDEX_URL = 'https://petdex.dev';
// 0.1.8: Mode, Model and Effort are pills in the message bar (controller.mjs pillMenu); each opens a menu of menuitemradio choices.
// pillValue reads a pill's value from its aria-label; pillItems lists a menu (the checked ones marked); choose picks (no submenus).
const pillOf = (pane, kind) => pane.locator(`[data-pill="${kind}"]`);
const pillValue = async (pane, kind) => (await pillOf(pane, kind).getAttribute('aria-label')).replace(kind + ': ', '');
const menuItem = (page, label) => page.locator('#pillMenu .item').filter({ has: page.locator(`.truncate:text-is("${label}")`) });
const pillItems = async (page, pane, kind) => { await pillOf(pane, kind).click(); await page.locator('#pillMenu:not([hidden])').waitFor(); const items = await page.locator('#pillMenu .item').evaluateAll((l) => l.map((b) => b.firstElementChild.textContent + (b.getAttribute('aria-checked') === 'true' ? ' ✓' : ''))); await page.keyboard.press('Escape'); return items; };
const choose = async (page, pane, kind, ...labels) => { await pillOf(pane, kind).click(); for (const label of labels) await menuItem(page, label).click(); };
const fake = path.join(root, 'test/fake-acp-agent.mjs');
// O119: the themes kept, in picker order, and the ones taken out (a look saved under one loads as the default).
const KEPT = ['duskwood', 'midnight', 'daylight', 'linen', 'event-horizon-prime', 'night-drive', 'olympus', 'hades', 'aphrodite-blue', 'aphrodite-charcoal', 'p9-event-horizon-azure'];
const GONE = ['ember', 'forest', 'synthwave', 'rose', 'arctic', 'mono', 'outrun', 'cyberpunk', '8bit', 'ascii', 'custom', 'redline', 'event-horizon', 'apollo', 'athena', 'poseidon', 'ra'];
const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((result) => JSON.parse(result.text));


// O37 (threat model row 18): a complete fenced block in a listed language is coloured, in every look; an unknown
// language, a block still open and markup inside a block stay plain escaped text.
test('Code colours: ts, python, json and shell blocks coloured in Azure and the other looks, readable; unknown language, open block and markup stay text', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-code-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#rChat').waitFor();
  const fence = (lang, code) => '```' + lang + '\n' + code.replace(/\n$/, '') + '\n```\n\n';
  const text = '\nFour blocks:\n\n' + fence('ts', FIXTURE.ts) + fence('python', OTHERS['app.py']) + fence('json', OTHERS['data.json']) + fence('bash', OTHERS['run.sh'])
    + fence('zz', 'const plain = 1;') + fence('constructor', 'a') + fence('toString', 'b') + fence('__proto__', 'c') + fence('ts', 'const x = "<img src=x onerror=window.pwned=1>"; // </code></pre><script>window.pwned = 2</script>')
    + '```py\ndef still_open():';
  const id = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  await call(instance, `/chat/${id}/prompt`, 'POST', { text });
  await page.locator(`#nav .row[data-chat="${id}"]`).click();
  const reply = page.locator(`#chats .pane[data-id="${id}"] .msg.agent`).last();
  // The first block loads its parser; the chat redraws once each one arrives.
  await reply.locator('code.language-bash .cc-comment').first().waitFor({ timeout: 15000 });
  await reply.locator('code.language-json .cc-prop').first().waitFor({ timeout: 15000 });
  const blocks = await reply.evaluate((m) => [...m.querySelectorAll('pre')].map((pre) => {
    const code = pre.querySelector('code');
    return { lang: code.className, spans: code.querySelectorAll('span').length, copy: !!pre.querySelector('[data-copycode]'), text: code.textContent,
      kinds: [...new Set([...code.querySelectorAll('span')].map((s) => s.className))].sort() };
  }));
  assert.deepEqual(blocks.map((b) => [b.lang, b.spans > 0, b.copy]), [['language-ts', true, true], ['language-python', true, true], ['language-json', true, true],
    ['language-bash', true, true], ['language-zz', false, true], ['language-constructor', false, true], ['language-toString', false, true],
    ['language-__proto__', false, true], ['language-ts', true, true], ['language-py', false, true]]);
  // The text in each block is the code exactly as sent (colouring adds spans, never characters).
  assert.equal(blocks[0].text, FIXTURE.ts);
  assert.equal(blocks[2].text, OTHERS['data.json']);
  assert.equal(blocks[4].text, 'const plain = 1;\n');
  assert.equal(blocks[7].text, 'c\n', 'a label that names an inherited property stays plain');
  // The render path catches a throw and a later redraw hides it, so the lookup itself is checked here.
  const { codePieces } = await import('../apps/web/src/code-colours.mjs');
  for (const l of ['constructor', 'toString', '__proto__']) assert.equal(codePieces(l, 'x'), null, l + ' stays plain');
  assert.equal(blocks[9].text, 'def still_open():\n', 'an open block stays plain');
  for (const k of ['cc-keyword', 'cc-string', 'cc-type', 'cc-punct']) assert.ok(blocks[0].kinds.includes(k), 'ts has ' + k + ': ' + blocks[0].kinds);
  assert.deepEqual(await reply.evaluate((m) => ({
    banned: m.querySelectorAll('script, img, iframe, object, embed, svg').length,
    on: [...m.querySelectorAll('*')].some((el) => [...el.attributes].some((a) => /^on/i.test(a.name))),
    classes: [...new Set([...m.querySelectorAll('pre span')].flatMap((s) => [...s.classList]))].every((c) => /^cc-[a-z]+$/.test(c)),
    shown: m.querySelectorAll('pre')[8].textContent.includes('<img src=x onerror=window.pwned=1>') && m.querySelectorAll('pre')[8].textContent.includes('<script>'),
    pwned: window.pwned ?? null,
  })), { banned: 0, on: false, classes: true, shown: true, pwned: null });
  // Each colour, blended onto its block's real background, read in four looks: the default dark look, AMOLED, a light
  // look and Azure (Azure's colours are the spec's).
  const read = () => reply.evaluate((m) => {
    const px = (colour, under) => { const c = document.createElement('canvas').getContext('2d', { willReadFrequently: true }); c.fillStyle = under || '#000'; c.fillRect(0, 0, 1, 1); c.fillStyle = colour; c.fillRect(0, 0, 1, 1); return [...c.getImageData(0, 0, 1, 1).data].slice(0, 3); };
    const lum = (rgb) => { const [r, g, b] = rgb.map((v) => v / 255).map((v) => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const out = {};
    for (const pre of m.querySelectorAll('pre')) {
      const bg = px(getComputedStyle(pre).backgroundColor, getComputedStyle(document.body).backgroundColor);
      for (const span of pre.querySelectorAll('code span')) {
        const fg = px(getComputedStyle(span).color, 'rgb(' + bg + ')'), [x, y] = [lum(fg), lum(bg)].sort((a, b) => b - a);
        const ratio = Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
        if (!(span.className in out) || ratio < out[span.className].ratio) out[span.className] = { ratio, rgb: 'rgb(' + fg.join(', ') + ')' };
      }
    }
    return out;
  });
  const shot = async (name) => { if (!process.env.GITHUB_ACTIONS) { await page.waitForTimeout(300); console.log('P9_SHOT ' + name + ' ' + (await reply.screenshot()).toString('base64')); } };
  const looks = {};
  looks.default = await read(); await shot('code-colours-default');
  await page.evaluate(() => document.documentElement.setAttribute('data-amoled', '')); looks.amoled = await read();
  await page.evaluate(() => { const h = document.documentElement; h.removeAttribute('data-amoled'); h.classList.remove('dark'); h.dataset.theme = 'daylight'; });
  looks.daylight = await read(); await shot('code-colours-daylight');
  await page.evaluate((azure) => { const h = document.documentElement; h.classList.add('dark'); h.dataset.theme = azure; }, AZURE);
  looks.azure = await read(); await shot('code-colours-azure');
  console.log('CONTRAST ' + JSON.stringify(looks));
  const azure = Object.fromEntries(Object.entries(looks.azure).map(([k, v]) => [k, v.rgb]));
  assert.deepEqual([azure['cc-keyword'], azure['cc-fn'], azure['cc-string'], azure['cc-const'], azure['cc-comment']],
    ['rgb(183, 122, 255)', 'rgb(66, 199, 245)', 'rgb(246, 187, 88)', 'rgb(99, 217, 189)', 'rgb(117, 131, 154)']);
  // Readable: code text at least 4.5:1 on its block; comments and punctuation, muted on purpose, at least 3:1.
  for (const [look, kinds] of Object.entries(looks)) for (const [kind, { ratio }] of Object.entries(kinds)) {
    assert.ok(ratio >= (/cc-comment|cc-punct/.test(kind) ? 3 : 4.5), `${look} ${kind} ${ratio}:1`);
  }
  console.log('PASS code colours: 4 coloured blocks plus an unknown language, open block and markup as text; contrast ' + Object.entries(looks).map(([l, k]) => l + ' min ' + Math.min(...Object.values(k).map((v) => v.ratio))).join(', '));
});

// O31 (nightly 1, a dark gold look): Settings > Default effort opened as a white list with near-white words. Every
// dropdown's open list, in every look plus AMOLED: each option's words against the list it is drawn on, at least 4.5:1.
test('Dropdowns: every option of every select is readable in its open list, in every look and AMOLED', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t);
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-selects-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#rChat').waitFor();
  const ids = await page.locator('[data-theme-pick]').evaluateAll((buttons) => buttons.map((b) => b.dataset.themePick));
  // The list's background: the option's own, else P9's list (base-select), else the system's list, which nightly 1 showed white.
  const read = () => page.evaluate(() => {
    const px = (colour, under) => { const c = document.createElement('canvas').getContext('2d', { willReadFrequently: true }); c.fillStyle = under || '#000'; c.fillRect(0, 0, 1, 1); c.fillStyle = colour; c.fillRect(0, 0, 1, 1); return [...c.getImageData(0, 0, 1, 1).data].slice(0, 3); };
    const lum = (rgb) => { const [r, g, b] = rgb.map((v) => v / 255).map((v) => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    let worst = null; const selects = document.querySelectorAll('select');
    for (const sel of selects) {
      const own = getComputedStyle(sel).appearance === 'base-select', list = own ? getComputedStyle(sel, '::picker(select)').backgroundColor : '';
      const under = own ? px(list || 'rgba(0,0,0,0)', '#fff') : [255, 255, 255];
      for (const o of sel.options) {
        const bg = px(getComputedStyle(o).backgroundColor, 'rgb(' + under + ')'), fg = px(getComputedStyle(o).color, 'rgb(' + bg + ')'), [x, y] = [lum(fg), lum(bg)].sort((a, b) => b - a);
        const ratio = Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
        if (!worst || ratio < worst.ratio) worst = { ratio, select: sel.getAttribute('aria-label') || sel.id, option: o.textContent, own, list, fg: fg.join(','), bg: bg.join(',') };
      }
    }
    // One arrow each: the thin chevron drawn as the background, room for it on the right, and no picker icon beside it.
    const arrows = [...selects].filter((sel) => { const s = getComputedStyle(sel); return !s.backgroundImage.includes('svg') || parseFloat(s.paddingRight) < 20 || getComputedStyle(sel, '::picker-icon').display !== 'none'; })
      .map((sel) => sel.getAttribute('aria-label') || sel.id || sel.dataset.slot);
    return { selects: selects.length, worst, arrows };
  });
  const openSettings = async () => { await page.click('#setBtn'); await page.locator('#setDlg[open]').waitFor(); };
  const closeSettings = async () => { await page.keyboard.press('Escape'); await page.locator('#setDlg').waitFor({ state: 'hidden', timeout: 5000 }); };
  const shot = async (name) => { if (!process.env.GITHUB_ACTIONS) { await page.waitForTimeout(300); console.log('P9_SHOT ' + name + ' ' + (await page.screenshot()).toString('base64')); } };
  const looks = {};
  for (const id of ids) {
    await page.click('#themeBtn'); await page.click(`[data-theme-pick="${id}"]`); await page.keyboard.press('Escape');
    await openSettings(); looks[id] = await read();
    if (id === 'daylight' || id === ids[0]) {
      // The open list itself: Settings > Chat Focus > Claude's Mode.
      await page.click('[data-set-page="Chat Focus"]'); await shot('select-closed-' + id);
      await page.click('[data-default-mode="claude"]'); await shot('select-open-' + id);
      await page.keyboard.press('Escape');
    }
    await closeSettings();
  }
  await page.evaluate(() => document.documentElement.setAttribute('data-amoled', ''));
  await openSettings(); looks.amoled = await read(); await closeSettings();
  console.log('SELECTS ' + JSON.stringify(Object.fromEntries(Object.entries(looks).map(([k, v]) => [k, v.worst.ratio]))));
  for (const [look, { selects, worst, arrows }] of Object.entries(looks)) {
    assert.ok(selects >= 6, look + ': only ' + selects + ' selects found');
    assert.deepEqual(arrows, [], look + ': these selects lack the one thin arrow');
    assert.ok(worst.ratio >= 4.5, `${look}: "${worst.option}" in ${worst.select} is ${worst.ratio}:1 (${JSON.stringify(worst)})`);
  }
  console.log('PASS dropdowns: ' + Object.keys(looks).length + ' looks, ' + looks.amoled.selects + ' selects, lowest ' + Math.min(...Object.values(looks).map((v) => v.worst.ratio)) + ':1');
});

test('One look for every focus mode: a pick in Chat or Mission sets Dev Focus too; old per-focus looks still load', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t);
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-looks-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const launch = async () => {
    const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
    const proc = app.process();
    t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
    const page = await app.firstWindow();
    await page.locator('#rChat').waitFor();
    return { app, page };
  };
  const theme = (page) => page.evaluate(() => document.documentElement.dataset.theme);
  let { app, page } = await launch();
  const ids = await page.locator('[data-theme-pick]').evaluateAll((buttons) => buttons.map((b) => b.dataset.themePick));
  const before = await theme(page), [first, second, old] = ids.filter((id) => id !== before).slice(0, 3);
  const pick = async (key, id) => {
    await page.keyboard.press(key);
    await page.click('#themeBtn'); await page.click(`[data-theme-pick="${id}"]`); await page.keyboard.press('Escape');
    assert.equal(await theme(page), id);
  };
  const tour = async (id, label) => {
    for (const key of ['Control+1', 'Control+2', 'Control+3', 'Control+1']) {
      await page.keyboard.press(key);
      assert.equal(await theme(page), id, `${label} ${key}`);
      assert.equal(await page.locator(`[data-theme-pick="${id}"]`).getAttribute('aria-pressed'), 'true', `${label} picker ${key}`);
    }
  };
  await pick('Control+1', first);
  await tour(first, 'picked in Chat');
  await pick('Control+3', second);
  await tour(second, 'picked in Mission');
  // f964049: the picker works in Dev Focus too (its menu shows over a still of the editor); it shows the look picked elsewhere.
  await page.keyboard.press('Control+2');
  assert.equal(await page.locator('#themeBtn').isDisabled(), false, 'the theme picker works in Dev Focus');
  assert.equal(await theme(page), second);
  const shot = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'));
  if (process.env.CI !== 'true') console.log('P9_SHOT one-look-dev ' + shot);
  // A profile from an older version holds a different look per focus: it still loads, with the one look everywhere.
  await page.evaluate((id) => localStorage.setItem('p9-focus-looks', JSON.stringify({ dev: { theme: id }, mission: { theme: id } })), old);
  await app.close();
  ({ app, page } = await launch());
  await page.waitForFunction((id) => document.documentElement.dataset.theme === id, second);
  await tour(second, 'after restart with old per-focus looks');
  assert.equal(await page.evaluate(() => localStorage.getItem('p9-focus-looks')), null, 'the old per-focus looks are dropped');
  console.log(`PASS looks: ${first} then ${second} in every focus, Dev Focus included; an old per-focus profile loads with the one look`);
});

test('DUWOP themes: exactly the 11 kept themes are offered (O119), and the command palette names only kept ones; each repaints the page, its fonts load from P9 itself', { timeout: 120000 }, async (t) => {
  // Every DUWOP theme, not a subset
  const instance = await daemon(t);
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-themes-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  const remote = []; page.on('request', (r) => { if (!/^(p9|data|blob):/.test(r.url())) remote.push(r.url()); });
  await page.locator('#rChat').waitFor();
  const ids = await page.locator('[data-theme-pick]').evaluateAll((buttons) => buttons.map((b) => b.dataset.themePick));
  assert.deepEqual(ids, KEPT, 'the picker offers exactly the kept themes');
  await page.keyboard.press('Control+k'); await page.locator('#palIn').fill('Look:');
  // A row's text ends with its Enter hint on a second line; the look's name is the first.
  assert.deepEqual((await page.locator('#palList li[data-i]').allInnerTexts()).map((x) => x.split('\n')[0]), ['Look: Night Drive', 'Look: Duskwood'], 'the command palette names only kept looks');
  await page.keyboard.press('Escape');
  const looks = new Map(), missing = [];
  for (const id of ids) {
    await page.click('#themeBtn'); await page.click(`[data-theme-pick="${id}"]`); await page.keyboard.press('Escape');
    const look = await page.evaluate(async () => {
      const css = getComputedStyle(document.documentElement), fonts = [css.getPropertyValue('--app-font'), css.getPropertyValue('--app-display')].map((f) => f.trim()).filter((f) => f && f !== 'system-ui');
      const loaded = await Promise.all(fonts.map(async (f) => [f, (await document.fonts.load('16px ' + f)).length]));
      return { colours: css.getPropertyValue('--background') + ' ' + css.getPropertyValue('--primary'), unloaded: loaded.filter(([, n]) => !n).map(([f]) => f) };
    });
    looks.set(id, look.colours); missing.push(...look.unloaded.map((f) => id + ':' + f));
    if (process.env.P9_EVIDENCE) await page.screenshot({ path: path.join(process.env.P9_EVIDENCE, `theme-${id}.png`) });
  }
  assert.deepEqual(missing, [], 'a theme names a font P9 does not serve');
  assert.equal(new Set(looks.values()).size, ids.length, 'two themes paint the same colours');
  assert.deepEqual(remote, [], 'no request leaves the app (no Google Fonts)');
  console.log(`PASS DUWOP themes: ${ids.length} offered, ${new Set(looks.values()).size} distinct colour sets, every named font loaded locally, 0 remote requests`);
});

test('Look picker: DUWOP Appearance cards, each painted in its own theme, plus AMOLED, the bundled fonts and every effect', { timeout: 120000 }, async (t) => {
  // The cards and all the themes (DUWOP's _engine/registry/appearance/appearance.tsx)
  const instance = await daemon(t);
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-picker-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#rChat').waitFor();
  const html = (name) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
  await page.click('#themeBtn');
  const cards = await page.locator('#themePop [data-theme-pick]').evaluateAll((list) => list.map((c) => {
    const css = getComputedStyle(c), dot = getComputedStyle(c.querySelector('.dots i'));
    return { id: c.dataset.themePick, bg: css.backgroundColor, dot: dot.backgroundColor, primary: css.getPropertyValue('--primary').trim(), name: c.querySelector('b').textContent, note: c.querySelector('small').textContent };
  }));
  assert.equal(cards.length, KEPT.length);
  assert.ok(cards.every((c) => c.name && c.note), 'every card has a name and a note');
  assert.equal(new Set(cards.map((c) => c.bg + c.dot)).size, KEPT.length, 'every card is painted in its own colours');
  for (const id of ['night-drive', 'midnight', 'olympus', 'daylight']) {
    await page.click(`[data-theme-pick="${id}"]`);
    assert.equal(await html('--primary'), cards.find((c) => c.id === id).primary, `${id}: the card shows the colour the page gets`);
    assert.equal(await page.locator(`[data-theme-pick="${id}"]`).getAttribute('aria-pressed'), 'true');
  }
  await page.click('[data-theme-pick="duskwood"]');
  const fonts = await page.locator('[data-font-pick]').evaluateAll((list) => list.map((b) => b.dataset.fontPick));
  assert.deepEqual(fonts, ['inter', 'system', 'outfit', 'spacegrotesk', 'jetbrains', 'pixelify', 'chakra'], 'only fonts P9 bundles, plus System');
  await page.click('[data-font-pick="jetbrains"]');
  assert.equal(await html('--app-font'), '"JetBrains Mono"');
  assert.equal(await page.locator('[data-font-note]').textContent(), 'Monospace, for the nerds.');
  const fx = () => page.evaluate(() => document.documentElement.dataset.fx);
  assert.deepEqual(await page.locator('[data-fx-pick]').evaluateAll((l) => l.map((b) => b.dataset.fxPick)), ['underglow', 'ambient', 'motion', 'shine'], 'Horizon and Neon are gone (O119)');
  assert.ok(await page.locator('[data-fx-pick="motion"]').isDisabled(), 'Drifting glow waits for Ambient glow');
  await page.click('[data-fx-pick="ambient"]');
  assert.match(await fx(), /\bambient\b/);
  assert.ok(await page.locator('[data-fx-pick="motion"]').isEnabled());
  await page.click('[data-fx-pick="shine"]');
  assert.doesNotMatch(await fx(), /\bshine\b/);
  const amoled = await page.evaluate(() => document.documentElement.hasAttribute('data-amoled'));
  await page.click('[data-amoled-switch]');
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-amoled')), !amoled);
  assert.equal(await page.locator('[data-theme-pick="midnight"]').evaluate((c) => c.hasAttribute('data-amoled')), !amoled, 'the cards follow AMOLED');
  assert.equal(await page.locator('[data-roll]').count(), 0, 'no Roll again button (Roll the dice is gone)');
  await page.click('[data-theme-pick="event-horizon-prime"]');
  if (process.env.P9_EVIDENCE) await page.screenshot({ path: path.join(process.env.P9_EVIDENCE, 'look-picker.png') });
  console.log(`PASS look picker: ${cards.length} cards in their own colours (4 matched the page), ${fonts.length} fonts, 4 effects, AMOLED`);
});

test('O119: a look saved under a removed theme or effect loads as the default, from the boot script on, with no error', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t);
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-gone-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.locator('#rChat').waitFor();
  // What the boot script paints, before the app's module runs: the first data-theme and data-fx put on <html>.
  await page.addInitScript(() => {
    const first = (window.__first = {});
    new MutationObserver((list) => { for (const m of list) if (!(m.attributeName in first)) first[m.attributeName] = document.documentElement.getAttribute(m.attributeName); })
      .observe(document, { subtree: true, attributes: true, attributeFilter: ['data-theme', 'data-fx'] }); // <html> may not exist yet
  });
  const state = () => page.evaluate(() => ({ first: window.__first, theme: document.documentElement.dataset.theme, fx: document.documentElement.dataset.fx,
    inline: document.documentElement.style.getPropertyValue('--primary'), saved: JSON.parse(localStorage.getItem('p9-look')) }));
  const load = async (saved) => {
    await page.evaluate((v) => localStorage.setItem('p9-look', JSON.stringify(v)), saved);
    await page.reload(); await page.locator('#rChat').waitFor();
    return state();
  };
  // The shape applyLook saved on main for each of these, a rolled Roll the dice palette included.
  const old = (theme, effects) => ({ theme, effects, amoled: false, font: 'inter', dark: true, both: false, family: 'Inter', adjust: 0, url: '', display: '', displayUrl: '',
    palette: { nh: 10, nc: 0.03, ph: 140, gh: 200 }, vars: { '--primary': 'oklch(0.78 0.16 140)', '--nh': '10' } });
  const want = { theme: 'event-horizon-prime', fx: 'underglow motion shine' };
  for (const id of [...GONE, 'no-such-theme']) { // any id the app doesn't have, not just a list
    const s = await load(old(id, ['underglow', 'horizon', 'neon', 'motion']));
    assert.deepEqual([s.first['data-theme'], s.theme, s.fx, s.inline, s.saved.theme, s.saved.palette, s.saved.vars], [want.theme, want.theme, want.fx, '', want.theme, undefined, undefined], id);
  }
  // A kept theme saved with a removed effect keeps the theme and drops the effect.
  const s = await load(old('duskwood', ['underglow', 'neon', 'horizon', 'ambient']));
  assert.deepEqual([s.first['data-theme'], s.first['data-fx'], s.theme, s.fx, s.saved.effects], ['duskwood', 'underglow ambient', 'duskwood', 'underglow ambient', ['underglow', 'ambient']]);
  assert.deepEqual(errors, [], 'no page errors');
  console.log(`PASS O119: ${GONE.length} removed themes and an unknown one load as Event Horizon Prime from the first paint; Horizon and Neon drop from a kept look; 0 page errors`);
});
