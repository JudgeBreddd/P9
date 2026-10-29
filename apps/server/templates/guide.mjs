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
3. Add each section with add_section, then its items with add_button and set_section_items.
4. Check the space with validate_space.

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

## What runs, and when

- A button runs only when you click it.
- A data tile or a card runs its script only after you answer Allow on it.
- Links open http and https addresses only.
`;

// The first message of a build chat: a fixed line, then the guide.
export const BUILD_PROMPT = 'I want to set up Mission Control in P9. Follow this guide: ask me what I want on it first, then build it with P9\'s Mission tools.\n\n' + GUIDE;
