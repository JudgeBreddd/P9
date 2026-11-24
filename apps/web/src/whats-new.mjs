// D13: what the window lists after an update, one line per change. The full list is the message of the release's commit
// (tag v<version>), which the popup links to. A release updates this list with package.json's version
// (test/whats-new.test.mjs fails while the two differ); for another version the popup shows only the link.
export const WHATS_NEW = {
  version: '0.1.9-beta.14',
  changes: [
    "Remote: the machine menu, Settings and Dev Focus open at once, even over a slow or busy link.",
    "Remote: Dev Focus keeps its open files and file tree through a remote switch or a restart.",
    "Remote: the chat list draws before any chat's history, and screenshots load when they come into view.",
    "Back after time away, chats jump to where they are now instead of replaying everything missed.",
    "A click on a chat row opens it even while the list is redrawing.",
    "Phone: a turn nobody typed in (started by a script or hook) still shows Working and Stop.",
    "A steer sent just as a turn starts joins that turn instead of being refused.",
  ],
};
