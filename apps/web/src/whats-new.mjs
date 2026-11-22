// D13: what the window lists after an update, one line per change. The full list is the message of the release's commit
// (tag v<version>), which the popup links to. A release updates this list with package.json's version
// (test/whats-new.test.mjs fails while the two differ); for another version the popup shows only the link.
export const WHATS_NEW = {
  version: '0.1.9-beta.11',
  changes: [
    "Sprints: the Sprint View shows each phase's plan; Setup has a standing-merge switch and marks others' file edits.",
    "Sprints: the Sprint View shows Used, PRs an hour and each worker's next item; sprint scripts can repeat.",
    "Settings: Delegation and Sprints are separate, and Notices picks a note or a message per kind of worker notice.",
    "A scrolled-up desktop chat stays on its message while tool calls and replies arrive.",
    "Codex edits show per file and hunk with line numbers; its commands stream live and show their exit code.",
    "A message from another chat's agent shows under that chat's title, not as You, on desktop and phone.",
    "Dev editor: closing a changed tab asks Save, Don't Save or Cancel, and Revert drops unsaved changes.",
    "Settings > Remote Connect > Devices approves or removes phones; the phone's chat bar names the running model.",
    "11 themes and 4 effects remain; a look saved under a removed one loads as the default.",
  ],
};
