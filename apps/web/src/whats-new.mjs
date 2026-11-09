// D13: what the window lists after an update, one line per change. The full list is the message of the release's commit
// (tag v<version>), which the popup links to. A release updates this list with package.json's version
// (test/whats-new.test.mjs fails while the two differ); for another version the popup shows only the link.
export const WHATS_NEW = {
  version: '0.1.9-beta.2',
  changes: [
    'A new look, Event Horizon Azure, is in the Look picker; the default look is unchanged.',
    'Dev Focus colours JSON, CSS and shell files.',
    'In Dev Focus the editor turns light with a light look.',
    'Two quick saves of the connection settings can no longer leave the file half-written.',
  ],
};
