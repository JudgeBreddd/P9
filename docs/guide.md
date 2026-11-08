# Using P9

What each part of P9 does, for you and for the agent helping you set it up. Installing, updating and removing P9 are in the [README](../README.md). What P9 protects, and what it does not, is in [SECURITY.md](../SECURITY.md).

## First start

The first time P9 opens, a setup wizard walks through what it needs. A **Set up** card waits in the Notification Center until every check passes, and Settings → Setup opens the wizard again. Skip it any time; the x on the card skips the card for good. Up to eight steps:

1. **Welcome.** Offers *Connect to a remote* if you want this window to work on a P9 on another machine (see [Remote Connect](#remote-connect-send-to-remote-and-send-files)).
2. **Your workspace.** The folder P9 can write to. *Change the folder* restarts P9's background service, so running chats, scripts and terminals stop.
3. **Claude, Codex or both?** Pick the agents you have an account with. *Install* sets up the copies that come with P9: nothing is downloaded and no admin password is needed.
4. **Sign in to an agent.** *Sign in* opens your browser at the agent's sign-in page (Claude then shows a code to paste into the wizard). *Sign in in a terminal* types the agent's own sign-in command into a P9 terminal and waits for your Enter. P9 never stores your provider login.
5. **Terminal.** P9's terminals run in tmux. If tmux is missing, this step says why it is needed and shows the command. Anything else that only an admin password can install gets the same treatment: the reason first, then the command, and P9 types it into a P9 terminal for you to read and run.
6. **You.** Your name, and a pointer to pets.
7. **Done.** What is set up and what is not yet, and *Take the tour* (the walkthrough, about two minutes).
8. **Mission Control**, last. Mission starts empty; **Open Mission Control** takes you to its own first card, where an agent builds it with you or you start from a template (see [Building your space](#building-your-space)). If you already have Mission files, **I already have Mission files** shows the paths P9 found in your workspace (read only, three folders deep, skipping `node_modules`, `.venv`, `dist`, `build`, `.cache` and similar), lets you change them, and lists what does not exist yet. **Use these files** saves the settings file and creates only what is missing; nothing that already exists is changed or replaced. The fields are listed under [Mission Control](#mission-control).

## Focus modes

One window, three modes. Switch with the buttons at the top of the window.

- **Chat**: agent chats.
- **Dev**: a VS Code-style editor on your workspace.
- **Mission Control**: your scripts as buttons, your apps and pages, and what is waiting on you.

You can turn off modes you don't use: each mode's page in Settings has its own on/off row. At least one stays on. The look you pick applies to every focus mode, Dev Focus included.

## Chat

- **New chat**: pick Claude or Codex. Each chat is its own agent session, run by the P9 daemon, so closing the window doesn't stop it.
- **Tabs and robot heads.** Each open chat has a tab, and each chat that is running has a numbered robot head on the side (its tooltip reads `#N title · Agent · working/idle`). The x on a tab stops that chat and closes the tab, as in VS Code. History lists every chat; Open brings one back.
- **Mode**, **Model** and **Effort** are the three pills under the message box, beside the paperclip and the send arrow. Each opens a menu with the current choice ticked (arrow keys move, Enter picks, Escape closes).
- **Mode** sets how much the agent may do without asking. Claude: Manual (asks every time), Auto, Accept edits, Plan (read and plan only), Bypass permissions (never asks). Codex: Read-only, Workspace access (asks before anything outside the chat folder), Auto review (Codex decides what is risky), Full access (anything on the computer, never asks), Plan (Codex's plan collaboration mode: it plans before it changes anything, with the sandbox of the mode you picked before; any other mode turns it off). A new chat starts in the mode you set under Settings → New chats start in, or in the last mode you picked for that agent. A loosened mode (Bypass permissions, Full access) does not carry into a new chat on its own: it shows its warning again unless you ticked "Don't show again" for it. The agent lock in Settings overrides every mode.
- **Model** lists the agent's own models under its name, with the one in use ticked, all in one list (a group the agent sends, such as Claude's "More", is listed with the rest); Fast mode, where the agent offers it, follows under its own heading. **Effort** sets how hard the agent thinks, where the agent supports it. A pick changes that chat only; Settings → New chats start in sets the model and effort new chats begin with.
- **Approvals.** When the agent asks for permission, its own options show as buttons in the chat.
- **Stop** ends the turn in progress. What the agent wrote so far stays in the chat.
- **Meters** above the message box show context used and your 5-hour and weekly limits, where the provider reports them.
- **Attach** (the paperclip) sends a photo to the agent.
- **Images from the agent** show in the chat when the agent sends the picture itself, such as one Codex generates or one a tool opened. P9 never downloads an image from a web address; a Markdown image in a reply shows as its description.
- **Links in replies.** A link to an `http` or `https` address opens in your browser, never in P9's window, and the real host shows after the link text when the text is not the address itself. Clicking one first shows the full address and asks: **Cancel**, **Open**, or **Open, don't ask again** (remembered in this window's profile). Any other kind of link (`javascript:`, `file:`, a relative path) shows as text. Ctrl+click in a terminal and Mission tiles open without this question, as before.
- **History** lists every chat with its title and when it was last used.
- **Send to remote** and **Send files to remote** (beside Hand off and in the files panel) move work to a remote's P9: see [Remote Connect](#remote-connect-send-to-remote-and-send-files).
- **Hand off** (Claude chats) stops the chat and types `claude --resume <session> --remote-control` into a terminal. Nothing runs until you press Enter.

### Artifacts

When an agent makes something to look at, such as a page, a diagram or a plan, it can mark it as an artifact: a fenced block whose first line reads `<type> artifact [mode] [title]`. `type` is one of `markdown`, `html`, `svg`, `mermaid`, `code` or `react`. `mode` is `panel` (the default), `pinned` or `full`.

- The chat shows a chip where the block was. On the desktop the newest artifact of a finished turn opens beside the chat by itself; click a chip to open any other. On the phone, tap the chip: it opens full screen.
- It runs in a sealed frame with no network, no access to your files and none to P9 itself. Its text is shown as text where it is not code.
- **Pin** keeps it open beside the chat; **Full screen** fills the stage above the message box, which stays usable (in Chat Focus and in Dev Focus, over the side chat).
- **Artifacts and Changes.** The panel beside the chat has two tabs. Artifacts lists what the agent made to look at; Changes lists the files the chat edited or created, and clicking one shows a read-only diff taken from the agent's own edits (removed lines red, added green). Nothing there edits the file. Each chat keeps its newest 30 artifacts in this window, so they stay listed after the chat compacts or the window reloads.
- **Comments.** Select text in the artifact and press *Add comment*. Collect as many as you like, then *Send N comments* sends one message that quotes each. *Cancel* clears them. Nothing is sent until you press Send.
- The pinned **Plan** card, and the plan Claude shows when it asks to leave plan mode, have an **Open** button that opens the plan the same way, with the same comments.

### Agent lock

Settings → Security settings → Agent lock. While it's on, agents can read and answer but can't edit files or run anything that asks for permission. The daemon enforces it, not the window, so it also covers chats started from your phone. You can turn it on or off from the computer or from a paired phone; an agent cannot.

## Dev

A VS Code-style editor (VSCodium's server) on your workspace folder, with its file tree, terminal, extensions from Open VSX, and debugging.

- **Saving.** A file is written only when you press Ctrl+S or Save; the editor no longer writes by itself after you stop typing. A white dot on a tab marks a file you have not saved. A file you open from Chat Focus saves the same way.
- **Guarded save.** If a file changed on disk after you opened it, P9 won't overwrite it. It shows the conflict and keeps your text as a recovery draft. The README explains how to get a draft back.
- **Editor server.** Dev needs VSCodium's server. The install script, the AppImage and the Windows installer carry it. If it is missing, Dev offers an **Install the editor server** button (on a remote, **Install the editor server on the remote**).
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

### Building your space

An empty Mission shows one card with three ways to start:

- **Have Claude build it** or **Have Codex build it** opens a chat with that agent, which asks what you want and builds the space with you. While File protection is on, the agent cannot write your space; the card says so, and you turn it back on once the build is done.
- **Or start from a template**: **ICM workspace**, **Obsidian vault**, **Homelab** or **Blank**, plus any template you saved. A click shows what the template holds; only **Choose template** writes it. The Obsidian template asks for your vault folder as it is added.
- Every part of it can be changed later.

The **Space** button at the top of Mission (it shows the current space's name, *Main* by default) switches between spaces, adds one (**+ Add**), deletes the one you are on, and saves the current one as a template (**Save as template…**, with a name and an optional one-line description).

**Agents edit the space with tools.** Every chat P9 starts has P9's own MCP server, `p9`. Its tools read and change the space and the registry one item at a time: `describe_mission` explains the format with an example of every item type and the templates, `preview_card` shows a card before you place it, and others add, update, move and remove buttons, apps, pages and sections, check a whole file (`validate_space`, `validate_registry`), list and answer what waits on you, and run a registry script. Each write says what changed and is refused while the agent lock is on; the space and registry are read-only to them while File protection is on. `run_script`, `answer_needs_you` and `allow_folder` ask you in the chat first, except in Unrestricted mode.

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

The `space` file adds sections to Mission Control. Each section can have text, buttons and log views (the last 200 lines of a file; a log view's `heading`, `from` and `lines` show one Markdown heading's part, the top of the file, or another number of lines):

```json
{ "sections": [
  { "title": "Backups", "text": "Nightly backup tools.",
    "buttons": [{ "id": "backup-now", "title": "Backup now", "cmd": ["bash", "scripts/backup.sh"] }],
    "logs": [{ "id": "backup-log", "title": "Backup log", "path": "logs/backup.log" }] }
] }
```

Edits to this file show up the next time the page loads, with no restart.

A section's `place` (`col1` to `col6`) draws it open in a column of the page instead of as a tile, and `span` (1 to 6) makes its column wider than the others. Your agent's `describe_mission` tool lists every field; its `preview_card` tool shows how a card looks before you place it.

### Sprint tracker

A **Sprint** button shows while the machine you are connected to has a sprint status file (`~/.local/state/sprint/status.json`, which the sprint skill writes). Its window shows a ring for the whole sprint and one ring per chunk, with each chunk's state (running, waiting, merged, blocked), its latest activity and its steps, and when it last updated. **Open tmux** opens a P9 terminal that runs `tmux attach -t p9`. The window also has a button for each sprint script your registry defines (`sprint-start`, `sprint-close`, `sprint-heavy`). A section in your space with `"widget": "sprint"` puts this button where the section is, and its window then has that section's own buttons instead. No file, no button.

### Other parts

- **Needs you chips** read `needs <your name>`, with the name from Settings → Your name.
- **Robot heads** in the rail are numbered; the tooltip names the chat and whether it is working.
- **Waiting on you**: one card per file in your `waiting` folder.
- **+ New idea**: writes a new file to the `_ideas/` folder in your workspace (`_ideas/needs-done/` for a fix to an existing project). It never replaces an existing file.
- **Fix with Claude**: a folder list in your space with a `fix` text gives the files it opens a **Fix with Claude** button, which starts a Claude chat with that text, then the file.

## Terminal

The terminal at the bottom of the window is a real shell, kept by the daemon, so it keeps running when you close the window. The phone can open the same terminals.

Settings → General → **Show the shell's welcome message in terminals** (on by default). Off: new terminals get `P9_NO_GREETING=1` for your shell config to read, and fish starts with its greeting emptied (that hides a logo or `fastfetch`). PowerShell always starts without its logo. Terminals already open keep theirs.

## Pets

A pet from [petdex.dev](https://petdex.dev) can stand in for the "agent is working" spinner. To add one:

1. Run the install command from the pet's page (`npx petdex install <name>`). It saves the pet to `~/.codex/pets`.
2. In Settings → Pets, click **Import N new petdex pets**. P9 copies each pet in `~/.codex/pets` it doesn't have yet. A folder that isn't a petdex pet is skipped and named in the notice.

**Add pets…** picks pet folders from anywhere else.

Each focus mode has its own pet settings: on or off, size, and a pet for System, Claude and Codex. Drag a pet to move it; Reset positions puts them back.

## Remote Connect, Send to remote and Send files

Remote Connect points this window at a P9 on another Linux machine (a remote). Chat, Mission Control, the terminal and Dev Focus use the remote's P9 through an ssh tunnel (the way VS Code Remote-SSH works). This computer's own P9 keeps running.

1. **Pick the machine.** Click the Local/Remote badge in the top bar: its menu lists this computer, each saved remote with whether P9 there is reachable, **Add a machine…**, and, for a saved remote, **Remove**. Settings → Remote Connect has the same list: every `Host` in your `~/.ssh/config`, plus any `Host` name or `user@address` you add, each with **Connect**. The setup wizard's welcome step offers the same.
2. **Log in.** A key works as with `ssh`. Without one, P9 asks for your password in its own window (from Linux only; Windows needs a key). The password goes to ssh through a pipe and is never saved, logged or put on a command line; the login is kept for 10 idle minutes so you type it once. Afterwards P9 offers **Log in without a password next time** (ticked), which adds a key of P9's own on the remote. If this computer has no ssh program, P9 says `ssh-missing` with how to install it, and **Try again**.
3. **The host key.** The first connect to a machine trusts whatever host key it shows (ssh's `StrictHostKeyChecking=accept-new`), without asking. That means: if someone could sit between you and that machine on that first connect, ssh would not notice. From then on a different key stops the connect, and P9 names the `known_hosts` line to check before you remove it.
4. **P9 on the remote.** If P9 is not running there, Connect starts it, or installs a small P9 in `~/.local/share/p9/remote` (no source checkout, no `~/p9`) with one progress line. Then one question: **Temporary** (P9 there runs while you are connected and stops 5 minutes after the last window leaves) or **Always on** (installs the full P9 there and keeps it running, so your phone can reach it and long tasks finish; if your account there needs an admin setting for that, P9 shows the exact command and asks for the admin password in its own window). Tick **Do not ask again for this machine** to keep the answer; Settings → Remote Connect changes it per machine. The small Temporary P9 has no Mission Control. P9 also asks which AI agents to download there: Claude, Codex, both or none (none: just the editor and terminal); the machine menu's **AI agents on <machine>…** asks again.
5. **Disconnect** beside the remote label, **This computer** in the machine menu, or **Use this computer** in Settings goes back to this computer's P9.
6. **Updates.** Connecting to a remote whose P9 is 0.1.6 or later but older than this one updates it. A failed build leaves it as it was, and a new build that does not start is put back. One whose P9 is current is left alone, and P9 refuses to replace a newer one with an older one. A remote still on 0.1.5 does not update itself: update it once as a source checkout (the README's Update steps: git pull, build, restart), then run `bash scripts/install.sh` there.
7. **Dev Focus** runs its editor on the remote. If the editor server is missing there, Dev offers **Install the editor server on the remote**. **Open Folder** lists the remote's folders to click through, and New chat's **Choose folder** does the same. Both stay inside the remote's workspace unless Unrestricted mode is on there; then they walk the whole machine, with `..` up to `/`.
8. **Some things stay on this computer.** The setup **Pick** buttons, **Open in VS Code**, the Obsidian vault picker, **Change the workspace folder** and **Repair** do nothing on a remote, or say they are for this computer. The remote's workspace folder is set where P9 is installed there.

If a connection drops on its own and is still down 30 s later, a notification says so. If it needs your password again, the password window says the connection dropped.

### Send to remote

In a Claude or Codex chat, **Send to remote** moves that chat to the remote and carries on there. Codex chats move too. A black-hole animation with a progress bar shows the move; **Cancel** stops it. Before the chat moves, P9 sends the workspace's files the same way as Send files (below), so the chat finds what it was working on. When the move finishes, P9 asks **Open it on <host>?**; tick "Don't show again" to always open it, or always stay. A loosened mode (Bypass permissions, Full access) does not carry to the new chat.

### Send files

The files panel's **Send files to remote** copies your workspace's files to the remote's workspace, over the same ssh tunnel, with no Syncthing.

- The first send from this computer to a folder there stops to ask when files differ: **Laptop wins** or **Keep the newer of each**. A later send asks only about files changed on both sides since the last one: **Keep the laptop's**, **Keep the remote's** or **Keep the newer of each**. Either way it lists each differing file in words before anything is copied, and **Cancel** stops it. Files deleted here since the last send are deleted there only if you tick **Delete on the remote too**.
- Any file the send replaces goes to P9's recovery folder first, so it can be put back.
- Settings → Remote Connect → Send files sets three limits: the largest file, the most files in one send, and the most data in one send. A send over a limit is refused before anything is copied, and the message names the limit.

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

The gear opens Settings. It has five pages, picked on the left: **General**, **Chat Focus**, **Dev Focus**, **Mission Control** and **Remote Connect**; each focus mode's page holds its on/off switch. Each row has an **i**: hover it for what the row does, click it to open its part of this guide.

- **P9 docs on GitHub**, **Anymouse** and **Setup**, at the top: this guide, [Anymouse](#anymouse) and the [first-start](#first-start) window again.
- **Zoom** makes everything in the window bigger or smaller, in every focus mode. Ctrl = and Ctrl - do the same; Ctrl 0 resets.
- **Your name** is what the landing page greets you with.
- **Start in my last focus mode** opens P9 straight into the focus mode you used last (Chat Focus, Dev Focus or Mission Control), not the landing page.
- **Close the chat window on send** closes a chat window opened from a Chat Focus card or the Notification Center once your message is sent.
- **New chats start in** sets the mode a new chat starts in, for Claude and for Codex. "Last mode picked" is the default. A loosened mode (Bypass permissions, Full access) asks first, in red, unless you ticked "Don't show again" for it. Beside it, **Default model** and **Default effort** per agent: "Agent's default" (no override) or one of the agent's own models or efforts as P9 last received them; before the first chat with that agent only "Agent's default" is offered. A new chat starts with them when the agent still offers them; a pick inside a chat changes that chat only.
- **Focus modes** and **Pets**: see [Focus modes](#focus-modes) and [Pets](#pets).
- **Show the shell's welcome message in terminals** (General): see [Terminal](#terminal).
- **Open P9 on** (the Remote Connect page): where P9 opens the next time it starts: "Where it was last" (the default: the machine this window was on when it closed), "This computer", or one of the remotes listed there. A chosen remote that cannot be reached shows the connecting screen, as Connect does.
- **Remote** and **Send files** (the Remote Connect page): see [Remote Connect](#remote-connect-send-to-remote-and-send-files) and [Send files](#send-files).

### Security settings

Four switches in one group, on the desktop and on a paired phone. The defaults are the ones P9 ships with; turn off what gets in your way.

- **Agent lock** (off by default): agents can read and answer but cannot edit files or run anything that asks permission. See [Agent lock](#agent-lock).
- **File protection** (on by default): the editor cannot open or change secrets, `.env` files, `_private`, `.git` or P9's own files. See [File protection](#file-protection). Turning it off asks first.
- **Warn before Full access and Bypass permissions** (on by default): a red warning before a chat switches to one of those modes. This is stored on the device you change it on.
- **Unrestricted mode**: turns the lock, File protection and the warnings off in one step, and makes new chats on this device start in Codex Full access and Claude Bypass permissions. It asks once. Turning it off puts File protection and the warnings back on and removes those two start modes (a mode you picked by hand stays); the lock stays off. While it is on, Dev Focus and Mission may open any folder, including your home folder and `/` (P9's own state and recovery folders stay closed); a folder outside the workspace asks **Trust this folder?** with **Don't ask again** (remembered per machine, this computer or each remote, and only while the mode is on); and the `p9` tools `run_script`, `answer_needs_you` and `allow_folder` run without asking in the chat.

The lock and File protection belong to P9, so one setting covers the desktop and every phone. The warnings and the start modes belong to the device.

### Mission Control files

Once Mission Control's settings file is loaded, Settings shows its paths, so you can change them after setup without a text editor. Each row saves when you leave it; P9 checks it as it checks the file at start, and a value it refuses stays in the box with the reason. The old file is kept as `settings.json.bak`.

A path box shows the end of the path (the file name); hover it for the full path.

- **Main project file** (`primary`): the file that names your main project, the bold "Main project: Name" line with its folder (for the Mission Control Main Project card and the Chat Focus Files pane's Current project).
- **Buttons, apps and pages file** (`registry`): the JSON file listing your buttons, apps and pages (for the Mission Control script buttons and the Apps and pages card).
- **Folder of items waiting on you** (`waiting`): a folder of .md files, one for each thing waiting on you (for the Mission Control Waiting on you list, the Chat Focus cards and the Files pane's Needs you view).
- These three are the same paths as in [first start](#first-start), each inside the workspace. **Pick** opens a picker there.
- **Folder your buttons run in** (`scripts_root`, optional): a full path where your buttons and apps run, and the one ~/workspace stands for. Empty: the workspace.
- **Extra sections file** (`space`, optional): the JSON file with your own sections, buttons and log views (for the extra sections on the Mission Control page). Empty: no extra sections.
- **Extra link types for pages** (`page_schemes`, optional): link types besides http and https that a Mission Control page may open, separated by commas (for example `obsidian`). A page link of that type asks before it opens.
- **Notes folders** (`notes_roots`, optional): one `name = /full/path` per line (for the notes an extra Mission Control section shows, by that name). Your home folder, a folder holding the workspace and P9's recovery folder are refused.

### Updates

The Updates row sits in the Maintenance group. In the installed app, **Check now** asks GitHub for a newer P9, and **Restart to update** installs one that has downloaded. **Nightly builds** also takes P9's test builds between releases (GitHub pre-releases); they can break. Turning it off keeps the nightly you have until a newer stable release is out, so it never goes back to an older version. Where automatic updates are off (a source checkout), **Check now** opens the newest P9 release on GitHub instead; if its number is higher than yours, the README's Update section says how to install it. Your workspace and settings stay.

### Maintenance

For when P9 misbehaves. Each button is also in the command palette (Ctrl K).

- **Reload window** loads the window again. Chats keep running in the background service; text you have not sent is lost.
- **Refresh Mission** reads your Mission Control files again now, instead of at the next check (for every Mission Control card and button).
- **Restart daemon** restarts P9's background service (the daemon that runs your chats, scripts and terminals) and waits until the new one answers. Running chats, scripts and terminals stop.
- **Repair daemon service** sets P9's background service (the daemon that runs your chats, scripts and terminals) up again and starts it. On Windows it runs the installer's own setup step: use it when P9 says its task is missing or out of date. On Linux it enables the `p9-foundation` unit again. Running chats, scripts and terminals stop.
- **Rebuild + reload** shows only when P9 runs from a source checkout. It runs `pnpm build`, then reloads the window with the new build.
