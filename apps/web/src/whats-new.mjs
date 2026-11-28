// D13: what the window lists after an update, one line per change. The full list is the message of the release's commit
// (tag v<version>), which the popup links to. A release updates this list with package.json's version
// (test/whats-new.test.mjs fails while the two differ); for another version the popup shows only the link.
export const WHATS_NEW = {
  version: '0.1.9-beta.17',
  changes: [
    "Queued messages from you, P9 and other chats run in separate turns, each in its own sender's mode.",
    "Phone: As set sends the mode shown when you tap Send, even if a turn ends before the picker redraws.",
    "Agent lock: a prompt goes only once read-only mode is confirmed; a message that would steer waits for the turn to end.",
    "Desktop chat: between turns, Set again restores an active goal after a restart, and Clear removes it.",
    "Worker window: item names and replies wrap; Details has Open chat and shows tokens used and context.",
    "Phone: an unanswered send stays on its own card with Send again and Take back, apart from your next draft.",
    "Phone: files from an accepted send no longer come back in the message box after a reload.",
    "Phone: Chats opens while agent details load, and Back stays available while a chat loads or fails to.",
    "Dev Focus on this computer keeps its open files and file tree when P9 restarts.",
    "Remote: a window opened before the remote answered fills in place instead of reloading.",
    "Desktop chat: background agents' tool rows no longer split a reply into separate blocks.",
    "Desktop chat: when one refresh sees several turns end in a chat, it shows one finished notice.",
    "P9 stops an agent that leaves a mode, model or effort change unanswered for 30 seconds.",
    "Settings: Unrestricted reads a change back after a lost reply, and a revision check guards newer changes.",
    "Sprint Close tells the chats that sent messages to held workers which ones were not delivered.",
    "Sprints: the third-fix notice names larger model families when it knows the worker's model.",
  ],
};
