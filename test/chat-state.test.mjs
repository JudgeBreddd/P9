// O123 (Builder, 2026-11-15): "Remove them all together from the top and use the chat bar on the left to indicate a working
// chat with a spinning ring. Green circle is idle. Red hand is blocked." Real Electron, the real daemon and the fake agent
// ("slow" works until cancelled, "permission" waits on the user). Also: no pet sheet loads at startup while pets are off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, http, authenticated, root, versionSeen } from './helpers.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((result) => JSON.parse(result.text));
const look = (on, roles = {}) => ({ on, size: 48, claude: null, codex: null, system: null, top: null, pane: null, ...roles });
// A profile with the bundled pet installed and the given pet settings.
async function profileWith(name, pet) {
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-' + name + '-')), 'profile');
  await mkdir(path.join(profile, 'pets'), { recursive: true });
  await cp(path.join(root, 'apps/desktop/pets/skipper'), path.join(profile, 'pets', 'skipper'), { recursive: true });
  await writeFile(path.join(profile, 'p9-settings.json'), JSON.stringify({ zoom: 1, closeOnSend: false, focus: { chat: true, dev: true, mission: true }, pet }));
  await versionSeen(profile);
  return profile;
}
async function launch(t, instance, profile) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#rChat').waitFor();
  return { app, page };
}
const shot = async (locator, name) => { if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + (await locator.screenshot({ type: 'png' })).toString('base64')); };

test('Chat state: each row shows a spinning ring while working, a green circle when idle, a red hand when waiting; no top-bar pet', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  // Pets on in Chat with a Claude pet: before O123 a waiting agent's pet took the top bar's place.
  const profile = await profileWith('chat-state', { chat: look(true, { claude: 'skipper' }), dev: look(false), mission: look(false) });
  const chat = async (text) => { const id = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation; await call(instance, `/chat/${id}/prompt`, 'POST', { text }); return id; };
  const idle = await chat('hello'), working = await chat('slow'), waiting = await chat('permission');
  const { page } = await launch(t, instance, profile);
  const row = (id) => page.locator(`#navList .row[data-chat="${id}"]`);
  await row(idle).and(page.locator('[data-s="running"]')).locator('.mk-run:not([data-busy])').waitFor({ timeout: 15000 });
  await row(working).locator('.mk-run[data-busy]').waitFor({ timeout: 15000 });
  await row(waiting).locator('.mk-needs svg').waitFor({ timeout: 15000 });

  // Each mark as drawn: the theme's colours resolved in the panel, so the check holds in every theme.
  const marks = await page.evaluate((ids) => {
    const panel = document.querySelector('#navList'), probe = document.createElement('i');
    panel.append(probe);
    const resolve = (v) => { probe.style.color = `var(${v})`; return getComputedStyle(probe).color; };
    const colours = { ok: resolve('--ok'), destructive: resolve('--destructive'), warn: resolve('--warn') };
    probe.remove();
    const mk = (id) => document.querySelector(`#navList .row[data-chat="${id}"] .mk`);
    const pseudo = (el, which) => { const s = getComputedStyle(el, which); return { content: s.content, bg: s.backgroundColor, w: s.width, h: s.height, radius: s.borderRadius, top: s.borderTopColor, right: s.borderRightColor, topWidth: s.borderTopWidth }; };
    const spin = (el) => document.getAnimations().filter((a) => a.effect?.target === el).map((a) => ({ pseudo: a.effect.pseudoElement, transforms: a.effect.getKeyframes().map((k) => k.transform).filter(Boolean), running: a.playState === 'running' }));
    return { colours, idle: { before: pseudo(mk(ids.idle), '::before'), after: pseudo(mk(ids.idle), '::after'), anims: spin(mk(ids.idle)) },
      working: { before: pseudo(mk(ids.working), '::before'), after: pseudo(mk(ids.working), '::after'), anims: spin(mk(ids.working)) },
      waiting: { colour: getComputedStyle(mk(ids.waiting)).color, hand: !!mk(ids.waiting).querySelector('svg') } };
  }, { idle, working, waiting });
  const info = JSON.stringify(marks);
  // Idle: a filled green circle, standing still.
  assert.equal(marks.idle.before.bg, marks.colours.ok, 'idle: filled with the theme green ' + info);
  assert.ok(marks.idle.before.w === marks.idle.before.h && marks.idle.before.radius === '50%', 'idle: a circle ' + info);
  assert.equal(marks.idle.anims.length, 0, 'idle: nothing moves ' + info);
  // Working: a green ring with a gap, turning without end.
  const ring = [marks.working.before, marks.working.after].find((p) => p.content !== 'none' && p.topWidth !== '0px');
  assert.ok(ring && ring.radius === '50%' && ring.top === marks.colours.ok && ring.right === 'rgba(0, 0, 0, 0)', 'working: an open green ring ' + info);
  assert.ok(marks.working.anims.some((a) => a.running && a.transforms.some((x) => /rotate|matrix/.test(x))), 'working: the ring spins ' + info);
  assert.ok(![marks.working.before, marks.working.after].some((p) => p.content !== 'none' && p.bg === marks.colours.ok), 'working: no filled dot beside the ring ' + info);
  // Waiting: the hand, in the theme red.
  assert.equal(marks.waiting.hand, true, info);
  assert.equal(marks.waiting.colour, marks.colours.destructive, 'waiting: red hand ' + info);
  assert.notEqual(marks.colours.destructive, marks.colours.warn, info);

  // The top bar keeps the spinner and its words, and shows no pet (two agents active, one waiting).
  await page.locator('#agentInd[data-state="waiting"]').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('#agentInd canvas, #indPets').count(), 0, 'no top-bar pet');
  assert.equal(await page.locator('#indGlyph').isVisible(), true);
  assert.equal(await page.locator('#indText').innerText(), 'An agent waits on you');

  await page.mouse.move(0, 0);
  await shot(row(working), 'row-working'); await shot(row(idle), 'row-idle'); await shot(row(waiting), 'row-waiting');
  await shot(page.locator('#nav'), 'chat-bar-states'); await shot(page.locator('.topbar'), 'top-bar');
});

