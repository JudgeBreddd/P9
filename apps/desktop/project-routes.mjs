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
    removeProjectFile: ({ id, name, ...rest }) => uuid(id) && typeof name === 'string' && !Object.keys(rest).length && ['POST', '/projects/' + id + '/files/remove', { name }],
    startedIn: ({ folder, ...rest }) => typeof folder === 'string' && folder.length <= 4096 && !Object.keys(rest).length && ['GET', '/chat/started-in?' + new URLSearchParams({ folder })],
    moveChat: ({ id, project, ...rest }) => uuid(id) && (project === null || uuid(project)) && !Object.keys(rest).length && ['POST', `/chat/${id}/project`, { project }],
    renameChat: ({ id, title, ...rest }) => uuid(id) && typeof title === 'string' && !Object.keys(rest).length && ['POST', `/chat/${id}/rename`, { title }],
    archiveChat: ({ id, archived, ...rest }) => uuid(id) && typeof archived === 'boolean' && !Object.keys(rest).length && ['POST', `/chat/${id}/archive`, { archived }],
    deleteChat: ({ id, empty, ...rest }) => uuid(id) && (empty === undefined || empty === true) && !Object.keys(rest).length && ['POST', `/chat/${id}/delete`, empty ? { empty } : {}],
  };
};
