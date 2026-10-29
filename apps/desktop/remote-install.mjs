// Install P9 on a remote that has none (D15a, threat model row 67), the way VS Code Remote-SSH puts its server on a machine
// at first connect. Only after the person asked for it in the connecting screen; updates stay with server-update.mjs (K1).
// One fixed script over the user's own ssh (BatchMode: keys or an agent, never a password prompt): it unpacks P9's source
// into ~/p9 there and runs install.sh --headless with no input, so install.sh's admin ask stops and lists what is missing.
import { spawn } from 'node:child_process';
import { names } from './server-update.mjs';
import { HOST, SSH_OPTIONS } from './remote.mjs';

// The same release archives a packaged app's update downloads (apps/server/update.mjs ARCHIVE).
const ARCHIVE = 'https://github.com/JudgeBreddd/P9/archive/refs/tags/';
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.]{1,40})?$/;
const LIMIT_MS = 30 * 60_000, KEEP = 64 * 1024;
const quote = (text) => "'" + text.replace(/'/g, "'\\''") + "'";

// The remote's script. version: null when this app's source comes over ssh's stdin, else the release to download there.
// A ~/p9 this install made (its marker file) gets install.sh again; any other ~/p9 is left alone.
export function script(version) {
  if (version !== null && !VERSION.test(version)) throw new Error('remote-install-version');
  const source = version === null ? 'cat > "$t/p9.tar.gz"'
    : 'u=' + quote(ARCHIVE + 'v' + version + '.tar.gz') + '; if command -v curl >/dev/null; then curl -fsSL --proto =https -o "$t/p9.tar.gz" "$u"; '
      + 'elif command -v wget >/dev/null; then wget -q -O "$t/p9.tar.gz" "$u"; else echo "P9_INSTALL missing curl"; exit 4; fi';
  return [
    'set -eu', 'd="$HOME/p9"',
    'if [ -e "$d" ] || [ -L "$d" ]; then [ -f "$d/.p9-remote-install" ] || { echo "P9_INSTALL already-there"; exit 3; }',
    'else t=$(mktemp -d); trap \'rm -rf "$t"\' EXIT; ' + source + '; mkdir "$d"; : > "$d/.p9-remote-install"; tar -xzf "$t/p9.tar.gz" -C "$d" --strip-components=1; echo "P9_INSTALL unpacked"; fi',
    'bash "$d/scripts/install.sh" --headless </dev/null',
    'echo "P9_INSTALL done"',
  ].join('\n');
}

// tell(event): { phase: 'running' | 'done' | 'failed' | 'already-there', line?, tail? } for the window. archive: a readable
// stream of this app's source as tar.gz (a checkout's git archive), or null to have the remote download version.
export function installRemote({ host, ssh = 'ssh', version = null, archive = null, tell = () => {}, limit = LIMIT_MS }) {
  if (typeof host !== 'string' || !HOST.test(host)) throw new Error('server-host-refused');
  const command = 'sh -c ' + quote(script(archive ? null : version));
  return new Promise((resolve) => {
    const child = spawn(ssh, [...SSH_OPTIONS, host, command], { stdio: ['pipe', 'pipe', 'pipe'] });
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
    if (archive) { archive.on('error', () => child.kill()); archive.pipe(child.stdin); } else child.stdin.end();
    child.once('close', (code) => {
      const shown = names(tail.trimEnd().split('\n').slice(-12)).join('\n');
      if (code === 0 && tail.includes('P9_INSTALL done')) finish({ phase: 'done', tail: shown });
      else if (code === 3 && tail.includes('P9_INSTALL already-there')) finish({ phase: 'already-there' });
      else finish({ phase: 'failed', error: code === 255 ? 'server-unreachable' : 'install-failed', tail: shown });
    });
  });
}
