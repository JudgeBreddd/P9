// D13: what the window lists after an update, one line per change. The full list is the message of the release's commit
// (tag v<version>), which the popup links to. A release updates this list with package.json's version
// (test/whats-new.test.mjs fails while the two differ); for another version the popup shows only the link.
export const WHATS_NEW = {
  version: '0.1.7',
  changes: [
    'Long streaming replies no longer slow the rest of P9 down.',
    'A disk or database error during a chat is logged instead of stopping P9.',
    'Pets animate only while one is on screen.',
    'The Dev Focus editor server is stopped properly again on Linux.',
    'Reinstalling over an old P9 no longer skips the Dev Focus editor server.',
    'Installing on a remote stops the P9 running there before replacing it.',
  ],
};
