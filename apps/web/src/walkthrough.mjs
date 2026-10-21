// First-login walkthrough (Builder, 2026-10-18: "I want to view and approve the walkthrough before its integrated into the
// app official"; approved as written: "A."). It starts once, the first time the landing page closes; the command menu's
// "Walkthrough" runs it again.
// Each step: the element it points at (none = centred), the focus mode to show first, and what the guide pet says.
export const WALKTHROUGH = [
  { title: 'Welcome to P9', text: 'One window for your agent chats, your code and your system. This takes about two minutes. Skip any time; the command menu (Ctrl K) brings it back.' },
  { at: '#rChat', focus: 'chat', title: 'Three focus modes', text: 'Chat for agents, Dev for code, Mission Control for your scripts and what waits on you. Switch here or with Ctrl 1, 2 and 3. Each mode keeps its place and its own theme.' },
  { at: '#newBtn', focus: 'chat', title: 'Start a chat', text: 'Pick Claude or Codex. P9 uses the logins you already have. Each chat runs in the P9 daemon, so closing this window does not stop it.' },
  { at: '#tabs', focus: 'chat', title: 'Tabs', text: "Each open chat has a tab. The x on a tab stops that chat, like closing a terminal in VS Code. Mode and Model sit above each chat's message box: Mode sets how much the agent may do without asking." },
  { at: '#histBtn', focus: 'chat', title: 'History', text: 'Every chat is kept here. Open brings a stopped or closed one back.' },
  { at: '#agentInd', focus: 'chat', title: 'Who is working', text: 'When an agent is working or waiting on you, its pet or a spinner shows here.' },
  { at: '#cards', focus: 'chat', title: 'Cards', text: 'Cards show what needs you: an agent asking a question, an item waiting on you. Click one to answer it without leaving what you were doing.' },
  { at: '#rBell', focus: 'chat', title: 'Notification Center', text: 'Cards you set aside, older items and system notices wait here until you clear them.' },
  { at: '#rBots', focus: 'chat', title: 'Running chats', text: 'Each running chat has a robot head here. Click one to open that chat in a window.' },
  { at: '#rMission', focus: 'mission', title: 'Mission Control', text: 'Your scripts as buttons, your apps and pages, incidents, usage, and everything waiting on you. A button runs one exact command; nothing goes through a shell. + New idea saves a file to your _ideas/ folder.' },
  { at: '#rDev', focus: 'dev', title: 'Dev', text: 'A VS Code-style editor on your workspace, with extensions from Open VSX. If a file changed on disk since you opened it, P9 shows a conflict instead of overwriting it. Secrets, .env files and _private stay locked while File protection is on.' },
  { at: '#rTerm', title: 'Terminal', text: "A real shell at the bottom of the window. It keeps running when you close P9, and your phone's Terminal tab reaches P9's terminals too." },
  { at: '#stopAll', title: 'Session controls', text: 'P9 is persistent: Close Window and Quit UI leave agents and P9 terminals running. Stop Session ends one. Stop All blocks new starts, then stops every P9 agent, script and terminal. This dialog can switch P9 to stop everything when the app closes.' },
  { at: '#setBtn', title: 'Settings', text: 'Zoom, focus modes, pets, Agent lock (agents can read but not change anything), File protection, and the P9 docs. Each setting survives a restart.' },
  { at: '#rCmd', title: 'Every command', text: "Ctrl K opens every command, this walkthrough included. That's the tour." },
];
