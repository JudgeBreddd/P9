# Phase 3 security boundary

P9 currently exposes one owner-only Unix socket in an owner-only runtime directory.
Every request, including HEAD, OPTIONS, unknown routes and WebSocket upgrades, needs
a desktop cookie. HTTP requests require the exact P9 host and origin. Mutating
requests and upgrades also need a separate CSRF token. Nothing is publicly exempt.

Production does not bind TCP unless Phase 10's opt-in loopback listener is turned on (see
below); there, passkeys, enrollment, lock, revoke and reset are built. Tailscale deployment
is Phase 11.
Proxy identity headers and a loopback source address never authenticate a caller.

File reads refuse traversal, symbolic links, hardlinks, locked names, invalid UTF-8,
NUL bytes and files over 2 MiB. File handles anchor resolution within the workspace.
Locked names are case-insensitive, including `.git`, `.env*`, `secrets` and the
`_private` folder names. These locks apply only to P9's own routes, and only while File protection
is on (see File protection below).

The Linux daemon takes a nonblocking exclusive lock on the fixed daemon.lock file
under .local/state/p9-foundation in os.homedir(). XDG_STATE_HOME is ignored for
ownership, so changing it does not permit another daemon. Only one P9 daemon may
run per user, including nested, disjoint and aliased workspaces or different runtime
directories. The owner-only directory and file are checked before locking. The open
handle retains the kernel lock; process exit, including SIGKILL, releases it. The
lock file stays in place and must not be deleted to clear ownership. Replacing the
lock file or deliberately altering the process home remains outside cooperative
same-user ownership. This uses Linux flock on this host; no cross-machine or
network-filesystem ownership guarantee is claimed.

P9 serializes its own saves per file and checks the content hash before replacement.
It writes and syncs a temporary file in the target directory, rechecks the path and
content, renames it over the target, then syncs the directory. Existing permission
bits are preserved, excluding special bits. Successful replacement returns HTTP 200.

A detected conflict leaves the disk version alone and returns HTTP 409, an opaque
recovery identifier, the draft content and, when safely readable, disk content and
its hash for comparison. The user can compare, keep disk content, or submit a resolved
draft against that disk hash. A further detected change conflicts again; no force
overwrite endpoint bypasses the checks. The editor's comparison UI is a later phase.

Drafts are JSON records in a separate owner-only durable recovery directory. Each
contains workspace, relative path, expected hash, draft hash, last safely read disk
hash when known, content, reason and createdAt. The whole record is synced and
atomically published before any target open or read; outcome updates use the same protocol.
Missing targets and targets that became links, binary, oversized or changed paths,
including a moved workspace root, return 409 path-conflict with a draft. They are
never replaced and their disk contents are not returned. Locked names, unsafe path
syntax, components exceeding 255 UTF-8 bytes and invalid draft content or Unicode
are refused before recovery writes. Initial target permission and I/O failures
retain a save-failed record and return its ID and draft without disk content, with
HTTP 403 (also a read-only disk), 503 (file busy, held by another program), 500 or 507 as appropriate. If recovery storage itself fails, the API
returns the storage error without claiming a retained draft. The opened root must
resolve to the canonical startup path, including after ancestor symlink changes.

