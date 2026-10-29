// ST1/ST2: Settings → Mission Control files, the rows of settings.json, on the desktop (controller.mjs) and, since c18
// (threat model row 66), the phone (phone.ts): the same rows, words and text forms; the daemon's checks are the rules.
// The wizard's path rows; the wizard (controller.mjs) uses them too.
export const PATH_KEYS = [['primary', 'Main project folder (optional)', 'setup-folder'], ['registry', 'Buttons, apps and pages file (optional)', 'setup-file'], ['waiting', 'Folder of items waiting on you (optional)', 'setup-folder'], ['hub', 'Logs and status folder (optional)', 'setup-folder'], ['scripts_root', 'Folder your buttons run in (optional, full path)', '']];
const MISSION_TIPS = { primary: 'Folder of your main project, or a file that names it (for the Mission Control Main Project card and the Chat Focus Files pane)',
  registry: "JSON file listing your buttons, apps and pages (for the Mission Control script buttons and the Apps and pages card)",
  waiting: 'Folder of .md files, one for each thing waiting on you (for the Mission Control Waiting on you list, the Chat Focus cards and the Files pane\'s Needs you view)',
  hub: "Folder where a monitoring tool keeps your machines' logs, incidents, wiki review inbox and work status. Mission Control shows them in its Logs and incidents, Wiki review inbox and Workspace cards, which stay hidden without it",
  scripts_root: 'Full path of the folder your buttons and apps run in, and the one ~/workspace stands for (for the Mission Control buttons). Empty: the workspace' };
export const missionKeys = () => [...PATH_KEYS.map(([k, name, kind]) => [k, name, kind, MISSION_TIPS[k]]),
  ['space', 'Extra sections file (optional)', 'setup-file', 'JSON file with your own sections, buttons and log views (for the extra sections on the Mission Control page)'],
  ['server_host', 'Remote host name (optional)', '', "Network name of your remote, the second machine the monitoring tool behind your logs and status folder watches (for the Mission Control Logs and incidents card, which also reads that remote's logs over ssh)"],
  ['page_schemes', 'Extra link types for pages (optional, comma-separated)', '', 'Link types besides http and https that a Mission Control page may open, for example obsidian (a page link of that type asks before it opens)'],
  ['notes_roots', 'Notes folders (optional, one name = /full/path per line)', '', 'Named folders of .md notes (for the notes an extra Mission Control section shows, by that name)']];
export const missionShown = (k, v) => v === undefined ? '' : k === 'page_schemes' ? v.join(', ') : k === 'notes_roots' ? Object.entries(v).map(([n, f]) => n + ' = ' + f).join('\n') : v;
// The box's text as the settings value; empty removes the key. No checks here: the daemon's are the rules.
export const missionValue = (k, text) => {
  text = text.trim();
  if (!text) return null;
  if (k === 'page_schemes') return text.split(/[\s,]+/).filter(Boolean);
  if (k === 'notes_roots') return Object.fromEntries(text.split('\n').filter(l => l.trim()).map(l => { const i = l.indexOf('='); return i < 0 ? [l.trim(), ''] : [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
  return text;
};
