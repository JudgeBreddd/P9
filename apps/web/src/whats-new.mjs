// D13: what the window lists after an update, one line per change. The full list is the message of the release's commit
// (tag v<version>), which the popup links to. A release updates this list with package.json's version
// (test/whats-new.test.mjs fails while the two differ); for another version the popup shows only the link.
export const WHATS_NEW = {
  version: '0.1.6',
  changes: [
    'Dev Focus, Send to remote and Codex sign-in work on a remote.',
    'Connecting to a remote shows how it is going instead of a blank window.',
    'Settings lists your remotes and has an Add remote button. None are built in.',
    'A remote updates itself when you connect. One older than 0.1.6 shows the steps to update it once by hand.',
    'The Linux AppImage brings its own tmux, so terminals work on a machine without it.',
    'Error messages show in full and open with what went wrong.',
    'Pets stay beside the chat box: panels, split view and the editor no longer cover them.',
    'Settings is wider, with its sections side by side.',
    'Dev Focus: the terminal floats above every panel, Markdown has colors, and the split no longer flashes white.',
    'Mission starts as a blank slate you fill with widgets.',
    'Logging in again and the setup wizard no longer get stuck.',
    'Save in Chat Focus\'s editor reaches the file, on this computer and on a remote.',
  ],
};
