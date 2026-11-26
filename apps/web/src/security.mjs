import { modes, LOOSE, LOOSE_SAID, AUTO } from './helpers.mjs';

// Settings > Security settings (c18, threat model row 66), on the desktop (controller.mjs) and the phone (phone.ts).
// One toggle per restriction, and an Unrestricted mode toggle that turns them all off, so nobody hunts for them.
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
  // Review 3 L5: "Open, don't ask again" in the link question, shown and undone here (desktop only; the phone never asks).
  links: ['Ask before opening agent links', 'A link in an agent reply opens in your browser only after a question showing its whole address, on this computer.',
    'On: a link in an agent reply asks first, showing its whole address. Off: it opens on a click. Turning Unrestricted mode off turns this back on.'],
  unknown: 'Unknown: the daemon did not answer.',
  noModes: 'Waiting for the agents\' modes from P9; open Settings again in a moment.',
  noLoose: 'Unavailable: no agent P9 lists has a mode that acts without asking.', // review 14: the catalog answered with none
};
// The mode Unrestricted mode starts new chats in, per agent: its tier-4 mode (fillAgents).
export const LOOSEST = {};
// CAT-2: GET /agents (the catalog, apps/server/agents.mjs publicAgents) is the only list of each agent's modes: its answer
// replaces helpers' modes, AUTO and LOOSE and this LOOSEST, so a renamed or new mode is offered, warns and starts as the
// catalog says. Desktop (chat-view.mjs) and phone (phone.ts). ponytail: LOOSE is keyed by mode name, so a name two agents
// share warns for both.
// Review 13: ours says the modes came from the daemon in use (its GET /agents answered, or the desktop's own catalog while
// that daemon is this computer's). Only then may they change what that daemon enforces (Unrestricted, the warnings):
// a desktop on a remote starts from this computer's catalog, which the remote's may not match.
export const CATALOG = { ours: false };
export const fillAgents = (agents, ours = true) => {
  CATALOG.ours = ours;
  for (const t of [modes, AUTO, LOOSE, LOOSEST]) for (const k in t) delete t[k];
  for (const a of agents) {
    const all = a.modes ?? []; // an older server's GET /agents names none: no modes offered, nothing thrown
    modes[a.id] = all.map((m) => m.name);
    if (a.auto) AUTO[a.id] = a.auto;
    for (const m of all) if (m.tier === 4) { LOOSEST[a.id] = m.name;
      LOOSE[m.name] ??= LOOSE_SAID[m.name] ?? (a.short || a.name) + ' acts without asking first: it can run any command and change any file it can reach.'; }
  }
};
// The warnings are on while any loosened mode still asks ("Don't show again" not set for it).
export const warnsLoose = () => Object.keys(LOOSE).some((m) => !localStorage.getItem('p9-mode-ok:' + m));
export const setWarnsLoose = (on) => Object.keys(LOOSE).forEach((m) => on ? localStorage.removeItem('p9-mode-ok:' + m) : localStorage.setItem('p9-mode-ok:' + m, '1'));
// startKey: where this device keeps the mode a new chat starts in (the desktop's p9-mode-default:, the phone's p9-mode:).
// Off removes only the loosest mode, so a mode picked by hand stays.
export const setStarts = (on, startKey) => Object.entries(LOOSEST).forEach(([a, m]) => on ? localStorage.setItem(startKey + a, m)
  : localStorage.getItem(startKey + a) === m && localStorage.removeItem(startKey + a));
// Review 12: Unrestricted mode switches new chats to each agent's loosest mode, so with none known (GET /agents not read, or
// it lists none) the switch is off and cannot be turned on: it never turns the lock and File protection off by itself.
// Review 13: known means from the daemon in use (CATALOG.ours). The warning switch is disabled by the same test.
// Desktop (settings-view.mjs) and phone (phone.ts); each checks freeLocked again before every change it commits.
export const modesKnown = () => CATALOG.ours && Object.keys(LOOSEST).length > 0;
export const freeLocked = (lock, protect) => lock === null || protect === null || !modesKnown();
// Why the warnings and Unrestricted are disabled with no loosened mode known: still loading, or (the daemon in use answered)
// none listed. Review 14.
// Review 14/15: the mode a prompt carries. Once the daemon in use has listed its modes, one it does not list (retired by an
// update, kept by replay for display) is left out, so the chat stays in its current mode instead of the prompt being refused.
// Before that (a remote's GET /agents not answered yet) the pick goes as is: this computer's catalog cannot judge it.
export const sentMode = (agent, mode) => (!CATALOG.ours || modes[agent]?.includes(mode)) && mode || undefined;
export const modesNote = () => CATALOG.ours ? SECURITY.noLoose : SECURITY.noModes;
// Review 14: Unrestricted mode as one change of the daemon's two settings, File protection then the agent lock (desktop
// settings-view.mjs, phone phone.ts). write(key, on, rev) makes one change and answers the daemon's { on, rev } (the
// setting as it now is), or { error } when it was refused or not answered; read(key) answers the same without a change.
// A refusal, a "keep it" answer (on comes back unchanged), or (turning on) no loosened mode known once the writes are done
// (the catalog can land meanwhile) puts back every setting this changed, newest first, and names any it could not put back.
// ok: both are as asked, so the device may set its own part.
// O267b: a write with no { on } may still have been made (its reply lost on the way back), so the setting is read: as asked,
// it counts as done; not read, it shows unknown (null), never the old value. A put-back sends the rev of the change it
// undoes, so a newer change (another device, another switch) stays; an older daemon gives no rev, and its put-back is plain.
// ponytail: a write whose answer and read are both lost is not put back (its state shows unknown); set it again by hand.
export async function changeFree(on, state, write, read) {
  const now = { ...state }, done = [], names = { protect: SECURITY.protect[0], lock: SECURITY.lock[0] };
  const known = (r) => typeof r?.on === 'boolean';
  let note = null;
  for (const [key, want] of [['protect', !on], ...(on ? [['lock', false]] : [])]) {
    if (now[key] === want) continue;
    const w = await write(key, want), r = known(w) ? w : await read(key);
    now[key] = known(r) ? r.on : null;
    if (now[key] === null) { note = 'Stopped: P9 did not say whether ' + names[key] + ' changed, so it shows as unknown.'; break; }
    if (now[key] !== want) { note = known(w) ? '' : 'Not changed: ' + (w?.error || 'P9 did not answer') + '.'; break; }
    done.push([key, r.rev]);
  }
  if (note === null && on && !modesKnown()) note = 'Not changed: the agents\' modes changed meanwhile.';
  if (note === null) return { ok: true, state: now, note: '' };
  const lost = [];
  for (const [key, rev] of done.reverse()) {
    const w = await write(key, state[key], rev), r = known(w) ? w : await read(key);
    now[key] = known(r) ? r.on : null;
    if (now[key] !== state[key]) lost.push(names[key]);
  }
  if (lost.length) note = (note ? note + ' ' : '') + 'Could not put back ' + lost.join(' and ') + ': set ' + (lost.length > 1 ? 'them' : 'it') + ' again above.';
  return { ok: false, state: now, note };
}
// Before GET /agents answers there are no loosened modes to check, so it reads off.
export const unrestricted = (lock, protect, startKey) => lock === false && protect === false && modesKnown() && !warnsLoose()
  && Object.entries(LOOSEST).every(([a, m]) => localStorage.getItem(startKey + a) === m);