test('Chat state: pets off in every focus mode loads no pet sheet at startup; turning them on loads them', { timeout: 90000 }, async (t) => {
  const instance = await daemon(t);
  const profile = await profileWith('pets-off', { chat: look(false, { system: 'skipper' }), dev: look(false, { system: 'skipper' }), mission: look(false, { system: 'skipper' }) });
  const { app, page } = await launch(t, instance, profile);
  // Count the sheet loads (one argument: a pet's folder name; none lists the pets), then start the window again.
  await app.evaluate(({ ipcMain }) => {
    const h = ipcMain._invokeHandlers.get('p9:pets'); ipcMain.removeHandler('p9:pets');
    globalThis.sheets = [];
    ipcMain.handle('p9:pets', (e, ...args) => { if (args.length) globalThis.sheets.push(args[0]); return h(e, ...args); });
  });
  await page.reload();
  await page.locator('#rChat').waitFor();
  for (const focus of ['Control+2', 'Control+3', 'Control+1']) { await page.keyboard.press(focus); await page.waitForTimeout(1000); }
  assert.deepEqual(await app.evaluate(() => globalThis.sheets), [], 'no sheet loaded with pets off');
  // The counter is live: with pets on in Chat (Settings opened only through its file, as its thumbnails load every sheet),
  // the same startup loads the sheet.
  await page.evaluate(async () => { const s = await window.p9.getSettings(); await window.p9.setSettings({ ...s, pet: { ...s.pet, chat: { ...s.pet.chat, on: true } } }); });
  await page.reload();
  await page.locator('#rChat').waitFor();
  for (let i = 0; i < 50 && !(await app.evaluate(() => globalThis.sheets.length)); i++) await page.waitForTimeout(200);
  assert.ok((await app.evaluate(() => globalThis.sheets)).includes('skipper'), 'pets on: the sheet loads');
});
