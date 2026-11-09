// The file tree, Send files and the small editor. Split out of controller.mjs's mountShell (F9) with no change in behaviour; names that stay in mountShell come in through outer.
import { esc } from './helpers.mjs';

export function installFiles(outer) {
// MC-18 (N1 point 11): Current project is the project page's work folder, else the shown chat's project's, else the chat's own
// folder as before. In P9 (no path from the daemon) and a chat's ':project-files' marker are not workspace folders: the main project.
const projectRoot = () => { const v = outer.S.view, s = outer.S.sessions.find(x => x.id === outer.S.open[0]), id = v?.kind === 'project' ? v.id : !v && s?.project;
  const p = id && outer.S.projects?.find(x => x.id === id); if (p?.work.folder != null) return p.work.folder;
  return (!(v?.kind === 'project') && s?.folder && !s.folder.startsWith(':') && s.folder) || outer.live.primary?.path || ''; };
const fileRoot = () => ({ project: projectRoot, workspace: () => '',
  needs: () => outer.live.waitDir, ideas: () => '_ideas' })[outer.files.scope]();
async function loadDir(dir) {
  outer.files.dirs[dir] = 'loading';
  const r = await window.p9.mission('list', { path: dir });
  outer.files.dirs[dir] = r.status === 200 ? r.body.entries.slice().sort((a, b) => (b.dir ? 1 : 0) - (a.dir ? 1 : 0)) : { error: r.body?.error || String(r.status) };
  renderTree();
}
function liveTree(dir, depth, q, cur) {
  const got = outer.files.dirs[dir], pad = `style="padding-left:${6 + depth * 12}px"`;
  if (!got || got === 'loading') { if (!got) loadDir(dir); return `<p class="sm muted" ${pad}>Loading…</p>`; }
  if (got.error) return `<p class="sm muted" ${pad}>Not readable: ${esc(got.error)}</p>`;
  if (!got.length) return `<p class="sm muted" ${pad}>Empty</p>`;
  return got.filter(e => e.dir || !q || e.name.toLowerCase().includes(q)).map(e => { const p = dir ? dir + '/' + e.name : e.name;
    return e.dir ? `<button data-ldir="${esc(p)}" ${pad}><span class="k">${outer.files.open.has(p) ? '▾' : '▸'}</span><span class="truncate">${esc(e.name)}</span></button>${outer.files.open.has(p) ? liveTree(p, depth + 1, q, cur) : ''}`
      : `<button data-lfile="${esc(p)}" ${pad}${p === cur ? ' aria-current="true"' : ''}><span class="k"></span><span class="truncate">${esc(e.name)}</span></button>`; }).join('');
}
function renderTree() {
  const q = outer.$('#fileSearch').value.trim().toLowerCase();
  if (outer.live.on) {
    const root = fileRoot(), cur = outer.S.modal?.kind === 'file' && outer.mdl.open ? outer.S.modal.name : null;
    outer.$('#fileScope').hidden = false; outer.$('#fileScope').value = outer.files.scope;
    outer.$('#tree').innerHTML = `<p class="where muted mono truncate" title="${esc(root || 'Workspace')}">${esc(root || 'Workspace')}</p>${liveTree(root, 0, q, cur)}`;
    outer.$('#tree').querySelectorAll('[data-ldir]').forEach(b => b.onclick = () => { const p = b.dataset.ldir; outer.files.open.has(p) ? outer.files.open.delete(p) : outer.files.open.add(p); renderTree(); });
    outer.$('#tree').querySelectorAll('[data-lfile]').forEach(b => b.onclick = () => outer.openModal({ kind: 'file', name: b.dataset.lfile, live: true }));
    outer.$('#xferBtn').hidden = !window.p9?.xferPlan || !!outer.serverInfo?.host;
    outer.$('#xferBtn').title = 'Copy ' + (root || 'the workspace') + ' to the same folder on ' + (outer.serverInfo?.last || 'your remote (Settings > Remote Connect)') + ' over P9\'s own tunnel: no Syncthing. It asks before writing over anything.';
    return;
  }
  outer.$('#tree').innerHTML = outer.tree(outer.M.files, 0, q, outer.S.modal?.kind === 'file' && outer.mdl.open ? outer.S.modal.name : null);
  outer.$('#tree').querySelectorAll('[data-file]').forEach(b => b.onclick = () => outer.openModal({ kind: 'file', name: b.dataset.file }));
}
// Send files (item 23; main's p9:xfer, desktop/xfer.mjs): the files panel's folder goes to the same folder on the server.
// Main plans and keeps the plan; this asks what the plan cannot settle alone (Builder, 2026-10-27: one choice for the whole
// list; a delete is asked; a Syncthing folder warns; a limit names its Setting), then shows the send. A plan with nothing
// to ask sends at once: one button press.
const XFER_SETTINGS = { fileMiB: ['Largest file to send', 'MiB', 65536], files: ['Most files in one send', 'files', 200000], sendGiB: ['Most data in one send', 'GiB', 1024] }; // desktop/xfer.mjs XFER_LIMITS
const bytes = n => n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(1) + ' GiB' : n >= 1024 ** 2 ? (n / 1024 ** 2).toFixed(1) + ' MiB' : Math.ceil(n / 1024) + ' KiB';
const xfer = { id: null };
function xferShow(title, note, body, foot) {
  outer.$('#xferT').textContent = title; outer.$('#xferP').textContent = note; outer.$('#xferBody').innerHTML = body; outer.$('#xferFoot').innerHTML = foot;
  if (!outer.$('#xferDlg').open) outer.$('#xferDlg').showModal();
}
const xferClose = '<button data-slot="button" data-variant="outline" data-xfer-close>Close</button>';
function xferWire() { outer.$('#xferDlg').querySelectorAll('[data-xfer-close]').forEach(b => b.onclick = () => { xfer.id = null; outer.$('#xferDlg').close(); }); }
// A refusal: a limit links its Setting.
function xferRefused(r) {
  xferShow('Not sent', r.message || r.error || 'No answer.', '', (r.setting ? '<button data-slot="button" data-variant="default" id="xferSetting">Open Settings</button>' : '') + xferClose);
  xferWire();
  if (r.setting) outer.$('#xferSetting').onclick = async () => { outer.$('#xferDlg').close(); await outer.$('#setBtn').onclick(); const input = outer.$('#setXfer-' + r.setting); outer.settingsAt(input); input?.focus(); };
}
async function sendFiles() {
  const folder = fileRoot(), b = outer.$('#xferBtn');
  b.disabled = true; b.textContent = 'Checking…';
  const p = await window.p9.xferPlan(folder).catch(() => ({ error: 'no-answer', message: 'P9 did not answer.' }));
  b.disabled = false; b.textContent = 'Send files to remote';
  if (p.error) return xferRefused(p);
  xfer.id = p.id;
  const where = (p.folder || 'The workspace') + ' on ' + p.host, sync = [...p.syncthing.laptop.map(d => ['laptop', d]), ...p.syncthing.server.map(d => ['server', d])];
  if (!p.asked && !p.deletes && !sync.length) {
    if (!p.send) return xferShow('Nothing to send', where + ' already matches this computer (' + p.same.toLocaleString() + ' files the same).', '', xferClose), xferWire();
    return xferGo(p, null, false);
  }
  xferAsk(p, (choice, deleteToo) => xferGo(p, choice, deleteToo));
}
// The prompt for a plan that asks: a Syncthing warning, the files that differ, the deletes. go(choice, deleteToo) runs on a choice;
// moving: Send to server's prompt for the chat's folder, before the chat is frozen.
function xferAsk(p, go, moving) {
  const where = (p.folder || 'The workspace') + ' on ' + p.host, sync = [...p.syncthing.laptop.map(d => ['laptop', d]), ...p.syncthing.server.map(d => ['server', d])];
  const list = (items, more) => '<ul class="mono sm" style="max-height:30vh;overflow:auto;margin:0;padding-left:18px">' + items.join('') + (more > 0 ? '<li class="muted">and ' + more.toLocaleString() + ' more</li>' : '') + '</ul>';
  const warn = sync.length ? '<div class="set-row" data-xfer-syncthing><span><strong>Syncthing already syncs this folder</strong><span class="muted sm">Two copiers on one folder fight: each undoes the other. Found .stfolder at '
    + sync.map(([side, d]) => esc(d === '..' ? 'a folder above the workspace' : d || 'the workspace') + ' (' + side + ')').join(', ') + '. Send only if Syncthing is off for it.</span></span></div>' : '';
  const asked = p.asked ? '<div data-xfer-asked><p><strong>' + (p.kind === 'first' ? 'Nothing was sent to this folder from here before, and ' + p.asked.toLocaleString() + ' file' + (p.asked === 1 ? ' differs' : 's differ') + ' between the two.'
    : p.asked.toLocaleString() + ' file' + (p.asked === 1 ? '' : 's') + ' changed on both sides since your last send.') + '</strong><br><span class="muted sm">'
    + p.summary.laptopNewer.toLocaleString() + ' newer on the laptop, ' + p.summary.serverNewer.toLocaleString() + ' newer on the remote.</span></p>'
    + list(p.list.map(i => '<li><span>' + esc(i.path) + '</span> <span class="muted">' + esc(i.text) + '</span></li>'), p.asked - p.list.length) + '</div>' : '';
  const gone = p.deletes ? '<label class="set-row" data-xfer-deletes><input type="checkbox" id="xferDel"><span><strong>Delete on the remote too</strong><span class="muted sm">' + p.deletes.toLocaleString() + ' file'
    + (p.deletes === 1 ? ' was' : 's were') + ' deleted on the laptop since your last send. Unticked, the remote keeps ' + (p.deletes === 1 ? 'it' : 'them') + '.</span></span></label>' + list(p.deleteList.map(d => '<li>' + esc(d) + '</li>'), p.deletes - p.deleteList.length) : '';
  const choices = !p.asked ? [['go', 'default', 'Send']] : p.kind === 'first' ? [['laptop', 'default', 'Laptop wins'], ['newer', 'outline', 'Keep the newer of each']]
    : [['laptop', 'default', 'Keep the laptop\'s'], ['server', 'outline', 'Keep the remote\'s'], ['newer', 'outline', 'Keep the newer of each']];
  xferShow(p.kind === 'first' ? 'First send to ' + p.host : p.kind === 'conflict' ? 'Files changed on both sides' : 'Send files to ' + p.host,
    where + ': ' + p.send.toLocaleString() + ' file' + (p.send === 1 ? '' : 's') + ' to send (' + bytes(p.sendBytes) + ').' + (moving ? ' The chat moves once they are there.' : ''),
    warn + asked + gone + '<p class="muted sm">Every file replaced or deleted, on either side, is kept in that computer\'s P9 recovery folder.</p>',
    '<button data-slot="button" data-variant="outline" data-xfer-close autofocus>Cancel</button>' + choices.map(([v, look, label]) => '<button data-slot="button" data-variant="' + look + '" data-xfer-choice="' + v + '">' + label + '</button>').join(''));
  xferWire();
  outer.$('#xferDlg').querySelectorAll('[data-xfer-choice]').forEach(c => c.onclick = () => go(c.dataset.xferChoice === 'go' ? null : c.dataset.xferChoice, !!outer.$('#xferDel')?.checked));
}
async function xferGo(p, choice, deleteToo) {
  xferShow('Sending to ' + p.host, (p.folder || 'The workspace') + '. Closing this leaves the send running.', '<progress id="xferBar" value="0" max="1" style="width:100%"></progress><p class="muted sm mono" id="xferNum"></p>', xferClose);
  xferWire();
  const r = await window.p9.xferRun(p.id, choice, deleteToo).catch(() => ({ error: 'no-answer', message: 'P9 did not answer.' }));
  if (r.error === 'limit' || r.error && !r.sent && !r.received && !r.deletedOnServer && !r.deletedHere) return xferRefused(r);
  const said = [r.sent && r.sent.toLocaleString() + ' sent', r.received && r.received.toLocaleString() + ' taken from the remote', r.deletedOnServer && r.deletedOnServer.toLocaleString() + ' deleted on the remote',
    r.deletedHere && r.deletedHere.toLocaleString() + ' deleted here', r.kept && r.kept.toLocaleString() + ' old cop' + (r.kept === 1 ? 'y' : 'ies') + ' kept in recovery'].filter(Boolean);
  xferShow(r.error ? 'Partly sent' : 'Sent', (said.join(', ') || 'Nothing needed sending') + '.', r.message ? '<p>' + esc(r.message) + '</p>' : '', xferClose);
  xferWire();
  outer.files.dirs = {}; renderTree();
}
// One doc per file, shared by the Chat file modal and Dev Focus. text is the draft, saved is what
// is on disk; they differ until an explicit Save (D04: a draft never silently overwrites the file).
function doc(name) {
  if (!outer.S.docs[name]) {
    const body = outer.M.fileBody[name] || (name.endsWith('.md') ? `# ${name.split('/').pop()}\n\n(mock file: the real app reads it from disk)\n` : `// ${name}\n// (no preview in this prototype)\n`);
    outer.S.docs[name] = { text: body, saved: body, sel: [0, 0], top: 0 };
  }
  return outer.S.docs[name];
}
const dirty = name => outer.S.docs[name] && outer.S.docs[name].text !== outer.S.docs[name].saved;
function fitGut(ta, gut) {
  if (!ta.clientWidth) return; // hidden focus: the ResizeObserver runs this again when it shows
  const cs = getComputedStyle(ta), lh = parseFloat(cs.lineHeight);
  outer.mirror.style.cssText = `position:absolute;visibility:hidden;white-space:pre-wrap;overflow-wrap:anywhere;font:${cs.font};letter-spacing:${cs.letterSpacing};tab-size:${cs.tabSize};width:${ta.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)}px`;
  outer.mirror.innerHTML = ta.value.split('\n').map(l => `<div>${esc(l) || ' '}</div>`).join('');
  document.body.append(outer.mirror);
  gut.textContent = [...outer.mirror.children].map((r, i) => (i + 1) + '\n'.repeat(Math.max(1, Math.round(r.offsetHeight / lh)) - 1)).join('\n');
  outer.mirror.remove();
  gut.scrollTop = ta.scrollTop;
}
const lines = s => Array.from({ length: s.split('\n').length }, (_, i) => i + 1).join('\n');
function editorHtml(name, id) {
  const d = doc(name);
  return `<div class="ed"><pre class="gut" aria-hidden="true">${lines(d.text)}</pre><textarea id="${id}" spellcheck="false" aria-label="${esc(name)}">${esc(d.text)}</textarea></div>`;
}
// Keeps the doc, the gutter and the caret in step with the textarea; after() repaints dirty marks.
function wireEditor(root, name, after, save = () => saveDoc(name)) {
  const d = doc(name), ta = root.querySelector('.ed textarea'), gut = root.querySelector('.ed .gut');
  ta.setSelectionRange(...d.sel); ta.scrollTop = d.top; gut.scrollTop = d.top;
  ta.oninput = () => { const was = dirty(name); d.text = ta.value; fitGut(ta, gut); d.sel = [ta.selectionStart, ta.selectionEnd]; if (was !== dirty(name)) after(); };
  ta.onscroll = () => { d.top = gut.scrollTop = ta.scrollTop; };
  outer.observe(() => fitGut(ta, gut)).observe(ta);
  ta.onselect = ta.onkeyup = ta.onclick = () => { d.sel = [ta.selectionStart, ta.selectionEnd]; };
  outer.edSave = { root, save, after };
}
// D7: why a save failed, in words; the daemon's code word stays at the end for a bug report.
function saveWhy(r) {
  const code = r.body?.error || r.body?.code || String(r.status);
  const words = { 'registry-read-only': 'P9 keeps this file read-only (it holds Mission Control button commands)',
    'request-refused': 'P9 refused it: a locked or protected name, or not a text file',
    'daemon-unavailable': 'P9' + (outer.serverInfo?.host ? ' on ' + outer.serverInfo.host : '') + ' did not answer; check the connection and try again',
    'daemon-outdated': 'P9' + (outer.serverInfo?.host ? ' on ' + outer.serverInfo.host : '') + ' is older than this app; update it, then try again',
    EACCES: 'no permission to write it', EPERM: 'no permission to write it', EROFS: 'the disk is read-only', ENOSPC: 'the disk is full',
    EDQUOT: 'the disk quota is full', EBUSY: 'the file is busy; try again', ENOENT: 'its folder is gone' }[code];
  return (words || 'P9 could not write it') + ' (' + code + ')';
}
function saveDoc(name) { const d = doc(name); d.saved = d.text; renderTree(); }
const saveBtn = name => dirty(name) ? `<span data-slot="badge">draft</span><button data-slot="button" data-size="sm" data-savefile>Save</button>` : `<span class="muted sm">saved</span>`;
function renderModalFoot() {
  const n = outer.S.modal.name;
  outer.$('#mdlFoot').innerHTML = `<span class="muted sm mono truncate">${esc(n)}</span><span class="spacer"></span><span class="muted sm">Ctrl S</span>${saveBtn(n)}`;
  const b = outer.$('#mdlFoot [data-savefile]'); if (b) b.onclick = () => { saveDoc(n); renderModalFoot(); };
}
  return { renderTree, XFER_SETTINGS, bytes, xfer, xferRefused, sendFiles, xferAsk, doc, dirty, editorHtml, wireEditor, saveWhy, saveDoc, saveBtn, renderModalFoot };
}
