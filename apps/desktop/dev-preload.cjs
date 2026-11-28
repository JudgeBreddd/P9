const { contextBridge, ipcRenderer } = require('electron');
// SPIKE o294: the shell's page in a workbench tab gets the shell's bridge.
if (location.host === 'chat') {

contextBridge.exposeInMainWorld('p9', Object.freeze({
  getStatus: () => ipcRenderer.invoke('p9:get-status'),
  usage: () => ipcRenderer.invoke('p9:usage'),
  usageTurns: (days) => ipcRenderer.invoke('p9:usage-turns', days),
  telemetryTab: (show) => ipcRenderer.invoke('p9:telemetry-tab', show),
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
  devStill: () => ipcRenderer.invoke('p9:dev-still'),
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
  serverOff: () => ipcRenderer.invoke('p9:server-off'), // O8 Disconnect: back to this computer, then P9 on the remote is turned off
  remotes: (action, host) => ipcRenderer.invoke('p9:remotes', action, host), // 'add' or 'remove', one host name
  remoteKeep: (yes, remember) => ipcRenderer.invoke('p9:remote-keep', yes, remember), // row I1: Keep P9 running on this remote?
  remoteAgents: (names) => ipcRenderer.invoke('p9:remote-agents', names),
  remoteKeepSetting: (host, choice) => ipcRenderer.invoke('p9:remote-keep-setting', host, choice), // true, false or null (ask)
  remoteState: host => ipcRenderer.invoke('p9:remote-state', host), // 'p9', 'no-p9' or 'unreachable'; saved or last-used remotes only
  // With a Send files plan for the chat's folder: its id and the prompt's answer (item 23).
  sendToServer: (id, plan, choice, deleteToo) => plan ? ipcRenderer.invoke('p9:send-to-server', id, plan, choice, deleteToo) : ipcRenderer.invoke('p9:send-to-server', id),
  cancelMove: (id) => ipcRenderer.invoke('p9:move-cancel', id),
  onMove: (callback) => { ipcRenderer.on('p9:move', (_event, move) => callback(move)); },
  // Send files: a workspace folder ('' is all of it). U4: a chat's full path, and to, where it goes on the remote once picked.
  xferPlan: (folder, to) => to === undefined ? ipcRenderer.invoke('p9:xfer', 'plan', folder) : ipcRenderer.invoke('p9:xfer', 'plan', folder, to),
  xferFolders: (kind, at) => ipcRenderer.invoke('p9:xfer', 'folders', kind, at), // U4: the remote picker's walk, kind 'folders' or 'list'
  xferRun: (id, choice, deleteToo) => ipcRenderer.invoke('p9:xfer', 'run', id, choice, deleteToo),
  onXfer: (callback) => { ipcRenderer.on('p9:xfer', (_event, progress) => callback(progress)); },
  serverUpdate: () => ipcRenderer.invoke('p9:server-update'),
  remoteAdmin: password => ipcRenderer.invoke('p9:remote-admin', password), // row I2: the admin password for this remote's admin step
  remoteDepsCheck: () => ipcRenderer.invoke('p9:remote-deps-check'), // row 61 on a remote: the command that remote computed for tmux or ssh
  sshAnswer: answer => ipcRenderer.invoke('p9:ssh-answer', answer), // row 78: the ssh password for the waiting login; null cancels
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
  firstRun: !process.argv.includes('--p9-first-run=off'), // the wizard and walkthrough on the first start (controller.mjs firstStart)
  version: (process.argv.find(arg => arg.startsWith('--p9-version=')) || '').slice('--p9-version='.length),
  sendCap: Number((process.argv.find(arg => arg.startsWith('--p9-send-cap=')) || '').slice('--p9-send-cap='.length)) || 0, // a test's shorter send cap (controller.mjs SEND_CAP)
  defaults: JSON.parse((process.argv.find(arg => arg.startsWith('--p9-defaults=')) || '--p9-defaults=null').slice('--p9-defaults='.length)), // main.mjs DEFAULT_SETTINGS (CAT-2)
  // Review 12: this computer's agent catalog (main.mjs p9:agents, publicAgents: GET /agents' answer), so the window has every agent's modes
  // before the daemon answers; GET /agents still replaces it (a remote server's may differ). { agents, local }: local is true
  // when the daemon in use is this computer's own (review 13; controller.mjs, security.mjs CATALOG).
  agents: ipcRenderer.sendSync('p9:agents'),
  source: process.argv.includes('--p9-source'), // a source checkout: Settings shows Rebuild + reload
  sample: ipcRenderer.sendSync('p9:sample'), // null unless an unpackaged test run set P9_SAMPLE_DATA=1
}));

} else {

// Dev Focus page (p9://dev/): the editor's guarded save and "Open in VS Code"; main checks every sender.
contextBridge.exposeInMainWorld('p9dev', Object.freeze({
  config: () => ipcRenderer.invoke('p9dev:config'),
  save: (path, hash, content) => ipcRenderer.invoke('p9dev:save', { path, hash, content }),
  create: (path, content) => ipcRenderer.invoke('p9dev:create', { path, content }),
  hostPath: (path, kind) => ipcRenderer.invoke('p9dev:host-path', path, kind),
  openInCode: (name, line, reason) => ipcRenderer.invoke('p9dev:open-in-code', { name, line, reason }),
  openFolder: (folder) => folder === undefined ? ipcRenderer.invoke('p9dev:open-folder') : ipcRenderer.invoke('p9dev:open-folder', folder),
  installEditor: () => ipcRenderer.invoke('p9dev:install-editor'),
  onLook: (callback) => { ipcRenderer.on('p9dev:look', (_event, look) => callback(look)); },
  // p9 edit / p9 diff: the page says when it can open files, then main sends each checked request.
  onOpen: (callback) => { ipcRenderer.on('p9dev:open', (_event, request) => callback(request)); return ipcRenderer.invoke('p9dev:open-ready'); },
}));

}
