// The chat composer and chat pane (v0.1.5 part 2, chunk C). Real Electron, the real daemon and the fake agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { deflateSync, crc32 } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from '@playwright/test';
import { daemon, http, authenticated, root, watchStartup, waitStartup } from './helpers.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((result) => ({ status: result.status, ...JSON.parse(result.text) }));
const events = async (instance, id) => {
  const all = [];
  for (let after = 0, page; (page = await call(instance, '/chat/events?after=' + after + '&only=' + id)).events.length; after = page.cursor) all.push(...page.events);
  return all;
};
const said = async (instance, id, type) => (await events(instance, id)).filter((e) => e.type === type);
const until = async (check, what, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 200))) if (await check()) return;
  assert.fail('timed out: ' + what);
};

// One chat with the given agent, answered "hello" once, and a window on it.
async function setup(t, name, { provider = 'claude', files = [], env: extra = {} } = {}) {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  for (const file of files) await writeFile(path.join(instance.workspace, file), '');
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-' + name + '-')), 'profile');
  const env = { ...process.env, ...extra }; delete env.ELECTRON_RUN_AS_NODE;
  const id = (await call(instance, '/chat', 'POST', { provider })).conversation;
  await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'hello' });
  const agentSaid = async (text) => (await said(instance, id, 'update')).some((e) => e.data.content?.text === text);
  await until(() => agentSaid('echo:hello'), 'hello answered');
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow(), watch = watchStartup(page);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  // O71: timed out on CI 3 times (11-20, 11-21), the O58 (l) shape; a timeout prints the page's stage.
  await waitStartup(page, watch, page.locator('#navList .rowwrap[data-live] .row[data-chat="' + id + '"]'), { what: name + ' row live', chat: id, timeout: 15000 });
  await page.locator('#nav .row[data-chat="' + id + '"]').click();
  const pane = page.locator('.pane[data-id="' + id + '"]');
  const type = async (text) => { await pane.locator('.composer textarea').click(); await page.keyboard.type(text); };
  const send = async (text) => { await type(text); await page.keyboard.press('Enter'); };
  return { app, instance, id, page, pane, type, send, agentSaid, errors };
}

test('CP9: answering a question with Enter in its text box leaves the chat updating', { timeout: 90000 }, async (t) => {
  const { pane, page, send, agentSaid, errors } = await setup(t, 'cp9');
  await send('ask-text');
  const box = pane.locator('[data-question] input[name="f0"]');
  await box.waitFor({ timeout: 15000 });
  // Focus stays in the box as the answer goes; the window then repaints with the question gone.
  await box.click(); await page.keyboard.type('Saturn'); await page.keyboard.press('Enter');
  await until(() => agentSaid('ask:{"action":"accept","content":{"name":"Saturn"}}'), 'the answer reached the agent');
  await until(async () => (await pane.locator('[data-question]').count()) === 0, 'the question card went');
  // The next turn still shows: before the fix the throw ended the window's event loop, so nothing after it did.
  await send('after');
  await pane.locator('.hist', { hasText: 'echo:after' }).waitFor({ timeout: 15000 });
  assert.deepEqual(errors.filter((e) => /reading 'focus'/.test(e)), []);
  console.log('PASS CP9: Enter in a question\'s text box answered it, the chat kept updating and nothing threw');
});

// CP1 and CP8, both agents. The fake's tool calls take 10 s here (slow-tools), so a message sent during one is held.
const steers = (instance) => readFile(path.join(instance.workspace, 'steers.log'), 'utf8').catch(() => '');
const started = (instance, id, tool) => until(async () => (await said(instance, id, 'update')).some((e) => e.data.toolCallId === tool), tool + ' started');
const users = async (instance, id) => (await said(instance, id, 'user')).map((e) => e.data.text);
for (const provider of ['claude', 'codex']) {
  test('CP1 ' + provider + ': Enter during a tool call holds the message, and it goes into the turn once, when that call ends', { timeout: 120000 }, async (t) => {
    const { instance, id, pane, send, agentSaid } = await setup(t, 'cp1-steer-' + provider, { provider, files: ['slow-tools'] });
    await send('tools 1');
    await started(instance, id, 'tool-1');
    await pane.locator('[data-when="steer"]').waitFor({ timeout: 5000 }); // the chip shows while the agent works
    await send('mid');
    await pane.locator('.queue [data-held]', { hasText: 'After this step: mid' }).waitFor({ timeout: 5000 });
    await until(() => agentSaid('got:mid'), 'mid reached the agent', 20000);
    await until(() => agentSaid('tools done'), 'the turn went on', 10000);
    const all = await events(instance, id), at = (f) => all.findIndex(f);
    const held = at((e) => e.type === 'held'), done = at((e) => e.data.toolCallId === 'tool-1' && e.data.status === 'completed'), user = at((e) => e.type === 'user' && e.data.text === 'mid');
    assert.ok(held >= 0 && held < done && done < user, 'held while the tool call ran, steered after it ended');
    assert.deepEqual([all[user].data.steered, all[user].data.held, all[held].data.when], [true, [all[held].data.id], 'steer']);
    assert.equal(await steers(instance), 'mid\n', 'exactly one steer');
    await pane.locator('.queue [data-held]').first().waitFor({ state: 'detached', timeout: 5000 }); // the window drops it on its next poll
    console.log('PASS CP1 ' + provider + ': a message sent during a tool call waited for it to end, then went into the turn once');
  });

  test('CP1 ' + provider + ': when the turn ends first, a held message and a queued one (Tab) go as the next prompt; nothing is steered', { timeout: 120000 }, async (t) => {
    const { instance, id, pane, page, type, send, agentSaid } = await setup(t, 'cp1-end-' + provider, { provider, files: ['slow-tools'] });
    await send('tool-open');
    await started(instance, id, 'tool-1');
    await send('mid');
    await type('later'); await page.keyboard.press('Tab');
    await pane.locator('.queue [data-held]', { hasText: 'Queued: later' }).waitFor({ timeout: 5000 });
    assert.deepEqual(await pane.locator('.queue [data-held] span').allInnerTexts(), ['After this step: mid', 'Queued: later']);
    await until(() => agentSaid('echo:mid\n\nlater'), 'both went as one prompt after the turn', 25000);
    await pane.locator('.queue [data-held]').first().waitFor({ state: 'detached', timeout: 5000 }); // the window drops them on its next poll
    assert.deepEqual([await users(instance, id), await steers(instance), await pane.locator('.queue [data-held]').count()], [['hello', 'tool-open', 'mid\n\nlater'], '', 0]);
    console.log('PASS CP1 ' + provider + ': the turn ended with its tool call open; the held and the queued message went as one prompt, held first, no steer');
  });

  test('CP8 ' + provider + ': a message held past the turn\'s last step still lands, and the chat stops showing working', { timeout: 120000 }, async (t) => {
    const { instance, id, pane, send, agentSaid } = await setup(t, 'cp8-' + provider, { provider, files: ['slow-tools'] });
    await send('tool-last');
    await started(instance, id, 'tool-1');
    await send('mid');
    await pane.locator('.queue [data-held]', { hasText: 'mid' }).waitFor({ timeout: 5000 });
    // The steer reaches the agent just after its turn ended. Claude refuses it (promptRequired), so it goes as a prompt;
    // Codex takes it into a turn of its own that reports no end, which P9 takes as ended after 10 s of quiet.
    if (provider === 'codex') {
      await until(() => agentSaid('got:mid'), 'Codex took mid into a turn of its own', 20000);
      await until(async () => (await said(instance, id, 'turn-end')).some((e) => e.data.unprompted), 'that turn ended after 10 s of quiet', 20000);
    } else await until(() => agentSaid('echo:mid'), 'refused as a steer, mid went as the next prompt', 20000);
    await until(async () => (await pane.locator('.working').count()) === 0, 'the chat no longer shows working', 15000);
    await pane.locator('.queue [data-held]').first().waitFor({ state: 'detached', timeout: 5000 }); // the window drops it on its next poll
    console.log('PASS CP8 ' + provider + ': a steer that crossed the turn\'s end landed and the chat went idle');
  });

  test('CP1 ' + provider + ': the x takes a held message back into the box; Esc cancels the turn and gives back the rest', { timeout: 120000 }, async (t) => {
    const { instance, id, pane, page, send } = await setup(t, 'cp1-back-' + provider, { provider, files: ['slow-tools'] });
    const box = pane.locator('.composer textarea'), rows = pane.locator('.queue [data-held]');
    await send('tools 1');
    await started(instance, id, 'tool-1');
    await send('one'); await send('two');
    await until(async () => (await rows.count()) === 2, 'both held', 5000);
    await rows.filter({ hasText: 'one' }).locator('[data-unhold]:not([data-now])').click();
    await until(async () => (await box.inputValue()) === 'one', 'one back in the box', 5000);
    await box.click(); await page.keyboard.press('Escape');
    await until(async () => (await box.inputValue()) === 'two\none', 'two back in the box after the cancel', 10000);
    assert.deepEqual([await users(instance, id), await steers(instance), await rows.count(), (await said(instance, id, 'turn-end')).at(-1).data.stopReason],
      [['hello', 'tools 1'], '', 0, 'cancelled']);
    console.log('PASS CP1 ' + provider + ': the x and Esc each put the held text back in the box and sent nothing');
  });
}

// CP7: Codex's turn of its own (CP8) is one the daemon has no handle on, so a cancel answers 409 no-turn. Claude's
// unprompted work keeps sending updates, and each shows it working again, so Codex's is the case to prove.
test('CP7: Esc on a turn the daemon has no handle on leaves the chat idle, with no error', { timeout: 120000 }, async (t) => {
  const { instance, id, page, pane, send, agentSaid } = await setup(t, 'cp7', { provider: 'codex', files: ['slow-tools'] });
  await send('tool-last');
  await started(instance, id, 'tool-1');
  await send('mid');
  await until(() => agentSaid('got:mid'), 'Codex took mid into a turn of its own', 20000);
  await pane.locator('.working').waitFor({ timeout: 5000 });
  await pane.locator('.composer textarea').click(); await page.keyboard.press('Escape');
  await until(async () => (await pane.locator('.working').count()) === 0, 'idle well before the 10 s quiet', 4000);
  assert.equal(await page.locator('.toast', { hasText: 'no-turn' }).count(), 0);
  console.log('PASS CP7: Esc with no daemon turn left the chat idle and showed no error');
});

// O-702 (desktop said Steer and Queue, the phone Steer and Interrupt): the desktop chip shows the
// phone card's three words in its order, each with the phone's title, and its Interrupt stops the turn and sends the text
// as the next prompt, as Ctrl Enter does. The phone card is read from phone.astro, so a word changed on one screen fails here.
test('CP11: the chip shows Steer, Queue, Interrupt as the phone does; Interrupt stops the turn and sends', { timeout: 120000 }, async (t) => {
  const { instance, id, pane, type, agentSaid } = await setup(t, 'cp11', { files: ['slow-tools'] });
  const card = (await readFile(path.join(root, 'apps/web/src/pages/phone.astro'), 'utf8')).match(/<div id="midTurn"[^]*?<\/div>/)[0];
  const phone = [...card.matchAll(/<button [^>]*data-when="(\w+)" title="([^"]+)">(\w+)<\/button>/g)].map(([, when, title, word]) => [word, when, title]);
  await pane.locator('.composer textarea').click(); await type('tools 1'); await pane.page().keyboard.press('Enter');
  await started(instance, id, 'tool-1');
  const chip = pane.locator('.hint [data-when]');
  await chip.first().waitFor({ timeout: 5000 });
  const desktop = await chip.evaluateAll((all) => all.map((b) => [b.firstChild.textContent.trim(), b.dataset.when, b.title]));
  assert.equal(phone.length, 3, 'the phone card has three buttons');
  assert.deepEqual(desktop, phone, 'same words, order and titles on both screens');
  await type('now');
  await pane.locator('.hint [data-when="now"]').click();
  await until(() => agentSaid('echo:now'), 'Interrupt sent the text as the next prompt', 25000);
  assert.deepEqual([await users(instance, id), await steers(instance)], [['hello', 'tools 1', 'now'], '']);
  assert.ok((await said(instance, id, 'update')).every((e) => !(e.data.toolCallId === 'tool-1' && e.data.status === 'completed')), 'tool-1 never finished: the turn was stopped');
  console.log('PASS CP11: the desktop chip matched the phone card, and Interrupt stopped the turn and sent the text');
});

