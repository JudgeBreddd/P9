// D15a (threat model row 67): installing P9 on a remote that has none, through a stand-in ssh that runs the command in a
// stand-in home on this machine. install.sh is a stub that records its arguments and what it read from stdin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { installRemote, script, slimArchive, sourceArchive } from '../apps/desktop/remote-install.mjs';

const skip = process.platform === 'win32' ? 'sh' : false;

async function stage() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-rinstall-')), home = path.join(dir, 'home'), bin = path.join(dir, 'bin');
  await mkdir(home); await mkdir(bin); await mkdir(path.join(dir, 'src', 'p9', 'scripts'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'p9', 'scripts', 'install.sh'),
    'echo "ARGS $*" > "$HOME/args.txt"; cat > "$HOME/stdin.txt"; echo "Built in ' + dir + '/deep/folder/build.log"\n');
  await writeFile(path.join(dir, 'src', 'p9', 'README.md'), 'p9\n');
  // ssh: the options and host are dropped, the last argument runs as the remote's login shell would run it.
  const ssh = path.join(bin, 'ssh');
  await writeFile(ssh, '#!/bin/sh\nfor last; do :; done\necho "$*" >> "' + dir + '/ssh-args.txt"\nexport HOME="' + home + '" PATH="' + bin + ':$PATH"\nexec sh -c "$last"\n');
  // curl for a packaged app's download: logs the URL, writes the stage's archive.
  await writeFile(path.join(bin, 'curl'), '#!/bin/sh\nfor a; do [ "$prev" = -o ] && out="$a"; prev="$a"; done\nfor last; do :; done\necho "$last" >> "' + dir + '/urls.txt"\ntar -czf "$out" -C "' + dir + '/src" p9\n');
  await chmod(ssh, 0o755); await chmod(path.join(bin, 'curl'), 0o755);
  const archive = () => spawn('tar', ['-czf', '-', '-C', path.join(dir, 'src'), 'p9'], { stdio: ['ignore', 'pipe', 'ignore'] }).stdout;
  return { dir, home, ssh, archive };
}
const exists = (p) => access(p).then(() => true, () => false);

test('D15a: a checkout\'s source lands in ~/p9 there and install.sh runs headless with no input', { skip, timeout: 30000 }, async () => {
  const s = await stage(), events = [];
  const result = await installRemote({ host: 'test-host', ssh: s.ssh, archive: s.archive(), version: '0.1.6', tell: (e) => events.push(e) });
  assert.equal(result.phase, 'done', JSON.stringify(result));
  assert.equal(await readFile(path.join(s.home, 'args.txt'), 'utf8'), 'ARGS --headless --background\n');
  assert.equal(await readFile(path.join(s.home, 'stdin.txt'), 'utf8'), '', 'install.sh reads no answer, so its admin ask says no');
  assert.ok(await exists(path.join(s.home, 'p9', 'README.md')) && await exists(path.join(s.home, 'p9', '.p9-remote-install')));
  // ssh gets BatchMode, the host as its own argument, and the archive never in the command.
  const argv = await readFile(path.join(s.dir, 'ssh-args.txt'), 'utf8');
  assert.match(argv, /^-o BatchMode=yes .* test-host sh -c /);
  // What the window shows names files, never where they are on the remote.
  const shown = JSON.stringify(events);
  assert.ok(shown.includes('build.log') && !shown.includes(s.dir), shown);
  // A failed install can be tried again: its own ~/p9 gets this app's source over it, so an older app's install.sh
  // (an arm64 test server, 2026-10-31: the old "XDG_RUNTIME_DIR: not set" at line 20 on every retry) is replaced before it runs.
  await writeFile(path.join(s.home, 'p9', 'scripts', 'install.sh'), 'echo "XDG_RUNTIME_DIR: not set"; exit 1\n');
  await writeFile(path.join(s.home, 'p9', 'node_modules-kept'), 'built\n');
  assert.equal((await installRemote({ host: 'test-host', ssh: s.ssh, archive: s.archive(), version: '0.1.6' })).phase, 'done');
  assert.equal(await readFile(path.join(s.home, 'p9', 'scripts', 'install.sh'), 'utf8'), await readFile(path.join(s.dir, 'src', 'p9', 'scripts', 'install.sh'), 'utf8'));
  assert.equal(await readFile(path.join(s.home, 'p9', 'node_modules-kept'), 'utf8'), 'built\n', 'what the last install built stays');
});

