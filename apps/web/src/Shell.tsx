import { useEffect } from 'react';
import shell from './shell.html?raw';
import hole from './black-hole.html?raw';
import './styles/black-hole.css';

const markup = shell.replace('<!--black-hole-->', hole);
import { mountShell } from './controller.mjs';

declare global {
  interface Window { p9?: { getStatus(): Promise<{ status: 'ok' | 'unavailable'; reason?: 'task-missing' | 'task-stale' | 'not-answering'; savedWorkspace?: string; workspace?: string; mode?: 'server'; host?: string; error?: string; knownHosts?: { file: string; line: number }; install?: RemoteInstall; sshAsk?: SshAsk; keyOffer?: { id: number }; background?: boolean; slim?: boolean; ask?: boolean; keeping?: Keeping }>; remoteKeep?(yes: boolean, remember: boolean): Promise<unknown>; sshAnswer?(answer: string | null): Promise<unknown>; sshKey?(yes: boolean, never: boolean): Promise<{ ok?: boolean; error?: string }>; sshKeySetting?(host: string): Promise<unknown>; remoteAdmin?(password: string): Promise<{ ok?: boolean; error?: string }>; remoteDepsCheck?(): Promise<{ command?: string; error?: string }>; remoteDeps?(password: string): Promise<{ ok?: boolean; error?: string }>; usage(): Promise<unknown>; server?(...host: (string | null)[]): Promise<{ host?: string | null; last?: string | null }> } }
}

// Remote mode (desktop/remote.mjs): why the window is not on the remote yet.
const REMOTE_WHY: Record<string, string> = {
  'server-connecting': 'Opening the ssh tunnel and waiting for P9 there to answer.',
  'server-unreachable': 'The remote is not reachable over ssh: check it is on and that its name or address is right.',
  'ssh-login-needed': 'ssh needs your password for this remote. Type it in the window that opened.',
  'ssh-refused': 'The remote did not accept the password. Press Try again to type it again.',
  'ssh-cancelled': 'Connecting stopped before the password was typed. Press Try again when you are ready.',
  'ssh-failed': 'ssh could not log in to the remote. Check its name or address, then press Try again.',
  'ssh-host-key-changed': 'The remote\'s ssh host key has changed, so P9 will not connect or ask for a password.',
  'ssh-key-needed': 'The remote needs an ssh key from this computer: on Windows, P9 connects with keys only.',
  'server-no-p9': 'P9 is not running there yet. Setting it up…',
  'server-not-answering': 'The tunnel opened, but P9 on the remote did not answer.',
  'server-host-refused': 'ssh refused that host name.',
  'server-dropped': 'Lost the remote: connecting again.',
};

// Row 78 (desktop/ssh-login.mjs): the password the waiting ssh login asks for. A new host key is never asked (accept-new).
// Row 78: a changed host key, said plainly, with the known_hosts line ssh pointed at. P9 never edits known_hosts itself.
const keyChanged = (host: string, kh?: { file: string; line: number }) => 'The ssh host key of ' + host + ' is not the one your known_hosts file has for it, '
  + 'so P9 will not connect and will not ask for your password. A reinstalled remote gets a new key; so does another machine answering in its place. '
  + 'If you know why it changed, remove the old key' + (kh ? ' (' + kh.file + ' line ' + kh.line + ')' : '') + ' with ssh-keygen -R ' + host + ', then press Try again.';
