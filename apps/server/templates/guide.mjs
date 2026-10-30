// The shipped Mission guide (threat model row 72): shown on the onboarding card's "Build it yourself" page, and the whole first
// message of a "Have Claude/Codex build it" chat. Nothing from a request or a file is ever added to it.
export const GUIDE = `# Build your Mission Control space

Mission Control is your control room in P9. It shows one space: a list of sections in order. Each section has a heading, a line of text, and the things you want in reach: buttons that run your scripts, live numbers, log views, notes, folders and links.

## Decide what goes on it

1. What you check every day: services, backups, an inbox, a project's state.
2. What you run by hand: scripts and chores you want one click away.
3. Where you go: dashboards, docs and pages you open often.

Each answer is a section.

## Build it with an agent

In a P9 chat, Claude and Codex have P9's Mission tools. The agent should:

1. Call describe_mission to read the format and an example of every item.
2. Ask you what you want, one section at a time.
3. Add each section with add_section.
4. For a built-in panel (Waiting on you, Usage, Apps and pages or Notifications), call update_section with widget.
5. To show a button you already have in the registry, call update_section with refs and the button's ID. Never copy its command into a new button.
6. Add new buttons with add_button. Add data tiles, log views, folders, links and checklists with set_section_items.
7. For a custom card, write a workspace .html file with its own file tool (you approve the write). Then add it with set_section_items cards. The .html file stays in the workspace even if a scratch space is dropped.
8. When it cannot find a folder, file or command, ask you in the chat. Never skip it.
9. Check the space with validate_space.
10. At the end, list anything it did not build.

To try changes without touching the space you use, the agent passes a scratch space name, such as "draft", to each write tool. Pick that name in Mission's space picker to see it, and pick Main to go back.

An agent can write your space only while File protection is off and the agent lock is off. Both are switches in Settings. Turn File protection back on once the build is done.

## Build it yourself

- Start from a template. It adds sections you can rename and fill.
- Rename a section or change its icon with Edit on the Mission page.
- For buttons, data tiles and log views, edit the space file (JSON) in any editor. describe_mission shows every field with an example.

## Your own card

A card is your own HTML file in the workspace, shown in a section with one script's JSON. It runs in a sandbox with no
network and no access to P9, so put its styles and scripts inline. Add it to a section as
{ "id": "inbox-card", "title": "Inbox", "html": "cards/inbox.html", "script": "count-inbox" }. A small card:

    <!doctype html>
    <style>body { font: 14px system-ui; margin: 0; color: CanvasText } b { font-size: 28px }</style>
    <p><b id="count">…</b> notes in the inbox</p>
    <script>
      addEventListener('p9data', (event) => { document.getElementById('count').textContent = event.detail.count; });
    </script>

Here the script count-inbox prints {"count": 12}.
If the card's own code stops with an error, the card shows only that error, not what it drew before it.

## What runs, and when

- A button runs only when you click it.
- A data tile or a card runs its script only after you answer Allow on it.
- Links open http and https addresses. A link to another app (an address whose scheme is in page_schemes, such as obsidian://) shows the address first and opens only when you click Open.
`;

// The first message of a build chat: a fixed line, then the guide.
// From + Add (finding 4): the build goes into a new scratch space. The name passed spaceName, so it holds no words or path parts.
export const buildPrompt = (space) => (space === undefined ? BUILD_PROMPT
  : BUILD_PROMPT + '\n\nBuild it as a new scratch space named ' + space + ': pass space "' + space + '" on every Mission tool call that writes. Leave Main and every other space as they are.');
export const BUILD_PROMPT = 'I want to set up Mission Control in P9. Follow this guide: ask me what I want on it first, then build it with P9\'s Mission tools.\n\n' + GUIDE;