// 0.1.8 H5, the 0.1.7 hotfix: a running full P9 there is stopped after the archive is listed and before its files are
// replaced, or its unit restarts it from a half-built ~/p9; a stop that fails replaces nothing (P9_INSTALL busy).
test('0.1.7 hotfix: a remote install stops a running p9-foundation before replacing its files; a failed stop replaces nothing', { skip, timeout: 60000 }, async () => {
  const s = await stage(), readme = path.join(s.home, 'p9', 'README.md');
  assert.equal((await installRemote({ host: 'test-host', ssh: s.ssh, archive: s.archive(), version: '0.1.6' })).phase, 'done');
  await writeFile(readme, 'old\n');
  // systemctl there: the unit is active; a stop logs which README it saw, and fails when stop-fails exists.
  await writeFile(path.join(path.dirname(s.ssh), 'systemctl'), '#!/bin/sh\ncase "$*" in *is-active*) exit 0;; *stop*) echo "stop $(cat "$HOME/p9/README.md")" >> "$HOME/systemctl.txt"; '
    + '[ -e "$HOME/stop-fails" ] && exit 1; exit 0;; esac\nexit 0\n');
  await chmod(path.join(path.dirname(s.ssh), 'systemctl'), 0o755);
  assert.equal((await installRemote({ host: 'test-host', ssh: s.ssh, archive: s.archive(), version: '0.1.6' })).phase, 'done');
  assert.equal(await readFile(path.join(s.home, 'systemctl.txt'), 'utf8').catch(() => 'never stopped'), 'stop old\n', 'stopped once, before the new files');
  assert.equal(await readFile(readme, 'utf8'), 'p9\n');
  await writeFile(readme, 'old\n'); await writeFile(path.join(s.home, 'stop-fails'), ''); await rm(path.join(s.home, 'args.txt'));
  const busy = await installRemote({ host: 'test-host', ssh: s.ssh, archive: s.archive(), version: '0.1.6' });
  assert.equal(busy.phase, 'failed');
  assert.match(JSON.stringify(busy), /busy/);
  assert.equal(await readFile(readme, 'utf8'), 'old\n', 'a failed stop replaces nothing');
  assert.equal(await exists(path.join(s.home, 'args.txt')), false, 'install.sh did not run');
});

test('D15a: a ~/p9 this app did not make is left alone', { skip, timeout: 30000 }, async () => {
  const s = await stage();
  await mkdir(path.join(s.home, 'p9')); await writeFile(path.join(s.home, 'p9', 'mine.txt'), 'mine\n');
  const result = await installRemote({ host: 'test-host', ssh: s.ssh, archive: s.archive(), version: '0.1.6' });
  assert.equal(result.phase, 'already-there');
  assert.deepEqual(await readdir(path.join(s.home, 'p9')), ['mine.txt']);
  assert.equal(await exists(path.join(s.home, 'args.txt')), false, 'install.sh did not run');
});

test('D15a: a packaged app has the remote download its own version from the fixed release URL', { skip, timeout: 30000 }, async () => {
  const s = await stage();
  const result = await installRemote({ host: 'test-host', ssh: s.ssh, version: '0.1.6' });
  assert.equal(result.phase, 'done', JSON.stringify(result));
  assert.equal(await readFile(path.join(s.dir, 'urls.txt'), 'utf8'), 'https://github.com/JudgeBreddd/P9/archive/refs/tags/v0.1.6.tar.gz\n');
  assert.match(script('0.1.6'), /--proto =https/);
});

test('D15a: a host ssh would read as an option, or a version that is not one, is refused before ssh runs', { skip, timeout: 10000 }, async () => {
  const s = await stage();
  assert.throws(() => installRemote({ host: '-oProxyCommand=x', ssh: s.ssh, version: '0.1.6' }), /server-host-refused/);
  assert.throws(() => installRemote({ host: 'test-host', ssh: s.ssh, version: "0.1.6'; touch x; '" }), /remote-install-version/);
  assert.equal(await exists(path.join(s.dir, 'ssh-args.txt')), false);
});

