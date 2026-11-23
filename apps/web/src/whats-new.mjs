// D13: what the window lists after an update, one line per change. The full list is the message of the release's commit
// (tag v<version>), which the popup links to. A release updates this list with package.json's version
// (test/whats-new.test.mjs fails while the two differ); for another version the popup shows only the link.
export const WHATS_NEW = {
  version: '0.1.9-beta.12',
  changes: [
    "Sprints: Close keeps unmerged worker branches as git bundles, cleans landed folders; a closed sprint reads only.",
    "Sprints: a sprint from a folder with no remote lists its change under Folder sprints, even without a status file.",
    "Attach any file to a message with the paperclip, or the phone's +; the agent gets it as a link.",
    "Agents come from one catalog: the setup wizard, chat pickers, sign-in and Usage all read it.",
    "Usage pages show every agent's plan limits, mark stale numbers, and name shared plans.",
    "The chat card's Work Queue names the next item, and each Sprint View worker row shows its tokens used.",
    "Codex runs on codex-acp 2.9.0; Claude's adapter is 0.109.1.",
  ],
};
