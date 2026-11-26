// D13: what the window lists after an update, one line per change. The full list is the message of the release's commit
// (tag v<version>), which the popup links to. A release updates this list with package.json's version
// (test/whats-new.test.mjs fails while the two differ); for another version the popup shows only the link.
export const WHATS_NEW = {
  version: '0.1.9-beta.16',
  changes: [
    "Sprints: the lead watches plan usage and holds only a worker near a cap; closing a sprint pauses its schedules.",
    "Remote: a send still waiting for its answer is asked about again instead of sent twice.",
    "Phone: a message the phone cannot store in its queue stays in the box with a note saying why.",
    "Chat box: Ctrl+S saves its text as a draft; Drafts beside the paperclip brings one back.",
    "Desktop chat: selected text shows a small Comment button, so Copy still works; a quote is a small chip you can edit.",
    "Phone chat: quote part of a reply with a comment, as on desktop.",
    "Phone: the chat list tries again after a failed load and says why.",
    "A short reply no longer shows twice when the agent sends it again after its turn ends.",
    "A tool call shown again after a compaction stays one row instead of coming back as pending.",
    "Dev Focus: the editor's terminal draws its letters at full size.",
    "Desktop: open chats keep their order in the panel after a restart.",
  ],
};
