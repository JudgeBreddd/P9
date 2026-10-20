#!/usr/bin/env node
// Refuse a heavy test run while the laptop is already short of memory. The scope cap
// only limits the tests; when the whole machine runs short, systemd-oomd kills the
// biggest unit, which is usually Builder's hub (2026-10-17: hub-vscode-web killed with
// swap 12.1/15.2 GB full, the test that tipped it peaked at 852 MB).
// ponytail: fixed thresholds, tune here if they refuse runs that would have been fine.
import { readFileSync } from 'node:fs';

const MIN_AVAILABLE_GIB = 4;
const MAX_SWAP_USED = 0.6;

const kib = Object.fromEntries(readFileSync('/proc/meminfo', 'utf8').trim().split('\n')
  .map((line) => { const [k, v] = line.split(/:\s+/); return [k, parseInt(v, 10)]; }));
const availGib = kib.MemAvailable / 1048576;
const swapUsed = kib.SwapTotal ? (kib.SwapTotal - kib.SwapFree) / kib.SwapTotal : 0;

const problems = [];
if (availGib < MIN_AVAILABLE_GIB) problems.push(`only ${availGib.toFixed(1)} GiB memory available (need ${MIN_AVAILABLE_GIB})`);
if (swapUsed > MAX_SWAP_USED) problems.push(`swap ${(swapUsed * 100).toFixed(0)}% full (limit ${MAX_SWAP_USED * 100}%)`);
if (problems.length) {
  console.error(`mem-guard: not running tests: ${problems.join('; ')}. Close something or wait, then retry.`);
  process.exit(1);
}
console.error(`mem-guard: ok (${availGib.toFixed(1)} GiB available, swap ${(swapUsed * 100).toFixed(0)}%)`);
