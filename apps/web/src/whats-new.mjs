// D13: what the window lists after an update, one line per change. The full list is the message of the release's commit
// (tag v<version>), which the popup links to. A release updates this list with package.json's version
// (test/whats-new.test.mjs fails while the two differ); for another version the popup shows only the link.
export const WHATS_NEW = {
  version: '0.1.9-beta.4',
  changes: [
    'The New project window fits a long folder path; Create no longer runs off the edge.',
    'Moving, renaming or archiving a chat no longer changes when it was last used.',
    'New project names the chats it offers to add, offers only chats you can see, and says if one could not be added.',
    'A project row in the panel counts only the chats it lists.',
  ],
};
