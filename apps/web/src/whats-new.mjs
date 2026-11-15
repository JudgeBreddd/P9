// D13: what the window lists after an update, one line per change. The full list is the message of the release's commit
// (tag v<version>), which the popup links to. A release updates this list with package.json's version
// (test/whats-new.test.mjs fails while the two differ); for another version the popup shows only the link.
export const WHATS_NEW = {
  version: '0.1.9-beta.9',
  changes: [
    "Phone: each chat keeps its own draft, and a send goes once to the chat on screen or says why not.",
    "Phone: the chat stays put while you read or type, and a model or effort pick holds until you send.",
    "Phone: a cancelled turn leaves no spinner, and the chat list shows what each chat is doing.",
    "Phone: Mission and Files read as text, sheets stay above the keyboard, and attach is one tap.",
    "Phone: chats open faster, typing is lighter, and the first screen loads a third of the script.",
    "Send to remote refuses a folder over 200,000 files in seconds instead of timing out.",
    "Pets load sooner on the landing page and when reopening Settings while remote; the pets list opens faster.",
    "The window does less work while a reply streams and starts with a smaller script.",
    "The daemon uses less CPU answering the window; remote update progress is checked less often after a minute.",
  ],
};