// D15a: an unpackaged app that is not a git checkout (a synced copy) sends its own files, one top folder for the script to
// strip, without node_modules, .git or dist. Before this it ran git archive there and sent nothing. Nothing its .gitignore
// excludes goes either (threat model row 67): private notes and agent files sit beside the source in such a copy.
test('D15a source: a copy without .git sends its files under one folder, without node_modules, dist, .env or what .gitignore excludes', { skip, timeout: 20000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-rsource-')), app = path.join(dir, 'app');
  for (const f of ['scripts/install.sh', 'node_modules/x/index.js', 'apps/web/dist/a.js', 'apps/web/src/b.mjs', 'private-notes/notes.md', 'CLAUDE.md', 'AGENTS.md', '.env', '.cursor/rules.md', 'apps/web/src/c.log']) {
    await mkdir(path.dirname(path.join(app, f)), { recursive: true }); await writeFile(path.join(app, f), 'x\n');
  }
  await writeFile(path.join(app, '.gitignore'), '# private\nprivate-notes/\n/CLAUDE.md\nAGENTS.md\n*.log\n!keep.log\n');
  const list = spawn('tar', ['-tzf', '-'], { stdio: ['pipe', 'pipe', 'ignore'] });
  sourceArchive(app).pipe(list.stdin);
  let out = ''; list.stdout.setEncoding('utf8').on('data', (c) => { out += c; });
  await new Promise((resolve) => list.once('close', resolve));
  const files = out.split('\n').filter((f) => f && !f.endsWith('/')).sort();
  assert.deepEqual(files, ['app/.gitignore', 'app/apps/web/src/b.mjs', 'app/scripts/install.sh']);
  console.log('PASS D15a source: a copy sends ' + files.length + ' files, nothing .gitignore excludes');
});

// U8 (threat model row 50 U8 and U9): the slim Temporary P9. A stand-in daemon folder (bundleDaemon's out): slimArchive
// sends only its named files, and the stand-in install.sh records its arguments and writes a slim start that logs stop.
async function slimFolder(dir, name, extra = {}) {
  const folder = path.join(dir, name);
  const files = {
    'apps/server/main.mjs': 'main\n', 'agents.json': '{}\n', 'package.json': '{}\n',
    'scripts/install.sh': 'echo "ARGS $*" > "$HOME/slim-args.txt"; s="$HOME/.local/share/p9"; mkdir -p "$s/run"\n'
      + 'printf "%s\\n" "checkout=$4" "slim=1" "echo stop >> $HOME/stops.txt" > "$s/run/start"\n',
    // Never sent: this computer's own agents' binaries and anything not named in SLIM.
    'node_modules/@openai/codex-linux-x64/codex': 'bin\n', 'AGENTS.md': 'private\n', 'node': 'bin\n', ...extra,
  };
  for (const [f, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(folder, f)), { recursive: true }); await writeFile(path.join(folder, f), text); }
  return folder;
}
const tree = async (dir) => (await readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath, e.name))).sort();

