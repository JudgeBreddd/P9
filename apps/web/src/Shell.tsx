import { useEffect } from 'react';
import shell from './shell.html?raw';
import hole from './black-hole.html?raw';
import './styles/black-hole.css';

const markup = shell.replace('<!--black-hole-->', hole);
import { mountShell } from './controller.mjs';

declare global {
  interface Window { p9?: { getStatus(): Promise<{ status: 'ok' | 'unavailable'; reason?: 'task-missing' | 'task-stale' | 'not-answering'; savedWorkspace?: string; workspace?: string; mode?: 'server'; host?: string; error?: string; install?: RemoteInstall; background?: boolean; ask?: boolean; keeping?: Keeping }>; remoteInstall?(): Promise<{ ok?: boolean; error?: string }>; remoteStart?(): Promise<{ result?: string; error?: string }>; remoteKeep?(yes: boolean, remember: boolean): Promise<unknown>; remoteAdmin?(password: string): Promise<{ ok?: boolean; error?: string }>; usage(): Promise<unknown>; server?(...host: (string | null)[]): Promise<{ host?: string | null; last?: string | null }> } }
}

// Remote mode (desktop/remote.mjs): why the window is not on the remote yet.
const REMOTE_WHY: Record<string, string> = {
  'server-connecting': 'Opening the ssh tunnel and waiting for P9 there to answer.',
  'server-unreachable': 'The remote is not reachable over ssh: check it is on and that ssh to it works without a password prompt.',
  'server-no-p9': 'The remote answered, but P9 is not running there. If P9 is installed there, start it; if not, install it from here.',
  'server-not-answering': 'The tunnel opened, but P9 on the remote did not answer.',
  'server-host-refused': 'ssh refused that host name.',
  'server-dropped': 'Lost the remote: connecting again.',
};

// D15a (desktop/remote-install.mjs): the asked-first install of P9 on a remote that has none, as the status poll reports it.
type RemoteInstall = { phase: 'running' | 'done' | 'failed' | 'already-there' | 'admin'; line?: string; tail?: string; error?: string; started?: number; need?: string[]; command?: string };
// P9_INSTALL and P9_ADMIN lines are for main, not for people.
const lastLine = (text = '') => text.split('\n').filter(l => l.trim() && !l.startsWith('P9_')).pop() ?? '';
const needNames = (need: string[] = []) => need.map(n => n.split(':')[0]).join(', ');
const installWhy = (host: string, i: RemoteInstall) => ({
  running: 'Installing P9 on ' + host + '. This takes a few minutes; this window shows each step and connects when it is done.',
  done: 'P9 is installed on ' + host + '. Connecting…',
  admin: host + ' is missing ' + (needNames(i.need) || 'a few tools') + ', and installing ' + ((i.need?.length ?? 0) > 1 ? 'them' : 'it') + ' needs an admin password. Continue asks for it.',
  'already-there': host + ' already has a ~/p9 folder that this app did not make, so it was left alone. If it is P9 installed there, Start P9 there runs it.',
  failed: 'The install on ' + host + ' stopped' + ({ 'timed-out': ' after 30 minutes', 'server-unreachable': ': ssh lost the remote', 'ssh-failed': ': ssh did not start', 'install-failed': '', 'missing-tools': ': ' + host + ' is missing ' + (needNames(i.need) || 'tools P9 needs') + ' and has no package manager P9 knows', 'not-allowed': ': your account there cannot install software' }[i.error ?? ''] ?? ' (' + i.error + ')')
    + '. ' + (i.error === 'not-allowed' || i.error === 'missing-tools' ? 'Someone who administers ' + host + ' must install ' + (needNames(i.need) || 'them') + ', then Try again.' : (i.tail ? 'Its last lines are below.' : '') + ' Try again.'),
}[i.phase]);
// D15a: why pressing Install started nothing, in words. A window whose app files were updated while it ran has the new
// button but not the main process that answers it, until P9 is quit fully and opened again.
const installRefused = (error: string) => /No handler registered/.test(error)
  ? 'This P9 window is older than its app files, so it cannot start the install. Quit P9 fully (every window), open it again, then press Install.'
  : error === 'remote-install-refused' ? 'P9 did not start the install: it runs only while this remote answers without P9, and one at a time. Wait a few seconds and try again.'
    : 'The install could not start (' + error + ').';