SIGTERM and SIGINT use [Node's server.close](https://nodejs.org/api/http.html#serverclosecallback)
to stop accepting connections, let active requests finish and drain
queued saves before credentials and ownership are released. A 10-second deadline
closes remaining connections and exits with failure if I/O or a client is stuck.
That forced exit has the same recovery limits as a crash; normal shutdown completes
save outcomes and cleanup before exiting.

Reasons hash-conflict/path-conflict identify detected conflicts; save-pending means
an interrupted attempt whose outcome is unknown, not a confirmed conflict. Compare
its draftHash with the current safe target before offering recovery. A kill after
rename can leave save-pending with the new content already on disk. A synced success
is marked saved before cleanup. Cleanup failure returns HTTP 200 with draftRetained
and a recovery ID, and emits the allowlisted P9_DRAFT_RETAINED event without paths
or content; it does not report uncertain target durability. Successful cleanup
unlinks the record; its disappearance across power loss is not guaranteed.
Conflicted/failed/interrupted records remain. Neither credentials nor recovery drafts may live in the workspace.
Process death can also leave a reserved temporary file; it is never treated as a user
file. Recovery listing and retention UI are not implemented yet.

**Limit:** an independent same-user writer can change the target or directory after
the final check, or move a held folder outside the workspace after it was checked. Replacement and the content check are separate operations; this is
not atomic hash compare-and-swap. The tests deliberately reproduce that remaining
race. Path protection uses Linux directory handles, and NT handles on Windows
(packages/files/win32.mjs). P9 does not protect against hostile same-user filesystem manipulation;
for example, on Linux such a process can hardlink a P9 temp (.p9-save-, .p9-new-) elsewhere before it is published.

**Windows limits:** a save keeps the target's owner, primary group and DACL: they are
copied onto the temp and checked back on both files just before the rename. A target
P9 cannot keep exactly is refused, and the save fails with the draft kept (EPERM):
an EFS-encrypted file; a file with an integrity label, resource attribute or scoped
policy entry; a file with more than one data stream, which includes the Zone.Identifier
stream Windows adds to downloads and to files Explorer extracts from them; and a file
whose owner or group you cannot assign, for example one owned by Administrators while
P9 runs without admin; and a file whose folder would give the new copy encryption or a
label the file itself does not have. These checks are separate queries, so a stream,
label or encryption change made at the same moment as a save can still be lost.
The temp is open only to you until the rename, and no other process can open it
even once it carries the target's DACL. (Known limit: P9 cannot read,
compare or keep a file's audit SACL or its SACL protection, because reading them needs
SeSecurityPrivilege, which P9's limited process never holds. The saved file gets
whatever audit SACL Windows gives a new file in that folder. Accepted as a stated limit,
Builder, 2026-10-20: "Q1 yes".)

