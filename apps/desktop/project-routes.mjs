// N1 (threat model row N1): the window's project actions, added to main.mjs's chatRoutes (p9:chat). Each names a daemon
// route and passes the body on; the daemon checks every field again (apps/server/projects.mjs). uuid: main.mjs's check.
export const projectRoutes = (uuid) => {
  const body = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
  return {
    projects: (rest) => !Object.keys(rest).length && ['GET', '/projects'],
    project: ({ id, ...rest }) => uuid(id) && !Object.keys(rest).length && ['GET', '/projects/' + id],
    createProject: (rest) => body(rest) && ['POST', '/projects', rest],
    updateProject: ({ id, ...rest }) => uuid(id) && ['POST', '/projects/' + id, rest],
    locateProject: ({ id, folder, ...rest }) => uuid(id) && typeof folder === 'string' && !Object.keys(rest).length && ['POST', '/projects/' + id + '/locate', { folder }],
    deleteProject: ({ id, ...rest }) => uuid(id) && !Object.keys(rest).length && ['POST', '/projects/' + id + '/delete', {}],
    addProjectFile: ({ id, name, data, ...rest }) => uuid(id) && typeof name === 'string' && typeof data === 'string' && !Object.keys(rest).length && ['POST', '/projects/' + id + '/files', { name, data }],
    sprintFile: ({ id, lead, name, text, hash, ...rest }) => uuid(id) && uuid(lead) && typeof name === 'string' && typeof text === 'string' && typeof hash === 'string' && !Object.keys(rest).length && ['POST', '/projects/' + id + '/sprint-file', { lead, name, text, hash }],
    // SECURITY.md § Worker folders, "Who cleans up": a desktop-only daemon route; lead is the sprint's lead chat.
    cleanSprint: ({ lead, ...rest }) => uuid(lead) && !Object.keys(rest).length && ['POST', '/sprints/' + lead + '/clean', {}],
    // SECURITY.md § Start sprint: a sprint to prepare, and the owner's Start press (the approval record of its plan).
    newSprint: ({ id, title, ...rest }) => uuid(id) && typeof title === 'string' && !Object.keys(rest).length && ['POST', '/projects/' + id + '/sprints', { title }],
    // hooks: the SHA-256 of the hooks.json the page showed, so the press approves the scripts the owner saw (SECURITY.md § Sprint scripts).
    startSprint: ({ sprint, hooks, ...rest }) => uuid(sprint) && !Object.keys(rest).length && (hooks === undefined || /^[0-9a-f]{64}$/.test(hooks)) && ['POST', '/sprints/' + sprint + '/start', hooks ? { hooks } : {}],
    // Sprint View: where a started sprint stands (what sprint_status tells an agent).
    sprintStatus: ({ sprint, ...rest }) => uuid(sprint) && !Object.keys(rest).length && ['GET', '/sprints/' + sprint + '/status'],
    // Sprint View's Close sprint button (what close_sprint does for an agent, after asking you).
    closeSprint: ({ sprint, ...rest }) => uuid(sprint) && !Object.keys(rest).length && ['POST', '/sprints/' + sprint + '/close', {}],
    // O164 part (3): the Sprint View's click on a v line (Role: owner), closing the owner's own item. No merge involved.
    ownerDone: ({ sprint, item, ...rest }) => uuid(sprint) && typeof item === 'string' && !Object.keys(rest).length && ['POST', '/sprints/' + sprint + '/owner-done', { item }],
    // SECURITY.md § Sprint scripts, "The library": the owner's saved scripts, and a run of one approved script of a sprint.
    scriptLibrary: ({ sprint, ...rest }) => (sprint === undefined || uuid(sprint)) && !Object.keys(rest).length && ['GET', '/sprint-scripts' + (sprint ? '?sprint=' + sprint : '')],
    allowScripts: ({ on, ...rest }) => typeof on === 'boolean' && !Object.keys(rest).length && ['POST', '/sprint-scripts/allow', { on }],
    approveScripts: ({ sprint, hash, names, ...rest }) => uuid(sprint) && typeof hash === 'string' && (names === undefined || (Array.isArray(names) && names.every((n) => typeof n === 'string'))) && !Object.keys(rest).length && ['POST', '/sprints/' + sprint + '/approve-scripts', { hash, ...(names && { names }) }],
    // sprint: that sprint's hooks.json; left out: the library.
    saveScript: ({ script, sprint, ...rest }) => body(script) && (sprint === undefined || uuid(sprint)) && !Object.keys(rest).length && ['POST', '/sprint-scripts', { save: script, ...(sprint && { sprint }) }],
    removeScript: ({ name, sprint, ...rest }) => typeof name === 'string' && (sprint === undefined || uuid(sprint)) && !Object.keys(rest).length && ['POST', '/sprint-scripts', { remove: name, ...(sprint && { sprint }) }],
    addScript: ({ name, sprint, ...rest }) => typeof name === 'string' && uuid(sprint) && !Object.keys(rest).length && ['POST', '/sprint-scripts', { add: name, sprint }],
    runSprintScript: ({ sprint, name, ...rest }) => uuid(sprint) && typeof name === 'string' && !Object.keys(rest).length && ['POST', '/sprints/' + sprint + '/run-script', { name }],
    // SECURITY.md § Pause sprint: the owner's Pause and Resume on the sprint row.
    pauseSprint: ({ sprint, ...rest }) => uuid(sprint) && !Object.keys(rest).length && ['POST', '/sprints/' + sprint + '/pause', {}],
    resumeSprint: ({ sprint, ...rest }) => uuid(sprint) && !Object.keys(rest).length && ['POST', '/sprints/' + sprint + '/resume', {}],
    // SECURITY.md § Standing merge: the owner's switch on Sprint Setup.
    standingMerge: ({ sprint, on, ...rest }) => uuid(sprint) && typeof on === 'boolean' && !Object.keys(rest).length && ['POST', '/sprints/' + sprint + '/merge', { on }],
    sprintSettings: ({ id, source, setup, ...rest }) => uuid(id) && typeof source === 'string' && typeof setup === 'string' && !Object.keys(rest).length && ['POST', '/projects/' + id + '/sprint-settings', { source, setup }],
    removeProjectFile: ({ id, name, ...rest }) => uuid(id) && typeof name === 'string' && !Object.keys(rest).length && ['POST', '/projects/' + id + '/files/remove', { name }],
    startedIn: ({ folder, ...rest }) => typeof folder === 'string' && folder.length <= 4096 && !Object.keys(rest).length && ['GET', '/chat/started-in?' + new URLSearchParams({ folder })],
    search: ({ q, ...rest }) => typeof q === 'string' && q.length <= 200 && !Object.keys(rest).length && ['GET', '/chat/search?' + new URLSearchParams({ q })], // O200
    moveChat: ({ id, project, ...rest }) => uuid(id) && (project === null || uuid(project)) && !Object.keys(rest).length && ['POST', `/chat/${id}/project`, { project }],
    renameChat: ({ id, title, ...rest }) => uuid(id) && typeof title === 'string' && !Object.keys(rest).length && ['POST', `/chat/${id}/rename`, { title }],
    archiveChat: ({ id, archived, ...rest }) => uuid(id) && typeof archived === 'boolean' && !Object.keys(rest).length && ['POST', `/chat/${id}/archive`, { archived }],
    askableChat: ({ id, on, ...rest }) => uuid(id) && typeof on === 'boolean' && !Object.keys(rest).length && ['POST', `/chat/${id}/askable`, { on }],
    deleteChat: ({ id, empty, ...rest }) => uuid(id) && (empty === undefined || empty === true) && !Object.keys(rest).length && ['POST', `/chat/${id}/delete`, empty ? { empty } : {}],
  };
};
