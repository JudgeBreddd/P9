// O135 part B (apps/desktop/use-installed.mjs): whether the window asks to move a service that runs another copy onto the
// installed daemon. The answer is ask, leave (the user said keep for this same checkout) or nothing; a checkout kept once
// stays kept across starts (keep-my-setup.json), and a different checkout is asked about again.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { daemonOffer, keptCheckout, keepText } from '../apps/desktop/use-installed.mjs';
import * as offer from '../apps/desktop/use-installed.mjs';

const installed = '/users/u/.local/share/p9/daemon';
const result = { checkout: '/usr/bin/node /srv/src/p9/apps/server/main.mjs', seen: '{ path=/usr/bin/node ; argv[]=/usr/bin/node /srv/src/p9/apps/server/main.mjs ; pid=0 }\n' };
const base = { result, from: '/srv/src/p9', keep: null, unit: true, installed };

test('O135 offer: ask, leave or nothing from the service answer, /health from, the kept checkout and the unit', () => {
  for (const [why, change, want] of [
    ['another copy, no keep', {}, 'ask'],
    ['a daemon older than /health from', { from: undefined }, 'ask'],
    ['no daemon answer at all', { from: null }, 'ask'],
    ['the user kept this checkout', { keep: result.checkout }, 'leave'],
    ['the user kept a different checkout', { keep: '/usr/bin/node /old/main.mjs' }, 'ask'],
    ['the launcher unit (nothing returned)', { result: undefined }, 'nothing'],
    ['systemd could not be read', { result: { checkout: null } }, 'nothing'],
    ['a checkout with no ExecStart seen', { result: { checkout: result.checkout } }, 'nothing'],
    ['a missing library instead', { result: { missing: 'libatomic1' } }, 'nothing'],
    ['no unit file', { unit: false }, 'nothing'],
    ['the daemon already runs from the installed folder', { from: installed + '/5.0.0' }, 'nothing'],
    ['a folder that only starts with the installed name', { from: installed + '-old/5.0.0' }, 'ask'],
  ]) assert.equal(daemonOffer({ ...base, ...change }), want, why);
});

test('O135 offer: keep my setup as written reads back as kept on the next start; a missing or broken file is no keep', () => {
  assert.equal(daemonOffer({ ...base, keep: keptCheckout(keepText(result.checkout)) }), 'leave', 'asked again after keep');
  for (const text of ['', '{', 'null', '{"checkout":5}']) assert.equal(keptCheckout(text), null, JSON.stringify(text));
});

test('O135 offer: Keep my setup that cannot be written says why (main.mjs shows and logs it), not silence', async (t) => {
  assert.equal(typeof offer.failureOf, 'function', 'no failureOf: a failed Keep my setup write is swallowed (main.mjs .catch(() => {})) and P9 just asks again');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'o135-keep-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // The write main.mjs makes, into a folder that can be made, and into one under a plain file (it fails).
  const write = (p9) => fs.promises.mkdir(p9, { recursive: true, mode: 0o700 }).then(() => fs.promises.writeFile(path.join(p9, 'keep-my-setup.json'), keepText(result.checkout), { mode: 0o600 }));
  const good = path.join(dir, 'p9');
  assert.equal(await offer.failureOf(write(good)), null);
  assert.equal(daemonOffer({ ...base, keep: keptCheckout(fs.readFileSync(path.join(good, 'keep-my-setup.json'), 'utf8')) }), 'leave');
  const blocked = path.join(dir, 'blocked'); fs.writeFileSync(blocked, 'not a folder');
  const why = await offer.failureOf(write(path.join(blocked, 'p9')));
  assert.equal(typeof why, 'string', 'a failed write answered ' + JSON.stringify(why));
  assert.match(why, /ENOTDIR|EEXIST|not a directory/, why);
  // The window uses that answer: the same write, no swallowed catch, a warning with the reason, a log line.
  const main = fs.readFileSync(new URL('../apps/desktop/main.mjs', import.meta.url), 'utf8');
  const branch = main.slice(main.indexOf('if (response === 1)'), main.indexOf('if (response !== 2)'));
  assert.ok(branch.includes('await failureOf(mkdir(p9, { recursive: true, mode: 0o700 }).then(() => writeFile(keepFile, keepText(result.checkout), { mode: 0o600 })))') && !branch.includes('.catch(() => {})'), branch);
  assert.ok(branch.includes("updateLog('keep my setup not saved: ' + failed)") && branch.includes("type: 'warning'") && branch.includes('detail: failed'), branch);
  console.log('PASS O135 keep: a write under a plain file says ' + JSON.stringify(why) + '; the window warns with it and logs it; a good write reads back as kept');
});

test('O135 offer: a Keep my setup warning or offer dialog that throws or rejects is logged, not an unhandled rejection', async () => {
  assert.equal(typeof offer.guarded, 'function', 'no guarded: a rejecting Keep my setup warning (main.mjs returns dialog.showMessageBox with no catch) is an unhandled rejection');
  const lines = [], log = (line) => lines.push(line);
  // A dialog that rejects, one that throws before it returns, and one that answers.
  assert.equal(await offer.guarded(() => Promise.reject(new Error('window gone')), log, 'keep my setup warning failed'), null);
  assert.equal(await offer.guarded(() => { throw new TypeError('no window'); }, log, 'keep my setup warning failed'), null);
  assert.deepEqual(await offer.guarded(() => Promise.resolve({ response: 0 }), log, 'keep my setup warning failed'), { response: 0 });
  assert.deepEqual(lines, ['keep my setup warning failed: window gone', 'keep my setup warning failed: no window']);
  // main.mjs: the warning goes through guarded with that label and no second dialog; the whole offer chain ends in a logged catch.
  const main = fs.readFileSync(new URL('../apps/desktop/main.mjs', import.meta.url), 'utf8');
  const branch = main.slice(main.indexOf('if (response === 1)'), main.indexOf('if (response !== 2)'));
  assert.ok(branch.includes('return guarded(() => dialog.showMessageBox(window, {') && branch.includes("updateLog, 'keep my setup warning failed')"), branch);
  assert.equal(branch.split('showMessageBox').length - 1, 1, 'one dialog in the Keep my setup branch: ' + branch);
  const start = main.indexOf('serviceResult?.then(async (result) => {'), chain = main.slice(start, main.indexOf('if (watched) {', start));
  assert.match(chain, /\}\)\.catch\(\(error\) => updateLog\('use installed offer failed: ' \+ \(error\?\.message \|\| String\(error\)\)\)\);\s*$/, chain.slice(-200));
  console.log('PASS O135 warning: a rejecting and a throwing dialog are each one log line; the offer chain ends in a logged catch');
});

