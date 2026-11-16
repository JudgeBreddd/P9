#!/usr/bin/env node
// Run a command with TMPDIR set to a fresh folder, deleted afterwards. The tests make temp homes
// with mkdtemp and never remove them; /tmp is RAM on the laptop, and 6,677 leftovers (3.3 GB)
// got Builder's apps killed by oomd (2026-10-17).
// TEMP/TMP as well: Windows' os.tmpdir() reads those, not TMPDIR (the Windows desktop kept its leftovers, 2026-10-17).
// P9_FIRST_RUN=off: the desktop skips the first start's setup wizard and walkthrough, whose dialogs would cover the shell the
// tests click (start-chat.test turns it on).
// ponytail: a hard kill of this wrapper leaves its one folder; node --test run directly skips the wrapper.
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(path.join(os.tmpdir(), 'p9-run-'));
process.on('SIGINT', () => {}); // Ctrl+C stops the child; we stay to clean up.
const [command, ...rest] = process.argv.slice(2);
// `node --test`: each file process also gets its own TMPDIR, removed when that file ends (tmp-per-file.mjs, O77).
const perFile = pathToFileURL(path.join(import.meta.dirname, 'tmp-per-file.mjs')).href;
const args = command === 'node' && rest.includes('--test') ? ['--import', perFile, ...rest] : rest;
const result = spawnSync(command, args, { stdio: 'inherit', env: { ...process.env, TMPDIR: dir, TEMP: dir, TMP: dir, P9_FIRST_RUN: process.env.P9_FIRST_RUN ?? 'off' } });
rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
if (result.status === null) console.error(`with-tmp: ${command} ended by ${result.signal ?? result.error?.message}, no exit code`);
process.exit(result.status ?? 1);
