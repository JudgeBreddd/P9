// D13: what the window lists after an update, one line per change. The full list is the message of the release's commit
// (tag v<version>), which the popup links to. A release updates this list with package.json's version
// (test/whats-new.test.mjs fails while the two differ); for another version the popup shows only the link.
export const WHATS_NEW = {
  version: '0.1.9-beta.16',
  changes: [
    "Sprints: a new sprint's lead is told to watch plan usage and hold a worker near a cap; Close pauses its schedules.",
    "Desktop, remote: a send with no answer yet is asked about again with the same ID for up to 10 minutes.",
    "Phone: a message the phone cannot store in its queue stays in the box with a note saying why.",
    "Desktop chat box: Ctrl+S saves its text as a draft, quotes included; Drafts beside the paperclip brings one back.",
    "Desktop chat: selected text shows a small Comment button, so Copy still works; a quote is a small chip you can edit.",
    "Phone chat: quote part of a reply with a comment, as on desktop.",
    "Phone: the chat list and an open chat try again after a failed load and say why.",
    "A short reply no longer shows twice when the agent's connection sends it again.",
    "A tool call shown again after a compaction stays one row instead of coming back as pending.",
    "Dev Focus: the editor's terminal draws its letters at full size (GPU drawing is now off by default).",
    "Desktop: open chats keep their order in the panel after a restart.",
    "Settings: Unrestricted reads the service's own list of modes, and stays off when the service offers none.",
  ],
};