test('U8: a Temporary remote gets the slim P9 in ~/.local/share/p9/remote, no ~/p9; a newer one replaces it whole; an older one is refused unless forced', { skip, timeout: 60000 }, async () => {
  const s = await stage(), remote = path.join(s.home, '.local', 'share', 'p9', 'remote');
  const first = await slimFolder(s.dir, 'v1', { 'apps/server/old-only.mjs': 'old\n' });
  const result = await installRemote({ host: 'test-host', ssh: s.ssh, archive: slimArchive(first), version: '0.1.6', slim: true });
  assert.equal(result.phase, 'done', JSON.stringify(result));
  assert.equal(await exists(path.join(s.home, 'p9')), false, 'no ~/p9');
  assert.equal(await readFile(path.join(s.home, 'slim-args.txt'), 'utf8'), 'ARGS --headless --background --slim ' + remote + '\n');
  assert.deepEqual(await tree(remote), ['.p9-version', 'agents.json', 'apps/server/main.mjs', 'apps/server/old-only.mjs', 'package.json', 'scripts/install.sh']);
  assert.equal(await readFile(path.join(remote, '.p9-version'), 'utf8'), '0.1.6\n');
  // A newer app: the whole folder is swapped, so a file only the old one had is gone; the old daemon is told to stop.
  await writeFile(path.join(s.home, 'stops.txt'), '');
  assert.equal((await installRemote({ host: 'test-host', ssh: s.ssh, archive: slimArchive(await slimFolder(s.dir, 'v2')), version: '0.1.7', slim: true })).phase, 'done');
  assert.equal(await exists(path.join(remote, 'apps', 'server', 'old-only.mjs')), false, 'nothing of the old version stays');
  assert.equal(await readFile(path.join(remote, '.p9-version'), 'utf8'), '0.1.7\n');
  assert.equal(await readFile(path.join(s.home, 'stops.txt'), 'utf8'), 'stop\n');
  assert.deepEqual((await readdir(path.join(s.home, '.local', 'share', 'p9'))).filter((n) => n.startsWith('.remote-')), [], 'no work folder left');
  // An older app never downgrades it, and nothing changes there; force does.
  const older = await installRemote({ host: 'test-host', ssh: s.ssh, archive: slimArchive(first), version: '0.1.6', slim: true });
  assert.deepEqual(older, { phase: 'failed', error: 'newer-there', server: '0.1.7' });
  assert.equal(await readFile(path.join(remote, '.p9-version'), 'utf8'), '0.1.7\n');
  assert.equal((await installRemote({ host: 'test-host', ssh: s.ssh, archive: slimArchive(first), version: '0.1.6', slim: true, force: true })).phase, 'done');
  assert.equal(await readFile(path.join(remote, '.p9-version'), 'utf8'), '0.1.6\n');
  // A pre-release is older than its release.
  assert.equal((await installRemote({ host: 'test-host', ssh: s.ssh, archive: slimArchive(first), version: '0.1.6-rc.1', slim: true })).error, 'newer-there');
});

// The owner, 2026-11-02: a full remote install gets the app, not the build notes. This checkout's .gitattributes export-ignore
// lines keep tests, docs, contracts and agent folders out of git archive (a checkout's send and GitHub's tag archives) and out
// of a synced copy's send; what install.sh and the build read stays.
test('full install source: this checkout sends no tests, docs, contracts or agent folders, as a git checkout or as a synced copy', { skip, timeout: 60000 }, async () => {
  const root = path.join(import.meta.dirname, '..');
  const listed = async (folder) => {
    const list = spawn('tar', ['-tzf', '-'], { stdio: ['pipe', 'pipe', 'ignore'] });
    sourceArchive(folder).pipe(list.stdin);
    let out = ''; list.stdout.setEncoding('utf8').on('data', (c) => { out += c; });
    await new Promise((resolve) => list.once('close', resolve));
    return out.split('\n').filter((f) => f && !f.endsWith('/')).map((f) => f.replace(/^[^/]+\//, ''));
  };
  const check = (files, how) => {
    for (const bad of ['test/', 'docs/guide.md', '.cursor/', '.github/', '.githooks/', 'contracts.md', 'CONTRIBUTING.md', 'AGENTS.md', 'CLAUDE.md', 'CONTEXT.md', '_' + 'private/', 'apps/server/AGENTS.md'])
      assert.ok(!files.some((f) => f === bad || f.startsWith(bad)), how + ' sent ' + bad);
    for (const good of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'scripts/install.sh', 'scripts/background.sh', 'apps/server/main.mjs',
      'apps/web/astro.config.mjs', 'packages/files/index.mjs', 'LICENSE', 'LICENSES.md', 'README.md', 'third-party/DUWOP-LICENSE.md', 'docs/brand/icon-primary-1024.png'])
      assert.ok(files.includes(good), how + ' is missing ' + good);
  };
  // A synced copy: the files beside the source, with no .git (the dev space copies the checkout without one).
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-rfull-')), copy = path.join(dir, 'app');
  const tracked = (await listed(root)).filter((f) => !f.startsWith('node_modules/'));
  const run = (cmd, args, cwd) => new Promise((resolve) => { const c = spawn(cmd, args, { cwd, stdio: 'ignore' }); c.once('close', resolve); });
  await mkdir(copy);
  for (const f of ['.gitignore', '.gitattributes', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'scripts/install.sh', 'scripts/background.sh', 'apps/server/main.mjs',
    'apps/web/astro.config.mjs', 'packages/files/index.mjs', 'LICENSE', 'LICENSES.md', 'README.md', 'third-party/DUWOP-LICENSE.md', 'test/helpers.mjs', 'docs/guide.md', 'docs/brand/icon-primary-1024.png',
    'contracts.md', 'CONTRIBUTING.md', '.github/workflows/x.yml', '.githooks/pre-commit', '.cursor/skills/x.md']) {
    await mkdir(path.dirname(path.join(copy, f)), { recursive: true });
    await writeFile(path.join(copy, f), await readFile(path.join(root, f)).catch(() => 'stand-in\n'));
  }
  for (const f of ['AGENTS.md', 'CLAUDE.md', 'CONTEXT.md', '_' + 'private/notes.md', 'apps/server/AGENTS.md']) { await mkdir(path.dirname(path.join(copy, f)), { recursive: true }); await writeFile(path.join(copy, f), 'notes\n'); }
  check(await listed(copy), 'a synced copy');
  // The same files as a git checkout: git archive HEAD applies .gitattributes.
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'x']]) await run('git', args, copy);
  check(await listed(copy), 'a git checkout');
  check(tracked, 'this checkout');
});

