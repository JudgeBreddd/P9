const { contextBridge, ipcRenderer } = require('electron');

// The Dev Focus cards overlay (p9://cards/): what to draw, and which card was clicked. Main checks every sender.
contextBridge.exposeInMainWorld('p9cards', Object.freeze({
  ready: () => ipcRenderer.invoke('p9cards:ready'),
  size: height => ipcRenderer.send('p9cards:size', height),
  act: (key, action) => ipcRenderer.send('p9cards:act', { key, action }),
  onList: callback => { ipcRenderer.on('p9cards:list', (_event, items) => callback(items)); },
  onLook: callback => { ipcRenderer.on('p9cards:look', (_event, look) => callback(look)); },
}));
