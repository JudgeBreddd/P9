import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from '@playwright/test';
import { remoteDaemon, enrollDevice, passkeyDevice } from './helpers.mjs';

const evidence = process.env.P9_SCREENSHOTS || path.join(os.tmpdir(), 'p9-phone-c16');

// A phone-sized touch browser on the phone page, signed in, with every frame the page sends on a socket recorded
// (the bytes after the 8-byte lease, as text) so a test reads exactly what reached the terminal.
async function phone(t, server, { touchScreen = true } = {}) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ hasTouch: touchScreen, viewport: { width: 390, height: 844 } });
  await context.addInitScript(() => {
    window.p9sent = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (data instanceof Uint8Array) window.p9sent.push(new TextDecoder().decode(data.subarray(8)));
      return send.call(this, data);
    };
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal',
    hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await page.goto(server.origin + '/login');
  const session = await enrollDevice(server, { name: 'phone-terminal-touch', page, context });
  await context.addCookies([{ name: 'p9s', value: session.token, url: server.origin, httpOnly: true, secure: true, sameSite: 'Strict' }]);
  await page.goto(server.origin + '/phone/');
  await page.evaluate((csrf) => sessionStorage.setItem('p9-csrf', csrf), session.csrf);
  await page.reload();
  // ponytail: the dev space runs tests with no network, so Chromium says navigator.onLine is false and the phone keeps
  // New terminal disabled; say online here rather than change the sandbox (same as the other phone terminal tests).
  await context.addInitScript(() => { Object.defineProperty(navigator, 'onLine', { get: () => true, configurable: true }); });
  await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { get: () => true, configurable: true }); dispatchEvent(new Event('online')); });
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
  return { page, cdp, touch, session, context };
}

const connected = (page) => page.waitForFunction(() => document.querySelector('#termState').textContent === 'Connected', null, { timeout: 15000 });
const sent = (page) => page.evaluate(() => window.p9sent.join(''));
// A finger drag on the screen: down at the first point, moves through the rest, up at the last.
async function drag(page, touch, from, to, steps = 12) {
  await touch('touchStart', [from]);
  for (let i = 1; i <= steps; i++) {
    await touch('touchMove', [[from[0] + (to[0] - from[0]) * i / steps, from[1] + (to[1] - from[1]) * i / steps]]);
    await page.waitForTimeout(16);
  }
  await touch('touchEnd', []);
}

