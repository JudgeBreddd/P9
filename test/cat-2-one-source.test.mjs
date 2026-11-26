// CAT-2: five lists that were written by hand in more than one place now come from one source each. Each test below
// fails when a reader keeps its own copy again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import * as protocol from '../packages/protocol/index.mjs';
import * as helpers from '../apps/web/src/helpers.mjs';
import * as security from '../apps/web/src/security.mjs';
import * as onboarding from '../apps/web/src/onboarding.mjs';
import * as mcp from '../apps/server/mcp.mjs';
import * as limits from '../apps/server/limits.mjs';
import { publicAgents, AUTO } from '../apps/server/agents.mjs';
import { WIDGETS, SETTINGS, SECTION, RECORD, PAGE, CARD } from '../apps/server/mission-fields.mjs';
import { GUIDE, buildPrompt } from '../apps/server/templates/guide.mjs';
import { startUsageHistory } from '../apps/server/usage-history.mjs';
import { root } from './helpers.mjs';

test('CAT-2 modes: the window takes each agent\'s modes, its loosest mode and its start mode from GET /agents, a renamed one too', () => {
  const kept = new Map();
  globalThis.localStorage = { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, String(v)), removeItem: (k) => kept.delete(k) };
  try {
    assert.equal(typeof security.fillAgents, 'function', 'security.mjs fills the modes from GET /agents');
    // The catalog renames Claude's Auto and Bypass permissions: the window has no copy of the old names left to refuse them by.
    const renamed = publicAgents().agents.map((a) => a.id !== 'claude' ? a : { ...a, auto: 'Auto pilot',
      modes: a.modes.map((m) => ({ ...m, name: { Auto: 'Auto pilot', 'Bypass permissions': 'Skip asking' }[m.name] ?? m.name })) });
    security.fillAgents(renamed);
    assert.ok(helpers.modes.claude.includes('Skip asking') && helpers.modes.claude.includes('Auto pilot'), 'the renamed modes are offered and pass the mode check');
    assert.ok(!helpers.modes.claude.includes('Bypass permissions'), 'the old name is gone');
    assert.equal(helpers.AUTO.claude, 'Auto pilot', 'a new chat starts in the catalog\'s auto mode');
    assert.equal(security.LOOSEST.claude, 'Skip asking', 'Unrestricted mode starts in the renamed tier-4 mode');
    assert.ok(helpers.LOOSE['Skip asking'] && !('Bypass permissions' in helpers.LOOSE), 'the renamed mode warns; the old name does not linger');
    // The real catalog: every table equals it, the built-in warnings keep their words.
    security.fillAgents(publicAgents().agents);
    for (const a of publicAgents().agents) {
      assert.deepEqual(helpers.modes[a.id], a.modes.map((m) => m.name));
      assert.equal(helpers.AUTO[a.id], AUTO[a.id]);
      assert.equal(security.LOOSEST[a.id], a.modes.find((m) => m.tier === 4)?.name);
    }
    assert.equal(helpers.LOOSE['Bypass permissions'], helpers.LOOSE_SAID['Bypass permissions']);
    // An older server's answer names no modes: none offered, and the page does not stop there.
    security.fillAgents([{ id: 'claude', name: 'Claude' }]);
    assert.deepEqual(helpers.modes.claude, [], 'no modes from an older server');
    // Before GET /agents answers, nothing is known: Unrestricted reads off rather than on.
    security.fillAgents([]);
    assert.deepEqual([helpers.modes, helpers.AUTO, helpers.LOOSE, security.LOOSEST], [{}, {}, {}, {}]);
    assert.equal(security.unrestricted(false, false, 'p9-mode:'), false, 'no catalog yet: Unrestricted is not shown on');
  } finally { delete globalThis.localStorage; }
  console.log('PASS CAT-2 modes: modes, the loosest mode and the start mode come from GET /agents; a renamed mode is taken');
});

