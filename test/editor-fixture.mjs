// The pinned editor server (VSCodium REH) for tests that run it: test/dev.test.mjs (Dev Focus) and test/remote.test.mjs
// (Server mode's Dev Focus, where the server's daemon starts it). Returns { host, path } for P9_EDITOR_HOST and PATH, or null.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { root } from './helpers.mjs';
import { EDITOR_DIR } from '../apps/desktop/editor-host.mjs';

const host = process.env.P9_EDITOR_HOST ?? path.join(EDITOR_DIR, 'codium-server');
// The dev space has no editor server and no systemd user bus. There, the pinned release is unpacked from the private fixtures folder
// (untracked: the sprint put it there) and started through a stand-in systemd-run that only runs the command; on a machine
// with the editor server and a user bus (the server itself, CI) the real ones are used.
const fixtures = path.join(root, '_private', 'fixtures');
let preparedEditor;
export const editorFor = () => preparedEditor ??= (async () => {
  if (process.platform !== 'linux') return null;
  const bus = spawnSync('systemd-run', ['--user', '--scope', '--quiet', 'true'], { timeout: 10000 }).status === 0;
  if (existsSync(host) && bus) return { host, path: process.env.PATH };
  if (!existsSync(path.join(fixtures, 'reh.tar.gz'))) return null;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-reh-')), unpacked = path.join(dir, 'codium-server'), shims = path.join(dir, 'shims');
  await mkdir(unpacked); await mkdir(shims);
  assert.equal(spawnSync('tar', ['-xzf', path.join(fixtures, 'reh.tar.gz'), '-C', unpacked]).status, 0);
  // Stand-ins for the user manager: systemd-run records which process is the scope's, and systemctl stop/kill ends it and its children.
  const pids = path.join(dir, 'pids'); await mkdir(pids);
  await writeFile(path.join(shims, 'systemd-run'), [`#!${process.execPath}`,
    "const fs = require('fs'), { spawn } = require('child_process');",
    "const args = process.argv.slice(2), unit = (args.find(a => a.startsWith('--unit=')) ?? '').slice(7), at = args.findIndex(a => !a.startsWith('--'));",
    `fs.writeFileSync(${JSON.stringify(pids)} + '/' + unit, String(process.pid));`,
    "spawn(args[at], args.slice(at + 1), { stdio: 'inherit' }).on('exit', code => process.exit(code ?? 1));", ''].join('\n'), { mode: 0o755 });
  await writeFile(path.join(shims, 'systemctl'), [`#!${process.execPath}`,
    "const fs = require('fs'), args = process.argv.slice(2), unit = args.find(a => a.endsWith('.scope'));",
    "if (!unit || !args.some(a => a === 'stop' || a === 'kill')) process.exit(0);",
    `let root; try { root = Number(fs.readFileSync(${JSON.stringify(pids)} + '/' + unit.slice(0, -6), 'utf8')); } catch { process.exit(0); }`,
    "const parent = {}; for (const d of fs.readdirSync('/proc').filter(n => /^[0-9]+$/.test(n))) { try { parent[d] = fs.readFileSync('/proc/' + d + '/stat', 'utf8').replace(/^.*[)] /, '').split(' ')[1]; } catch {} }",
    "const kill = pid => { for (const [child, p] of Object.entries(parent)) if (Number(p) === pid) kill(Number(child)); try { process.kill(pid, 'SIGKILL'); } catch {} };",
    'kill(root);', ''].join('\n'), { mode: 0o755 });
  return { host: unpacked, path: shims + ':' + process.env.PATH };
})();
