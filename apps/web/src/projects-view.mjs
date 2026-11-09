// N1 points 9 and 10: the New project dialog and the project page (the N1 spec and the approved mock, round 3), plus
// Rename, Archive and Delete in a chat's row menu and the Archived page. installPanel calls installProjects last; it sets
// the hooks panel.mjs asks for (o.openProject, o.newProject, o.chatMenuItems, o.renderPage). The page lives in #projPage
// beside #chats; o.S.view says which shows ({ kind: 'project', id }, { kind: 'archived' } or null for the chats).
// Every change goes through the daemon's project routes (p9:chat); nothing here reads or writes a folder.
import { svg, esc } from './helpers.mjs';
import { PANEL_ICONS, LABEL, listedChats, stateOf } from './panel.mjs';

const ERR = { 'folder-exists': 'A folder with that name is already there. Change the name or the parent.', 'folder-refused': 'P9 can\'t use that folder. Pick another.',
  'file-exists': 'A file with that name is already added.', 'too-many-files': 'This project has the most files it can hold (200).', 'request-refused': 'P9 refused that. Check the name and try again.' };
const where = f => f === '' ? 'Workspace' : f;
const slug = s => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'project';
const size = n => n < 1024 ? n + ' B' : n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
const when = s => s.used || s.created || 0;
const fmt = t => { if (!t) return ''; const m = Math.floor((Date.now() - t) / 60000), D = 1440;
  return m < 1 ? 'now' : m < 60 ? m + 'm' : m < D ? Math.floor(m / 60) + 'h' : m < 7 * D ? Math.floor(m / D) + 'd' : new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' }); };

export function installProjects(o, api) {
  const I = PANEL_ICONS, $ = s => document.querySelector(s), page = $('#projPage'), chats = $('#chats');
  const call = (action, body) => o.liveChat.call(action, body);
  const find = id => o.S.sessions.find(s => s.id === id);
  // cur: the shown project as GET /projects/<id> gives it (instructions, files, agentFiles, sharedWith).
  let cur = null, edit = false, saveT = 0;
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
  async function openProject(id) {
    if (o.S.focus !== 'chat' && !o.focusOn('chat')) return;
    api.closeMenu(); api.setOpen(id, true); edit = false;
    o.S.view = { kind: 'project', id }; if (o.S.focus !== 'chat') o.setFocus('chat');
    if (cur?.id !== id) cur = null; // shown once the full record is in: the list's copy has no instructions or files
    o.renderTabs(); if (o.S.files) o.renderTree();
    const r = await call('project', { id });
    if (r.status === 200 && o.S.view?.id === id) { cur = r.body.project; renderPage(); }
    else if (r.status === 404) { o.S.view = null; o.loadProjects(); o.renderTabs(); }
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
      : `<div class="wf">${I.folder}<span>Work folder</span>${mine ? `<span class="plain">P9's folder for this project</span><span class="tag">In P9</span>`
        : `<span class="mono" title="Chats in this project start here">${esc(where(f))}</span><button data-slot="button" data-variant="ghost" data-size="sm" data-pj="open" title="Show it in the Files pane">Open</button>`}</div>`;
    const own = !mine && p.agentFiles?.length ? `<p class="ownfile">${svg.files}This folder has its own instructions (${p.agentFiles.map(esc).join(', ')}). Agents read them on their own.</p>` : '';
    const instr = edit ? `<textarea data-slot="textarea" id="pjInstr" aria-label="Instructions" maxlength="32000">${esc(p.instructions ?? '')}</textarea>`
      : p.instructions ? instrText(p.instructions) : '<p class="hint">None yet. Add a few lines every chat in this project should follow.</p>';
    const files = p.files ?? [];
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
    </div>`;
  }
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
    if (page.contains(document.activeElement) && document.activeElement.matches('[contenteditable], textarea')) return;
    o.morph(page, v.kind === 'project' ? projectHtml(cur) : archivedHtml());
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
    if (k === 'new') return setTimeout(() => { o.newPop.open(); api.newAt(b, cur.id); $('#newPop [data-new]')?.focus(); });
    if (k === 'all') { page.querySelector('[data-rest]').hidden = false; return b.remove(); }
    if (k === 'edit') { if (edit) { clearTimeout(saveT); await saveInstr(); } edit = !edit; renderPage(); return edit && $('#pjInstr')?.focus(); }
    if (k === 'add') return picker.click();
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
    if (m.dataset.pjchat === 'delete') return deleteChat(s);
  }, { signal: o.lifetime.signal });
  // Name and about save when they lose the focus; Enter ends the name, Escape puts it back.
  page.addEventListener('keydown', e => {
    if (e.target.id === 'pjName' && e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
    if ((e.target.id === 'pjName' || e.target.id === 'pjAbout') && e.key === 'Escape') { e.stopPropagation(); e.target.textContent = e.target.id === 'pjName' ? cur.name : cur.about; e.target.blur(); }
  });
  page.addEventListener('focusout', e => {
    if (!cur) return;
    const t = e.target, v = t.id === 'pjName' ? t.textContent.replace(/\s+/g, ' ').trim() : t.textContent.trim();
    if (t.id === 'pjName') { if (!v) t.textContent = cur.name; else if (v !== cur.name) update({ name: v }); }
    if (t.id === 'pjAbout' && v !== (cur.about || '')) update({ about: v });
  });
  const saveInstr = async () => { const box = $('#pjInstr'); if (!box || box.value === (cur.instructions ?? '')) return;
    const r = await call('updateProject', { id: cur.id, instructions: box.value }); if (r.status !== 200) return failed(r);
    cur = { ...cur, instructions: r.body.project.instructions }; const s = $('#pjSaved'); s?.classList.add('on'); setTimeout(() => s?.classList.remove('on'), 1200); };
  page.addEventListener('input', e => { if (e.target.id === 'pjInstr') { clearTimeout(saveT); saveT = setTimeout(saveInstr, 600); } });
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
  async function deleteChat(s) {
    if (!await confirmIt({ title: `Delete “${s.title}”?`, body: `Deletes the chat and everything in it.${s.state === 'running' || s.pending ? ' It stops first.' : ''} This can't be undone.`, ok: 'Delete chat', danger: true })) return;
    const r = await call('deleteChat', { id: s.id }); if (r.status !== 200) return failed(r);
    o.S.sessions = o.S.sessions.filter(x => x !== s); o.S.open = o.S.open.filter(x => x !== s.id); o.renderTabs(); o.renderChats();
    say(`Deleted ${s.title}.`);
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
  const form = dlg.querySelector('form'), F = form.elements, D = { linked: undefined, parent: '', started: [] };
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
    // The offer to add the chats already started there: only chats in no project, and never ticked for you.
    const r = await call('startedIn', { folder: f }); D.started = r.status === 200 ? r.body.conversations.filter(c => !c.project).map(c => c.id) : [];
    const fd = form.querySelector('.found'), n = D.started.length; fd.hidden = !n; F.adopt.checked = false;
    fd.querySelector('label').textContent = `${n} chat${n > 1 ? 's were' : ' was'} started in this folder. Add ${n > 1 ? 'them' : 'it'} to the project?`;
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
    e.preventDefault(); const name = F.name.value.trim(), w = F.where.value;
    if (!name) { err('Give the project a name.'); return F.name.focus(); }
    if (w === 'linked' && D.linked === undefined) { err('Pick the folder first.'); return form.querySelector('[data-pick=linked]').focus(); }
    const work = w === 'p9' ? { kind: 'p9' } : w === 'linked' ? { kind: 'linked', folder: D.linked } : { kind: 'new', parent: D.parent, name: slug(name) };
    const btn = form.querySelector('[type=submit]'); btn.disabled = true;
    const r = await call('createProject', { name, about: F.about.value.trim(), work }).finally(() => { btn.disabled = false; });
    if (r.status !== 201) return err(ERR[r.body?.error] || 'P9 could not make the project (' + (r.body?.error || r.status) + ').');
    if (w === 'linked' && F.adopt.checked) for (const id of D.started) { const m = await call('moveChat', { id, project: r.body.project.id }); const s = find(id); if (m.status === 200 && s) s.project = r.body.project.id; }
    dlg.close(); await o.loadProjects(); openProject(r.body.project.id);
  });
  function newProject() {
    api.closeMenu(); form.reset(); err(); Object.assign(D, { linked: undefined, parent: '', started: [] });
    form.querySelector('.shared').hidden = form.querySelector('.found').hidden = true; paths();
    dlg.showModal(); F.name.focus();
  }

  o.openProject = openProject; o.newProject = newProject; o.renderPage = renderPage; o.openArchived = () => { o.S.view = { kind: 'archived' }; if (o.S.focus !== 'chat') o.setFocus('chat'); o.renderTabs(); page.focus(); };
  o.chatMenuItems = s => `<div class="sep"></div><button role="menuitem" data-pjchat="rename" data-id="${esc(s.id)}">${svg.edit}Rename…</button><button role="menuitem" data-pjchat="archive" data-id="${esc(s.id)}">${svg.history}Archive</button><button role="menuitem" class="danger" data-pjchat="delete" data-id="${esc(s.id)}">${svg.x}Delete…</button>`;
}