test('CAT-2 widgets: the space check, both pages and the guide read one widget list, and the guide names every widget', () => {
  assert.ok(Array.isArray(protocol.WIDGETS), 'packages/protocol lists the widgets');
  assert.deepEqual(WIDGETS, protocol.WIDGETS.map((w) => w.id), 'the space check takes exactly those ids');
  for (const w of protocol.WIDGETS) {
    assert.ok(GUIDE.includes(w.id + ' (' + w.label), `the guide names ${w.id} with its label`);
    assert.equal(typeof w.label, 'string');
  }
  assert.deepEqual(protocol.WIDGETS.filter((w) => w.tile).map((w) => w.id), ['idea', 'sprint', 'edit'], 'the three built-in tiles');
  // Review 12 nit: the lines in each page that draw a widget's name hold none of the names themselves, so a copied label fails.
  const quoted = (line) => protocol.WIDGETS.filter((w) => line.includes(`'${w.label}'`) || line.includes(`>${w.label}<`)).map((w) => w.label);
  // Review 13: the four widget windows' titles too (the desktop's widget headings and windows).
  const pages = { 'mission-view.mjs': ['const BUILTIN =', 'class="wdg"'], 'phone.ts': ['const PHONE_WIDGET', 'const widgetLabel', 'const widgetRow'],
    'controller.mjs': ['  mprimary: {', '  mnotes: {', '  mlaunch: {', '  musage: {'] };
  for (const [file, marks] of Object.entries(pages)) {
    const lines = readFileSync(path.join(root, 'apps/web/src', file), 'utf8').split('\n');
    for (const mark of marks) { const line = lines.find((l) => l.includes(mark));
      assert.ok(line, `${file} still draws widgets at ${mark}`); assert.deepEqual(quoted(line), [], `${file} ${mark} copies no widget name`); }
  }
  console.log('PASS CAT-2 widgets: one list, and the guide names all ' + protocol.WIDGETS.length);
});

test('CAT-2 tools: every tool the guide names is a real MCP tool, and the onboarding card\'s line is the guide\'s', () => {
  assert.ok(Array.isArray(mcp.TOOLS), 'mcp.mjs exports its tool list');
  const tools = new Set(mcp.TOOLS.map((t) => t.name));
  // Field names (settings.page_schemes, quick_note, ...) are snake_case too; anything else snake_case is a tool name.
  const fields = new Set([SETTINGS, SECTION, RECORD, PAGE, CARD].flatMap((t) => Object.keys(t)));
  const text = GUIDE + buildPrompt('draft', { title: 'T', about: 'a' });
  const named = [...new Set(text.match(/\b[a-z]+(?:_[a-z]+)+\b/g))].filter((w) => !fields.has(w));
  assert.ok(named.includes('describe_mission') && named.includes('allow_folder'), 'the scan finds the tool names');
  assert.deepEqual(named.filter((w) => !tools.has(w)), [], 'every snake_case word in the guide is a real tool or a field');
  assert.equal(onboarding.PROTECT_WORDS[1], protocol.PROTECT_AFTER, 'the onboarding card reads the shared line');
  assert.ok(GUIDE.includes(protocol.PROTECT_AFTER), 'the guide says the same line');
  console.log('PASS CAT-2 tools: the guide names ' + named.length + ' real tools; the File protection line is shared');
});