// O-702 review: the chip used to shrink and clip, so in a narrow pane its right end (Interrupt, Cancel) was cut off. In the
// narrowest pane P9 allows (two chats in a 760 px window, the split bar at its 280 px floor), mid-turn, every chip button
// is whole inside the pane and is what a click at its middle hits; Interrupt there stops the turn and sends.
test('CP12: at the narrowest split pane, mid-turn, Steer, Queue, Interrupt and Cancel all show whole and Interrupt works', { timeout: 150000 }, async (t) => {
  const { app, instance, id, page, pane, type, send, agentSaid } = await setup(t, 'cp12', { files: ['slow-tools'] });
  const second = (await call(instance, '/chat', 'POST', { provider: 'codex' })).conversation;
  await page.locator('#nav .row[data-chat="' + second + '"]').waitFor({ timeout: 10000 });
  // A new chat takes Chat Focus, so the first one is opened again; Split then puts it first (left) and the new one beside it.
  await page.locator('#nav .row[data-chat="' + id + '"]').click();
  await pane.locator('[data-tool=split]').click({ timeout: 10000 });
  await page.locator('#chats[data-split="true"] .pane').nth(1).waitFor({ timeout: 10000 });
  const order = await page.locator('#chats > .pane[data-id]').evaluateAll((l) => l.map((x) => x.dataset.id));
  assert.deepEqual(order, [id, second], 'Split shows the busy chat on the left');
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.unmaximize(); w.setContentSize(760, 600); });
  await page.waitForFunction(() => innerWidth <= 800, null, { timeout: 5000 });
  await page.evaluate(() => document.querySelector('#chats').style.setProperty('--split-l', '280px'));
  await send('tools 1');
  await started(instance, id, 'tool-1');
  await pane.locator('.hint [data-when="now"]').waitFor({ timeout: 5000 });
  await page.waitForTimeout(300); // one frame for the layout after the chip appears
  const fit = await pane.evaluate((p) => {
    const pr = p.getBoundingClientRect(), inside = (r) => r.width > 0 && r.left >= pr.left - 0.5 && r.right <= pr.right + 0.5 && r.top >= pr.top - 0.5 && r.bottom <= pr.bottom + 0.5;
    const hit = (b) => { const r = b.getBoundingClientRect(), at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!at && b.contains(at); };
    const buttons = [...p.querySelectorAll('.composer .hint button')].map((b) => [b.firstChild.textContent.trim(), inside(b.getBoundingClientRect()), hit(b)]);
    const send = p.querySelector('.composer .send').getBoundingClientRect();
    return { width: Math.round(pr.width), buttons, sendIn: inside(send) };
  });
  const png = await page.screenshot({ type: 'png' });
  if (process.env.P9_EVIDENCE) await writeFile(path.join(process.env.P9_EVIDENCE, 'cp12-narrow-chip.png'), png); else console.log('P9_SHOT cp12-narrow-chip ' + png.toString('base64'));
  assert.ok(fit.width <= 300, 'the pane is at the narrowest: ' + JSON.stringify(fit));
  assert.deepEqual(fit.buttons, [['Steer', true, true], ['Queue', true, true], ['Interrupt', true, true], ['Cancel', true, true]], JSON.stringify(fit));
  assert.equal(fit.sendIn, true, 'the send arrow stays in the pane');
  await type('now');
  await pane.locator('.hint [data-when="now"]').click();
  await until(() => agentSaid('echo:now'), 'Interrupt in the narrow pane sent the text as the next prompt', 25000);
  assert.deepEqual([await users(instance, id), await steers(instance)], [['hello', 'tools 1', 'now'], '']);
  console.log('PASS CP12: at ' + fit.width + ' px all four chip buttons showed whole and Interrupt stopped the turn and sent');
});

// O234: in a ~1270 px window, mid-turn, the send arrow wrapped to its own line under the pills. The chip gives way (its
// buttons wrap among themselves) so the arrow stays on the pills' row at every width; each button stays whole.
test('CP13: mid-turn, the send arrow stays on the pills row from a 1270 px window down to 800 px', { timeout: 150000 }, async (t) => {
  const { app, instance, id, page, pane, send } = await setup(t, 'cp13', { files: ['slow-tools'] });
  await send('tools 1');
  await started(instance, id, 'tool-1');
  await pane.locator('.hint [data-when="now"]').waitFor({ timeout: 5000 });
  const seen = [];
  for (const width of [1270, 1100, 960, 800]) {
    await app.evaluate(({ BrowserWindow }, w) => { const win = BrowserWindow.getAllWindows()[0]; win.unmaximize(); win.setContentSize(w, 800); }, width);
    await page.waitForFunction((w) => innerWidth === w, width, { timeout: 5000 });
    await page.waitForTimeout(300); // one frame for the layout after the resize
    seen.push(await pane.evaluate((p, w) => {
      const pr = p.getBoundingClientRect(), r = (s) => p.querySelector(s).getBoundingClientRect(), mid = (b) => b.top + b.height / 2;
      const inside = (b) => b.width > 0 && b.left >= pr.left - 0.5 && b.right <= pr.right + 0.5;
      const pill = r('.composer .bar .pill'), arrow = r('.composer .send');
      return { width: w, sameRow: Math.abs(mid(arrow) - mid(pill)) <= 1, top: [Math.round(pill.top), Math.round(arrow.top)],
        whole: [...p.querySelectorAll('.composer .hint button, .composer .send')].every((b) => inside(b.getBoundingClientRect())) };
    }, width));
    if (width === 1270 || width === 800) {
      const png = await page.screenshot({ type: 'png' });
      if (process.env.P9_EVIDENCE) await writeFile(path.join(process.env.P9_EVIDENCE, 'cp13-' + width + '.png'), png); else console.log('P9_SHOT cp13-' + width + ' ' + png.toString('base64'));
    }
  }
  assert.deepEqual(seen.map(({ width, sameRow, whole }) => ({ width, sameRow, whole })), [1270, 1100, 960, 800].map((width) => ({ width, sameRow: true, whole: true })), JSON.stringify(seen));
  console.log('PASS CP13: the send arrow stayed on the pills row and every chip button stayed whole: ' + JSON.stringify(seen));
});

// CP2, CP4, CP5: each check gathers what it saw into one object, so a failure shows every part that broke.
const height = (l) => l.evaluate((n) => n.getBoundingClientRect().height);
test('CP2: the box grows with its text to twice its height, then scrolls', { timeout: 90000 }, async (t) => {
  const { page, pane, type } = await setup(t, 'cp2');
  const box = pane.locator('.composer textarea');
  await type('one line'); const one = await height(box);
  for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+Enter');
  const five = await height(box);
  for (let i = 0; i < 8; i++) await page.keyboard.press('Shift+Enter');
  const tall = await height(box);
  assert.deepEqual({ grew: five > one, twice: Math.abs(tall - 2 * one) <= 2, scrolls: await box.evaluate((b) => b.scrollHeight > b.clientHeight) },
    { grew: true, twice: true, scrolls: true }, 'heights ' + [one, five, tall].join(', '));
  console.log('PASS CP2: the box went ' + one + ', ' + five + ', ' + tall + 'px for 1, 5 and 13 lines, then scrolled');
});

test('CP4: an edit shows as a line diff, and its long lines wrap', { timeout: 90000 }, async (t) => {
  const { pane, send, agentSaid } = await setup(t, 'cp4');
  await send('diff and code');
  await until(() => agentSaid('Run this:\n\n```sh\nnpm test\n```'), 'the reply');
  const tool = pane.locator('details.tool', { hasText: 'Edit notes.md' }), diff = tool.locator('.diff');
  await tool.locator('summary').click();
  // The one changed line, three unchanged lines either side, and the cut-off rest as one line.
  assert.deepEqual({
    rows: (await diff.locator('div').allInnerTexts()).map((r) => r.trim()),
    wraps: await height(diff.locator('.add')) > 2 * await height(diff.locator('.del')),
    sideways: await diff.evaluate((d) => d.scrollWidth > d.clientWidth),
  }, { rows: ['two', 'three', 'four', '− five', '+ FIVE' + ' long'.repeat(60), 'six', 'seven', 'eight', '⋯'], wraps: true, sideways: false });
  console.log('PASS CP4: a one-line edit showed as 9 rows (3 unchanged either side, the rest cut), its long line wrapped');
});

test('CP5: a code block in a reply has a Copy button that copies just the code', { timeout: 90000 }, async (t) => {
  const { app, pane, send, agentSaid } = await setup(t, 'cp5');
  await send('diff and code');
  await until(() => agentSaid('Run this:\n\n```sh\nnpm test\n```'), 'the reply');
  await pane.locator('.msg.agent pre').hover();
  await pane.locator('.msg.agent pre [data-copycode]').click({ timeout: 5000 });
  await until(async () => await app.evaluate(({ clipboard }) => clipboard.readText()) === 'npm test\n', 'the code on the clipboard', 5000);
  console.log('PASS CP5: Copy put the code block, and only it, on the clipboard');
});

// CP3, both agents: a photo sent with a message shows above it, from the daemon's copy, and again after a reload.
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
for (const provider of ['claude', 'codex']) {
  test('CP3 ' + provider + ': a sent photo shows as a thumbnail above its message, on the same side, and still does after a reload', { timeout: 90000 }, async (t) => {
    const { instance, id, page, pane, agentSaid } = await setup(t, 'cp3-' + provider, { provider });
    assert.equal((await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'look', images: [{ mimeType: 'image/png', data: png }] })).status, 202);
    await until(() => agentSaid('echo:look[image image/png ' + Buffer.from(png, 'base64').length + ']'), 'the agent got the photo');
    const thumb = () => pane.locator('.user-imgs + .msg.user', { hasText: 'look' }).evaluate((m) => {
      const img = m.previousElementSibling.querySelector('img');
      return { src: img.src.slice(0, 22), loaded: img.complete && img.naturalWidth === 1, width: img.getBoundingClientRect().width, offRight: Math.round(m.getBoundingClientRect().right - img.getBoundingClientRect().right) };
    });
    const want = { src: 'data:image/png;base64,', loaded: true, width: 96, offRight: 0 };
    await until(async () => (await thumb()).loaded, 'the thumbnail loaded', 10000);
    assert.deepEqual(await thumb(), want);
    await page.reload();
    await page.locator('#nav .row[data-chat="' + id + '"]').click({ timeout: 15000 });
    await until(async () => (await thumb().catch(() => ({}))).loaded, 'the thumbnail loaded again after the reload', 15000);
    assert.deepEqual(await thumb(), want);
    console.log('PASS CP3 ' + provider + ': the photo showed above its message from the daemon\'s copy, before and after a reload');
  });
}