// Row I1: P9 on a remote in background mode stops when nobody uses it. One line in the status bar says so, with Keep it
// running; after the first connect there, one question. keeping: the last switch main ran there (desktop main.mjs applyKeep).
type Keeping = { action: 'keep' | 'release'; phase: 'running' | 'ok' | 'refused' | 'no-start' | 'failed' | 'wrong-password' | 'not-allowed'; command?: string };
const keepLine = (host: string, background?: boolean, k?: Keeping): [string, string] | null => {
  if (k?.phase === 'running') return [k.action === 'keep' ? 'Keeping P9 running on ' + host + '…' : 'Switching P9 on ' + host + ' to run only while connected…', ''];
  if (k?.phase === 'refused') return ['Keeping P9 running on ' + host + ' needs an admin password', 'Use admin password'];
  if (k?.phase === 'wrong-password') return ['That admin password did not work on ' + host, 'Use admin password'];
  if (k?.phase === 'not-allowed') return ['Your account on ' + host + ' cannot keep P9 running; someone who administers it can allow it', ''];
  if (k?.phase === 'no-start') return ['P9 on ' + host + ' was installed before this choice existed, so it cannot switch', ''];
  if (k?.phase === 'failed') return ['Could not change how P9 runs on ' + host, 'Try again'];
  return background ? ['P9 on ' + host + ' stops when you disconnect', 'Keep it running'] : null;
};
// Row I2: the password window for one admin step on host. need: "name: reason" lines; command: exactly what runs as admin.
// The password goes to main once (p9:remote-admin) and the field is emptied whenever the window closes.
const askAdmin = (host: string, title: string, lead: string, need: string[], command: string, ok: string, error: string, done: () => void) => {
  const dialog = document.getElementById('adminDlg') as HTMLDialogElement | null, pw = document.getElementById('adminPw') as HTMLInputElement | null;
  if (!dialog || !pw || dialog.open || !window.p9?.remoteAdmin) return;
  document.getElementById('adminT')!.textContent = title;
  document.getElementById('adminP')!.textContent = lead;
  const list = document.getElementById('adminNeed')!;
  list.replaceChildren(...need.map(line => {
    const li = document.createElement('li'), b = document.createElement('b'), at = line.indexOf(':');
    b.textContent = at < 0 ? line : line.slice(0, at);
    li.append(b, at < 0 ? '' : line.slice(at + 1).trim());
    return li;
  }));
  list.hidden = !need.length;
  document.getElementById('adminWhat')!.textContent = 'With your password, P9 runs this as admin on ' + host + ':';
  document.getElementById('adminCmd')!.textContent = command;
  document.getElementById('adminL')!.textContent = 'Admin password for your account on ' + host;
  document.getElementById('adminOk')!.textContent = ok;
  const err = document.getElementById('adminErr')!;
  err.textContent = error; err.hidden = !error;
  pw.value = '';
  dialog.returnValue = '';
  dialog.onclose = () => {
    const password = pw.value;
    pw.value = '';
    if (dialog.returnValue === 'ok' && password) void window.p9!.remoteAdmin!(password).finally(done);
  };
  dialog.showModal();
  pw.focus();
};
const elapsed = (started?: number) => {
  const s = started ? Math.max(0, Math.round((Date.now() - started) / 1000)) : 0;
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};