test('CAT-2 pace: the Usage page, plan_usage and the history table\'s CHECK use one paceOf and one word list', async () => {
  assert.equal(typeof protocol.paceOf, 'function', 'packages/protocol has paceOf');
  assert.equal(helpers.paceOf, protocol.paceOf, 'the Usage page uses it');
  const now = Date.UTC(2026, 10, 24, 12), w = (used, minsLeft, windowMins = 300) => ({ usedPercent: used, resetsAt: now + minsLeft * 60000, windowMins });
  for (const x of [w(80, 60), w(86, 60), w(74, 60), w(50, 0), { usedPercent: 3 }, null])
    assert.equal(limits.paceState(x, now), protocol.paceOf(x, 0, now)?.state ?? null, 'plan_usage uses it: ' + JSON.stringify(x));
  assert.deepEqual([w(86, 60), w(80, 60), w(74, 60)].map((x) => protocol.paceOf(x, 0, now).state), protocol.PACE_STATES, 'its words are PACE_STATES');
  const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-cat2-')), 'usage-limits.db');
  const history = startUsageHistory({ file, read: async () => ({ third: { fiveHour: w(40, 180), asOf: now - 60000, stale: false } }), everyMs: 0, now: () => now });
  await history.tick(); history.close();
  const db = new DatabaseSync(file, { readOnly: true }), sql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'limits'").get().sql; db.close();
  assert.ok(sql.includes(`pace IN (${protocol.PACE_STATES.map((p) => `'${p}'`).join(', ')})`), 'the CHECK lists PACE_STATES: ' + sql);
  console.log('PASS CAT-2 pace: one paceOf and one word list, in the page, the tool and the table');
});

test('CAT-2 settings: the window starts from the desktop\'s DEFAULT_SETTINGS, passed over the preload, and keeps no copy', async () => {
  // The preload as Electron runs it, with main.mjs's argument: its defaults are that JSON.
  const defaults = { zoom: 1, xfer: { fileMiB: 9, files: 8, sendGiB: 7 } };
  let exposed = null;
  const electron = { contextBridge: { exposeInMainWorld: (_name, api) => { exposed = api; } }, ipcRenderer: { sendSync: () => null, invoke() {}, on() {}, send() {} }, webUtils: {} };
  const source = await readFile(path.join(root, 'apps/desktop/preload.cjs'), 'utf8');
  vm.runInNewContext(source, { require: (m) => m === 'electron' ? electron : {}, process: { argv: ['electron', '--p9-defaults=' + JSON.stringify(defaults)], platform: 'linux', env: {} }, console });
  assert.equal(JSON.stringify(exposed?.defaults), JSON.stringify(defaults), 'the preload hands the window main\'s defaults'); // its own realm's objects
  const main = await readFile(path.join(root, 'apps/desktop/main.mjs'), 'utf8'), controller = await readFile(path.join(root, 'apps/web/src/controller.mjs'), 'utf8');
  assert.match(main, /'--p9-defaults=' \+ JSON\.stringify\(DEFAULT_SETTINGS\)/, 'main.mjs passes DEFAULT_SETTINGS');
  assert.match(controller, /let settings = structuredClone\(window\.p9\.defaults\)/, 'the window starts from them');
  assert.doesNotMatch(controller, /fileMiB: \d/, 'and keeps no copy of the Send files limits');
  console.log('PASS CAT-2 settings: the window\'s first settings are main.mjs DEFAULT_SETTINGS, over the preload');
});