// CP10: a chat picture opens large in a dialog of its own; a click anywhere or Esc closes it. The same render serves
// both agents, so it runs once. The picture is a 480x320 PNG (blue, a white band) so the screenshot shows it.
const bigPng = (() => {
  const w = 480, h = 320, raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.writeUInt32BE(y > 140 && y < 180 ? 0xffffffff : 0x3f7fffff, y * (w * 4 + 1) + 1 + x * 4);
  const chunk = (type, data) => { const len = Buffer.alloc(4), crc = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type), data]); len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body)); return Buffer.concat([len, body, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
})();
test('CP10: clicking a chat picture shows it large; a click anywhere or Esc closes it', { timeout: 90000 }, async (t) => {
  const { instance, id, page, pane, agentSaid } = await setup(t, 'cp10');
  assert.equal((await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'look', images: [{ mimeType: 'image/png', data: bigPng }] })).status, 202);
  await until(() => agentSaid('echo:look[image image/png ' + Buffer.from(bigPng, 'base64').length + ']'), 'the agent got the photo');
  const thumb = pane.locator('.user-imgs img[src]');
  await until(async () => await thumb.count() === 1, 'the thumbnail loaded', 10000);
  assert.equal(await thumb.evaluate((i) => getComputedStyle(i).cursor), 'zoom-in');
  const viewer = () => page.locator('#picDlg').evaluate((d) => ({ open: d.open, modal: d.matches(':modal'), same: d.firstElementChild.src === document.querySelector('.user-imgs img[src]').src,
    large: ((r) => r.width > 400 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight)(d.firstElementChild.getBoundingClientRect()),
    centred: ((r) => Math.abs(r.left + r.width / 2 - innerWidth / 2) < 2 && Math.abs(r.top + r.height / 2 - innerHeight / 2) < 2)(d.firstElementChild.getBoundingClientRect()) }));
  for (const [how, close] of [['a backdrop click', () => page.mouse.click(5, 5)], ['Esc', () => page.keyboard.press('Escape')]]) {
    await thumb.click({ timeout: 5000 });
    await until(async () => (await viewer()).open, 'the viewer opened', 5000);
    await page.locator('#picDlg').evaluate((d) => Promise.all(d.getAnimations().map((a) => a.finished)));
    assert.deepEqual(await viewer(), { open: true, modal: true, same: true, large: true, centred: true });
    if (how === 'Esc' && !process.env.GITHUB_ACTIONS) console.log('P9_SHOT cp10-viewer ' + (await page.screenshot({ type: 'png' })).toString('base64'));
    await close();
    await until(async () => !(await viewer()).open, 'the viewer closed on ' + how, 5000);
  }
  console.log('PASS CP10: the picture opened large over a dim backdrop; a backdrop click and Esc each closed it');
});

// A2 step 1, the paperclip half: any file attaches, not only photos. A .docx goes as a file (a chip with its name), the daemon
// saves it in the chat's own folder, the agent gets its real path and edits it there, and the sent message names it. The photo
// beside it still goes as a photo. Fails on main: the picker filters to photos and readImage refuses the .docx.
test('A2 step 1: the desktop paperclip attaches any file; the agent gets its path and its edit is on disk', { timeout: 90000 }, async (t) => {
  const { instance, id, page, pane, send, errors } = await setup(t, 'a2-files');
  const docx = Buffer.from('PK\x03\x04 any bytes at all');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10000 }), pane.locator('[data-attach]').click()]);
  assert.equal(await chooser.element().evaluate((input) => input.accept), '', 'the picker greys nothing out');
  await chooser.setFiles([{ name: 'report.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: docx }, { name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) }, { name: 'dot.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') }]);
  await pane.locator('.attach .att-file', { hasText: 'report.docx' }).waitFor({ timeout: 10000 });
  await pane.locator('.attach .att-file', { hasText: 'empty.txt' }).waitFor({ timeout: 10000 });
  await pane.locator('.attach img[alt="dot.png"]').waitFor({ timeout: 10000 });
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT a2-desktop-chips ' + (await pane.screenshot({ type: 'png' })).toString('base64'));
  await send('edit attached');
  let reply;
  await until(async () => (reply = (await said(instance, id, 'update')).map((e) => e.data.content?.text).find((text) => text?.startsWith('edited:'))), 'the agent edited the file');
  const edited = Object.fromEntries(reply.slice('edited:'.length).split(',').map((pair) => pair.split('=')));
  assert.deepEqual(Object.keys(edited), ['report.docx', 'empty.txt']);
  for (const [name, uri] of Object.entries(edited)) assert.match(uri, new RegExp('/attachments/' + id + '/' + name.replace('.', '\\.') + '$'), 'saved in the chat\'s own folder');
  assert.equal(await readFile(fileURLToPath(edited['report.docx']), 'utf8'), docx.toString() + ' edited by the agent', 'the agent\'s edit is on disk');
  assert.equal(await readFile(fileURLToPath(edited['empty.txt']), 'utf8'), ' edited by the agent', 'an empty file goes too, and its edit is on disk');
  const user = (await said(instance, id, 'user')).at(-1).data;
  assert.deepEqual([user.text, user.files, user.images?.length], ['edit attached', [{ name: 'report.docx', size: docx.length }, { name: 'empty.txt', size: 0 }], 1]);
  await pane.locator('.msg.user [data-sent-files]', { hasText: 'report.docx' }).waitFor({ timeout: 10000 });
  assert.equal(await pane.locator('.attach').count(), 0, 'the chips went with the message');
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT a2-desktop-sent ' + (await pane.screenshot({ type: 'png' })).toString('base64'));
  // A name the daemon would refuse (a Windows device name) is refused when attached, with the reason; nothing is attached.
  const [again] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10000 }), pane.locator('[data-attach]').click()]);
  await again.setFiles([{ name: 'CON.txt', mimeType: 'text/plain', buffer: Buffer.from('x') }]);
  await page.locator('#toasts .toast', { hasText: 'CON.txt: its name cannot have' }).waitFor({ timeout: 15000 });
  assert.match(await page.locator('#toasts .toast', { hasText: 'CON.txt' }).innerText(), /Windows device name such as CON; rename it and attach it again/);
  assert.equal(await pane.locator('.attach').count(), 0, 'CON.txt was not attached');
  assert.deepEqual(errors, []);
  console.log('PASS A2 step 1 desktop: report.docx attached as a file beside a photo, saved in attachments/<chat>/, edited there by the agent, named in the sent message; an empty file went and was edited too; CON.txt refused with the reason when attached');
});

// A2 step 1: a big paste of text attaches as a file, so a long log does not fill the box; a short one, or Ctrl Shift V, stays text.
test('A2 step 1: a big paste of text attaches as pasted.txt; a short paste or Ctrl Shift V stays text', { timeout: 90000 }, async (t) => {
  const { instance, id, page, pane, type, errors } = await setup(t, 'a2-paste');
  const box = pane.locator('.composer textarea'), big = 'log line\n'.repeat(600);
  const paste = (text, plain) => box.evaluate((ta, [text, plain]) => {
    if (plain) ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true, bubbles: true }));
    const dt = new DataTransfer(); dt.setData('text/plain', text); const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    ta.dispatchEvent(ev); return ev.defaultPrevented;
  }, [text, plain]);
  assert.equal(await paste('a short paste'), false, 'a short paste stays text');
  assert.equal(await paste('x'.repeat(5000)), false, '5000 characters is not big');
  assert.equal(await paste(big, true), false, 'Ctrl Shift V pastes a big one as text');
  // The real shortcut, through the real clipboard: the text lands in the box.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate((text) => navigator.clipboard.writeText(text), big);
  await box.click(); await page.keyboard.press('Control+Shift+V');
  await until(async () => await box.inputValue() === big, 'Ctrl Shift V put the big paste in the box as text');
  await box.fill('an old prompt'); await box.evaluate((ta) => ta.select());
  assert.equal(await paste(big), false, 'a big paste over a selection replaces it as text');
  await box.fill('');
  assert.equal(await pane.locator('.attach').count(), 0, 'nothing attached yet');
  // A Ctrl Shift V that pasted nothing (keyup came) does not keep the next paste as text; Enter while the file is still
  // being read does not send without it.
  await type('edit attached');
  assert.equal(await box.evaluate((ta, text) => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true, bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'V', code: 'KeyV', bubbles: true }));
    const dt = new DataTransfer(); dt.setData('text/plain', text); const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    ta.dispatchEvent(ev); ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return ev.defaultPrevented;
  }, big), true, 'a big paste is taken from the box');
  await page.locator('#toasts .toast', { hasText: 'Still attaching a file' }).waitFor({ timeout: 10000 });
  await pane.locator('.attach .att-file', { hasText: 'pasted.txt' }).waitFor({ timeout: 10000 });
  await page.locator('#toasts .toast', { hasText: 'Ctrl Shift V pastes it as text' }).waitFor({ timeout: 10000 });
  assert.equal(await box.inputValue(), 'edit attached', 'nothing was sent while attaching');
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT a2-paste-chip ' + (await pane.screenshot({ type: 'png' })).toString('base64'));
  await box.press('Enter');
  let reply;
  await until(async () => (reply = (await said(instance, id, 'update')).map((e) => e.data.content?.text).find((text) => text?.startsWith('edited:'))), 'the agent edited the file');
  const uri = Object.fromEntries(reply.slice('edited:'.length).split(',').map((pair) => pair.split('=')))['pasted.txt'];
  assert.equal(await readFile(fileURLToPath(uri), 'utf8'), big + ' edited by the agent', 'the paste reached the agent whole, as a file');
  // Four files a message: a fifth big paste is refused, and goes into the box as text instead of being lost.
  for (let i = 0; i < 4; i += 1) assert.equal(await paste(big), true);
  await until(async () => await pane.locator('.attach .att-file').count() === 4, 'four pasted files');
  const fifth = 'fifth\n'.repeat(1000);
  assert.equal(await paste(fifth), true);
  await page.locator('#toasts .toast', { hasText: 'Four files a message at most' }).waitFor({ timeout: 10000 });
  await until(async () => await pane.locator('.composer textarea').inputValue() === fifth, 'the refused paste is in the box');
  assert.equal(await pane.locator('.attach .att-file').count(), 4);
  assert.deepEqual(errors, []);
  console.log('PASS A2 step 1 paste: a 5400-character paste went as pasted.txt and the agent edited it; short, 5000, over a selection and Ctrl Shift V (real clipboard too) stayed text; Enter waited for the attach; a fifth file went in as text');
});

// RS2: the agent asks through P9's MCP server, as a real one would. The native "Restart P9?" dialog is answered Cancel,
// so nothing restarts; it opening proves the button reached the restart.
test('RS2: an agent\'s restart request shows a Restart P9 button that asks to restart P9', { timeout: 90000 }, async (t) => {
  const { Client } = await import('../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
  const { StdioClientTransport } = await import('../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
  const { app, instance, id, pane, send } = await setup(t, 'rs2');
  await send('mcp');
  let entry;
  await until(async () => ([entry] = JSON.parse((await said(instance, id, 'update')).find((e) => e.data.content?.text?.startsWith('mcp:'))?.data.content.text.slice(4) ?? '[]')).length, 'the MCP entry');
  const client = new Client({ name: 'p9-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env: Object.fromEntries(entry.env.map(({ name, value }) => [name, value])) }));
  t.after(() => client.close());
  await client.callTool({ name: 'request_restart', arguments: { reason: 'settings changed' } });
  await app.evaluate(({ dialog }) => { globalThis.asked = []; dialog.showMessageBox = async (_window, options) => { globalThis.asked.push(options.title); return { response: 0 }; }; });
  const button = pane.locator('.notice', { hasText: 'settings changed' }).locator('[data-restart-p9]');
  await button.click({ timeout: 10000 });
  await until(async () => (await app.evaluate(() => globalThis.asked)).includes('Restart P9?'), 'the restart dialog', 5000);
  await until(() => button.isEnabled(), 'the button back after Cancel', 5000);
  console.log('PASS RS2: the restart request showed Restart P9; it asked to restart, and Cancel left P9 running');
});

// #479 review: attach.mjs loads on the first attach. A failed load (the chunk's first request cancelled) says why, keeps the
// draft and attaches nothing; the next attach loads it afresh, without a reload, and the file is a chip.
test('A2 step 1: a failed load of the attach code says so, keeps the draft, and the next attach works', { timeout: 90000 }, async (t) => {
  const { app, page, pane, type } = await setup(t, 'a2-chunk');
  await app.evaluate(({ session }) => {
    globalThis.attachRequests = 0;
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      if (/\/_astro\/attach[^/]*\.js/.test(details.url)) callback({ cancel: ++globalThis.attachRequests === 1 }); else callback({});
    });
  });
  await type('keep this draft');
  const pick = async () => {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10000 }), pane.locator('[data-attach]').click()]);
    await chooser.setFiles([{ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('n') }]);
  };
  await pick();
  await page.locator('#toasts .toast', { hasText: 'Could not load attaching; nothing was attached. Try again.' }).waitFor({ timeout: 15000 });
  assert.equal(await pane.locator('.attach').count(), 0, 'nothing attached');
  assert.equal(await pane.locator('.composer textarea').inputValue(), 'keep this draft', 'the draft is kept');
  // The toast pops up over the paperclip, and hovering holds it: move off, and let it fade before the next attach.
  await page.mouse.move(0, 0);
  await page.locator('#toasts .toast').first().waitFor({ state: 'detached', timeout: 20000 });
  await pick();
  await pane.locator('.attach .att-file', { hasText: 'notes.txt' }).waitFor({ timeout: 10000 });
  assert.equal(await pane.locator('.composer textarea').inputValue(), 'keep this draft', 'the draft is still there');
  assert.equal(await app.evaluate(() => globalThis.attachRequests), 2, 'the chunk was requested again on the next attach');
});

