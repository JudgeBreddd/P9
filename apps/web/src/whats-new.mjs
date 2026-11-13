// D13: what the window lists after an update, one line per change. The full list is the message of the release's commit
// (tag v<version>), which the popup links to. A release updates this list with package.json's version
// (test/whats-new.test.mjs fails while the two differ); for another version the popup shows only the link.
export const WHATS_NEW = {
  version: '0.1.9-beta.8',
  changes: [
    "The sprint card lies over the chat: the chat text stays in the middle and no longer moves aside.",
    "The sprint card has a Files button that opens the sprint's plan, instructions and rules.",
    "Sidebar: a chat's workers open below it, and Show workers shows all of them.",
    "A sprint can start from a repository address, and each project names its own setup command.",
    "Worker folders have a Clean up button. It says plainly that git-ignored files go with a folder.",
    "A worker's notes can be read in its chat, and it is told where they are again after a compaction.",
    "Agents can archive a chat they started. The limit on workers also holds for a stopped worker.",
    "Delegate refusals say what was wrong and what to do next.",
    "Settings explains Delegate and has a Sprints section.",
  ],
};