// Review 12: the agents' modes are never empty on the desktop (its own catalog over the preload until GET /agents answers),
// and where they can be empty (the phone before GET /agents, an older server listing none) Unrestricted cannot be turned on.
test('CAT-2 review 12: the desktop starts from its own catalog over the preload; with no loosest mode known Unrestricted is locked on both pages', async () => {
  const agents = publicAgents().agents;
  let exposed = null;
  const electron = { contextBridge: { exposeInMainWorld: (_name, api) => { exposed = api; } }, ipcRenderer: { sendSync: (channel) => channel === 'p9:agents' ? { agents, local: true } : null, invoke() {}, on() {}, send() {} }, webUtils: {} };
  const preload = await readFile(path.join(root, 'apps/desktop/preload.cjs'), 'utf8');
  vm.runInNewContext(preload, { require: (m) => m === 'electron' ? electron : {}, process: { argv: ['electron'], platform: 'linux', env: {} }, console });
  assert.equal(JSON.stringify(exposed?.agents), JSON.stringify({ agents, local: true }), 'the preload hands the window main\'s catalog');
  const [main, controller, settings, phone] = await Promise.all(['apps/desktop/main.mjs', 'apps/web/src/controller.mjs', 'apps/web/src/settings-view.mjs', 'apps/web/src/phone.ts'].map((f) => readFile(path.join(root, f), 'utf8')));
  assert.match(main, /ipcMain\.on\('p9:agents', event => \{ event\.returnValue = event\.sender === window\.webContents \? \{ agents: publicAgents\(\)\.agents, local: !serverHost \} : \{ agents: \[\], local: false \}; \}\);/, 'main.mjs answers with publicAgents(), and whether the daemon in use is this computer\'s');
  assert.match(controller, /\nfillAgents\(sampleView \? M\.agents : window\.p9\?\.agents\?\.agents \?\? \[\], sampleView \|\| window\.p9\?\.agents\?\.local === true\);/, 'the window takes it as it starts, as its daemon\'s own only when local');
  // Unrestricted needs a loosest mode to switch to: none known locks it, whatever the lock and File protection say.
  security.fillAgents([]);
  assert.equal(security.freeLocked(false, true), true, 'no catalog: locked');
  security.fillAgents([{ id: 'claude', name: 'Claude' }]);
  assert.equal(security.freeLocked(false, true), true, 'an older server listing no modes: locked');
  security.fillAgents(agents);
  assert.deepEqual([security.freeLocked(false, true), security.freeLocked(null, true), security.freeLocked(false, null)], [false, true, true], 'the catalog read: only an unknown lock or protection locks it');
  // Both pages draw the switch with it and check it again before changing anything.
  assert.match(settings, /box\('setFree', [^\n]*, freeLocked\(outer\.agentLock, outer\.fileProtect\), /, 'desktop: the switch is disabled by freeLocked');
  assert.match(settings, /async function setUnrestricted\(on\) \{\n(  \/\/[^\n]*\n)*  if \(on && freeLocked\(outer\.agentLock, outer\.fileProtect\)\) return renderSettings\(\);/, 'desktop: and refuses before any change');
  assert.match(phone, /toggle\('setFree', [^\n]*, freeLocked\(lock, protect\)\)/, 'phone: the switch is disabled by freeLocked');
  assert.match(phone, /async function setFree\(on: boolean\) \{\n  if \(on && freeLocked\(sec\.lock, sec\.protect\)\) return drawSettings\(\);/, 'phone: and refuses before any change');
  console.log('PASS CAT-2 review 12: the desktop has its catalog from the start; Unrestricted is locked with no loosest mode, on both pages');
});

// Review 13: a desktop on a remote starts from this computer's catalog, which only fills the pickers: Unrestricted and the
// warnings wait for the remote's own GET /agents, and both pages check again before they commit. Replay keeps the daemon's mode.
test('CAT-2 review 13: only the daemon in use\'s catalog unlocks Unrestricted and the warnings; both pages check again before committing; replay keeps a mode the catalog does not know', async (t) => {
  const agents = publicAgents().agents, kept = new Map();
  globalThis.localStorage = { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, String(v)), removeItem: (k) => kept.delete(k) };
  t.after(() => { delete globalThis.localStorage; });
  security.fillAgents(agents, false);
  assert.deepEqual([security.modesKnown(), security.freeLocked(false, true), security.unrestricted(false, false, 'k:')], [false, true, false], 'this computer\'s catalog on a remote: locked, reads off');
  assert.ok(helpers.modes.claude.length, 'it still fills the pickers');
  security.fillAgents(agents);
  assert.deepEqual([security.modesKnown(), security.freeLocked(false, true)], [true, false], 'the daemon in use answered: unlocked');
  const [settings, phone, chat] = await Promise.all(['apps/web/src/settings-view.mjs', 'apps/web/src/phone.ts', 'apps/web/src/chat-view.mjs'].map((f) => readFile(path.join(root, f), 'utf8')));
  // The warning switch is disabled by the same test as Unrestricted, on both pages.
  assert.match(settings, /box\('setWarn', warn\[0\], warnsLoose\(\), modesKnown\(\) \? warn\[1\] : modesNote\(\), !modesKnown\(\),/, 'desktop: the warnings wait for the modes');
  assert.match(phone, /toggle\('setWarn', [^\n]*, warnsLoose\(\), !modesKnown\(\)\)/, 'phone: the warnings wait for the modes');
  // Checked again after the daemon's writes, before this device's part (review 14: in security.mjs changeFree, on both pages).
  assert.match(settings, /await changeFree\(on, [^\n]*\n(  [^\n]*\n)*  if \(!ok\) return renderSettings\(\);\n  setWarnsLoose\(!on\); setStarts\(on, START\);/, 'desktop: checked again before committing');
  assert.match(phone, /await changeFree\(on, [^\n]*\n(  [^\n]*\n)*  if \(!ok\) return drawSettings\(note\);\n  setWarnsLoose\(!on\); setStarts\(on, START\);/, 'phone: checked again before committing');
  // The phone's Settings does not wait on GET /agents.
  assert.doesNotMatch(phone.slice(phone.indexOf('async function openSettings'), phone.indexOf('const toggle =')), /Promise\.all\([^\n]*loadAgents\(\)/, 'phone: the sheet draws without the catalog');
  // Replay takes the daemon's mode as given; the catalog filters only the menu.
  const line = chat.split('\n').find((l) => l.includes("case 'mode':"));
  assert.ok(line && !/modes\[/.test(line), 'replay keeps a mode the catalog does not know yet');
  console.log('PASS CAT-2 review 13: the catalog unlocks only from the daemon in use; both pages recheck; replay keeps the daemon\'s mode');
});

// Review 14: Unrestricted is two daemon writes (File protection, then the agent lock), changed as one: a refusal, or the modes
// gone once both are written, puts back every setting it changed and names any it could not. A chat never sends a mode the
// catalog in use does not list; Settings open redraws when the catalog lands and says "unavailable" when it has no loosest mode.
test('CAT-2 review 14: Unrestricted changes both daemon settings or neither, and says which it could not put back; a retired mode is never sent; Settings follows the catalog', async (t) => {
  const agents = publicAgents().agents, kept = new Map();
  globalThis.localStorage = { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, String(v)), removeItem: (k) => kept.delete(k) };
  t.after(() => { delete globalThis.localStorage; });
  security.fillAgents(agents);
  const daemon = (lock, protect, answer = () => null) => { const d = { lock, protect, calls: [], rev: { lock: 'l0', protect: 'p0' }, n: 0 };
    d.set = (key, want) => { d[key] = want; d.rev[key] = key + ++d.n; };
    d.read = async (key) => ({ on: d[key], rev: d.rev[key] });
    d.write = async (key, want, rev) => { d.calls.push(key + ':' + want); const r = answer(key, want, d); if (r) return r;
      if (rev === undefined || rev === d.rev[key]) d.set(key, want); return d.read(key); }; return d; };
  const start = { lock: true, protect: true };
  // Both writes go through: on.
  let d = daemon(true, true), r = await security.changeFree(true, start, d.write, d.read);
  assert.deepEqual([r.ok, r.state, r.note, d.calls], [true, { lock: false, protect: false }, '', ['protect:false', 'lock:false']], 'both off, in order');
  // The lock refused after protection went off: protection goes back on, nothing is reported as changed.
  d = daemon(true, true, (key) => key === 'lock' ? { error: 'refused' } : null);
  r = await security.changeFree(true, start, d.write, d.read);
  assert.deepEqual([r.ok, r.state, d.protect, d.calls], [false, { lock: true, protect: true }, true, ['protect:false', 'lock:false', 'protect:true']], 'lock refused: protection put back');
  assert.match(r.note, /^Not changed: refused\.$/);
  // "Keep protection on" (200, still on): nothing else is written.
  d = daemon(true, true, (key) => key === 'protect' ? { on: true } : null);
  r = await security.changeFree(true, start, d.write, d.read);
  assert.deepEqual([r.ok, r.state, r.note, d.calls], [false, start, '', ['protect:false']], 'kept on: no further write, no note');
  // The modes go while the writes run (a daemon whose catalog has no loosest mode): both go back, newest first.
  d = daemon(true, true, (key) => { if (key === 'lock') security.fillAgents([]); return null; });
  r = await security.changeFree(true, start, d.write, d.read);
  assert.deepEqual([r.ok, r.state, d.lock, d.protect, d.calls], [false, start, true, true, ['protect:false', 'lock:false', 'lock:true', 'protect:true']], 'modes gone: both put back');
  assert.match(r.note, /modes changed meanwhile/);
  // A put-back that fails is named.
  security.fillAgents(agents);
  d = daemon(true, true, (key, want) => { if (key === 'lock' && want === false) security.fillAgents([]); return key === 'lock' && want === true ? { error: 'down' } : null; });
  r = await security.changeFree(true, start, d.write, d.read);
  assert.deepEqual([r.ok, r.state], [false, { lock: false, protect: true }], 'the lock could not go back: shown as it is');
  assert.match(r.note, /Could not put back Agent lock: set it again above\./i);
  // Off turns protection back on only; the lock stays off.
  security.fillAgents(agents);
  d = daemon(false, false); r = await security.changeFree(false, { lock: false, protect: false }, d.write, d.read);
  assert.deepEqual([r.ok, d.calls], [true, ['protect:true']], 'off: protection only');
  // "Unavailable" once the daemon's catalog came back with no loosest mode; "waiting" before.
  security.fillAgents([{ id: 'claude', name: 'Claude', modes: [{ name: 'Default' }] }]);
  assert.equal(security.modesNote(), security.SECURITY.noLoose, 'the catalog read, nothing loose: unavailable');
  security.fillAgents(agents, false);
  assert.equal(security.modesNote(), security.SECURITY.noModes, 'not the daemon\'s own yet: waiting');
  security.fillAgents(agents);
  const [controller, chat, settings] = await Promise.all(['apps/web/src/controller.mjs', 'apps/web/src/chat-view.mjs', 'apps/web/src/settings-view.mjs'].map((f) => readFile(path.join(root, f), 'utf8')));
  assert.match(controller, /body = \{ id: s\.id, text, mode: sentMode\(s\.agent, n\.mode\),/, 'a chat sends its mode through sentMode');
  assert.match(chat, /  fillAgents\(agents\); if \(outer\.\$\('#setDlg'\)\?\.open\) outer\.refreshDefaults\(\);/, 'the catalog landing redraws Settings open');
  assert.match(settings, /if \(outer\.\$\('#setSecurity'\) && !outer\.\$\('#setBody'\)\.contains\(document\.activeElement\)\) return renderSettings\(\);/, 'and the redraw covers the security rows');
  console.log('PASS CAT-2 review 14: both settings or neither, failed put-backs named; only catalog modes sent; Settings follows the catalog');
});

// O267b: a write whose reply was lost may have been made: changeFree reads the setting back before it counts it as unchanged.
// A put-back carries the rev of the change it undoes, so a newer change from another device stays (both the daemon's routes
// keep a rev for this: a boolean cannot tell a newer change of the same value from ours). Settings open with focus inside
// patches the security rows in place when the catalog lands, instead of skipping them.
test('O267b: Unrestricted reads a write back when its reply is lost, and a put-back never overwrites a newer change', async (t) => {
  const agents = publicAgents().agents, kept = new Map();
  globalThis.localStorage = { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, String(v)), removeItem: (k) => kept.delete(k) };
  t.after(() => { delete globalThis.localStorage; });
  security.fillAgents(agents);
  const daemon = (answer) => { const d = { lock: true, protect: true, calls: [], rev: { lock: 'l0', protect: 'p0' }, n: 0, readable: true };
    d.set = (key, want) => { d[key] = want; d.rev[key] = key + ++d.n; };
    d.read = async (key) => d.readable ? { on: d[key], rev: d.rev[key] } : {};
    d.write = async (key, want, rev) => { d.calls.push(key + ':' + want); const r = await answer(key, want, d, rev); if (r) return r;
      if (rev === undefined || rev === d.rev[key]) d.set(key, want); return d.read(key); }; return d; };
  const start = { lock: true, protect: true };
  // The protection write was made but its reply lost; then the lock is refused: protection is read back as off, so it is put back.
  let d = daemon((key, want, d) => { if (key === 'protect' && !want) { d.set('protect', false); return {}; } return key === 'lock' ? { error: 'refused' } : null; });
  let r = await security.changeFree(true, start, d.write, d.read);
  assert.deepEqual([r.ok, r.state, d.protect, d.calls, r.note], [false, start, true, ['protect:false', 'lock:false', 'protect:true'], 'Not changed: refused.'], 'lost reply: read back, put back');
  // The reply and the read both lost: the setting shows unknown, never the old value, and nothing more is written.
  d = daemon((key, want, d) => { if (key === 'protect') { d.set('protect', false); d.readable = false; return {}; } return null; });
  r = await security.changeFree(true, start, d.write, d.read);
  assert.deepEqual([r.ok, r.state, d.calls], [false, { lock: true, protect: null }, ['protect:false']], 'not known: unknown');
  assert.match(r.note, /did not say whether File protection changed/);
  // Another device turns protection off again (the same value, a newer change) while the lock is refused: the put-back leaves it.
  d = daemon((key, want, d) => { if (key === 'lock') { d.set('protect', false); return { error: 'refused' }; } return null; });
  r = await security.changeFree(true, start, d.write, d.read);
  assert.deepEqual([r.ok, r.state, d.protect, d.calls], [false, { lock: true, protect: false }, false, ['protect:false', 'lock:false', 'protect:true']], 'a newer change stays');
  assert.match(r.note, /Could not put back File protection/);
  const settings = await readFile(path.join(root, 'apps/web/src/settings-view.mjs'), 'utf8');
  assert.match(settings, /fresh\.innerHTML = securityGroup\(box\);/, 'focus inside Settings: the security rows are drawn fresh off screen');
  assert.match(settings, /o\.checked = n\.checked; o\.disabled = n\.disabled;/, 'and patched in place, so the focused row keeps its focus');
  console.log('PASS O267b: lost replies read back; put-backs keep a newer change; Settings rows follow the catalog with focus inside');
});

// Review 15: the outgoing mode is checked only against the catalog of the daemon in use. Before a remote's GET /agents
// answers, the pick goes as is (as before CAT-2): this computer's catalog may lack a mode only the remote has.
test('CAT-2 review 15: a retired mode is left out only once the daemon in use listed its modes; before that the pick goes as is', () => {
  const agents = publicAgents().agents;
  security.fillAgents(agents, false);
  assert.equal(security.sentMode('claude', 'Remote only'), 'Remote only', 'provisional catalog: a mode it does not list still goes');
  assert.equal(security.sentMode('claude', ''), undefined, 'no pick: none sent');
  security.fillAgents(agents);
  assert.equal(security.sentMode('claude', 'Remote only'), undefined, 'the daemon\'s own catalog: a mode it does not list is left out');
  assert.equal(security.sentMode('claude', agents.find((a) => a.id === 'claude').modes[0].name), agents.find((a) => a.id === 'claude').modes[0].name, 'a listed mode goes');
  console.log('PASS CAT-2 review 15: the outgoing mode is judged only by the daemon in use\'s catalog');
});