test('A2 step 2: Up in an empty box brings back the prompts sent before, Down goes forward again; typed text is never replaced', { timeout: 90000 }, async (t) => {
  const { page, pane, type, agentSaid, errors, instance, id } = await setup(t, 'a2-recall');
  const box = pane.locator('.composer textarea'), key = (k) => page.keyboard.press(k), value = () => box.inputValue(), caret = () => box.evaluate((b) => b.selectionStart);
  await type('second'); await key('Shift+Enter'); await page.keyboard.type('one'); await key('Enter');
  await until(() => agentSaid('echo:second\none'), 'second answered');
  await box.click();
  await key('ArrowUp'); assert.deepEqual([await value(), await caret()], ['second\none', 0], 'Up in an empty box: the last prompt, caret at its start');
  await key('ArrowUp'); assert.equal(await value(), 'hello', 'Up again: the one before');
  await key('ArrowUp'); assert.equal(await value(), 'hello', 'the first prompt stays');
  await key('ArrowDown'); assert.equal(await value(), 'hello', 'Down with the caret at the start moves the caret, recalls nothing');
  await key('End'); await key('ArrowDown'); assert.deepEqual([await value(), await caret()], ['second\none', 10], 'Down at the end: forward again, caret at its end');
  await key('ArrowUp'); assert.equal(await value(), 'second\none', 'Up with the caret not at the start moves the caret, recalls nothing');
  assert.ok(await caret() > 0 && await caret() < 7, 'the caret went up a line');
  await key('ArrowDown'); assert.equal(await value(), 'second\none', 'Down from the first line moves the caret down a line, recalls nothing');
  await key('Control+End'); await key('ArrowDown'); assert.equal(await value(), '', 'Down at the end of the newest: an empty box');
  await key('ArrowDown'); assert.equal(await value(), '', 'Down in an empty box does nothing');
  await page.keyboard.type('hello'); await key('Home'); await key('ArrowUp');
  assert.equal(await value(), 'hello', 'typed text is never replaced, even when it matches a sent prompt');
  await box.fill(''); await key('ArrowUp'); await key('Control+End'); await page.keyboard.type('x'); await key('Backspace'); await key('ArrowDown');
  assert.equal(await value(), 'second\none', 'typing ends a recall, even when the text matches again');
  await box.fill(''); await key('ArrowUp'); await key('ArrowUp'); await key('End'); await page.keyboard.type(' again');
  await key('Enter');
  await until(async () => (await users(instance, id)).join('|') === 'hello|second\none|hello again', 'the edited recall sent');
  await until(async () => (await pane.innerText()).includes('hello again'), 'the page shows it'); // the daemon has it before the page does
  await key('ArrowUp'); assert.equal(await value(), 'hello again', 'the newest sent prompt comes back first');
  assert.deepEqual(errors, []);
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT a2-recall ' + (await pane.screenshot({ type: 'png' })).toString('base64'));
});

// A2 step 6: quote a reply, or the part of it selected, with a comment; the chip it makes goes with the next message.
test('A2 step 6: a selection in a reply, or its Quote button, opens a box under it; Enter makes a chip, x removes it, and the message carries quote and comment', { timeout: 90000 }, async (t) => {
  const { page, pane, send, errors, instance, id } = await setup(t, 'a2-quote');
  const said_ = 'The first sentence. The second sentence.', reply = pane.locator('.msg.agent').last();
  await send(said_); await until(async () => (await reply.textContent()).includes('The second sentence.'), 'the reply is drawn');
  // The turn's end redraws the reply (CI run 45732957543: a selection made before it was gone); select after it.
  await until(async () => (await pane.locator('.working').count()) === 0, 'the turn ended', 15000);
  // CI run 45737907047: still lost after that on a slow runner, so also wait until the reply has not changed for 800 ms.
  await reply.evaluate((m) => new Promise((done) => { let t = setTimeout(fin, 800); const o = new MutationObserver(() => { clearTimeout(t); t = setTimeout(fin, 800); });
    function fin() { o.disconnect(); done(); } o.observe(m.closest('.hist'), { subtree: true, childList: true, characterData: true, attributes: true }); }));
  const box = page.locator('.quote-box'), chips = pane.locator('.attach .att-quote'), composer = pane.locator('.composer textarea');
  // As a drag over "The second sentence." leaves it: the words selected, then the pointer let go over the history.
  const select = () => reply.evaluate((m) => { const w = document.createTreeWalker(m, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode()) && !n.data.includes('The second'));
    const at = n.data.indexOf('The second'), r = document.createRange(); r.setStart(n, at); r.setEnd(n, at + 'The second sentence.'.length);
    getSelection().removeAllRanges(); getSelection().addRange(r); m.closest('.hist').dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    const b = r.getBoundingClientRect(); return { bottom: b.bottom, left: b.left }; });
  // Follow-up (owner): the selection only shows a small Comment button beside it, and stays selected (Copy works); the
  // button opens the box.
  const pop = page.locator('.comment-pop');
  const sel = await select();
  await pop.waitFor({ timeout: 5000 }); await page.waitForTimeout(300);
  assert.equal(await box.count(), 0, 'a selection alone opens no box');
  assert.equal(await page.evaluate(() => getSelection().toString()), 'The second sentence.', 'the text stays selected, so it can be copied');
  const pshot = await page.screenshot({ type: 'png', clip: { x: Math.max(0, sel.left - 40), y: Math.max(0, sel.bottom - 60), width: 520, height: 140 } });
  if (process.env.P9_EVIDENCE) await writeFile(path.join(process.env.P9_EVIDENCE, 'a2-comment-button.png'), pshot); else console.log('P9_SHOT a2-comment-button ' + pshot.toString('base64'));
  await pop.click();
  await box.waitFor({ timeout: 5000 });
  assert.equal(await pop.count(), 0, 'the button goes when the box opens');
  const at = await box.evaluate((b) => { const r = b.getBoundingClientRect(); return { top: r.top, left: r.left, focused: document.activeElement === b.querySelector('textarea') }; });
  assert.ok(at.top >= sel.bottom && at.top <= sel.bottom + 8 && Math.abs(at.left - Math.max(8, sel.left)) < 1, 'the box opens just under the selection: ' + JSON.stringify({ at, sel }));
  assert.ok(at.focused, 'the box takes the typing');
  assert.equal(await box.locator('blockquote').textContent(), 'The second sentence.', 'the box shows what was selected');
  await page.keyboard.type('why this?');
  const shot = await page.screenshot({ type: 'png', clip: { x: Math.max(0, at.left - 40), y: Math.max(0, sel.bottom - 60), width: 520, height: 260 } });
  if (process.env.P9_EVIDENCE) await writeFile(path.join(process.env.P9_EVIDENCE, 'a2-quote-box.png'), shot); else console.log('P9_SHOT a2-quote-box ' + shot.toString('base64'));
  await page.keyboard.press('Enter');
  await until(async () => await box.count() === 0 && await chips.count() === 1, 'Enter makes a chip and closes the box', 5000);
  assert.equal(await chips.first().getAttribute('title'), 'The second sentence.\n\nwhy this?', 'the chip holds the quote and the comment');
  assert.ok(await composer.evaluate((b) => document.activeElement === b), 'the message box has the typing again');
  assert.equal((await chips.first().locator('.quote-go').textContent()).trim(), 'why this?', 'a chip with a comment shows the comment');
  // The pencil opens the box with the comment in it; Enter saves the change on the same chip.
  await chips.first().locator('[data-quote-edit]').click(); await box.waitFor({ timeout: 5000 });
  assert.equal(await box.locator('textarea').inputValue(), 'why this?', 'the pencil opens the box with its comment');
  await page.keyboard.type(' really'); await page.keyboard.press('Enter');
  await until(async () => await box.count() === 0 && (await chips.first().getAttribute('title')) === 'The second sentence.\n\nwhy this? really', 'the edit is saved on the chip', 5000);
  assert.equal(await chips.count(), 1, 'editing adds no chip');
  await select(); await pop.waitFor({ timeout: 5000 }); await page.keyboard.press('Escape');
  await until(async () => await pop.count() === 0, 'Esc takes the Comment button away', 5000);
  // Review #536: a selection changed after the button showed (Shift+arrow) takes it away, so it never quotes the old words.
  await select(); await pop.waitFor({ timeout: 5000 }); await page.evaluate(() => getSelection().modify('extend', 'backward', 'character'));
  await until(async () => await pop.count() === 0, 'a changed selection takes the Comment button away', 5000);
  await select(); await pop.waitFor({ timeout: 5000 });
  await pop.click(); await box.waitFor({ timeout: 5000 }); await page.keyboard.press('Escape');
  await until(async () => await box.count() === 0, 'Esc closes the box', 5000);
  assert.equal(await chips.count(), 1, 'Esc adds nothing');
  await reply.hover(); await reply.locator('[data-quote-reply]').click();
  await box.waitFor({ timeout: 5000 });
  assert.equal(await box.locator('blockquote').textContent(), 'echo:' + said_, 'Quote takes the whole reply');
  await page.keyboard.press('Enter');
  await until(async () => await chips.count() === 2, 'a second chip, with no comment', 5000);
  assert.equal((await chips.nth(1).locator('.quote-go').textContent()).trim(), '“echo:The first sentence. The second sent”', 'a chip with no comment shows the start of its quote');
  const png = await pane.locator('.composer').screenshot({ type: 'png' });
  if (process.env.P9_EVIDENCE) await writeFile(path.join(process.env.P9_EVIDENCE, 'a2-quote.png'), png); else console.log('P9_SHOT a2-quote ' + png.toString('base64'));
  await chips.first().locator('[data-unquote]').click();
  await until(async () => await chips.count() === 1, 'x removes its chip', 5000);
  assert.equal(await chips.first().getAttribute('title'), 'echo:' + said_, 'the other chip stays');
  await composer.click(); await page.keyboard.type('my message'); await page.keyboard.press('Enter');
  await until(async () => (await users(instance, id)).includes('> echo:' + said_ + '\n\nmy message'), 'the message carries the quote first', 15000);
  assert.equal(await chips.count(), 0, 'a send takes the chips');
  // A quote alone, with the box empty, sends too.
  await until(async () => (await reply.textContent()).includes('my message'), 'that one is answered on the page');
  await pane.locator('.msg.agent').first().hover(); await pane.locator('.msg.agent').first().locator('[data-quote-reply]').click();
  await box.waitFor({ timeout: 5000 }); await page.keyboard.type('only this'); await page.keyboard.press('Enter');
  await until(async () => await chips.count() === 1, 'the chip', 5000);
  // The chip shows its reply: the chat scrolls it into the middle and marks it.
  const hist = pane.locator('.hist');
  await hist.evaluate((h) => { h.style.maxHeight = '140px'; h.scrollTo({ top: h.scrollHeight, behavior: 'instant' }); });
  const was = await hist.evaluate((h) => h.scrollTop);
  await chips.first().locator('[data-quote-go]').click();
  const first = pane.locator('.msg.agent').first();
  await until(async () => await first.evaluate((m) => m.classList.contains('quote-src')), 'the quoted reply is marked', 5000);
  const seen = () => hist.evaluate((h, was) => { const r = h.querySelector('.msg.agent').getBoundingClientRect(), b = h.getBoundingClientRect(); return h.scrollTop < was && r.bottom > b.top && r.top < b.bottom; }, was);
  await until(seen, 'the chat scrolled (smoothly) to the quoted reply', 5000);
  await hist.evaluate((h) => { h.style.maxHeight = ''; });
  await composer.click(); await page.keyboard.press('Enter');
  await until(async () => (await users(instance, id)).includes('> echo:hello\n\nonly this'), 'a quote with nothing typed sends', 15000);
  assert.deepEqual(errors, [], 'no page errors');
  console.log('PASS A2 step 6: a selection shows Comment (copy kept), Comment or Quote opens the box; the chip shows the comment or the quote start, the pencil edits it, a click shows its reply; x removes it; the send carries quote and comment');
});

