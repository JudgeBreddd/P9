// N1 points 9 and 10: the New project dialog and the project page (the N1 spec and the approved mock, round 3), plus
// Rename, Archive and Delete in a chat's row menu and the Archived page. installPanel calls installProjects last; it sets
// the hooks panel.mjs asks for (o.openProject, o.newProject, o.chatMenuItems, o.renderPage). The page lives in #projPage
// beside #chats; o.S.view says which shows ({ kind: 'project', id }, { kind: 'archived' } or null for the chats).
// Every change goes through the daemon's project routes (p9:chat); nothing here reads or writes a folder.
import { svg, esc, runnerPicks } from './helpers.mjs';
import { PANEL_ICONS, LABEL, listedChats, stateOf } from './panel.mjs';

const ERR = { 'folder-exists': 'A folder with that name is already there. Change the name or the parent.', 'folder-refused': 'P9 can\'t use that folder. Pick another.',
  'file-exists': 'A file with that name is already added.', 'source-refused': 'P9 clones only from an https:// or ssh:// address, or user@host:path. Check the address.', 'too-many-files': 'This project has the most files it can hold (200).', 'request-refused': 'P9 refused that. Check the name and try again.', 'unknown-conversation': 'That chat is no longer there.' };
const where = f => f === '' ? 'Workspace' : f;
const slug = s => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'project';
const size = n => n < 1024 ? n + ' B' : n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
const when = s => s.used || s.created || 0;
const fmt = t => { if (!t) return ''; const m = Math.floor((Date.now() - t) / 60000), D = 1440;
  return m < 1 ? 'now' : m < 60 ? m + 'm' : m < D ? Math.floor(m / 60) + 'h' : m < 7 * D ? Math.floor(m / D) + 'd' : new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' }); };

export function installProjects(o, api) {
  const I = PANEL_ICONS, $ = s => document.querySelector(s), page = $('#projPage'), chats = $('#chats');
  const call = (action, body, opts) => o.liveChat.call(action, body, opts);
  const find = id => o.S.sessions.find(s => s.id === id);
  // cur: the shown project as GET /projects/<id> gives it (instructions, files, agentFiles, sharedWith).
  let cur = null, edit = false, saveT = 0, sprintOpen = ''; // sprintOpen: '<lead> <name>' of the sprint file shown in its box
  // Sprint file drafts, '<lead> <name>' -> { text, hash }: typed and not saved yet; hash is the file as it was when typing
  // began. spNote: a draft's save that was refused ('changed': someone else's edit came first; 'failed'). spSaving: saves
  // go one at a time, so each one names the file the one before it wrote.
  // cleaned: lead -> what "Clean up worker folders" last answered (SECURITY.md § Worker folders, "Who cleans up").
  const cleaned = new Map();
  // window-10, Start sprint (SECURITY.md § Start sprint): lead -> what the last press answered; starting: the presses still out,
  // so a redraw meanwhile keeps the button off. The press is the approval record; the page shows the one P9 kept.
  const startSaid = new Map(), starting = new Set();
  // A lead chat takes its sprint's id, so the chat a press here makes is known before it exists; chat-view leaves it
  // where it is listed instead of putting it on screen, so the press's answer (a failure halfway too) stays in view.
  const pressed = new Set(); o.pressedStart = id => pressed.has(id);
  const startText = r => r.status === 200 ? 'Started: ' + r.body.chats.map(c => c.key + (c.existing ? ' (kept)' : '')).join(', ') + '.'
    : 'Not started: ' + (r.body?.detail || r.body?.error || r.status) + (r.body?.chats?.length ? ' Made so far: ' + r.body.chats.map(c => c.key).join(', ') + '.' : '');
  const startedHtml = sp => sp.started ? `<p class="hint" data-sp-started>Started ${esc(new Date(sp.started.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))} by ${sp.started.by === 'owner' ? 'you' : esc(find(sp.started.by)?.title ?? 'a chat\'s agent, on your yes')}: your approval of its plan, sha256 <span class="mono" title="${esc(sp.started.plan)}">${esc(sp.started.plan.slice(0, 12))}</span>.</p>` : '';
  // The sprint's scripts (SECURITY.md § Sprint scripts): what Start approves, command by command, and what P9 runs now.
  // The server parses hooks.json for real and refuses a file it cannot read; this only shows it.
  const scriptsOf = sp => { const text = sp.files.find(f => f.name === 'hooks.json')?.text ?? ''; if (!text.trim()) return [];
    try { const rows = JSON.parse(text)?.scripts; return Array.isArray(rows) && rows.every(r => r && typeof r.name === 'string' && typeof r.command === 'string' && typeof r.point === 'string') ? rows : null; } catch { return null; } };
  const scriptLine = s => `${s.name} (${s.point}${s.blocking === true ? ', blocking' : ''}): ${s.command}`;
  const scriptsHtml = sp => { const file = scriptsOf(sp), ok = sp.started?.scripts ?? [], same = file && JSON.stringify(file.map(scriptLine)) === JSON.stringify(ok.map(scriptLine));
    const list = rows => `<ul class="sp-scripts">${rows.map(s => `<li class="mono">${esc(scriptLine(s))}</li>`).join('')}</ul>`;
    return (ok.length ? `<div class="hint" data-sp-scripts="approved">Scripts you approved at Start. P9 runs these as you, outside every agent's mode, and only these:${list(ok)}</div>` : '')
      + (file === null ? '<p class="hint" data-sp-scripts="unread" role="alert">hooks.json is not a scripts list: Start will refuse it and say why.</p>'
        : !same && file.length ? `<div class="hint" data-sp-scripts="pending">${sp.started ? 'hooks.json has changed since. Not run until you press Start again, which approves' : 'Start sprint approves'} ${file.length === 1 ? 'this script' : 'these scripts'}. P9 will run ${file.length === 1 ? 'it' : 'them'} as you, outside every agent's mode:${list(file)}</div>`
        : !same && ok.length ? '<p class="hint" data-sp-scripts="pending">hooks.json has no scripts now. The approved ones above still run until you press Start again.</p>' : ''); };
  const startBtn = sp => (!sp.prep && !sp.started) || sp.closed ? '' : `<button data-slot="button" data-variant="${sp.prep ? 'default' : 'ghost'}" data-size="sm" data-pj="spstart" data-lead="${esc(sp.lead)}" data-hooks="${esc(sp.files.find(f => f.name === 'hooks.json')?.hash ?? '')}"${starting.has(sp.lead) ? ' disabled' : ''} title="${sp.prep ? 'Makes the lead\'s chat and every chat under it, each on its row. Your press is the approval of the plan.' : 'Makes what an earlier press did not; every chat already made is kept.'}">${starting.has(sp.lead) ? 'Starting…' : sp.prep ? 'Start sprint' : 'Start again'}</button>`;
  const cleanText = r => r.status === 200 ? (r.body.removed.length || r.body.kept.length
    ? [r.body.removed.length && 'Removed: ' + r.body.removed.join(', ') + '.', r.body.kept.length && 'Kept: ' + r.body.kept.map(k => `${k.item} (${k.why}, ${size(k.bytes)})`).join(', ') + '.'].filter(Boolean).join(' ')
    : 'No worker folders to clean up.') : 'Not cleaned: ' + (r.body?.detail || r.body?.error || r.status);
  const drafts = new Map(), spNote = new Map(); let spSaving = Promise.resolve(true);
  // The sprint whose own page is open (its lead's id), '' for the project page. Each sprint is one button on the project
  // page; the button opens the sprint's page: Sprint Setup until it is started.
  let spPage = '';
  let sv = null, svFor = '', svN = 0; // Sprint View (loadView): the status drawn { lead, draw(opts) }, the sprint being read, the read's number
  let svClosing = '', svSaid = ''; // Close sprint: the sprint whose press is out, and why the last press was refused
  const say = (txt, level = 'ok') => o.toast({ kind: 'project', txt, level }, true);
  const failed = r => say(ERR[r.body?.error] || 'That did not work (' + (r.body?.error || r.status) + ').', 'warn');

  // ---- A folder from the native picker: a workspace path ('' is the workspace), the server's own list in server mode. ----
  async function pick() {
    let f = await window.p9?.pickFolder?.().catch(() => undefined);
    if (f?.remote) f = await o.pickRemoteFolder?.();
    if (f === null) say('Pick a folder inside the workspace.', 'warn');
    return typeof f === 'string' ? f : undefined;
  }

  // ---- One question at a time: a title, a line, maybe a text box; resolves to true, the text, or null on Cancel. ----
  const ask = $('#pjAsk') || document.body.appendChild(Object.assign(document.createElement('dialog'), { id: 'pjAsk', className: 'pj-dlg' }));
  function confirmIt({ title, body = '', input, ok, danger }) {
    ask.setAttribute('aria-labelledby', 'pjAskT'); ask.setAttribute('role', danger ? 'alertdialog' : 'dialog');
    ask.innerHTML = `<form method="dialog"><h2 id="pjAskT">${esc(title)}</h2>${body ? `<p class="body2">${body}</p>` : ''}${input !== undefined ? `<input data-slot="input" name="v" value="${esc(input)}" maxlength="120" required aria-label="${esc(title)}" autocomplete="off">` : ''}`
      + `<div class="btns"><button type="button" data-slot="button" data-variant="ghost" value="no">Cancel</button><button data-slot="button" data-variant="${danger ? 'destructive' : 'default'}" value="yes">${esc(ok)}</button></div></form>`;
    return new Promise(done => {
      ask.querySelector('[value=no]').onclick = () => ask.close('no');
      ask.onclose = () => done(ask.returnValue !== 'yes' ? null : input !== undefined ? ask.querySelector('input').value.trim() || null : true);
      ask.returnValue = ''; ask.showModal(); (ask.querySelector('input') || ask.querySelector('[value=yes]')).focus(); ask.querySelector('input')?.select();
    });
  }

  // ---- The page ----
  async function openProject(id, sprintLead) {
    if (o.S.focus !== 'chat' && !o.focusOn('chat')) return;
    api.closeMenu(); api.setOpen(id, true); edit = false; spPage = sprintLead || '';
    o.S.view = { kind: 'project', id }; if (o.S.focus !== 'chat') o.setFocus('chat');
    if (cur?.id !== id) cur = null; // shown once the full record is in: the list's copy has no instructions or files
    o.renderTabs(); if (o.S.files) o.renderTree();
    const r = await call('project', { id });
    if (r.status === 200 && o.S.view?.id === id) { cur = r.body.project; renderPage(); }
    else if (r.status === 404) { o.S.view = null; o.loadProjects(); o.renderTabs(); }
    if (sprintLead && o.S.view?.id === id) page.querySelector(`[data-sprint="${CSS.escape(sprintLead)}"]`)?.scrollIntoView({ block: 'start' });
    page.focus({ preventScroll: true }); // the page, not the editable name: a stray key must not rename the project
  }
  const instrText = s => { const l = s.split('\n'), rest = l.slice(3);
    return `<p class="instr">${esc(l.slice(0, 3).join('\n'))}${rest.length ? `<span hidden data-rest>\n${esc(rest.join('\n'))}</span>` : ''}</p>`
      + (rest.length ? `<button class="instr-all" data-pj="all">Show ${rest.length} more line${rest.length > 1 ? 's' : ''}</button>` : ''); };
  const mark = s => { const st = stateOf(s, false); return st ? `<span class="mk mk-${st === 'running' ? 'run' : st}" title="${LABEL[st]}">${st === 'needs' ? I.hand : st === 'failed' ? svg.x : ''}</span>` : ''; };
  const chatRow = s => `<button class="crow" data-chat="${esc(s.id)}" data-s="${stateOf(s, false)}"><span class="dot" data-agent="${esc(s.agent)}"></span><span class="t">${esc(s.title)}</span>${mark(s)}<span class="when">${fmt(when(s))}</span></button>`;
  function projectHtml(p) {
    const kids = listedChats(o.S.sessions).filter(s => s.project === p.id), mine = p.work.kind === 'p9', f = p.work.folder;
    // In P9: the daemon gives no path for P9's own folder, so the page names it instead (report: open question 1).
    const wf = p.found === false
      ? `<div class="missing" role="status">${I.alert}<div><b>Folder not found</b><span>${esc(where(f))} was moved or deleted. New chats in this project can't start until P9 knows where it is.</span></div><button data-slot="button" data-variant="outline" data-size="sm" data-pj="locate">Locate…</button></div>`
      : `<div class="wf">${I.folder}<span>Work folder</span>${mine ? `<span class="plain">P9's folder for this project</span><span class="tag">In P9</span><button data-slot="button" data-variant="ghost" data-size="sm" data-pj="open" title="Show it in the Files pane">Open</button>`
        : `<span class="mono" title="Chats in this project start here">${esc(where(f))}</span><button data-slot="button" data-variant="ghost" data-size="sm" data-pj="open" title="Show it in the Files pane">Open</button>`}</div>`;
    const own = !mine && p.agentFiles?.length ? `<p class="ownfile">${svg.files}This folder has its own instructions (${p.agentFiles.map(esc).join(', ')}). Agents read them on their own.</p>` : '';
    const instr = edit ? `<textarea data-slot="textarea" id="pjInstr" aria-label="Instructions" maxlength="32000">${esc(p.instructions ?? '')}</textarea>`
      : p.instructions ? instrText(p.instructions) : '<p class="hint">None yet. Add a few lines every chat in this project should follow.</p>';
    const files = p.files ?? [], open = spPage && (p.sprints ?? []).find(x => x.lead === spPage);
    if (open) return `<div class="wrap" data-page="${esc(p.id)}" data-sp-page="${esc(open.lead)}">
      <div class="ph"><div class="grow"><button data-slot="button" data-variant="ghost" data-size="sm" data-pj="spback" title="Back to the project's page">‹ ${esc(p.name)}</button><h1 data-sp-title>${open.prep ? 'Sprint Setup' : open.closed ? 'Closed sprint' : 'Sprint View'}</h1>
        <p class="about">${open.prep ? 'Everything before Start: the plan, the roles and each role\'s files, the rules and the scripts. Each is a file in the sprint\'s folder, so an agent can fill in the same things. Nothing runs until Start sprint.' : open.closed ? 'This sprint is closed. Its record is first: what it built and its numbers, as they stood at Close; an agent reads the same with sprint_status. Its roles and files are below.' : 'This sprint is started. Where it stands is first, read again every few seconds; an agent reads the same with sprint_status. Its roles and files are below.'}</p></div></div>
      ${sv?.lead === open.lead && !open.prep ? sv.draw({ closing: svClosing === open.lead, said: svSaid }) : ''}${sprintHtml(open)}</div>`;
    const stamp = sp => sp.prep ? '<span class="tag">Not started</span>' : sp.closed ? `<span class="when" data-sp-closed>Closed ${esc(new Date(sp.closed.at).toLocaleDateString([], { month: 'short', day: 'numeric' }))}</span>` : `<span class="when">Started${sp.started ? ' ' + esc(new Date(sp.started.at).toLocaleDateString([], { month: 'short', day: 'numeric' })) : ''}</span>`;
    const sprintRows = (p.sprints ?? []).map(sp => `<button class="crow" data-pj="spopen" data-lead="${esc(sp.lead)}" title="${sp.prep ? 'Open its Sprint Setup' : 'Open this sprint'}">${svg.files}<span class="t">${esc(sp.title)}</span>${stamp(sp)}</button>`).join('');
    return `<div class="wrap" data-page="${esc(p.id)}">
      <div class="ph"><div class="grow"><h1 contenteditable="plaintext-only" spellcheck="false" id="pjName" title="Click to rename" aria-label="Project name">${esc(p.name)}</h1><p class="about" contenteditable="plaintext-only" id="pjAbout" title="Click to edit" aria-label="What it is about" data-ph="Add a line about what this project is for">${esc(p.about || '')}</p></div>
        <div class="acts2"><button data-slot="button" data-variant="default" data-size="sm" data-pj="new" title="Starts in the work folder, with the instructions and added files">${svg.plus}New chat</button><button data-slot="button" data-variant="ghost" data-size="sm" data-pj="more" aria-haspopup="menu" aria-expanded="false" title="More">${I.more}More</button></div></div>
      ${wf}
      <section class="sec" aria-labelledby="pjChatsH"><div class="sh2"><h2 id="pjChatsH">Chats</h2><span class="muted">${kids.length || ''}</span></div>
        ${kids.map(chatRow).join('') || '<p class="hint">No chats yet. Start one with New chat, or drag a chat from the panel onto this project.</p>'}</section>
      <section class="sec" aria-labelledby="pjInstrH"><div class="sh2"><h2 id="pjInstrH">Instructions</h2><span class="muted">every chat in this project gets these</span><span class="saved" id="pjSaved" role="status">Saved</span><button data-slot="button" data-variant="ghost" data-size="sm" data-pj="edit">${edit ? 'Done' : 'Edit'}</button></div>
        ${own}${instr}</section>
      <section class="sec" data-drop-files aria-labelledby="pjFilesH"><div class="sh2"><h2 id="pjFilesH">${mine ? 'Files' : 'Added files'}</h2><span class="muted">${mine ? 'handed to every chat in this project' : 'kept in P9, handed to every chat in this project'}</span><button data-slot="button" data-variant="ghost" data-size="sm" data-pj="add">${svg.plus}Add files</button></div>
        ${files.map(x => `<div class="crow file">${svg.files}<span class="t" title="${esc(x.name)}">${esc(x.name)}</span><span class="sz">${size(x.size)}</span><button class="rm" data-pj="rm" data-name="${esc(x.name)}" title="Remove ${esc(x.name)}" aria-label="Remove ${esc(x.name)}">${svg.x}</button></div>`).join('')
          || '<p class="hint">Drop files here, or Add files. Every chat in this project gets them.</p>'}</section>
      ${window.p9 && p.sprint ? `<section class="sec" aria-labelledby="pjSprintH"><div class="sh2"><h2 id="pjSprintH">Sprints</h2><span class="muted">each opens on its own page</span><button data-slot="button" data-variant="outline" data-size="sm" data-pj="spnew">${svg.plus}New sprint</button></div>
        ${sprintRows || '<p class="hint">No sprint yet. New sprint makes one to prepare; nothing starts until you press Start sprint on its page.</p>'}
        <div class="sh2 sp-every"><span class="muted">For every sprint in this project</span><span class="saved" id="pjSprintSaved" role="status">Saved</span><button data-slot="button" data-variant="ghost" data-size="sm" data-pj="spset">Save</button></div>
        <label class="spset"><span>Clone from</span><input data-slot="input" class="mono" id="pjSpSource" maxlength="2000" spellcheck="false" autocomplete="off" placeholder="https://… or git@host:owner/repo.git" value="${esc(p.sprint.source)}"></label>
        <p class="hint">Empty: each sprint is cloned from the folder its workers would start in${mine ? '' : ' (this project\'s work folder)'}, and that folder is only read. With an address here, P9 clones from the address instead and does not read your folder at all. Signing in is your own git sign-in.</p>
        <label class="spset"><span>Setup command</span><input data-slot="input" class="mono" id="pjSpSetup" maxlength="2000" spellcheck="false" autocomplete="off" placeholder="for example: pnpm install" value="${esc(p.sprint.setup)}"></label>
        <p class="hint">Runs in each new worker folder before its worker starts. Empty: the one in Settings &gt; Delegation is used. Only you set these, here on the desktop; no agent can.</p></section>` : ''}
      ${window.p9 && p.sprint || !sprintRows ? '' : `<section class="sec" aria-label="Sprints"><div class="sh2"><h2>Sprints</h2></div>${sprintRows}</section>`}
    </div>`;
  }
  // D1, D3, D4: a sprint's files, kept in P9; its lead and workers edit them too. One open at a time, saved as you type.
  function sprintHtml(sp) {
    const about = { 'sprint.md': 'the plan', 'rules.md': 'sent with every message the lead sends a worker', 'roles.json': 'the roles above', 'hooks.json': 'the sprint\'s scripts: P9 runs only what you approved at Start', 'hooks.log': 'P9\'s log of script runs, read only', 'review-trail.md': 'P9\'s record of reviews, read only' };
    const what = n => about[n] || (/\.instructions\.md$/.test(n) ? 'this role gets it at its start' : /\.rules\.md$/.test(n) ? 'sent to this role with the sprint rules' : /\.work\.md$/.test(n) ? 'its first message at Start' : 'the worker keeps it itself');
    const roles = rolesOf(sp), files = [...sp.files, ...[...roleFiles(sp), 'hooks.json'].filter(n => !sp.files.some(f => f.name === n)).map(name => ({ name, text: '', hash: '', unmade: true }))];
    const fixed = ['sprint.md', 'rules.md', 'roles.json', 'hooks.json'], rank = n => fixed.includes(n) ? fixed.indexOf(n) : fixed.length;
    files.sort((x, y) => rank(x.name) - rank(y.name) || (rank(x.name) < fixed.length ? 0 : x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    return `<section class="sec" data-sprint="${esc(sp.lead)}" aria-label="Sprint files: ${esc(sp.title)}"><div class="sh2"><h2>${esc(sp.title)}</h2>${sp.prep ? '<span class="tag" data-sp-prep>Prep</span><span class="muted">not started: its chats are made at Start sprint</span>' : '<span class="muted">its files, kept in P9</span>'}<span class="saved" data-sp-saved role="status">Saved</span>${startBtn(sp)}<button data-slot="button" data-variant="ghost" data-size="sm" data-pj="spscripts" data-lead="${esc(sp.lead)}" title="This sprint's scripts and your library: make one, remove one, keep one for other sprints, run an approved one.">Sprint scripts</button>${sp.prep ? '' : `<button data-slot="button" data-variant="ghost" data-size="sm" data-pj="spclean" data-lead="${esc(sp.lead)}">Clean up worker folders</button>`}</div>
      ${sp.prep ? '' : '<p class="hint" data-sp-ignored>Clean up removes a finished worker\'s whole folder, including files git ignores, such as build output or a local .env.</p>'}
      ${startedHtml(sp)}${scriptsHtml(sp)}${startSaid.has(sp.lead) ? `<p class="hint" data-sp-start role="status">${esc(startSaid.get(sp.lead))}</p>` : ''}
      ${cleaned.has(sp.lead) ? `<p class="hint" data-sp-clean role="status">${esc(cleaned.get(sp.lead))}</p>` : ''}
      ${rolesHtml(sp, roles)}
      ${[...files, ...goneDrafts(sp)].map(f => { const on = sprintOpen === sp.lead + ' ' + f.name;
        const sz = what(f.name) + (f.gone ? ' · deleted, your text not saved' : drafts.has(sp.lead + ' ' + f.name) ? ' · not saved'
          : f.unmade && f.name === 'rules.md' ? ' · none yet, P9\'s defaults are sent' : f.unmade || f.text === '' ? ' · empty' : '');
        return `<button class="crow file" data-pj="spfile" data-lead="${esc(sp.lead)}" data-name="${esc(f.name)}" aria-expanded="${on}">${svg.files}<span class="t mono">${esc(f.name)}</span><span class="sz" title="${esc(sz)}">${esc(sz)}</span></button>`
          + (on ? `<textarea data-slot="textarea" class="sp-box" data-sp-box data-lead="${esc(sp.lead)}" data-name="${esc(f.name)}" aria-label="${esc(f.name)}" maxlength="32000" spellcheck="false"${f.name === 'hooks.log' || f.name === 'review-trail.md' ? ' readonly' : ''}>${esc(drafts.get(sprintOpen)?.text ?? f.text)}</textarea><p class="hint" data-sp-note role="alert">${spNoteHtml(sprintOpen)}</p>` : ''); }).join('')}</section>`;
  }
  // H1-H3: the roles a sprint starts with, read from its roles.json, the same file the lead's tools write. null: the file
  // is missing or not a roles list; then it shows only as its file, never rewritten from the rows.
  const rolesOf = sp => { try { const d = JSON.parse(sp.files.find(f => f.name === 'roles.json')?.text ?? ''); return Array.isArray(d?.roles) && d.roles.every(r => r && typeof r.key === 'string') ? d.roles : null; } catch { return null; } };
  // O110: a roles.json read between an outside writer's truncate and its write comes back empty or cut short. The page
  // keeps the last good one it had (its hash too, so a pick made meanwhile is refused as changed) and reads the project
  // again every half second until roles.json parses, so the rows never stay missing. Still bad after 5 s, it is the file
  // as written and its hint shows. ponytail: 10 reads; a writer paused longer than 5 s mid-file shows the hint until the
  // next save or a reload.
  const rereading = new Set(); // id + ' ' + lead: each sprint's own reads, so two recovering at once both finish
  function takeFiles(sp, files, id) {
    if (rolesOf({ files }) === null && rolesOf(sp) !== null) {
      const good = sp.files.find(f => f.name === 'roles.json');
      files = files.some(f => f.name === 'roles.json') ? files.map(f => (f.name === 'roles.json' ? good : f)) : [...files, good];
      reread(id, sp.lead);
    }
    sp.files = files;
  }
  async function reread(id, lead) {
    const key = id + ' ' + lead; if (rereading.has(key)) return; rereading.add(key);
    try {
      for (let i = 0; i < 10; i++) {
        await new Promise(go => setTimeout(go, 500));
        const r = cur?.id === id && await call('project', { id }, { quiet: true });
        if (r?.status !== 200 || cur?.id !== id) return;
        const sp = r.body.project.sprints?.find(x => x.lead === lead);
        if (!sp || rolesOf(sp) !== null || i === 9) {
          adopt(r.body.project, lead); renderPage(); fillBox(false);
          // renderPage leaves the page alone while its file box has the focus: the rows alone are redrawn then.
          const rows = sp && document.activeElement?.matches?.('[data-sp-box]') && page.querySelector(`[data-sprint="${CSS.escape(lead)}"] :is([data-sp-roles], [data-sp-roles-bad])`);
          if (rows) rows.outerHTML = rolesHtml(sp, rolesOf(sp));
          return;
        }
      }
    } finally { rereading.delete(key); }
  }
  // A fresh read of the project replaces cur: every sprint but the one read for (taken as it is) keeps its last good
  // roles.json over a torn one, and is read again itself.
  function adopt(next, lead) {
    for (const sp of next.sprints ?? []) {
      const was = sp.lead !== lead && cur?.id === next.id && cur.sprints?.find(x => x.lead === sp.lead);
      if (was) { const files = sp.files; sp.files = was.files; takeFiles(sp, files, next.id); }
    }
    cur = next;
  }
  // Each role's instructions, rules and work file: listed (empty) before anyone writes one, made by its first save.
  // A prep lists the sprint's rules.md too (none yet: Start sends P9's default rules), so all of prep can be done by hand.
  const roleFiles = sp => (sp.prep ? ['rules.md'] : []).concat((rolesOf(sp) ?? []).flatMap(r => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(r.key) ? ['instructions', 'rules', 'work'].map(k => `roles/${r.key}.${k}.md`) : []));
  const ROLE = { lead: 'Lead: runs the sprint, merges what passed review', review: 'Reviewer: reviews each piece, gets no worker folder' };
  function rolesHtml(sp, roles) {
    if (!sp.files.some(f => f.name === 'roles.json')) return '';
    if (!roles) return '<p class="hint" data-sp-roles-bad role="status">roles.json is not a list of roles P9 can read. Fix it in its file below; the rows show again when it reads.</p>';
    const row = r => { const worker = r.key !== 'lead' && r.key !== 'review', p = runnerPicks(o, { agent: String(r.provider ?? ''), model: String(r.model ?? ''), effort: String(r.effort ?? '') },
      { first: ['', 'Not set'], attr: k => `data-spr="${k}" data-role="${esc(r.key)}" data-lead="${esc(sp.lead)}"`, aria: k => `${r.key} ${k}` });
      return `<div class="set-row sp-role" data-role-row="${esc(r.key)}"><span><strong class="mono">${esc(r.key)}</strong><span class="muted sm">${ROLE[r.key] ?? `Worker: its own folder on branch sprint/…/${esc(r.key)}`}${p.empty ? `. Start one ${esc(o.names[p.a] ?? p.a)} chat first: its models and efforts are listed here after that.` : ''}</span></span>${p.html}`
        + (worker ? `<button class="rm" data-pj="sprole-rm" data-lead="${esc(sp.lead)}" data-role="${esc(r.key)}" title="Remove the role ${esc(r.key)}" aria-label="Remove the role ${esc(r.key)}">${svg.x}</button>` : '') + '</div>'; };
    return `<div class="sp-roles" data-sp-roles><h3>Roles</h3>${roles.map(row).join('')}`
      + `<div class="sp-add"><input data-slot="input" class="mono" data-sp-newkey data-lead="${esc(sp.lead)}" maxlength="64" spellcheck="false" autocomplete="off" placeholder="worker name, for example docs" aria-label="New worker's name"><button data-slot="button" data-variant="ghost" data-size="sm" data-pj="sprole-add" data-lead="${esc(sp.lead)}">${svg.plus}Add worker</button></div></div>`;
  }
  // A draft whose file was deleted since (a worker, the lead): still listed, with its text, until saved again or discarded.
  const goneDrafts = sp => [...drafts.keys()].filter(id => id.startsWith(sp.lead + ' ') && !sp.files.some(f => sp.lead + ' ' + f.name === id) && ![...roleFiles(sp), 'hooks.json'].includes(id.slice(sp.lead.length + 1))).map(id => ({ name: id.slice(sp.lead.length + 1), text: '', gone: true }));
  const isGone = id => { const sp = cur?.sprints?.find(x => id.startsWith(x.lead + ' ')); return !!sp && drafts.has(id) && !sp.files.some(f => sp.lead + ' ' + f.name === id) && ![...roleFiles(sp), 'hooks.json'].includes(id.slice(sp.lead.length + 1)); };
  const spNoteHtml = id => (spNote.get(id) !== 'failed' && isGone(id) ? 'This file was deleted in P9 after you opened it (the lead or a worker removed it). Your text is still here, not saved. <button data-slot="button" data-variant="outline" data-size="sm" data-pj="spmine">Save it again</button> <button data-slot="button" data-variant="ghost" data-size="sm" data-pj="sptheirs">Discard my text</button>' : null) ?? ({ changed: 'This file changed in P9 after you opened it (the lead or a worker edited it). Your text is still here, not saved. <button data-slot="button" data-variant="outline" data-size="sm" data-pj="spmine">Save mine over it</button> <button data-slot="button" data-variant="ghost" data-size="sm" data-pj="sptheirs">Show theirs</button>',
    failed: 'Not saved. Your text is still here. <button data-slot="button" data-variant="outline" data-size="sm" data-pj="spretry">Try again</button>' })[spNote.get(id)] ?? '';
  function archivedHtml() {
    const ps = (o.S.projects || []).filter(p => p.archived), cs = o.S.sessions.filter(s => s.archived && (s.sent || !s.hidden));
    const row = (label, attr) => `<div class="crow arch"><span class="t">${label}</span><button data-slot="button" data-variant="ghost" data-size="sm" ${attr}>Unarchive</button></div>`;
    return `<div class="wrap"><div class="ph"><div class="grow"><h1 tabindex="-1">Archived</h1><p class="lead">Archived projects and chats keep everything. Unarchive puts one back in the panel.</p></div></div>
      <section class="sec"><div class="sh2"><h2>Projects</h2><span class="muted">${ps.length || ''}</span></div>${ps.map(p => row(`${I.folder}${esc(p.name)}`, `data-pj="unproj" data-id="${esc(p.id)}"`)).join('') || '<p class="hint">None.</p>'}</section>
      <section class="sec"><div class="sh2"><h2>Chats</h2><span class="muted">${cs.length || ''}</span></div>${cs.map(s => row(`<span class="dot" data-agent="${esc(s.agent)}"></span>${esc(s.title)}`, `data-pj="unchat" data-id="${esc(s.id)}"`)).join('') || '<p class="hint">None.</p>'}</section></div>`;
  }
  // Called by renderPanel: shows the page or the chats, and keeps the page's chat list current. The name and about being
  // edited, and the instructions box, are left alone while they have the focus.
  function renderPage() {
    const v = o.S.focus === 'chat' && o.S.view, on = v?.kind === 'project' ? !!cur && cur.id === v.id : v?.kind === 'archived';
    page.hidden = !on; chats.hidden = on;
    if (!on) { if (v?.kind === 'project' && !cur) return; page.innerHTML = ''; return; }
    if (page.contains(document.activeElement) && document.activeElement.matches('[contenteditable], textarea, input')) return;
    o.morph(page, v.kind === 'project' ? projectHtml(cur) : archivedHtml());
    // morph changes an option's selected attribute only; a pick the user changed keeps showing their choice, so each role
    // pick is set to what roles.json says (after a refused save it says the lead's value).
    page.querySelectorAll('select[data-spr]').forEach(s => { s.value = s.querySelector('option[selected]')?.value ?? ''; });
    if (spPage && svFor !== spPage) loadView();
  }
  // ---- Sprint View: the shown sprint's status, drawn by sprint-view.mjs (loaded on first use) from the answer
  // sprint_status gives an agent. ponytail: read again every 5 s while its page shows; no push from the daemon.
  async function loadView() {
    const lead = svFor = spPage, n = ++svN;
    if (cur?.sprints?.find(x => x.lead === lead)?.prep === false) {
      const [m, r] = await Promise.all([import('./sprint-view.mjs').catch(() => null), call('sprintStatus', { sprint: lead }).catch(() => ({}))]);
      if (n !== svN) return;
      if (m && r.status === 200) { sv = { lead, draw: opts => m.statusHtml(r.body, esc, opts) }; renderPage(); if (r.body.closed) return; } // a closed sprint's record does not change: read once
    }
    setTimeout(() => { if (n !== svN) return; svFor = ''; if (spPage === lead && !page.hidden) loadView(); }, 5000);
  }
  const refresh = p => { if (p) cur = p; o.loadProjects(); renderPage(); };
  async function update(body) { const r = await call('updateProject', { id: cur.id, ...body }); if (r.status !== 200) { failed(r); return false; } refresh(r.body.project); return true; }

  // ---- Archive and delete a project ----
  async function archiveProject(id, archived) {
    const r = await call('updateProject', { id, archived }); if (r.status !== 200) return failed(r);
    if (archived && o.S.view?.id === id) o.S.view = null;
    await o.loadProjects(); o.renderTabs();
    if (archived) api.undoToast(`Archived <b>${esc(r.body.project.name)}</b>`, () => archiveProject(id, false));
  }
  async function deleteProject(p) {
    const n = listedChats(o.S.sessions).filter(s => s.project === p.id).length, moved = n ? ` Its ${n} chat${n > 1 ? 's' : ''} move to Chats.` : '';
    const body = p.work.kind === 'p9'
      ? `Deletes the project's instructions, its files and P9's folder for it, with anything its chats saved there.${moved}`
      : `Deletes P9's notes and added files for this project. Your folder at <b class="path">${esc(where(p.work.folder))}</b> is not touched.${moved}`;
    if (!await confirmIt({ title: `Delete “${p.name}”?`, body, ok: 'Delete project', danger: true })) return;
    const r = await call('deleteProject', { id: p.id }); if (r.status !== 200) return failed(r);
    for (const id of r.body.moved || []) { const s = find(id); if (s) s.project = null; }
    if (o.S.view?.id === p.id) { o.S.view = null; cur = null; }
    await o.loadProjects(); o.renderTabs(); o.renderChats();
    say(`Deleted ${p.name}.${r.body.moved?.length ? ' Its chats are in Chats.' : ''}`);
  }

  // ---- Added files: read here, sent as base64; the daemon never replaces a name already there. ----
  async function addFiles(list) {
    for (const file of list) {
      if (file.size > 4 * 1024 * 1024) { say(`${file.name} is over 4 MB, the most one added file can be.`, 'warn'); continue; }
      const bytes = new Uint8Array(await file.arrayBuffer()); let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const r = await call('addProjectFile', { id: cur.id, name: file.name, data: btoa(bin) });
      if (r.status === 201) cur = { ...cur, files: r.body.files }; else failed(r);
    }
    renderPage();
  }
  const picker = Object.assign(document.createElement('input'), { type: 'file', multiple: true, hidden: true });
  picker.onchange = () => { addFiles([...picker.files]); picker.value = ''; }; page.after(picker);

  page.addEventListener('click', async e => {
    const b = e.target.closest('[data-pj], [data-chat]'); if (!b) return;
    if (b.dataset.chat) return api.openChat(b.dataset.chat);
    const k = b.dataset.pj;
    if (k === 'unproj') return archiveProject(b.dataset.id, false).then(renderPage);
    if (k === 'unchat') return archiveChat(find(b.dataset.id), false).then(renderPage);
    if (!cur) return;
    if (k === 'new') return o.newSession(o.lastAgent(), '', cur.id);
    if (k === 'all') { page.querySelector('[data-rest]').hidden = false; return b.remove(); }
    // Instructions typed and not yet saved are saved before the box leaves the page; a refused save keeps box and page.
    const kept = async () => { if (!$('#pjInstr')) return true; clearTimeout(saveT); return await saveInstr() !== false; };
    if (k === 'edit') { if (edit && !await kept()) return; edit = !edit; renderPage(); return edit && $('#pjInstr')?.focus(); }
    if (k === 'add') return picker.click();
    if (k === 'spset') return saveSprintSet();
    if (k === 'spopen' || k === 'spback') { if (!await kept()) return; spPage = b.dataset.lead ?? ''; renderPage(); page.scrollTop = 0; return page.focus({ preventScroll: true }); }
    if (k === 'spnew') { const title = await confirmIt({ title: 'New sprint', body: 'A sprint to prepare: its plan, its roles and each role\'s files. No chat starts until Start sprint.', input: '', ok: 'Make it' }); if (!title) return;
      if (!await kept()) return; const r = await call('newSprint', { id: cur.id, title }); if (r.status !== 201) return failed(r); return openProject(cur.id, r.body.sprint); }
    if (k === 'sprole-add') { const box = page.querySelector(`[data-sp-newkey][data-lead="${CSS.escape(b.dataset.lead)}"]`), key = box?.value.trim() ?? '';
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(key) || /^[0-9a-f]{8}-/.test(key)) return say('A worker\'s name is 1 to 64 of a-z, 0-9, dot, dash and underscore, starting with a letter or digit.', 'warn');
      return saveRoles(b.dataset.lead, rs => rs.some(r => r.key === key) ? say(`There is a role named ${key} already.`, 'warn') : rs.push({ key, provider: '', model: '', effort: '' })); }
    if (k === 'sprole-rm') return saveRoles(b.dataset.lead, rs => { const i = rs.findIndex(r => r.key === b.dataset.role); if (i >= 0) rs.splice(i, 1); else return false; });
    // A file whose save was refused stays open with its draft: nothing switches over unsaved text.
    if (k === 'spfile') { clearTimeout(saveT); if (!await saveSprint()) { renderPage(); return fillBox(); } const id = b.dataset.lead + ' ' + b.dataset.name; sprintOpen = sprintOpen === id ? '' : id; renderPage(); return fillBox(); }
    // An open file's draft is saved first: the press approves the plan as it is on disk. The page is read again after, in
    // place (the user may be elsewhere by then: nothing is opened for them).
    // The press is out from the click, its draft's save too: a second press while that save is held sends nothing.
    if (k === 'spstart') { const lead = b.dataset.lead, id = cur.id; if (starting.has(lead)) return;
      // The scripts this press approves are the ones drawn with its button (SECURITY.md § Sprint scripts): a hooks.json that
      // reached the page since (a save's reply carries every file) is shown, and waits for a press of its own.
      const shown = b.dataset.hooks ?? '', hooksNow = () => cur?.sprints?.find(s => s.lead === lead)?.files.find(f => f.name === 'hooks.json')?.hash ?? ''; starting.add(lead); clearTimeout(saveT); renderPage(); fillBox(false);
      if (!await saveSprint().catch(() => false)) { starting.delete(lead); renderPage(); return fillBox(); }
      if (hooksNow() !== shown) { starting.delete(lead); startSaid.set(lead, 'Not started: hooks.json changed before your press went out. Look at the scripts listed here, then press Start again.'); renderPage(); return fillBox(); }
      pressed.add(lead); startSaid.delete(lead); renderPage(); fillBox(false);
      const r = await call('startSprint', { sprint: lead, ...(shown && { hooks: shown }) }, { quiet: true }).finally(() => starting.delete(lead));
      startSaid.set(lead, startText(r));
      const again = cur?.id === id && await call('project', { id }, { quiet: true });
      if (again?.status === 200 && cur?.id === id) adopt(again.body.project, lead);
      o.loadProjects(); renderPage(); return fillBox(false); }
    // Close sprint: asked once, then the daemon stops the sprint's chats and keeps its record. The page is read again
    // after, so the sprint shows as closed everywhere; a refusal (a before-close script, a chat that did not stop) is said beside the button.
    if (k === 'spclose') { const lead = b.dataset.lead, id = cur.id; if (svClosing) return;
      if (!await confirmIt({ title: 'Close this sprint?', body: 'Every chat of this sprint is stopped, its record is kept and its scripts are turned off. Nothing is deleted. A closed sprint is not started again.', ok: 'Close sprint', danger: true })) return;
      svClosing = lead; svSaid = ''; renderPage();
      const r = await call('closeSprint', { sprint: lead }, { quiet: true }).catch(() => ({})).finally(() => { svClosing = ''; });
      if (r.status !== 200) svSaid = 'Not closed: ' + (r.body?.detail || r.body?.error || r.status || 'no answer') + '';
      const again = cur?.id === id && await call('project', { id }, { quiet: true });
      if (again?.status === 200 && cur?.id === id) adopt(again.body.project, lead);
      o.loadProjects(); renderPage(); if (spPage === lead) loadView(); return; }
    if (k === 'spscripts') return openScripts(b.dataset.lead);
    if (k === 'spclean') { b.disabled = true; cleaned.set(b.dataset.lead, cleanText(await call('cleanSprint', { lead: b.dataset.lead }, { quiet: true }))); renderPage(); return fillBox(); }
    if (k === 'spretry' || k === 'spmine') { clearTimeout(saveT); return saveSprint(k === 'spmine'); }
    if (k === 'sptheirs') { const gone = isGone(sprintOpen); drafts.delete(sprintOpen); spNote.delete(sprintOpen); if (gone) sprintOpen = ''; renderPage(); return fillBox(); }
    if (k === 'rm') { const r = await call('removeProjectFile', { id: cur.id, name: b.dataset.name }); if (r.status !== 200) return failed(r); cur = { ...cur, files: r.body.files }; return renderPage(); }
    if (k === 'open') { o.files.scope = 'project'; if (!o.S.files) $('[data-tool=files]')?.click(); else o.renderTree(); return; }
    if (k === 'locate') { const f = await pick(); if (f === undefined) return; const r = await call('locateProject', { id: cur.id, folder: f }); if (r.status !== 200) return failed(r); refresh(r.body.project); return say(`Found it: ${where(f)}`); }
    if (k === 'more') {
      if (b.getAttribute('aria-expanded') === 'true') return api.closeMenu();
      const r = b.getBoundingClientRect();
      return setTimeout(() => api.openMenu(`${cur.work.kind !== 'p9' && cur.found !== false ? `<button role="menuitem" data-pjm="open">${I.folder}Show the work folder</button>` : ''}<button role="menuitem" data-pjm="rename">${svg.edit}Rename</button><button role="menuitem" data-pjm="archive">${svg.history}Archive project</button><div class="sep"></div><button role="menuitem" class="danger" data-pjm="delete">${svg.x}Delete project…</button>`, { x: r.right - 220, y: r.bottom + 4 }, b));
    }
  });
  // The menus' items (the page's More and a chat row's added items); panel.mjs handles its own.
  addEventListener('click', e => {
    const m = e.target.closest?.('.lp-menu [data-pjm], .lp-menu [data-pjchat]'); if (!m) return;
    api.closeMenu(); const k = m.dataset.pjm, s = find(m.dataset.id);
    if (k === 'open') return page.querySelector('[data-pj=open]')?.click();
    if (k === 'rename') { const h = $('#pjName'); h?.focus(); return getSelection().selectAllChildren(h); }
    if (k === 'archive') return archiveProject(cur.id, true);
    if (k === 'delete') return deleteProject(cur);
    if (!s) return;
    if (m.dataset.pjchat === 'rename') return renameChat(s);
    if (m.dataset.pjchat === 'archive') return archiveChat(s, true);
    if (m.dataset.pjchat === 'askable') return askableChat(s);
    if (m.dataset.pjchat === 'delete') return deleteChat(s);
  }, { signal: o.lifetime.signal });
  // Name and about save when they lose the focus; Enter ends the name, Escape puts it back.
  page.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.matches?.('#pjSpSource, #pjSpSetup')) { e.preventDefault(); return saveSprintSet(); }
    if (e.target.id === 'pjName' && e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
    if ((e.target.id === 'pjName' || e.target.id === 'pjAbout') && e.key === 'Escape') { e.stopPropagation(); e.target.textContent = e.target.id === 'pjName' ? cur.name : cur.about; e.target.blur(); }
  });
  page.addEventListener('focusout', e => {
    if (!cur) return;
    const t = e.target, v = t.id === 'pjName' ? t.textContent.replace(/\s+/g, ' ').trim() : t.textContent.trim();
    if (t.id === 'pjName') { if (!v) t.textContent = cur.name; else if (v !== cur.name) update({ name: v }); }
    if (t.id === 'pjAbout' && v !== (cur.about || '')) update({ about: v });
  });
  // A1, A4: the project's sprint source and setup command (desktop only; the daemon checks the address again).
  async function saveSprintSet() {
    const r = await call('sprintSettings', { id: cur.id, source: $('#pjSpSource').value.trim(), setup: $('#pjSpSetup').value }, { quiet: true });
    if (r.status !== 200) return failed(r);
    cur = { ...cur, sprint: r.body.project.sprint }; $('#pjSpSource').value = cur.sprint.source;
    const s = $('#pjSprintSaved'); s?.classList.add('on'); setTimeout(() => s?.classList.remove('on'), 1200);
  }
  // H1: a role row's change rewrites roles.json (its other fields, such as mode, kept), after any save before it. A change
  // returning false changes nothing. Refused (the lead or an agent wrote the file meanwhile): the page reloads it.
  const saveRoles = (lead, change) => (spSaving = spSaving.then(() => writeRoles(lead, change), () => writeRoles(lead, change)));
  async function writeRoles(lead, change) {
    const project = cur, sp = project?.sprints?.find(x => x.lead === lead), f = sp?.files.find(x => x.name === 'roles.json');
    let doc; try { doc = JSON.parse(f?.text ?? ''); } catch { return true; }
    if (!Array.isArray(doc?.roles) || change(doc.roles) === false) return true;
    const r = await call('sprintFile', { id: project.id, lead, name: 'roles.json', text: JSON.stringify(doc, null, 2) + '\n', hash: f.hash }, { quiet: true });
    if (r.status === 200 && r.body?.files) takeFiles(sp, r.body.files, project.id);
    else { if (r.status !== 409) failed(r); else say('roles.json changed in P9 meanwhile (the lead or an agent wrote it). The rows show it now; make your change again.', 'warn');
      const again = await call('project', { id: project.id });
      if (again.status === 200 && cur?.id === project.id) adopt(again.body.project); }
    if (cur?.id === project.id) { renderPage(); fillBox(false); } // the focus stays on the pick just used
    return r.status === 200;
  }
  // The pick is read now, not when its save runs: a save queued behind another runs after that one's redraw has set
  // every pick back to the file.
  page.addEventListener('change', e => { const x = e.target; if (!x.matches?.('[data-spr]')) return;
    const { lead, role, spr } = x.dataset, value = x.value;
    saveRoles(lead, rs => { const r = rs.find(y => y.key === role); if (!r) return false;
      if (spr === 'agent') Object.assign(r, { provider: value, model: '', effort: '' }); else r[spr] = value; }); });
  const saveInstr = async () => { const box = $('#pjInstr'); if (!box || box.value === (cur.instructions ?? '')) return;
    const r = await call('updateProject', { id: cur.id, instructions: box.value }); if (r.status !== 200) { failed(r); return false; }
    cur = { ...cur, instructions: r.body.project.instructions }; const s = $('#pjSaved'); s?.classList.add('on'); setTimeout(() => s?.classList.remove('on'), 1200); };
  // The open file's box shows its draft, or the file: set as a value, since morph may keep a box another file typed in.
  const fillBox = (focus = true) => { const box = page.querySelector('[data-sp-box]'); if (!box) return;
    box.value = drafts.get(sprintOpen)?.text ?? cur.sprints?.find(x => x.lead === box.dataset.lead)?.files.find(x => x.name === box.dataset.name)?.text ?? box.value; if (focus) box.focus(); };
  // The open file's draft, saved after the one before it. true: nothing left unsaved. mine: over whatever is there now
  // (after a 'changed' refusal, the user chose it). A reply for a page or file no longer shown changes nothing there.
  const saveSprint = (mine = false) => (spSaving = spSaving.then(() => saveOpen(mine), () => saveOpen(mine)));
  async function saveOpen(mine) {
    const id = sprintOpen, d = drafts.get(id), project = cur; if (!d || !project) return true;
    const sp = project.sprints?.find(x => id.startsWith(x.lead + ' ')), name = id.slice(id.indexOf(' ') + 1), f = sp?.files.find(x => x.name === name);
    if (!sp) return true;
    if (!mine && f && f.hash === d.hash && f.text === d.text) { drafts.delete(id); return true; }
    // A file deleted since: refused as changed (the draft stays, listed); mine makes it again ('' = must not exist).
    const r = await call('sprintFile', { id: project.id, lead: sp.lead, name, text: d.text, hash: mine ? f?.hash ?? '' : d.hash }, { quiet: true });
    const here = cur?.id === project.id ? cur.sprints?.find(x => x.lead === sp.lead) : null; // the page may have reloaded meanwhile
    for (const x of new Set([sp, here])) if (x && r.body?.files) takeFiles(x, r.body.files, project.id);
    const now = sp.files.find(x => x.name === name), shown = !!here && sprintOpen === id;
    if (r.status === 200) {
      spNote.delete(id);
      if (drafts.get(id) === d) drafts.delete(id); else if (drafts.has(id)) drafts.get(id).hash = now?.hash; // typed meanwhile: that text builds on this save
      const s = shown && page.querySelector(`[data-sprint="${CSS.escape(sp.lead)}"] [data-sp-saved]`); if (s) { s.classList.add('on'); setTimeout(() => s.classList.remove('on'), 1200); }
    } else {
      spNote.set(id, r.status === 409 && r.body?.error === 'sprint-file-changed' ? 'changed' : 'failed');
      if (spNote.get(id) === 'failed') failed(r);
    }
    const note = shown && page.querySelector('[data-sp-note]'); if (note) note.innerHTML = spNoteHtml(id);
    return r.status === 200;
  }
  page.addEventListener('input', e => { if (e.target.id === 'pjInstr') { clearTimeout(saveT); saveT = setTimeout(saveInstr, 600); }
    if (e.target.matches('[data-sp-box]')) { const id = e.target.dataset.lead + ' ' + e.target.dataset.name, f = cur?.sprints?.find(x => x.lead === e.target.dataset.lead)?.files.find(x => x.name === e.target.dataset.name);
      drafts.set(id, { text: e.target.value, hash: drafts.get(id)?.hash ?? f?.hash ?? '' }); clearTimeout(saveT); saveT = setTimeout(saveSprint, 600); } });
  page.addEventListener('focusout', e => { if (e.target.matches?.('[data-sp-box]')) { clearTimeout(saveT); saveSprint(); } });
  page.addEventListener('dragover', e => { if (e.target.closest('[data-drop-files]') && e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.target.closest('[data-drop-files]').setAttribute('data-over', ''); } });
  page.addEventListener('dragleave', e => e.target.closest?.('[data-drop-files]')?.removeAttribute('data-over'));
  page.addEventListener('drop', e => { const z = e.target.closest('[data-drop-files]'); if (!z || !e.dataTransfer.files.length) return; e.preventDefault(); z.removeAttribute('data-over'); addFiles([...e.dataTransfer.files]); });

  // ---- A chat's Rename, Archive and Delete (row menu). The daemon's renamed, archived and deleted events tell every window. ----
  async function renameChat(s) {
    const t = await confirmIt({ title: 'Rename chat', input: s.title, ok: 'Rename' }); if (!t || t === s.title) return;
    const r = await call('renameChat', { id: s.id, title: t }); if (r.status !== 200) return failed(r);
    s.title = r.body.title; o.renderTabs(); o.renderChats();
  }
  async function archiveChat(s, archived) {
    if (!s) return; const r = await call('archiveChat', { id: s.id, archived }); if (r.status !== 200) return failed(r);
    s.archived = archived; o.renderTabs();
    if (archived) api.undoToast(`Archived <b>${esc(s.title)}</b>`, () => archiveChat(s, false));
  }
  // Peer help: whether other chats in the project may ask this one a question (ask_chat). Off until the user turns it on.
  async function askableChat(s) {
    const r = await call('askableChat', { id: s.id, on: !s.askable }); if (r.status !== 200) return failed(r);
    s.askable = r.body.on; say(s.askable ? `${s.title} is open to questions from other chats in its project. It answers them read-only.` : `${s.title} no longer takes questions from other chats.`);
  }
  async function deleteChat(s) {
    if (!await confirmIt({ title: `Delete “${s.title}”?`, body: `Deletes the chat, what P9 remembered from it and its photos no other chat uses; its files and what it spent stay.${s.state === 'running' || s.pending ? ' It stops first.' : ''} This can't be undone.`, ok: 'Delete chat', danger: true })) return;
    const r = await call('deleteChat', { id: s.id }); if (r.status !== 200) return failed(r);
    o.S.sessions = o.S.sessions.filter(x => x !== s); o.S.open = o.S.open.filter(x => x !== s.id); o.renderTabs(); o.renderChats();
    say(`Deleted ${s.title}.`);
  }

  // ---- Sprint scripts (S18): the window is sprint-scripts-view.mjs, loaded on first use ----
  let scriptsWin = null;
  async function openScripts(lead) {
    clearTimeout(saveT); await saveSprint().catch(() => false);
    scriptsWin ??= import('./sprint-scripts-view.mjs').then(m => m.installScripts({ cur: () => cur, esc, scriptLine, scriptsOf, call, failed, ERR, say, adopt, renderPage, fillBox }));
    const win = await scriptsWin.catch(() => { scriptsWin = null; });
    return win ? win.show(lead) : say('The Sprint scripts window did not load. Try again.', 'warn');
  }

  // ---- New project ----
  const dlg = document.body.appendChild(Object.assign(document.createElement('dialog'), { id: 'pjNew', className: 'pj-dlg' }));
  dlg.setAttribute('aria-labelledby', 'pjNewT');
  dlg.innerHTML = `<form method="dialog" novalidate><h2 id="pjNewT">New project</h2>
    <label>Name<input data-slot="input" name="name" placeholder="Holiday cards" maxlength="120" required autocomplete="off"></label>
    <label>What it is about<textarea data-slot="textarea" name="about" placeholder="One or two lines: what this project is for" maxlength="4000"></textarea></label>
    <fieldset><legend>Where does the work happen?</legend>
      <div class="opt"><input type="radio" name="where" value="p9" id="pjW1" checked><label for="pjW1"><b>In P9</b><small>Chats start in P9's own folder for the project. Nothing else to pick.</small></label></div>
      <div class="opt"><input type="radio" name="where" value="linked" id="pjW2"><label for="pjW2"><b>In a folder I already have</b><small>Chats start in your folder, for example a code project.</small></label>
        <span class="sub"><span class="pick"><span class="mono" data-show="linked"></span><button type="button" data-slot="button" data-variant="outline" data-size="sm" data-pick="linked">Browse…</button></span>
          <span class="shared" hidden></span>
          <span class="found" hidden><input type="checkbox" id="pjAdopt" name="adopt"><label for="pjAdopt"></label></span>
          <span class="quiet">P9 keeps its own notes for this project in its own folder. It adds nothing to yours.</span></span></div>
      <div class="opt"><input type="radio" name="where" value="new" id="pjW3"><label for="pjW3"><b>In a new folder somewhere else</b><small>P9 makes the folder where you choose.</small></label>
        <span class="sub"><span class="pick"><span class="mono" data-show="new"></span><button type="button" data-slot="button" data-variant="outline" data-size="sm" data-pick="new">Change parent…</button></span>
          <span class="quiet">P9 keeps its own notes for this project in its own folder. It adds nothing to yours.</span></span></div>
    </fieldset>
    <p class="err" role="alert" hidden></p>
    <div class="btns"><button type="button" data-slot="button" data-variant="ghost" data-cancel>Cancel</button><button data-slot="button" data-variant="default" type="submit">Create project</button></div></form>`;
  const form = dlg.querySelector('form'), F = form.elements, D = { linked: undefined, parent: '', started: [], made: null };
  const err = t => { const p = form.querySelector('.err'); p.textContent = t || ''; p.hidden = !t; };
  const paths = () => {
    form.querySelector('[data-show=linked]').textContent = D.linked === undefined ? '' : where(D.linked);
    form.querySelector('[data-show=new]').textContent = (D.parent ? D.parent + '/' : '') + slug(F.name.value);
  };
  async function picked(f) {
    D.linked = f; paths();
    // Two projects may share one folder; the dialog names the others (N1 spec).
    const others = (o.S.projects || []).filter(p => p.work.kind !== 'p9' && p.work.folder === f), sh = form.querySelector('.shared');
    sh.hidden = !others.length; sh.textContent = others.length ? `${others.map(p => p.name).join(', ')} already use${others.length > 1 ? '' : 's'} this folder. Two projects can share one.` : '';
    // The offer to add the chats already started there: only chats in no project that the panel lists, never ticked for you.
    // Nightly 3: the daemon also counts a chat closed before anything was sent, which the panel hides; moving it moved
    // nothing Builder could see.
    const shown = new Set(listedChats(o.S.sessions).map(s => s.id));
    const r = await call('startedIn', { folder: f }), offer = r.status === 200 ? r.body.conversations.filter(c => !c.project && shown.has(c.id)) : [];
    D.started = offer.map(c => c.id);
    const fd = form.querySelector('.found'), n = D.started.length; fd.hidden = !n; F.adopt.checked = false;
    // Named, newest first, so you can see what will move (Builder: "it didn't tell me" which chat): up to 3, then "and N more".
    const t = offer.map(c => `“${c.title || 'Untitled chat'}”`), names = n > 3 ? `${t.slice(0, 3).join(', ')} and ${n - 3} more` : n > 1 ? `${t.slice(0, -1).join(', ')} and ${t[n - 1]}` : t[0];
    fd.querySelector('label').textContent = `${n} chat${n > 1 ? 's were' : ' was'} started in this folder: ${names}. Add ${n > 1 ? 'them' : 'it'} to the project?`;
  }
  form.addEventListener('click', async e => {
    if (e.target.closest('[data-cancel]')) return dlg.close();
    const b = e.target.closest('[data-pick]'); if (!b) return;
    e.preventDefault(); const f = await pick(); if (f === undefined) return; err();
    if (b.dataset.pick === 'linked') picked(f); else { D.parent = f; paths(); }
  });
  F.name.addEventListener('input', paths);
  form.addEventListener('change', e => { if (e.target.name === 'where') err(); });
  form.addEventListener('submit', async e => {
    e.preventDefault(); if (D.made) { dlg.close(); return openProject(D.made); }
    const name = F.name.value.trim(), w = F.where.value;
    if (!name) { err('Give the project a name.'); return F.name.focus(); }
    if (w === 'linked' && D.linked === undefined) { err('Pick the folder first.'); return form.querySelector('[data-pick=linked]').focus(); }
    const work = w === 'p9' ? { kind: 'p9' } : w === 'linked' ? { kind: 'linked', folder: D.linked } : { kind: 'new', parent: D.parent, name: slug(name) };
    const btn = form.querySelector('[type=submit]'); btn.disabled = true;
    const r = await call('createProject', { name, about: F.about.value.trim(), work }).finally(() => { btn.disabled = false; });
    if (r.status !== 201) return err(ERR[r.body?.error] || 'P9 could not make the project (' + (r.body?.error || r.status) + ').');
    // A chat that can't be moved (gone since the offer) is named here, not dropped in silence; Create becomes Open.
    const made = r.body.project.id; let left = 0, why;
    if (w === 'linked' && F.adopt.checked) for (const id of D.started) { const m = await call('moveChat', { id, project: made }, { quiet: true }); const s = find(id);
      if (m.status === 200) { if (s) s.project = made; } else { left++; why = m.body?.error || m.status; } }
    await o.loadProjects();
    if (left) { D.made = made; btn.textContent = 'Open the project';
      return err(`“${name}” is made, but ${left} chat${left > 1 ? 's' : ''} could not be added. ${ERR[why] || 'P9 refused the move (' + why + ').'}${why === 'unknown-conversation' ? '' : ` Drag ${left > 1 ? 'them' : 'it'} onto the project in the panel.`}`); }
    dlg.close(); openProject(made);
  });
  function newProject() {
    api.closeMenu(); form.reset(); err(); Object.assign(D, { linked: undefined, parent: '', started: [], made: null }); form.querySelector('[type=submit]').textContent = 'Create project';
    form.querySelector('.shared').hidden = form.querySelector('.found').hidden = true; paths();
    dlg.showModal(); F.name.focus();
  }

  o.openProject = openProject; o.newProject = newProject; o.renderPage = renderPage; o.openArchived = () => { o.S.view = { kind: 'archived' }; if (o.S.focus !== 'chat') o.setFocus('chat'); o.renderTabs(); page.focus(); };
  o.chatMenuItems = s => `<div class="sep"></div><button role="menuitem" data-pjchat="rename" data-id="${esc(s.id)}">${svg.edit}Rename…</button><button role="menuitem" data-pjchat="archive" data-id="${esc(s.id)}">${svg.history}Archive</button><button role="menuitem" data-pjchat="askable" data-id="${esc(s.id)}">${svg.chat ?? svg.edit}${s.askable ? 'Close to questions' : 'Open to questions'}</button><button role="menuitem" class="danger" data-pjchat="delete" data-id="${esc(s.id)}">${svg.x}Delete…</button>`;
}
