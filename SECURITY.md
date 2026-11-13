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

Doctor bundles include only structured unit states, runtime versions, the name of a missing
shared library (only a file name shaped like lib*.so*) or the package that holds it (only
from a fixed list, today libatomic1), read from the Linux service install log, and only while the daemon does not answer) and recognized
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

## Mission notes

A Mission space section can show a notes folder outside the workspace, such as a notes vault (threat model row 34).
The folder must be listed by name in `notes_roots` in settings.json, which P9 never writes, and named by a section;
the page and the phone send only that name and a path inside the folder. P9 opens only `.md` files, refuses `..`,
absolute paths, names starting with a dot (`.obsidian`, `.git`) and links that lead out of the folder, and applies
File protection there as in the workspace. A folder that holds the workspace, the home folder or P9's recovery folder
is refused. Saves use the same guarded save as workspace files: a note changed on disk since you opened it is never
overwritten without your say. Rename keeps the note in its folder and refuses a name that exists. The preview shows a
note's HTML, links and images as text. A paired phone has the same access to the folder as the desktop.
Chat Focus has a separate read-only exception for a validated In P9 project's files (threat model row MC-18).

## Mission pages with other schemes

A registry page opens a scheme other than http(s) only if you list it in `page_schemes` in settings.json, which P9
never writes, and only after you confirm the full link (threat model row 35). `javascript:`, `file:`, `data:`,
`vbscript:` and `blob:` links are refused even when listed. A handler you list, such as `ms-settings:` or `obsidian:`,
is trusted as you chose.

## P9 MCP server

The agent in each of P9's chats gets a `p9` MCP server (threat model row 33). It reaches the daemon only through the
desktop socket or pipe with a random token for that chat, which dies when the chat stops; the phone listener has no
`/mcp` route. An agent in a P9 chat can change Mission buttons only while you let it edit files (not under the agent
lock or File protection), never over an edit you made since its last read, and runs nothing without your yes in that
chat: running a script and answering a needs-you item raise the chat's own approval prompt. An agent that can run
shell commands can read its relay's token, as it can read the desktop's own connection file.

The agent can pin text cards above its own chat's composer with `pin_card` and remove them with `unpin_card` (threat model
row 42). A card is text only, at most 8 KB, and renders like an agent reply: raw HTML shows as text, a link as its text
with nothing to click, an image as its alt text. Cards are kept in the chat's history in the daemon's ledger, so the
desktop and a paired phone show them again after a restart. Pinning writes no file, so the agent lock does not stop it.

Hand off (Claude chats only) stops the chat and opens a P9 terminal in the chat's folder with
`claude --resume <session> --remote-control` typed in but not run. Nothing reaches claude.ai until you press Enter;
Remote Control then needs Claude Code signed in with a claude.ai subscription.

## File protection

File protection is on by default. While it is on, P9's file routes and editor, on the desktop and on a paired phone,
refuse to open or save locked names (`_private`, `.git`, `secrets`, `.env*`, `.p9-*`) and refuse to save the script
registry, the Mission space file and workspace-hub's `mission_control.py`.

