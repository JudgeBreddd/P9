// D13: what the window lists after an update, one line per change. The full list is the message of the release's commit
// (tag v<version>), which the popup links to. A release updates this list with package.json's version
// (test/whats-new.test.mjs fails while the two differ); for another version the popup shows only the link.
export const WHATS_NEW = {
  version: '0.1.9-beta.7',
  changes: [
    "Sprint files: a sprint's plan, rules, role files and notes live in its folder and are edited on the project page.",
    "Worker folders: each sprint worker gets its own branch and folder, with a setup command and a safe clean-up.",
    "Delegated chats show their task and review state.",
    "A chat's card shows its sprint row.",
    "The update popup never forces an update.",
    "Phone: a message sent while the agent is working is queued instead of staying in the box.",
    "Fixes: the Open on setting is saved, and the doctor no longer shows a stale library line.",
    "The guide covers peer help's asking side, worker folders, a task on a worker and the sprint card.",
  ],
};
