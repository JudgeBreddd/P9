// D13: what the window lists after an update, one line per change. The full list is the message of the release's commit
// (tag v<version>), which the popup links to. A release updates this list with package.json's version
// (test/whats-new.test.mjs fails while the two differ); for another version the popup shows only the link.
export const WHATS_NEW = {
  version: '0.1.9-beta.3',
  changes: [
    'Chats live in a left panel with projects, chats and search; it folds to a strip of what is running or waiting.',
    'The chat tab row is gone; the panel is the switcher, and Ctrl Tab flips to the previous chat.',
    'New project sets up a project; each project has its own page with its chats and files.',
    'A chat in a project reads the files added to that project without asking; everything else is still asked.',
    'Code blocks in a chat are coloured by language, on the desktop and the phone.',
    'On the phone, chats are listed by project.',
  ],
};