You turn it off in Settings > Security settings. On the desktop that raises a native warning that the page can
neither draw nor answer; on a paired phone it is a confirm in the same words, behind the phone's session, CSRF check,
Origin check and operation ledger. Unrestricted mode turns it off too (with the same warning when protection is on).
"Keep protection on" is the default and Escape keeps it on; turning it back on never asks. The choice is kept in the
daemon's ledger, so it survives a restart, and one switch covers the desktop and every phone.

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
bootstrap file never reach the renderer. No process argv or arbitrary URL crosses the bridge. Most paths are workspace-relative and the daemon checks them again (since 2026-10-19: the Chat Focus file browser's read-only list and read, threat model row 23, and a new
chat's folder, row 24; since v0.1.5, paths inside a Mission notes folder named in settings.json, row 34). For an In P9 project, `projectList`, `projectRead` and `projectImage` send a project UUID and a path inside its files folder (row MC-18). Scripts run by registry ID, files are saved only through the guarded save. In P9 project files open read-only in the Chat Focus file browser. A chat's folder is where its agent starts, not a sandbox (Codex's own sandbox keeps its writes there;
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
  on TCP they are 404. Three routes are also on the phone's listener since 0.1.6, behind its session, CSRF check,
  Origin check and operation ledger: the agent lock, File protection, and `/setup/settings`, which Settings >
  Mission Control files uses. `/setup/settings` changes settings.json through the same checks P9 runs at start and
  keeps the old file as settings.json.bak (threat model row 49); the phone's read of it leaves out the file path and
  `remoteOrigin`. A lost phone is cut off by revoking it from the desktop. It takes only settings.json keys; a value those checks refuse writes
  nothing and shows its reason under its box. Saves run one at a time, and each lands by a temporary file and a
  rename, so a quick second save never drops the first. `/health` on TCP leaves out the workspace path. A failed New idea
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
- **Phone link (threat model row 46).** The Phone button in a desktop chat shows a QR code and a link,
  `https://<server_host>/phone#chat=<id>`. It holds only the chat's ID: no token, no session. The QR is drawn on
  your computer, never by a QR service. The phone still signs in with your passkey, and opens the chat only if it is
  in the phone's own list.
- **Phone queue (threat model row 45).** A message you queue on the phone (typed offline, or while a question or
  approval waits) stays in that phone's browser storage until it is sent or you take it back. It is sent once: a
  retry carries the same operation ID, and it waits for the turn's end, so it declines nothing.
- **Phone first read (threat model row 47).** On opening, the phone reads only the chats that are still running; a
  stopped chat loads when you pick it. The daemon takes at most 100 chat IDs in that read and refuses any that are
  not chat IDs; the phone then falls back to its full read. It never returns more than the phone could read before.
- **Phone service worker.** It keeps and serves only the build's hashed `/_astro/` files; the page, sign-in, API
  answers and anything with a query go to the network untouched, so nothing signed-in is cached. A page it does not
  control (one opened while it was starting, or a hard reload) asks it to take over with a `claim` message. Only a
  page of P9's own origin can send that, and taking over changes only where that page's `/_astro/` files come from,
  so a forged `claim` gains nothing.

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
unit (`p9-tmux-<socket>.service`) together with the slice it runs in
(`p9-tmux-<socket>.slice`, inside `p9.slice`). tmux moves each new pane into a scope of its
own in that slice, so stopping the slice ends every process a pane started, including
jobs a pane detached with nohup or setsid. A server an older P9 started is kept across
an upgrade, in `p9.slice` with its pane scopes beside it; Stop All also stops each scope
in the server's slice that tmux describes as launched by the server's process (its PID,
read before its last session ends) and that started after the server did, so a stale
scope left by an exited server that had the same PID is excluded by its start time. One
known gap: if that server exits between Stop All's owner lookup and its scope listing,
and another older-style server in `p9.slice` gets the same PID and starts a pane inside
that window, the newer scope matches. It needs a PID reuse inside that window. If either query fails,
Stop All reports a failure, not success. It verifies all of it is gone (the server unit, its
slice and those scopes read inactive or failed) before reporting success. Known limit:
if such an older server exits on its own first (its last terminal stopped one by one),
its PID is gone, so a job one of its panes detached is not tied to the socket any more
and lives until the user's systemd manager ends; Stop All does not end every pane scope
in `p9.slice`, since other P9 instances share it. Failed scope or tmux cleanup is returned as a failure,
and a retry enumerates real systemd and tmux state again. Other user units and other
tmux sockets are outside the namespace and are never enumerated or stopped. Also outside Stop All:
the Dev Focus editor host (its own `p9-editor-host-*` scope, stopped when the window quits), apps
and pages launched from Mission Control, and registry entries marked `terminal: true`, which start
detached in their own Konsole window.

Model lists (0.1.9): once per daemon run, when a signed-in desktop window or phone first
asks for the chat list, the daemon starts each agent's adapter with no chat and no prompt, opens one
session in the workspace folder to read the models and settings it offers, and ends it.
Nothing is sent to the model, no MCP server is attached, and every permission request
from that session is rejected. The read is not started while the agent lock is on or
during Stop All, it is bounded by the same 45 s handshake limit, and a failure (an agent
that is not signed in) keeps the last list. A second ask in
the same run starts nothing. Tests:
`test/model-lists.test.mjs`.

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
transient user unit, in a slice of its own, with only P9's allowlisted environment, and
tmux puts each pane in a scope in that slice, so neither a systemd restart nor SIGKILL of the daemon
touches them (the daemon's service also keeps `KillMode=process`). Stop Session ends one
terminal's panes; a job that pane detached lives until Stop All stops the server unit,
its slice and its pane scopes (known gap). Stored ACP provider session IDs resume
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
content), p9dev.create(path, content), p9dev.hostPath(path, kind), p9dev.openInCode(name, line, reason) and, since v0.1.5,
p9dev.openFolder() (no arguments); the main process accepts them only
from that view's main frame on that exact page, and refuses them from the shell.

Open Folder (since v0.1.5, threat model row 41): Dev Focus can open a folder outside your workspace only from the
desktop, after you confirm it, and never your home folder, a drive root or P9's own folders. Its saves get the same
conflict check as the workspace, and the phone cannot write there. The page passes nothing: main shows the system
folder dialog. A folder inside the workspace opens at once, as the workspace. For one outside, main shows a confirm
naming it, then sends it to the daemon's desktop-only `POST /dev/root`. The daemon refuses a folder that holds the
workspace, home, or P9's state, recovery or ownership folder, or that sits inside one of P9's folders, and checks it
again on every save. It keeps the folder in memory only: a daemon restart, a workspace change or going back to the
workspace ends it. Main adds the folder to each save; the page never names it. A save from a page left from an earlier
folder is refused, never written into the new one. Saves go through the same guarded writer as the workspace (hash
check, no `..` or links out, File protection's locked names). The separate Chat Focus read-only exception for an
In P9 project's files does not open a Dev Focus folder (row MC-18).

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
kernel's cgroup.kill; the host is started in P9's own p9.slice, so the path is known) and
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
**Surface 6: no workspace trust prompt.** Dev Focus opens the configured workspace root, or
a folder you pick with Open Folder (above), and treats it as trusted (workspace trust off).
For the workspace a trust prompt would be answered once and never shown again, so it adds
no protection there; for a folder outside the workspace, the confirm before it opens is the
prompt. Opening a folder in Dev Focus applies its settings and tools as soon as it opens.
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

## ACP version 2

Since 0.1.9 P9 asks each agent for ACP 2 and falls back to ACP 1 per agent. On 2, one module
(`apps/server/acp-v2.mjs`) rewrites every message into the ACP 1 shape before any other
P9 code sees it, so the permission boundary is the same code as before:

- A version 2 permission request names a title and a subject instead of a tool call. The
  translator builds the tool call P9 shows from that subject (for a command: the command
  itself as the title, with its folder). The options the agent offers and the answer P9 sends
  back pass through unchanged, so the agent lock, the mode rules and the approval card decide
  exactly as on version 1. A subject of a kind P9 does not know is shown as a plain
  request with the agent's own title; it is never approved by the translator.
- The agents' sign-in status notices carry the account's email. They are dropped in the
  translator, before the ledger, the window, the phone and any log. P9 reads sign-in state
  from its own check, never from these notices.
- The translator adds nothing to a request going to the agent except a config option's type
  and an MCP server's transport type (`stdio`), both required by version 2.

Tests: `test/acp-v2.test.mjs` (approval through the translator on a fake version 2 agent,
the dropped notices fed to the translator directly), `test/acp-contract.test.mjs` (both
recorded real turns, each with an approval).

## Plan usage reads

The Usage rows (5 h and week, with the pace mark) need each plan's own figures. The agent
protocol does not carry them, so the daemon asks each agent's own program directly. If the
protocol ever carries them, that becomes the source and these reads go.

- **Claude** (threat model row 42). One idle query of the Agent SDK that the bundled Claude
  adapter itself loads. It loads no settings, hooks, plugins or MCP servers, runs in the
  system temp folder, and is never sent a prompt: only the SDK's usage call is made.
- **Codex.** Each read starts the bundled Codex's app server, makes the handshake and one
  call (`account/rateLimits/read`), and ends the process. No thread is started and nothing is
  sent to a model. This is what keeps the rows right when one Codex account is used on
  several computers: the session files on this computer only know its own turns.
- **When.** Only while someone looks at usage: once a minute after a usage request, none after
  2 minutes without one, and the Claude query is closed after 10 idle minutes. Each read has a
  5 s limit.
- **What reaches the network.** The agent's own program asks its own service, signed in as
  you, exactly as its `/usage` or status screen would. P9 adds no request of its own and
  never reads, holds or sends the agent's credentials.
- **What P9 keeps.** The percent used, the window's length and its reset time, in memory only.
  The Codex answer also carries an account id; P9 drops it. A failed read logs one fixed line
  per kind of failure, never the agent's error text (it can name the account) and never the
  process's error output. The rows then fall back to the other sources: the figures a running
  chat reports, and the agents' own files on this computer. The newest reading wins.
- **Who can see it.** The same usage summary as before, on the desktop and a signed-in phone.

## Provider profiles

A provider profile lets a Claude chat talk to another service that speaks the same API: a
name, a base URL, a key, and the model names that service uses. You type all of it in
Settings on the desktop. P9 ships no preset and no key. Codex chats have no profiles.

- **Where the key lives.** In `profiles.json` beside the chat ledger, in the daemon's own
  owner-only folder (never the workspace), as plain text: it is not encrypted. On Linux the
  file is mode 600; on Windows its protection is that folder's owner-only access list, which
  the daemon checks at start. It is written by create-then-rename, never in place. Instead of a key a profile may
  name a command that prints one (a password manager's): the daemon runs it at each chat
  start with no shell, the short allow-list environment and a 10 s limit, reads the first
  line, and keeps the key in memory only for that start. The command is split on spaces
  into a program and its arguments; nothing in it is read by a shell.
- **Who can set one.** The desktop window only. The phone, the P9 MCP server and agents have
  no route to read, add, change or remove a profile. The command is run as you, by the
  daemon; the desktop window can already open a real terminal, so it gains nothing by it.
- **What the page gets back.** Name, base URL, model names, and whether a key or a command
  is set. Never the key, and never the command's output. A saved key cannot be read back:
  it can only be replaced or removed.
- **A changed base URL.** A saved key, or key command, belongs to the address it was typed
  for. When a profile's base URL changes, the daemon drops both unless the same save brings a
  new one, and Settings asks for it; a key is never sent to an address it was not typed for.
- **Where the key goes.** P9 hands it to the one adapter process of a chat started on that
  profile, in the first message of its session (new and resume) over the process's own
  stdin: not in that process's environment and on no command line, on Linux or Windows. The
  adapter then puts the key and the base URL in the environment of the agent program it
  starts, and every command, hook and tool server that agent starts inherits them (seen
  2026-11-11, bundled adapter 0.106.0: a command the agent ran found the key in its
  environment). So **the agent and anything it runs in that chat can read the key**. The
  model name, which is not a secret, is in the adapter's environment. Every other chat's
  agent starts exactly as before, with nothing from any profile.
- **Where P9 never puts the key.** The page, the phone, the ledger, a transcript event, the
  daemon's log, telemetry, the memory engine, Send to remote, an export. A profile chat
  cannot be sent to a remote: it is refused with the reason, because the key does not travel.
  This is about what P9 writes, not what the agent may print: if a command in that chat
  prints its environment (`env`), the key is in that command's output, and the output is
  part of the chat like any other, so it reaches the ledger, the window, the phone and the
  service. P9 does not look for the key in tool output. Use a key you can revoke, and treat
  a profile chat's transcript as able to hold it.
- **What the service sees.** Everything that chat sends a model: your prompts, the files and
  command output the agent reads, and its tool calls. That is the point of the profile and
  your choice of service; Settings says so beside the base URL field. P9 does not check
  that a base URL is who it claims to be beyond TLS. `https` is expected; an `http` URL is
  accepted (a model server on your own machine or network) and Settings marks it "not
  encrypted", since the key then crosses that network in the clear.
- **Signed in to Claude as well.** A profile chat uses the profile, not your Claude sign-in
  (seen once, 2026-11-11, bundled adapter 0.106.0). Your other Claude chats are unaffected.
  A profile chat is left out of the Claude usage rows: it does not spend that plan.
- **What the agent can do with it.** Read it and use it, as above: it is in the agent's
  environment for the whole chat. The agent's own setting that strips such keys from the
  commands it runs was tried (2026-11-11) and not used: it needs extra programs installed,
  and without them the agent could run no command at all. The chat's mode and approvals are
  the same as any Claude chat's.
- **A removed profile.** Its chats stay readable. They cannot be continued, and say why.
- **What the bundled adapter keeps.** Checked 2026-11-11 against adapter 0.106.0 with a
  real key, new and resumed sessions: the key was in no file under the agent's home or the
  chat's folder and not in the adapter's own log output; a resume without the key fails to
  authenticate, so the adapter does not keep it between runs. This is a check of one
  version, not a promise about the next; the adapter's own transcript of the chat is kept
  under its home as for any Claude chat.

## Delegate

Delegate lets a chat's agent start and steer other chats through the P9 MCP server: `open_chat`,
`send_chat`, `wait_chat`, `read_chat`, `stop_chat`, `list_chats`, `set_rules`, `answer_chat` and
`ask_chat`, and record task completion and review with `ready` and `verdict`. The
chat that starts them is the parent, the chats it starts are its workers, and the group is a
sprint. A worker is an ordinary chat: you can open it, type in it and stop it.

- **What one chat can reach.** The tools use the same relay and the same per-chat token as the rest
  of the P9 MCP server. A token reaches the chats of its own chat's project, and the chats its own
  chat started, directly or through a worker. A general chat (no project) reaches only the chats
  it started. `stop_chat` reaches only the chats the caller started: a chat cannot stop its parent
  or a chat beside it. A chat outside that reach is answered as if it did not exist.
- **A worker is never wider than its parent.** It starts in the parent's mode unless a narrower
  one is asked for; a wider one is refused (`mode-escalation`) and nothing starts. A message from
  a chat starts a turn no wider than the sender's mode, and a chat that is working in a wider
  mode takes no message from it until that turn ends. The agent lock
  and File protection are global, so they cover every worker as they cover its parent.
- **Notes (`send_chat` with `when: note`).** A note passes information on and asks for nothing: a
  result, a branch that is ready, something found. It is the one message that is not held to the
  sender's mode, and the one that reaches a worker's parent when the two share no project. What
  bounds it:
  - **It never starts a turn.** A chat that is working reads it at its next step. Any other chat
    keeps it until its next message, yours or another chat's, and reads it with that. A stopped or
    idle chat is not woken and spends nothing. One gap: an agent that starts a turn of its own when
    a message reaches it at the moment its turn ends (Codex does this with any message sent then)
    does so for a note too.
  - **It is marked.** The agent that reads it is told it comes from another chat's agent, is
    information only, is not an instruction and needs no reply. You see it in the chat as "Note
    from" the chat that sent it.
  - **The risk that remains, accepted (Builder, 2026-11-11).** A note from a chat in a narrow mode
    is still text that a chat working in a wider mode reads. The mark is the only guard: an agent
    that treats a note as an instruction acts on it in its own, wider mode. The alternative,
    refusing notes upward, leaves a worker unable to tell its parent anything while the parent
    works.
  - **Size and reach.** At most 20,000 characters. It reaches the chats `send_chat` reaches and the
    sender's own parent, nothing else. The agent lock refuses it like any `send_chat`.
  - **What is kept.** A waiting note is in the chat's history at once. The copy that waits for the
    agent is in memory, the newest 20 for each chat: after P9 restarts, a note not yet read stays in
    the history but is not sent to the agent.
  - **How often the agent reads a note.** Once in the normal case, twice at most, and sometimes
    never. P9 sends a note again once only, after either of two failures where it cannot tell
    whether the agent read it: a note put into a running turn whose answer was lost, or a prompt
    that carried the note and failed. After a second such failure the note is dropped from the
    waiting list; it stays in the chat's history.
- **The agent lock.** `open_chat`, `send_chat`, `set_rules` and `answer_chat` are refused while it
  is on, as are `ready` and `verdict`. Reading (`list_chats`, `read_chat`, `wait_chat`) and `stop_chat` still work: a locked
  agent may always stop work it started.
- **Completion and review records.** A worker can mark its assigned task ready only during its own active turn, with results for every check and a weakest part. A reachable independent reviewer can record a verdict only for the current ready commit; a worker, its descendants and a reviewer of its own descendants cannot review that work. These tools write sprint records in P9's database; a solo peer-answer turn allows only read tools and cannot call them. The agent lock refuses both, and `ready` checks it again after Git inspection. To refuse a dirty folder, the daemon runs Git status in the worker's validated starting folder with fixed arguments, disabled hooks and fsmonitor, a restricted environment and a timeout. Git can still run configured clean filters while checking a repository: this is not a sandbox. When Git facts cannot provide a commit or changed-file list, `ready` is refused rather than accepting a claim. File protection does not itself prevent these P9 database records.
- **Approvals.** An agent may answer an approval or a question asked by a chat it started,
  directly or through a worker, and by no other chat. For an approval, P9 first asks you in
  the parent's chat, naming the worker, what it asked and the answer the parent wants to give;
  only your Allow sends it. In Unrestricted mode (agent lock and File protection both off) it does
  not ask, like `run_script`. The tool tells the parent to answer only what is within the task
  it gave; that is an instruction to the agent, not a check P9 makes. Every answer is recorded in
  the worker's chat with the chat that gave it. The approval also stays in the worker's own
  chat, where you can answer it yourself.
- **Ready and verdict.** A worker that was given a task with checks ends it with `ready`: its commit, one result
  per check and its weakest part. A chat's agent marks another chat's ready commit with `verdict` (pass or fix, with a
  note). Both write only P9's own sprint record for that chat, never a file, so they work in ordinary read-only modes too; solo peer-answer turns allow only read tools, and the agent lock refuses both. `ready` needs a parent and a task, and a folder with nothing unsaved; where
  git can be read the commit and changed files are git's, not the agent's word. `verdict` reaches only a chat the
  caller could message, never its own work, a chat below it or a chat above it in its line, and only at the commit
  that chat marked ready: a newer commit makes the verdict stale.
- **Sprint rules.** A parent has one text of rules, at most 8,000 characters, that P9 sends as
  its own block with every message that parent's agent sends a chat it started. Until the parent
  sets them (`set_rules`, or `rules` on `open_chat`) P9 sends a short default: state the folder
  and branch first, wait for what you started, end with pass or fail. The rules are text the
  parent's agent wrote, so the worker reads them as its parent's instructions, not yours; they
  widen nothing a worker may do. A message you type, and P9's own `[p9]` lines, carry none.
  The transcript keeps a hash of the rules sent, and the text is in the parent's tool call.
  The rules are the sprint folder's `rules.md` (see "Sprint files" below).
- **Folders.** A worker's folder passes the same check as a folder the parent asks for itself:
  inside the workspace or a folder you allowed; any absolute folder only in Unrestricted mode.
- **Tokens.** Each worker gets its own token the way every chat does. Tokens live in memory
  only; Delegate saves nothing that grants access. What it adds to the ledger is which chat
  started which, and the name the parent gave it.
- **What P9 sends on its own.** When a worker's turn ends and its parent is not waiting on it,
  P9 sends the parent one line, `[p9] <title> finished: <last line of the reply>`, marked in the
  transcript as P9's and not yours. That line is text the worker wrote, so the parent reads
  it as a report, not as an instruction from you. A worker whose agent dies mid-turn is reported
  as `[p9] <title> failed`. Either line is sent only to a parent that is running; it never starts
  a stopped chat.
- **Who sent it.** A message another chat's agent sends (`open_chat`, `send_chat`) reaches the
  receiving agent with one line in front, added by P9: it says the message is from another chat's
  agent and not from you, and names that chat. Your own messages carry no such line. It is a
  label, not a control: P9 does not stop the receiving agent from acting on the message.
- **After a restart.** P9 resends nothing a restart cut off. When P9 starts and finds that a
  restart stopped a chat of a sprint in the middle of a turn, it sends one line to the chat at the
  top of that sprint, `[p9] P9 restarted. Interrupted mid-turn: <titles>. Not resent.`, which
  starts that one chat; its agent decides what to send again. A sprint whose chats were all idle
  is not started, however old. On the third start within 10 minutes P9 sends none.
- **Stopping a parent.** Stop or close on a chat also stops every chat it started, directly or
  through a worker.
- **Who may start one.** `open_chat` asks you in the parent chat first, naming the agent, the mode
  and the task. In Unrestricted mode (agent lock and File protection both off) it does not ask,
  like `run_script`. The same key from the same parent returns the chat it already made and asks
  nothing. A chat has at most as many running workers as "Workers per chat" in Settings >
  Delegation says (5 until changed, never more than 20), 3 levels deep.
- **The Delegation setting.** Settings > Delegation, "Who starts a sprint", has three values, kept
  in the daemon and read on every `open_chat`. **Off**: every new worker is refused
  (`delegate-off`); chats already started keep running and can still be read, sent to and stopped.
  **Ask me first** (the default): P9 asks you in the parent chat before that chat's first
  worker, in every mode, Unrestricted included; your Allow covers that chat's later workers,
  which follow the rule above. **Agent decides**: only the rule above applies. The setting is
  changed from the desktop's Settings only; no MCP tool reads or writes it. A setting never
  widens a mode: the mode rule above is unchanged.
- **Workers per chat, and what each runs on.** The same section holds how many workers one chat
  may have running at once, and one row per worker: an agent (the parent's own, Claude, Codex, or
  one of your provider profiles), a model and an effort. A chat's new worker takes the first row
  no running worker of that chat holds, and keeps it until it is stopped. Past the limit
  `open_chat` is refused (`too-many-chats`); lowering the limit stops nothing. What the call
  names still wins over the row, then the row, then the parent's own: the rows are your
  defaults, not a fence, and the tool's text tells the agent to name its own only when you asked.
  A pick the agent no longer lists, or a profile you removed, is passed over.
- **A worker's approval, shown in the parent chat.** While a worker waits on an approval or
  a question, the desktop also draws it in the chat that started it, labelled with the
  worker's title. It is the same request, not a copy: your answer there is sent as your own
  answer to the worker's chat, exactly as if you had opened it, and the parent's agent is not
  involved. A worker an agent starts is listed under its parent and never takes the screen
  from the chat you are reading.
- **Asking a chat beside you (`ask_chat`).** A chat's agent can put one question to another chat
  of its project and get that chat's answer back, so it need not work out again what the other
  already knows. What bounds it:
  - **You open each chat to it.** A chat takes questions only after you turn on "Open to
    questions" in its menu on the desktop. It is off for every chat until then, the phone cannot
    change it, and no tool can.
  - **Beside, never above or below.** The chat asked must be in the asker's project and must not
    be its parent, a chat above that, or a chat it started: those have `send_chat`.
  - **An answer, never an action.** The question gets a turn of its own in the helper, after
    whatever the helper is doing; nothing else is joined to that turn and messages sent meanwhile
    wait for its end. The turn runs as if the agent lock were on for that chat: the agent's
    no-write mode (Claude Plan, Codex Read-only), every approval rejected, and P9's own tools
    refused except the ones that only read. `ask_chat` is among the refused, so a question never
    leads to a second one. The helper's own mode is not changed in the window, and comes back
    before its next message is sent: that message sets the mode itself, and is not sent if the
    set fails.
  - **What it costs.** A helper that is stopped or has sat unused, and holds a large context,
    reads all of it again to answer. P9 does not ask you before waking one: opening the chat to
    questions is your yes, and closing it again is how you stop the cost.
  - **What the asker gets.** The helper's reply as text, with a line saying it is another agent's
    view, does not override the asker's instructions, and that a conflict or a decision of yours
    goes to you. It is still text one agent wrote for another: an asker can be misled by a wrong
    answer exactly as by a wrong file, and a chat you open to questions shows what it knows to
    every chat of its project.
  - **You can read it.** The question is in the helper's chat, marked as a question from the
    asking chat, and the answer is the helper's reply there; the asker's tool call holds both.
  Not covered: a question the helper's agent raises to you during that turn stays open, and a
  background task the helper starts and that outlives the turn runs in the helper's own mode.
- **Provider profiles.** A worker started by a chat on a provider profile runs on that profile
  (the parent's model, or another the profile lists), so it and every command it runs can read
  that profile's key, as its parent can (see Provider profiles above). A worker row set to a
  provider profile does the same for that worker whatever its parent runs on: the parent's agent
  never sees the key, but it chooses the task of a chat that can read it.
- **Not on the phone.** The phone listener has no MCP server, so nothing here is reachable from
  it. The phone shows workers in its chat list like any chat.

## Worker folders

A chat that starts a worker with `open_chat` may ask for the worker to get its own folder (`worktree: true`, with a
`key`). P9 then makes the folder itself, with git, before the worker starts. Written before the code (sprint spec K1).

- **Where they live.** One clone of the repository per sprint (a sprint is the chat that started the workers), in
  `sprints/<that chat's id>/` beside the ledger (0700, like `projects/`). Each worker gets a git worktree of that clone
  in `workers/<key>/`, on its own branch `sprint/<first 8 of the chat id>/<key>`, started from the main line. The
  key is checked by `open_chat`'s rule and again as a branch name before any path or branch is made.
- **Your own folder is never touched.** The clone is made from the folder the worker would have started in (the
  `folder` passed, else the parent's), which must be a git repository and passes the same folder check as before.
  P9 only reads there (`git clone` from it, and its `origin` address): no branch switch, no file added, unsaved work
  left as it is. The clone's `origin` is then set to that folder's own `origin`, so a push goes where yours go, with
  your own git sign-in. If the folder has no `origin`, the clone's `origin` stays your folder.
- **A sprint from an address.** A project can name a repository address as its sprint source (the project page, on the
  desktop). A lead chat in that project then gets its sprint clone straight from the address, and your folder is not
  read at all. Only you set it, and only from the desktop window: no agent tool, no file in the repository and no
  phone request can set or change it. P9 takes three forms only: `https://…`, `ssh://…` and `user@host:path`, with
  no spaces or control characters and nothing that starts with `-`; anything else is refused when you save it and
  again before git runs. For that clone git is also told to use no transport but https and ssh
  (`protocol.allow=never` with those two allowed), so an address form that would run a command (`ext::`) or read a
  local path (`file://`) is refused by git itself even if the first check were wrong. Sign-in is your own git
  sign-in, never a prompt: an address that needs a password P9 cannot get fails, and the agent is told git's own
  message. The clone is made once per sprint: a source changed later is used by the next sprint, not by one whose
  clone exists. What remains: P9 downloads whatever that address serves into its own folder, and the workers'
  agents then read and run it in their own modes, as they would in any folder you point a chat at.
- **Where a worker starts.** The chat's record holds a marker, not a path. At every start P9 finds the folder again
  from the chat's parent and key, and refuses it if it is not a real folder inside the sprint's own folder (a link,
  or gone). A chat a client makes with that marker has no parent and is refused. The agent then works in that folder
  in its own mode, like any chat; its approvals are asked as before.
- **P9 running git.** P9 runs `git` itself only in its own sprint folders, plus the two reads above in your folder.
  Every run has an empty environment plus the usual allow list, no terminal prompt (`GIT_TERMINAL_PROMPT=0`), hooks
  off (`core.hooksPath` set to the null device), `core.fsmonitor` off and no external diff, so a hook or a
  file-system monitor written into the clone does not run as P9. What remains: a clean or smudge filter set in the
  clone's own git config runs when P9 reads the folder's state. That config sits outside every worker folder, so an
  agent writes it only by editing outside its folder, which its mode asks you for; in Unrestricted mode nothing is
  asked, as for every other command an agent runs there.
- **What P9 reads from git (for the sprint's version stamp).** For a worker folder: the current commit, the files
  changed against the main line, whether anything is unsaved, and whether a commit is in the main line. It reads; it
  never fetches on its own except when it cleans up (below), and a fetch uses your git sign-in like a push.
- **The setup command.** One command you type, run in each new worker folder before its worker starts (for example
  installing packages). A project can have its own (the project page, on the desktop: the same desktop-only route
  as its sprint source); a lead chat in a project without one, or in no project, gets the one in Settings >
  Delegation. Only you set either: no agent tool, no file in the repository and no phone request can set or change
  them, and an empty field runs nothing. It runs through your shell, in that folder, with the allow-listed
  environment, for at most 15 minutes, as a process tree P9 owns (Windows: a kill-on-close Job Object, which also ends
  what the shell leaves running when it exits; elsewhere a process group). At that limit the whole tree is stopped and
  P9 waits, briefly, for the stop to be confirmed before it answers or starts anything else in that sprint; a stop it
  cannot confirm is told to the agent as such. If it fails or runs out of time the worker is not started, the folder is
  kept, and the agent is told the exit code and the end of its output. Clone and setup can take minutes, so after them P9 checks again that the agent lock is
  off, Delegation is on, the worker limit allows one more and the chat's mode is the same; if not, the worker is not
  started and the folder is kept for the next try. A folder P9 cannot resolve is refused before git runs. It runs without asking you each time: typing it is
  the permission, in every mode except while the agent lock is on, which refuses `open_chat` first.
- **Clean-up removes a whole worker folder, and keeps one only for work git can see.** Cleaning a sprint's folders removes a worker folder only when it has nothing
  unsaved, it is still on its own sprint branch, and that branch's newest commit is in the main line (or, after a
  squash merge, every file it changed is the same in the main line, compared by exact file name, a rename as both its old and new
  name). "Nothing unsaved" looks only at what git tracks or would track: a changed tracked file, or a new file git
  does not ignore. Removing a folder removes everything in it, including files git ignores (build output, a local env
  file or database, anything not committed and not tracked); P9 does not look for them and does not keep a folder for
  them, and the "Clean up worker folders" button says so beside it. Its branch is
  deleted with it, and only if the branch has not moved since that check. A folder switched to another branch or
  detached is kept with its branch. Clean-up waits for any worker folder being made in the same sprint. Anything else is kept and listed with its size and why it was kept.
  P9 never deletes a branch that is not in the main line, and never removes the clone while a worker folder is in it.
- **Who cleans up, and from where.** Only you, from the desktop window: "Clean up worker folders" on the sprint's
  section of its project page. It is a desktop-only route; the phone, a signed-in phone session and agents have no way
  to call it, and P9 never runs it on its own. It refuses while any worker the sprint's lead started is still running
  (anything but stopped, or moved to another computer), and while the lead is in a turn or has a message waiting, since it may be making a worker
  folder that moment (a new folder has nothing of its own yet, so it would read as merged). It removes only what the
  rule above allows, and answers with each folder removed and each folder kept, with why and its size. Written before
  the code (sprint spec A6). What remains: you can restart a stopped worker while clean-up runs; its folder is then
  removed only if it still has nothing unsaved and its work is in the main line, so nothing git tracks or would track is lost, and its next start
  is refused because the folder is gone.
- **Disk.** One clone per sprint plus one worktree (and whatever the setup command installs) per worker, in P9's own
  folder, until cleaned up.

## Sprint files

A sprint's plan, rules, role files and workers' notes are plain files in the sprint's folder, `sprints/<lead chat
id>/` (the same folder as its worker folders, 0700). The lead's agent, its workers and you all read and edit them.
Written before the code (sprint spec D1, D3, D4).

- **Only these names.** `sprint.md`, `rules.md`, `roles/<key>.instructions.md`, `roles/<key>.rules.md` and
  `notes/<key>.md`, where `key` follows `open_chat`'s key rule (a worker without a key has its notes under its chat
  ID; `open_chat` refuses a key shaped like a chat ID, so two workers never share notes). P9 reads or writes no other
  name there. If a folder on
  the way or the file itself is a link, P9 refuses it. Each file is at most 32,000 characters and is written whole
  (a temp file, then a rename).
- **Who makes them.** P9 makes `sprint.md` (a short outline) at the lead's first worker, and a notes outline for every
  worker. For a worker with a key it also makes empty role files. It never writes over a file that is already there.
- **What reaches an agent.** `rules.md` is the sprint rules (`set_rules` writes it; a value kept from before this
  change is still read until the first `set_rules`). A keyed worker's `roles/<key>.rules.md` follows them, under the
  same rule: only with a message its lead's agent sends. `roles/<key>.instructions.md` and the notes file's full path
  ride once, as their own block after the rules, with the worker's first message from its lead that reaches the agent
  (the transcript keeps a hash, as for the rules). P9 keeps that block in its database until the agent confirms it got
  the message: the turn ended, or the steer went in. A failed start, a failed prompt or a P9 restart before that does
  not lose it, and messages sent while one carrying it is still unconfirmed leave it out. A P9 restart during a turn
  that already read it sends it once more with the next message. Like the rules, this text comes from the lead or from you, so it widens nothing the
  worker may do.
- **Who can edit them.** You can edit them on the project page, for a lead chat that is in that project. A save names
  the file as the page opened it; if an agent changed or deleted it since, P9 refuses the save and the page keeps your
  text (for a deleted file, until you save it again or discard it). P9 checks the file right before its rename, as
  the Files editor does; an agent's write that lands after that last check and before the rename is still replaced.
  No lock exists that the agents' own editors would honour. That is the
  same route family as project instructions, so a signed-in phone can edit them too. The lead's and workers' agents
  edit them with their own file tools, under their own mode and your approvals. P9 gives them no write of its own.
- **Removal.** Clean-up of a sprint's worker folders (§ Worker folders) removes the clone and the worker folders
  only; these files stay. P9 never deletes them. Deleting the lead chat leaves them too.

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

## Photos you send

Photos you send are kept on your computer, in P9's state folder, so the chat can show them again; only that chat's
view asks for them, the phone needs your passkey session, and P9 deletes the oldest once they pass 200 MB (threat
model row 43). Each is stored under the hash of its bytes (folder 0700, file 0600), after the same checks as before:
PNG, JPEG, GIF or WebP, at most 4 a message and 2 MiB of base64 each. The daemon answers a request for one only when
that chat's own history names that hash; the file name is built from the hash, never from the request. Deleting a chat
deletes each of its photos that no other chat's history names; a photo another chat also sent stays. The phone does not
show sent photos.

## Projects

A project (threat model row N1) is an id P9 makes (a random UUID) and its own folder, `projects/<id>/` beside the ledger
(0700): the record, the instructions, the files you add and a state folder. The work folder is where its chats start:
none (In P9), a folder you link, or one new empty folder P9 makes when you ask. P9 never writes, moves or deletes
anything in a work folder: deleting a project removes only its own folder and moves its chats to the general list;
locating a moved folder changes only the record. Two projects may use one work folder. A route's project id must be a
UUID before any path is built; an added file's name is one path part under File protection's rules, saved without
replacing a name already there or following a link. A chat's project is set only by you (start it in one, or move it);
it is never taken from the folder it started in. An In P9 project's chat starts in that project's own `files/` (threat
model row N1b): the client sends no path, the daemon finds the folder from the chat's project id at every start and
refuses it if it is a link. Ordinary file and folder routes still refuse P9's own folders in every mode. The desktop's
Chat Focus list, text and image reads are a narrow exception (threat model row MC-18): the client sends a project UUID
and a path inside its `files/`; the daemon accepts only an In P9 project, checks its folders and refuses traversal, links
and locked names. The phone cannot use this exception, and the exception allows no writes. The project routes are on
both listeners, like the chat routes, and every
change carries its operation id. Deleting a chat (from its menu) removes its row and events from the ledger, what the
memory and telemetry databases recorded from it, and its photos no other chat uses. What it already spent (tokens and
cost) stays in the usage totals, carried on the ledger's `deleted` event, so the totals are the same after a restart.

**Chat starting folder (row 24).** An empty chat shows its full starting path. The desktop and an authenticated phone may read any chat's path by chat ID. A paired phone has the same reach as desktop: in Unrestricted mode it can browse directory names, not file contents, across the host except P9's private folders (owner decision, 2026-11-10); with agent lock or File protection on, it can browse only the workspace. The daemon validates the selected folder again. A deletion keeps anonymous cursor placeholders with no chat ID, message or timestamp so other devices do not mistake it for missing history; the cursor numbers remain in the ledger. Changing the folder replaces the chat only if it has never been sent a message; a race with Send keeps the original chat. Project chats cannot change their folder this way. Revealing a path may reveal user and project names to a signed-in phone.

Switching an empty chat's agent (the Agent pill) makes a new chat on the other agent, in the same folder or project, and
deletes the old one with `{ "empty": true }` (threat model row O29). With it, the daemon deletes only a chat never sent
to: no `user` or `held` event in its history and no turn running. Otherwise it refuses 409 `not-empty` and the chat stays
as it was; the check is made before the chat is stopped and again after, with nothing in between that and the delete.
Any other body than `{}` or `{ "empty": true }` is refused 400. The route is on both listeners like the other chat
routes, so the desktop and a paired phone (with its passkey session) can call it. It gives no more than the plain
delete from the chat's menu already does: at most, one chat that was never sent to is gone, and the new chat is in the
same folder or project.

While a chat is in a project, its agent reads that project's added files without asking you (threat model row N1d:
putting the chat in the project is the permission): only Claude's read and search tools (Read, Glob, Grep), only paths
inside that project's own `files/` after links are resolved, answered once each time and never as a lasting rule. The
daemon finds the folder from the chat's project at every request; another project's `files/`, `projects/<id>/` and
`state/` are asked as before. Writes, edits and commands (a shell command that reads a file included) are asked as
before, the agent lock still refuses everything, and taking the chat out of the project ends it. Each such answer is
kept as an `auto-allowed` event in the chat. Codex is unchanged: its sandbox reads without asking in every mode.

## Repository checks

`.github/workflows/no-local-paths.yaml` runs `scripts/no-local-paths.mjs` on every pull request. It reads the
PR description, each commit's message and each commit's added lines, and fails on a place on a maintainer's
machine (a home folder, a working copy outside the repo, private notes, a test run id). It only reads: the
workflow has `contents: read` and writes nothing back but its own run summary.

- **The one allowed kind of home path.** Places that are the same on every machine pass: P9's install folder, the
  default workspace by itself (never a folder inside it), and the named dot folders of the tools P9 works with. Any
  other home path, including another dot folder or a folder inside the workspace, fails.

- **The `NO_LOCAL_PATHS_TERMS` secret.** Machine and account names cannot be written in a public file, so they
  are a repository secret, passed to that one step as an environment variable. The script matches them and never
  prints the list; a hit shows the offending line, which is the leak it stops. A PR from this repository fails
  when the secret is missing. A PR from a fork gets no secrets from GitHub, so its run checks paths only and says
  "Personal names: not checked" in the result instead of passing quietly.
- **Limit:** the check stops a path before merge. A path already pushed stays in GitHub's history of that PR
  (its old commits and description edits) until a maintainer removes it there.

## Outbound requests a reader of this file should know about

Things P9 does that reach the network or a host outside your machine, each covered
in more detail above or in its own section (threat model rows 5, 13, 15, 16, 28, 39, 40, 44):

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
- **Check for updates.** Where automatic updates are off, Settings > Maintenance > Updates > Check now opens P9's newest GitHub release
  (`https://github.com/JudgeBreddd/p9/releases/latest`) in your browser (threat model row 28).
- **Auto-update.** The installed app (Windows installer, Linux AppImage) asks GitHub for P9's
  newest release, downloads it and asks to install it (Update now installs; Later, or no answer, installs
  nothing and P9 asks again the next time it opens); see Auto-update
  below (threat model row 39). A source checkout never does. On Windows, a rollback (threat model row 40) can download the
  installer of the version you had from that release on GitHub, when it was not kept.
- **Mission Control tile icons.** A link tile with no picture and no text icon of its own shows the site's icon
  (threat model row 44). The daemon asks that site itself for its page head and icon (GET only, no cookies, 5 s,
  128 KB for the page and 200 KB for the icon, at most 4 icons), never a favicon service, so the site learns your IP
  address and that P9 looked. A link you saved to a host on your own network is asked as you saved it; a redirect or
  an icon on another site is followed only to a public address, never to your router or another private address. The
  icon must be a PNG, JPEG, WebP or ICO by its bytes, is cached in P9's state folder (7 days, a miss 1 day) and is
  shown as an image only. Your own pictures (the Picture button in Edit names and icons) are saved beside your
  registry only after you confirm, at most 256 KB, and agents cannot set them.
- **Landing page name.** The landing greeting's name comes from Settings (or your account's
  first name, once, if the file is new); it is shown as text on your own screen and never sent
  anywhere.

## Auto-update

The installed app updates itself from P9's public GitHub Releases (threat model row 39). It uses
electron-updater, Stable releases only unless the user turns on Settings > Maintenance > Nightly builds: a draft is
never offered, a pre-release (a nightly) only with that switch on, and an older version never replaces a newer one,
except by the rollback below. Turning the switch off keeps the installed nightly until a newer stable release is out.
The switch is kept in `update-channel.json` in the profile folder; anything but `{ "nightly": true }` there is Stable.

- **What is downloaded.** The repository's release feed (`releases.atom`), which names the newest release and
  holds its notes; `latest.yml` (Windows) or `latest-linux.yml` (Linux), which names the newest
  version, its file and that file's sha512; then the Windows installer `.exe` (with its `.blockmap`, so
  only the changed parts download) or the `.AppImage`. Nothing else.
- **From where.** `https://github.com` and GitHub's download host, over HTTPS, for the one repository
  P9 is published from. No sign-in, no token, no account: the release is public. GitHub learns your IP
  address, that P9 checked, and when.
- **When.** Shortly after the app starts and every few hours while it is open. A found update downloads
  in the background, then a box "P9 is ready to update" lists what it changes. Update now (or Settings >
  Maintenance > Updates) closes P9, installs it and opens P9 again. Later, or closing the box without an
  answer, installs nothing: a declined update is only offered again, never applied, and P9 asks at every
  open until Update now. Quitting P9 never
  installs anything: an installer running on the way out could end a window opened meanwhile. Installing restarts the background service on the new version, which ends a chat turn in
  progress; on Linux the restart happens the next time the AppImage starts.
- **The list in the box.** The list items of the release's notes before their first heading, as plain text (tags
  removed, at most 12 lines of 240 characters) in a native box with two buttons: nothing in it is a link, an image
  or HTML, and nothing in it runs. Whoever controls a release controls this text, as they control the release itself.
- **How it is checked.** The downloaded file's sha512 must equal the one in `latest*.yml`, or it is
  thrown away. P9's builds are not code-signed, so there is no publisher signature to check: the
  sha512 proves the file is the one the release names, not who made the release.
- **When it is off.** Running from a source checkout (`!app.isPackaged`), any system other than
  Windows and Linux, a build without `resources/app-update.yml`, and on Linux any run that is not the AppImage. Settings shows the
  Updates row as off and says why.
- **Rollback (threat model row 40).** An update that fails its first 2 starts (window not ready, or the
  service not answering as that version, within 180 s; quitting P9 or closing its window first does not
  count, a crash does) goes back to the last version that started: the
  installer or AppImage of that version kept in P9's folder, or on Windows, when it was not kept, that
  release's installer downloaded from GitHub and run only when its sha512 matches that release's
  `latest.yml`. The failed version is not offered again; the restored app says what happened once and
  offers a prefilled GitHub bug report with the logs, home folder, user and machine names, tokens and IP
  addresses removed, which you read and submit yourself.
- **What rollback cannot do.**
  - A version that has never started healthy on this machine has nothing to go back to. Rollback arrived
    in 0.1.5, so an update from 0.1.4 (or a first install) that fails its starts only writes "no healthy
    version to go back to" to `p9-update.log` and keeps trying.
  - On Linux the old version comes back only from its kept copy in `~/.local/share/p9/appimage/` (the
    running version and the one before it; a copy that failed, for example on a full disk, is not there).
    With no kept copy, P9 quits, the launcher writes "no kept AppImage" to `rollback.log`, and the failed
    version starts again next time; there is no download fallback on Linux as there is on Windows.
  - Only the first 180 s of a start are watched. A version that started healthy once is never rolled back,
    however it breaks later, and a start that takes longer than 180 s counts as a failed one.
- **What a person who controls a release can do.** Anyone who can publish a release in P9's repository
  (the owner's GitHub account, or the CI token that uploads the files) can ship any program, and every
  installed P9 will download it and run it as you, with everything you can reach. HTTPS and the sha512
  stop a change on the way; they do not stop a bad release. Protecting that account and that token is
  what protects you. If you would rather check each version yourself, use a source checkout, which
  never updates on its own.

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
| A phone learns a chat’s starting path only through the chat folder view; health and setup still hide the workspace path (F2, row 24) | "PASS F2" in `test/phone.test.mjs` "Phase 11: malformed and stale usage" (not in `gate:12`; run on its own) | TCP `/health` has no workspace, TCP `/setup` is 404, a refused New idea names no path; fails with the old routes |
