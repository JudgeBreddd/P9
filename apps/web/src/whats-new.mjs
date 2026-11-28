// D13: what the window lists after an update, one line per change. The full list is the message of the release's commit
// (tag v<version>), which the popup links to. A release updates this list with package.json's version
// (test/whats-new.test.mjs fails while the two differ); for another version the popup shows only the link.
export const WHATS_NEW = {
  version: '0.1.9-beta.17',
  changes: [
    "Your messages run in your own mode: a P9 notice or another chat's message waiting beside yours goes as its own prompt.",
    "Phone: Send uses the mode it shows, even when a turn ends as you tap.",
    "Agent lock: turned on while a message starts or a turn runs, it holds before the next prompt or steer goes.",
    "Goal line: Set again sends a goal the agent lost in a restart back to it; Clear removes the goal.",
    "Worker window: item names get the room, and Details shows tokens used and context.",
    "Phone: a message being sent is kept apart from the box until P9 answers, so a reload or another tab cannot lose it.",
    "Phone: files sent with a message stay gone after a reload, and a message handed back gets its files back too.",
    "Dev Focus on this computer keeps its open files and file tree when P9 restarts.",
    "Remote: a window opened before the remote answered fills in place instead of reloading.",
    "Desktop chat: another agent's command rows no longer cut a reply in two.",
    "One finished notice per turn, even when a waiting message starts the next turn at once.",
    "A setting the agent never answers no longer blocks later messages; P9 gives up on it after 30 s.",
    "Settings: the Unrestricted switch checks a change whose reply was lost, and never undoes another device's newer change.",
    "Sprints: the third-fix notice suggests only models larger than the worker's own.",
  ],
};
