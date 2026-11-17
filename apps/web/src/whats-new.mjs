// D13: what the window lists after an update, one line per change. The full list is the message of the release's commit
// (tag v<version>), which the popup links to. A release updates this list with package.json's version
// (test/whats-new.test.mjs fails while the two differ); for another version the popup shows only the link.
export const WHATS_NEW = {
  version: '0.1.9-beta.10',
  changes: [
    "Sprints: each sprint has a Setup page and a page showing where it stands, with Start, Pause, Resume and Close.",
    "Sprints: Start gives each chat its role row, scripts run only as approved, and Clean up removes landed folders.",
    "Top-right notices show once like any other notification, then live in the bell.",
    "Steer waits for the next tool step; Queue waits for turn end; Interrupt stops the turn and sends.",
    "The message box stays on screen, waiting messages fold into one queued strip, and a worker's report folds away.",
    "Each chat row shows what it is doing: a spinning ring, a green circle or a red hand.",
    "Scheduled prompts: the daemon sends a prompt once or on a repeat, and keeps it across a restart.",
    "Agents can rename, compact and close chats, list providers, and answer a worker's approval.",
    "A model or mode picked mid-turn waits for the turn to end, and New chats start in also covers agent-opened chats.",
    "A name you gave a chat wins over the agent's title, and a helper agent's model never becomes the chat's.",
    "Phone: a refused send says why, New chat offers provider profiles, and the composer stays on screen.",
    "P9 opens in Chat or the first enabled view; the landing page is gone, and an early reload keeps the app open.",
  ],
};
