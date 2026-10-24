# Using P9

What each part of P9 does, for you and for the agent helping you set it up. Installing, updating and removing P9 are in the [README](../README.md). What P9 protects, and what it does not, is in [SECURITY.md](../SECURITY.md).

## First start

When P9 is missing something it needs, it shows a **Set up** card. Its window tells you two things.

- **Mission Control paths.** P9 reads `~/.config/p9/settings.json` to find your main project file, your buttons and your waiting folder. If the file is missing, the window gives you a prompt. Copy it and paste it into Claude or Codex, and your agent writes the file for you. P9 never writes this file itself. Restart P9 after it's written. The fields are listed under [Mission Control](#mission-control).
- **Agents.** P9 uses the Claude and Codex logins you already have. Sign in from a terminal (`claude`, then log in, or `codex login`), then restart P9. P9 never stores your provider login.

The x on the card skips it for good. Settings → Welcome opens it again.

## Focus modes

One window, three modes. Switch with the buttons at the top of the window.

- **Chat**: agent chats.
- **Dev**: a VS Code-style editor on your workspace.
- **Mission Control**: your scripts as buttons, your apps and pages, and what is waiting on you.

You can turn off modes you don't use in Settings → Focus modes. At least one stays on. Each mode keeps its own theme.

## Chat

- **New chat**: pick Claude or Codex. Each chat is its own agent session, run by the P9 daemon, so closing the window doesn't stop it.
- **Tabs and robot heads.** Each open chat has a tab, and each chat that is running has a robot head on the side. The x on a tab stops that chat and closes the tab, as in VS Code. History lists every chat; Open brings one back.
- **Mode** sets how much the agent may do without asking. Claude: Auto, Manual (asks every time), Plan (read and plan only), Accept edits. Bypass permissions (never asks). Codex: Read-only, Workspace access (asks before anything outside the chat folder), Auto review (Codex decides what is risky), Full access (anything on the computer, never asks). The last mode you pick for an agent is where its next chat starts. Bypass permissions and Full access show a warning first; the agent lock in Settings overrides every mode. P9 doesn't offer modes that skip every check.
- **Model** lists the agent's own models, with its default marked. **Effort** sets how hard the agent thinks, where the agent supports it.
- **Approvals.** When the agent asks for permission, its own options show as buttons in the chat.
- **Stop** ends the turn in progress. What the agent wrote so far stays in the chat.
- **Meters** above the message box show context used and your 5-hour and weekly limits, where the provider reports them.
- **Attach** (the paperclip) sends a photo to the agent.
- **Images from the agent** show in the chat when the agent sends the picture itself, such as one Codex generates or one a tool opened. P9 never downloads an image from a web address; a Markdown image in a reply shows as its description.

### Agent lock

Settings → Agent lock. While it's on, agents can read and answer but can't edit files or run anything that asks for permission. The daemon enforces it, not the window, so it also covers chats started from your phone. Neither the phone nor an agent can turn it off.

## Dev

A VS Code-style editor (VSCodium's server) on your workspace folder, with its file tree, terminal, extensions from Open VSX, and debugging.

- **Guarded save.** If a file changed on disk after you opened it, P9 won't overwrite it. It shows the conflict and keeps your text as a recovery draft. The README explains how to get a draft back.
- **New File** creates a file. It never replaces one that exists. **Save As** onto a name that already exists asks you whether to replace it.
- New folders, renames and deletes from the file tree aren't available yet. Do those in a terminal.
- From any terminal, `p9 edit <file>[:line]` opens a file in Dev, and `p9 diff <a> <b>` compares two.

### File protection

Settings → File protection, on by default. While it's on, the editor (here and on your phone) can't open or change secrets, `.env` files, `_private`, `.git` or P9's own files. Turning it off shows a warning first, and turning it back on doesn't ask. It covers the editor and P9's own file routes only. Agents and terminals run as you and aren't limited by it.

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

### Other parts

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

## Phone

An optional phone view on your Tailscale network, signed in with a passkey that you approve from the computer. The README has the setup steps. The phone has Chat (with Mode and Model), Terminal, Mission Control, Usage and Files. An approved phone can do what you can do in P9, so approve only your own devices.

## Notifications

Cards show what needs you, such as an agent waiting for your answer or items waiting on you. Click a card to open its chat or item. The bell (Notification Center) keeps the cards you set aside, older items and system notices until you dismiss them.

## Anymouse

The Anymouse button sends P9's makers an idea, a bug report or a gripe. Without a GitHub token it opens a prefilled GitHub issue page in your browser. The README shows how to send notes straight from the app.

## Persistence and Stop All

Closing the window keeps chats and terminals running. The red session button switches P9 to "dies with the app", or runs **Stop All**, which stops every chat, button run and P9 terminal. The README has a table of what stops what.

## Settings

The gear opens Settings. Each row has an **i**: hover it for what the row does, click it to open its part of this guide.

- **P9 docs on GitHub**, **Anymouse** and **Setup**, at the top: this guide, [Anymouse](#anymouse) and the [first-start](#first-start) window again.
- **Zoom** makes everything in the window bigger or smaller. Ctrl = and Ctrl - do the same; Ctrl 0 resets.
- **Your name** is what the landing page greets you with.
- **Start in my last focus mode** skips the landing page when P9 opens.
- **Close the chat window on send** closes a chat opened from a card once your message is sent.
- **Focus modes**, **Pets**, **Agent lock** and **File protection**: see [Focus modes](#focus-modes), [Pets](#pets), [Agent lock](#agent-lock) and [File protection](#file-protection).

### Updates

**Check for updates** opens the newest P9 release on GitHub. If its number is higher than yours, the README's Update section says how to install it. Your workspace and settings stay.

### Maintenance

For when P9 misbehaves. Each button is also in the command palette (Ctrl K).

- **Reload window** loads the window again. Chats keep running in the background service; text you have not sent is lost.
- **Refresh Mission** reads Mission Control's settings, buttons and space again now, instead of at the next check.
- **Restart daemon** restarts P9's background service and waits until the new one answers. Running chats, scripts and terminals stop.
- **Repair daemon service** sets the background service up again and starts it. On Windows it runs the installer's own setup step: use it when P9 says its task is missing or out of date. On Linux it enables the `p9-foundation` unit again. Running chats, scripts and terminals stop.
- **Rebuild + reload** shows only when P9 runs from a source checkout. It runs `pnpm build`, then reloads the window with the new build.