// Windows (0.1.6: keys only, no password window): the remote refused every key. How to add one, so nobody has to look it up.
const keyNeeded = (host: string) => host + ' needs an ssh key from this computer: on Windows, P9 connects with an ssh key only, never a password. To add one:';
const keySteps = (host: string, show: boolean) => {
  const steps = document.getElementById('connSteps')!, add = document.getElementById('connAddKey')!;
  steps.hidden = !show; if (!show) return;
  const line = 'type $env:USERPROFILE\\.ssh\\id_ed25519.pub | ssh ' + host + ' "umask 077; mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"';
  if (add.textContent !== line) { add.textContent = line; steps.querySelector('[data-host]')!.textContent = host; } // set once: a poll keeps a selection
};
type SshAsk = { id: number; prompt: string; again?: boolean; dropped?: boolean };
const askSsh = (host: string, ask: SshAsk) => {
  const dialog = document.getElementById('sshDlg') as HTMLDialogElement | null, pw = document.getElementById('sshPw') as HTMLInputElement | null;
  if (!dialog || !pw || dialog.open || !window.p9?.sshAnswer) return;
  document.getElementById('sshT')!.textContent = 'Password for ' + host;
  document.getElementById('sshP')!.textContent = (ask.dropped ? 'The connection to ' + host + ' dropped. ' : '') + 'No ssh key works for ' + host + ', so ssh needs your password to ' + (ask.dropped ? 'connect again.' : 'log in.');
  document.getElementById('sshL')!.textContent = ask.prompt.trim().replace(/:$/, '');
  pw.required = true;
  document.getElementById('sshErr')!.hidden = !ask.again;
  document.getElementById('sshOk')!.textContent = 'Connect';
  pw.value = '';
  dialog.returnValue = '';
  // The answer goes to main once; the field is emptied whenever the window closes. Cancel (or Esc) stops the login.
  dialog.onclose = () => {
    const password = pw.value;
    pw.value = '';
    void window.p9?.sshAnswer?.(dialog.returnValue === 'ok' ? password || null : null).catch(() => {});
  };
  dialog.showModal();
  pw.focus();
};

// Row 79, since U6 (threat model row 50 U6): the key offer is a checkbox on the keep window (below). When adding the key
// fails, the status bar says so for 30 s; success says nothing.
const KEY_SAID: Record<string, string> = {
  'key-not-made': 'This computer could not make the key, so P9 asks for your password on HOST next time',
  'key-not-accepted': 'HOST did not accept P9\'s key, so P9 asks for your password there next time',
};

