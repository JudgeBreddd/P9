// N1 point 12: the phone's chat list groups by project, as the desktop's left panel does (panel.mjs): one section per
// project in the order they were made, then Chats for the rest. A chat's project is the daemon's id (GET /chat's
// project), never its folder; an id not in the list, or an archived project, puts the chat in Chats. Archived chats are
// not listed. phone.ts keeps its rows and section look; this only decides the sections.
let projects = [];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// GET /projects on the phone's own listener. An older daemon without the route leaves the list flat, as before.
export const loadPhoneProjects = (request) => request('/projects').then((r) => { projects = (r.projects ?? []).filter((p) => !p.archived); }, () => { projects = []; });
// listed: which chats the list shows at all; section(label, items, project): phone.ts's heading and rows. A project's
// section is drawn with no chats too (O210: its heading opens its sprints, and a prepared sprint may have no chat yet);
// Chats is '' when it has none.
export function phoneSections(conversations, listed, section) {
  const shown = conversations.filter((c) => !c.archived && listed(c)), ids = new Set(projects.map((p) => p.id));
  return projects.map((p) => section(esc(p.name), shown.filter((c) => c.project === p.id), p.id)).join('')
    + section('Chats', shown.filter((c) => !ids.has(c.project)));
}
export const projectName = (id) => projects.find((p) => p.id === id)?.name ?? '';
// O210 (plan A): a sprint's state on the phone's project sheet, and what its one button asks for. Start and Close stay
// presses on the desktop (SECURITY.md § Start sprint, § Close sprint): the phone asks an agent of the project, which asks
// the user in the chat (start_sprint, close_sprint). A closed sprint asks for nothing.
export const sprintAsk = (s) => s.closed ? null : s.prep || !s.started ? 'start' : 'close';
export const askText = (s, ask) => `${ask === 'start' ? 'Start' : 'Close'} the sprint "${s.title}" (sprint ${s.lead}) with ${ask}_sprint.`;
// The chat that asks: the project's newest chat that is no sprint's (no parent, not a lead), else none (phone.ts makes one).
export function askingChat(conversations, project, sprints) {
  const leads = new Set(sprints.map((s) => s.lead));
  return conversations.filter((c) => c.project === project && !c.archived && !c.parent && !leads.has(c.id))
    .sort((a, b) => (b.used ?? b.created ?? 0) - (a.used ?? a.created ?? 0))[0]?.id ?? null;
}