test('T1: a touch scroll on the phone terminal never sends NaN or out-of-range bytes (cursor keys in a shell, valid wheel reports when the program wants the mouse)', { timeout: 120000 }, async (t) => {
  await mkdir(evidence, { recursive: true });
  const server = await remoteDaemon(t, {});
  const { page, touch } = await phone(t, server);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('[data-nav="terminal"]');
  await page.click('#newTerminal');
  await connected(page);
  await page.click('#screen'); await page.keyboard.type('seq 1 300'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#screen .xterm-rows')?.textContent.includes('300'), null, { timeout: 10000 });
  const box = await page.locator('#screen').boundingBox();
  const x = box.x + box.width / 2, y0 = box.y + box.height * 0.3, y1 = box.y + box.height * 0.8;
  // 1. No mouse mode (a shell): xterm turns a drag into cursor keys, never a mouse report, never a bad number.
  let mark = (await sent(page)).length;
  await drag(page, touch, [x, y0], [x, y1]);
  await page.waitForTimeout(300);
  const plain = (await sent(page)).slice(mark);
  assert.ok(!/NaN|undefined|Infinity|\0/.test(plain) && /^(\x1b[\[O][AB])*$/.test(plain), 'a drag in a shell sent ' + JSON.stringify(plain));
  // 2. The program asked for mouse reports (Claude Code does; so does tmux with mouse on in a normal window): the scroll
  // is wheel reports, numbers on the screen, nothing else. Raw printf: control mode hands the pane's own output through.
  await page.click('#screen'); await page.keyboard.type("printf '\\033[?1000h\\033[?1006h'"); await page.keyboard.press('Enter');
  await page.waitForSelector('#screen .enable-mouse-events', { timeout: 10000 });
  await page.screenshot({ path: path.join(evidence, 'phone-terminal-before-scroll.png') });
  mark = (await sent(page)).length;
  // Finger down the screen = older lines (the page scrolls up), a few times, so enough distance for several reports.
  for (let i = 0; i < 3; i++) await drag(page, touch, [x, y0], [x, y1]);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(evidence, 'phone-terminal-after-scroll.png') });
  const gesture = (await sent(page)).slice(mark);
  console.log('touch scroll sent ' + JSON.stringify(gesture.slice(0, 120)));
  // Nothing from a scroll gesture is NaN, and every number in a wheel report is a column and row on the screen.
  assert.ok(!/NaN|undefined|Infinity/.test(gesture), 'a touch scroll sent ' + JSON.stringify(gesture));
  const reports = [...gesture.matchAll(/\x1b\[<(\d+);(\d+);(\d+)M/g)];
  assert.ok(reports.length > 0, 'the scroll sent no wheel reports; sent ' + JSON.stringify(gesture));
  const rows = await page.evaluate(() => document.querySelector('#screen .xterm-rows').children.length);
  for (const [, button, col, row] of reports) {
    assert.ok(button === '64' || button === '65', 'a scroll sent a non-wheel report ' + button);
    assert.ok(Number(col) >= 1 && Number(col) <= 500 && Number(row) >= 1 && Number(row) <= rows, `wheel report at ${col};${row} is off the screen`);
  }
  assert.equal(gesture.replace(/\x1b\[<\d+;\d+;\d+M/g, ''), '', 'a scroll sent bytes that are not wheel reports: ' + JSON.stringify(gesture));
  // 3. The desktop dock's input is the mouse, which carries real coordinates: a wheel over a known cell goes out untouched
  // (the same createTerminal serves the dock, so this is the check that the dock's mouse reports did not change).
  mark = (await sent(page)).length;
  await page.mouse.move(box.x + 100, box.y + 100);
  await page.mouse.wheel(0, -100);
  await page.waitForFunction((n) => window.p9sent.join('').length > n, mark, { timeout: 5000 });
  const wheel = (await sent(page)).slice(mark);
  const cell = await page.evaluate(() => { const r = document.querySelector('#screen .xterm-screen').getBoundingClientRect(), row = document.querySelector('#screen .xterm-rows > div').getBoundingClientRect(); return { w: r.width, h: row.height, left: r.left, top: r.top }; });
  const m = /^\x1b\[<64;(\d+);(\d+)M$/.exec(wheel);
  assert.ok(m, 'a mouse wheel sent ' + JSON.stringify(wheel));
  assert.equal(Number(m[2]), Math.floor((box.y + 100 - cell.top) / cell.h) + 1, 'the dock-style wheel report moved to row ' + m[2]);
  assert.ok(Number(m[1]) > 1, 'the dock-style wheel report was not at the pointer column ' + m[1]);
  console.log('PASS T1: a 390x844 touch scroll sent only cursor keys (shell) or ' + reports.length + ' valid wheel reports (mouse mode); a mouse wheel is untouched: ' + JSON.stringify(wheel));
});


// T2: a finger's tap on the terminal puts the focus in xterm's input box, which is what raises a phone's keyboard.
// A test cannot see the operating system's keyboard; it can see the three things that decide it: the tap is a real touch,
// the focus ends in a writable (not readonly) input, and what is typed there reaches the program.
test('T2: a tap on the phone terminal focuses a writable input and typing reaches the program', { timeout: 120000 }, async (t) => {
  await mkdir(evidence, { recursive: true });
  const server = await remoteDaemon(t, {});
  const { page, touch } = await phone(t, server);
  await page.click('[data-nav="terminal"]');
  await page.click('#newTerminal');
  await connected(page);
  await page.evaluate(() => document.activeElement?.blur());
  const focus = () => page.evaluate(() => { const a = document.activeElement; return { tag: a?.tagName, cls: a?.className, readOnly: a?.readOnly, disabled: a?.disabled, inScreen: !!a?.closest('#screen') }; });
  assert.equal((await focus()).inScreen, false, 'the focus should start outside the terminal');
  const box = await page.locator('#screen').boundingBox();
  // A scroll drag is not a tap: it must not raise the keyboard over the screen being read.
  await drag(page, touch, [box.x + box.width / 2, box.y + box.height * 0.7], [box.x + box.width / 2, box.y + box.height * 0.3]);
  await page.waitForTimeout(300);
  assert.equal((await focus()).inScreen, false, 'a scroll drag raised the keyboard');
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(300);
  const got = await focus();
  await page.screenshot({ path: path.join(evidence, 'phone-terminal-tap.png') });
  assert.deepEqual({ tag: got.tag, inScreen: got.inScreen, readOnly: got.readOnly, disabled: got.disabled }, { tag: 'TEXTAREA', inScreen: true, readOnly: false, disabled: false }, 'a tap left the focus at ' + JSON.stringify(got));
  const mark = (await sent(page)).length;
  await page.keyboard.type('echo kbd');
  await page.waitForTimeout(300);
  assert.equal((await sent(page)).slice(mark), 'echo kbd', 'what was typed after the tap did not reach the program');
  console.log('PASS T2: a touch tap focused ' + got.tag + ' (' + got.cls + '), writable, and typing reached the program');
});

// Item 4: the phone's Paste is a bracketed paste when the program asked for one (a shell, Claude Code), plain text when not.
test('Item 4: Paste wraps in the bracketed-paste markers only when the program turned them on, and cannot close the bracket early', { timeout: 120000 }, async (t) => {
  await mkdir(evidence, { recursive: true });
  const server = await remoteDaemon(t, {});
  const { page } = await phone(t, server);
  await page.click('[data-nav="terminal"]');
  await page.click('#newTerminal');
  await connected(page);
  const clip = (text) => page.evaluate((value) => { navigator.clipboard.readText = async () => value; }, text);
  const pasted = async (text) => {
    await clip(text);
    const mark = (await sent(page)).length;
    await page.click('[data-key="paste"]');
    await page.waitForTimeout(400);
    return (await sent(page)).slice(mark);
  };
  // What a program does: sets bracketed paste (DEC mode 2004) on or off and keeps the terminal (cat just echoes, so nothing
  // pasted here runs). A shell is no good for "off": its line editor turns the mode back on at every prompt.
  const program = async (mode) => {
    await page.click('#screen'); await page.keyboard.press('Control+c');
    await page.keyboard.type("printf '\\033[?2004" + mode + "'; cat"); await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
  };
  const two = 'first line\nsecond line';
  await program('l');
  assert.equal(await pasted(two), 'first line\rsecond line', 'mode off: plain text, newline as Enter');
  await program('h');
  assert.equal(await pasted(two), '\x1b[200~first line\rsecond line\x1b[201~', 'mode on: one bracketed paste');
  const hostile = await pasted('safe\x1b[201~rm -rf /tmp/x');
  assert.equal(hostile, '\x1b[200~saferm -rf /tmp/x\x1b[201~', 'the pasted text closed the bracket early');
  console.log('PASS Item 4: mode off sent ' + JSON.stringify('first line\rsecond line') + '; mode on wrapped it in 200~/201~; an embedded end marker was dropped');
});
