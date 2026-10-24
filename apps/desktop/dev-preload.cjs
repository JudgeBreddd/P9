const { contextBridge, ipcRenderer } = require('electron');

// Dev Focus page (p9://dev/): the editor's guarded save and "Open in VS Code"; main checks every sender.
contextBridge.exposeInMainWorld('p9dev', Object.freeze({
  config: () => ipcRenderer.invoke('p9dev:config'),
  save: (path, hash, content) => ipcRenderer.invoke('p9dev:save', { path, hash, content }),
  create: (path, content) => ipcRenderer.invoke('p9dev:create', { path, content }),
  hostPath: (path, kind) => ipcRenderer.invoke('p9dev:host-path', path, kind),
  openInCode: (name, line, reason) => ipcRenderer.invoke('p9dev:open-in-code', { name, line, reason }),
  openFolder: () => ipcRenderer.invoke('p9dev:open-folder'),
  onLook: (callback) => { ipcRenderer.on('p9dev:look', (_event, look) => callback(look)); },
  // p9 edit / p9 diff: the page says when it can open files, then main sends each checked request.
  onOpen: (callback) => { ipcRenderer.on('p9dev:open', (_event, request) => callback(request)); return ipcRenderer.invoke('p9dev:open-ready'); },
}));
