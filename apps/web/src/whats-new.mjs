// D13: what the window lists after an update, one line per change. The full list is the message of the release's commit
// (tag v<version>), which the popup links to. A release updates this list with package.json's version
// (test/whats-new.test.mjs fails while the two differ); for another version the popup shows only the link.
export const WHATS_NEW = {
  version: '0.1.9-beta.13',
  changes: [
    "Chat Changes tab: shell-made edits show too (in a git folder, worktree or submodule), with line counts and edit counts.",
    "Sprint View: each worker row opens Details (branch, head, files, review, notes) and can steer, stop or restart it.",
    "Sprint View: each worker row shows its model and effort; Clear on a closed sprint also clears its lead chat.",
    "Mission: a template preview leads into its build, and a space added while its chat failed is kept and retried.",
    "Mission: a button's window shows its last run; a checklist write refreshes its section; long lists scroll in their tile.",
    "Phone: Send stops a running turn only when the box was empty at the tap.",
    "Settings: a Default model or effort row shows its save once it answers, even when redrawn meanwhile.",
  ],
};
