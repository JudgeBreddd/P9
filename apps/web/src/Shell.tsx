import { useEffect } from 'react';
import markup from './shell.html?raw';
import { mountShell } from './controller.mjs';

declare global {
  interface Window { p9?: { getStatus(): Promise<{ status: 'ok' | 'unavailable'; reason?: 'task-missing' | 'task-stale' | 'not-answering'; savedWorkspace?: string; workspace?: string; mode?: 'server'; host?: string; error?: string; install?: RemoteInstall }>; remoteInstall?(): Promise<{ ok?: boolean; error?: string }>; usage(): Promise<unknown>; server?(...host: (string | null)[]): Promise<{ host?: string | null; last?: string | null }> } }
}

// Remote mode (desktop/remote.mjs): why the window is not on the remote yet.
const REMOTE_WHY: Record<string, string> = {
  'server-connecting': 'Opening the ssh tunnel and waiting for P9 there to answer.',
  'server-unreachable': 'The remote is not reachable over ssh: check it is on and that ssh to it works without a password prompt.',
  'server-no-p9': 'The remote answered, but P9 is not running there. Install it there from here, or on that machine run the Linux command from the README\'s Install section.',
  'server-not-answering': 'The tunnel opened, but P9 on the remote did not answer.',
  'server-host-refused': 'ssh refused that host name.',
  'server-dropped': 'Lost the remote: connecting again.',
};

// D15a (desktop/remote-install.mjs): the asked-first install of P9 on a remote that has none, as the status poll reports it.
type RemoteInstall = { phase: 'running' | 'done' | 'failed' | 'already-there'; line?: string; tail?: string; error?: string; started?: number };
const lastLine = (text = '') => text.split('\n').filter(l => l.trim() && !l.startsWith('P9_INSTALL')).pop() ?? '';
const installWhy = (host: string, i: RemoteInstall) => ({
  running: 'Installing P9 on ' + host + '. This takes a few minutes; this window shows each step and connects when it is done.',
  done: 'P9 is installed on ' + host + '. Connecting…',
  'already-there': host + ' already has a ~/p9 folder that this app did not make, so it was left alone. If it is P9, start it there with: systemctl --user start p9-foundation',
  failed: 'The install on ' + host + ' stopped' + ({ 'timed-out': ' after 30 minutes', 'server-unreachable': ': ssh lost the remote', 'ssh-failed': ': ssh did not start', 'install-failed': '' }[i.error ?? ''] ?? ' (' + i.error + ')')
    + '. ' + (i.tail ? 'Its last lines are below.' : '') + ' Try again, or run the Linux command from the README there.',
}[i.phase]);
// D15a: why pressing Install started nothing, in words. A window whose app files were updated while it ran has the new
// button but not the main process that answers it, until P9 is quit fully and opened again.
const installRefused = (error: string) => /No handler registered/.test(error)
  ? 'This P9 window is older than its app files, so it cannot start the install. Quit P9 fully (every window), open it again, then press Install.'
  : error === 'remote-install-refused' ? 'P9 did not start the install: it runs only while this remote answers without P9, and one at a time. Wait a few seconds and try again.'
    : 'The install could not start (' + error + ').';
const elapsed = (started?: number) => {
  const s = started ? Math.max(0, Math.round((Date.now() - started) / 1000)) : 0;
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};

export default function Shell() {
  useEffect(() => {
    const dispose = mountShell();
    let active = true, waited = false, connected = false, asking = false, starting = false, refused = '', timer: ReturnType<typeof setTimeout> | undefined;
    // D20: the remote this window has shown.
    let shown = '';
    // The title-bar badge (Remote · host or Local) and its machine menu: controller.mjs, serverMenu.
    // Asks again every 5 s until the daemon answers: asked once, the label said unavailable forever (issue #6 B3).
    const ask = () => void (window.p9?.getStatus() ?? Promise.resolve({ status: 'unavailable' as const }))
      .catch(() => ({ status: 'unavailable' as const }))
      .then((result: { status: string; reason?: string; savedWorkspace?: string; workspace?: string; mode?: string; host?: string; error?: string; install?: RemoteInstall }) => {
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
            // D15a: Install P9 there asks first, in place: what happens, where, and what it never does. Then the poll shows its
            // progress (a reopened window too: main keeps it): the button stays off, a spinner, the last line, the time so far.
            if (!asking) why.textContent = refused || (i ? installWhy(host, i) : REMOTE_WHY[result.error ?? ''] ?? 'Not connected yet (' + result.error + ')');
            install.hidden = !(busy || asking || result.error === 'server-no-p9') || !window.p9?.remoteInstall;
            install.disabled = busy;
            install.textContent = phase === 'done' ? 'Connecting…' : busy ? 'Installing…' : asking ? 'Install' : phase === 'failed' || refused ? 'Try again' : 'Install P9 there';
            no.hidden = !asking;
            const progress = document.getElementById('connProgress')!, log = document.getElementById('connLog')!;
            progress.hidden = !busy;
            document.getElementById('connStep')!.textContent = phase === 'done' ? 'Installed' : lastLine(i?.line) || 'Starting…';
            document.getElementById('connTime')!.textContent = elapsed(i?.started);
            log.hidden = asking || phase !== 'failed' || !i?.tail;
            log.textContent = (i?.tail ?? '').split('\n').filter(l => !l.startsWith('P9_INSTALL')).join('\n');
            install.onclick = () => {
              if (!asking) {
                asking = true; refused = ''; install.textContent = 'Install'; no.hidden = false; log.hidden = true;
                why.textContent = 'Install P9 on ' + host + '? Over your ssh login, P9 puts its source in ~/p9 there, builds it and starts its background service for your user. '
                  + 'It never uses sudo or a password: anything that needs an admin is listed for you to run. It takes a few minutes.';
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
