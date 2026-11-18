// O135 part B (apps/desktop/use-installed.mjs): whether the window asks to move a service that runs another copy onto the
// installed daemon. The answer is ask, leave (the user said keep for this same checkout) or nothing; a checkout kept once
// stays kept across starts (keep-my-setup.json), and a different checkout is asked about again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { daemonOffer, keptCheckout, keepText } from '../apps/desktop/use-installed.mjs';

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
