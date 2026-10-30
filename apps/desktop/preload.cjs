const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('p9', Object.freeze({
  getStatus: () => ipcRenderer.invoke('p9:get-status'),
  usage: () => ipcRenderer.invoke('p9:usage'),
  anymouse: (note) => ipcRenderer.invoke('p9:anymouse', note),
  mission: (action, payload) => ipcRenderer.invoke('p9:mission', action, payload),
  pickPicture: () => ipcRenderer.invoke('p9:pick-picture'),
  agentLogin: (...args) => ipcRenderer.invoke('p9:agent-login', ...args),
  workspaceChange: () => ipcRenderer.invoke('p9:workspace-change'),
  restartService: () => ipcRenderer.invoke('p9:restart-service'),
  repairService: () => ipcRenderer.invoke('p9:repair-service'),
  rebuild: () => ipcRenderer.invoke('p9:rebuild'),
  chat: (action, payload) => ipcRenderer.invoke('p9:chat', action, payload),
  lifecycle: (action, payload) => ipcRenderer.invoke('p9:lifecycle', action, payload),
  devView: (bounds) => ipcRenderer.invoke('p9:dev-view', bounds),
  cards: (cards) => ipcRenderer.invoke('p9:cards', cards),
  onCardAct: (callback) => { ipcRenderer.on('p9:card-act', (_event, act) => callback(act)); },
  look: (look) => ipcRenderer.invoke('p9:look', look),
  getSettings: () => ipcRenderer.invoke('p9:settings'),
  setSettings: (settings) => ipcRenderer.invoke('p9:settings', settings),
  openDocs: (section) => ipcRenderer.invoke('p9:open-docs', ...(section === undefined ? [] : [section])),
  openUpdates: () => ipcRenderer.invoke('p9:open-updates'),
  whatsNew: () => ipcRenderer.invoke('p9:whats-new'),
  updates: (ask) => ipcRenderer.invoke('p9:updates', ...(ask === undefined ? [] : [ask])),
  openPetdex: () => ipcRenderer.invoke('p9:open-petdex'),
  openLink: (href) => ipcRenderer.invoke('p9:open-link', href),
  fileProtection: (...on) => ipcRenderer.invoke('p9:file-protection', ...on),
  listPets: () => ipcRenderer.invoke('p9:pets'),
  loadPet: (name) => ipcRenderer.invoke('p9:pets', name),
  addPets: () => ipcRenderer.invoke('p9:pet-add'),
  importPets: () => ipcRenderer.invoke('p9:pet-import'),
  installPets: text => ipcRenderer.invoke('p9:pet-install', String(text)),
  removePet: (name) => ipcRenderer.invoke('p9:pet-remove', name),
  server: (...host) => ipcRenderer.invoke('p9:server', ...host), // none: mode, remotes and ssh hosts; null: Local; a host: that remote
  remotes: (action, host) => ipcRenderer.invoke('p9:remotes', action, host), // 'add' or 'remove', one host name
  remoteKeep: (yes, remember) => ipcRenderer.invoke('p9:remote-keep', yes, remember), // row I1: Keep P9 running on this remote?
  remoteKeepSetting: (host, choice) => ipcRenderer.invoke('p9:remote-keep-setting', host, choice), // true, false or null (ask)
  remoteState: host => ipcRenderer.invoke('p9:remote-state', host), // 'p9', 'no-p9' or 'unreachable'; saved or last-used remotes only
  // With a Send files plan for the chat's folder: its id and the prompt's answer (item 23).
  sendToServer: (id, plan, choice, deleteToo) => plan ? ipcRenderer.invoke('p9:send-to-server', id, plan, choice, deleteToo) : ipcRenderer.invoke('p9:send-to-server', id),
  cancelMove: (id) => ipcRenderer.invoke('p9:move-cancel', id),
  onMove: (callback) => { ipcRenderer.on('p9:move', (_event, move) => callback(move)); },
  xferPlan: (folder) => ipcRenderer.invoke('p9:xfer', 'plan', folder), // Send files: a workspace folder ('' is all of it)
  xferRun: (id, choice, deleteToo) => ipcRenderer.invoke('p9:xfer', 'run', id, choice, deleteToo),
  onXfer: (callback) => { ipcRenderer.on('p9:xfer', (_event, progress) => callback(progress)); },
  serverUpdate: () => ipcRenderer.invoke('p9:server-update'),
  remoteInstall: () => ipcRenderer.invoke('p9:remote-install'), // D15a: install P9 on this remote, asked first
  remoteStart: () => ipcRenderer.invoke('p9:remote-start'), // row I1: start P9 on this remote, no terminal
  remoteAdmin: password => ipcRenderer.invoke('p9:remote-admin', password), // row I2: the admin password for this remote's admin step
  remoteDepsCheck: () => ipcRenderer.invoke('p9:remote-deps-check'), // row 61 on a remote: the command that remote computed for tmux or ssh
  sshAnswer: answer => ipcRenderer.invoke('p9:ssh-answer', answer), // row 78: the ssh password (or 'yes' to a host key) for the waiting login; null cancels
  sshKey: (yes, never) => ipcRenderer.invoke('p9:ssh-key', yes, never), // row 79: the key offer's answer (yes, Don't ask again)
  sshKeySetting: host => ipcRenderer.invoke('p9:ssh-key-setting', host), // Settings > Remote: offer a P9 key again for this remote
  remoteDeps: password => ipcRenderer.invoke('p9:remote-deps', password), // row 61 on a remote: the admin password for it
  adminInstall: (id, password) => ipcRenderer.invoke('p9:admin-install', id, password), // row 61: tmux or ssh here, with the admin password
  onServerUpdate: (callback) => { ipcRenderer.on('p9:server-update', (_event, update) => callback(update)); },
  pickVault: () => ipcRenderer.invoke('p9:pick-vault'), // row 73: the Obsidian vault folder, through the native picker
  pickFolder: (kind) => ipcRenderer.invoke('p9:pick-folder', ...(kind === undefined ? [] : [kind])),
  onFocus: (callback) => { ipcRenderer.on('p9:focus', (_event, focus) => callback(focus)); },
  terminal: (action, payload) => ipcRenderer.invoke('p9:terminal', action, payload),
  terminalOpen: (id) => ipcRenderer.invoke('p9:terminal-open', id),
  terminalSend: (serial, frame) => ipcRenderer.send('p9:terminal-send', serial, frame),
  terminalClose: (serial) => ipcRenderer.send('p9:terminal-close', serial),
  onTerminal: (callback) => { ipcRenderer.on('p9:terminal', (_event, serial, message) => callback(serial, message)); },
  landing: !process.argv.includes('--p9-landing=off'),
  landingBg: process.argv.includes('--p9-landing=original') ? 'original' : 'video', // landing v5's rollback switch (controller.mjs LAND_BG)
  version: (process.argv.find(arg => arg.startsWith('--p9-version=')) || '').slice('--p9-version='.length),
  source: process.argv.includes('--p9-source'), // a source checkout: Settings shows Rebuild + reload
  sample: ipcRenderer.sendSync('p9:sample'), // null unless an unpackaged test run set P9_SAMPLE_DATA=1
}));
