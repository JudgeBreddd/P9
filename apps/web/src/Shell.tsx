import { useEffect } from 'react';
import markup from './shell.html?raw';
import { mountShell } from './controller.mjs';

declare global {
  interface Window { p9?: { getStatus(): Promise<{ status: 'ok' | 'unavailable'; reason?: 'task-missing' | 'task-stale' | 'not-answering'; savedWorkspace?: string; workspace?: string; mode?: 'server'; host?: string; error?: string }>; usage(): Promise<unknown>; server?(...host: (string | null)[]): Promise<{ host?: string | null; last?: string | null }> } }
}

// Server mode (desktop/remote.mjs): why the window is not on the server yet.
const SERVER_WHY: Record<string, string> = {
  'server-connecting': 'Connecting to the server',
  'server-unreachable': 'Server not reachable over ssh: check it is on and that ssh to it works without a password prompt',
  'server-no-p9': 'The server answered, but P9 is not running there',
  'server-not-answering': 'The tunnel opened, but P9 on the server did not answer',
  'server-host-refused': 'ssh refused that host name',
  'server-dropped': 'Lost the server: connecting again',
};

export default function Shell() {
  useEffect(() => {
    const dispose = mountShell();
    let active = true, timer: ReturnType<typeof setTimeout> | undefined;
    // The title-bar badge: Server · host while on a server; Local once a server was used, so one click goes back to it.
    void window.p9?.server?.().then(({ host, last }) => {
      const badge = document.getElementById('serverBadge');
      if (!active || !badge || !(host || last)) return;
      badge.hidden = false;
      badge.textContent = host ? 'Server · ' + host : 'Local';
      badge.title = host ? 'This window works on ' + host + '. Click to switch to this computer.' : 'This window works on this computer. Click to switch to ' + last + '.';
      badge.onclick = () => void window.p9?.server?.(host ? null : last ?? null);
    }, () => {});
    // Asks again every 5 s until the daemon answers: asked once, the label said unavailable forever (issue #6 B3).
    const ask = () => void (window.p9?.getStatus() ?? Promise.resolve({ status: 'unavailable' as const }))
      .catch(() => ({ status: 'unavailable' as const }))
      .then((result: { status: string; reason?: string; savedWorkspace?: string; workspace?: string; mode?: string; host?: string; error?: string }) => {
        const label = document.getElementById('daemonStatus');
        if (!active) return;
        // Server mode asks every 5 s even when connected: a lost tunnel shows here, and main connects again on its own.
        if (result.mode === 'server') {
          if (label) {
            label.textContent = result.status === 'ok' ? 'Connected to ' + result.host : (SERVER_WHY[result.error ?? ''] ?? 'Server unavailable (' + result.error + ')');
            label.title = 'Server mode: chats, Mission Control and the terminal run on ' + result.host + '. Settings > Server switches back to this computer.';
          }
          timer = setTimeout(ask, 5000);
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
