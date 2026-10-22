import test from 'node:test';
import { daemon } from './helpers.mjs';

// The daemon start alone, timed (the Stop test's daemon printed nothing in 20 s on CI, runs 39732594547 and 39736142911).
// The Windows installer workflow runs it once with each chunk-3 suspect switched off; a timeout prints where it hung.
test('Windows daemon reaches P9_READY', { skip: process.platform !== 'win32' && 'requires Windows', timeout: 60000 }, async (t) => {
  const began = Date.now();
  await daemon(t);
  console.log(`daemon start: ${Date.now() - began} ms`);
});
