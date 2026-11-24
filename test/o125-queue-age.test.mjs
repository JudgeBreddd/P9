// O125 (4), what #351 left: the "N queued" strip's oldest wait counts the desktop's local queue (an agent without
// steering), not only held messages; the phone's strip shows it too (phone-o109, phone-continue).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as composer from '../apps/web/src/composer.mjs';

test('O125 left: the desktop strip counts the local queue in its oldest wait', () => {
  const { strip } = composer;
  const since = (at) => `${Math.round((NOW - at) / 60000)}m`, NOW = Date.now();
  const summary = (s) => /<summary>([^<]*)<\/summary>/.exec(strip(s, since, ''))[1];
  // Only the local queue, one queued 7 minutes ago: before, "1 queued" with no time.
  assert.equal(summary({ queue: [{ t: 'later', at: NOW - 7 * 60000 }] }), '1 queued, oldest waiting 7m');
  // Held and local: the older of the two, whichever kind.
  assert.equal(summary({ held: [{ id: 'h', text: 'x', when: 'queue', at: NOW - 3 * 60000 }], queue: [{ t: 'a', at: NOW - 9 * 60000 }] }), '2 queued, oldest waiting 9m');
  assert.equal(summary({ held: [{ id: 'h', text: 'x', when: 'queue', at: NOW - 12 * 60000 }], queue: [{ t: 'a', at: NOW - 2 * 60000 }] }), '2 queued, oldest waiting 12m');
  // An item with no time (kept by an older build) adds to the count only.
  assert.equal(summary({ queue: [{ t: 'old' }] }), '1 queued');
  assert.equal(summary({ queue: [{ t: 'old' }, { t: 'new', at: NOW - 60000 }] }), '2 queued, oldest waiting 1m');

  console.log('PASS O125 left: the desktop strip counts its local queue (oldest waiting 7m), held and local together');
});
