import { useEffect } from 'react';
import shell from './shell.html?raw';
import hole from './black-hole.html?raw';
import './styles/black-hole.css';

const markup = shell.replace('<!--black-hole-->', hole);
import { mountShell } from './controller.mjs';

declare global {
  interface Window { p9?: { getStatus(): Promise<{ status: 'ok' | 'unavailable'; reason?: 'task-missing' | 'task-stale' | 'not-answering'; savedWorkspace?: string; workspace?: string; mode?: 'server'; host?: string; error?: string; knownHosts?: { file: string; line: number }; install?: RemoteInstall; sshAsk?: SshAsk; keyOffer?: { id: number }; background?: boolean; ask?: boolean; keeping?: Keeping }>; remoteInstall?(): Promise<{ ok?: boolean; error?: string }>; remoteStart?(): Promise<{ result?: string; error?: string }>; remoteKeep?(yes: boolean, remember: boolean): Promise<unknown>; sshAnswer?(answer: string | null): Promise<unknown>; sshKey?(yes: boolean, never: boolean): Promise<{ ok?: boolean; error?: string }>; sshKeySetting?(host: string): Promise<unknown>; remoteAdmin?(password: string): Promise<{ ok?: boolean; error?: string }>; remoteDepsCheck?(): Promise<{ command?: string; error?: string }>; remoteDeps?(password: string): Promise<{ ok?: boolean; error?: string }>; usage(): Promise<unknown>; server?(...host: (string | null)[]): Promise<{ host?: string | null; last?: string | null }> } }
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
  'server-no-p9': 'The remote answered, but P9 is not running there. If P9 is installed there, start it; if not, install it from here.',
  'server-not-answering': 'The tunnel opened, but P9 on the remote did not answer.',
  'server-host-refused': 'ssh refused that host name.',
  'server-dropped': 'Lost the remote: connecting again.',
};

// Row 78 (desktop/ssh-login.mjs): what the waiting ssh login asks. A prompt with (yes/no is a host key seen for the first time.
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
  const key = /\(yes\/no/i.test(ask.prompt);
  document.getElementById('sshT')!.textContent = key ? 'Trust ' + host + '?' : 'Password for ' + host;
  document.getElementById('sshP')!.textContent = key
    ? 'This computer has not connected to ' + host + ' before. ssh shows its key below. Trust it if this is the machine you meant.'
    : (ask.dropped ? 'The connection to ' + host + ' dropped. ' : '') + 'No ssh key works for ' + host + ', so ssh needs your password to ' + (ask.dropped ? 'connect again.' : 'log in.');
  const said = document.getElementById('sshKey')!;
  said.textContent = key ? ask.prompt.trim() : ''; said.hidden = !key;
  document.getElementById('sshL')!.textContent = ask.prompt.trim().replace(/:$/, '');
  for (const id of ['sshL', 'sshPw', 'sshNote']) document.getElementById(id)!.hidden = key;
  pw.required = !key;
  document.getElementById('sshErr')!.hidden = !ask.again;
  document.getElementById('sshOk')!.textContent = key ? 'Trust and connect' : 'Connect';
  pw.value = '';
  dialog.returnValue = '';
  // The answer goes to main once; the field is emptied whenever the window closes. Cancel (or Esc) stops the login.
  dialog.onclose = () => {
    const password = pw.value;
    pw.value = '';
    void window.p9?.sshAnswer?.(dialog.returnValue === 'ok' ? (key ? 'yes' : password || null) : null).catch(() => {});
  };
  dialog.showModal();
  (key ? document.getElementById('sshOk')! : pw).focus();
};

