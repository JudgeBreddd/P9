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
type RemoteInstall = { phase: 'running' | 'done' | 'failed' | 'already-there'; line?: string; tail?: string; error?: string };
const lastLine = (text = '') => text.split('\n').filter(l => l.trim() && !l.startsWith('P9_INSTALL')).pop() ?? '';
const installWhy = (host: string, i: RemoteInstall) => ({
  running: 'Installing P9 on ' + host + '. This takes a few minutes. ' + lastLine(i.line),
  done: 'P9 is installed on ' + host + '. Connecting…',
  'already-there': host + ' already has a ~/p9 folder that this app did not make, so it was left alone. If it is P9, start it there with: systemctl --user start p9-foundation',
  failed: 'The install on ' + host + ' stopped' + (i.error === 'timed-out' ? ' after 30 minutes' : i.error === 'server-unreachable' ? ': ssh lost the remote' : '') + '. ' + lastLine(i.tail),
}[i.phase]);

export default function Shell() {
  useEffect(() => {
    const dispose = mountShell();
    let active = true, waited = false, connected = false, asking = false, timer: ReturnType<typeof setTimeout> | undefined;
    // The title-bar badge: Remote · host while on a remote; Local once a server was used, so one click goes back to it.
    void window.p9?.server?.().then(({ host, last }) => {
      const badge = document.getElementById('serverBadge');
      if (!active || !badge || !(host || last)) return;
      badge.hidden = false;
      badge.textContent = host ? 'Remote · ' + host : 'Local';
      badge.title = host ? 'This window works on ' + host + '. Click to switch to this computer.' : 'This window works on this computer. Click to switch to ' + last + '.';
      badge.onclick = () => void window.p9?.server?.(host ? null : last ?? null);
    }, () => {});
    // Asks again every 5 s until the daemon answers: asked once, the label said unavailable forever (issue #6 B3).
    const ask = () => void (window.p9?.getStatus() ?? Promise.resolve({ status: 'unavailable' as const }))
      .catch(() => ({ status: 'unavailable' as const }))
      .then((result: { status: string; reason?: string; savedWorkspace?: string; workspace?: string; mode?: string; host?: string; error?: string }) => {
        const label = document.getElementById('daemonStatus');
        if (!active) return;
        // Remote mode asks every 5 s even when connected: a lost tunnel shows here, and main connects again on its own.
        if (result.mode === 'server') {
          // D20: the connecting layer until the remote answers. A window that loaded before it answered loads once more, so
          // its chats and Mission Control come from the remote; a drop later only shows the layer again.
          const layer = document.getElementById('connecting') as HTMLDialogElement | null, ok = result.status === 'ok';
          if (layer && !ok) {
            document.getElementById('connT')!.textContent = 'Connecting to ' + result.host;
            const why = document.getElementById('connWhy')!, install = document.getElementById('connInstall') as HTMLButtonElement, no = document.getElementById('connNo')!;
            const host = result.host ?? '', running = result.install?.phase === 'running' || result.install?.phase === 'done';
            // D15a: Install P9 there asks first, in place: what happens, where, and what it never does. Then the poll shows its progress.
            if (!asking) why.textContent = result.install ? installWhy(host, result.install) : REMOTE_WHY[result.error ?? ''] ?? 'Not connected yet (' + result.error + ')';
            install.hidden = running || !(asking || result.error === 'server-no-p9') || !window.p9?.remoteInstall;
            install.textContent = asking ? 'Install' : result.install?.phase === 'failed' ? 'Try the install again' : 'Install P9 there';
            no.hidden = !asking;
            install.onclick = () => {
              if (!asking) {
                asking = true; install.textContent = 'Install'; no.hidden = false;
                why.textContent = 'Install P9 on ' + host + '? Over your ssh login, P9 puts its source in ~/p9 there, builds it and starts its background service for your user. '
                  + 'It never uses sudo or a password: anything that needs an admin is listed for you to run. It takes a few minutes.';
                return;
              }
              asking = false; no.hidden = true; install.hidden = true; why.textContent = 'Installing P9 on ' + host + '…';
              void window.p9?.remoteInstall?.().catch(() => {});
            };
            no.onclick = () => { asking = false; no.hidden = true; install.textContent = 'Install P9 there'; why.textContent = REMOTE_WHY[result.error ?? ''] ?? ''; };
            document.getElementById('connLocal')!.onclick = () => void window.p9?.server?.(null);
            if (!layer.open) { layer.addEventListener('cancel', e => e.preventDefault()); layer.showModal(); }
          }
          if (ok && waited && !connected) return location.reload();
          if (ok) { connected = true; if (layer?.open) layer.close(); } else waited = true;
          if (label) {
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
