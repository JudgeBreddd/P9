// D13: what the window lists after an update, one line per change. The full list is the message of the release's commit
// (tag v<version>), which the popup links to. A release updates this list with package.json's version
// (test/whats-new.test.mjs fails while the two differ); for another version the popup shows only the link.
export const WHATS_NEW = {
  version: '0.1.9-beta.6',
  changes: [
    "Delegate: a chat's agent can start worker chats, message, read and stop them. Off until you turn it on in Settings.",
    "Workers show under the chat that started them; stopping the chat stops its workers.",
    "Peer help: a chat you mark Open to questions answers other chats in its project, read-only.",
    "Notes: a chat's agent can pass information to another chat without starting a turn.",
    "A reply the agent sends twice is shown once.",
    "Provider profiles for Claude chats, set in Settings and picked in the New chat menu.",
    "Model lists come from the agent itself, and the default is named.",
    "New chat starts in one click and shows its folder.",
    "A usage window with a pace mark; Codex plan figures are read from Codex.",
    "The guide explains Delegate, its workers and its settings.",
  ],
};