// Row 79: the offer after a password login. Yes makes P9's key and adds it to host, and the window says how that went;
// No (or Esc) changes nothing. Don't ask again is kept for this remote; Settings > Remote Connect offers it again.
const KEY_SAID: Record<string, string> = {
  'key-not-made': 'This computer could not make the key (ssh-keygen failed). Nothing was added to HOST.',
  'key-not-accepted': 'The key was added to HOST, but HOST does not accept it, so P9 still asks for your password there.',
};
const offerKey = (host: string, dialog: HTMLDialogElement) => {
  const yes = document.getElementById('keyYes') as HTMLButtonElement, no = document.getElementById('keyNo')!, never = document.getElementById('keyNever') as HTMLInputElement, said = document.getElementById('keyMsg')!;
  document.getElementById('keyT')!.textContent = 'Connect to ' + host + ' without a password?';
  // The approved copy: what a key is and what Yes does, here and there, for someone new to ssh keys. No hint at No.
  document.getElementById('keyP')!.textContent = 'An ssh key is a pair of matching files that proves it is you, in place of your password.';
  document.getElementById('keyWhat')!.textContent = 'Yes makes a key for P9 on this computer, in P9\'s own folder. On ' + host + ', it adds the key\'s public half '
    + 'to your account\'s list of allowed keys (~/.ssh/authorized_keys). After that, P9 connects to ' + host + ' without your password. '
    + 'To undo it, delete the line marked p9-event-horizon from that list.';
  never.checked = false; said.hidden = true; no.hidden = false; yes.disabled = false; yes.textContent = 'Yes, add a key';
  // style, not hidden: .keep-again sets its own display.
  for (const id of ['keyNeverRow', 'keyLater']) document.getElementById(id)!.style.display = '';
  dialog.returnValue = '';
  let done = false;
  yes.onclick = e => {
    if (done) return;
    e.preventDefault(); yes.disabled = true; no.hidden = true; said.hidden = false;
    for (const id of ['keyNeverRow', 'keyLater']) document.getElementById(id)!.style.display = 'none';
    said.textContent = 'Making the key and adding it to ' + host + '…';
    void (window.p9?.sshKey?.(true, never.checked) ?? Promise.reject(new Error('no-bridge'))).catch(() => ({ error: 'key-failed' })).then((r?: { ok?: boolean; error?: string }) => {
      done = true; yes.disabled = false; yes.textContent = 'Close';
      said.textContent = r?.ok ? 'Done. P9 logs in to ' + host + ' with its own key from now on.'
        : (KEY_SAID[r?.error ?? ''] ?? 'The key could not be added to HOST, and nothing changed there. P9 asks for your password next time.').replaceAll('HOST', host);
    });
  };
  dialog.onclose = () => { if (!done) void window.p9?.sshKey?.(false, never.checked).catch(() => {}); };
  dialog.showModal();
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
    let keepAsked = false, adminAsked = '', sshAsked = 0, keyAsked = 0;
    let active = true, waited = false, connected = false, asking = false, starting = false, refused = '', startSaid = '', timer: ReturnType<typeof setTimeout> | undefined;
    // D20: the remote this window has shown.
    let shown = '';
    // The title-bar badge (Remote · host or Local) and its machine menu: controller.mjs, serverMenu.
    // Asks again every 5 s until the daemon answers: asked once, the label said unavailable forever (issue #6 B3).
    const ask = () => void (window.p9?.getStatus() ?? Promise.resolve({ status: 'unavailable' as const }))
      .catch(() => ({ status: 'unavailable' as const }))
      .then((result: { status: string; reason?: string; savedWorkspace?: string; workspace?: string; mode?: string; host?: string; error?: string; install?: RemoteInstall; sshAsk?: SshAsk; keyOffer?: { id: number }; background?: boolean; ask?: boolean; keeping?: Keeping }) => {
        const label = document.getElementById('daemonStatus');
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
            const why = document.getElementById('connWhy')!, install = document.getElementById('connInstall') as HTMLButtonElement, no = document.getElementById('connNo')!;
            const host = result.host ?? '', i = result.install, phase = i?.phase;
            if (phase === 'running') refused = '';
            const busy = starting || phase === 'running' || phase === 'done';
            // Row I2: the install stopped at an admin step. The window opens once for each stop; Continue opens it again.
            const admin = phase === 'admin' && !!i?.command && !!window.p9?.remoteAdmin;
            const openAdmin = () => askAdmin(host, 'Install what P9 needs on ' + host, host + ' is missing what P9 needs to install, and only an admin can add it:',
              i?.need ?? [], i?.command ?? '', 'Install', i?.error === 'wrong-password' ? 'That password did not work. Check it and try again.' : '', ask);
            if (admin && adminAsked !== i!.started + (i!.error ?? '')) { adminAsked = i!.started + (i!.error ?? ''); openAdmin(); }
            // Row 78: the ssh login's question opens the password window once; a refused or cancelled login offers Try again.
            const retry = document.getElementById('connRetry') as HTMLButtonElement;
            retry.hidden = !/^ssh-(refused|cancelled|failed|host-key-changed|key-needed)$/.test(result.error ?? '');
            retry.onclick = () => { retry.disabled = true; void window.p9?.server?.(host); };
            // D15a: Install P9 there asks first, in place: what happens, where, and what it never does. Then the poll shows its
            // progress (a reopened window too: main keeps it): the button stays off, a spinner, the last line, the time so far.
            if (!asking) why.textContent = refused || startSaid || (result.sshAsk?.dropped ? 'The connection to ' + host + ' dropped. No ssh key works there, so P9 needs your password to connect again.' : '') || (result.error === 'ssh-host-key-changed' ? keyChanged(host, result.knownHosts) : result.error === 'ssh-key-needed' ? keyNeeded(host) : '') || (i ? installWhy(host, i) : REMOTE_WHY[result.error ?? ''] ?? 'Not connected yet (' + result.error + ')');
            keySteps(host, !asking && result.error === 'ssh-key-needed');
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
            // After the layer opens, so the password window sits on top of it.
            if (result.sshAsk && result.sshAsk.id !== sshAsked) { sshAsked = result.sshAsk.id; askSsh(host, result.sshAsk); }
          }
          if (ok && waited && !connected) return location.reload();
          if (ok) { connected = true; shown = result.host ?? ''; if (layer?.open) layer.close(); } else waited = true;
          if (label && (ok || !known)) {
            label.textContent = result.status === 'ok' ? 'Connected to ' + result.host : (REMOTE_WHY[result.error ?? ''] ?? 'Remote unavailable (' + result.error + ')');
            label.title = 'Remote mode: chats, Mission Control and the terminal run on ' + result.host + '. Settings > Remote switches back to this computer.';
          }
          // Row 79: the key offer, once per password login, before Keep P9 running's question.
          const keyDlg = document.getElementById('keyDlg') as HTMLDialogElement | null;
          if (ok && result.keyOffer && result.keyOffer.id !== keyAsked && keyDlg && !keyDlg.open && window.p9?.sshKey) { keyAsked = result.keyOffer.id; offerKey(result.host ?? '', keyDlg); }
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
            if (ok && result.ask && !keepAsked && dialog && !dialog.open && !keyDlg?.open) {
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