test('U8: slimArchive sends only the named files, never the bundled node, this computer\'s agent binaries or other files', { skip, timeout: 20000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-rslim-')), folder = await slimFolder(dir, 'd');
  const list = spawn('tar', ['-tzf', '-'], { stdio: ['pipe', 'pipe', 'ignore'] });
  slimArchive(folder).pipe(list.stdin);
  let out = ''; list.stdout.setEncoding('utf8').on('data', (c) => { out += c; });
  await new Promise((resolve) => list.once('close', resolve));
  assert.deepEqual(out.split('\n').filter((f) => f && !f.endsWith('/')).sort(), ['agents.json', 'apps/server/main.mjs', 'package.json', 'scripts/install.sh']);
  assert.throws(() => slimArchive(dir), /slim-bundle-incomplete/);
  // Inside a named folder only what runs (the owner, 2026-11-02): a package's README, changelog, notes, types and maps stay
  // here; its licence and notice files go.
  const docs = await slimFolder(dir, 'docs', { 'node_modules/@openai/codex/README.md': 'r\n', 'node_modules/@openai/codex/CHANGELOG': 'c\n',
    'node_modules/@openai/codex/bin/codex.js': 'js\n', 'node_modules/@openai/codex/LICENSE.md': 'l\n', 'node_modules/@openai/codex/index.d.ts': 't\n',
    'node_modules/@openai/codex/bin/codex.js.map': 'm\n', 'apps/server/notes.md': 'n\n', 'packages/files/index.mjs': 'f\n', 'NOTICES.md': 'n\n' });
  const second = spawn('tar', ['-tzf', '-'], { stdio: ['pipe', 'pipe', 'ignore'] });
  slimArchive(docs).pipe(second.stdin);
  let sent = ''; second.stdout.setEncoding('utf8').on('data', (c) => { sent += c; });
  await new Promise((resolve) => second.once('close', resolve));
  assert.deepEqual(sent.split('\n').filter((f) => f && !f.endsWith('/')).sort(), ['NOTICES.md', 'agents.json', 'apps/server/main.mjs',
    'node_modules/@openai/codex/LICENSE.md', 'node_modules/@openai/codex/bin/codex.js', 'package.json', 'packages/files/index.mjs', 'scripts/install.sh']);
});

test('U8: a remote with the full P9 says full-there and gets no slim copy beside it', { skip, timeout: 30000 }, async () => {
  const s = await stage();
  await mkdir(path.join(s.home, 'p9')); await writeFile(path.join(s.home, 'p9', '.p9-remote-install'), '0.1.5\n');
  const result = await installRemote({ host: 'test-host', ssh: s.ssh, archive: slimArchive(await slimFolder(s.dir, 'v1')), version: '0.1.6', slim: true });
  assert.equal(result.phase, 'full-there');
  assert.equal(await exists(path.join(s.home, '.local', 'share', 'p9', 'remote')), false);
});

