// D13: what the window lists after an update, one line per change. The full list is the message of the release's commit
// (tag v<version>), which the popup links to. A release updates this list with package.json's version
// (test/whats-new.test.mjs fails while the two differ); for another version the popup shows only the link.
export const WHATS_NEW = {
  version: '0.1.9-beta.5',
  changes: [
    "Chats can run Claude Fable 5.2.",
    "A resumed chat keeps its model, mode and effort; a setting it could not restore is shown.",
    "Each New chat menu row starts the model it names; New chat opens on the agent you used last.",
    "An Agent pill in the chat bar picks Claude or Codex, with that agent's saved defaults.",
    "Every dropdown opens as P9's own list, readable in every look.",
    "Open chats keep a stable order in the sidebar.",
    "Deleting a chat removes what it left behind.",
    "Chat Focus's file pane follows an In P9 project.",
    "Project actions stay clear of notification cards.",
    "The phone takes its app files from its own store even right after it was set up or hard-reloaded.",
  ],
};
