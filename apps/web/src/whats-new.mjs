// D13: what the window lists after an update, one line per change. The full list is the message of the release's commit
// (tag v<version>), which the popup links to. A release updates this list with package.json's version
// (test/whats-new.test.mjs fails while the two differ); for another version the popup shows only the link.
export const WHATS_NEW = {
  version: '0.1.8',
  changes: [
    'The AppImage starts on a fresh Ubuntu user with nothing installed beyond fuse3.',
    'The desktop asks before updating a server on another version, and names both versions.',
    'Settings > Maintenance has a Nightly builds switch (off by default) for pre-releases.',
    'The Mission Space menu lists a space made on the phone as soon as it opens.',
    'A dev P9 runs beside the daily one on Linux; its update, restart and stop leave the daily one alone.',
  ],
};