export default function Shell() {
  useEffect(() => {
    const dispose = mountShell();
    let keepAsked = false, adminAsked = '';
    let active = true, waited = false, connected = false, asking = false, starting = false, refused = '', startSaid = '', timer: ReturnType<typeof setTimeout> | undefined;
    // D20: the remote this window has shown.
    let shown = '';
    // The title-bar badge (Remote · host or Local) and its machine menu: controller.mjs, serverMenu.
    // Asks again every 5 s until the daemon answers: asked once, the label said unavailable forever (issue #6 B3).
    const ask = () => void (window.p9?.getStatus() ?? Promise.resolve({ status: 'unavailable' as const }))
      .catch(() => ({ status: 'unavailable' as const }))
      .then((result: { status: string; reason?: string; savedWorkspace?: string; workspace?: string; mode?: string; host?: string; error?: string; install?: RemoteInstall; background?: boolean; ask?: boolean; keeping?: Keeping }) => {
        const label = document.getElementById('daemonStatus');
        if (!active) return;
        // Remote mode asks every 5 s even when connected: a lost tunnel shows here, and main connects again on its own.
        if (result.mode === 'server') {
          // D20: the full connecting layer only while this window has never shown this remote. A window that loaded before it
          // answered loads once more, so its chats and Mission Control come from the remote. After that a slow or failed poll
          // (a slow network, the tunnel rebuilt) shows nothing: main reconnects on its own, and only what the user does waits
          // where they did it (a send's working row, a page's Loading).
          const layer = document.getElementById('connecting') as HTMLDialogElement | null, ok = result.status === 'ok', known = shown === result.host;
          if (layer && !ok && !known) {
            document.getElementById('connT')!.textContent = 'Connecting to ' + result.host;
            const why = document.getElementById('connWhy')!, install = document.getElementById('connInstall') as HTMLButtonElement, no = document.getElementById('connNo')!;
            const host = result.host ?? '', i = result.install, phase = i?.phase;
            if (phase === 'running') refused = '';
            const busy = starting || phase === 'running' || phase === 'done';
            // Row I2: the install stopped at an admin step. The window opens once for each stop; Continue opens it again.
            const admin = phase === 'admin' && !!i?.command && !!window.p9?.remoteAdmin;
            const openAdmin = () => askAdmin(host, 'Install what P9 needs on ' + host, host + ' is missing what P9 needs to install, and only an admin can add it:',
              i?.need ?? [], i?.command ?? '', 'Install', i?.error === 'wrong-password' ? 'That password did not work. Check it and try again.' : '', ask);
            if (admin && adminAsked !== i!.started + (i!.error ?? '')) { adminAsked = i!.started + (i!.error ?? ''); openAdmin(); }
            // D15a: Install P9 there asks first, in place: what happens, where, and what it never does. Then the poll shows its
            // progress (a reopened window too: main keeps it): the button stays off, a spinner, the last line, the time so far.
            if (!asking) why.textContent = refused || startSaid || (i ? installWhy(host, i) : REMOTE_WHY[result.error ?? ''] ?? 'Not connected yet (' + result.error + ')');
            install.hidden = !(busy || asking || result.error === 'server-no-p9') || !window.p9?.remoteInstall;
            install.disabled = busy;
            install.textContent = admin ? 'Continue' : phase === 'done' ? 'Connecting…' : busy ? 'Installing…' : asking ? 'Install' : phase === 'failed' || refused ? 'Try again' : 'Install P9 there';
            no.hidden = !asking;
            // Start P9 there: a P9 that is installed but stopped (or a ~/p9 this app did not make), never a terminal command.
            const start = document.getElementById('connStart') as HTMLButtonElement;
            start.hidden = busy || asking || !(result.error === 'server-no-p9' || phase === 'already-there') || !window.p9?.remoteStart;
            start.onclick = () => {
              start.disabled = true; start.textContent = 'Starting…';
              void (window.p9?.remoteStart?.() ?? Promise.resolve({ result: 'failed' })).then((r: { result?: string; error?: string }) => {
                start.disabled = false; start.textContent = 'Start P9 there';
                if (r?.result === 'ok') return void (why.textContent = 'P9 started on ' + host + '. Connecting…');
                startSaid = r?.result === 'none' ? 'P9 is not set up to run on ' + host + ' yet. Install P9 there sets it up.' : 'P9 did not start on ' + host + '. Try again, or install it from here.';
                why.textContent = startSaid;
              }, () => { start.disabled = false; start.textContent = 'Start P9 there'; });
            };
            const progress = document.getElementById('connProgress')!, log = document.getElementById('connLog')!;
            progress.hidden = !busy;
            document.getElementById('connStep')!.textContent = phase === 'done' ? 'Installed' : lastLine(i?.line) || 'Starting…';
            document.getElementById('connTime')!.textContent = elapsed(i?.started);
            log.hidden = asking || phase !== 'failed' || !i?.tail;
            log.textContent = (i?.tail ?? '').split('\n').filter(l => !l.startsWith('P9_')).join('\n');
            install.onclick = () => {
              if (admin) return openAdmin();
              if (!asking) {
                asking = true; refused = ''; startSaid = ''; install.textContent = 'Install'; no.hidden = false; log.hidden = true;
                why.textContent = 'Install P9 on ' + host + '? Over your ssh login, P9 puts its source in ~/p9 there, builds it and starts its background service for your user. '
                  + 'If it needs anything only an admin can install, it shows you what and asks for your password first. It takes a few minutes.';
                return;
              }
              asking = false; starting = true; no.hidden = true; install.disabled = true; install.textContent = 'Installing…'; progress.hidden = false;
              why.textContent = 'Installing P9 on ' + host + '…';
              const stop = (error: string) => { starting = false; refused = installRefused(error); why.textContent = refused; install.disabled = false; install.textContent = 'Try again'; progress.hidden = true; };
              void (window.p9?.remoteInstall?.() ?? Promise.reject(new Error('no-install')))
                .then((r: { error?: string } | undefined) => r?.error ? stop(r.error) : void (starting = false), (e: Error) => stop(e?.message ?? String(e)));
            };
            no.onclick = () => { asking = false; no.hidden = true; install.textContent = 'Install P9 there'; why.textContent = REMOTE_WHY[result.error ?? ''] ?? ''; };
            document.getElementById('connLocal')!.onclick = () => void window.p9?.server?.(null);
            if (!layer.open) { layer.addEventListener('cancel', e => e.preventDefault()); layer.showModal(); }
          }
          if (ok && waited && !connected) return location.reload();
          if (ok) { connected = true; shown = result.host ?? ''; if (layer?.open) layer.close(); } else waited = true;
          if (label && (ok || !known)) {
            label.textContent = result.status === 'ok' ? 'Connected to ' + result.host : (REMOTE_WHY[result.error ?? ''] ?? 'Remote unavailable (' + result.error + ')');
            label.title = 'Remote mode: chats, Mission Control and the terminal run on ' + result.host + '. Settings > Remote switches back to this computer.';
          }
          const note = document.getElementById('keepNote'), line = ok ? keepLine(result.host ?? '', result.background, result.keeping) : null;
          if (note && window.p9?.remoteKeep) {
            note.hidden = !line;
            document.getElementById('keepText')!.textContent = line?.[0] ?? '';
            const button = document.getElementById('keepBtn') as HTMLButtonElement;
            button.hidden = !line?.[1]; button.textContent = line?.[1] ?? '';
            const k = result.keeping, host = result.host ?? '';
            button.onclick = (k?.phase === 'refused' || k?.phase === 'wrong-password') && k.command
              ? () => askAdmin(host, 'Keep P9 running on ' + host, 'For P9 to keep running after you sign out, your account there needs one admin setting.',
                [], k.command!, 'Keep it running', k.phase === 'wrong-password' ? 'That password did not work. Check it and try again.' : '', ask)
              : () => { button.hidden = true; void window.p9?.remoteKeep?.(true, false).finally(ask); };
            const dialog = document.getElementById('keepDlg') as HTMLDialogElement | null;
            if (ok && result.ask && !keepAsked && dialog && !dialog.open) {
              keepAsked = true;
              document.getElementById('keepT')!.textContent = 'Keep P9 running on ' + result.host + '?';
              (document.getElementById('keepRemember') as HTMLInputElement).checked = false;
              dialog.onclose = () => {
                const v = dialog.returnValue;
                if (v === 'yes' || v === 'no') void window.p9?.remoteKeep?.(v === 'yes', (document.getElementById('keepRemember') as HTMLInputElement).checked).finally(ask);
              };
              dialog.returnValue = '';
              dialog.showModal();
            }
          }
          timer = setTimeout(ask, ok ? 5000 : 1000);
          return;
        }
        // The saved folder was not there when the daemon started (an unplugged drive, an offline share): it runs on the default.
        if (label && result.status === 'ok' && result.savedWorkspace) {
          label.textContent = 'Workspace folder not found: ' + result.savedWorkspace + '. Using ' + result.workspace + ' for now';
          label.title = 'P9 goes back to ' + result.savedWorkspace + ' the next time its background service starts with that folder there (plug the drive in, then restart P9 or sign in again).';
        } else if (label) {
          label.textContent = result.status === 'ok' ? 'Daemon connected' : result.reason === 'task-missing' || result.reason === 'task-stale'
            ? 'Daemon not installed: reinstall P9' : result.reason ? 'Daemon not answering: starting it again' : 'Daemon unavailable';
          label.title = result.status === 'ok' ? 'Status connected.' : result.reason === 'task-missing'
            ? 'No P9 Foundation task, and P9 could not add it (service-install.log in the install folder). Run the P9 installer again.' : result.reason === 'task-stale'
            ? 'The P9 Foundation task is from an older P9, and P9 could not replace it (service-install.log in the install folder). Run the P9 installer again.' : result.reason
            ? 'Log: %LOCALAPPDATA%\\P9\\daemon.log' : 'Optional for this preview. Start the daemon and launch with --state to connect.';
        }
        if (result.status !== 'ok') timer = setTimeout(ask, 5000);
      });
    ask();
    return () => { active = false; clearTimeout(timer); dispose(); };
  }, []);
  // Approved static markup, bundled with this module; external data never reaches this sink.
  return <div data-p9-island dangerouslySetInnerHTML={{ __html: markup }} />;
}
