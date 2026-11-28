// D13: what the window lists after an update, one line per change. The full list is the message of the release's commit
// (tag v<version>), which the popup links to. A release updates this list with package.json's version
// (test/whats-new.test.mjs fails while the two differ); for another version the popup shows only the link.
export const WHATS_NEW = {
  version: '0.1.9-beta.18',
  changes: [
    "Dev Focus: closing the last file tab gives the chat the editor space when the chat is beside the file list.",
    "Dev Focus: beside the chat with no tabs open, the divider sizes the file list; opening a file restores the split.",
    "Dev Focus: in that layout the command palette fits inside the file pane.",
    "Phone: a file closed or replaced while the editor loads it no longer shows Loaded.",
  ],
};