// A2 step 6, review round 1: the message box is kept as chips come and go (its undo history with it); Esc from the box's
// buttons closes it and gives the typing back; a slash command goes alone and the chips wait; a refused send gives the
// chips back as chips; in the chat dialog the box opens inside the dialog, where it can be reached.
test('A2 step 6: the box stays put, Esc anywhere in it closes it, a command leaves the chips, a refusal gives them back, the dialog has it', { timeout: 120000 }, async (t) => {
  const { app, page, pane, errors, instance, id } = await setup(t, 'a2-quote-2');
  const box = page.locator('.quote-box'), chips = pane.locator('.attach .att-quote'), composer = pane.locator('.composer textarea'), reply = pane.locator('.msg.agent').last();
  const quote = async (r = reply) => { await r.hover(); await r.locator('[data-quote-reply]').click(); await box.waitFor({ timeout: 5000 }); };
  await composer.evaluate((b) => { b.p9kept = true; }); // a property: the patcher copies attributes, not properties
  await quote(); await page.keyboard.press('Enter');
  await until(async () => await chips.count() === 1, 'a chip', 5000);
  assert.equal(await composer.evaluate((b) => b.p9kept), true, 'the first chip leaves the same message box (its undo history too)');
  await quote(); await page.keyboard.press('Tab'); await page.keyboard.press('Escape');
  await until(async () => await box.count() === 0, 'Esc on the Cancel button closes the box', 5000);
  assert.ok(await composer.evaluate((b) => document.activeElement === b), 'and the message box has the typing');
  // Another focus mode by its shortcut (the focus stays in the box) closes it, so Enter cannot add to a chat out of sight.
  await quote(); await page.keyboard.press('Control+2');
  await until(async () => await box.count() === 0, 'Ctrl+2 closes the box', 5000);
  await page.keyboard.press('Control+1'); await composer.waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(await chips.count(), 1, 'and added nothing');
  // Follow-up (owner): a comment typed and not sent is kept as a chip when the box closes that way, not lost.
  await quote(); await page.keyboard.type('keep me'); await page.keyboard.press('Control+2');
  await until(async () => await box.count() === 0, 'Ctrl+2 closes the box with a comment typed', 5000);
  await page.keyboard.press('Control+1'); await composer.waitFor({ state: 'visible', timeout: 5000 });
  await until(async () => await chips.count() === 2, 'the typed comment came back as a chip', 5000);
  assert.ok((await chips.nth(1).getAttribute('title')).endsWith('\n\nkeep me'), 'with its comment');
  // Review #536: the pencil, the comment deleted, then away: the chip keeps the cleared comment, not the old one.
  await chips.nth(1).locator('[data-quote-edit]').click(); await box.waitFor({ timeout: 5000 });
  await page.keyboard.press('Control+a'); await page.keyboard.press('Backspace'); await page.keyboard.press('Control+2');
  await until(async () => await box.count() === 0, 'Ctrl+2 closes the pencil box', 5000);
  await page.keyboard.press('Control+1'); await composer.waitFor({ state: 'visible', timeout: 5000 });
  await until(async () => !(await chips.nth(1).getAttribute('title')).includes('keep me'), 'the cleared comment was saved', 5000);
  assert.equal(await chips.count(), 2, 'on the same chip');
  await quote(); await page.keyboard.type('dropped'); await page.keyboard.press('Escape');
  await until(async () => await box.count() === 0, 'Esc closes it', 5000);
  assert.equal(await chips.count(), 2, 'Esc drops what was typed');
  await chips.nth(1).locator('[data-unquote]').click(); await until(async () => await chips.count() === 1, 'back to one chip', 5000);
  // A command the agent lists goes alone; the chip waits for the next message.
  await composer.click(); await page.keyboard.type('/compact'); await page.keyboard.press('Enter');
  await until(async () => (await users(instance, id)).includes('/compact'), 'the command went as typed', 15000);
  assert.equal(await chips.count(), 1, 'the chip waits');
  await until(async () => (await pane.locator('.working').count()) === 0, 'that turn ended', 15000);
  // The daemon holds the next message, then takes it; a second, identical quoted send made while it waits (its call waits
  // behind the first's) is refused. While they wait the box is empty and the chip gone; after, the refused one's chip comes
  // back as the same chip and only its typed words go back in the box. Review round 5: the first is taken and the second
  // refused, so a recovery shared by identical sends (taken one clears it) fails here.
  const chipText = await chips.first().textContent();
  await app.evaluate(({ ipcMain }) => { const h = ipcMain._invokeHandlers.get('p9:chat'); ipcMain.removeHandler('p9:chat'); let n = 0;
    ipcMain.handle('p9:chat', async (e, ...args) => { if (args[0] !== 'prompt' || n > 1) return h(e, ...args);
      if (n++ === 0) { await new Promise((r) => { globalThis.p9release = r; }); return h(e, ...args); }
      globalThis.p9refused = args[1]?.text; return { status: 409, body: { error: 'not-ready' } }; }); });
  await composer.click(); await page.keyboard.type('my words'); await page.keyboard.press('Enter');
  await until(async () => await app.evaluate(() => !!globalThis.p9release), 'the first send reached the daemon and waits', 10000);
  assert.equal(await composer.inputValue(), '', 'while it waits the box is empty');
  assert.equal(await chips.count(), 0, 'and the chip went with the send');
  await quote(); await page.keyboard.press('Enter'); await until(async () => await chips.count() === 1, 'the same quote again', 5000);
  await composer.click(); await page.keyboard.type('my words'); await page.keyboard.press('Enter');
  await until(async () => (await composer.inputValue()) === '' && await chips.count() === 0, 'the second send left the box', 5000);
  const ends = (await said(instance, id, 'turn-end')).length;
  await app.evaluate(() => globalThis.p9release());
  await until(async () => (await users(instance, id)).filter((u) => u.startsWith('> ') && u.endsWith('my words')).length === 1, 'the first send was taken', 15000);
  const refused = async () => await app.evaluate(() => globalThis.p9refused ?? '');
  await until(async () => /^> /.test(await refused()) && (await refused()).endsWith('my words'), 'the identical second send was refused', 15000);
  assert.equal(await refused(), (await users(instance, id)).find((u) => u.startsWith('> ') && u.endsWith('my words')), 'the refused text is the taken one exactly'); // O267
  await until(async () => (await composer.inputValue()) === 'my words' && await chips.count() === 1, 'refused: its words in the box, its chip a chip', 10000);
  assert.equal(await chips.first().textContent(), chipText, 'the same chip came back');
  await until(async () => (await said(instance, id, 'turn-end')).length > ends, 'the taken send\'s turn ended', 15000);
  await chips.first().locator('[data-unquote]').click();
  await until(async () => await chips.count() === 0, 'the last chip goes', 5000);
  assert.equal(await composer.evaluate((b) => b.p9kept), true, 'and the message box is still the same one');
  // In the chat dialog (opened from its card in Notification Center, over Settings left open), the box opens inside the
  // dialog and its chip lands in that chat: only the top dialog counts (review round 5).
  await composer.fill(''); await page.keyboard.press('Escape');
  await pane.locator('.composer textarea').click(); await page.keyboard.type('ask-text'); await page.keyboard.press('Enter');
  await pane.locator('[data-question]').waitFor({ timeout: 15000 });
  await page.click('#setBtn'); await page.locator('#setDlg[open]').waitFor();
  await page.keyboard.press('Control+Shift+N'); await page.locator('#mdlBody .mlist [data-i]').first().click();
  const mbtn = page.locator('#mdlBody .mlist button').first(); if (await mbtn.count()) await mbtn.click();
  const dpane = page.locator('#mdlBody .pane'); await dpane.waitFor({ timeout: 10000 });
  await quote(dpane.locator('.msg.agent').first());
  assert.ok(await box.evaluate((b) => !!b.closest('dialog[open]')), 'the box is inside the open dialog');
  assert.equal(await page.locator('#setDlg[open]').count(), 1, 'with Settings still open under it');
  await page.keyboard.type('from the dialog'); await page.keyboard.press('Enter');
  await until(async () => await dpane.locator('.attach .att-quote').count() === 1, 'the chip in the dialog\'s chat', 5000);
  assert.ok(await dpane.locator('.composer textarea').evaluate((b) => document.activeElement === b), 'the dialog\'s message box has the typing');
  assert.deepEqual(errors.filter((e) => !/not-ready|409/.test(e)), [], 'no page errors');
  console.log('PASS A2 step 6 round 2: box kept, Esc from a button, command alone, refusal keeps chips, the dialog');
});

