// Install P9 on a remote that has none (D15a, threat model row 67), the way VS Code Remote-SSH puts its server on a machine
// at first connect. Only after the person asked for it in the connecting screen; updates stay with server-update.mjs (K1).
// One fixed script over the user's own ssh (BatchMode: keys or an agent, never a password prompt): it unpacks P9's source
// into ~/p9 there and runs install.sh --headless. Where an admin is needed it stops with what is missing, why, and the one
// command (P9_ADMIN lines); the window asks for the admin password and runs it again with that (threat model row I2).
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { names } from './server-update.mjs';
// PASSWORD: one line, so the remote's read takes exactly it and the archive after it is untouched.
import { HOST, sshOptions, PASSWORD } from './remote.mjs';
export { PASSWORD };
// Row 61 (commit C): a system package missing on this computer, installed with the admin password typed into the wizard.
// command: deps.mjs's own (adminCommand), run as admin without its leading sudo; the password is stdin's first line,
// as row I2's. -> { ok } | { error: 'wrong-password' | 'not-allowed' | 'admin-failed' | 'admin-refused' }.
// p9:admin-install's arguments: the package (tmux or ssh) and the password, nothing else.
export const adminArgs = (args) => Array.isArray(args) && args.length === 2 && ['tmux', 'ssh'].includes(args[0]) && PASSWORD(args[1]);
export function adminLocal(command, password, sh = 'sh') {
  if (typeof command !== 'string' || !command.startsWith('sudo ') || !PASSWORD(password)) return Promise.resolve({ error: 'admin-refused' });
  const root = command.replace(/(^|; |&& |\| )sudo /g, '$1');
  return new Promise((resolve) => {
    const child = execFile(sh, ['-c', TOOLS + '\nIFS= read -r p9_pw || true\nexec </dev/null\np9_admin "$1"', 'p9', root], { timeout: 600000 }, (error, out) => {
      const said = /^P9_ADMIN (wrong-password|not-allowed)$/m.exec(out ?? '')?.[1];
      resolve(error ? { error: said ?? 'admin-failed' } : { ok: true });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(password + '\n');
  });
}

// The same release archives a packaged app's update downloads (apps/server/update.mjs ARCHIVE).
const ARCHIVE = 'https://github.com/JudgeBreddd/P9/archive/refs/tags/';
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.]{1,40})?$/;
const LIMIT_MS = 30 * 60_000, KEEP = 64 * 1024;
const quote = (text) => "'" + text.replace(/'/g, "'\\''") + "'";
// The tools needed before Node, their reasons and the admin step (apps/desktop/tools.sh, shared with install.sh).
const TOOLS = readFileSync(new URL('./tools.sh', import.meta.url), 'utf8');

// The remote's script. version: null when this app's source comes over ssh's stdin, else the release to download there.
// A ~/p9 this install made (its marker file) gets install.sh again; any other ~/p9 is left alone.
// keep: the remembered Yes to Keep P9 running there (keep.mjs): linger and the service. Otherwise --background (row I1): no
// linger, no service, until the person answers after the first connect.
// admin: stdin's first line is the admin password (row I2), read before anything else; install.sh gets it the same way.
// Tools a fresh install needs first (tar and gzip unpack the source) are checked here, before the unpack, with the same
// reasons install.sh gives: no command line or file ever holds the password.
export function script(version, keep = false, admin = false) {
  if (version !== null && !VERSION.test(version)) throw new Error('remote-install-version');
  const source = version === null ? 'cat > "$t/p9.tar.gz"'
    : 'u=' + quote(ARCHIVE + 'v' + version + '.tar.gz') + '; if command -v curl >/dev/null; then curl -fsSL --proto =https -o "$t/p9.tar.gz" "$u"; '
      + 'elif command -v wget >/dev/null; then wget -q -O "$t/p9.tar.gz" "$u"; else echo "P9_INSTALL missing curl"; exit 4; fi';
  const flags = '--headless' + (keep ? '' : ' --background');
  return [
    'set -eu', 'd="$HOME/p9" p9_pw=', TOOLS,
    admin ? 'IFS= read -r p9_pw || true' : '',
    'if [ -e "$d" ] || [ -L "$d" ]; then [ -f "$d/.p9-remote-install" ] || { echo "P9_INSTALL already-there"; exit 3; }',
    'else p9_tools; if [ -n "$P9_TOOLS_NEED" ]; then c=$(p9_install_command "$P9_TOOLS_PACKAGES")',
    admin ? '  if [ -n "$c" ]; then p9_admin "$c" || true; fi'
      : '  printf "%s" "$P9_TOOLS_NEED" | while IFS= read -r l; do echo "P9_ADMIN need $l"; done; if [ -n "$c" ]; then echo "P9_ADMIN command $c"; exit 5; fi',
    '  p9_tools; [ -z "$P9_TOOLS_NEED" ] || { echo "P9_INSTALL missing-tools"; exit 4; }; fi',
    '  t=$(mktemp -d); trap \'rm -rf "$t"\' EXIT; ' + source + '; mkdir "$d"; : > "$d/.p9-remote-install"; tar -xzf "$t/p9.tar.gz" -C "$d" --strip-components=1; echo "P9_INSTALL unpacked"; fi',
    admin ? 'printf "%s\\n" "$p9_pw" | bash "$d/scripts/install.sh" ' + flags + ' --admin-stdin' : 'bash "$d/scripts/install.sh" ' + flags + ' </dev/null',
    'echo "P9_INSTALL done"',
  ].join('\n');
}

// This app's source as tar.gz for the script's stdin, one top folder (the script strips it). A git checkout sends its
// committed HEAD; a copy without .git (a synced folder) sends only what its .gitignore does not exclude (threat model row 67):
// private notes and agent files sit beside the source there and never go to a remote.
// ponytail: each .gitignore line becomes a plain tar --exclude, matched at any depth (a leading / is dropped, so an anchored
// line excludes more, never less); ! lines are skipped, so a re-included file stays out. Only the folder's top .gitignore.
export function sourceArchive(folder) {
  folder = path.resolve(folder);
  if (existsSync(path.join(folder, '.git'))) return run('git', ['-C', folder, 'archive', '--format=tar.gz', '--prefix=p9/', 'HEAD']);
  let ignored = [];
  try { ignored = readFileSync(path.join(folder, '.gitignore'), 'utf8').split('\n').map(l => l.trim().replace(/^\/+|\/+$/g, '')).filter(l => l && !l.startsWith('#') && !l.startsWith('!')); } catch {}
  const excludes = [...new Set(['node_modules', '.git', 'dist', '.env', '.env.*', '.cursor', ...ignored])].map(p => '--exclude=' + p);
  return run('tar', ['-czf', '-', ...excludes, '-C', path.dirname(folder), path.basename(folder)]);
}
function run(command, args) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  child.on('error', (error) => child.stdout.destroy(error)); // no git or tar: installRemote stops ssh and the install fails
  return child.stdout;
}

