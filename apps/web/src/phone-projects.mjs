// N1 point 12: the phone's chat list groups by project, as the desktop's left panel does (panel.mjs): one section per
// project in the order they were made, then Chats for the rest. A chat's project is the daemon's id (GET /chat's
// project), never its folder; an id not in the list, or an archived project, puts the chat in Chats. Archived chats are
// not listed. phone.ts keeps its rows and section look; this only decides the sections.
let projects = [];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// GET /projects on the phone's own listener. An older daemon without the route leaves the list flat, as before.
export const loadPhoneProjects = (request) => request('/projects').then((r) => { projects = (r.projects ?? []).filter((p) => !p.archived); }, () => { projects = []; });
// listed: which chats the list shows at all; section(label, items): phone.ts's heading and rows, '' when items is empty.
export function phoneSections(conversations, listed, section) {
  const shown = conversations.filter((c) => !c.archived && listed(c)), ids = new Set(projects.map((p) => p.id));
  return projects.map((p) => section(esc(p.name), shown.filter((c) => c.project === p.id))).join('')
    + section('Chats', shown.filter((c) => !ids.has(c.project)));
}