// A2 step 6, review round 3: Send pressed while the pencil is open sends the chip as it was and the edit comes back as a
// chip. A refusal then gives back each chip as it is now: the edit once (not beside the version sent), and one whose x was
// pressed meanwhile stays gone.
test('A2 step 6: a refused send made with the pencil open gives back the edited chip once, and a removed one stays gone', { timeout: 90000 }, async (t) => {
  const { app, page, pane, errors, instance, id } = await setup(t, 'a2-quote-3');
  const ends = (await said(instance, id, 'turn-end')).length;
  const box = page.locator('.quote-box'), chips = pane.locator('.attach .att-quote'), composer = pane.locator('.composer textarea'), reply = pane.locator('.msg.agent').last();
  const titles = async () => (await chips.evaluateAll((els) => els.map((el) => el.title.split('\n\n').slice(1).at(-1) ?? ''))); // the comment: a later reply quoted holds blank lines of its own
  await reply.hover(); await reply.locator('[data-quote-reply]').click(); await box.waitFor({ timeout: 5000 });
  await page.keyboard.type('a'); await page.keyboard.press('Enter'); await until(async () => await chips.count() === 1, 'a chip', 5000);
  // Every prompt waits for p9release, then is refused.
  await app.evaluate(({ ipcMain }) => { const h = ipcMain._invokeHandlers.get('p9:chat'); ipcMain.removeHandler('p9:chat');
    ipcMain.handle('p9:chat', async (e, ...args) => { if (args[0] !== 'prompt') return h(e, ...args);
      await new Promise((r) => { globalThis.p9release = r; }); globalThis.p9release = null; return globalThis.p9pass ? h(e, ...args) : { status: 409, body: { error: 'not-ready' } }; }); });
  const sendWithPencil = async (more) => {
    await chips.first().locator('[data-quote-edit]').click(); await box.waitFor({ timeout: 5000 }); await page.keyboard.type(more);
    await pane.locator('[data-send]').click();
    await until(async () => await app.evaluate(() => !!globalThis.p9release), 'the send waits at the daemon', 10000);
  };
  await composer.click(); await page.keyboard.type('words');
  await sendWithPencil(' b');
  await until(async () => (await titles()).join('|') === 'a b', 'the edit came back as a chip while the send waits', 5000);
  await app.evaluate(() => globalThis.p9release());
  await until(async () => (await composer.inputValue()) === 'words', 'refused: its words back in the box', 10000);
  assert.deepEqual(await titles(), ['a b'], 'the edited chip once, not beside the one sent');
  // Again, and the edit's x pressed while the send waits: the refusal does not bring the chip back.
  await sendWithPencil(' c');
  await until(async () => (await titles()).join('|') === 'a b c', 'the second edit came back as a chip', 5000);
  await chips.first().locator('[data-unquote]').click(); await until(async () => await chips.count() === 0, 'x removed it', 5000);
  await app.evaluate(() => globalThis.p9release());
  await until(async () => (await composer.inputValue()) === 'words', 'refused again: the words back', 10000);
  assert.equal(await chips.count(), 0, 'the removed chip stays gone');
  const add = async (comment) => { const n = await chips.count(); await reply.hover(); await reply.locator('[data-quote-reply]').click(); await box.waitFor({ timeout: 5000 });
    await page.keyboard.type(comment); await page.keyboard.press('Enter'); await until(async () => await chips.count() === n + 1, 'chip ' + comment, 5000); };
  // Review round 4: two chips, the first's pencil open at Send; the refusal gives them back in the order sent.
  await add('p'); await add('r');
  await sendWithPencil(' 2');
  await until(async () => (await titles()).join('|') === 'p 2', 'the edit came back while the send waits', 5000);
  await app.evaluate(() => globalThis.p9release());
  await until(async () => (await titles()).join('|') === 'p 2|r', 'refused: both back, in the order sent', 10000);
  for (let n = 2; n; n--) { await chips.first().locator('[data-unquote]').click(); await until(async () => await chips.count() === n - 1, 'cleared', 5000); }
  // Review round 4: the edit that came back is sent again before the first send is refused; that refusal does not give it
  // back (the second send has it), and the second send, taken, leaves no chip behind.
  await add('q'); await sendWithPencil(' z');
  await until(async () => (await titles()).join('|') === 'q z', 'the edit came back while the first send waits', 5000);
  await pane.locator('[data-send]').click(); await until(async () => await chips.count() === 0, 'the second send took the edit', 5000);
  await app.evaluate(() => globalThis.p9release());
  await until(async () => (await composer.inputValue()) === 'words', 'the first refused: its words back', 10000);
  assert.equal(await chips.count(), 0, 'and not the chip the second send took');
  await until(async () => await app.evaluate(() => !!globalThis.p9release), 'the second send waits at the daemon', 10000);
  await app.evaluate(() => { globalThis.p9pass = true; globalThis.p9release(); });
  await until(async () => (await said(instance, id, 'turn-end')).length > ends, 'the second send was taken and answered', 20000);
  assert.equal(await chips.count(), 0, 'no chip left behind');
  // Review round 5: the edit that came back is saved to Drafts (Ctrl+S) before the refusal; the refusal does not bring it back.
  await app.evaluate(() => { globalThis.p9pass = false; });
  await add('d'); await composer.fill('words'); await sendWithPencil(' s'); // fill: the refusal above left its words in the box
  await until(async () => (await titles()).join('|') === 'd s', 'the edit came back while the send waits', 5000);
  await composer.click(); await page.keyboard.type('later'); await page.keyboard.press('Control+s');
  await until(async () => await chips.count() === 0 && (await composer.inputValue()) === '', 'Ctrl+S put the box and its chip aside', 5000);
  await app.evaluate(() => globalThis.p9release());
  await until(async () => (await composer.inputValue()) === 'words', 'refused: its words back', 10000);
  assert.equal(await chips.count(), 0, 'and not the chip the draft took');
  assert.deepEqual(errors.filter((e) => !/not-ready|409/.test(e)), [], 'no page errors');
  console.log('PASS A2 step 6 round 3: a refusal gives back the edit once, in the order sent; a removed edit, or one a later send or a draft took, stays gone');
});

// O267: a send whose retry gets outcome-unknown (a remote's first try still in flight) asks again with the same operation
// ID until the daemon answers, so its own answer settles it (a held one keeps its files the normal way); an identical
// message from elsewhere does not count as it. Never answered: back in the box, saying it may still have arrived.
// Review 7: it asks until the send cap (10 minutes; 65 s here, P9_SEND_CAP_MS), so one that lands late is delivered once.
test('O267: a send with an unknown outcome asks again with its own operation ID, then goes back in the box unsure', { timeout: 420000 }, async (t) => {
  const { app, instance, id, page, pane, send, errors } = await setup(t, 'o267-unknown', { files: ['slow-tools'], env: { P9_SEND_CAP_MS: '65000' } });
  const composer = pane.locator('.composer textarea');
  // 'landed': the daemon's first two answers are lost in flight, the third try is the one it runs. 'lost': never answered.
  // 'held': the daemon runs the first try (held mid-turn) but its answer is lost; the second meets a dropped link (503);
  // the third gets the daemon's own answer replayed (202 with its held ID).
  await app.evaluate(({ ipcMain }) => { const h = ipcMain._invokeHandlers.get('p9:chat'); ipcMain.removeHandler('p9:chat'); globalThis.o267 = [];
    ipcMain.handle('p9:chat', async (e, ...args) => { const text = args[0] === 'prompt' && args[1]?.text; if (!['landed', 'lost', 'held', 'stalled', 'late', 'dropped', 'dropped once', 'long work', 'long again', 'slow cut'].includes(text)) return h(e, ...args);
      globalThis.o267.push([text, args[1].op, JSON.stringify(args[1])]);
      const n = globalThis.o267.filter(([x]) => x === text).length;
      if (text === 'held') { if (n === 1) { await h(e, ...args); return { status: 409, body: { error: 'outcome-unknown', operation: args[1].op } }; } if (n === 2) return { status: 503, body: { error: 'daemon-unavailable' } }; globalThis.o267replayed = await h(e, ...args); return globalThis.o267replayed; }
      if (text === 'landed' && n >= 3) return h(e, ...args);
      // Review 9: 'dropped': the daemon takes the first try but the link drops before its answer (503, unsure: it went out), and drops again on
      // the second; the third gets its own answer replayed. 'long work': its turn starts, its answer never comes until told.
      if (text === 'dropped') { if (n === 1) await h(e, ...args); return n <= 2 ? { status: 503, body: { error: 'daemon-unavailable', unsure: true } } : h(e, ...args); }
      // Review 10: 'dropped once': the first try goes out but its link drops (unsure); the retry meets nothing listening (a plain
      // 503, never sent); the third gets the first try's answer replayed.
      if (text === 'dropped once') { if (n === 1) { await h(e, ...args); return { status: 503, body: { error: 'daemon-unavailable', unsure: true } }; } return n === 2 ? { status: 503, body: { error: 'daemon-unavailable' } } : h(e, ...args); }
      if (text === 'long work') { if (n === 1) void h(e, ...args); if (globalThis.o267settle) return h(e, ...args); }
      // Review 11: 'long again' is 'long work' again, answered once o267settle2; 'slow cut' (an Interrupt) waits on its link until o267cutgo.
      if (text === 'long again') { if (n === 1) void h(e, ...args); if (globalThis.o267settle2) { globalThis.o267long2 = true; return h(e, ...args); } }
      if (text === 'slow cut') { await new Promise((res) => { globalThis.o267cutgo = res; }); return h(e, ...args); }
      // Round 4: 'lost' stalls its tries from 50 s on (a bridge prompt can wait 90 s): the send still ends unsure at the cap.
      // Round 5: 'stalled' never answers its first try: the cap counts from it too.
      // Review 7: 'late' lands at 62 s, past the old 60 s deadline and inside the cap.
      if (text === 'late') { await new Promise((res) => setTimeout(res, 62000)); return h(e, ...args); }
      if (text === 'stalled') { globalThis.o267stalled = Date.now(); await new Promise(() => {}); }
      if (text === 'lost') { globalThis.o267lost ??= Date.now(); if (Date.now() - globalThis.o267lost > 50000) await new Promise(() => {}); }
      return { status: 409, body: { error: 'outcome-unknown', operation: args[1]?.op } }; }); });
  const rows = pane.locator('.queue [data-held]');
  await send('tools 2');
  await started(instance, id, 'tool-1');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10000 }), pane.locator('[data-attach]').click()]);
  await chooser.setFiles([{ name: 'held.txt', mimeType: 'text/plain', buffer: Buffer.from('held') }]);
  await pane.locator('.attach .att-file', { hasText: 'held.txt' }).waitFor({ timeout: 10000 });
  await send('held');
  await until(async () => (await app.evaluate(() => globalThis.o267replayed?.status)) === 202, 'the third try got the daemon\'s own answer', 15000);
  assert.ok((await app.evaluate(() => globalThis.o267replayed.body?.held)), 'a held ID in the replayed answer');
  assert.equal(new Set(await app.evaluate(() => globalThis.o267.filter(([x]) => x === 'held').map(([, op]) => op))).size, 1, 'one operation across the lost answer and the dropped link');
  await until(async () => (await rows.filter({ hasText: 'held' }).count()) === 1, 'held once', 5000);
  assert.equal(await pane.locator('.attach').count(), 0, 'its file went with it');
  await rows.filter({ hasText: 'held' }).locator('[data-unhold]:not([data-now])').click();
  await until(async () => (await composer.inputValue()) === 'held' && (await pane.locator('.attach .att-file', { hasText: 'held.txt' }).count()) === 1, 'Take back gives the message its file back', 10000);
  await pane.locator('.attach [data-unattach]').click(); await composer.fill('');
  await until(async () => (await pane.locator('.working').count()) === 0, 'the tool turn ended', 30000);
  assert.equal((await users(instance, id)).filter((u) => u === 'held').length, 0, 'taken back, never sent');
  await send('landed');
  // The same words from another device while this one waits: a message of its own, not this send's answer.
  const other = await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'landed' }); assert.equal(other.status, 202, JSON.stringify(other.body));
  await until(async () => (await users(instance, id)).filter((u) => u === 'landed').length === 2, 'both arrived, once each', 20000);
  const ops = await app.evaluate(() => globalThis.o267.filter(([x]) => x === 'landed').map(([, op]) => op));
  assert.equal(ops.length, 3); assert.equal(new Set(ops).size, 1, 'each try is the same operation');
  assert.equal(await composer.inputValue(), '', 'a message that arrived does not come back');
  assert.equal(await page.locator('#toasts .toast', { hasText: 'not sure' }).count(), 0, 'its own answer settled it, with no unsure line');
  await until(async () => (await pane.locator('.working').count()) === 0, 'those turns ended', 20000);
  await send('lost');
  await page.waitForTimeout(5000);
  assert.equal(await composer.inputValue(), '', 'not back in the box while P9 may still be running it');
  await until(async () => (await composer.inputValue()) === 'lost', 'back in the box once P9 never answered', 80000);
  assert.ok(Date.now() - (await app.evaluate(() => globalThis.o267lost)) < 71000, 'by the cap, though its last try stalled');
  await page.locator('#toasts .toast', { hasText: 'Still not sure your message arrived' }).waitFor({ timeout: 5000 });
  assert.equal(new Set(await app.evaluate(() => globalThis.o267.filter(([x]) => x === 'lost').map(([, op]) => op))).size, 1, 'one operation throughout');
  assert.equal((await users(instance, id)).filter((u) => u === 'lost').length, 0);
  await composer.fill(''); await send('stalled');
  await until(async () => (await composer.inputValue()) === 'stalled', 'back in the box though its first try never answered', 80000);
  const waited = Date.now() - (await app.evaluate(() => globalThis.o267stalled));
  assert.ok(waited < 69000, `by the cap from the first try (${waited} ms)`);
  assert.equal((await app.evaluate(() => globalThis.o267.filter(([x]) => x === 'stalled').length)), 1, 'one try: it never answered');
  // Review 7: an answer at 62 s is still this send's own: delivered once, never back in the box, and a send made meanwhile
  // waits in the chat's line behind it, so it goes after it.
  await composer.fill(''); await send('late');
  await page.waitForTimeout(2000); await send('behind');
  await until(async () => (await users(instance, id)).includes('behind'), 'the send behind it went', 90000);
  const order = await users(instance, id);
  assert.equal(order.filter((u) => u === 'late').length, 1, 'the late send arrived once');
  assert.ok(order.lastIndexOf('late') < order.indexOf('behind'), 'and before the send made behind it');
  assert.equal(await app.evaluate(() => globalThis.o267.filter(([x]) => x === 'late').length), 1, 'one try: its own answer came');
  assert.equal(await composer.inputValue(), '', 'a late answer does not put it back in the box');
  assert.equal(await page.locator('#toasts .toast', { hasText: 'operation-reused' }).count(), 0, 'no reused-ID refusal');
  // Review 9: two dropped links before any outcome-unknown are unsure too: it keeps asking and arrives once, not back in the box.
  await until(async () => (await pane.locator('.working').count()) === 0, 'the late turns ended', 30000);
  await send('dropped');
  await until(async () => (await users(instance, id)).includes('dropped') && (await app.evaluate(() => globalThis.o267.filter(([x]) => x === 'dropped').length)) === 3, 'its third try got its own answer', 20000);
  await page.waitForTimeout(1000);
  assert.equal(await composer.inputValue(), '', 'not put back in the box after the dropped links');
  assert.equal((await users(instance, id)).filter((u) => u === 'dropped').length, 1, 'arrived once');
  assert.equal(new Set(await app.evaluate(() => globalThis.o267.filter(([x]) => x === 'dropped').map(([, op]) => op))).size, 1, 'one operation');
  await until(async () => (await pane.locator('.working').count()) === 0, 'its turn ended', 30000);
  // Review 10: an unsure first try stays unsure when the retry meets nothing listening: it keeps asking, never back in the box.
  await send('dropped once');
  await until(async () => (await users(instance, id)).includes('dropped once') && (await app.evaluate(() => globalThis.o267.filter(([x]) => x === 'dropped once').length)) === 3, 'its third try got the first try\'s answer', 20000);
  await page.waitForTimeout(1000);
  assert.equal(await composer.inputValue(), '', 'not put back in the box after an unsure try and a plain 503');
  assert.equal((await users(instance, id)).filter((u) => u === 'dropped once').length, 1, 'arrived once');
  await until(async () => (await pane.locator('.working').count()) === 0, 'its turn ended', 30000);
  // Review 9: Interrupt and send does not wait behind a send whose answer never came: the running turn stops and the new
  // message goes long before the cap. Then the first send's answer comes, and it stays sent.
  await send('long work');
  await until(async () => (await users(instance, id)).includes('long work') && (await pane.locator('.working').count()) === 1, 'the long turn runs, its answer not back', 20000);
  await page.waitForTimeout(1500);
  // Review 10: a send made behind the unanswered one waits for it, so the Interrupt goes first; it still goes once, after it.
  await send('wait behind');
  await composer.fill('cut in'); const cut = Date.now(); await composer.press('Control+Enter');
  await until(async () => (await users(instance, id)).includes('cut in'), 'the interrupt went while the first send was unanswered', 20000);
  assert.ok(Date.now() - cut < 20000, 'well before the cap');
  await app.evaluate(() => { globalThis.o267settle = true; });
  await until(async () => (await pane.locator('.working').count()) === 0, 'the cut-in turn ended', 30000);
  await page.waitForTimeout(2500);
  assert.equal((await users(instance, id)).filter((u) => u === 'long work').length, 1, 'the first send arrived once');
  await until(async () => (await users(instance, id)).includes('wait behind'), 'the send behind it went once it was answered', 20000);
  await until(async () => (await pane.locator('.working').count()) === 0, 'its turn ended', 30000);
  const after = await users(instance, id);
  assert.equal(after.filter((u) => u === 'wait behind').length, 1, 'the send behind it arrived once');
  assert.ok(after.indexOf('cut in') < after.indexOf('wait behind'), 'after the Interrupt: ' + JSON.stringify(after.slice(-4)));
  // Review 11: the answer it waits for comes while the Interrupt is still on its way: it still goes after the Interrupt.
  await send('long again');
  await until(async () => (await users(instance, id)).includes('long again') && (await pane.locator('.working').count()) === 1, 'the second long turn runs', 20000);
  await send('behind again');
  await composer.fill('slow cut'); await composer.press('Control+Enter');
  await until(async () => app.evaluate(() => !!globalThis.o267cutgo), 'the Interrupt is on its way', 10000);
  await app.evaluate(() => { globalThis.o267settle2 = true; });
  await until(async () => app.evaluate(() => !!globalThis.o267long2), 'the long send got its answer', 20000);
  await page.waitForTimeout(3000);
  assert.ok(!(await users(instance, id)).includes('behind again'), 'it waits for the Interrupt still on its way');
  await app.evaluate(() => globalThis.o267cutgo());
  await until(async () => (await users(instance, id)).includes('behind again'), 'it went after the Interrupt', 30000);
  await until(async () => (await pane.locator('.working').count()) === 0, 'its turn ended', 30000);
  const again = await users(instance, id);
  assert.deepEqual(['slow cut', 'behind again'].map((u) => again.filter((x) => x === u).length), [1, 1], 'each once');
  assert.ok(again.indexOf('slow cut') < again.indexOf('behind again'), 'after the Interrupt: ' + JSON.stringify(again.slice(-4)));
  assert.equal(await composer.inputValue(), '', 'and its late answer does not put it back in the box');
  assert.equal(await page.locator('#toasts .toast', { hasText: 'not sure' }).count(), 0, 'no unsure line');
  assert.deepEqual(errors, [], 'no page errors');
  console.log('PASS O267: an unknown outcome asks again with its own ID; an unsure first try stays unsure; a send behind an unanswered one goes once, after an Interrupt; identical words elsewhere do not settle it; a late answer is its own; never answered by the cap, back in the box unsure; dropped links stay unsure; an interrupt does not wait behind an unanswered send');
});