// tell(event): { phase: 'running' | 'done' | 'failed' | 'already-there' | 'admin', line?, tail?, need?, command?, error? } for
// the window. archive: a readable stream of this app's source as tar.gz (a checkout's git archive), or null to have the
// remote download version. admin: the admin password (PASSWORD), written to ssh's stdin first; no event ever carries it.
// 'admin': an admin must install need (["name: reason"]) with command (no sudo in it, run as admin as shown); error
// 'wrong-password' after a password that sudo refused.
export function installRemote({ host, ssh = 'ssh', version = null, archive = null, keep = false, admin = null, tell = () => {}, limit = LIMIT_MS }) {
  if (typeof host !== 'string' || !HOST.test(host)) throw new Error('server-host-refused');
  if (admin !== null && !PASSWORD(admin)) throw new Error('remote-install-password');
  const command = 'sh -c ' + quote(script(archive ? null : version, keep === true, admin !== null));
  return new Promise((resolve) => {
    const child = spawn(ssh, [...sshOptions(), host, command], { stdio: ['pipe', 'pipe', 'pipe'] });
    let tail = '', done = false;
    const finish = (event) => { if (done) return; done = true; clearTimeout(timer); tell(event); resolve(event); };
    const timer = setTimeout(() => { child.kill(); finish({ phase: 'failed', error: 'timed-out', tail: names(tail.split('\n')).join('\n') }); }, limit);
    const take = (chunk) => {
      tail = (tail + chunk).slice(-KEEP);
      const line = tail.trimEnd().split('\n').pop();
      if (line && !done) tell({ phase: 'running', line: names([line])[0] });
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', take); child.stderr.on('data', take);
    child.once('error', () => finish({ phase: 'failed', error: 'ssh-failed' }));
    child.stdin.on('error', () => {});
    if (admin !== null) child.stdin.write(admin + '\n');
    if (archive) { archive.on('error', () => child.kill()); archive.pipe(child.stdin); } else child.stdin.end();
    child.once('close', (code) => {
      const shown = names(tail.trimEnd().split('\n').slice(-12)).join('\n');
      const need = [...tail.matchAll(/^P9_ADMIN need (.+)$/gm)].map((m) => m[1]).slice(-20), said = /^P9_ADMIN command (.+)$/m.exec(tail)?.[1];
      if (code === 0 && tail.includes('P9_INSTALL done')) finish({ phase: 'done', tail: shown });
      else if (code === 3 && tail.includes('P9_INSTALL already-there')) finish({ phase: 'already-there' });
      else if (code === 5 && said) finish({ phase: 'admin', need, command: said });
      else if (code === 6 && tail.includes('P9_ADMIN wrong-password')) finish({ phase: 'admin', error: 'wrong-password' });
      else if (code === 7 && tail.includes('P9_ADMIN not-allowed')) finish({ phase: 'failed', error: 'not-allowed', tail: shown });
      else finish({ phase: 'failed', error: code === 255 ? 'server-unreachable' : 'install-failed', tail: shown });
    });
  });
}