// D15a (desktop/remote-install.mjs), since U6 run by main on Connect (main.mjs setUp): starting is main trying the start
// first, then the install, as the status poll reports it. Plain words; the steps stay in connStep and, on a failure, connLog.
type RemoteInstall = { phase: 'starting' | 'running' | 'done' | 'failed' | 'already-there' | 'admin'; line?: string; tail?: string; error?: string; started?: number; need?: string[]; command?: string; server?: string };
// P9_INSTALL and P9_ADMIN lines are for main, not for people.
const lastLine = (text = '') => text.split('\n').filter(l => l.trim() && !l.startsWith('P9_')).pop() ?? '';
const needNames = (need: string[] = []) => need.map(n => n.split(':')[0]).join(', ');
const installWhy = (host: string, i: RemoteInstall) => ({
  starting: 'Starting P9 on ' + host + '…',
  running: 'Setting up P9 on ' + host + '. The first time takes a few minutes.',
  done: 'P9 is ready on ' + host + '. Connecting…',
  admin: host + ' needs ' + (needNames(i.need) || 'a few tools') + ' before P9 can run there, and only an admin can add ' + ((i.need?.length ?? 0) > 1 ? 'them' : 'it') + '. Press Continue.',
  'already-there': host + ' has a ~/p9 folder this app did not make, so P9 leaves it alone. Rename or remove that folder there, then press Try again.',
  failed: 'Setting up P9 on ' + host + ' stopped' + ({ 'timed-out': ' after 30 minutes', 'not-answering': ': P9 started there but did not answer', 'server-unreachable': ': the connection was lost', 'ssh-failed': ': ssh did not start', 'install-failed': '', 'missing-tools': ': ' + host + ' is missing ' + (needNames(i.need) || 'tools P9 needs') + ' and has no package manager P9 knows', 'not-allowed': ': your account there cannot install software', 'newer-there': ': ' + host + ' has P9 ' + (i.server ?? '') + ', newer than this app, and P9 never replaces it with an older one. Update this app first' }[i.error ?? ''] ?? ' (' + i.error + ')')
    + '. ' + (i.error === 'not-allowed' || i.error === 'missing-tools' ? 'Someone who administers ' + host + ' must install ' + (needNames(i.need) || 'them') + ', then press Try again.' : (i.tail ? 'Its last lines are below. ' : '') + 'Press Try again.'),
}[i.phase]);
// Row I1: P9 on a remote in background mode stops when nobody uses it. One line in the status bar says so, with Make it
// always on; after the first connect there, one question (Temporary or Always on, U6). keeping: the last switch main ran there (desktop main.mjs applyKeep).
// full (U8): Always on asked on the slim Temporary P9, so main installs the full one (the connecting screen shows it).
type Keeping = { action: 'keep' | 'release'; phase: 'running' | 'ok' | 'refused' | 'no-start' | 'failed' | 'wrong-password' | 'not-allowed' | 'full'; command?: string };
// slim (U8): the small Temporary P9 there has no Mission Control; Always on installs the full P9, which has it.
const keepLine = (host: string, background?: boolean, k?: Keeping, slim?: boolean): [string, string] | null => {
  if (k?.phase === 'full' && background) return ['Installing the full P9 on ' + host + ' for Always on…', ''];
  if (k?.phase === 'running') return [k.action === 'keep' ? 'Making P9 always on on ' + host + '…' : 'Making P9 on ' + host + ' temporary…', ''];
  if (k?.phase === 'refused') return ['Always on for ' + host + ' needs an admin password', 'Use admin password'];
  if (k?.phase === 'wrong-password') return ['That admin password did not work on ' + host, 'Use admin password'];
  if (k?.phase === 'not-allowed') return ['Your account on ' + host + ' cannot make P9 always on; someone who administers it can allow it', ''];
  if (k?.phase === 'no-start') return ['P9 on ' + host + ' was installed before this choice existed, so it cannot switch', ''];
  if (k?.phase === 'failed') return ['Could not change how P9 runs on ' + host, 'Try again'];
  return background ? ['P9 on ' + host + ' is temporary' + (slim ? ' (no Mission Control)' : '') + ': it stops when you disconnect', 'Make it always on'] : null;
};
// Row I2: the password window for one admin step on host. need: "name: reason" lines; command: exactly what runs as admin.
// The password goes to main once (p9:remote-admin) and the field is emptied whenever the window closes.
// send: where the password goes (Keep it running and the install: p9:remote-admin; row 61 on a remote: p9:remote-deps).
const askAdmin = (host: string, title: string, lead: string, need: string[], command: string, ok: string, error: string,
  done: (r?: { ok?: boolean; error?: string }) => void, send = window.p9?.remoteAdmin) => {
  const dialog = document.getElementById('adminDlg') as HTMLDialogElement | null, pw = document.getElementById('adminPw') as HTMLInputElement | null;
  if (!dialog || !pw || dialog.open || !send) return;
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
    if (dialog.returnValue === 'ok' && password) void send(password).then(done, () => done({ error: 'admin-failed' }));
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
    const dispose = mountShell({ askAdmin });
    let keepAsked = false, adminAsked = '', sshAsked = 0, keyAsked = 0, keySaid = '';
    let active = true, waited = false, connected = false, timer: ReturnType<typeof setTimeout> | undefined;
    // D20: the remote this window has shown.
    let shown = '';
    // The title-bar badge (Remote · host or Local) and its machine menu: controller.mjs, serverMenu.
    // Asks again every 5 s until the daemon answers: asked once, the label said unavailable forever (issue #6 B3).
    const ask = () => void (window.p9?.getStatus() ?? Promise.resolve({ status: 'unavailable' as const }))
      .catch(() => ({ status: 'unavailable' as const }))
      .then((result: { status: string; reason?: string; savedWorkspace?: string; workspace?: string; mode?: string; host?: string; error?: string; install?: RemoteInstall; sshAsk?: SshAsk; keyOffer?: { id: number }; background?: boolean; slim?: boolean; ask?: boolean; keeping?: Keeping }) => {
        const label = document.getElementById('daemonStatus'), disconnect = document.getElementById('disconnectBtn');
        if (!active) return;
        // Remote mode asks every 5 s even when connected: a lost tunnel shows here, and main connects again on its own.
        if (result.mode === 'server') {
          // D20: the full connecting layer only while this window has never shown this remote. A window that loaded before it
          // answered loads once more, so its chats and Mission Control come from the remote. After that a slow or failed poll
          // (a slow network, the tunnel rebuilt) shows nothing: main reconnects on its own, and only what the user does waits
          // where they did it (a send's working row, a page's Loading).
          const layer = document.getElementById('connecting') as HTMLDialogElement | null, ok = result.status === 'ok', known = shown === result.host;
          // Row 78: a window already on this remote shows the layer again only when the ssh login needs the person.
          const person = !!result.sshAsk || /^ssh-(refused|cancelled|failed)$/.test(result.error ?? '');
          if (layer && !ok && (!known || person)) {
            document.getElementById('connT')!.textContent = (/^ssh-(host-key-changed|key-needed)$/.test(result.error ?? '') ? 'Not connecting to ' : known ? 'Reconnecting to ' : 'Connecting to ') + result.host;
            const why = document.getElementById('connWhy')!, cont = document.getElementById('connAdmin') as HTMLButtonElement;
            const host = result.host ?? '', i = result.install, phase = i?.phase;
            // U6 (threat model row 50 U6): Connect is the yes. Main starts or installs P9 there on its own; this layer shows the
            // black hole, one plain line and the progress. Only the admin step and errors need the person.
            const busy = phase === 'starting' || phase === 'running' || phase === 'done' || (result.error === 'server-no-p9' && !i);
            // Row I2: the set-up stopped at an admin step. The window opens once for each stop; Continue opens it again.
            const admin = phase === 'admin' && !!i?.command && !!window.p9?.remoteAdmin;
            const openAdmin = () => askAdmin(host, 'P9 needs a few tools on ' + host, 'Only an admin can add them. Type your admin password and P9 adds them, then carries on:',
              i?.need ?? [], i?.command ?? '', 'Install', i?.error === 'wrong-password' ? 'That password did not work. Check it and try again.' : '', ask);
            if (admin && adminAsked !== i!.started + (i!.error ?? '')) { adminAsked = i!.started + (i!.error ?? ''); openAdmin(); }
            cont.hidden = !admin; cont.onclick = openAdmin;
            // Row 78 and U6: a refused or cancelled login, or a set-up that stopped, offers Try again (main starts over).
            const retry = document.getElementById('connRetry') as HTMLButtonElement;
            retry.hidden = !/^ssh-(refused|cancelled|failed|host-key-changed|key-needed)$/.test(result.error ?? '') && phase !== 'failed' && phase !== 'already-there';
            if (retry.hidden) retry.disabled = false;
            retry.onclick = () => { retry.disabled = true; void window.p9?.server?.(host); };
            why.textContent = (result.sshAsk?.dropped ? 'The connection to ' + host + ' dropped. No ssh key works there, so P9 needs your password to connect again.' : '') || (result.error === 'ssh-host-key-changed' ? keyChanged(host, result.knownHosts) : result.error === 'ssh-key-needed' ? keyNeeded(host) : '') || (i ? installWhy(host, i) : REMOTE_WHY[result.error ?? ''] ?? 'Not connected yet (' + result.error + ')');
            keySteps(host, result.error === 'ssh-key-needed');
            const progress = document.getElementById('connProgress')!, log = document.getElementById('connLog')!;
            progress.hidden = !busy;
            document.getElementById('connStep')!.textContent = phase === 'done' ? 'Ready' : phase === 'running' ? lastLine(i?.line) || 'Setting up' : 'Starting P9';
            document.getElementById('connTime')!.textContent = elapsed(i?.started);
            log.hidden = phase !== 'failed' || !i?.tail;
            log.textContent = (i?.tail ?? '').split('\n').filter(l => !l.startsWith('P9_')).join('\n');
            document.getElementById('connLocal')!.onclick = () => void window.p9?.server?.(null);
            if (!layer.open) { layer.addEventListener('cancel', e => e.preventDefault()); layer.showModal(); }
            // After the layer opens, so the password window sits on top of it.
            if (result.sshAsk && result.sshAsk.id !== sshAsked) { sshAsked = result.sshAsk.id; askSsh(host, result.sshAsk); }
          }
          if (ok && waited && !connected) return location.reload();
          if (ok) { connected = true; shown = result.host ?? ''; if (layer?.open) layer.close(); } else waited = true;
          if (label && (ok || !known)) {
            label.textContent = result.status === 'ok' ? 'Connected to ' + result.host : (REMOTE_WHY[result.error ?? ''] ?? 'Remote unavailable (' + result.error + ')');
            label.title = 'Remote mode: chats, Mission Control and the terminal run on ' + result.host + '. Disconnect switches back to this computer.';
          }
          // U9: Disconnect beside the label, the same switch as Settings > Remote Connect's This computer (p9:server(null)). A
          // Temporary P9 there stops on its own 5 minutes after its last client (row I1, --idle-exit 300).
          if (disconnect && ok) {
            disconnect.hidden = false;
            disconnect.title = 'Back to this computer.' + (result.background ? ' P9 on ' + result.host + ' is temporary, so it stops there 5 minutes later.' : ' P9 keeps running on ' + result.host + '.');
            disconnect.onclick = () => { (disconnect as HTMLButtonElement).disabled = true; void window.p9?.server?.(null); };
          }
          const note = document.getElementById('keepNote'), line: [string, string] | null = ok ? (keySaid ? [keySaid, ''] : keepLine(result.host ?? '', result.background, result.keeping, result.slim)) : null;
          if (note && window.p9?.remoteKeep) {
            note.hidden = !line;
            const keepText = document.getElementById('keepText')!; keepText.textContent = keepText.title = line?.[0] ?? '';
            const button = document.getElementById('keepBtn') as HTMLButtonElement;
            button.hidden = !line?.[1]; button.textContent = line?.[1] ?? '';
            const k = result.keeping, host = result.host ?? '';
            button.onclick = (k?.phase === 'refused' || k?.phase === 'wrong-password') && k.command
              ? () => askAdmin(host, 'Make P9 always on for ' + host, 'For P9 to keep running after you sign out, your account there needs one admin setting.',
                [], k.command!, 'Make it always on', k.phase === 'wrong-password' ? 'That password did not work. Check it and try again.' : '', ask)
              : () => { button.hidden = true; void window.p9?.remoteKeep?.(true, false).finally(ask); };
          }
          // U6 (row I1 and row 79, threat model row 50 U6): one window after connecting. Temporary or Always on when that question
          // is due; after a password login, the key checkbox (ticked). Only the checkbox due: the same window titled Connected, with Done.
          const dialog = document.getElementById('keepDlg') as HTMLDialogElement | null;
          const askKeep = ok && !!result.ask && !keepAsked && !!window.p9?.remoteKeep;
          const offer = ok && !!result.keyOffer && result.keyOffer.id !== keyAsked && !!window.p9?.sshKey;
          if (dialog && !dialog.open && (askKeep || offer)) {
            const host = result.host ?? '', box = document.getElementById('keepKey') as HTMLInputElement, remember = document.getElementById('keepRemember') as HTMLInputElement;
            if (askKeep) keepAsked = true;
            if (offer) keyAsked = result.keyOffer!.id;
            document.getElementById('keepT')!.textContent = askKeep ? 'How should P9 run on ' + host + '?' : 'Connected to ' + host;
            // style, not hidden: .keep-ways and .keep-again set their own display.
            for (const id of ['keepP', 'keepWays', 'keepRememberRow', 'keepNo', 'keepYes']) document.getElementById(id)!.style.display = askKeep ? '' : 'none';
            document.getElementById('keepDone')!.style.display = askKeep ? 'none' : '';
            document.getElementById('keepKeyRow')!.style.display = offer ? '' : 'none';
            box.checked = true; remember.checked = false;
            dialog.onclose = () => {
              const v = dialog.returnValue;
              if (askKeep && (v === 'yes' || v === 'no')) void window.p9?.remoteKeep?.(v === 'yes', remember.checked).finally(ask);
              if (!offer) return;
              // Unticked, or Esc: adds nothing, and the no is remembered (Settings > Remote Connect offers it again).
              if (!v || !box.checked) return void window.p9?.sshKey?.(false, true).catch(() => {});
              void (window.p9?.sshKey?.(true, false) ?? Promise.reject(new Error('no-bridge'))).catch(() => ({ error: 'key-failed' })).then((r?: { ok?: boolean; error?: string }) => {
                if (r?.ok) return;
                keySaid = (KEY_SAID[r?.error ?? ''] ?? 'P9\'s key could not be added to HOST, so P9 asks for your password there next time').replaceAll('HOST', host);
                setTimeout(() => { keySaid = ''; }, 30000);
              });
            };
            dialog.returnValue = '';
            dialog.showModal();
            (askKeep ? document.getElementById('keepYes')! : document.getElementById('keepDone')!).focus();
          }
          timer = setTimeout(ask, ok ? 5000 : 1000);
          return;
        }
        if (disconnect) disconnect.hidden = true;
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