// A2 step 7: Ctrl+S in the message box saves its text as a draft and empties the box; Ctrl+S in an empty box, or Drafts,
// lists them, newest first; one picked goes back in the box and leaves the list; its x deletes it; Esc closes the list.
test('A2 step 7: Ctrl+S puts the draft aside, Drafts lists them, one picked comes back, x deletes, Esc closes', { timeout: 90000 }, async (t) => {
  const { page, pane, errors } = await setup(t, 'a2-drafts');
  const composer = pane.locator('.composer textarea'), btn = pane.locator('[data-drafts]'), menu = page.locator('.drafts-menu');
  await composer.click(); await page.keyboard.type('first idea'); await page.keyboard.press('Control+s');
  await until(async () => (await composer.inputValue()) === '' && (await btn.textContent())?.trim() === 'Drafts 1', 'saved aside, the box empty', 5000);
  await page.keyboard.type('second idea'); await page.keyboard.press('Control+s');
  await until(async () => (await btn.textContent())?.trim() === 'Drafts 2', 'two drafts', 5000);
  await page.keyboard.press('Control+s');
  await menu.waitFor({ timeout: 5000 });
  assert.deepEqual(await menu.locator('.draft-take .truncate').allTextContents(), ['second idea', 'first idea'], 'newest first');
  assert.equal(await menu.locator('.draft-take').first().evaluate((b) => document.activeElement === b), true, 'the list has the keys');
  const png = await page.screenshot({ type: 'png', clip: await menu.evaluate((m) => { const r = m.getBoundingClientRect(); return { x: Math.max(0, r.left - 20), y: Math.max(0, r.top - 20), width: r.width + 40, height: r.height + 80 }; }) });
  if (process.env.P9_EVIDENCE) await writeFile(path.join(process.env.P9_EVIDENCE, 'a2-drafts.png'), png); else console.log('P9_SHOT a2-drafts ' + png.toString('base64'));
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await until(async () => (await composer.inputValue()) === 'first idea' && await menu.count() === 0, 'the picked draft is back in the box', 5000);
  assert.ok(await composer.evaluate((b) => document.activeElement === b), 'the box has the typing');
  assert.equal((await btn.textContent())?.trim(), 'Drafts 1', 'and it left the list');
  await btn.click(); await menu.waitFor({ timeout: 5000 });
  await page.keyboard.press('Escape');
  await until(async () => await menu.count() === 0, 'Esc closes the list', 5000);
  assert.ok(await composer.evaluate((b) => document.activeElement === b), 'the box has the typing again');
  // Step 6 follow-up: a draft keeps the box's quotes with their comments, and taking it back brings them back as chips.
  const reply = pane.locator('.msg.agent').first(), chips = pane.locator('.attach .att-quote'), qbox = page.locator('.quote-box');
  await reply.hover(); await reply.locator('[data-quote-reply]').click(); await qbox.waitFor({ timeout: 5000 });
  await page.keyboard.type('keep this'); await page.keyboard.press('Enter');
  await until(async () => await chips.count() === 1, 'a quote chip', 5000);
  await composer.click(); await page.keyboard.press('Control+s');
  await until(async () => (await composer.inputValue()) === '' && await chips.count() === 0 && (await btn.textContent())?.trim() === 'Drafts 2', 'the text and its quote saved aside together', 5000);
  await btn.click(); await menu.waitFor({ timeout: 5000 });
  assert.equal(await menu.locator('.draft-take .truncate').first().textContent(), '1 quote · first idea', 'the draft says it carries a quote');
  await menu.locator('.draft-take').first().click();
  await until(async () => (await composer.inputValue()) === 'first idea' && await chips.count() === 1, 'taken back: the text and the chip', 5000);
  assert.equal(await chips.first().getAttribute('title'), (await reply.locator('.md, p').first().textContent()).trim() + '\n\nkeep this', 'the chip has its quote and comment');
  await chips.first().locator('[data-quote-go]').click();
  await until(async () => await reply.evaluate((m) => m.classList.contains('quote-src')), 'a quote back from a draft saved in this window still finds its reply', 5000);
  await btn.click(); await menu.locator('.draft-del').first().click();
  await until(async () => await menu.count() === 0 && await btn.count() === 0, 'x deleted the last draft; no list, no Drafts', 5000);
  assert.equal(await composer.inputValue(), 'first idea', 'the box kept its text');
  assert.equal(await page.evaluate(() => localStorage.getItem('p9-drafts')), '[]', 'the store is empty');
  assert.deepEqual(errors, [], 'no page errors');
  console.log('PASS A2 step 7: Ctrl+S puts aside, Drafts lists newest first, pick brings back, x deletes, Esc closes');
});

