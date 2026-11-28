// D13: what the window lists after an update, one line per change. The full list is the message of the release's commit
// (tag v<version>), which the popup links to. A release updates this list with package.json's version
// (test/whats-new.test.mjs fails while the two differ); for another version the popup shows only the link.
export const WHATS_NEW = {
  version: '0.1.9-beta.18',
  changes: [
    "Dev Focus: with the chat on and no file open, the chat sits right beside the file list, with no empty editor area between.",
    "Dev Focus: opening a file brings the editor back at its earlier width; the divider sizes the file list while no file is open.",
    "Phone: a file closed or replaced while it was loading no longer shows Loaded.",
  ],
};
