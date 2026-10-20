const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('probe', {
  call: (...args) => ipcRenderer.invoke('p9:get-status', ...args),
  sandboxed: process.sandboxed,
});