// A2 step 7 review (#535): a full store changes nothing on a swap; a row another window took is redrawn away, not brought back;
// a menu whose pane now shows another chat takes nothing; a restored leading blank line survives a repaint.
test('A2 step 7 review: full store keeps the box, a taken row is not brought back, a moved pane takes nothing', { timeout: 90000 }, async (t) => {
  const { page, pane, errors } = await setup(t, 'a2-drafts-review');
  const composer = pane.locator('.composer textarea'), btn = pane.locator('[data-drafts]'), menu = page.locator('.drafts-menu');
  // As another window writes it; quiet: the storage event that window would send is missed (a stale row).
  const seed = (d, quiet) => page.evaluate(([d, quiet]) => { localStorage.setItem('p9-drafts', JSON.stringify(d)); if (!quiet) window.dispatchEvent(new StorageEvent('storage', { key: 'p9-drafts' })); }, [d, quiet]);
  const store = () => page.evaluate(() => JSON.parse(localStorage.getItem('p9-drafts')).map((x) => x.text));
  await seed([{ text: 'saved one', at: 1 }, { text: '\nblank first', at: 2 }]);
  await composer.click(); await page.keyboard.type('typed now'); await composer.evaluate((b) => b.dispatchEvent(new Event('input', { bubbles: true })));
  // Full store: picking a draft with text in the box must leave both as they were.
  await page.evaluate(() => { const o = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (k === 'p9-drafts') throw new DOMException('full', 'QuotaExceededError'); return o.call(this, k, v); }; window.__unfull = () => { Storage.prototype.setItem = o; }; });
  await btn.click(); await menu.waitFor({ timeout: 5000 });
  await menu.locator('.draft-take').first().click();
  await page.locator('#toasts .toast', { hasText: 'nothing changed' }).waitFor({ timeout: 5000 });
  assert.equal(await composer.inputValue(), 'typed now', 'the box kept its text');
  assert.deepEqual(await store(), ['saved one', '\nblank first'], 'the list is as it was');
  await page.evaluate(() => window.__unfull());
  // Another window took 'saved one' (no storage event in this window, so the row is stale): clicking it brings nothing back.
  await seed([{ text: '\nblank first', at: 2 }], true);
  await menu.locator('.draft-take', { hasText: 'saved one' }).click();
  await until(async () => await menu.locator('.draft-take', { hasText: 'saved one' }).count() === 0, 'the stale row redrawn away', 5000);
  assert.equal(await composer.inputValue(), 'typed now', 'nothing restored from the stale row');
  // The pane is no longer shown (as when another focus mode hides it): the open menu takes nothing and closes. A style rule,
  // not the pane's own attributes, which the next redraw puts back (CI: a redraw between the change and the click).
  const hide = await page.addStyleTag({ content: '.pane { visibility: hidden !important }' });
  await menu.locator('.draft-take').first().click();
  await until(async () => await menu.count() === 0, 'the menu closed', 5000);
  await hide.evaluate((el) => el.remove());
  assert.equal(await composer.inputValue(), 'typed now', 'nothing taken into a pane no longer shown');
  assert.deepEqual(await store(), ['\nblank first'], 'the draft is still saved');
  // Taken for real: the box text is saved in the same write, and the leading blank line is kept through a repaint.
  await btn.click(); await menu.waitFor({ timeout: 5000 }); await menu.locator('.draft-take').first().click();
  await until(async () => (await composer.inputValue()) === '\nblank first', 'the draft is in the box', 5000);
  assert.deepEqual(await store(), ['typed now'], 'the box text took its place in the list');
  await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'p9-drafts' }))); // a repaint
  await until(async () => (await btn.textContent())?.trim() === 'Drafts 1', 'repainted', 5000);
  assert.equal(await composer.inputValue(), '\nblank first', 'the leading blank line survived the repaint');
  // Review #536: two quote-only drafts saved in the same millisecond are two drafts, each labelled by its comment or words;
  // a quote from a draft another window saved finds no reply here, even one with the same words (no matching by words).
  await seed([{ id: 'a', text: '', at: 5, quotes: [{ text: 'echo:hello', comment: 'other chat' }] }, { id: 'b', text: '', at: 5, quotes: [{ text: 'more words', comment: '' }] }]);
  await btn.click(); await menu.waitFor({ timeout: 5000 });
  assert.deepEqual(await menu.locator('.draft-take .truncate').allTextContents(), ['1 quote · other chat', '1 quote · “more words”'], 'quote-only drafts say which');
  await menu.locator('.draft-del').nth(1).click();
  await until(async () => await menu.locator('.draft-take').count() === 1, 'x deleted only that one', 5000);
  await menu.locator('.draft-take').first().click();
  const chip = pane.locator('.attach .att-quote'); await until(async () => await chip.count() === 1, 'its chip', 5000);
  await chip.first().locator('[data-quote-go]').click();
  await page.locator('#toasts .toast', { hasText: 'is not available in this window' }).waitFor({ timeout: 5000 });
  assert.equal(await pane.locator('.msg.quote-src').count(), 0, 'no reply here marked as its source');
  // O267 (#535 round 2): another window's draft redraws the open menu; the focus stays on the draft chosen, and the taller
  // menu stays above Drafts.
  await seed([{ id: 'f1', text: 'first', at: 6 }, { id: 'f2', text: 'second', at: 7 }]);
  await btn.click(); await menu.waitFor({ timeout: 5000 }); await page.keyboard.press('ArrowDown');
  const focused = () => page.evaluate(() => document.activeElement?.closest('.draft')?.querySelector('.truncate')?.textContent);
  assert.equal(await focused(), 'second');
  await seed([{ id: 'f0', text: 'newest', at: 8 }, { id: 'f1', text: 'first', at: 6 }, { id: 'f2', text: 'second', at: 7 }]);
  await until(async () => await menu.locator('.draft-take').count() === 3, 'redrawn with the new draft', 5000);
  assert.equal(await focused(), 'second', 'the focus stayed on the same draft');
  assert.ok((await menu.boundingBox()).y + (await menu.boundingBox()).height <= (await btn.boundingBox()).y, 'the menu still sits above Drafts');
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, [], 'no page errors');
  console.log('PASS A2 step 7 review: full store, stale row, moved pane, leading newline, focus kept on a redraw');
});

// Review #536 round 2: a quote whose reply is above the drawn window (more than TAIL steps later) jumps there: the window
// widens, the reply is marked and in view, and stays so through a repaint.
test('A2 step 6 review: a chip whose reply is above the drawn steps widens the window and shows it', { timeout: 120000 }, async (t) => {
  const { page, pane, send, errors } = await setup(t, 'a2-quote-far');
  const box = page.locator('.quote-box'), chips = pane.locator('.attach .att-quote'), composer = pane.locator('.composer textarea');
  const hello = pane.locator('.msg.agent', { hasText: 'echo:hello' });
  await hello.hover(); await hello.locator('[data-quote-reply]').click(); await box.waitFor({ timeout: 5000 });
  await page.keyboard.type('far up'); await page.keyboard.press('Enter');
  await until(async () => await chips.count() === 1, 'a chip', 5000);
  await composer.click(); await page.keyboard.press('Control+s'); // aside, so the long turn's message does not carry it
  await until(async () => await chips.count() === 0, 'saved aside', 5000);
  await send('stream 150'); // 300 steps, more than the 200 drawn
  await until(async () => await pane.locator('.hist').getByText('step 150 done.').count() > 0 && await pane.locator('.working').count() === 0, 'the long turn ended', 60000);
  assert.equal(await hello.count(), 0, 'the quoted reply is above the drawn steps');
  await pane.locator('[data-drafts]').click(); await page.locator('.drafts-menu .draft-take').first().click();
  await until(async () => await chips.count() === 1, 'the chip is back from the draft', 5000);
  await chips.first().locator('[data-quote-go]').click();
  await until(async () => await hello.count() === 1 && await hello.evaluate((m) => { const r = m.getBoundingClientRect(), b = m.closest('.hist').getBoundingClientRect();
    return m.classList.contains('quote-src') && r.bottom > b.top && r.top < b.bottom; }), 'the window widened to the reply, marked and in view', 5000);
  // Repaints after the jump keep it drawn and in view: the mark ending, then another window's draft (the drafts count
  // changes, so the pane is drawn again; a sentinel on the reply proves the redraw went over it).
  await until(async () => !(await hello.evaluate((m) => m.classList.contains('quote-src'))), 'the mark ended', 5000);
  await hello.evaluate((m) => { m.setAttribute('data-sentinel', '1'); const d = JSON.parse(localStorage.getItem('p9-drafts') || '[]');
    localStorage.setItem('p9-drafts', JSON.stringify([{ id: 'other-window', text: 'from another window', at: Date.now() }, ...d])); window.dispatchEvent(new StorageEvent('storage', { key: 'p9-drafts' })); });
  await until(async () => await hello.count() === 1 && await hello.evaluate((m) => !m.hasAttribute('data-sentinel')), 'the history was drawn again', 5000);
  assert.ok(await hello.evaluate((m) => { const r = m.getBoundingClientRect(), b = m.closest('.hist').getBoundingClientRect(); return r.bottom > b.top && r.top < b.bottom; }), 'still in view');
  assert.deepEqual(errors, [], 'no page errors');
  console.log('PASS A2 step 6 review: a far quote widens the window and shows its reply');
});

// O266: after an automatic compaction the adapter sends the calls from before it again, same ids, pending, then each one's
// finish. The chat keeps the one row it has, finished; it drew a second one that stayed pending.
test('O266: a tool call sent again after a compaction keeps its one finished row', { timeout: 90000 }, async (t) => {
  const { pane, send, errors } = await setup(t, 'o266-repeat');
  await send('toolrepeat');
  await pane.locator('.msg.agent', { hasText: 'after repeat' }).waitFor({ timeout: 15000 });
  const rows = pane.locator('details.tool', { hasText: 'repeat me' });
  assert.equal(await rows.count(), 1, 'one row for the call');
  assert.equal((await rows.locator('[data-slot=badge]').first().textContent()).trim(), 'completed');
  assert.deepEqual(errors, [], 'no page errors');
});

// O266 review: the first call outside the newest 200 blocks a reloaded window loads, its second inside them. Show earlier
// brings the first's page: still one row, where the call first ran, finished.
test('O266 review 3: Show earlier keeps the first run\'s diff for a file the repeat names without one, and adds a streamed piece to its output', { timeout: 120000 }, async (t) => {
  const { page, pane, send, errors } = await setup(t, 'o266-files');
  await send('toolrepeat files');
  await pane.locator('.msg.agent', { hasText: 'after repeat files' }).waitFor({ timeout: 30000 });
  await page.reload();
  const fresh = page.locator('.pane .hist').filter({ hasText: 'after repeat files' }).first();
  await fresh.waitFor({ timeout: 30000 });
  await fresh.locator('[data-earlier]').click();
  await fresh.locator('details.tool', { hasText: 'step 0' }).waitFor({ timeout: 15000 });
  const rows = fresh.locator('details.tool', { hasText: 'repeat edit' });
  assert.equal(await rows.count(), 1, 'one row for the call');
  assert.match(await rows.first().textContent(), /first run output and a streamed piece/, 'the streamed piece is added to the first run\'s output, not put in its place');
  const diffRows = fresh.locator('details.tool', { hasText: 'diff replay' });
  assert.equal(await diffRows.count(), 1, 'one row for the call repeated with its diff');
  assert.match(await diffRows.first().textContent(), /diff tool output/, 'a repeat that carries only its diff keeps the first run\'s output');
  await page.locator('.pane [data-chat-files]').first().click();
  await page.locator('#side .cf-tabs [role=tab]').nth(1).dispatchEvent('click'); // a card in this window's corner covers the tab
  const item = page.locator('#side .cf-item[data-cf-file]', { hasText: 'kept.md' });
  await item.waitFor({ timeout: 8000 });
  assert.match(await item.textContent(), /\+1 −1/, 'the file keeps the first run\'s diff: ' + await item.textContent());
  // Review 5: other.md came only with the repeated call, which the live view skips, so Show earlier does not add it either.
  assert.doesNotMatch(await diffRows.first().textContent(), /other\.md/, 'the repeat\'s own diff is not put on the first run');
  assert.equal(await page.locator('#side .cf-item[data-cf-file]', { hasText: 'other.md' }).count(), 0, 'no change for a file only the repeat named');
  // Review 8: a diff-only update after the repeat, then a whole snapshot: the snapshot does not take the update that brought the file.
  await page.locator('#side .cf-item[data-cf-file]', { hasText: 'edited.md' }).waitFor({ timeout: 8000 });
  assert.match(await fresh.locator('details.tool', { hasText: 'snapshot edit' }).first().textContent(), /third snapshot/, 'the snapshot is the row\'s output');
  assert.deepEqual(errors, [], 'no page errors');
});

test('O266: Show earlier across a compaction still draws the call once, finished, where it first ran', { timeout: 120000 }, async (t) => {
  const { page, pane, send, errors } = await setup(t, 'o266-earlier');
  await send('toolrepeat far');
  await pane.locator('.msg.agent', { hasText: 'after repeat' }).waitFor({ timeout: 30000 });
  await page.reload();
  const fresh = page.locator('.pane .hist').filter({ hasText: 'after repeat' }).first();
  await fresh.waitFor({ timeout: 30000 });
  const rows = fresh.locator('details.tool', { hasText: 'repeat me' });
  assert.equal(await rows.count(), 1, 'the newest blocks hold the second call');
  assert.equal(await fresh.locator('details.tool', { hasText: 'step 0' }).count(), 0, 'and not the first: it is on the earlier page');
  await fresh.locator('[data-earlier]').click();
  await fresh.locator('details.tool', { hasText: 'step 0' }).waitFor({ timeout: 15000 });
  assert.equal(await rows.count(), 1, 'one row for the call after Show earlier');
  assert.equal((await rows.locator('[data-slot=badge]').first().textContent()).trim(), 'completed');
  assert.match(await rows.first().textContent(), /first run output/, 'the first run\'s output is kept, not replaced by the status-only repeat');
  assert.equal(await fresh.evaluate((h) => { const all = [...h.querySelectorAll('details.tool')], at = (w) => all.findIndex((d) => d.textContent.includes(w)); return at('repeat me') < at('step 0'); }), true, 'where it first ran, above the calls after it');
  assert.deepEqual(errors, [], 'no page errors');
});