**Crash leftover (both platforms, stated limit):** just before the rename, the save temp
(`.p9-save-…`) gets the target's permissions (Windows: owner, group and DACL; Linux: the
mode bits, `packages/files/index.mjs` `file.chmod`). If P9 is killed in that moment, the
temp stays in the folder and anyone allowed to read the original can read the new, unsaved
text; the draft is also kept in recovery. Nothing removes leftover `.p9-save-` files on
startup yet. Accepted as a stated limit, Builder, 2026-10-20: "Q2 yes" ("ive tried answering
yes to q1 q2 for days").
Not tested: the unassignable owner or group, resource attributes and scoped
policy (none can be set up on a non-admin test account).

Disk-full before replacement keeps the original. Recovery storage must also succeed
to retain a draft. If shared storage is too full to persist the recovery record,
the API returns 507 without claiming a draft. The actual ENOSPC tests cover both
shared and separate storage; only the tested separate-storage case retains the complete draft.
Death after replacement leaves the complete new file. A rename or directory-sync
failure returns a durability-uncertain failure with the recovery draft;
it does not claim the original remains. Tests cover process death, not sudden power loss.

All processes running as your account remain inside the trust boundary. Extensions,
terminals, language servers and agents can access what you can. P9 does not sandbox
them or promise to prevent their direct filesystem writes.

Editor extensions run as you and can change any file you can; P9's file locks don't
apply to them. Install only extensions you trust. (Decided 2026-10-15: the guard covers only writes P9's own code
applies; an extension, terminal or language server that writes to disk directly is
not guarded.)

Doctor bundles include only structured unit states, runtime versions and recognized
daemon event names, allowlisted storage error codes and a nonnegative recovery-record
count from the authenticated health endpoint. The count includes published conflict
records, not temporary record files. They exclude request data, credentials, paths, environment,
command lines and arbitrary journal messages.

## Mission hub sections

Mission Control's notifications, logs, incidents, work in flight, Wiki inbox, audit and last solo run come from
workspace-hub's own Python (`mission_control.py`), which P9 runs with a fixed argument list and no shell. P9 will not
save over that file. Approve/Reject on a Wiki batch is written by the hub's code into your vault's review inbox, not
through P9's guarded save. A doctor sweep started for notifications is not stopped by Stop All; it only reads and ends
within three minutes. Anyone logged in to P9 sees these sections, including full paths on your machine.

## File protection

File protection is on by default. While it is on, P9's file routes and editor, on the desktop and on a paired phone,
refuse to open or save locked names (`_private`, `.git`, `secrets`, `.env*`, `.p9-*`) and refuse to save the script
registry, the Mission space file and workspace-hub's `mission_control.py`.

Only the desktop can turn it off: Settings, File protection, then a native warning that the page can neither draw
nor answer. "Keep protection on" is the default and Escape keeps it on; turning it back on never asks. The choice is
kept in the daemon's ledger, so it survives a restart. The phone follows the switch but has no route to read or
change it.

With it off:

- A mistaken save can damage a secret, git's history or P9's own recovery files (`.p9-save-*` and `.p9-new-*` temp
  files can also show in listings while a save runs).
- Anyone holding your unlocked, paired phone can read and change those files, API keys included.
- A changed registry or Mission space can point a Mission button at a different command. P9 still runs buttons by ID
  without a shell, but the command behind the ID is whatever the file now says.

It never limited agents, terminals or editor extensions: they run as you and could always change any file you can
(threat model rows 4, 5 and 7).

## Phase 4 desktop

The renderer is sandboxed with context isolation, Node disabled, web security on,
no webviews, denied permissions and blocked external navigation/window creation.
It loads only compiled static assets through p9://app/. The protocol serves an
in-memory map of regular build files; it never resolves a renderer path on disk.
CSP is an HTTP response header on every asset: scripts self plus exact hashes of
Astro's compiled hydration scripts; no unsafe-eval or inline script wildcard.
Inline styles remain allowed for the approved shell's layout and theme variables.
Fonts are local. Connections, frames, forms, objects and base changes are restricted.

The exact contextBridge allowlist is p9.getStatus(), p9.usage() (since phase 11; no arguments, returns the daemon's usage summary), p9.mission(action, payload),
p9.chat(action, payload), p9.lifecycle(action, payload), since phase 13 p9.anymouse(note) (the daemon files the note, or
returns GitHub's prefilled new-issue page, which the main process opens only if it starts with
https://github.com/JudgeBreddd/p9/issues/new?), and since phase 8 p9.devView(bounds) (places the editor view over
the Dev pane; integers only), p9.onFocus(callback) (receives chat/dev/mission) and p9.pickFolder() (no arguments; opens
the system folder dialog and returns only a workspace-relative folder whose real path is inside the workspace, threat
model row 24). Since phases 18-19 also: p9.look(look), p9.getSettings() and p9.setSettings(settings), p9.openDocs(),
p9.fileProtection(on?) (§ File protection), the pet calls p9.listPets(), p9.loadPet(name), p9.addPets(), p9.importPets(),
p9.installPets(text) and p9.removePet(name) (threat model row 16), the terminal dock's p9.terminal(action, payload),
p9.terminalOpen(id), p9.terminalSend(serial, frame), p9.terminalClose(serial) and p9.onTerminal(callback) (threat model
row 13), and p9.landing, a boolean rather than a call. For each, the main process checks its own
webContents, main frame and exact page URL. getStatus takes no arguments and
returns only ok/unavailable. mission and chat accept only actions from a fixed
table with slug- or UUID-shaped IDs (chat may add an operation ID), and map each action to one fixed
daemon route; the daemon validates every body again. The socket cookie and
bootstrap file never reach the renderer. No process argv or arbitrary URL crosses the bridge, and the only filesystem paths are workspace-relative ones the daemon
checks again (since 2026-10-19: the Chat Focus file browser's read-only list and read, threat model row 23, and a new
chat's folder, row 24): scripts run by registry ID, files are saved only through the guarded save. The Chat Focus file
browser cannot write. A chat's folder is where its agent starts, not a sandbox (Codex's own sandbox keeps its writes there;
Claude can still reach the rest of the workspace under its permission rules). The app ships no sample data (GitHub issue #4):
it lives in `test/sample-data.mjs`, which the packaged build leaves out. The one test-only path is `window.p9.sample`: the desktop
fills it from that file only when unpackaged and `P9_SAMPLE_DATA=1` is set, answers only the main window, and loads no other
path; otherwise it is `null`. There is no sender bypass.

Tests launch real Electron with chromiumSandbox:true (Playwright otherwise defaults
to disabling it on Linux), check renderer seccomp and preferences, reject a separate
hostile renderer and injected script, and exercise the approved shell interactions.
This phase is verified on Linux only. Packaging, platform smoke and live adapters
belong to their later gates. Static build files are trusted installed application code.

## Phase 10 remote access

The remote listener exists only when the daemon starts with `--remote-port` and
`--remote-origin` (https, or `http://localhost` / `*.localhost` for tests). It binds
127.0.0.1 only; `tailscale serve` is the one thing that puts it on the tailnet over HTTPS.
Without both flags there is no TCP listener at all.

Identity on that port is a per-device passkey (WebAuthn, user verification required,
RP ID = the origin's host). Tailscale identity headers and `X-Forwarded-For` are never
identity. Every request must carry `Host` equal to the origin's host. A mutation or
upgrade on a session must carry the same `Origin`, and so must a public login or
enrollment mutation; a missing or different Origin is 403.

- **Enrollment.** The TCP port can only ask: `POST /auth/enroll {name}` returns an id
  and a 6-digit code (at most 3 pending). Nothing is granted until the desktop approves
  that id over the owner-only Unix socket. An approval allows one registration attempt;
  the first verify, good or bad, uses it. Wrong origin, wrong RP ID and replayed
  registrations are refused. A request the desktop has not approved expires 10 minutes
  after the phone asked; once approved, the phone has 10 minutes from the approval to
  finish (at most 20 minutes in all), including a registration still being checked. A
  desktop refuse or reset that lands while a registration is being checked cancels it.
- **Sessions.** A login or enrollment issues a 12 h session: an `HttpOnly; Secure;
  SameSite=Strict` cookie `p9s` plus a CSRF token in the response body, which every
  mutation must send as `x-p9-csrf`. A browser cannot set headers on a WebSocket, so the
  terminal socket upgrade instead needs the cookie plus an Origin exactly equal to the
  remote origin; any other or missing Origin is 403. The ledger stores only the cookie's
  SHA-256. A new
  login rotates: the device's earlier sessions are deleted and its sockets closed.
- **Lock, revoke, reset.** Lock (desktop, or the device itself with `POST /lock`) gives
  423 on every route until that device's own passkey logs in again; unlocking one device
  never unlocks another. Revoke is final: the session and passkey stop working and the way
  back is a new enrollment the desktop approves. Reset revokes every device. Each one
  destroys that device's open sockets at once: terminal WebSockets, long polls and
  requests in flight (measured 12-16 ms in `test/remote-auth.test.mjs`), including one
  pipelined behind another request on the same connection, and a response still being sent.
  A login whose challenge was issued before the device's last lock, revoke, login or reset is
  refused, even when the device has been unlocked since (`test/auth-races.test.mjs`). A request
  already admitted is disconnected, and it re-checks its session after its body arrives and
  right before these side effects: creating a terminal, a chat prompt, running a script,
  opening an app or page (including a URL opened later, after the app prints it or after its
  delay), and answering a waiting item. Not re-checked: a file write already under way, and a
  Stop All already admitted, which finishes stopping everything (it only stops work). A request
  refused because its session ended keeps that 401 as its operation's outcome, because a side
  effect may already have happened; a retry after logging in again needs a new operation ID. An open terminal socket also closes when its
  12 h session expires, and one whose client stops reading (8 MiB queued) is dropped.
- **Desktop only.** `/devices` and its approve, refuse, lock, revoke and reset routes,
  and `/setup` (it names the workspace and settings file), exist only on the Unix socket;
  on TCP they are 404. `/health` on TCP leaves out the workspace path. A failed New idea
  save answers with an allowlisted code (`request-refused`, `storage-unavailable`), never
  the system's error text, which can hold paths.
- **Rate limit and audit.** 10 failed logins in a sliding 5-minute window close
  `POST /auth/login/options`, `/auth/login/verify`, `/auth/enroll`,
  `/auth/enroll/:id/options` and `/auth/enroll/:id/verify` with 429. It is one global
  window, because behind Serve every client is 127.0.0.1; an attacker on the tailnet who
  keeps failing can keep you locked out of logging in for as long as they keep it up
  (existing sessions keep working; `pnpm teh devices` lists the failures). At most
  256 login challenges are outstanding; hitting that cap is audited too, so a flood of
  login starts shows on the desktop. Every auth event goes to the ledger's `audit`
  table and stderr as `P9_AUTH`; unauthenticated noise (unknown enrollment ids, enrollment
  floods) is audited at most 10 times per window. The window lives in memory only: a daemon restart
  clears it, so an attacker who can also restart the daemon gets a fresh 10 tries (restarting it already
  needs your account).
- **"The desktop" here means the owner-only Unix socket.** v1 has no device screen in the window: approve,
  refuse, lock, revoke, reset and the audit list are `pnpm teh devices` on the computer (README).
- **The 6-digit code** is shown on the phone and by `teh devices` for you to compare by eye;
  the server does not check it. Approval on the desktop is the gate.
- **Terminal socket.** `/terminals/:id/socket` attaches a tmux control-mode client; input
  goes back only as `send-keys -H` hex, so no byte is parsed as a tmux command.

What an agent or a terminal can do with what it can see: P9 gives children no session
cookie, CSRF token or desktop cookie (the allowlisted environment), and the remote port
never accepts the desktop cookie. `test/credential-probe.mjs` runs inside a real ACP
adapter and a real P9 tmux pane, tries every environment value and workspace token
(including a planted copy of the desktop cookie) as `p9s=` and `p9=`, and gets 401 for
all of them. The stated limit stands: `desktop.json` (0600, outside the workspace) is
readable by any code running as the same user, so a same-user process can reach the
desktop socket. That is the Unix user boundary, not a P9 one.


Persistent is the default. Closing the window or quitting Electron does not stop the
daemon, ACP sessions, registry subprocess scopes or P9 tmux sessions. Dies-with-app is
one click away and asks the daemon to run Stop All before quitting. It is best effort: if the
daemon does not answer or a stop fails, the window still quits and work can remain. A UI crash cannot
make that request, so owned work remains for the next daemon to reconcile.

Stop All closes its creation barrier before enumerating owned work. New chat, registry
and terminal starts are refused until the stop finishes; concurrent Stop All calls
share one result. Stop All waits for starts already in flight, so each start is bounded:
an adapter that does not finish the ACP handshake within 45 s is ended and its start
fails with 502. The daemon stops only `p9-chat-*` and `p9-run-*` scopes for its hashed
instance, `p9-*` sessions on its dedicated tmux socket, and that socket's tmux server
unit (`p9-tmux-<socket>.service`), which ends every process a pane started, including
jobs a pane detached with nohup or setsid. It verifies all of it is gone (the server
unit reads inactive or failed) before reporting success. Failed scope or tmux cleanup is returned as a failure,
and a retry enumerates real systemd and tmux state again. Other user units and other
tmux sockets are outside the namespace and are never enumerated or stopped. Also outside Stop All:
the Dev Focus editor host (its own `p9-editor-host-*` scope, stopped when the window quits), apps
and pages launched from Mission Control, and registry entries marked `terminal: true`, which start
detached in their own Konsole window.

Windows: each chat and registry script runs in its own kill-on-close Job Object
(scripts/windows-host.ps1), and Stop or Stop All closes it, which ends everything inside. One exception: a script
record marked `detach: true` in the registry or space file (P9's file API cannot write either while file
protection is on). That script still ends, but whatever it starts leaves its job and keeps running past
Stop, Stop All and a daemon restart. Apps, pages and terminal entries start outside the daemon's job, so a daemon
restart leaves them running, as on Linux. A `print_url` server stays in the daemon's job and ends with it (known gap).
Stopping the task (schtasks /end, Stop-ScheduledTask) ends only its conhost. The daemon's host watches that
parent process and closes the daemon's job when it ends, so node and every process still inside go too.
A Job Object is not a security boundary on Windows: any process can already start another outside it (through WMI or
Task Scheduler).

Linux terminal sessions are real tmux sessions recorded in the daemon ledger and
reconciled against the dedicated socket at startup. The tmux server runs as its own
transient user unit with only P9's allowlisted environment, and tmux puts each pane in a
scope that is PartOf that unit, so neither a systemd restart nor SIGKILL of the daemon
touches them (the daemon's service also keeps `KillMode=process`). Stop Session ends one
terminal's panes; a job that pane detached lives until Stop All stops the server unit
(known gap). Stored ACP provider session IDs resume
through `session/resume` after restart. An in-flight turn becomes interrupted, its
pending approval expires, and P9 never retries the prompt automatically.

The Phase 8 Dev Focus terminal is the VSCodium REH's node-pty, not a P9 tmux session.
It remains deliberately coupled to the editor host and dies when that host is stopped;
Phase 9 does not claim persistence for that terminal. Moving it into tmux would require
replacing or intercepting the REH terminal backend and is outside this phase.

## Phase 8 Dev Focus

The editor is monaco-vscode-api 33.0.9 in its own WebContentsView, its own session
(persist:p9-dev) and its own origin (p9://dev/), with the same sandbox, isolation,
denied permissions (clipboard write excepted) and blocked popups as the shell. Its main
frame may load only the Dev Focus page itself (p9://dev/, query and hash aside; since phase 12, any other p9://dev/ file is refused), and its subframes (the workbench's webviews)
only within p9://dev/, p9://webview/ (extension pages, below) or about:blank/srcdoc; the shell blocks subframe navigation
entirely. Each session serves only its own origin: the shell's session answers 404 for
p9://dev/, and the dev session 404 for p9://app/. A failed start, a failed page load or
a crashed editor page is rebuilt on the next open. Its CSP allows only self scripts plus wasm, and connections only to the
editor host's loopback port. Its preload exposes p9dev.config(), p9dev.save(path, hash,
content), p9dev.create(path, content), p9dev.hostPath(path, kind) and p9dev.openInCode(name, line, reason); the main process accepts them only
from that view's main frame on that exact page, and refuses them from the shell.

New File and Save As reach the daemon's desktop-only POST /files, which calls the same create-only writer as
Mission's New idea: it makes a new name and refuses locked names while File protection is on. Once made, the file
saves like any opened file. A name that already exists is replaced the way a file explorer does it: VS Code asks
Replace or Cancel (Cancel picks another name), then the editor reads the file and sends a guarded save on those bytes,
so a change on disk in between is a conflict, not a lost edit. An extension writing an existing name gets the same
replace without a prompt.
New folders, renames and deletes from the editor are still refused; use the terminal.

The editor host is VSCodium's server (REH, commit 824c4c46), started per user by the
desktop in a systemd user scope, bound to 127.0.0.1 only (any other address is refused
before spawn), with a random port and a 256-bit connection token in a 0600 file under
~/.local/share/p9/editor (the folder is set to 0700 and the token file recreated 0600 on
every start). Requests without the token get 403; the token also appears in the editor's
resource URLs (?tkn=), so it is visible to the dev view's own devtools. The quit handler
is registered before the host starts. A normal quit stops the host's scope; if systemd cannot stop it in 10 s, P9 asks systemd to kill everything in it and
then, without waiting on systemd's answer, kills the scope's cgroup itself (the
kernel's cgroup.kill; the host is started in app.slice, so the path is known) and
counts it stopped only when the kernel reports that cgroup and every cgroup under it
empty (cgroup.events: populated 0), or the cgroup is gone. If even that fails, P9 logs an error and quits; the host may keep running
until logout (known gap, same as an Electron crash). A quit
during startup also kills the server process directly, so a quit that lands before
systemd has made the scope still stops it; a host that fails to start is stopped before
the error is shown. If Electron itself crashes, the host keeps running until logout
(known gap). Windows: the host runs in a Job Object created with the process
(scripts/windows-host.ps1, the same as chats); a PowerShell owner holds the only job
handle, and a quit kills that owner so Windows ends the whole tree. P9 waits up to 5 s
for the owner only; the tree's processes end 0-10 ms later (measured, 6 runs). The
host listens on 127.0.0.1, and its data folder and token file are reset to your account
only. Not tested on Windows: what happens to the host when Electron crashes.

Writes P9 applies, guarded. Every write the editor makes to a workspace file (Ctrl+S,
autosave, format on save, search-and-replace) goes through P9's file provider, which
sends the daemon's guarded save with the sha256 of the bytes the editor's text was
loaded from. That hash moves only when the editor's own clean buffer loads from disk
(open, revert, reload after a disk change) or a save lands, and only to one of the last
four reads whose bytes are exactly what the buffer shows (its text, line ending and BOM);
other reads (a diff, a compare, an extension) never move it, whether the buffer is dirty
or clean. A file with mixed line endings never matches exactly; then a read with the same
text counts only if every such read had the same bytes. A buffer with no matching read (not UTF-8, or a legacy encoding VS Code guessed) has no
basis and cannot save from the editor; the draft is kept. Known gap, narrow: if the
buffer's own read is pushed out of the last four by four reads of a version with the
same text but different line endings or BOM, that version becomes the basis, and a save
can undo only that line-ending or BOM change without a conflict. A disk change in between is a conflict: disk keeps the other writer's text, the
editor keeps the draft, and a recovery copy is written. Creating, renaming, deleting
files and making folders inside the workspace from the editor fail closed (not yet
guarded). Writes under the editor host's own data folder (editor settings, extension
state) pass through unguarded, but only after the main process confirms, on real paths,
that the target's folder is inside that folder and, for a write, that the target is
missing or a plain file with one name (not a symlink, not a hardlink). Rename, delete
and make-folder act on the last name itself, never through it, so for them only the real
folder is checked; a folder link inside the data folder cannot reach the workspace. A
link swapped in between that check and the operation still gets through
(known gap; only code already running as you could plant one). Every other path fails
closed, so another name for a workspace file (a symlink or bind mount outside it) cannot
skip the guard; paths with . or .. parts are refused. The guard is installed on the
remote file provider's class before the workbench starts, so no editor file access runs
unguarded; open/write handles, folder copy, read streams and clones are turned off, so
every editor read and write goes through the two guarded calls. The workbench takes no
input until the save basis is tracked.

**Surface 5: runs as you, not guarded.** Editor extensions, language servers and the
terminal run as you inside the editor host. Writes they make directly to disk, not
through the provider P9 calls, skip the guarded save and P9's file locks. Editor
extensions run as you and can change any file you can; P9's file locks don't apply to
them. Install only extensions you trust. The terminal is a real shell.

The editor host's port is not the remote port: the phone/remote transport has no route
to it, and /files on the remote transport answers 401 without a session (phase 3 remote
isolation test); with a session it serves files like the desktop.
**Surface 6: no workspace trust prompt.** Dev Focus opens one folder only, the configured
workspace root, and treats it as trusted (workspace trust off). A trust prompt would be
answered once for that one folder and never shown again, so it adds no protection here.
What does hold (phase 12, tested): a folder-open task never runs by itself. VS Code reads
task.allowAutomaticTasks only from user settings (application scope), so a repository's
own "on" is ignored, and with the default VS Code asks before running a folder-open task.
What does not hold: the root's workspace settings, workspace extension recommendations
and language tooling apply without a prompt, and installed extensions act on them as you.
A repository cloned below the root is just files: its .vscode folder is not read unless
that folder is opened as the root.
"Open in VS Code" spawns /usr/bin/code -g file:line with no shell, only for a file whose
real path (symlinks resolved) is inside the workspace's real path, and refuses names
with a colon-number part (code -g would read it as a line). The click is logged (file,
line and reason, to ~/.local/state/p9/open-in-vscode.jsonl) before VS Code starts.

Tests: test/dev.test.mjs runs real Electron, the real REH and a real daemon: loopback
refusal, token 403, shell-sender refusal, a guarded save, two save races (one VS Code
catches by mtime, one only the hash guard catches), a read during a draft not moving
the hash, a new file created then saved, create over an existing or locked name refused, a symlinked alias refused, the subframe lock and per-session
origins, a TypeScript LSP error, a terminal, Open in VS Code and its log, the view's
bounds over the Dev pane, and the host's port closed after a normal quit. Unit checks:
a host that never starts is stopped and its token file made 0600; Open in VS Code
refuses a symlink escape and a colon-number name.

## Agent modes

A new install starts every chat in the agent's own default: Claude Auto, Codex Auto review (Codex's
sandbox limits writes to the chat folder). Each chat's Mode picker offers the agent's own modes,
including two that remove the agent's checks: Claude's Bypass permissions (runs every tool without
asking) and Codex's Full access (no sandbox: any file on the computer and the network, without asking).
Picking either in the desktop window first shows a warning; "Turn on, don't show again" skips that
warning for that mode on that computer. The window remembers the last mode picked per agent and starts
new chats in it. The phone offers neither loosened mode, though a phone session could post one by hand;
it can already approve any request, so this gives it nothing new. The daemon accepts only the mode names
it lists for each agent, and the agent lock in Settings overrides every mode (threat model row 25).

## Images from agents

An image an agent makes or reads (Codex image generation, a screenshot a tool opened) shows in the chat
when the agent sends the image itself. The daemon keeps PNG, JPEG, GIF and WebP only, at most 4 per update
and 8 MiB of base64 each, and stores any other image as a short note; the window shows it as a data:
image. P9 never loads an image from an address an agent names, and Markdown images in a reply stay their
alt text (threat model row 26).

## Outbound requests a reader of this file should know about

Things P9 does that reach the network or a host outside your machine, each covered
in more detail above or in its own section (threat model rows 5, 13, 15, 16, 28):

- **Pets (petdex).** Settings > Pets fetches petdex.dev's manifest (https only, capped) and,
  for a pet found there, its `pet.json` and spritesheet from `https://assets.petdex.dev` only;
  nothing downloaded is ever run.
- **Desktop terminal dock.** The dock opens a real shell as you, over the same socket and
  credentials as the phone terminal; the page itself never holds the socket or credentials.
- **Dev Focus README/icon images.** An extension's page in Dev Focus loads its README and
  icon images from any https host (img.shields.io, raw.githubusercontent.com, Open VSX, ...),
  the same as VS Code. That host learns your IP and when you viewed the page; images only,
  nothing else about Dev Focus reaches an outside host.
- **Dev Focus extension pages.** Image and Markdown previews and extension panels run on
  their own origin, p9://webview, walled off from the editor page and its save bridge, as in
  VS Code. Their scripts run, and their files come from the editor host; a request for them
  that would leave the machine is cancelled. All extension pages share that one origin.
- **Check for updates.** Settings > Check for updates opens P9's newest GitHub release
  (`https://github.com/JudgeBreddd/p9/releases/latest`) in your browser; GitHub's sign-in and the
  download happen there. P9 itself sends nothing, downloads nothing and keeps no GitHub token
  (threat model row 28).
- **Landing page name.** The landing greeting's name comes from Settings (or your account's
  first name, once, if the file is new); it is shown as text on your own screen and never sent
  anywhere.

## Phase 12 adversarial results

Every check below runs in `pnpm gate:12` and was shown to fail when its protection is
removed (an A/B run; logs in the private phase 12 folder).

| Claim | Test | Result |
|---|---|---|
| A fake API key in the daemon's environment never reaches an agent or a terminal | `test/adversarial.test.mjs` "locked files and a fake API key" (`test/locked-probe.mjs` runs inside a real ACP adapter and a real P9 tmux pane) | Key absent from both; fails when the key is added to the child allowlist |
| P9's routes refuse locked files | same test | Desktop GET and PUT of `.p9-locked.txt`, `.env`, `secrets/key.txt` and `.git/config` refused; remote `/files` 401 without a session |
| **Limit:** locks cover P9's routes only | same test | The agent and the terminal read all four files straight from disk, as stated above. That is the Unix user boundary |
| Hostile chat titles, prompts, agent replies, project names, `_tyler` titles and file names never run script or reach IPC | adversarial "hostile chat and repository content" (real Electron) | No injected handler, script or IPC call; a canary registry script never ran |
| A hostile repository runs nothing when Dev Focus opens it | adversarial "Dev Focus opens" (real REH) | A `runOn: folderOpen` task with the repository setting `task.allowAutomaticTasks: on` wrote nothing in 10 s; the same task run by hand does (control) |
| The editor host gets the allowlisted environment, not Electron's | same test | No editor-host process carries the fake key; fails with the old full environment |
| Dev Focus cannot move its main frame to another `p9://dev/` file (which would keep the preload) | same test | Stays on `p9://dev/`; fails with the old prefix check |
| Terminal socket input never becomes a tmux command | adversarial "cold-read L5" | `set-option`, `run-shell` and `send-keys` lines reach the shell as text; option unset, canary absent; fails when input is passed to tmux raw |
| A device revoked after its request was admitted cannot approve a waiting agent action | `test/auth-races.test.mjs` "cold-read H1" | The answer throws session-ended and the approval stays waiting; fails without the final session check |
| An ssh button takes one plain word | `test/mission.test.mjs` "surface 8" | Spaces, quotes, glob and brace characters refused for ssh buttons only; fails without the rule |
| A remote device cannot fill the disk with operation IDs | auth-races "cold-read M2" | 600 new operation IDs an hour per device, then 429 `operation-quota`; the desktop and other devices are unaffected. Rows are never deleted, so a device held at the cap adds about 0.8 GB a year at worst |
| The 10 minutes to finish enrolling count from the desktop's approval; an unapproved request still lapses at 10 (v0.1.3 F1) | auth-races "Phase 10: the 10 minutes to finish enrolling count from the approval" | Approved at 9 minutes, registered 9 minutes later; an unapproved request is 404 at 11 minutes; fails (403) when the clock starts at the request |
| A phone never learns the workspace path (v0.1.3 F2) | "PASS F2" in `test/phone.test.mjs` "Phase 11: malformed and stale usage" (not in `gate:12`; run on its own) | TCP `/health` has no workspace, TCP `/setup` is 404, a refused New idea names no path; fails with the old routes |