test('U8: Always on after the slim P9 stops it, installs the full one and removes the slim folder; a failed install puts its background marker back', { skip, timeout: 60000 }, async () => {
  const s = await stage(), p9s = path.join(s.home, '.local', 'share', 'p9');
  assert.equal((await installRemote({ host: 'test-host', ssh: s.ssh, archive: slimArchive(await slimFolder(s.dir, 'v1')), version: '0.1.6', slim: true })).phase, 'done');
  await writeFile(path.join(p9s, 'run', 'background'), ''); await writeFile(path.join(s.home, 'stops.txt'), '');
  // The full install fails first: the slim one runs again on the next connect (its marker is back), its folder stays.
  const good = await readFile(path.join(s.dir, 'src', 'p9', 'scripts', 'install.sh'), 'utf8');
  await writeFile(path.join(s.dir, 'src', 'p9', 'scripts', 'install.sh'), 'exit 1\n');
  assert.equal((await installRemote({ host: 'test-host', ssh: s.ssh, archive: s.archive(), version: '0.1.6', keep: true })).phase, 'failed');
  assert.equal(await exists(path.join(p9s, 'run', 'background')), true, 'the background marker is back');
  assert.equal(await exists(path.join(p9s, 'remote')), true);
  await writeFile(path.join(s.dir, 'src', 'p9', 'scripts', 'install.sh'), good);
  assert.equal((await installRemote({ host: 'test-host', ssh: s.ssh, archive: s.archive(), version: '0.1.6', keep: true })).phase, 'done');
  assert.equal(await readFile(path.join(s.home, 'stops.txt'), 'utf8'), 'stop\nstop\n', 'the slim daemon was stopped before each install');
  assert.equal(await readFile(path.join(s.home, 'args.txt'), 'utf8'), 'ARGS --headless\n');
  assert.equal(await exists(path.join(p9s, 'remote')), false, 'the slim folder went');
  assert.equal(await readFile(path.join(s.home, 'p9', '.p9-remote-install'), 'utf8'), '0.1.6\n');
});

test('U8: the full ~/p9 records its version, refuses an older one unless forced, and drops files the new source no longer has', { skip, timeout: 60000 }, async () => {
  const s = await stage(), d = path.join(s.home, 'p9');
  await writeFile(path.join(s.dir, 'src', 'p9', 'gone-later.mjs'), 'x\n');
  assert.equal((await installRemote({ host: 'test-host', ssh: s.ssh, archive: s.archive(), version: '0.1.7' })).phase, 'done');
  assert.equal(await readFile(path.join(d, '.p9-remote-install'), 'utf8'), '0.1.7\n');
  await writeFile(path.join(d, 'built-there.txt'), 'built\n');
  const older = await installRemote({ host: 'test-host', ssh: s.ssh, archive: s.archive(), version: '0.1.6' });
  assert.deepEqual(older, { phase: 'failed', error: 'newer-there', server: '0.1.7' });
  // A newer source without gone-later.mjs: it goes; what install.sh built there (never in the list) stays.
  await rm(path.join(s.dir, 'src', 'p9', 'gone-later.mjs'));
  assert.equal((await installRemote({ host: 'test-host', ssh: s.ssh, archive: s.archive(), version: '0.1.8' })).phase, 'done');
  assert.equal(await exists(path.join(d, 'gone-later.mjs')), false);
  assert.equal(await readFile(path.join(d, 'built-there.txt'), 'utf8'), 'built\n');
  assert.equal(await exists(path.join(d, 'README.md')), true);
  // An install from before U8 (an empty marker) is replaced as before; force installs an older version.
  assert.equal((await installRemote({ host: 'test-host', ssh: s.ssh, archive: s.archive(), version: '0.1.6', force: true })).phase, 'done');
  assert.equal(await readFile(path.join(d, '.p9-remote-install'), 'utf8'), '0.1.6\n');
  // Review 2 L1: an archive tar cannot list fails before the sweep, so the files the last install unpacked stay.
  assert.equal((await installRemote({ host: 'test-host', ssh: s.ssh, archive: Readable.from([Buffer.from('not a tarball')]), version: '0.1.9' })).phase, 'failed');
  assert.equal(await exists(path.join(d, 'README.md')), true, 'a bad archive removes nothing');
  assert.equal(await exists(path.join(d, 'scripts', 'install.sh')), true);
});
