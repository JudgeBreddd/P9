# Using P9

What each part of P9 does, for you and for the agent helping you set it up. Installing, updating and removing P9 are in the [README](../README.md). What P9 protects, and what it does not, is in [SECURITY.md](../SECURITY.md).

## First start

The first time P9 opens, a setup wizard walks through what it needs. A **Set up** card waits in the Notification Center until every check passes, and Settings → Setup opens the wizard again. Skip it any time; the x on the card skips the card for good. Eight steps:

1. **Welcome.** Offers *Connect to a P9 on another machine* if you already run P9 on a server (see [Server mode](#server-mode-send-to-server-and-send-files)).
2. **Your workspace.** The folder P9 can write to. *Change the folder* restarts P9's background service, so running chats, scripts and terminals stop.
3. **Claude, Codex or both?** Pick the agents you have an account with. *Install* sets up the copies that come with P9: nothing is downloaded and no admin password is needed.
4. **Sign in to an agent.** *Sign in* opens your browser at the agent's sign-in page (Claude then shows a code to paste into the wizard). *Sign in in a terminal* types the agent's own sign-in command into a P9 terminal and waits for your Enter. P9 never stores your provider login.
5. **Mission Control.** P9 looks around your workspace (read only, three folders deep, skipping `node_modules`, `.venv`, `dist`, `build`, `.cache` and similar) for an `AGENTS.md`, a `registry.json` and `needs-you` or `waiting` folders. It shows the paths it found, lets you change them, and lists exactly what the button will add. **Use these files** saves only the settings file. **Create the starter files** adds empty starter files. Nothing that already exists is changed or replaced. The fields are listed under [Mission Control](#mission-control).
6. **Terminal.** P9's terminals run in tmux. If tmux is missing, this step says why it is needed and shows the command. Anything else that only an admin password can install gets the same treatment: the reason first, then the command, and P9 types it into a P9 terminal for you to read and run.
7. **You.** Your name, and a pointer to pets.
8. **Done.** Take the tour (the walkthrough, about two minutes) or close.

## Focus modes

One window, three modes. Switch with the buttons at the top of the window.

- **Chat**: agent chats.
- **Dev**: a VS Code-style editor on your workspace.
- **Mission Control**: your scripts as buttons, your apps and pages, and what is waiting on you.

You can turn off modes you don't use in Settings → Focus modes. At least one stays on. Each mode keeps its own theme.

## Chat

- **New chat**: pick Claude or Codex. Each chat is its own agent session, run by the P9 daemon, so closing the window doesn't stop it.
- **Tabs and robot heads.** Each open chat has a tab, and each chat that is running has a numbered robot head on the side (its tooltip reads `#N title · Agent · working/idle`). The x on a tab stops that chat and closes the tab, as in VS Code. History lists every chat; Open brings one back.
- **Mode** sets how much the agent may do without asking. Claude: Auto, Manual (asks every time), Plan (read and plan only), Accept edits. Bypass permissions (never asks). Codex: Read-only, Workspace access (asks before anything outside the chat folder), Auto review (Codex decides what is risky), Full access (anything on the computer, never asks). A new chat starts in the mode you set under Settings → New chats start in, or in the last mode you picked for that agent. A loosened mode (Bypass permissions, Full access) does not carry into a new chat on its own: it shows its warning again unless you ticked "Don't show again" for it. The agent lock in Settings overrides every mode.
- **Model** lists the agent's own models, with its default marked. **Effort** sets how hard the agent thinks, where the agent supports it.
- **Approvals.** When the agent asks for permission, its own options show as buttons in the chat.
- **Stop** ends the turn in progress. What the agent wrote so far stays in the chat.
- **Meters** above the message box show context used and your 5-hour and weekly limits, where the provider reports them.
- **Attach** (the paperclip) sends a photo to the agent.
- **Images from the agent** show in the chat when the agent sends the picture itself, such as one Codex generates or one a tool opened. P9 never downloads an image from a web address; a Markdown image in a reply shows as its description.
- **Links in replies.** A link to an `http` or `https` address opens in your browser, never in P9's window, and the real host shows after the link text when the text is not the address itself. Any other kind of link (`javascript:`, `file:`, a relative path) shows as text.
- **Send to server** and **Send files to server** (beside Hand off and in the files panel) move work to a server's P9: see [Server mode](#server-mode-send-to-server-and-send-files).
- **Hand off** (Claude chats) stops the chat and types `claude --resume <session> --remote-control` into a terminal. Nothing runs until you press Enter.

### Artifacts

When an agent makes something to look at, such as a page, a diagram or a plan, it can mark it as an artifact: a fenced block whose first line reads `<type> artifact [mode] [title]`. `type` is one of `markdown`, `html`, `svg`, `mermaid`, `code` or `react`. `mode` is `panel` (the default), `pinned` or `full`.

- The chat shows a chip where the block was. On the desktop the newest artifact of a finished turn opens beside the chat by itself; click a chip to open any other. On the phone, tap the chip: it opens full screen.
- It runs in a sealed frame with no network, no access to your files and none to P9 itself. Its text is shown as text where it is not code.
- **Pin** keeps it open beside the chat; **Full screen** fills the stage above the message box, which stays usable (in Chat Focus and in Dev Focus, over the side chat).
- **Comments.** Select text in the artifact and press *Add comment*. Collect as many as you like, then *Send N comments* sends one message that quotes each. *Cancel* clears them. Nothing is sent until you press Send.
- The pinned **Plan** card, and the plan Claude shows when it asks to leave plan mode, have an **Open** button that opens the plan the same way, with the same comments.

### Agent lock

Settings → Security settings → Agent lock. While it's on, agents can read and answer but can't edit files or run anything that asks for permission. The daemon enforces it, not the window, so it also covers chats started from your phone. You can turn it on or off from the computer or from a paired phone; an agent cannot.

## Dev

A VS Code-style editor (VSCodium's server) on your workspace folder, with its file tree, terminal, extensions from Open VSX, and debugging.

- **Saving.** A file is written only when you press Ctrl+S or Save; the editor no longer writes by itself after you stop typing. A white dot on a tab marks a file you have not saved. A file you open from Chat Focus saves the same way.
- **Guarded save.** If a file changed on disk after you opened it, P9 won't overwrite it. It shows the conflict and keeps your text as a recovery draft. The README explains how to get a draft back.
- **Editor server.** Dev needs VSCodium's server. The install script, the AppImage and the Windows installer carry it. If it is missing, Dev offers an **Install the editor server** button (in Server mode, **Install the editor server on the server**).
- **New File** creates a file. It never replaces one that exists. **Save As** onto a name that already exists asks you whether to replace it.
- New folders, renames and deletes from the file tree aren't available yet. Do those in a terminal.
- From any terminal, `p9 edit <file>[:line]` opens a file in Dev, and `p9 diff <a> <b>` compares two.

### File protection

Settings → Security settings → File protection, on by default. While it's on, the editor (here and on your phone) can't open or change secrets, `.env` files, `_private`, `.git` or P9's own files. Turning it off shows a warning first (a confirm in the same words on the phone), and turning it back on doesn't ask. It covers the editor and P9's own file routes only. Agents and terminals run as you and aren't limited by it.

## Mission Control

Mission Control reads `~/.config/p9/settings.json`. Paths are relative to your workspace.

| Field | What it points to |
|---|---|
| `primary` | your main project file, shown as the Main Project card |
| `registry` | a JSON file of your buttons, apps and pages |
| `waiting` | a folder of files waiting on you, one file per item |
| `scripts_root` (optional, absolute) | where buttons run from; defaults to the workspace |
| `space` (optional) | a JSON file of your own sections (below) |

P9 re-reads the file every time Mission refreshes, so changes show within one refresh with no restart. If the file is broken, Mission keeps the last good settings and says so. The one case that asks you to restart is a saved workspace folder that was missing at start; the notice has a **Restart P9 to apply** button.

### Buttons, apps and pages

The registry is what makes Mission Control fit your system. Each entry has an `id`, a `title` and a `cmd`. P9 runs the `cmd` list as-is, without a shell. Example:

```json
{
  "scripts": [{ "id": "disk", "title": "Disk use", "cmd": ["df", "-h"] }],
  "apps": [{ "id": "files", "title": "Files", "cmd": ["xdg-open", "."] }],
  "pages": [{ "id": "docs", "title": "Docs", "url": "https://github.com/JudgeBreddd/p9" }]
}
```

A button's output opens in a window you can copy from. Add `"terminal": true` to run a button in its own terminal window instead. Clicking a button runs that command as you, so read the registry before you use it. Your agent can write it for you: describe the scripts you use and where they live.

### Your own sections

The `space` file adds sections to Mission Control. Each section can have text, buttons and log views (the last 200 lines of a file):

```json
{ "sections": [
  { "title": "Backups", "text": "Nightly backup tools.",
    "buttons": [{ "id": "backup-now", "title": "Backup now", "cmd": ["bash", "scripts/backup.sh"] }],
    "logs": [{ "id": "backup-log", "title": "Backup log", "path": "logs/backup.log" }] }
] }
```

Edits to this file show up the next time the page loads, with no restart.

### Sprint tracker

A **Sprint** button shows while the machine you are connected to has a sprint status file (`~/.local/state/sprint/status.json`, which the sprint skill writes). Its window shows a ring for the whole sprint and one ring per chunk, with each chunk's state (running, waiting, merged, blocked), its latest activity and its steps, and when it last updated. **Open tmux** opens a P9 terminal that runs `tmux attach -t p9`. The window also has a button for each sprint script your registry defines. No file, no button.

### Other parts

- **Needs you chips** read `needs <your name>`, with the name from Settings → Your name.
- **Robot heads** in the rail are numbered; the tooltip names the chat and whether it is working.
- **Waiting on you**: one card per file in your `waiting` folder.
- **+ New idea**: writes a new file to the `_ideas/` folder in your workspace (`_ideas/needs-done/` for a fix to an existing project). It never replaces an existing file.
- **Fix with Claude**: on an incident, starts a Claude chat that already holds the incident's details.

## Terminal

The terminal at the bottom of the window is a real shell, kept by the daemon, so it keeps running when you close the window. The phone can open the same terminals.

## Pets

A pet from [petdex.dev](https://petdex.dev) can stand in for the "agent is working" spinner. To add one:

1. Run the install command from the pet's page (`npx petdex install <name>`). It saves the pet to `~/.codex/pets`.
2. In Settings → Pets, click **Import N new petdex pets**. P9 copies each pet in `~/.codex/pets` it doesn't have yet. A folder that isn't a petdex pet is skipped and named in the notice.

**Add pets…** picks pet folders from anywhere else.

Each focus mode has its own pet settings: on or off, size, and a pet for System, Claude and Codex. Drag a pet to move it; Reset positions puts them back.

## Server mode, Send to server and Send files

Server mode points this window at a P9 running on another computer. Chat, Mission Control, the terminal and Dev Focus use the server's P9 through an ssh tunnel (the way VS Code Remote-SSH works). This computer's own P9 keeps running, and **Use Local** goes back.

1. Make sure `ssh <server>` works from this computer without a password prompt (an entry in `~/.ssh/config` with a key).
2. Settings → Server → pick the server → **Connect**. A badge in the title bar says you are on the server. The setup wizard's welcome step offers the same choice.
3. Connecting to a server whose P9 is 0.1.6 or later but older than this one updates it. A failed build leaves the server as it was, and a new build that does not start is put back. A server whose P9 is current is left alone. A server still on 0.1.5 does not update itself: update it once as a source checkout (the README's Update steps: git pull, build, restart), then run `bash scripts/install.sh` there.
4. Dev Focus runs its editor on the server. If the editor server is missing there, Dev offers **Install the editor server on the server**.
5. Some things stay on this computer. In Server mode the folder pickers, Dev Focus **Open Folder**, **Open in VS Code**, **Change the workspace folder** and **Repair** do nothing, or say they are Local-only. Switch to **Use Local** for them. The server's workspace folder is set where P9 is installed on the server.

### Send to server

In a Claude or Codex chat, **Send to server** moves that chat to the server and carries on there. Codex chats move too. A black-hole animation with a progress bar shows the move; **Cancel** stops it. Before the chat moves, P9 sends the workspace's files the same way as Send files (below), so the chat finds what it was working on. When the move finishes, P9 asks **Open it on <server>?**; tick "Don't show again" to always open it, or always stay. A loosened mode (Bypass permissions, Full access) does not carry to the new chat.

### Send files

The files panel's **Send files to server** copies your workspace's files to the server's workspace, over the same ssh tunnel, with no Syncthing.

- The first send from this computer to a server stops to ask when files differ. It lists each differing file in words (which copy is newer, with both times) before anything is copied.
- Choose **Laptop wins**, **Keep the server's** or **Keep the newer of each**, or **Cancel**. Any file the send replaces goes to P9's recovery folder first, so it can be put back.
- Settings → Send files sets three limits: the largest file, the most files in one send, and the most data in one send. A send over a limit is refused before anything is copied, and the message names the limit.

## Phone

An optional phone view on your Tailscale network, signed in with a passkey that you approve from the computer. The README has the setup steps. An approved phone can do what you can do in P9, so approve only your own devices; a lost phone is cut off by revoking it from the desktop.

- **Tabs.** A 44 px top bar and a tab bar: Chats, Terminal, Mission, Usage and Files. The Chats list opens a chat at its last message.
- **Chat** matches the desktop: the composer, Mode, Model, photos, the plan and pinned cards, queued messages, and artifacts (tap a chip to open one full screen).
- **Terminal** has a Paste key.
- **Sign-in.** If the phone has to sign in again, the text in your message box comes back after it. It is never sent for you.
- **Mission** shows a **Sprint** row (the same rings and scripts) when the machine has a sprint status file; **Open tmux** goes to the Terminal tab, attached.
- **Settings** (the gear on the Chats tab) has the theme, [Security settings](#security-settings), the [Mission Control files](#mission-control-files) rows, and Rebuild + reload.

A chat's **Phone** button shows a QR code and a link that open that chat on the phone, at this computer's remote login address. If sign-in comes first, the phone still opens that chat after it. With remote logins off, the button says how to turn them on.

## Notifications

Cards show what needs you, such as an agent waiting for your answer or items waiting on you. Click a card to open its chat or item. The bell (Notification Center) keeps the cards you set aside, older items and system notices until you dismiss them.

## Anymouse

The Anymouse button sends P9's makers an idea, a bug report or a gripe. Without a GitHub token it opens a prefilled GitHub issue page in your browser. The README shows how to send notes straight from the app. If GitHub refuses that token, the box says why and how to fix it, keeps your note, and offers **Open on GitHub** to file it on GitHub's own page instead.

## Persistence and Stop All

Closing the window keeps chats and terminals running. The red session button switches P9 to "dies with the app", or runs **Stop All**, which stops every chat, button run and P9 terminal. The README has a table of what stops what.

## Settings

The gear opens Settings. Each row has an **i**: hover it for what the row does, click it to open its part of this guide.

- **P9 docs on GitHub**, **Anymouse** and **Setup**, at the top: this guide, [Anymouse](#anymouse) and the [first-start](#first-start) window again.
- **Zoom** makes everything in the window bigger or smaller, in every focus mode. Ctrl = and Ctrl - do the same; Ctrl 0 resets.
- **Your name** is what the landing page greets you with.
- **Start in my last focus mode** opens P9 straight into the focus mode you used last (Chat Focus, Dev Focus or Mission Control), not the landing page.
- **Close the chat window on send** closes a chat window opened from a Chat Focus card or the Notification Center once your message is sent.
- **New chats start in** sets the mode a new chat starts in, for Claude and for Codex. "Last mode picked" is the default. A loosened mode (Bypass permissions, Full access) asks first, in red, unless you ticked "Don't show again" for it.
- **Focus modes** and **Pets**: see [Focus modes](#focus-modes) and [Pets](#pets).
- **Server** and **Send files** show when this window can reach a server: see [Server mode, Send to server and Send files](#server-mode-send-to-server-and-send-files) and [Send files](#send-files).

### Security settings

Four switches in one group, on the desktop and on a paired phone. The defaults are the ones P9 ships with; turn off what gets in your way.

- **Agent lock** (off by default): agents can read and answer but cannot edit files or run anything that asks permission. See [Agent lock](#agent-lock).
- **File protection** (on by default): the editor cannot open or change secrets, `.env` files, `_private`, `.git` or P9's own files. See [File protection](#file-protection). Turning it off asks first.
- **Warn before Full access and Bypass permissions** (on by default): a red warning before a chat switches to one of those modes. This is stored on the device you change it on.
- **Unrestricted mode**: turns the lock, File protection and the warnings off in one step, and makes new chats on this device start in Codex Full access and Claude Bypass permissions. It asks once. Turning it off puts File protection and the warnings back on and removes those two start modes (a mode you picked by hand stays); the lock stays off.

The lock and File protection belong to P9, so one setting covers the desktop and every phone. The warnings and the start modes belong to the device.

### Mission Control files

Once Mission Control's settings file is loaded, Settings shows its paths, so you can change them after setup without a text editor. Each row saves when you leave it; P9 checks it as it checks the file at start, and a value it refuses stays in the box with the reason. The old file is kept as `settings.json.bak`.

A path box shows the end of the path (the file name); hover it for the full path.

- **Main project file** (`primary`): the file that names your main project, the bold "Main project: Name" line with its folder (for the Mission Control Main Project card and the Chat Focus Files pane's Current project).
- **Buttons, apps and pages file** (`registry`): the JSON file listing your buttons, apps and pages (for the Mission Control script buttons and the Apps and pages card).
- **Folder of items waiting on you** (`waiting`): a folder of .md files, one for each thing waiting on you (for the Mission Control Waiting on you list, the Chat Focus cards and the Files pane's Needs you view).
- **workspace-hub folder** (`hub`, optional): the folder of your workspace-hub tool (for the Mission Control Logs and incidents, Wiki review inbox and Workspace cards, which stay hidden without it).
- These four are the same paths as in [first start](#first-start), each inside the workspace. **Pick** opens a picker there.
- **Folder your buttons run in** (`scripts_root`, optional): a full path where your buttons and apps run, and the one ~/workspace stands for. Empty: the workspace.
- **Extra sections file** (`space`, optional): the JSON file with your own sections, buttons and log views (for the extra sections on the Mission Control page). Empty: no extra sections.
- **Remote host name** (`server_host`, optional): the network name of your remote, the second machine workspace-hub watches (for the Mission Control Logs and incidents card, which also reads that remote's logs over ssh).
- **Extra link types for pages** (`page_schemes`, optional): link types besides http and https that a Mission Control page may open, separated by commas (for example `obsidian`). A page link of that type asks before it opens.
- **Notes folders** (`notes_roots`, optional): one `name = /full/path` per line (for the notes an extra Mission Control section shows, by that name). Your home folder, a folder holding the workspace and P9's recovery folder are refused.

### Updates

The Updates row sits in the Maintenance group. In the installed app, **Check now** asks GitHub for a newer P9, and **Restart to update** installs one that has downloaded. Where automatic updates are off (a source checkout), **Check now** opens the newest P9 release on GitHub instead; if its number is higher than yours, the README's Update section says how to install it. Your workspace and settings stay.

### Maintenance

For when P9 misbehaves. Each button is also in the command palette (Ctrl K).

- **Reload window** loads the window again. Chats keep running in the background service; text you have not sent is lost.
- **Refresh Mission** reads your Mission Control files again now, instead of at the next check (for every Mission Control card and button).
- **Restart daemon** restarts P9's background service (the daemon that runs your chats, scripts and terminals) and waits until the new one answers. Running chats, scripts and terminals stop.
- **Repair daemon service** sets P9's background service (the daemon that runs your chats, scripts and terminals) up again and starts it. On Windows it runs the installer's own setup step: use it when P9 says its task is missing or out of date. On Linux it enables the `p9-foundation` unit again. Running chats, scripts and terminals stop.
- **Rebuild + reload** shows only when P9 runs from a source checkout. It runs `pnpm build`, then reloads the window with the new build.
