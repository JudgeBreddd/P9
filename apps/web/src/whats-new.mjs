// D13: what the window lists after an update, one line per change. The full list is the message of the release's commit
// (tag v<version>), which the popup links to. A release updates this list with package.json's version
// (test/whats-new.test.mjs fails while the two differ); for another version the popup shows only the link.
export const WHATS_NEW = {
  version: '0.1.9-beta.15',
  changes: [
    "Desktop chat: select part of a reply, or press its Quote button, to quote it with a comment in your next message.",
    "Desktop chat box: Up in an empty box brings back the prompts you sent, and Down goes forward again.",
    "Chat box: a big paste attaches as pasted.txt instead of filling the box; on desktop, Ctrl Shift V pastes it as text.",
    "Desktop chat: a queued message can be edited in place before it goes.",
    "Desktop chat: when the agent sets a goal, it shows as a line above the message box.",
    "Desktop: queued messages are kept by P9's background service and keep their attachments until they send.",
    "Usage: Tokens and Cost tabs on desktop and phone (Settings > General can hide them); the phone gets Limits too.",
    "Usage: each limit shows its projected % at reset when there is a reading; P9 saves plan readings every 10 minutes.",
    "The window starts with less code: the project page loads when the window is idle or when first opened.",
  ],
};
