import { LOOSE } from './helpers.mjs';

// Settings > Security settings (c18, threat model row 66), on the desktop (controller.mjs) and the phone (phone.ts). Builder,
// 2026-10-27: one toggle per restriction, and an Unrestricted mode toggle that turns them all off, so nobody hunts for them.
// The defaults are unchanged: agent lock off, File protection on, the red warnings on, new chats in the agents' asking modes.
// The lock and protection are the daemon's (one for every device); the warnings and the new-chat mode are this device's
// own storage (rows 25, 25a).
export const SECURITY = {
  lock: ['Agent lock', 'Agents can read and answer, but cannot edit files or run anything that asks permission. Enforced by the daemon.',
    'On: agents in every chat can read and answer but cannot edit files or run anything that asks permission.'],
  protect: ['File protection', 'The editor, here and on your phone, cannot open or change secrets, .env files, _private, .git or P9\'s own files. Turning it off asks first.',
    'On: the editor (Dev Focus, here and on your phone) cannot open secrets, .env files, _private or .git.'],
  protectOff: 'Off: the editor, here and on your phone, can open and change any file, including secrets and .git.',
  warn: ['Warn before Full access and Bypass permissions', 'A red warning before a chat switches to one of them, on this device.',
    'On: picking Codex Full access or Claude Bypass permissions asks first, in red. Off: it never asks on this device.'],
  unrestricted: ['Unrestricted mode', 'Turns all of the above off, and new chats on this device start in Codex Full access and Claude Bypass permissions. Off puts File protection and the warnings back on.',
    'Every restriction above off at once. Turning it off puts the defaults back: File protection on, the warnings on, new chats in the agents\' own modes; the agent lock stays off.'],
  unknown: 'Unknown: the daemon did not answer.',
};
// The mode Unrestricted mode starts new chats in, per agent.
export const LOOSEST = { claude: 'Bypass permissions', codex: 'Full access' };
// The warnings are on while any loosened mode still asks ("Don't show again" not set for it).
export const warnsLoose = () => Object.keys(LOOSE).some((m) => !localStorage.getItem('p9-mode-ok:' + m));
export const setWarnsLoose = (on) => Object.keys(LOOSE).forEach((m) => on ? localStorage.removeItem('p9-mode-ok:' + m) : localStorage.setItem('p9-mode-ok:' + m, '1'));
// startKey: where this device keeps the mode a new chat starts in (the desktop's p9-mode-default:, the phone's p9-mode:).
// Off removes only the loosest mode, so a mode picked by hand stays.
export const setStarts = (on, startKey) => Object.entries(LOOSEST).forEach(([a, m]) => on ? localStorage.setItem(startKey + a, m)
  : localStorage.getItem(startKey + a) === m && localStorage.removeItem(startKey + a));
export const unrestricted = (lock, protect, startKey) => lock === false && protect === false && !warnsLoose()
  && Object.entries(LOOSEST).every(([a, m]) => localStorage.getItem(startKey + a) === m);
