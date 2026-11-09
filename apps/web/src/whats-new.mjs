// D13: what the window lists after an update, one line per change. The full list is the message of the release's commit
// (tag v<version>), which the popup links to. A release updates this list with package.json's version
// (test/whats-new.test.mjs fails while the two differ); for another version the popup shows only the link.
export const WHATS_NEW = {
  version: '0.1.9-beta.1',
  changes: [
    'Mode, Model and Effort are pills in the message bar; Settings sets the default model and effort.',
    'A downloaded update asks first: Update now reopens P9, Later installs it at the next open.',
    'The Artifacts list shows one row per title with its versions, and a Pin stays where you put it.',
    "On Windows and Linux P9's top row is the title bar, with the window buttons at its right end.",
    'On Windows a bare bash or sh opens Git Bash, never the WSL launcher.',
  ],
};
