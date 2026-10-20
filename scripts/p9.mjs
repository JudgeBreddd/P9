#!/usr/bin/env node
// p9: open the P9 app connected to the daemon. p9 edit <file>[:line] | p9 diff <a> <b>: open workspace files in its Dev Focus (threat model row 14).
// Checked here for a clear error, and again in the desktop, which is the boundary.
import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { health } from './teh.mjs';

const fail = message => { console.error('p9: ' + message); process.exit(2); };
const { values, positionals } = parseArgs({ allowPositionals: true, options: { state: { type: 'string' } } });
const state = values.state ?? (process.env.XDG_RUNTIME_DIR && path.join(process.env.XDG_RUNTIME_DIR, 'p9-foundation'));
const [verb, ...files] = positionals;
if (verb !== undefined && !(verb === 'edit' && files.length === 1) && !(verb === 'diff' && files.length === 2)) fail('usage: p9 | p9 edit <file>[:line] | p9 diff <a> <b>');
if (!state) fail('no daemon state folder; pass --state');
let workspace, open;
if (verb) try { workspace = await realpath((await health(state)).workspace); } catch { fail('the P9 daemon is not answering'); }
const check = async file => {
  const real = await realpath(path.resolve(file)).catch(() => fail(file + ': no such file'));
  if (!real.startsWith(workspace + path.sep)) fail(file + ': outside the workspace (' + workspace + ')');
  if (!(await stat(real)).isFile()) fail(file + ': not a file');
  return real;
};
if (verb === 'edit') {
  const [, name, line] = files[0].match(/^(.*?)(?::(\d+))?$/);
  open = { open: 'edit', path: await check(name), line: line ? Number(line) : 1 };
  if (!(open.line >= 1 && open.line <= 10000000)) fail('line must be 1 to 10,000,000');
} else if (verb === 'diff') open = { open: 'diff', a: await check(files[0]), b: await check(files[1]) };
// A running app takes the request over Electron's single-instance lock and this process exits; otherwise it becomes the app.
const electron = createRequire(import.meta.url)('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
spawn(electron, [fileURLToPath(new URL('../apps/desktop/start.cjs', import.meta.url)), '--state', state, ...(open ? ['--p9-open', JSON.stringify(open)] : [])],
  { detached: true, stdio: 'ignore', env }).unref();
